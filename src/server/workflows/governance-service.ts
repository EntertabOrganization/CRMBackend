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
