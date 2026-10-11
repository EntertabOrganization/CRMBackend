import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport } from '../support';
import type { FileLock } from './editing-types';
import type { ProjectDriveService } from './project-drive-service';

/** Lease identities are never reused: expiry/release cannot resurrect an old edit owner. */
export class FileLockService {
  private sessionClosed: (session: import('./editing-types').DocumentEditSession) => void = () => {};
  onSessionClosed(listener: typeof this.sessionClosed) { this.sessionClosed = listener; }
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService,
    private readonly bindings: (actor: ActorContext, id: string) => void) {}
  private get state() { return this.support.state; }
  safe(row: FileLock) { const { lockTokenHash, ...safe } = row; return { ...safe, isActive: !row.releasedAt && row.expiresAt > this.support.now() }; }
  private authority(actor: ActorContext, id: string, permission: string, full = false, editable = true) {
    const file = this.storages.fileAuthority(actor, id, permission, full ? 4 : 3, !editable, editable);
    this.bindings(actor, id);
    if (editable && file.status !== 'ACTIVE') throw new AppError('FILE_NOT_EDITABLE', 'This File is not available for editing.', 409);
    const version = this.state.driveFileVersions.find(row => row.workspaceId === actor.workspaceId && row.fileId === id && row.id === file.currentVersionId);
    if (editable && (version?.scanStatus !== 'CLEAN' || !version.processedAt)) throw new AppError('FILE_NOT_EDITABLE', 'The current Version is not clean and processed.', 409);
    return file;
  }
  assertUnlocked(workspaceId: string, fileIds: string[], allowedLockId?: string) {
    const now = this.support.now();
    if (this.state.fileLocks.some(row => row.workspaceId === workspaceId && fileIds.includes(row.fileId) && !row.releasedAt && row.expiresAt > now && row.id !== allowedLockId))
      throw new AppError('FILE_LOCKED', 'The File has an active exclusive lease.', 409);
  }
  acquire(actor: ActorContext, fileId: string, body: Body) {
    body.only(['lockType', 'leaseSeconds']);
    const lockType = body.enumOf('lockType', ['EDIT', 'SYSTEM_PROCESS', 'WORKFLOW'] as const, { required: body.has('lockType') }) ?? 'EDIT';
    const leaseSeconds = body.int('leaseSeconds', { min: 15, max: 900 }) ?? 300;
    this.authority(actor, fileId, 'file.lock', lockType !== 'EDIT');
    this.assertUnlocked(actor.workspaceId, [fileId]);
    const now = this.support.now();
    if (this.state.documentEditSessions.some(row => row.workspaceId === actor.workspaceId && row.fileId === fileId && row.status === 'ACTIVE' && row.expiresAt > now))
      throw new AppError('FILE_LOCKED', 'The File has an active collaborative edit session.', 409);
    // Retire stale leases in the same transaction before the independent SQL exclusivity constraint is checked.
    for (const old of this.state.fileLocks.filter(row => row.workspaceId === actor.workspaceId && row.fileId === fileId && !row.releasedAt && row.expiresAt <= now)) {
      old.releasedAt = now; old.version++; this.closeSessions(old); this.publish(actor, old, 'FILE_LOCK_RELEASED', { reason: 'EXPIRED' });
    }
    const token = randomBytes(32).toString('base64url');
    const row: FileLock = { id: this.support.id(), workspaceId: actor.workspaceId, fileId, lockType,
      lockedByUserId: actor.user.id, lockTokenHash: createHash('sha256').update(token).digest('hex'),
      lockedAt: now, expiresAt: new Date(now.getTime() + leaseSeconds * 1000), releasedAt: null, version: 1 };
    this.state.fileLocks.push(row); this.publish(actor, row, 'FILE_LOCK_ACQUIRED');
    // Secret is returned only at acquisition; persisted/API/audit projections retain no reusable token.
    return { ...this.safe(row), lockToken: token };
  }
  private row(actor: ActorContext, fileId: string, id: string) {
    const row = this.state.fileLocks.find(row => row.id === id && row.workspaceId === actor.workspaceId && row.fileId === fileId);
    if (!row) throw new AppError('FILE_LOCK_NOT_FOUND', 'File lock was not found.', 404);
    return row;
  }
  verify(actor: ActorContext, row: FileLock, token: string) {
    const expected = Buffer.from(row.lockTokenHash, 'hex'), actual = createHash('sha256').update(token).digest();
    if (row.lockedByUserId !== actor.user.id || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new AppError('FILE_LOCK_NOT_FOUND', 'File lock was not found.', 404);
  }
  release(actor: ActorContext, fileId: string, id: string, body: Body) {
    body.only(['lockToken']); this.authority(actor, fileId, 'file.lock', false, false);
    const row = this.row(actor, fileId, id); this.verify(actor, row, body.str('lockToken', { required: true, max: 200 }));
    if (!row.releasedAt) { row.releasedAt = this.support.now(); row.version++; this.closeSessions(row); this.publish(actor, row, 'FILE_LOCK_RELEASED'); }
    return this.safe(row);
  }
  releaseForEdit(actor: ActorContext, fileId: string, id: string, token: string) {
    this.authority(actor, fileId, 'file.edit', false, false);
    const row = this.row(actor, fileId, id); this.verify(actor, row, token);
    if (!row.releasedAt) { row.releasedAt = this.support.now(); row.version++; this.closeSessions(row); this.publish(actor, row, 'FILE_LOCK_RELEASED'); }
    return this.safe(row);
  }
  forceRelease(actor: ActorContext, fileId: string, id: string, body: Body) {
    body.only(['version', 'reason']); this.authority(actor, fileId, 'file.force_unlock', true, false);
    const row = this.row(actor, fileId, id); this.support.expectVersion(row, body.raw.version);
    const reason = body.str('reason', { required: true, max: 1000 });
    if (!row.releasedAt) {
      row.releasedAt = this.support.now(); row.version++;
      this.closeSessions(row);
      this.publish(actor, row, 'FILE_LOCK_RELEASED', { forced: true });
      this.support.audit(actor, actor.workspaceId, 'FILE.FORCE_UNLOCKED', 'FILE_LOCK', row.id, null, this.safe(row), { reason });
    }
    return this.safe(row);
  }
  renew(actor: ActorContext, fileId: string, id: string, token: string, leaseSeconds = 300) {
    new Body({ leaseSeconds }).int('leaseSeconds', { required: true, min: 15, max: 900 });
    const row = this.row(actor, fileId, id); this.verify(actor, row, token);
    const now = this.support.now();
    if (row.releasedAt || row.expiresAt <= now) throw new AppError('EDIT_SESSION_EXPIRED', 'The exclusive edit lease has expired.', 410);
    row.expiresAt = new Date(now.getTime() + leaseSeconds * 1000); row.version++; return row;
  }
  private closeSessions(lock: FileLock) {
    const now = this.support.now();
    for (const row of this.state.documentEditSessions.filter(row => row.workspaceId === lock.workspaceId && row.lockId === lock.id && row.status === 'ACTIVE')) {
      row.status = row.expiresAt <= now ? 'EXPIRED' : 'ABORTED'; row.endedAt = now; row.version++;
      this.sessionClosed(row);
    }
  }
  retireForSession(session: import('./editing-types').DocumentEditSession) {
    if (session.status === 'ACTIVE') throw new AppError('FILE_LOCKED', 'The edit session still owns this lease.', 409);
    const lock = this.state.fileLocks.find(row => row.id === session.lockId && row.workspaceId === session.workspaceId && row.fileId === session.fileId && row.lockedByUserId === session.userId);
    if (lock && !lock.releasedAt) {
      lock.releasedAt = this.support.now(); lock.version++;
      this.support.event({ workspaceId: lock.workspaceId, type: 'FILE_LOCK_RELEASED', entityType: 'FILE_LOCK', entityId: lock.id,
        actorUserId: null, changes: { fileId: lock.fileId, reason: session.status }, audienceUserIds: [session.userId] });
    }
  }
  private publish(actor: ActorContext, row: FileLock, type: string, changes: Record<string, unknown> = {}) {
    this.support.event({ workspaceId: actor.workspaceId, type, entityType: 'FILE_LOCK', entityId: row.id,
      actorUserId: actor.user.id, changes: { fileId: row.fileId, lockType: row.lockType, expiresAt: row.expiresAt.toISOString(), ...changes }, audienceUserIds: [actor.user.id] });
  }
}
