import type { DeliveryOutcome, LeaseJobHandler } from '../../jobs/lease-runner';
import type { CollabSupport } from '../support';
import type { DocumentEditingService } from './editing-service';
import type { EditorIdentity } from './editor-provider';
type Ticket = { id: string; token: string; attempt: number; identity: EditorIdentity };
export class EditingCleanup implements LeaseJobHandler<Ticket> {
  constructor(private readonly support: CollabSupport, private readonly editing: DocumentEditingService) {}
  private get state() { return this.support.state; }
  claimDue(limit: number, token: string, now: Date) {
    const expiring = new Set(this.state.documentEditSessions.filter(r => r.status === 'ACTIVE' && r.expiresAt <= now).map(r => r.id));
    this.editing.expireDue(limit);
    const rows = this.state.documentEditSessions.filter(r => !expiring.has(r.id) && r.status !== 'ACTIVE' && r.cleanupRequired && r.cleanupNextAttemptAt && r.cleanupNextAttemptAt <= now && (!r.cleanupLeaseExpiresAt || r.cleanupLeaseExpiresAt <= now))
      .sort((a, b) => a.cleanupNextAttemptAt!.getTime() - b.cleanupNextAttemptAt!.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of rows) { row.cleanupClaimId = token; row.cleanupLeaseExpiresAt = new Date(now.getTime() + 300000); row.cleanupAttempts = Math.min(2147483647, row.cleanupAttempts + 1); row.version++; }
    return rows.map(r => r.id);
  }
  private live(id: string, token: string, now: Date) { return this.state.documentEditSessions.find(r => r.id === id && r.status !== 'ACTIVE' && r.cleanupRequired && r.cleanupClaimId === token && r.cleanupLeaseExpiresAt && r.cleanupLeaseExpiresAt > now); }
  prepare(id: string, token: string, now: Date): Ticket | null {
    const row = this.live(id, token, now); return row ? { id, token, attempt: row.cleanupAttempts, identity: this.editing.identity(row) } : null;
  }
  async deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome> {
    try { await this.editing.editingProvider().close(ticket.identity, signal); return { kind: 'SENT', reference: null }; }
    catch { return { kind: 'FAILED', code: 'EDIT_PROVIDER_CLEANUP_FAILED' }; }
  }
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date) {
    const row = this.live(ticket.id, ticket.token, now);
    if (!row || row.cleanupAttempts !== ticket.attempt || row.workspaceId !== ticket.identity.workspaceId) return false;
    row.cleanupClaimId = null; row.cleanupLeaseExpiresAt = null; row.version++;
    row.cleanupRequired = outcome.kind !== 'SENT'; row.cleanupErrorCode = outcome.kind === 'SENT' ? null : 'EDIT_PROVIDER_CLEANUP_FAILED';
    row.cleanupNextAttemptAt = outcome.kind === 'SENT' ? null : new Date(now.getTime() + Math.min(3600000, 1000 * 2 ** Math.min(row.cleanupAttempts, 12)));
    this.support.audit(null, row.workspaceId, 'FILE.EDIT_PROVIDER_CLEANUP', 'DOCUMENT_EDIT_SESSION', row.id, null,
      { attempt: row.cleanupAttempts, errorCode: row.cleanupErrorCode });
    this.support.event({ workspaceId: row.workspaceId, type: outcome.kind === 'SENT' ? 'FILE_EDIT_PROVIDER_CLOSED' : 'FILE_EDIT_PROVIDER_CLEANUP_RETRY', entityType: 'DOCUMENT_EDIT_SESSION', entityId: row.id,
      actorUserId: null, changes: { attempt: row.cleanupAttempts, errorCode: row.cleanupErrorCode }, audienceUserIds: [row.userId] }); return true;
  }
}
