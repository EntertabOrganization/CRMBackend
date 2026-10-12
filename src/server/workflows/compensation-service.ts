import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { WorkflowExecutionService,terminalExecutionStatuses } from './execution-service';

export class WorkflowCompensationService {
  constructor(private readonly db: PrismaClient,readonly executions = new WorkflowExecutionService(db)) {}
  async children(actor: Principal,executionId: string) {
    return this.db.$transaction(async tx => {
      await this.executions.load(tx,actor,executionId);
      const bindings = await tx.workflowChildExecution.findMany({ where: { workspaceId: actor.workspaceId,parentExecutionId: executionId },orderBy: { id: 'asc' } });
      const visible = [];
      for (const binding of bindings) {
        try {
          const child = await this.executions.load(tx,actor,binding.childExecutionId);
          visible.push({ id: child.id,workflowId: child.definitionId,status: child.status,resultCode: child.resultCode,
            parentNodeRunId: binding.parentNodeRunId,waitForCompletion: binding.waitForCompletion,resumedAt: binding.resumedAt });
        } catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
      }
      return visible;
    });
  }
  async list(actor: Principal,executionId: string) {
    return this.db.$transaction(async tx => {
      await this.executions.load(tx,actor,executionId);
      const rows = await tx.workflowCompensationAction.findMany({ where: { workspaceId: actor.workspaceId,executionId },orderBy: [{ sequence: 'desc' },{ id: 'asc' }] });
      return rows.map(row => ({ id: row.id,nodeRunId: row.nodeRunId,actionType: row.actionType,status: row.status,requested: row.requested,
        sequence: row.sequence,attemptCount: row.attemptCount,errorCode: row.errorCode,executedAt: row.executedAt }));
    });
  }
  async request(actor: Principal,executionId: string,raw: unknown,key: string | null,actionId?: string) {
    requirePermission(actor,'WORKFLOW.EXECUTION_ADMIN');
    const input = actionId ? parse(z.strictObject({}),raw) : parse(z.strictObject({ reason: z.string().trim().min(1).max(2000) }),raw);
    if (actionId) parse(uuid,actionId);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:execution:' + executionId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const execution = await this.executions.load(tx,actor,executionId,'WORKFLOW.EXECUTION_ADMIN');
      return command(tx,actor,'WORKFLOW.COMPENSATE:' + executionId + ':' + (actionId ?? 'STACK'),key,input,async () => {
        if (!terminalExecutionStatuses.includes(execution.status)) throw new AppError('WORKFLOW_INVALID_STATE','Stop execution before compensation.',409);
        if (actionId) {
          const row = await tx.workflowCompensationAction.findFirst({ where: { workspaceId: actor.workspaceId,executionId,id: actionId,status: 'FAILED' } });
          if (!row) throw new AppError('WORKFLOW_COMPENSATION_UNDEFINED','Failed compensation was not found.',404);
          const adapter = this.executions.definitions.actions.get(row.actionType);
          requirePermission(await resolvePrincipal(tx,actor.workspaceId,execution.executionUserId),adapter.permission);
          if (adapter.sideEffectClass!=='TRANSACTIONAL') throw new AppError('WORKFLOW_RETRY_UNSAFE','Provider compensation requires its owning durable dispatcher.',409);
          await tx.workflowCompensationAction.update({ where: { id: row.id },data: { status: 'PENDING',requested: true,errorCode: null } });
        } else {
          if (!await tx.workflowCompensationAction.count({ where: { workspaceId: actor.workspaceId,executionId } }))
            throw new AppError('WORKFLOW_COMPENSATION_UNDEFINED','No inverse action is declared.',422);
          await tx.workflowCompensationAction.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING' },data: { requested: true } });
        }
        await evidence(tx,actor,'WORKFLOW_EXECUTION',executionId,'WORKFLOW_COMPENSATION_REQUESTED',{ actionId: actionId ?? null,...input });
        return { executionId,accepted: true };
      });
    });
  }
  /** Transactional owner adapters commit the inverse and its checkpoint together. A failed later inverse blocks earlier ones. */
  async tick(limit = 20) {
    const candidates = await this.db.workflowCompensationAction.findMany({ where: { requested: true,status: 'PENDING' },orderBy: [{ sequence: 'desc' },{ id: 'asc' }],take: limit });
    let completed = 0,failed = 0;
    for (const candidate of candidates) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.executionId);
        const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.executionId,status: { in: terminalExecutionStatuses } } });
        const current = await tx.workflowCompensationAction.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,requested: true,status: 'PENDING' } });
        if (!execution || !current) return false;
        const blocked = await tx.workflowCompensationAction.count({ where: { workspaceId: candidate.workspaceId,executionId: execution.id,
          requested: true,sequence: { gt: current.sequence },status: { not: 'SUCCEEDED' } } });
        if (blocked) return false;
        const actor = await resolvePrincipal(tx,execution.workspaceId,execution.executionUserId); requirePermission(actor,'WORKFLOW.START');
        await this.executions.entities.execution(tx,actor,execution);
        const adapter = this.executions.definitions.actions.get(current.actionType);
        if (adapter.sideEffectClass!=='TRANSACTIONAL') throw new AppError('WORKFLOW_RETRY_UNSAFE','Provider compensation requires its owning durable dispatcher.',409);
        await tx.workflowCompensationAction.update({ where: { id: current.id },data: { status: 'RUNNING',attemptCount: { increment: 1 } } });
        await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_COMPENSATION_STARTED',{ actionId: current.id,actionType: current.actionType });
        await tx.$queryRaw`SELECT set_config('truecrm.workflow_execution_id',${execution.id},true),set_config('truecrm.workflow_depth',${String(execution.depth+1)},true)`;
        await this.executions.definitions.actions.execute(tx,actor,current.actionType,current.configuration,current.idempotencyKey);
        await tx.workflowCompensationAction.update({ where: { id: current.id },data: { status: 'SUCCEEDED',executedAt: new Date(),errorCode: null,leaseOwner: null,leaseUntil: null } });
        await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_COMPENSATION_COMPLETED',{ actionId: current.id }); return true;
      },{ timeout: 60000 });
      if (done) completed++;
    } catch (error) {
      await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.executionId);
        const current = await tx.workflowCompensationAction.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: 'PENDING' } });
        if (!current) return;
        const code = isAppError(error) ? error.code : 'WORKFLOW_COMPENSATION_FAILED';
        await tx.workflowCompensationAction.update({ where: { id: current.id },data: { status: 'FAILED',attemptCount: { increment: 1 },errorCode: code,leaseOwner: null,leaseUntil: null } });
        const execution = await tx.workflowExecution.findFirstOrThrow({ where: { workspaceId: candidate.workspaceId,id: candidate.executionId } });
        const actor: Principal = { workspaceId: execution.workspaceId,userId: execution.executionUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() };
        await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_COMPENSATION_FAILED',{ actionId: current.id,errorCode: code });
      }); failed++;
    }
    return { candidates: candidates.length,completed,failed };
  }
}
