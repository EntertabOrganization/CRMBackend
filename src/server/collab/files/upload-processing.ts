import { createHash } from 'node:crypto';
import { AppError, isAppError } from '../../errors';
import type { DeliveryOutcome, LeaseJobHandler } from '../../jobs/lease-runner';
import type { CollabSupport } from '../support';
import { assertProcessingResult } from './object-storage';
import type { UploadService } from './upload-service';

type Ticket = { id: string; workspaceId: string; token: string; attempt: number; versionId: string; objectKey: string; checksum: string; size: number; mimeType: string };
export class UploadProcessing implements LeaseJobHandler<Ticket> {
  constructor(private readonly support: CollabSupport, private readonly uploads: UploadService) {}
  private get state() { return this.support.state; }
  claimDue(limit: number, token: string, now: Date) {
    const due = this.state.uploadSessions.filter(row => !row.purgedAt && row.status === 'PROCESSING' && row.resultVersionId &&
      (!row.processingLeaseExpiresAt || row.processingLeaseExpiresAt <= now) && (!row.processingNextAttemptAt || row.processingNextAttemptAt <= now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of due) {
      row.processingClaimId = token; row.processingLeaseExpiresAt = new Date(now.getTime() + 300_000);
      row.processingAttempts = Math.min(row.processingAttempts + 1, 2147483647); this.support.touch(row);
    }
    return due.map(row => row.id);
  }
  private live(id: string, token: string, now: Date) {
    return this.state.uploadSessions.find(row => !row.purgedAt && row.id === id && row.status === 'PROCESSING' && row.processingClaimId === token && row.processingLeaseExpiresAt && row.processingLeaseExpiresAt > now);
  }
  prepare(id: string, token: string, now: Date): Ticket | null {
    const row = this.live(id, token, now); if (!row) return null;
    const version = this.state.driveFileVersions.find(version => version.id === row.resultVersionId && version.workspaceId === row.workspaceId);
    if (!version) return null;
    return { id, workspaceId: row.workspaceId, token, attempt: row.processingAttempts, versionId: version.id, objectKey: version.objectKey,
      checksum: version.checksum, size: version.sizeBytes, mimeType: version.mimeType };
  }
  async deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome> {
    try {
      const bytes = await this.uploads.objectStorage().read(ticket.objectKey);
      if (bytes.length !== ticket.size || createHash('sha256').update(bytes).digest('hex') !== ticket.checksum)
        throw new AppError('UPLOAD_CHECKSUM_MISMATCH', 'Accepted content no longer matches its immutable identity.', 409);
      if (signal?.aborted) throw new AppError('FILE_PROCESSOR_UNAVAILABLE', 'Processing was interrupted.', 503);
      const outcome = await this.uploads.contentProcessor().process(bytes, ticket.mimeType, signal); assertProcessingResult(outcome);
      return { kind: 'SENT', reference: JSON.stringify(outcome) };
    } catch (error) { return { kind: 'FAILED', code: isAppError(error) ? error.code : 'FILE_PROCESSOR_UNAVAILABLE' }; }
  }
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date) {
    const row = this.live(ticket.id, ticket.token, now);
    if (!row || row.workspaceId !== ticket.workspaceId || row.processingAttempts !== ticket.attempt || row.resultVersionId !== ticket.versionId) return false;
    if (outcome.kind === 'SENT') {
      const verdict: unknown = JSON.parse(outcome.reference ?? 'null'); assertProcessingResult(verdict);
      this.uploads.applyProcessing(row, verdict, now);
    } else {
      row.processingClaimId = null; row.processingLeaseExpiresAt = null;
      row.processingErrorCode = outcome.kind === 'FAILED' ? outcome.code : 'FILE_PROCESSOR_UNAVAILABLE';
      row.processingNextAttemptAt = new Date(now.getTime() + Math.min(3600_000, 1000 * 2 ** Math.min(row.processingAttempts, 12)));
      this.support.touch(row);
      const changes = { versionId: row.resultVersionId, attempts: row.processingAttempts, errorCode: row.processingErrorCode };
      this.support.audit(null, row.workspaceId, 'UPLOAD.PROCESSING_RETRY', 'UPLOAD_SESSION', row.id, null, changes);
      this.support.event({ workspaceId: row.workspaceId, type: 'FILE_PROCESSING_RETRY', entityType: 'FILE', entityId: row.resultFileId!, actorUserId: null, changes });
    }
    return true;
  }
}
