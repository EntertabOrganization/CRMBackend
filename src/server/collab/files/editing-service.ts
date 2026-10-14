import { createHash } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError, isAppError } from '../../errors';
import { Body, fingerprint, pageOf, type CollabSupport } from '../support';
import { EDIT_PROVIDERS, type DocumentEditSession } from './editing-types';
import { EnvironmentEditingProvider, type EditingProvider, type EditorIdentity, type EditorResult } from './editor-provider';
import type { FileLockService } from './lock-service';
import type { ProjectDriveService } from './project-drive-service';
import type { UploadService } from './upload-service';
import { defaultContentAuthority, type FileContentAuthority } from './content-authority';

export type EditStartTicket = EditorIdentity & { objectKey: string; checksum: string; sizeBytes: number; mimeType: string; name: string; expiresAt: Date; lockToken?: string };
/** Each phase runs in a fresh state unit. Provider I/O runs between committed phases. */
export class DocumentEditingService {
  private provider: EditingProvider = new EnvironmentEditingProvider();
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService,
    private readonly locks: FileLockService, private readonly uploads: UploadService,
    private readonly bindings: (actor: ActorContext, id: string) => void,
    private readonly authorizeContent: FileContentAuthority = defaultContentAuthority) {}
  configure(provider: EditingProvider) { this.provider = provider; }
  editingProvider() { return this.provider; }
  private get state() { return this.support.state; }
  identity(row: DocumentEditSession): EditorIdentity {
    return { id: row.id, workspaceId: row.workspaceId, fileId: row.fileId, userId: row.userId, baseVersionId: row.baseVersionId, provider: row.provider };
  }
  safe(row: DocumentEditSession) {
    return { id: row.id, fileId: row.fileId, userId: row.userId, provider: row.provider, mode: row.mode, status: row.status,
      startedAt: row.startedAt, lastActivityAt: row.lastActivityAt, endedAt: row.endedAt, expiresAt: row.expiresAt,
      lockId: row.lockId, baseVersionId: row.baseVersionId, resultVersionId: row.resultVersionId, version: row.version };
  }
  private authority(actor: ActorContext, fileId: string, active: boolean) {
    const file = this.storages.fileAuthority(actor, fileId, 'file.edit', 3, !active, active);
    this.bindings(actor, fileId);
    const version = this.state.driveFileVersions.find(v => v.workspaceId === actor.workspaceId && v.fileId === fileId && v.id === file.currentVersionId);
    if (active && (file.status !== 'ACTIVE' || version?.scanStatus !== 'CLEAN' || !version.processedAt))
      throw new AppError('FILE_NOT_EDITABLE', 'The File must have a clean, processed current Version.', 409);
    return { file, version };
  }
  private owned(actor: ActorContext, id: string) {
    const row = this.state.documentEditSessions.find(r => r.id === id && r.workspaceId === actor.workspaceId && r.userId === actor.user.id);
    if (!row) throw new AppError('EDIT_SESSION_NOT_FOUND', 'Edit session was not found.', 404);
    this.authority(actor, row.fileId, false); return row;
  }
  private active(actor: ActorContext, row: DocumentEditSession, lockToken?: string, ready = true) {
    if (row.status !== 'ACTIVE' || row.expiresAt <= this.support.now()) throw new AppError('EDIT_SESSION_EXPIRED', 'The edit session is no longer active.', 410);
    if (ready && !row.providerReady) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor is not ready.', 409);
    const source = this.authority(actor, row.fileId, true);
    if (source.file.currentVersionId !== row.baseVersionId) throw new AppError('RESOURCE_VERSION_CONFLICT', 'The edited source Version has changed.', 409);
    this.locks.assertUnlocked(actor.workspaceId, [row.fileId], row.lockId ?? undefined);
    if (row.lockId) {
      const lock = this.state.fileLocks.find(l => l.id === row.lockId && l.workspaceId === row.workspaceId && l.fileId === row.fileId);
      if (!lock || lock.releasedAt || lock.expiresAt <= this.support.now()) throw new AppError('EDIT_SESSION_EXPIRED', 'The exclusive lease is no longer active.', 410);
      this.locks.verify(actor, lock, lockToken ?? '');
    }
    return source;
  }
  reserve(actor: ActorContext, fileId: string, body: Body): EditStartTicket {
    body.only(['provider', 'mode', 'leaseSeconds']);
    const provider = body.enumOf('provider', EDIT_PROVIDERS) ?? 'INTERNAL_DOCS';
    const mode = body.enumOf('mode', ['COLLABORATIVE', 'EXCLUSIVE_LOCK'] as const) ?? 'EXCLUSIVE_LOCK';
    const seconds = body.int('leaseSeconds', { min: 15, max: 900 }) ?? 300;
    const { file, version } = this.authority(actor, fileId, true);
    this.provider.assertConfigured(provider);
    if (!version || !this.provider.supports(provider, version.mimeType)) throw new AppError('FILE_NOT_EDITABLE', 'The provider does not support this File.', 409);
    this.expireDue(100);
    this.locks.assertUnlocked(actor.workspaceId, [fileId]);
    const lock = mode === 'EXCLUSIVE_LOCK' ? this.locks.acquire(actor, fileId, new Body({ leaseSeconds: seconds })) : null;
    const now = this.support.now(), id = this.support.id();
    const row: DocumentEditSession = { id, workspaceId: actor.workspaceId, fileId, userId: actor.user.id, provider, providerSessionId: id, mode,
      status: 'ACTIVE', startedAt: now, lastActivityAt: now, endedAt: null, expiresAt: new Date(now.getTime() + seconds * 1000),
      lockId: lock?.id ?? null, baseVersionId: version.id, resultVersionId: null, version: 1, providerReady: false,
      saveRequestHash: null, uploadSessionId: null, cleanupRequired: false, cleanupClaimId: null, cleanupLeaseExpiresAt: null,
      cleanupNextAttemptAt: null, cleanupAttempts: 0, cleanupErrorCode: null };
    this.state.documentEditSessions.push(row);
    if (lock) row.expiresAt = lock.expiresAt;
    return { ...this.identity(row), objectKey: version.objectKey, checksum: version.checksum, sizeBytes: version.sizeBytes,
      mimeType: version.mimeType, name: file.name, expiresAt: row.expiresAt, ...(lock ? { lockToken: lock.lockToken } : {}) };
  }
  async open(ticket: EditStartTicket, signal?: AbortSignal) {
    const user = this.state.users.find(row => row.id === ticket.userId);
    if (!user) throw new AppError('PERMISSION_DENIED', 'Editor principal is unavailable.', 403);
    await this.authorizeContent(this.support.access.actor(user, ticket.workspaceId), ticket.objectKey, 'EDIT');
    let bytes: Buffer;
    try { bytes = await this.uploads.objectStorage().read(ticket.objectKey); }
    catch { throw new AppError('EDIT_PROVIDER_ERROR', 'The source content is unavailable.', 502); }
    if (bytes.length !== ticket.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== ticket.checksum)
      throw new AppError('EDIT_PROVIDER_ERROR', 'The source content failed integrity verification.', 502);
    const { id, workspaceId, fileId, userId, baseVersionId, provider, mimeType, name, checksum, expiresAt } = ticket;
    let result: Awaited<ReturnType<EditingProvider['open']>>;
    try { result = await this.provider.open({ id, workspaceId, fileId, userId, baseVersionId, provider, mimeType, name, checksum, expiresAt, bytes }, signal); }
    catch (error) { if (isAppError(error)) throw error; throw new AppError('EDIT_PROVIDER_ERROR', 'The editor could not open this session.', 502); }
    if (result.providerSessionId !== ticket.id) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned an unbound session.', 502);
    return { ...result, ...(ticket.provider === 'INTERNAL_DOCS' ? { dataBase64: bytes.toString('base64') } : {}) };
  }
  activate(actor: ActorContext, ticket: EditStartTicket) {
    const row = this.owned(actor, ticket.id); this.active(actor, row, ticket.lockToken, false);
    if (fingerprint(this.identity(row)) !== fingerprint({ id: ticket.id, workspaceId: ticket.workspaceId, fileId: ticket.fileId, userId: ticket.userId, baseVersionId: ticket.baseVersionId, provider: ticket.provider }))
      throw new AppError('EDIT_SESSION_NOT_FOUND', 'Edit session was not found.', 404);
    if (!row.providerReady) { row.providerReady = true; row.version++; this.publish(actor, row, 'FILE_EDIT_SESSION_STARTED'); }
    return this.safe(row);
  }
  get(actor: ActorContext, id: string) { return this.safe(this.owned(actor, id)); }
  list(actor: ActorContext, fileId: string, query = new URLSearchParams()) {
    this.authority(actor, fileId, false);
    const rows = this.state.documentEditSessions.filter(r => r.workspaceId === actor.workspaceId && r.fileId === fileId && r.userId === actor.user.id).map(r => this.safe(r));
    return pageOf(rows, query, { searchable: [], filterable: ['status', 'provider', 'mode'], sortable: ['startedAt', 'lastActivityAt'], defaultSort: 'startedAt', defaultOrder: 'desc' });
  }
  heartbeat(actor: ActorContext, id: string, body: Body) {
    body.only(['version', 'lockToken', 'leaseSeconds']); const row = this.owned(actor, id);
    const token = body.str('lockToken', { max: 200 }) ?? undefined;
    this.active(actor, row, token); this.support.expectVersion(row, body.raw.version);
    const seconds = body.int('leaseSeconds', { min: 15, max: 900 }) ?? 300;
    const now = this.support.now(), expiry = new Date(Math.max(row.expiresAt.getTime(), now.getTime() + seconds * 1000));
    if (row.lockId) this.locks.renew(actor, row.fileId, row.lockId, token!, Math.ceil((expiry.getTime() - now.getTime()) / 1000));
    row.lastActivityAt = now; row.expiresAt = expiry; row.version++; return this.safe(row);
  }
  abort(actor: ActorContext, id: string, body: Body) {
    body.only(['version', 'lockToken']); const row = this.owned(actor, id);
    if (row.lockId) {
      const lock = this.state.fileLocks.find(r => r.id === row.lockId)!;
      this.locks.verify(actor, lock, body.str('lockToken', { required: true, max: 200 }));
    }
    if (row.status !== 'ACTIVE') return this.safe(row);
    this.support.expectVersion(row, body.raw.version);
    this.end(row, row.expiresAt <= this.support.now() ? 'EXPIRED' : 'ABORTED');
    this.publish(actor, row, 'FILE_EDIT_SESSION_ABORTED'); return this.safe(row);
  }
  compensate(ticket: EditorIdentity) {
    const { id, workspaceId, fileId, userId, baseVersionId, provider } = ticket;
    const row = this.state.documentEditSessions.find(r => r.id === ticket.id && fingerprint(this.identity(r)) === fingerprint({ id, workspaceId, fileId, userId, baseVersionId, provider }));
    if (!row || row.status === 'COMPLETED') return;
    if (row.status === 'ACTIVE') this.end(row, row.expiresAt <= this.support.now() ? 'EXPIRED' : 'ABORTED');
    else { this.scheduleCleanup(row); row.version++; }
  }
  expireDue(limit: number) {
    const rows = this.state.documentEditSessions.filter(r => r.status === 'ACTIVE' && r.expiresAt <= this.support.now()).slice(0, limit);
    for (const row of rows) this.end(row, 'EXPIRED'); return rows.length;
  }
  scheduleCleanup(row: DocumentEditSession) {
    if (!row.cleanupRequired) this.support.audit(null, row.workspaceId, 'FILE.EDIT_SESSION_CLEANUP_REQUESTED', 'DOCUMENT_EDIT_SESSION', row.id, null,
      { fileId: row.fileId, status: row.status, resultVersionId: row.resultVersionId });
    row.cleanupRequired = true; row.cleanupNextAttemptAt = this.support.now();
    this.uploads.cancelEditUpload(row);
  }
  private end(row: DocumentEditSession, status: 'ABORTED' | 'EXPIRED' | 'COMPLETED') {
    row.status = status; row.endedAt = this.support.now(); row.version++;
    this.locks.retireForSession(row); this.scheduleCleanup(row);
  }
  beginSave(actor: ActorContext, id: string, body: Body) {
    body.only(['version', 'lockToken', 'dataBase64', 'saveId']); const row = this.owned(actor, id);
    const token = body.str('lockToken', { max: 200 }) ?? undefined;
    const input = { dataBase64: body.str('dataBase64', { trim: false, max: 139810136 }) ?? undefined, saveId: body.str('saveId', { max: 200 }) ?? undefined };
    if (row.provider === 'INTERNAL_DOCS') {
      if (input.dataBase64 === undefined || input.saveId !== undefined) throw new AppError('VALIDATION_ERROR', 'Supply edited text content.', 400);
      const bytes = Buffer.from(input.dataBase64, 'base64');
      if (bytes.length > 100 * 1024 * 1024 || bytes.toString('base64') !== input.dataBase64) throw new AppError('VALIDATION_ERROR', 'Supply canonical base64 content of at most 100 MiB.', 400);
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AppError('VALIDATION_ERROR', 'Text must use valid UTF-8.', 400); }
    } else if (!input.saveId || input.dataBase64 !== undefined) throw new AppError('VALIDATION_ERROR', 'Supply a provider save receipt.', 400);
    const hash = fingerprint({ ...this.identity(row), ...input });
    if (row.saveRequestHash && row.saveRequestHash !== hash) throw new AppError('EDIT_SAVE_CONFLICT', 'This session has another save request.', 409);
    if (row.status === 'COMPLETED') return { completed: this.safe(row), hash, identity: this.identity(row), input, mimeType: '', lockToken: token };
    const { version } = this.active(actor, row, token);
    if (!row.saveRequestHash) { this.support.expectVersion(row, body.raw.version); row.saveRequestHash = hash; row.version++; }
    return { completed: null, hash, identity: this.identity(row), input, mimeType: version!.mimeType, lockToken: token };
  }
  async saveContent(ticket: ReturnType<DocumentEditingService['beginSave']>, signal?: AbortSignal) {
    try { return await this.provider.save(ticket.identity, ticket.mimeType, ticket.input, signal); }
    catch (error) { if (isAppError(error)) throw error; throw new AppError('EDIT_PROVIDER_ERROR', 'The editor could not save this session.', 502); }
  }
  private saving(actor: ActorContext, id: string, hash: string, token?: string) {
    const row = this.owned(actor, id); this.active(actor, row, token);
    if (row.saveRequestHash !== hash) throw new AppError('EDIT_SAVE_CONFLICT', 'The save request changed.', 409); return row;
  }
  stageSave(actor: ActorContext, id: string, hash: string, result: EditorResult, token?: string) {
    const existingSession = this.owned(actor, id);
    if (existingSession.status === 'COMPLETED' && existingSession.saveRequestHash === hash) return existingSession.uploadSessionId!;
    const row = this.saving(actor, id, hash, token);
    if (result.bytes.length > 100 * 1024 * 1024 || createHash('sha256').update(result.bytes).digest('hex') !== result.checksum ||
      result.mimeType !== this.state.driveFileVersions.find(v => v.id === row.baseVersionId)?.mimeType)
      throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned inconsistent content.', 502);
    if (row.uploadSessionId) {
      const existing = this.state.uploadSessions.find(u => u.id === row.uploadSessionId && u.editSessionId === row.id);
      if (!existing || existing.expectedChecksum !== result.checksum || existing.expectedSizeBytes !== result.bytes.length || existing.mimeType !== result.mimeType)
        throw new AppError('EDIT_SAVE_CONFLICT', 'The provider changed previously staged content.', 409);
      return existing.id;
    }
    row.uploadSessionId = this.uploads.createForEdit(actor, row, result.checksum, result.bytes.length, result.mimeType).id; row.version++;
    return row.uploadSessionId;
  }
  async writePart(actor: ActorContext, id: string, hash: string, partNumber: number, bytes: Buffer, token?: string) {
    const existing = this.owned(actor, id);
    if (existing.status === 'COMPLETED' && existing.saveRequestHash === hash) return this.safe(existing);
    const row = this.saving(actor, id, hash, token);
    if (!row.uploadSessionId) throw new AppError('EDIT_SAVE_CONFLICT', 'The save has not been staged.', 409);
    return this.uploads.part(actor, row.uploadSessionId, new Body({ partNumber, dataBase64: bytes.toString('base64'), checksum: createHash('sha256').update(bytes).digest('hex') }), row.id);
  }
  async finishSave(actor: ActorContext, id: string, hash: string, token?: string) {
    const existing = this.owned(actor, id);
    if (existing.status === 'COMPLETED' && existing.saveRequestHash === hash) return this.safe(existing);
    const row = this.saving(actor, id, hash, token);
    if (!row.uploadSessionId) throw new AppError('EDIT_SAVE_CONFLICT', 'The save has not been staged.', 409);
    const receipt = await this.uploads.complete(actor, row.uploadSessionId, new Body({}), row.id);
    if (!receipt.resultVersionId) throw new AppError('EDIT_PROVIDER_ERROR', 'The save was not accepted.', 502);
    row.resultVersionId = receipt.resultVersionId; row.lastActivityAt = this.support.now(); this.end(row, 'COMPLETED');
    this.publish(actor, row, 'FILE_EDIT_SESSION_COMPLETED'); return this.safe(row);
  }
  private publish(actor: ActorContext, row: DocumentEditSession, type: string) {
    this.support.audit(actor, row.workspaceId, type, 'DOCUMENT_EDIT_SESSION', row.id, null, this.safe(row));
    this.support.event({ workspaceId: row.workspaceId, type, entityType: 'DOCUMENT_EDIT_SESSION', entityId: row.id,
      actorUserId: actor.user.id, changes: { fileId: row.fileId, status: row.status, resultVersionId: row.resultVersionId }, audienceUserIds: [row.userId] });
  }
}
