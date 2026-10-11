import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import type { FilePort } from '../../ports';
import { Body, type CollabSupport, pageOf } from '../support';
import type { ProjectDriveService } from './project-drive-service';

export const ATTACHMENT_ROLES = ['ATTACHMENT', 'RESULT', 'COVER', 'DOCUMENT', 'MEDIA', 'OTHER'] as const;
export type FileAttachment = { id: string; workspaceId: string; fileId: string; entityType: string; entityId: string;
  role: typeof ATTACHMENT_ROLES[number]; attachedByUserId: string; createdAt: Date };
export interface AttachmentTarget {
  entityType: string;
  exists?(workspaceId: string, id: string): boolean;
  authorize(actor: ActorContext, id: string, write: boolean): void;
}

/** Owning modules supply their live read/mutation policies; bindings never confer authority. */
export class AttachmentService implements FilePort {
  private readonly targets = new Map<string, AttachmentTarget>();
  private legacyTargets: (workspaceId: string, fileId: string) => Array<{ entityType: string; entityId: string }> = () => [];
  registerLegacyTargets(resolve: typeof this.legacyTargets) {
    const previous = this.legacyTargets;
    this.legacyTargets = (workspaceId, fileId) => [...previous(workspaceId, fileId), ...resolve(workspaceId, fileId)];
  }
  hasPrivateBindings(workspaceId: string, fileId: string) {
    return this.state.fileAttachments.some(row => row.workspaceId === workspaceId && row.fileId === fileId) || this.legacyTargets(workspaceId, fileId).length > 0;
  }
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService) {}
  private get state() { return this.support.state; }
  register(target: AttachmentTarget) { this.targets.set(target.entityType, target); }
  authorizeEntity(actor: ActorContext, type: string, id: string, write = false, orphanDetach = false) {
    const target = this.targets.get(type);
    // A persisted binding has already proved tenant ownership. Owners can clean up references to deleted records.
    if (orphanDetach && actor.role.isOwnerRole && target?.exists && !target.exists(actor.workspaceId, id)) return;
    try {
      if (!target) throw new Error('Unsupported owning module');
      target.authorize(actor, id, write);
    } catch { throw new AppError('ATTACHMENT_ENTITY_ACCESS_DENIED', 'The owning record is inaccessible or does not allow this operation.', 403); }
  }
  authorizeBindings(actor: ActorContext, fileId: string) {
    for (const row of this.legacyTargets(actor.workspaceId, fileId)) this.authorizeEntity(actor, row.entityType, row.entityId);
    for (const row of this.state.fileAttachments.filter(row => row.workspaceId === actor.workspaceId && row.fileId === fileId))
      this.authorizeEntity(actor, row.entityType, row.entityId);
  }
  private file(actor: ActorContext, id: string, write = false) {
    try {
      const file = this.storages.fileAuthority(actor, id, 'file.read', 1, false, write);
      const version = this.state.driveFileVersions.find(row => row.workspaceId === actor.workspaceId && row.fileId === id && row.id === file.currentVersionId);
      if (file.status !== 'ACTIVE' || version?.scanStatus !== 'CLEAN' || !version.processedAt) throw new Error('Unavailable content');
      return file;
    } catch { throw new AppError('ATTACHMENT_FILE_ACCESS_DENIED', 'The File is inaccessible or unavailable.', 403); }
  }
  check(workspaceId: string, actor: ActorContext, fileId: string) {
    if (workspaceId !== actor.workspaceId || !this.state.driveFiles.some(row => row.workspaceId === workspaceId && row.id === fileId)) return 'MISSING' as const;
    try { this.file(actor, fileId); this.authorizeBindings(actor, fileId); return 'OK' as const; } catch { return 'FORBIDDEN' as const; }
  }
  private row(actor: ActorContext, id: string) {
    const row = this.state.fileAttachments.find(row => row.workspaceId === actor.workspaceId && row.id === id);
    if (!row) throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment was not found.', 404);
    return row;
  }
  get(actor: ActorContext, id: string) {
    this.support.require(actor, 'file.read');
    const row = this.row(actor, id); this.file(actor, row.fileId); this.authorizeEntity(actor, row.entityType, row.entityId);
    return { ...row };
  }
  list(actor: ActorContext, query: URLSearchParams, entityType?: string, entityId?: string) {
    this.support.require(actor, 'file.read');
    if (entityType !== undefined) {
      entityId = new Body({ entityId }).uuid('entityId', { required: true });
      this.authorizeEntity(actor, entityType, entityId);
    }
    const rows = this.state.fileAttachments.filter(row => row.workspaceId === actor.workspaceId &&
      (entityType === undefined || row.entityType === entityType && row.entityId === entityId)).filter(row => {
      try { this.file(actor, row.fileId); this.authorizeEntity(actor, row.entityType, row.entityId); return true; } catch { return false; }
    }).map(row => ({ ...row }));
    return pageOf(rows, query, { searchable: [], filterable: ['fileId', 'entityType', 'entityId', 'role'], sortable: ['createdAt'], defaultSort: 'createdAt' });
  }
  attach(actor: ActorContext, body: Body) {
    this.support.require(actor, 'file.attach'); this.support.require(actor, 'file.read');
    body.only(['fileId', 'entityType', 'entityId', 'role']);
    const fileId = body.uuid('fileId', { required: true }), entityId = body.uuid('entityId', { required: true });
    const entityType = body.str('entityType', { required: true, max: 50 });
    const role = body.enumOf('role', ATTACHMENT_ROLES, { required: body.has('role') }) ?? 'ATTACHMENT';
    const file = this.file(actor, fileId, true); this.authorizeBindings(actor, fileId); this.authorizeEntity(actor, entityType, entityId, true);
    const old = this.state.fileAttachments.find(row => row.workspaceId === actor.workspaceId && row.fileId === fileId && row.entityType === entityType && row.entityId === entityId && row.role === role);
    if (old) return { ...old };
    const row: FileAttachment = { id: this.support.id(), workspaceId: actor.workspaceId, fileId, entityType, entityId, role,
      attachedByUserId: actor.user.id, createdAt: this.support.now() };
    this.state.fileAttachments.push(row);
    // New private context and detach both retire previously issued File capabilities.
    file.publicShareVersion++; this.support.touch(file);
    this.publish(actor, row, 'FILE_ATTACHED'); return { ...row };
  }
  detach(actor: ActorContext, id: string, body: Body) {
    this.support.require(actor, 'file.detach'); this.support.require(actor, 'file.read'); body.only([]);
    const row = this.row(actor, id);
    // Trashed/quarantined content can be detached without opening its bytes.
    try { this.storages.fileAuthority(actor, row.fileId, 'file.read', 1, true); }
    catch { throw new AppError('ATTACHMENT_FILE_ACCESS_DENIED', 'The File is inaccessible.', 403); }
    this.authorizeEntity(actor, row.entityType, row.entityId, true, true);
    this.state.fileAttachments = this.state.fileAttachments.filter(item => item.id !== id);
    const file = this.state.driveFiles.find(item => item.id === row.fileId && item.workspaceId === actor.workspaceId)!;
    file.publicShareVersion++; this.support.touch(file);
    this.publish(actor, row, 'FILE_DETACHED'); return { id, detached: true };
  }
  private publish(actor: ActorContext, row: FileAttachment, type: string) {
    this.support.event({ workspaceId: actor.workspaceId, type, entityType: 'FILE_ATTACHMENT', entityId: row.id,
      actorUserId: actor.user.id, changes: { fileId: row.fileId, entityType: row.entityType, entityId: row.entityId, role: row.role }, audienceUserIds: [actor.user.id] });
    if (this.state.workspaces.find(item => item.id === actor.workspaceId)?.settings.auditFileAttachments === true)
      this.support.audit(actor, actor.workspaceId, type === 'FILE_ATTACHED' ? 'FILE.ATTACHED' : 'FILE.DETACHED', 'FILE_ATTACHMENT', row.id,
        type === 'FILE_DETACHED' ? row : null, type === 'FILE_ATTACHED' ? row : null);
  }
}
