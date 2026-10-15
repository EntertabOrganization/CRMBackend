import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { isAppError } from '../errors';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { WorkflowExecutionService,activeExecutionStatuses,terminalExecutionStatuses } from './execution-service';

const statuses = ['QUEUED','RUNNING','WAITING','SUSPENDED','COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT'] as const;
export class WorkflowGovernanceService {
  constructor(private readonly db: PrismaClient,readonly executions = new WorkflowExecutionService(db)) {}
  private async visibleIds(tx: Tx,actor: Principal,filter: { status?: string;id?: { in: string[] } } = {}) {
    const rows = await tx.workflowExecution.findMany({ where: { workspaceId: actor.workspaceId,...filter },select: { id: true },orderBy: { id: 'asc' } });
    const result: string[] = [];
    for (const row of rows) try { await this.executions.load(tx,actor,row.id,'WORKFLOW.EXECUTION_ADMIN'); result.push(row.id); }
    catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
    return result;
  }
  async health(actor: Principal,raw: unknown) {
    requirePermission(actor,'WORKFLOW.EXECUTION_ADMIN'); const query = parse(z.strictObject({ status: z.enum(statuses).optional() }),raw);
    return this.db.$transaction(async tx => {
      const ids = await this.visibleIds(tx,actor,query),where = { workspaceId: actor.workspaceId,executionId: { in: ids } },now = new Date();
      const [counts,expiredLeases,overdueTimers,overdueAssignments,failedNodes,failedCompensations,oldestReady,uncertainActions] = await Promise.all([
        tx.workflowExecution.groupBy({ by: ['status'],where: { workspaceId: actor.workspaceId,id: { in: ids } },_count: { _all: true } }),
        tx.workflowNodeExecution.count({ where: { ...where,status: 'RUNNING',leaseUntil: { lte: now } } }),
        tx.workflowTimer.count({ where: { ...where,status: 'PENDING',scheduledFor: { lte: now } } }),
        tx.workflowHumanAssignment.count({ where: { ...where,status: 'PENDING',dueAt: { lte: now } } }),
        tx.workflowNodeExecution.count({ where: { ...where,status: 'FAILED' } }),
        tx.workflowCompensationAction.count({ where: { ...where,status: 'FAILED' } }),
        tx.workflowExecutionToken.findFirst({ where: { ...where,status: 'READY',availableAt: { lte: now } },orderBy: { availableAt: 'asc' },select: { availableAt: true } }),
        tx.workflowActionInvocation.count({ where: { ...where,status: 'RUNNING' } })]);
      return { executions: Object.fromEntries(counts.map(c => [c.status,c._count._all])),expiredLeases,overdueTimers,overdueAssignments,
        failedNodes,failedCompensations,uncertainActions,queueLagSeconds: oldestReady ? Math.max(0,Math.floor((now.getTime()-oldestReady.availableAt.getTime())/1000)) : 0 };
    });
  }
  async reconcile(actor: Principal,raw: unknown,key: string | null) {
    requirePermission(actor,'WORKFLOW.EXECUTION_ADMIN'); const input = parse(z.strictObject({ executionIds: z.array(uuid).min(1).max(100).refine(ids => new Set(ids).size===ids.length).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:reconciliation'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.EXECUTION_ADMIN');
      if (input.executionIds) for (const id of [...input.executionIds].sort()) await this.executions.load(tx,actor,id,'WORKFLOW.EXECUTION_ADMIN');
      return command(tx,actor,'WORKFLOW.RECONCILE',key,input,async () => {
        const ids = input.executionIds ?? await this.visibleIds(tx,actor);
        const job = await tx.workflowReconciliationJob.create({ data: { workspaceId: actor.workspaceId,requestedByUserId: actor.userId,executionIds: ids } });
        await evidence(tx,actor,'WORKFLOW_RECONCILIATION_JOB',job.id,'WORKFLOW_RECONCILIATION_REQUESTED',{ executionCount: ids.length,correlationId: job.correlationId });
        return { jobId: job.id,status: job.status,correlationId: job.correlationId };
      });
    },{ timeout: 60000 });
  }
  /** Debug detail retention: purges logs and node payloads of terminal executions past the Workspace policy.
   * Legal hold, execution outcome, history rows and global Audit are never removed here. */
  async purgeRetention(limit = 50,now = new Date()) {
    const candidates = await this.db.$queryRaw<Array<{ id: string; workspace_id: string }>>`
      SELECT e.id,e.workspace_id FROM workflow_executions e
      LEFT JOIN workflow_runtime_policies p ON p.workspace_id=e.workspace_id
      WHERE e.status IN ('COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT') AND NOT e.legal_hold AND e.completed_at IS NOT NULL
        AND e.completed_at < ${now}::timestamptz - make_interval(days => COALESCE(p.retention_days,365))
        AND (EXISTS (SELECT 1 FROM workflow_execution_logs l WHERE l.workspace_id=e.workspace_id AND l.execution_id=e.id)
          OR EXISTS (SELECT 1 FROM workflow_node_executions n WHERE n.workspace_id=e.workspace_id AND n.execution_id=e.id AND (n.input_json<>'{}'::jsonb OR n.output_json IS NOT NULL)))
      ORDER BY e.completed_at,e.id LIMIT ${limit}`;
    let purged = 0,deletedLogs = 0;
    for (const candidate of candidates) {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspace_id,'workflow:execution:' + candidate.id);
        const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: candidate.workspace_id,id: candidate.id,status: { in: terminalExecutionStatuses },legalHold: false } });
        if (!execution?.completedAt) return 0;
        const policy = await tx.workflowRuntimePolicy.findUnique({ where: { workspaceId: execution.workspaceId } });
        if (execution.completedAt.getTime() >= now.getTime() - (policy?.retentionDays ?? 365)*86400000) return 0;
        const where = { workspaceId: execution.workspaceId,executionId: execution.id };
        const logs = await tx.workflowExecutionLog.deleteMany({ where });
        await tx.workflowNodeExecution.updateMany({ where,data: { input: {},output: Prisma.DbNull } });
        const actor: Principal = { workspaceId: execution.workspaceId,userId: execution.startedByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() };
        await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_LOGS_PURGED',{ deletedLogs: logs.count,retentionDays: policy?.retentionDays ?? 365 },false);
        return logs.count+1;
      },{ timeout: 60000 });
      if (done) { purged++; deletedLogs += done-1; }
    }
    return { candidates: candidates.length,purged,deletedLogs };
  }
  /** Recovery checks and checkpoints commit with the job. No owning adapter/provider is invoked here. */
  async tick(limit = 10) {
    const jobs = await this.db.workflowReconciliationJob.findMany({ where: { status: 'QUEUED' },orderBy: { createdAt: 'asc' },take: limit });
    let completed = 0,failed = 0;
    for (const job of jobs) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,job.workspaceId,'workflow:reconciliation');
        const current = await tx.workflowReconciliationJob.findFirst({ where: { workspaceId: job.workspaceId,id: job.id,status: 'QUEUED' } });
        if (!current) return false;
        const actor = await resolvePrincipal(tx,current.workspaceId,current.requestedByUserId); requirePermission(actor,'WORKFLOW.EXECUTION_ADMIN');
        const ids = parse(z.array(uuid),current.executionIds).sort();
        let recovered = 0,uncertain = 0,closedWaits = 0;
        for (const id of ids) {
          await lock(tx,actor.workspaceId,'workflow:execution:' + id);
          const execution = await this.executions.load(tx,actor,id,'WORKFLOW.EXECUTION_ADMIN');
          const where = { workspaceId: actor.workspaceId,executionId: id };
          if (activeExecutionStatuses.includes(execution.status) && execution.status!=='SUSPENDED') {
            const runs = await tx.workflowNodeExecution.findMany({ where: { ...where,status: 'RUNNING',leaseUntil: { lte: new Date() } } });
            for (const run of runs) {
              if (await tx.workflowActionInvocation.count({ where: { ...where,nodeRunId: run.id,status: 'RUNNING' } })) { uncertain++; continue; }
              const token = await tx.workflowExecutionToken.findFirst({ where: { ...where,id: run.tokenId,status: 'RUNNING' } });
              if (!token) continue;
              await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'QUEUED',leaseOwner: null,leaseUntil: null } });
              await tx.workflowExecutionToken.update({ where: { id: token.id },data: { status: 'READY',availableAt: new Date(),version: { increment: 1 } } }); recovered++;
            }
          } else if (terminalExecutionStatuses.includes(execution.status)) {
            // Terminal executions retain historical outcomes; close only still-live wait artifacts.
            const timers = await tx.workflowTimer.updateMany({ where: { ...where,status: { in: ['PENDING','PAUSED'] } },data: { status: 'CANCELLED' } });
            const events = await tx.workflowEventSubscription.updateMany({ where: { ...where,status: 'PENDING' },data: { status: 'CANCELLED' } });
            const assignments = await tx.workflowHumanAssignment.updateMany({ where: { ...where,status: 'PENDING' },data: { status: 'CANCELLED',version: { increment: 1 } } });
            await tx.workflowEntityLock.deleteMany({ where }); closedWaits += timers.count+events.count+assignments.count;
          }
        }
        const result = { checked: ids.length,recovered,uncertain,closedWaits };
        await tx.workflowReconciliationJob.update({ where: { id: current.id },data: { status: 'SUCCEEDED',result: result as Prisma.InputJsonValue } });
        await evidence(tx,actor,'WORKFLOW_RECONCILIATION_JOB',current.id,'WORKFLOW_RECONCILIATION_COMPLETED',{ ...result,correlationId: current.correlationId }); return true;
      },{ timeout: 60000 });
      if (done) completed++;
    } catch (error) {
      await this.db.workflowReconciliationJob.updateMany({ where: { workspaceId: job.workspaceId,id: job.id,status: 'QUEUED' },data: {
        status: 'FAILED',errorCode: isAppError(error) ? error.code : 'WORKFLOW_RECONCILE_NOT_ALLOWED' } }); failed++;
    }
    return { candidates: jobs.length,completed,failed };
  }
}
