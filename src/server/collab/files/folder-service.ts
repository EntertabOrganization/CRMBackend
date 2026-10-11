import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, pageOf } from '../support';
import type { ProjectRootFolder } from './types';
import type { ProjectDriveService } from './project-drive-service';
import type { FileService } from './file-service';

/** Folder lifecycle operates on a bounded, authorized graph inside the request transaction. */
export class FolderService {
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService, private readonly files: FileService) {}
  private get state() { return this.support.state; }
  private descendants(root: ProjectRootFolder) {
    const result: ProjectRootFolder[] = [], pending = [root], seen = new Set<string>();
    while (pending.length) {
      const row = pending.shift()!;
      if (seen.has(row.id)) throw new AppError('FOLDER_HIERARCHY_CYCLE', 'The folder graph contains a cycle.', 409);
      if (result.length >= 1000) throw new AppError('FOLDER_GRAPH_LIMIT', 'This operation exceeds the 1000-folder synchronous limit.', 409);
      seen.add(row.id); result.push(row);
      pending.push(...this.state.fileFolders.filter(child => child.workspaceId === root.workspaceId && child.storageId === root.storageId && child.parentFolderId === row.id));
    }
    return result;
  }
  private nonRoot(row: ProjectRootFolder) {
    if (!row.parentFolderId) throw new AppError('FOLDER_ROOT_MANAGED', 'Storage roots are managed by their storage.', 409);
  }
  private unique(row: ProjectRootFolder, parentId: string, name: string, code = 'FOLDER_NAME_CONFLICT') {
    if (this.state.fileFolders.some(other => other.id !== row.id && other.workspaceId === row.workspaceId && other.storageId === row.storageId &&
      other.parentFolderId === parentId && other.status === 'ACTIVE' && other.name.trim().normalize('NFC').toLowerCase() === name.trim().normalize('NFC').toLowerCase()))
      throw new AppError(code, 'An active sibling already uses this name. Supply a different name.', 409);
  }
  private record(actor: ActorContext, row: ProjectRootFolder, action: string, before: unknown = null) {
    this.support.event({ workspaceId: actor.workspaceId, type: `FOLDER_${action}`, entityType: 'FILE_FOLDER', entityId: row.id,
      actorUserId: actor.user.id, changes: { storageId: row.storageId, parentFolderId: row.parentFolderId, version: row.version, status: row.status } });
    this.support.audit(actor, actor.workspaceId, `FOLDER.${action}`, 'FILE_FOLDER', row.id, before, action === 'DELETED' ? null : row);
  }
  children(actor: ActorContext, id: string, query: URLSearchParams) {
    const parent = this.storages.folder(actor, id);
    const visible = this.state.fileFolders.filter(row => row.workspaceId === actor.workspaceId && row.storageId === parent.storageId && row.parentFolderId === id)
      .filter(row => { try { this.storages.folder(actor, row.id); return true; } catch (error) { if (error instanceof AppError && error.code === 'FOLDER_NOT_FOUND') return false; throw error; } });
    return pageOf(visible, query, { searchable: ['name'], filterable: ['name'], sortable: ['name', 'createdAt', 'updatedAt'], defaultSort: 'name' });
  }
  tree(actor: ActorContext, id: string, query: URLSearchParams) {
    const body = new Body(Object.fromEntries(query)); body.only(['maxDepth']);
    const maxDepth = body.has('maxDepth') ? Number(query.get('maxDepth')) : 20;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 100) throw new AppError('QUERY_INVALID', 'maxDepth must be an integer from 0 to 100.', 400);
    const root = this.storages.folder(actor, id), nodes: Array<ProjectRootFolder & { depth: number }> = [];
    const pending = [{ row: root, depth: 0 }], seen = new Set<string>(); let truncated = false;
    while (pending.length) {
      const { row, depth } = pending.shift()!;
      if (seen.has(row.id)) throw new AppError('FOLDER_HIERARCHY_CYCLE', 'The folder graph contains a cycle.', 409);
      seen.add(row.id);
      try { this.storages.folder(actor, row.id); } catch (error) { if (error instanceof AppError && error.code === 'FOLDER_NOT_FOUND') continue; throw error; }
      if (nodes.length >= 1000) throw new AppError('FOLDER_GRAPH_LIMIT', 'Tree reads support at most 1000 visible folders.', 409);
      nodes.push({ ...row, depth });
      const children = this.state.fileFolders.filter(child => child.workspaceId === actor.workspaceId && child.storageId === root.storageId && child.parentFolderId === row.id && child.status === 'ACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      if (depth < maxDepth) pending.push(...children.map(child => ({ row: child, depth: depth + 1 })));
      else truncated ||= children.some(child => { try { this.storages.folder(actor, child.id); return true; } catch (error) { if (error instanceof AppError && error.code === 'FOLDER_NOT_FOUND') return false; throw error; } });
    }
    return { rootFolderId: id, nodes, truncated };
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['name', 'version']); const row = this.storages.folderAuthority(actor, id, 'folder.update'); this.nonRoot(row);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const name = body.str('name', { required: true, max: 500 }).normalize('NFC'); this.unique(row, row.parentFolderId!, name);
    const before = structuredClone(row); row.name = name; this.support.touch(row); this.record(actor, row, 'UPDATED', before); return row;
  }
  move(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['parentFolderId', 'version']); const row = this.storages.folderAuthority(actor, id, 'folder.move'); this.nonRoot(row);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const parentId = body.uuid('parentFolderId', { required: true }), parent = this.storages.folderAuthority(actor, parentId, 'folder.move', 2);
    if (parent.storageId !== row.storageId) throw new AppError('FOLDER_NOT_FOUND', 'Destination was not found in this storage.', 404);
    const graph = this.descendants(row);
    if (graph.some(child => child.id === parentId)) throw new AppError('FOLDER_HIERARCHY_CYCLE', 'A folder cannot move into its own subtree.', 409);
    for (const child of graph) this.storages.folderAuthority(actor, child.id, 'folder.move', 3, true);
    this.unique(row, parentId, row.name); const before = structuredClone(row); row.parentFolderId = parentId;
    this.support.touch(row); this.record(actor, row, 'MOVED', before); return row;
  }
  copy(actor: ActorContext, id: string, body: Body) {
    body.only(['parentFolderId', 'name']); const root = this.storages.folder(actor, id); this.nonRoot(root);
    const parentId = body.uuid('parentFolderId', { required: true }), parent = this.storages.folderAuthority(actor, parentId, 'folder.create', 2);
    if (parent.storageId !== root.storageId) throw new AppError('FOLDER_NOT_FOUND', 'Destination was not found in this storage.', 404);
    const included = new Set<string>();
    const descendants = this.descendants(root).filter(row => {
      if (row.status !== 'ACTIVE' || row.id !== id && !included.has(row.parentFolderId!)) return false;
      included.add(row.id); return true;
    });
    for (const row of descendants) this.storages.folder(actor, row.id); // Never silently omit inaccessible content.
    const name = body.str('name', { required: body.has('name'), max: 500 }) ?? root.name;
    this.unique({ ...root, id: this.support.id() }, parentId, name);
    const ids = new Map(descendants.map(row => [row.id, this.support.id()])), now = this.support.now();
    const content = this.files.stageFolderCopy(actor, ids, root.storageId);
    const copies = descendants.map(row => ({ ...row, id: ids.get(row.id)!, name: row.id === id ? name.normalize('NFC') : row.name,
      parentFolderId: row.id === id ? parentId : ids.get(row.parentFolderId!)!, originalParentFolderId: null, trashedAt: null, purgeAfter: null, publicShareVersion: 1, version: 1, createdAt: now, updatedAt: now }));
    // ACLs and public capabilities are deliberately not duplicated; destination inheritance governs the new graph.
    this.state.fileFolders.push(...copies); for (const row of copies) this.record(actor, row, 'CREATED');
    this.files.commitFolderCopy(actor, content);
    return { folder: copies[0], copiedFolderCount: copies.length, copiedFileCount: content.files.length };
  }
  trash(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']); const row = this.storages.folderAuthority(actor, id, 'folder.delete', 3, true); this.nonRoot(row);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status === 'TRASHED') return row;
    // Descendants remain individually recoverable; normal reads/shares evaluate every ancestor.
    const settings = actor.workspace.settings as Record<string, unknown>;
    const retentionDays = Number(settings.fileRetentionDays ?? 30);
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) throw new AppError('FILE_RETENTION_POLICY_INVALID', 'File retention must be an integer from 0 to 3650 days.', 409);
    const graph = this.descendants(row);
    for (const child of graph) this.storages.folderAuthority(actor, child.id, 'folder.delete', 3, true);
    const folderIds = new Set(graph.map(child => child.id));
    const content = this.state.driveFiles.filter(file => file.workspaceId === actor.workspaceId && file.storageId === row.storageId && folderIds.has(file.folderId));
    this.files.assertUnlocked(actor.workspaceId, content.map(file => file.id));
    for (const file of content) this.storages.fileAuthority(actor, file.id, 'folder.delete', 3, true, true);
    const before = structuredClone(row), now = this.support.now();
    for (const file of content) { file.publicShareVersion += 1; this.support.touch(file); }
    for (const child of graph) { child.publicShareVersion = (child.publicShareVersion ?? 1) + 1; if (child.id !== row.id) this.support.touch(child); }
    row.status = 'TRASHED'; row.originalParentFolderId = row.parentFolderId; row.trashedAt = now;
    row.purgeAfter = new Date(now.getTime() + retentionDays * 86400000); this.support.touch(row); this.record(actor, row, 'TRASHED', before); return row;
  }
  restore(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['parentFolderId', 'name', 'version']); const row = this.storages.folderAuthority(actor, id, 'folder.restore', 3, true); this.nonRoot(row);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status !== 'TRASHED') throw new AppError('FOLDER_STATE_INVALID', 'Only trashed folders can be restored.', 409);
    const parentId = body.uuid('parentFolderId', { required: body.has('parentFolderId') }) ?? row.originalParentFolderId;
    if (!parentId) throw new AppError('FOLDER_RESTORE_CONFLICT', 'Supply an active restore destination.', 409);
    let parent: ProjectRootFolder;
    try { parent = this.storages.folderAuthority(actor, parentId, 'folder.restore', 2); } catch (error) {
      if (error instanceof AppError && error.code === 'FOLDER_NOT_FOUND') throw new AppError('FOLDER_RESTORE_CONFLICT', 'Supply an authorized active restore destination.', 409); throw error;
    }
    if (parent.storageId !== row.storageId) throw new AppError('FOLDER_RESTORE_CONFLICT', 'Restore must stay inside the original storage.', 409);
    if (this.descendants(row).some(child => child.id === parentId)) throw new AppError('FOLDER_HIERARCHY_CYCLE', 'Restore cannot create a hierarchy cycle.', 409);
    const name = (body.str('name', { required: body.has('name'), max: 500 }) ?? row.name).normalize('NFC');
    this.unique(row, parentId, name, 'FOLDER_RESTORE_CONFLICT');
    const before = structuredClone(row); Object.assign(row, { name, parentFolderId: parentId, status: 'ACTIVE', originalParentFolderId: null, trashedAt: null, purgeAfter: null });
    this.support.touch(row); this.record(actor, row, 'RESTORED', before); return row;
  }
  purge(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']); const root = this.storages.folderAuthority(actor, id, 'folder.purge', 4, true, false); this.nonRoot(root);
    this.support.expectVersion(root, body.raw.version ?? ifMatch);
    if (root.status !== 'TRASHED') throw new AppError('FOLDER_STATE_INVALID', 'Trash the folder before permanent purge.', 409);
    const graph = this.descendants(root), now = this.support.now();
    for (const row of graph) {
      this.storages.folderAuthority(actor, row.id, 'folder.purge', 4, true, false);
      if (row.purgeAfter && row.purgeAfter > now || root.purgeAfter && root.purgeAfter > now ||
        this.state.retentionRecords.some(record => record.workspaceId === actor.workspaceId && [row.id, row.storageId].includes(record.resourceId) && !record.purgedAt && (record.legalHold || record.expiresAt > now)))
        throw new AppError('FILE_RETENTION_HOLD', 'The folder subtree is protected by retention or a legal hold.', 409);
    }
    const ids = new Set(graph.map(row => row.id));
    const content = this.files.purgeFolders(actor, ids);
    this.state.filePublicLinks = this.state.filePublicLinks.filter(row => !(row.workspaceId === actor.workspaceId && row.resourceType === 'FOLDER' && ids.has(row.resourceId)));
    this.state.filePermissionAssignments = this.state.filePermissionAssignments.filter(row => !(row.workspaceId === actor.workspaceId && row.resourceType === 'FOLDER' && ids.has(row.resourceId)));
    this.state.fileFolders = this.state.fileFolders.filter(row => !ids.has(row.id));
    for (const row of graph) this.record(actor, row, 'DELETED', row);
    return { id, deleted: true, deletedFolderCount: graph.length, ...content };
  }
}
