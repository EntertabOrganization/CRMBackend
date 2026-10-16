import type { PrismaClient } from '@prisma/client';
import { lock } from '../process-platform/context';
import { systemEvent } from '../suite/kernel';

const ANOMALY_HOURS = 16;

/** HR background jobs: scheduled workspace-access revocation and missing clock-out detection. */
export class HrJobsService {
  constructor(private readonly db: PrismaClient) {}

  /** Revokes ONLY this workspace's membership (never the global User or other memberships). Failure keeps the case retryable. */
  async tickAccessTransitions(limit = 20) {
    const due = await this.db.hrAccessTransition.findMany({ where: { status: { in: ['PENDING', 'RETRY'] }, effectiveAt: { lte: new Date() }, nextAttemptAt: { lte: new Date() } }, orderBy: { effectiveAt: 'asc' }, take: limit });
    let done = 0;
    for (const row of due) {
      try {
        await this.db.$transaction(async tx => {
          await lock(tx, row.workspaceId, 'hr:access-transition:' + row.id);
          const current = await tx.hrAccessTransition.findUniqueOrThrow({ where: { id: row.id } });
          if (!['PENDING', 'RETRY'].includes(current.status)) return;
          if (current.userId) {
            const membership = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: row.workspaceId, userId: current.userId } } });
            if (membership && membership.status !== 'SUSPENDED') await tx.workspaceMembership.update({ where: { id: membership.id }, data: { status: 'SUSPENDED' } });
          }
          await tx.hrAccessTransition.update({ where: { id: row.id }, data: { status: 'COMPLETED', completedAt: new Date(), attempts: { increment: 1 } } });
          const lifecycle = await tx.hrLifecycleCase.findUnique({ where: { id: row.caseId } });
          if (lifecycle) await tx.hrLifecycleCase.update({ where: { id: lifecycle.id }, data: { status: 'ACCESS_REVOKED', checklist: (lifecycle.checklist as { item: string; done?: boolean }[]).map(c => c.item === 'REVOKE_WORKSPACE_ACCESS' ? { ...c, done: true } : c), version: { increment: 1 } } });
          await systemEvent(tx, row.workspaceId, 'HR_EMPLOYEE', row.employeeId, 'EMPLOYEE_ACCESS_REVOKED', { caseId: row.caseId });
        });
        done++;
      } catch {
        const attempts = row.attempts + 1;
        await this.db.hrAccessTransition.update({ where: { id: row.id }, data: { status: attempts >= 10 ? 'FAILED' : 'RETRY', attempts, errorCode: 'MEMBERSHIP_REVOCATION_FAILED', nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** attempts)) } });
        if (attempts >= 10) await this.db.$transaction(tx => systemEvent(tx, row.workspaceId, 'HR_EMPLOYEE', row.employeeId, 'EMPLOYEE_ACCESS_REVOCATION_FAILED', { caseId: row.caseId }));
      }
    }
    return { processed: done };
  }
  /** Open sessions beyond the anomaly window become INCOMPLETE (never fabricated hours); correction is required. */
  async tickAnomalies(limit = 100) {
    const stale = await this.db.hrWorkSession.findMany({ where: { status: 'OPEN', startedAt: { lt: new Date(Date.now() - ANOMALY_HOURS * 3600000) } }, take: limit });
    for (const s of stale) await this.db.$transaction(async tx => {
      const updated = await tx.hrWorkSession.updateMany({ where: { id: s.id, status: 'OPEN' }, data: { status: 'INCOMPLETE', version: { increment: 1 } } });
      if (updated.count) await systemEvent(tx, s.workspaceId, 'HR_WORK_SESSION', s.id, 'ATTENDANCE_ANOMALY_DETECTED', { employeeId: s.employeeId, kind: 'MISSING_CLOCK_OUT' });
    });
    return { flagged: stale.length };
  }
}
