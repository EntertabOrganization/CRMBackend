import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, notFoundError, pageOf } from '../support';
import type { TasksPolicy } from '../tasks/policy';
import type { ProjectResourceProvisioner } from '../tasks/ports';
import type { Project } from '../tasks/types';
import type { FilePermissionAssignment, ProjectFileStorage, ProjectRootFolder, StorageAccessSource } from './types';

const LEVELS = ['NONE', 'READ', 'ADD', 'EDIT', 'FULL'] as const;

/** Files owns the canonical Project storage and root; Project lifecycle only calls this port. */
export class ProjectDriveService {
  constructor(private readonly support: CollabSupport, private readonly projects: TasksPolicy,
    private readonly provisionProject?: (actor: ActorContext, projectId: string) => ProjectFileStorage) {}
  private get state() { return this.support.state; }
  private project(storage: ProjectFileStorage) {
    return this.state.projects.find(p => p.id === storage.projectId && p.workspaceId === storage.workspaceId);
  }
  private canRead(actor: ActorContext, storage: ProjectFileStorage) {
    return this.eligible(actor, storage) && this.level(actor, storage) > 0;
  }
  private eligible(actor: ActorContext, storage: ProjectFileStorage) {
    return actor.workspaceId === storage.workspaceId && storage.isActive && this.support.isEligibleUser(actor.workspaceId, actor.user.id);
  }
  private baseLevel(actor: ActorContext, storage: ProjectFileStorage) {
    const defaults = storage.type === 'PERSONAL' && storage.ownerUserId === actor.user.id ? 4 : storage.type === 'COMPANY' ? actor.role.isOwnerRole ? 4 : 1 : 0;
    const sources = this.state.storageAccessSources.filter(s => s.workspaceId === actor.workspaceId && s.storageId === storage.id && s.userId === actor.user.id && s.active &&
      (s.sourceType !== 'PROJECT' || Boolean(this.project(storage) && !this.project(storage)!.isDeleted &&
        s.sourceId === storage.projectId && this.projects.projectRole(this.project(storage)!, actor.user.id))));
    return Math.max(defaults, ...sources.map(s => LEVELS.indexOf(s.permissionLevel)));
  }
  private matches(actor: ActorContext, storage: ProjectFileStorage, assignment: FilePermissionAssignment) {
    switch (assignment.subjectType) {
      case 'USER': return assignment.subjectId === actor.user.id;
      case 'ROLE': return assignment.subjectId === actor.role.id;
      case 'WORKSPACE': return assignment.subjectId === null || assignment.subjectId === actor.workspaceId;
      case 'PROJECT_ROLE': return Boolean(this.project(storage) && !this.project(storage)!.isDeleted && this.projects.projectRole(this.project(storage)!, actor.user.id) === assignment.subjectId);
      case 'DEPARTMENT': return this.state.departments.some(row => row.id === assignment.subjectId && row.workspaceId === actor.workspaceId && !row.isDeleted) &&
        this.support.access.userDepartments(actor.workspaceId, actor.user.id).has(assignment.subjectId!);
      case 'DEPARTMENT_TREE': {
        if (!this.state.departments.some(row => row.id === assignment.subjectId && row.workspaceId === actor.workspaceId && !row.isDeleted)) return false;
        const seen = new Set<string>(), pending = [assignment.subjectId!];
        while (pending.length) {
          const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
          pending.push(...this.state.departments.filter(row => row.workspaceId === actor.workspaceId && !row.isDeleted && row.parentDepartmentId === id).map(row => row.id));
        }
        return [...this.support.access.userDepartments(actor.workspaceId, actor.user.id)].some(id => seen.has(id) &&
          this.state.departments.some(row => row.id === id && row.workspaceId === actor.workspaceId && !row.isDeleted));
      }
      default: return false;
    }
  }
  private applyAcl(actor: ActorContext, storage: ProjectFileStorage, type: FilePermissionAssignment['resourceType'], id: string, inherited: number) {
    const assignments = this.state.filePermissionAssignments.filter(row => row.workspaceId === actor.workspaceId && row.resourceType === type && row.resourceId === id);
    if (!assignments.length) return inherited;
    const granted = Math.max(0, ...assignments.filter(row => this.matches(actor, storage, row)).map(row => LEVELS.indexOf(row.permissionLevel)));
    return assignments.some(row => row.inheritanceMode === 'OVERRIDE') ? granted : Math.max(inherited, granted);
  }
  private level(actor: ActorContext, storage: ProjectFileStorage, chain: ProjectRootFolder[] = []) {
    let level = this.applyAcl(actor, storage, 'STORAGE', storage.id, this.baseLevel(actor, storage));
    for (const folder of [...chain].reverse()) level = this.applyAcl(actor, storage, 'FOLDER', folder.id, level);
    return level;
  }
  /** Reject corrupt/missing parents and hidden ancestors before resolving inherited ACLs. */
  private chain(row: ProjectRootFolder, includeTrash = false) {
    const result: ProjectRootFolder[] = [], seen = new Set<string>(); let current: ProjectRootFolder | undefined = row;
    while (current) {
      if (seen.has(current.id) || !includeTrash && current.status !== 'ACTIVE' || current.workspaceId !== row.workspaceId || current.storageId !== row.storageId)
        throw notFoundError('FOLDER_NOT_FOUND', 'Folder');
      seen.add(current.id); result.push(current);
      if (!current.parentFolderId) return result;
      current = this.state.fileFolders.find(parent => parent.id === current!.parentFolderId && parent.storageId === row.storageId && parent.workspaceId === row.workspaceId);
      if (!current) throw notFoundError('FOLDER_NOT_FOUND', 'Folder');
    }
    throw notFoundError('FOLDER_NOT_FOUND', 'Folder');
  }
  get(actor: ActorContext, id: string) {
    this.support.require(actor, 'storage.read');
    const storage = this.state.fileStorages.find(s => s.id === id && this.canRead(actor, s));
    if (!storage) throw notFoundError('STORAGE_NOT_FOUND', 'Storage');
    return { ...storage, isReadOnly: storage.isReadOnly || Boolean(this.project(storage)?.isDeleted || this.project(storage)?.status === 'ARCHIVED') };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'storage.read');
    return pageOf(this.state.fileStorages.filter(s => this.canRead(actor, s)).map(s => this.get(actor, s.id)), query,
      { searchable: ['name'], filterable: ['type', 'projectId', 'ownerUserId', 'isActive'], sortable: ['name', 'createdAt'], defaultSort: 'name' });
  }
  root(actor: ActorContext, storageId: string) {
    this.get(actor, storageId); this.support.require(actor, 'folder.read');
    const folder = this.state.fileFolders.find(f => f.storageId === storageId && f.workspaceId === actor.workspaceId && f.parentFolderId === null);
    if (!folder) throw notFoundError('FOLDER_NOT_FOUND', 'Root folder'); return this.folder(actor, folder.id);
  }
  folder(actor: ActorContext, id: string) {
    this.support.require(actor, 'folder.read');
    const row = this.state.fileFolders.find(f => f.id === id && f.workspaceId === actor.workspaceId);
    if (!row) throw notFoundError('FOLDER_NOT_FOUND', 'Folder');
    const storage = this.state.fileStorages.find(s => s.id === row.storageId && this.eligible(actor, s));
    if (!storage || this.level(actor, storage, this.chain(row)) < 1) throw notFoundError('FOLDER_NOT_FOUND', 'Folder');
    return row;
  }
  folderAuthority(actor: ActorContext, id: string, permission: string, minimum = 3, includeTrash = false, writable = true) {
    this.support.require(actor, permission);
    const row = this.state.fileFolders.find(f => f.id === id && f.workspaceId === actor.workspaceId);
    const storage = row && this.state.fileStorages.find(s => s.id === row.storageId && this.eligible(actor, s));
    if (!row || !storage || this.level(actor, storage, this.chain(row, includeTrash)) < minimum) throw notFoundError('FOLDER_NOT_FOUND', 'Folder');
    if (writable) this.assertWritable(storage); return row;
  }
  storageAuthority(actor: ActorContext, id: string, permission: string, minimum = 4) {
    this.support.require(actor, permission);
    const row = this.state.fileStorages.find(storage => storage.id === id && this.eligible(actor, storage));
    if (!row || this.level(actor, row) < minimum) throw notFoundError('STORAGE_NOT_FOUND', 'Storage');
    return row;
  }
  fileAuthority(actor: ActorContext, id: string, permission: string, minimum = 1, includeTrash = false, writable = false) {
    this.support.require(actor, permission);
    const row = this.state.driveFiles.find(file => file.id === id && file.workspaceId === actor.workspaceId && (includeTrash || file.status !== 'TRASHED'));
    const storage = row && this.state.fileStorages.find(storage => storage.id === row.storageId && this.eligible(actor, storage));
    const folder = row && this.state.fileFolders.find(folder => folder.id === row.folderId && folder.storageId === row.storageId && folder.workspaceId === actor.workspaceId);
    if (!row || !storage || !folder) throw notFoundError('FILE_NOT_FOUND', 'File');
    let level: number;
    try { level = this.applyAcl(actor, storage, 'FILE', row.id, this.level(actor, storage, this.chain(folder, includeTrash))); }
    catch (error) { if (error instanceof AppError && error.code === 'FOLDER_NOT_FOUND') throw notFoundError('FILE_NOT_FOUND', 'File'); throw error; }
    if (level < minimum) throw notFoundError('FILE_NOT_FOUND', 'File');
    if (writable) this.assertWritable(storage);
    return row;
  }
  assertWritable(storage: ProjectFileStorage) {
    if (storage.isReadOnly || this.project(storage)?.isDeleted || this.project(storage)?.status === 'ARCHIVED')
      throw new AppError('STORAGE_READ_ONLY', 'Storage is read-only.', 409);
  }
  updateStorage(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    this.support.require(actor, 'storage.manage'); body.only(['name', 'isActive', 'version']);
    const row = this.state.fileStorages.find(s => s.id === id && s.workspaceId === actor.workspaceId && this.support.isEligibleUser(actor.workspaceId, actor.user.id));
    if (!row || this.level(actor, row) < 4) throw notFoundError('STORAGE_NOT_FOUND', 'Storage');
    if (row.type === 'PROJECT') this.assertWritable(row);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const name = body.str('name', { required: body.has('name'), max: 500 }) ?? row.name;
    const isActive = body.bool('isActive', { required: body.has('isActive') }) ?? row.isActive;
    const before = structuredClone(row); Object.assign(row, { name, isActive }); this.support.touch(row);
    const root = this.state.fileFolders.find(folder => folder.storageId === id && folder.parentFolderId === null && folder.workspaceId === actor.workspaceId);
    if (root && root.name !== name) { root.name = name; this.support.touch(root); }
    this.support.audit(actor, actor.workspaceId, 'STORAGE.UPDATED', 'FILE_STORAGE', id, before, row);
    this.support.event({ workspaceId: actor.workspaceId, type: 'STORAGE_UPDATED', entityType: 'FILE_STORAGE', entityId: id, actorUserId: actor.user.id, changes: { version: row.version, name, isActive } });
    return row;
  }
  createStorage(actor: ActorContext, body: Body) {
    this.support.require(actor, 'storage.manage'); body.only(['type', 'ownerUserId', 'projectId', 'name']);
    const type = body.enumOf('type', ['PERSONAL', 'COMPANY', 'PROJECT', 'SYSTEM'] as const, { required: true });
    if (type === 'PROJECT') {
      const projectId = body.uuid('projectId', { required: true });
      if (body.has('ownerUserId')) throw new AppError('STORAGE_INVALID', 'Project storage derives its access from the Project.', 400);
      if (body.has('name')) body.str('name', { required: true, max: 500 });
      if (!this.provisionProject) throw new AppError('STORAGE_UNAVAILABLE', 'Project storage provisioning is unavailable.', 503);
      return this.provisionProject(actor, projectId);
    }
    if (body.has('projectId')) throw new AppError('STORAGE_INVALID', 'Only Project storage has a Project link.', 400);
    const name = body.str('name', { required: true, max: 500 });
    const ownerUserId = type === 'PERSONAL' ? body.uuid('ownerUserId') ?? actor.user.id : null;
    if (type !== 'PERSONAL' && body.has('ownerUserId')) throw new AppError('STORAGE_INVALID', 'Only Personal storage has an owner.', 400);
    const scope = this.support.require(actor, 'storage.manage');
    if (type === 'PERSONAL' ? !this.support.isEligibleUser(actor.workspaceId, ownerUserId!) || !this.support.scopeCovers(actor, scope, [ownerUserId]) : scope !== 'WORKSPACE')
      throw notFoundError('STORAGE_NOT_FOUND', 'Storage owner');
    const old = this.state.fileStorages.find(row => row.workspaceId === actor.workspaceId && row.type === type &&
      (type === 'PERSONAL' ? row.ownerUserId === ownerUserId : type === 'COMPANY'));
    if (old) throw new AppError('STORAGE_ALREADY_EXISTS', 'This canonical storage already exists.', 409);
    const now = this.support.now(), storage: ProjectFileStorage = { id: this.support.id(), workspaceId: actor.workspaceId, type, ownerUserId, projectId: null,
      name, isActive: true, isReadOnly: type === 'SYSTEM', version: 1, createdAt: now, updatedAt: now };
    this.state.fileStorages.push(storage);
    const root: ProjectRootFolder = { id: this.support.id(), workspaceId: actor.workspaceId, storageId: storage.id, parentFolderId: null, name,
      status: 'ACTIVE', originalParentFolderId: null, trashedAt: null, purgeAfter: null, version: 1, createdAt: now, updatedAt: now };
    this.state.fileFolders.push(root);
    if (type === 'SYSTEM') this.source(storage, actor.user.id, 'SYSTEM', storage.id, 'FULL', true);
    this.support.audit(actor, actor.workspaceId, 'STORAGE.CREATED', 'FILE_STORAGE', storage.id, null, storage);
    this.support.event({ workspaceId: actor.workspaceId, type: 'STORAGE_CREATED', entityType: 'FILE_STORAGE', entityId: storage.id, actorUserId: actor.user.id, changes: { type, rootFolderId: root.id } });
    this.support.event({ workspaceId: actor.workspaceId, type: 'FOLDER_CREATED', entityType: 'FILE_FOLDER', entityId: root.id, actorUserId: actor.user.id, changes: { storageId: storage.id } });
    return storage;
  }
  createFolder(actor: ActorContext, body: Body) {
    this.support.require(actor, 'folder.create'); body.only(['storageId', 'parentFolderId', 'name']);
    const storageId = body.uuid('storageId', { required: true }), parentId = body.uuid('parentFolderId', { required: true });
    const name = body.str('name', { required: true, max: 500 }).normalize('NFC');
    const parent = this.folder(actor, parentId);
    if (parent.storageId !== storageId) throw notFoundError('FOLDER_NOT_FOUND', 'Parent folder');
    const storage = this.state.fileStorages.find(row => row.id === storageId && row.workspaceId === actor.workspaceId)!;
    if (this.level(actor, storage, this.chain(parent)) < 2) throw new AppError('PERMISSION_DENIED', 'Folder creation requires ADD access.', 403);
    if (storage.isReadOnly || this.project(storage)?.isDeleted || this.project(storage)?.status === 'ARCHIVED') throw new AppError('STORAGE_READ_ONLY', 'Storage is read-only.', 409);
    if (this.state.fileFolders.some(row => row.storageId === storageId && row.parentFolderId === parentId && row.status === 'ACTIVE' && row.name.trim().normalize('NFC').toLowerCase() === name.toLowerCase()))
      throw new AppError('FOLDER_NAME_CONFLICT', 'An active sibling already uses this name.', 409);
    const now = this.support.now(), folder: ProjectRootFolder = { id: this.support.id(), workspaceId: actor.workspaceId, storageId, parentFolderId: parentId,
      name, status: 'ACTIVE', originalParentFolderId: null, trashedAt: null, purgeAfter: null, version: 1, createdAt: now, updatedAt: now };
    this.state.fileFolders.push(folder);
    this.support.event({ workspaceId: actor.workspaceId, type: 'FOLDER_CREATED', entityType: 'FILE_FOLDER', entityId: folder.id, actorUserId: actor.user.id, changes: { storageId, parentFolderId: parentId } });
    return folder;
  }
  private source(storage: ProjectFileStorage, userId: string, sourceType: StorageAccessSource['sourceType'], sourceId: string,
    permissionLevel: StorageAccessSource['permissionLevel'], active: boolean) {
    const row = this.state.storageAccessSources.find(s => s.storageId === storage.id && s.userId === userId && s.sourceType === sourceType && s.sourceId === sourceId);
    if (row && row.active === active && row.permissionLevel === permissionLevel || !row && !active) return;
    const now = this.support.now();
    if (row) Object.assign(row, { active, permissionLevel, updatedAt: now });
    else this.state.storageAccessSources.push({ id: this.support.id(), workspaceId: storage.workspaceId, storageId: storage.id,
      userId, sourceType, sourceId, permissionLevel, active, createdAt: now, updatedAt: now });
    this.support.event({ workspaceId: storage.workspaceId, type: 'STORAGE_ACCESS_CHANGED', entityType: 'FILE_STORAGE', entityId: storage.id,
      actorUserId: null, audienceUserIds: [userId], changes: { sourceType, sourceId, active, permissionLevel } });
  }
  private sync(storage: ProjectFileStorage, project: Project, members: string[]) {
    const desired = new Set(members.filter(id => this.support.isEligibleUser(storage.workspaceId, id)));
    const previous = this.state.storageAccessSources.filter(s => s.storageId === storage.id && s.sourceType === 'PROJECT' && s.sourceId === project.id);
    for (const id of new Set([...desired, ...previous.map(s => s.userId)])) {
      const role = this.projects.projectRole(project, id);
      this.source(storage, id, 'PROJECT', project.id, role === 'OWNER' || role === 'MODERATOR' ? 'FULL' : 'ADD', desired.has(id));
    }
  }
  projectProvisioner(): ProjectResourceProvisioner {
    const find = (p: Project, id: string) => this.state.fileStorages.find(s => s.id === id && s.projectId === p.id && s.workspaceId === p.workspaceId);
    return { toolType: 'DRIVE', resourceType: 'FILE_STORAGE',
      provision: (project, actorUserId, members) => {
        let storage = this.state.fileStorages.find(s => s.projectId === project.id && s.workspaceId === project.workspaceId);
        if (!storage) {
          const now = this.support.now();
          storage = { id: this.support.id(), workspaceId: project.workspaceId, type: 'PROJECT', ownerUserId: null, projectId: project.id,
            name: project.name, isActive: true, isReadOnly: project.status === 'ARCHIVED', version: 1, createdAt: now, updatedAt: now };
          this.state.fileStorages.push(storage);
          const root = { id: this.support.id(), workspaceId: project.workspaceId, storageId: storage.id, parentFolderId: null,
            name: project.name, status: 'ACTIVE' as const, originalParentFolderId: null, trashedAt: null, purgeAfter: null,
            version: 1, createdAt: now, updatedAt: now };
          this.state.fileFolders.push(root);
          this.support.event({ workspaceId: project.workspaceId, type: 'STORAGE_CREATED', entityType: 'FILE_STORAGE', entityId: storage.id,
            actorUserId, changes: { projectId: project.id, rootFolderId: root.id } });
          this.support.event({ workspaceId: project.workspaceId, type: 'FOLDER_CREATED', entityType: 'FILE_FOLDER', entityId: root.id,
            actorUserId, changes: { storageId: storage.id } });
          this.support.audit(null, project.workspaceId, 'STORAGE.PROVISIONED', 'FILE_STORAGE', storage.id, null, { projectId: project.id, actorUserId });
        }
        this.sync(storage, project, members); return storage.id;
      },
      syncProjectMembers: (p, id, members) => { const s = find(p, id); if (s) this.sync(s, p, members); },
      setReadOnly: (p, id, isReadOnly) => { const s = find(p, id); if (s && s.isReadOnly !== isReadOnly) { s.isReadOnly = isReadOnly; this.support.touch(s); } },
      detach: (p, id) => {
        const s = find(p, id); if (!s) return; s.projectId = null; s.isReadOnly = true; this.support.touch(s);
        for (const source of this.state.storageAccessSources.filter(source => source.storageId === id && source.sourceType === 'PROJECT')) source.sourceType = 'SYSTEM';
      },
    };
  }
}
