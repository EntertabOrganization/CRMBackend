import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, pageOf } from '../support';
import type { DriveFile, DriveFileVersion } from './types';
import type { ProjectDriveService } from './project-drive-service';

const MAX_FILE = 100 * 1024 * 1024, MAX_STORAGE = 5 * 1024 * 1024 * 1024;
export class FileService {
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService,
    private readonly bindingAuthority: (actor: ActorContext, fileId: string) => void,
    private readonly mutationGuard: (workspaceId: string, fileIds: string[], allowedLockId?: string) => void) {}
  private get state() { return this.support.state; }
  private authority(actor: ActorContext, id: string, permission: string, level = 1, trash = false, write = false) {
    const row = this.storages.fileAuthority(actor, id, permission, level, trash, write);
    if (write || permission === 'file.purge' || permission === 'folder.purge') this.assertUnlocked(actor.workspaceId, [id]);
    return row;
  }
  assertUnlocked(workspaceId: string, ids: string[], allowedLockId?: string) { this.mutationGuard(workspaceId, ids, allowedLockId); }
  private safeVersion(row: DriveFileVersion) { const { objectKey, ...safe } = row; return safe; }
  private record(actor: ActorContext, row: DriveFile, action: string, before: unknown = null) {
    this.support.audit(actor, row.workspaceId, `FILE.${action}`, 'FILE', row.id, before, action === 'DELETED' ? null : row);
    this.support.event({ workspaceId: row.workspaceId, type: `FILE_${action}`, entityType: 'FILE', entityId: row.id,
      actorUserId: actor.user.id, changes: { folderId: row.folderId, version: row.version, currentVersionId: row.currentVersionId, status: row.status } });
  }
  private name(row: DriveFile, folderId: string, name: string) {
    if (this.state.driveFiles.some(other => other.id !== row.id && other.workspaceId === row.workspaceId && other.storageId === row.storageId && other.folderId === folderId && other.status !== 'TRASHED' &&
      other.name.trim().normalize('NFC').toLowerCase() === name.trim().normalize('NFC').toLowerCase())) throw new AppError('FILE_NAME_CONFLICT', 'A File with this name already exists in the destination.', 409);
  }
  private extension(name: string) { const index = name.lastIndexOf('.'); return index > 0 ? name.slice(index + 1).toLowerCase() : ''; }
  /** Publishes an already processed immutable artifact through the same folder/quota/name authority as other Files. */
  publishArtifact(actor: ActorContext, input: { folderId: string; name: string; mimeType: string; objectKey: string; checksum: string; size: number }) {
    const folder = this.storages.folderAuthority(actor, input.folderId, 'file.create', 2);
    if (!input.name || input.name.length > 500 || /[\\/\u0000-\u001f\u007f]/.test(input.name)) throw new AppError('VALIDATION_ERROR', 'Artifact filename is invalid.', 400);
    this.quota(actor.workspaceId, input.size, input.size);
    const now = this.support.now();
    const file: DriveFile = { id: this.support.id(), workspaceId: actor.workspaceId, storageId: folder.storageId, folderId: folder.id,
      name: input.name, extension: this.extension(input.name), mimeType: input.mimeType, currentVersionId: null, status: 'ACTIVE',
      sizeBytesCurrent: input.size, version: 1, trashedAt: null, purgeAfter: null, originalFolderId: null, statusBeforeTrash: null,
      publicShareVersion: 1, createdAt: now, updatedAt: now };
    this.name(file, folder.id, file.name);
    const version: DriveFileVersion = { id: this.support.id(), workspaceId: actor.workspaceId, fileId: file.id, versionNumber: 1,
      objectKey: input.objectKey, sizeBytes: input.size, checksum: input.checksum, mimeType: input.mimeType,
      createdByUserId: actor.user.id, createdAt: now, processedAt: now, scanStatus: 'CLEAN' };
    file.currentVersionId = version.id;
    this.state.driveFiles.push(file); this.state.driveFileVersions.push(version); this.record(actor, file, 'CREATED');
    return { file, version };
  }
  quota(workspaceId: string, growth: number, size?: number, excludeSessionId?: string) {
    const workspace = this.state.workspaces.find(row => row.id === workspaceId)!;
    const limit = (setting: string, capability: string, platform: number) => {
      const configured = workspace.settings[setting] ?? platform;
      if (!Number.isSafeInteger(configured) || Number(configured) < 0) throw new AppError('FILE_QUOTA_POLICY_INVALID', 'File quota limits must be non-negative safe integers.', 409);
      const grants = this.state.entitlementGrants.filter(row => row.workspaceId === workspaceId && row.capability === capability);
      if (grants.some(row => !row.enabled)) return 0;
      const limits = grants.filter(row => row.limit !== undefined && row.limit !== null).map(row => row.limit!);
      if (limits.some(value => !Number.isSafeInteger(value) || value < 0)) throw new AppError('FILE_QUOTA_POLICY_INVALID', 'Entitlement limits must be non-negative safe integers.', 409);
      return Math.min(platform, Number(configured), ...limits);
    };
    if (size !== undefined && size > limit('fileMaxBytes', 'files.max_file_bytes', MAX_FILE)) throw new AppError('FILE_TOO_LARGE', 'File size exceeds the effective single-file limit.', 413);
    const used = this.state.driveFileVersions.filter(row => row.workspaceId === workspaceId).reduce((sum, row) => sum + row.sizeBytes, 0) +
      this.state.uploadSessions.filter(row => row.workspaceId === workspaceId && row.id !== excludeSessionId && !row.resultVersionId && ['CREATED', 'UPLOADING', 'COMPLETING'].includes(row.status) && row.expiresAt > this.support.now()).reduce((sum, row) => sum + row.expectedSizeBytes, 0);
    if (growth > 0 && used + growth > limit('fileStorageQuotaBytes', 'files.storage_bytes', MAX_STORAGE)) throw new AppError('STORAGE_QUOTA_EXCEEDED', 'The Workspace storage quota would be exceeded.', 409);
  }
  get(actor: ActorContext, id: string) { return this.authority(actor, id, 'file.read'); }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'file.read');
    const visible = this.state.driveFiles.filter(row => row.workspaceId === actor.workspaceId && row.status !== 'TRASHED').filter(row => {
      try { this.get(actor, row.id); return true; } catch (error) { if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') return false; throw error; }
    });
    return pageOf(visible, query, { searchable: ['name'], filterable: ['storageId', 'folderId', 'status', 'mimeType', 'extension'], sortable: ['name', 'createdAt', 'updatedAt', 'sizeBytesCurrent'], defaultSort: 'name' });
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['name', 'version']); const row = this.authority(actor, id, 'file.update', 3, false, true); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const name = body.str('name', { required: true, max: 500 }).normalize('NFC'); this.name(row, row.folderId, name);
    const before = structuredClone(row); row.name = name; row.extension = this.extension(name); this.support.touch(row); this.record(actor, row, 'UPDATED', before); return row;
  }
  move(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['folderId', 'version']); const row = this.authority(actor, id, 'file.move', 3, false, true); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const folder = this.storages.folderAuthority(actor, body.uuid('folderId', { required: true }), 'file.move', 2);
    if (folder.storageId !== row.storageId) throw new AppError('FILE_NOT_FOUND', 'Destination was not found in this storage.', 404);
    this.name(row, folder.id, row.name); const before = structuredClone(row); row.folderId = folder.id;
    this.support.touch(row); this.record(actor, row, 'MOVED', before); return row;
  }
  private clean(row: DriveFile) {
    if (row.status === 'BLOCKED') throw new AppError('FILE_BLOCKED', 'File content is blocked.', 409);
    const current = this.state.driveFileVersions.find(version => version.id === row.currentVersionId && version.fileId === row.id && version.workspaceId === row.workspaceId);
    if (row.status !== 'ACTIVE' || !current || current.scanStatus !== 'CLEAN' || !current.processedAt) throw new AppError('FILE_QUARANTINED', 'File content is unavailable until processing succeeds.', 409);
    return current;
  }
  copy(actor: ActorContext, id: string, body: Body) {
    body.only(['folderId', 'name']); const source = this.authority(actor, id, 'file.copy'); this.clean(source);
    this.bindingAuthority(actor, source.id);
    const destination = this.storages.folderAuthority(actor, body.uuid('folderId', { required: true }), 'file.copy', 2);
    if (destination.storageId !== source.storageId) throw new AppError('FILE_NOT_FOUND', 'Copy must stay inside the original storage.', 404);
    const name = (body.str('name', { required: body.has('name'), max: 500 }) ?? source.name).normalize('NFC');
    const copyId = this.support.id(); this.name({ ...source, id: copyId }, destination.id, name);
    const originals = this.state.driveFileVersions.filter(version => version.fileId === id && version.workspaceId === source.workspaceId);
    this.quota(source.workspaceId, originals.reduce((sum, row) => sum + row.sizeBytes, 0), Math.max(...originals.map(row => row.sizeBytes)));
    const ids = new Map(originals.map(row => [row.id, this.support.id()])), now = this.support.now();
    const copied = { ...source, id: copyId, name, extension: this.extension(name), folderId: destination.id, currentVersionId: ids.get(source.currentVersionId!)!,
      publicShareVersion: 1, version: 1, createdAt: now, updatedAt: now };
    const versions = originals.map(row => ({ ...row, id: ids.get(row.id)!, fileId: copied.id, createdByUserId: actor.user.id, createdAt: now }));
    this.state.driveFiles.push(copied); this.state.driveFileVersions.push(...versions);
    // Immutable objects may be shared; ACLs, public capabilities and business bindings are not copied.
    this.record(actor, copied, 'CREATED'); return copied;
  }
  stageFolderCopy(actor: ActorContext, folderIds: Map<string, string>, storageId: string) {
    const sources = this.state.driveFiles.filter(row => row.workspaceId === actor.workspaceId && row.storageId === storageId && folderIds.has(row.folderId) && row.status !== 'TRASHED');
    for (const source of sources) { this.authority(actor, source.id, 'file.copy'); this.clean(source); this.bindingAuthority(actor, source.id); }
    const sourceIds = new Set(sources.map(row => row.id));
    const originals = this.state.driveFileVersions.filter(row => row.workspaceId === actor.workspaceId && sourceIds.has(row.fileId));
    if (sources.length > 1000 || originals.length > 5000) throw new AppError('FOLDER_GRAPH_LIMIT', 'Folder copy exceeds the synchronous File/Version limit.', 409);
    if (originals.length) this.quota(actor.workspaceId, originals.reduce((sum, row) => sum + row.sizeBytes, 0), originals.reduce((max, row) => Math.max(max, row.sizeBytes), 0));
    const fileIds = new Map(sources.map(row => [row.id, this.support.id()])), versionIds = new Map(originals.map(row => [row.id, this.support.id()])), now = this.support.now();
    return { files: sources.map(source => ({ ...source, id: fileIds.get(source.id)!, folderId: folderIds.get(source.folderId)!, currentVersionId: versionIds.get(source.currentVersionId!)!,
      publicShareVersion: 1, version: 1, createdAt: now, updatedAt: now })),
      versions: originals.map(row => ({ ...row, id: versionIds.get(row.id)!, fileId: fileIds.get(row.fileId)!, createdByUserId: actor.user.id, createdAt: now })) };
  }
  commitFolderCopy(actor: ActorContext, staged: ReturnType<FileService['stageFolderCopy']>) {
    this.state.driveFiles.push(...staged.files); this.state.driveFileVersions.push(...staged.versions);
    for (const row of staged.files) this.record(actor, row, 'CREATED');
  }
  trash(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']); const row = this.authority(actor, id, 'file.delete', 3, true, true); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status === 'TRASHED') return row;
    const days = Number(actor.workspace.settings.fileRetentionDays ?? 30);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new AppError('FILE_RETENTION_POLICY_INVALID', 'File retention must be 0 to 3650 days.', 409);
    const before = structuredClone(row), now = this.support.now();
    row.originalFolderId = row.folderId; row.statusBeforeTrash = row.status; row.status = 'TRASHED'; row.trashedAt = now;
    row.purgeAfter = new Date(now.getTime() + days * 86400000); row.publicShareVersion += 1;
    this.support.touch(row); this.record(actor, row, 'TRASHED', before); return row;
  }
  restore(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['folderId', 'name', 'version']); const row = this.authority(actor, id, 'file.restore', 3, true, true); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status !== 'TRASHED') throw new AppError('FILE_STATE_INVALID', 'Only trashed Files can be restored.', 409);
    const folderId = body.uuid('folderId') ?? row.originalFolderId;
    if (!folderId) throw new AppError('FILE_RESTORE_CONFLICT', 'Supply an active restore folder.', 409);
    const folder = this.storages.folderAuthority(actor, folderId, 'file.restore', 2);
    if (folder.storageId !== row.storageId) throw new AppError('FILE_NOT_FOUND', 'Destination was not found in this storage.', 404);
    const name = (body.str('name', { required: body.has('name'), max: 500 }) ?? row.name).normalize('NFC'); this.name(row, folderId, name);
    const before = structuredClone(row), current = this.state.driveFileVersions.find(version => version.id === row.currentVersionId);
    const status = current?.scanStatus === 'BLOCKED' ? 'BLOCKED' : current?.scanStatus === 'CLEAN' && current.processedAt && row.statusBeforeTrash === 'ACTIVE' ? 'ACTIVE' : row.statusBeforeTrash === 'PROCESSING' ? 'PROCESSING' : 'QUARANTINED';
    Object.assign(row, { folderId, name, extension: this.extension(name), status, statusBeforeTrash: null, originalFolderId: null, trashedAt: null, purgeAfter: null });
    this.support.touch(row); this.record(actor, row, 'RESTORED', before); return row;
  }
  versions(actor: ActorContext, id: string, query: URLSearchParams) {
    this.get(actor, id);
    return pageOf(this.state.driveFileVersions.filter(row => row.fileId === id && row.workspaceId === actor.workspaceId).map(row => this.safeVersion(row)), query,
      { searchable: [], filterable: ['scanStatus'], sortable: ['versionNumber', 'createdAt'], defaultSort: 'versionNumber' });
  }
  version(actor: ActorContext, id: string, versionId: string) {
    this.get(actor, id); const row = this.state.driveFileVersions.find(row => row.id === versionId && row.fileId === id && row.workspaceId === actor.workspaceId);
    if (!row) throw new AppError('FILE_VERSION_NOT_FOUND', 'File Version was not found.', 404); return this.safeVersion(row);
  }
  restoreVersion(actor: ActorContext, id: string, versionId: string, body: Body, ifMatch?: number) {
    body.only(['version']); const file = this.authority(actor, id, 'file.version_restore', 3, false, true); this.support.expectVersion(file, body.raw.version ?? ifMatch);
    const previous = this.state.driveFileVersions.find(row => row.id === versionId && row.fileId === id && row.workspaceId === actor.workspaceId);
    if (!previous) throw new AppError('FILE_VERSION_NOT_FOUND', 'File Version was not found.', 404);
    if (previous.scanStatus !== 'CLEAN' || !previous.processedAt) throw new AppError(previous.scanStatus === 'BLOCKED' ? 'FILE_BLOCKED' : 'FILE_QUARANTINED', 'Only clean, processed historical content can be restored.', 409);
    this.quota(file.workspaceId, previous.sizeBytes, previous.sizeBytes);
    const nextNumber = this.state.driveFileVersions.filter(row => row.fileId === id).reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
    if (nextNumber > 2147483647) throw new AppError('FILE_VERSION_LIMIT', 'This File has reached its Version number limit.', 409);
    const before = structuredClone(file), version: DriveFileVersion = { ...previous, id: this.support.id(),
      versionNumber: nextNumber,
      createdByUserId: actor.user.id, createdAt: this.support.now() };
    this.state.driveFileVersions.push(version); file.currentVersionId = version.id; file.sizeBytesCurrent = version.sizeBytes; file.mimeType = version.mimeType; file.status = 'ACTIVE';
    this.support.touch(file); this.record(actor, file, 'VERSION_CREATED', before); return { file, version: this.safeVersion(version) };
  }
  processing(actor: ActorContext, id: string) {
    const file = this.get(actor, id), current = this.state.driveFileVersions.find(row => row.id === file.currentVersionId);
    return { fileId: id, status: file.status, currentVersionId: file.currentVersionId, scanStatus: current?.scanStatus ?? 'PENDING', version: file.version };
  }
  private ancestors(workspaceId: string, folderId: string) {
    const rows = [], seen = new Set<string>(); let id: string | null = folderId;
    while (id) {
      if (seen.has(id) || seen.size >= 1000) throw new AppError('FOLDER_HIERARCHY_CYCLE', 'Invalid retention ancestry.', 409);
      seen.add(id);
      const row = this.state.fileFolders.find(row => row.id === id && row.workspaceId === workspaceId);
      if (!row) throw new AppError('FOLDER_NOT_FOUND', 'Retention ancestry was not found.', 404);
      rows.push(row); id = row.parentFolderId;
    }
    return rows;
  }
  private retained(workspaceId: string, ids: string[], deadlines: Array<Date | null>) {
    const now = this.support.now();
    if (deadlines.some(date => date && date > now) || this.state.retentionRecords.some(row => row.workspaceId === workspaceId &&
      ids.includes(row.resourceId) && !row.purgedAt && (row.legalHold || row.expiresAt > now)))
      throw new AppError('FILE_RETENTION_HOLD', 'Content is protected by retention or a legal hold.', 409);
  }
  private purgeContent(actor: ActorContext, content: DriveFile[], permission: string, folderIds = new Set<string>()) {
    if (content.length > 1000) throw new AppError('FOLDER_GRAPH_LIMIT', 'Purge supports at most 1000 Files per transaction.', 409);
    const fileIds = new Set(content.map(row => row.id));
    if (this.state.fileAttachments.some(row => row.workspaceId === actor.workspaceId && fileIds.has(row.fileId)))
      throw new AppError('FILE_HAS_ATTACHMENTS', 'Detach business attachments before permanently purging this File.', 409);
    const versions = this.state.driveFileVersions.filter(row => row.workspaceId === actor.workspaceId && fileIds.has(row.fileId));
    if (versions.length > 5000) throw new AppError('FOLDER_GRAPH_LIMIT', 'Purge supports at most 5000 Versions per transaction.', 409);
    for (const file of content) {
      this.authority(actor, file.id, permission, 4, true, false);
      const ancestors = this.ancestors(actor.workspaceId, file.folderId);
      if (file.status !== 'TRASHED' && !ancestors.some(row => row.status === 'TRASHED')) throw new AppError('FILE_STATE_INVALID', 'Trash content before permanent purge.', 409);
      this.retained(actor.workspaceId, [file.id, file.storageId, ...ancestors.map(row => row.id), ...versions.filter(row => row.fileId === file.id).map(row => row.id)],
        [file.purgeAfter, ...ancestors.map(row => row.purgeAfter)]);
    }
    const keys = [...new Set(versions.map(row => row.objectKey))].filter(key => !this.state.driveFileVersions.some(row => row.objectKey === key && !fileIds.has(row.fileId)));
    for (const key of keys) if (!key.startsWith(`${actor.workspaceId}/objects/`) || !/^[a-f0-9-]{36}\/objects\/[A-Za-z0-9/_-]+$/.test(key))
      throw new AppError('FILE_OBJECT_INVALID', 'Content cannot be safely queued for deletion.', 409);
    // Validate the whole graph first. Request persistence commits metadata, audit and cleanup intents atomically.
    const now = this.support.now();
    for (const session of this.state.uploadSessions.filter(row => row.workspaceId === actor.workspaceId && !row.purgedAt &&
      (fileIds.has(row.resultFileId!) || fileIds.has(row.targetFileId!) || !row.resultVersionId && folderIds.has(row.targetFolderId)))) {
      session.purgedAt = now;
      if (!session.resultVersionId && !['ABORTED', 'FAILED'].includes(session.status)) session.status = 'FAILED';
      session.processingClaimId = null; session.processingLeaseExpiresAt = null; session.processingNextAttemptAt = null;
      this.support.touch(session);
      const changes = { resultFileId: session.resultFileId, resultVersionId: session.resultVersionId, status: session.status };
      this.support.audit(actor, actor.workspaceId, 'UPLOAD.PURGED', 'UPLOAD_SESSION', session.id, null, changes);
      this.support.event({ workspaceId: actor.workspaceId, type: 'UPLOAD_PURGED', entityType: 'UPLOAD_SESSION', entityId: session.id, actorUserId: actor.user.id, changes });
    }
    this.state.driveFileVersions = this.state.driveFileVersions.filter(row => !fileIds.has(row.fileId));
    this.state.driveFiles = this.state.driveFiles.filter(row => !fileIds.has(row.id));
    this.state.filePermissionAssignments = this.state.filePermissionAssignments.filter(row => !(row.workspaceId === actor.workspaceId && row.resourceType === 'FILE' && fileIds.has(row.resourceId)));
    this.state.filePublicLinks = this.state.filePublicLinks.filter(row => !(row.workspaceId === actor.workspaceId && row.resourceType === 'FILE' && fileIds.has(row.resourceId)));
    for (const key of keys) if (!this.state.fileObjectGarbage.some(row => row.workspaceId === actor.workspaceId && row.objectKey === key))
      this.state.fileObjectGarbage.push({ id: this.support.id(), workspaceId: actor.workspaceId, objectKey: key, createdAt: now, updatedAt: now,
        claimId: null, leaseExpiresAt: null, nextAttemptAt: now, attempts: 0, errorCode: null, cleanedAt: null });
    for (const row of content) this.record(actor, row, 'DELETED', row);
    return { deletedFileCount: content.length, deletedVersionCount: versions.length, queuedObjectCount: keys.length };
  }
  purge(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']); const file = this.authority(actor, id, 'file.purge', 4, true, false);
    this.support.expectVersion(file, body.raw.version ?? ifMatch);
    if (file.status !== 'TRASHED') throw new AppError('FILE_STATE_INVALID', 'Trash the File before permanent purge.', 409);
    return { id, deleted: true, ...this.purgeContent(actor, [file], 'file.purge') };
  }
  purgeFolders(actor: ActorContext, folderIds: Set<string>) {
    for (const id of folderIds) {
      const ancestors = this.ancestors(actor.workspaceId, id);
      this.retained(actor.workspaceId, [...ancestors.map(row => row.id), ancestors[0].storageId], ancestors.map(row => row.purgeAfter));
    }
    return this.purgeContent(actor, this.state.driveFiles.filter(row => row.workspaceId === actor.workspaceId && folderIds.has(row.folderId)), 'folder.purge', folderIds);
  }
}
