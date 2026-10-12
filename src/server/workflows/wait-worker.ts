import type { PrismaClient, WorkflowExecution } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { evidence, lock, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { parse } from '../process-platform/dto';
import { graph } from './dto';
import { compileExpression,evaluateExpression } from './expression';
import { typedValue } from './typed-values';
import { WorkflowRuntime } from './runtime';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export class WorkflowWaitWorker {
  constructor(private readonly db: PrismaClient, readonly runtime = new WorkflowRuntime(db)) {}
  private historicalActor(execution: WorkflowExecution): Principal {
    return { workspaceId: execution.workspaceId,userId: execution.startedByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() };
  }
  private async failure(workspaceId: string, executionId: string, nodeRunId: string, error: unknown) {
    const code = isAppError(error) ? error.code : 'WORKFLOW_NODE_FAILED';
    await this.db.$transaction(tx => this.runtime.failWait(tx,workspaceId,executionId,nodeRunId,code));
  }
  async timers(limit = 20) {
    const due = await this.db.workflowTimer.findMany({ where: { status: 'PENDING',scheduledFor: { lte: new Date() } },orderBy: [{ scheduledFor: 'asc' },{ id: 'asc' }],take: limit });
    let fired = 0,failed = 0;
    for (const candidate of due) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.executionId);
        const timer = await tx.workflowTimer.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: 'PENDING',scheduledFor: { lte: new Date() } } });
        if (!timer) return false;
        if (!await this.runtime.resumeWait(tx,timer.workspaceId,timer.executionId,timer.nodeRunId,{ timerId: timer.id,scheduledFor: timer.scheduledFor.toISOString() })) return false;
        await tx.workflowTimer.update({ where: { id: timer.id },data: { status: 'FIRED' } });
        const execution = await tx.workflowExecution.findUniqueOrThrow({ where: { id: timer.executionId } });
        await evidence(tx,this.historicalActor(execution),'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_TIMER_FIRED',{ timerId: timer.id,nodeRunId: timer.nodeRunId }); return true;
      },{ timeout: 60000 });
      if (done) fired++;
    } catch (error) { await this.failure(candidate.workspaceId,candidate.executionId,candidate.nodeRunId,error); failed++; }
    return { candidates: due.length,fired,failed };
  }
  async eventTimeouts(limit = 20) {
    const due = await this.db.workflowEventSubscription.findMany({ where: { status: 'PENDING',expiresAt: { lte: new Date() } },orderBy: { expiresAt: 'asc' },take: limit });
    let expired = 0;
    for (const candidate of due) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.executionId);
        const wait = await tx.workflowEventSubscription.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: 'PENDING',expiresAt: { lte: new Date() } } });
        if (!wait || !await this.runtime.resumeWait(tx,wait.workspaceId,wait.executionId,wait.nodeRunId,{ timeout: true },'TIMEOUT')) return false;
        await tx.workflowEventSubscription.update({ where: { id: wait.id },data: { status: 'CANCELLED' } }); return true;
      },{ timeout: 60000 });
      if (done) expired++;
    } catch (error) { await this.failure(candidate.workspaceId,candidate.executionId,candidate.nodeRunId,error); }
    return { candidates: due.length,expired };
  }
  async children(limit = 20) {
    const waiting = await this.db.$queryRaw<Array<{ id: string; workspace_id: string; parent_execution_id: string; parent_node_run_id: string }>>`
      SELECT c.id,c.workspace_id,c.parent_execution_id,c.parent_node_run_id FROM workflow_child_executions c
      JOIN workflow_executions e ON e.workspace_id=c.workspace_id AND e.id=c.child_execution_id
      WHERE c.wait_for_completion AND c.resumed_at IS NULL AND e.status IN ('COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT')
      ORDER BY e.completed_at LIMIT ${limit}`;
    let resumed = 0;
    for (const candidate of waiting) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspace_id,'workflow:execution:' + candidate.parent_execution_id);
        const binding = await tx.workflowChildExecution.findFirst({ where: { workspaceId: candidate.workspace_id,id: candidate.id,resumedAt: null } });
        if (!binding) return false;
        const parent = await tx.workflowExecution.findFirst({ where: { workspaceId: binding.workspaceId,id: binding.parentExecutionId,status: { in: ['RUNNING','WAITING'] } } });
        if (!parent) return false;
        const child = await tx.workflowExecution.findFirstOrThrow({ where: { workspaceId: binding.workspaceId,id: binding.childExecutionId } });
        const actor = await resolvePrincipal(tx,parent.workspaceId,parent.executionUserId);
        await this.runtime.executions.entities.execution(tx,actor,parent); await this.runtime.executions.entities.execution(tx,actor,child);
        const snapshot = parse(graph,parent.snapshot), variables = { ...(parent.variables as Record<string,unknown>) };
        const mapping = parse(z.record(z.string(),z.string()),binding.resultMapping);
        const context = { parameters: parent.parameters,variables,entity: await this.runtime.executions.entities.execution(tx,actor,parent),
          outputs: { CHILD: { status: child.status,result: child.result } },constants: {},actor: { id: actor.userId },now: new Date().toISOString(),iteration: {} };
        if (child.status==='COMPLETED') for (const [code,expression] of Object.entries(mapping)) {
          const definition = snapshot.variables.find(v => v.code===code);
          if (!definition) throw new AppError('WORKFLOW_CHILD_INVALID','Child output variable is not declared.',422);
          variables[code] = typedValue(definition,evaluateExpression(compileExpression(expression),context));
        }
        await this.runtime.executions.entities.validateReferences(tx,actor,variables);
        await tx.workflowExecution.update({ where: { id: parent.id },data: { variables: json(variables) } });
        if (!await this.runtime.resumeWait(tx,parent.workspaceId,parent.id,binding.parentNodeRunId,{ childExecutionId: child.id,status: child.status },child.status==='COMPLETED' ? 'NEXT' : 'ERROR')) return false;
        await tx.workflowChildExecution.update({ where: { id: binding.id },data: { resumedAt: new Date() } }); return true;
      },{ timeout: 60000 });
      if (done) resumed++;
    } catch (error) { await this.failure(candidate.workspace_id,candidate.parent_execution_id,candidate.parent_node_run_id,error); }
    return { candidates: waiting.length,resumed };
  }
  async assignments(limit = 20) {
    const due = await this.db.workflowHumanAssignment.findMany({ where: { status: 'PENDING',dueAt: { lte: new Date() } },orderBy: [{ dueAt: 'asc' },{ id: 'asc' }],take: limit });
    let resolved = 0;
    for (const candidate of due) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.executionId);
        await lock(tx,candidate.workspaceId,'workflow:assignment:' + candidate.id);
        const assignment = await tx.workflowHumanAssignment.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: 'PENDING',dueAt: { lte: new Date() } } });
        const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.executionId,status: { in: ['RUNNING','WAITING'] } } });
        if (!assignment || !execution) return false;
        const actor = await resolvePrincipal(tx,execution.workspaceId,execution.executionUserId);
        await this.runtime.executions.entities.execution(tx,actor,execution);
        const policy = assignment.timeoutPolicy as Record<string,unknown>;
        let outcome: string | null = null;
        if (policy.type==='REMIND' && Number(policy.reminderCount ?? 0) < Number(policy.maxReminders)) {
          await tx.workflowHumanAssignment.update({ where: { id: assignment.id },data: { dueAt: new Date(Date.now()+Number(policy.intervalSeconds)*1000),
            timeoutPolicy: json({ ...policy,reminderCount: Number(policy.reminderCount ?? 0)+1 }),version: { increment: 1 } } });
        } else if (['ESCALATE','DELEGATE'].includes(String(policy.type))) {
          const target = await resolvePrincipal(tx,actor.workspaceId,String(policy.toUserId));
          if (!target.grants.has('WORKFLOW.ASSIGNMENT_DECIDE')) throw new AppError('WORKFLOW_DELEGATE_INVALID','Escalation target cannot decide.',403);
          await this.runtime.executions.entities.execution(tx,target,execution);
          const participants = await tx.workflowAssignmentParticipant.findMany({ where: { workspaceId: actor.workspaceId,assignmentId: assignment.id,isActive: true } });
          const votes = await tx.workflowApprovalVote.findMany({ where: { workspaceId: actor.workspaceId,assignmentId: assignment.id } });
          const pending = participants.find(p => !votes.some(v => v.participantId===p.id));
          if (!pending || participants.some(p => p.effectiveUserId===target.userId) || votes.some(v => v.assigneeUserId===target.userId)) throw new AppError('WORKFLOW_DELEGATE_INVALID','Escalation would duplicate a participant.',409);
          await tx.workflowAssignmentParticipant.update({ where: { id: pending.id },data: { effectiveUserId: target.userId } });
          await tx.workflowHumanAssignment.update({ where: { id: assignment.id },data: { dueAt: null,version: { increment: 1 } } });
        } else {
          outcome = policy.type==='AUTO_APPROVE' ? assignment.assignmentType==='REQUEST_INFO' ? 'NEXT' : 'APPROVE' : policy.type==='AUTO_REJECT' ? 'REJECT' : 'TIMEOUT';
          if (policy.type==='AUTO_APPROVE' && assignment.assignmentType==='REQUEST_INFO') throw new AppError('WORKFLOW_APPROVAL_POLICY_INVALID','Information requests cannot invent required input on timeout.',422);
          if (!await this.runtime.resumeWait(tx,actor.workspaceId,execution.id,assignment.nodeRunId,{ decision: outcome,timeout: true },outcome)) return false;
          await tx.workflowHumanAssignment.update({ where: { id: assignment.id },data: { status: outcome==='TIMEOUT' ? 'EXPIRED' : 'COMPLETED',result: { decision: outcome,timeout: true },version: { increment: 1 } } });
        }
        await tx.workflowAssignmentHistory.create({ data: { workspaceId: actor.workspaceId,assignmentId: assignment.id,actorUserId: actor.userId,action: 'TIMEOUT_POLICY',metadata: { policy: String(policy.type),outcome } } });
        await evidence(tx,actor,'WORKFLOW_ASSIGNMENT',assignment.id,'WORKFLOW_ASSIGNMENT_ESCALATED',{ policy: String(policy.type),outcome }); return true;
      },{ timeout: 60000 });
      if (done) resolved++;
    } catch (error) { await this.failure(candidate.workspaceId,candidate.executionId,candidate.nodeRunId,error); }
    return { candidates: due.length,resolved };
  }
  async lifetime(limit = 20) {
    const due = await this.db.workflowExecution.findMany({ where: { status: { in: ['QUEUED','RUNNING','WAITING','SUSPENDED'] },expiresAt: { lte: new Date() } },orderBy: { expiresAt: 'asc' },take: limit });
    let timedOut = 0;
    for (const candidate of due) {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.id);
        const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: { in: ['QUEUED','RUNNING','WAITING','SUSPENDED'] },expiresAt: { lte: new Date() } } });
        if (!execution) return false;
        await tx.workflowExecution.update({ where: { id: execution.id },data: { status: 'TIMED_OUT',resultCode: 'WORKFLOW_RUNTIME_LIMIT_EXCEEDED',completedAt: new Date(),version: { increment: 1 } } });
        await tx.workflowExecutionToken.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: { in: ['READY','RUNNING','WAITING'] } },data: { status: 'CANCELLED',version: { increment: 1 } } });
        await tx.workflowNodeExecution.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: { in: ['QUEUED','RUNNING','WAITING'] } },data: { status: 'CANCELLED',leaseOwner: null,leaseUntil: null,completedAt: new Date() } });
        await tx.workflowTimer.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: { in: ['PENDING','PAUSED'] } },data: { status: 'CANCELLED' } });
        await tx.workflowEventSubscription.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: 'PENDING' },data: { status: 'CANCELLED' } });
        await tx.workflowHumanAssignment.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: 'PENDING' },data: { status: 'EXPIRED',version: { increment: 1 } } });
        await tx.workflowEntityLock.deleteMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id } });
        await evidence(tx,this.historicalActor(execution),'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_EXECUTION_TIMED_OUT',{}); return true;
      });
      if (done) timedOut++;
    }
    return { candidates: due.length,timedOut };
  }
  async tick(limit = 20) {
    return { timers: await this.timers(limit),events: await this.eventTimeouts(limit),assignments: await this.assignments(limit),children: await this.children(limit),lifetime: await this.lifetime(limit) };
  }
}
