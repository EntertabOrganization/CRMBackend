import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import { lock } from '../process-platform/context';
import { parse, uuid } from '../process-platform/dto';

const input = z.strictObject({ workspaceId: uuid, limit: z.number().int().min(1).max(5000).default(500) });
const policy = z.number().int().min(1).max(3650);

/** Prune verbose logs only. Checkpoints, dedupe, results, revisions and Audit retain their own lifecycle. */
export class AutomationDiagnosticRetention {
  constructor(private readonly db: PrismaClient) {}
  async run(raw: unknown, now = new Date()) {
    const { workspaceId, limit } = parse(input, raw);
    if (!Number.isFinite(now.getTime())) throw new AppError('INVALID_ARGUMENT', 'A valid retention time is required.', 400);
    return this.db.$transaction(async tx => {
      await lock(tx, workspaceId, 'automation:diagnostic-retention');
      if (!await tx.workspace.findFirst({ where: { id: workspaceId, isDeleted: false }, select: { id: true } }))
        throw new AppError('RESOURCE_NOT_FOUND', 'Workspace was not found.', 404);
      // Follow the shared persistence lock order: revision fence before source rows.
      await tx.$queryRaw`SELECT calendar_booking_lock_workspace(${workspaceId}::uuid)`;
      const rows = await tx.$queryRaw<Array<{ settings: Prisma.JsonValue }>>`
        SELECT settings FROM workspaces WHERE id = ${workspaceId}::uuid AND NOT is_deleted FOR UPDATE`;
      if (!rows.length) throw new AppError('RESOURCE_NOT_FOUND', 'Workspace was not found.', 404);
      const settings = rows[0].settings as Record<string, unknown>;
      const configured = settings?.automationDiagnosticRetentionDays;
      const checked = policy.safeParse(configured === undefined ? 90 : configured);
      if (!checked.success) throw new AppError('AUTOMATION_RETENTION_POLICY_INVALID', 'Diagnostic retention must be 1 to 3650 whole days.', 409);
      const retentionDays = checked.data, cutoff = new Date(now.getTime() - retentionDays * 86400000);
      // Shared retention-record writes take this same Workspace revision lock.
      // A hold committed before our selection is visible; later hold changes wait for this commit.
      const eligible = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT l.id FROM automation_logs l
        LEFT JOIN automation_executions e ON e.workspace_id = l.workspace_id AND e.id = l.execution_id
        LEFT JOIN automation_jobs j ON j.workspace_id = l.workspace_id AND j.id = l.job_id
        WHERE l.workspace_id = ${workspaceId}::uuid AND l.created_at < ${cutoff}
          AND (l.execution_id IS NULL OR e.status IN ('SUCCEEDED','SUCCEEDED_WITH_ERRORS','FAILED_FINAL','CANCELLED','SKIPPED_CONDITION','SKIPPED_STALE'))
          AND (l.job_id IS NULL OR j.status IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED'))
          AND NOT EXISTS (SELECT 1 FROM automation_jobs recovery
            WHERE recovery.workspace_id = l.workspace_id AND recovery.status IN ('PENDING','RUNNING')
              AND (recovery.id = l.job_id OR recovery.execution_id = l.execution_id))
          AND NOT EXISTS (
            SELECT 1 FROM commercial_pack_records r
            WHERE r.workspace_id = l.workspace_id AND r.collection = 'retentionRecords'
              AND r.data->>'purgedAt' IS NULL
              AND (r.data->>'legalHold' = 'true' OR (r.data->>'expiresAt')::timestamptz > ${now})
              AND r.data->>'resourceId' = ANY(ARRAY[l.workspace_id::text,l.id::text,l.rule_id::text,
                l.execution_id::text,l.job_id::text,e.rule_revision_id::text,e.target_id::text,e.source_event_id])
          )
        ORDER BY l.created_at, l.id LIMIT ${limit + 1} FOR UPDATE OF l SKIP LOCKED`;
      const ids = eligible.slice(0, limit).map(row => row.id);
      const deletedLogs = ids.length ? (await tx.automationLog.deleteMany({ where: { workspaceId, id: { in: ids } } })).count : 0;
      if (deletedLogs) {
        const payload = { deletedLogs, retentionDays, cutoff: cutoff.toISOString() };
        const eventId = randomUUID();
        await tx.auditLog.create({ data: { workspaceId, entityType: 'WORKSPACE', entityId: workspaceId,
          action: 'AUTOMATION.DIAGNOSTICS_PRUNED', afterData: payload } });
        await tx.outboxEvent.create({ data: { id: eventId, correlationId: eventId, workspaceId, entityType: 'WORKSPACE', entityId: workspaceId,
          eventType: 'AUTOMATION_DIAGNOSTICS_PRUNED', payload } });
      }
      return { workspaceId, retentionDays, cutoff, deletedLogs, hasMore: eligible.length > limit };
    }, { maxWait: 10000, timeout: 30000 });
  }
}
