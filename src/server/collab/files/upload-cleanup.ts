import { AppError, isAppError } from '../../errors';
import type { DeliveryOutcome, LeaseJobHandler } from '../../jobs/lease-runner';
import type { CollabSupport } from '../support';
import type { UploadSession } from './types';
import type { ObjectStorage } from './object-storage';

type Ticket = { id: string; workspaceId: string; token: string; attempt: number; keys: string[] };
export class UploadCleanup implements LeaseJobHandler<Ticket> {
  constructor(private readonly support: CollabSupport, private readonly objects: () => ObjectStorage) {}
  private get state() { return this.support.state; }
  private terminal(row: UploadSession) {
    return row.resultVersionId ? ['PROCESSING', 'COMPLETED'].includes(row.status) : ['ABORTED', 'FAILED'].includes(row.status);
  }
  private publish(row: UploadSession, action: string) {
    const changes = { status: row.status, attempts: row.cleanupAttempts, errorCode: row.cleanupErrorCode, partCount: row.parts.length };
    this.support.audit(null, row.workspaceId, `UPLOAD.${action}`, 'UPLOAD_SESSION', row.id, null, changes);
    this.support.event({ workspaceId: row.workspaceId, type: `UPLOAD_${action}`, entityType: 'UPLOAD_SESSION', entityId: row.id, actorUserId: null, changes });
  }
  claimDue(limit: number, token: string, now: Date) {
    const due = this.state.uploadSessions.filter(row =>
      (this.terminal(row) || !row.resultVersionId && ['CREATED', 'UPLOADING', 'COMPLETING'].includes(row.status) && row.expiresAt <= now) &&
      (!row.cleanupLeaseExpiresAt || row.cleanupLeaseExpiresAt <= now) && (!row.cleanupNextAttemptAt || row.cleanupNextAttemptAt <= now))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of due) {
      if (!this.terminal(row)) { row.status = 'FAILED'; this.publish(row, 'EXPIRED'); }
      row.cleanupClaimId = token; row.cleanupLeaseExpiresAt = new Date(now.getTime() + 300_000);
      row.cleanupAttempts = Math.min(row.cleanupAttempts + 1, 2147483647); row.cleanupNextAttemptAt = null;
      this.support.touch(row);
    }
    return due.map(row => row.id);
  }
  private live(id: string, token: string, now: Date) {
    return this.state.uploadSessions.find(row => row.id === id && this.terminal(row) && row.cleanupClaimId === token && row.cleanupLeaseExpiresAt && row.cleanupLeaseExpiresAt > now);
  }
  prepare(id: string, token: string, now: Date): Ticket | null {
    const row = this.live(id, token, now); if (!row) return null;
    const keys = row.parts.map(part => {
      const key = `${row.workspaceId}/uploads/${row.id}/parts/${part.partNumber}/${part.checksum}`;
      if (part.objectKey !== key || this.state.driveFileVersions.some(version => version.objectKey === key))
        throw new AppError('FILE_OBJECT_CLEANUP_UNSAFE', 'Temporary content cannot be safely removed.', 409);
      return key;
    });
    return { id, workspaceId: row.workspaceId, token, attempt: row.cleanupAttempts, keys };
  }
  async deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome> {
    try {
      const objects = this.objects();
      if (!objects.purgeMultipart) throw new AppError('FILE_OBJECT_CLEANUP_UNAVAILABLE', 'Object cleanup is unavailable.', 503);
      if (signal?.aborted) throw new AppError('FILE_OBJECT_CLEANUP_CANCELLED', 'Cleanup was interrupted.', 503);
      await objects.purgeMultipart(ticket.workspaceId, ticket.id);
      return { kind: 'SENT', reference: null };
    } catch (error) {
      return { kind: 'FAILED', code: isAppError(error) ? error.code : 'FILE_OBJECT_CLEANUP_FAILED' };
    }
  }
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date) {
    const row = this.live(ticket.id, ticket.token, now);
    if (!row || row.workspaceId !== ticket.workspaceId || row.cleanupAttempts !== ticket.attempt) return false;
    row.cleanupClaimId = null; row.cleanupLeaseExpiresAt = null;
    if (outcome.kind === 'SENT') {
      row.cleanedAt ??= now; row.cleanupErrorCode = null;
      // A stale, pre-abort writer can finish after a sweep. Recheck the closed namespace daily.
      row.cleanupNextAttemptAt = new Date(now.getTime() + 86400_000);
    }
    else {
      row.cleanupErrorCode = outcome.kind === 'FAILED' ? outcome.code : 'FILE_OBJECT_CLEANUP_FAILED';
      row.cleanupNextAttemptAt = new Date(now.getTime() + Math.min(3600_000, 1000 * 2 ** Math.min(row.cleanupAttempts, 12)));
    }
    this.support.touch(row); this.publish(row, outcome.kind === 'SENT' ? 'OBJECTS_CLEANED' : 'CLEANUP_RETRY'); return true;
  }
}
