import { AppError } from '../../errors';
import type { DeliveryOutcome, LeaseJobHandler } from '../../jobs/lease-runner';
import type { CollabSupport } from '../support';
import type { ObjectStorage } from './object-storage';
type Ticket = { id: string; workspaceId: string; token: string; attempt: number; objectKey: string };
export class ObjectGarbage implements LeaseJobHandler<Ticket> {
  constructor(private readonly support: CollabSupport, private readonly objects: () => ObjectStorage) {}
  private get state() { return this.support.state; }
  claimDue(limit: number, token: string, now: Date) {
    const due = this.state.fileObjectGarbage.filter(row => row.nextAttemptAt <= now && (!row.leaseExpiresAt || row.leaseExpiresAt <= now))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of due) { row.claimId = token; row.leaseExpiresAt = new Date(now.getTime() + 300_000); row.attempts = Math.min(2147483647, row.attempts + 1); row.updatedAt = now; }
    return due.map(row => row.id);
  }
  private live(id: string, token: string, now: Date) {
    return this.state.fileObjectGarbage.find(row => row.id === id && row.claimId === token && row.leaseExpiresAt && row.leaseExpiresAt > now);
  }
  prepare(id: string, token: string, now: Date): Ticket | null {
    const row = this.live(id, token, now); if (!row) return null;
    if (this.state.driveFileVersions.some(version => version.objectKey === row.objectKey)) throw new AppError('FILE_OBJECT_CLEANUP_UNSAFE', 'Content is still referenced.', 409);
    return { id, token, workspaceId: row.workspaceId, attempt: row.attempts, objectKey: row.objectKey };
  }
  async deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome> {
    try {
      const objects = this.objects();
      if (!objects.remove || signal?.aborted) throw new Error('Cleanup unavailable');
      await objects.remove(ticket.objectKey); return { kind: 'SENT', reference: null };
    } catch { return { kind: 'FAILED', code: 'FILE_OBJECT_CLEANUP_FAILED' }; }
  }
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date) {
    const row = this.live(ticket.id, ticket.token, now);
    if (!row || row.workspaceId !== ticket.workspaceId || row.attempts !== ticket.attempt || row.objectKey !== ticket.objectKey) return false;
    row.claimId = null; row.leaseExpiresAt = null; row.updatedAt = now;
    if (outcome.kind === 'SENT') { row.cleanedAt ??= now; row.errorCode = null; row.nextAttemptAt = new Date(now.getTime() + 86400_000); }
    else { row.errorCode = 'FILE_OBJECT_CLEANUP_FAILED'; row.nextAttemptAt = new Date(now.getTime() + Math.min(3600_000, 1000 * 2 ** Math.min(row.attempts, 12))); }
    const changes = { attempts: row.attempts, errorCode: row.errorCode };
    this.support.audit(null, row.workspaceId, 'FILE.OBJECT_CLEANUP', 'FILE_OBJECT_GARBAGE', row.id, null, changes);
    this.support.event({ workspaceId: row.workspaceId, type: outcome.kind === 'SENT' ? 'FILE_OBJECT_DELETED' : 'FILE_OBJECT_CLEANUP_RETRY',
      entityType: 'FILE_OBJECT_GARBAGE', entityId: row.id, actorUserId: null, changes });
    return true;
  }
}
