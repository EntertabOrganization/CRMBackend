import { Prisma, type PrismaClient, type WorkflowExecution, type WorkflowExecutionToken, type WorkflowNodeExecution } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { canonical, parse } from '../process-platform/dto';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { graph, configs, actionConfig, httpConfig, type Graph, type Node } from './dto';
import { compileExpression, evaluateExpression } from './expression';
import { typedValue, typedRecord, persistable } from './typed-values';
import { WorkflowExecutionService, activeExecutionStatuses } from './execution-service';
import { workflowBusinessTime } from './business-time';
import { WorkflowCallbackService } from './callback-service';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Claimed = { workspaceId: string; executionId: string; tokenId: string; nodeRunId: string; leaseOwner: string };
type ProviderWork = { claim: Claimed; config: z.infer<typeof httpConfig>; input: unknown; effectKey: string;
  prepared: Awaited<ReturnType<import('../integration-connections').IntegrationConnectionService['prepare']>> };
type JoinStack = Array<{ id: string; branchKey: string }>;
type LoopState = { counts?: Record<string,number>; collections?: Record<string,unknown[]>; joinStack?: JoinStack; item?: unknown; index?: number };

/** Durable interpreter: one claimed activation, owning effects and checkpoint per transaction. */
export class WorkflowRuntime {
  readonly executions: WorkflowExecutionService;
  readonly callbacks: WorkflowCallbackService;
  constructor(private readonly db: PrismaClient, executions?: WorkflowExecutionService) {
    this.executions = executions ?? new WorkflowExecutionService(db); this.callbacks = new WorkflowCallbackService(db,this);
  }
  private async claim(limit: number): Promise<Claimed[]> {
    const candidates = await this.db.$queryRaw<Array<{ id: string; workspace_id: string; execution_id: string }>>`
      SELECT t.id,t.workspace_id,t.execution_id FROM workflow_execution_tokens t
      JOIN workflow_executions e ON e.workspace_id=t.workspace_id AND e.id=t.execution_id
      LEFT JOIN workflow_node_executions n ON n.workspace_id=t.workspace_id AND n.token_id=t.id
      WHERE e.status IN ('QUEUED','RUNNING','WAITING') AND t.available_at<=now()
        AND (t.status='READY' OR (t.status='RUNNING' AND (n.id IS NULL OR n.lease_until<now())))
      ORDER BY t.available_at,t.id LIMIT ${limit}`;
    const result: Claimed[] = [];
    for (const candidate of candidates) {
      const claimed = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspace_id,'workflow:execution:' + candidate.execution_id);
        const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: candidate.workspace_id,id: candidate.execution_id,status: { in: ['QUEUED','RUNNING','WAITING'] } } });
        const token = await tx.workflowExecutionToken.findFirst({ where: { workspaceId: candidate.workspace_id,id: candidate.id,status: { in: ['READY','RUNNING'] },availableAt: { lte: new Date() } } });
        if (!execution || !token) return null;
        const snapshot = parse(graph,execution.snapshot), node = snapshot.nodes.find(n => n.nodeKey === token.nodeKey);
        if (!node) throw new AppError('WORKFLOW_NODE_INVALID','Persisted activation references an unavailable node.',409);
        const prior = await tx.workflowNodeExecution.findUnique({ where: { workspaceId_executionId_nodeId_iterationNumber_activationKey: {
          workspaceId: execution.workspaceId,executionId: execution.id,nodeId: node.id,iterationNumber: token.iterationNumber,activationKey: token.activationKey } } });
        if (prior?.status === 'RUNNING' && prior.leaseUntil && prior.leaseUntil > new Date() || prior && !['QUEUED','RUNNING'].includes(prior.status)) return null;
        const count = await tx.workflowNodeExecution.count({ where: { workspaceId: execution.workspaceId,executionId: execution.id } });
        const policy = await tx.workflowRuntimePolicy.findUnique({ where: { workspaceId: execution.workspaceId } });
        if (!prior && count >= (policy?.maxNodeRuns ?? 10000)) {
          const actor = await resolvePrincipal(tx,execution.workspaceId,execution.executionUserId);
          await this.failExecution(tx,actor,execution,'WORKFLOW_RUNTIME_LIMIT_EXCEEDED'); return null;
        }
        const leaseOwner = randomUUID(), leaseUntil = new Date(Date.now()+120000);
        const run = await tx.workflowNodeExecution.upsert({ where: { workspaceId_executionId_nodeId_iterationNumber_activationKey: {
          workspaceId: execution.workspaceId,executionId: execution.id,nodeId: node.id,iterationNumber: token.iterationNumber,activationKey: token.activationKey } },
          create: { workspaceId: execution.workspaceId,executionId: execution.id,tokenId: token.id,nodeId: node.id,
            iterationNumber: token.iterationNumber,activationKey: token.activationKey,status: 'RUNNING',attemptCount: 1,leaseOwner,leaseUntil,
            input: json({ variables: execution.variables,loopState: token.loopState }) },
          update: { status: 'RUNNING',attemptCount: { increment: 1 },leaseOwner,leaseUntil } });
        await tx.workflowExecutionToken.update({ where: { id: token.id },data: { status: 'RUNNING',version: { increment: 1 } } });
        await tx.workflowExecution.update({ where: { id: execution.id },data: { status: 'RUNNING',version: { increment: 1 } } });
        return { workspaceId: execution.workspaceId,executionId: execution.id,tokenId: token.id,nodeRunId: run.id,leaseOwner };
      });
      if (claimed) result.push(claimed);
    }
    return result;
  }
  private async checkpoint(tx: Tx, claim: Claimed) {
    await lock(tx,claim.workspaceId,'workflow:execution:' + claim.executionId);
    const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: claim.workspaceId,id: claim.executionId,status: { in: ['QUEUED','RUNNING','WAITING'] } } });
    const run = await tx.workflowNodeExecution.findFirst({ where: { workspaceId: claim.workspaceId,id: claim.nodeRunId,executionId: claim.executionId,
      status: 'RUNNING',leaseOwner: claim.leaseOwner,leaseUntil: { gt: new Date() } } });
    if (!execution || !run) return null;
    const token = await tx.workflowExecutionToken.findFirst({ where: { workspaceId: claim.workspaceId,id: claim.tokenId,executionId: claim.executionId,status: 'RUNNING' } });
    if (!token) return null;
    const actor = await resolvePrincipal(tx,execution.workspaceId,execution.executionUserId); requirePermission(actor,'WORKFLOW.START');
    const entity = await this.executions.entities.execution(tx,actor,execution);
    const snapshot = parse(graph,execution.snapshot), node = snapshot.nodes.find(n => n.id === run.nodeId);
    if (!node) throw new AppError('WORKFLOW_NODE_INVALID','Checkpoint node is unavailable.',409);
    const outputs: Record<string,unknown> = {};
    const completed = await tx.workflowNodeExecution.findMany({ where: { workspaceId: claim.workspaceId,executionId: claim.executionId,status: 'SUCCEEDED' },orderBy: [{ createdAt: 'asc' },{ id: 'asc' }] });
    for (const result of completed) {
      const key = snapshot.nodes.find(n => n.id === result.nodeId)?.nodeKey;
      if (key) outputs[key] = result.output;
    }
    const state = token.loopState as LoopState;
    const context: Record<string,unknown> = { parameters: execution.parameters,variables: execution.variables,constants: typedRecord(snapshot.constants,{}),entity,outputs,
      actor: { id: actor.userId },now: new Date().toISOString(),iteration: { item: state.item ?? null,index: state.index ?? null } };
    return { execution,run,token,actor,snapshot,node,context,state };
  }
  private expression(source: unknown, context: Record<string,unknown>) {
    if (typeof source !== 'string') throw new AppError('WORKFLOW_UNSAFE_EXPRESSION','Expression is missing.',422);
    return evaluateExpression(compileExpression(source),context);
  }
  private async enqueue(tx: Tx, execution: WorkflowExecution, token: WorkflowExecutionToken, target: Node, edgeId: string, state?: LoopState,
    branchKey = token.branchKey, joinGroupId = token.joinGroupId) {
    const nextState = state ?? token.loopState as LoopState;
    const iteration = ['WHILE','FOR_EACH'].includes(target.nodeType) ? nextState.counts?.[target.nodeKey] ?? 0 : token.iterationNumber;
    const activationKey = hash(token.activationKey + ':' + edgeId + ':' + iteration);
    await tx.workflowExecutionToken.upsert({ where: { workspaceId_executionId_activationKey: { workspaceId: execution.workspaceId,executionId: execution.id,activationKey } },
      create: { workspaceId: execution.workspaceId,executionId: execution.id,nodeKey: target.nodeKey,activationKey,branchKey,joinGroupId,
        iterationNumber: iteration,loopState: json(nextState) },update: {} });
  }
  async complete(tx: Tx, actor: Principal, execution: WorkflowExecution, run: WorkflowNodeExecution, token: WorkflowExecutionToken,
    snapshot: Graph, node: Node, context: Record<string,unknown>, output: unknown, edgeType = 'NEXT', state?: LoopState) {
    const edges = snapshot.edges.filter(e => e.fromNodeId === node.id && e.edgeType === edgeType).sort((a,b) => a.sortOrder-b.sortOrder);
    if (!edges.length && !['END','TERMINATE'].includes(node.nodeType)) throw new AppError('WORKFLOW_EDGE_INVALID','Selected outcome has no declared edge.',422);
    for (const edge of edges) {
      if (edge.condition && this.expression(edge.condition,context) !== true) continue;
      const target = snapshot.nodes.find(n => n.id === edge.toNodeId);
      if (!target) throw new AppError('WORKFLOW_EDGE_INVALID','Successor is unavailable.',409);
      await this.enqueue(tx,execution,token,target,edge.id,state);
    }
    await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'SUCCEEDED',output: json(output ?? null),completedAt: new Date(),leaseOwner: null,leaseUntil: null,errorCode: null } });
    await tx.workflowExecutionToken.update({ where: { id: token.id },data: { status: 'COMPLETED',version: { increment: 1 } } });
    await tx.workflowExecutionLog.create({ data: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,
      level: 'INFO',code: 'WORKFLOW_NODE_COMPLETED',metadata: { nodeKey: node.nodeKey,iteration: run.iterationNumber,attempt: run.attemptCount } } });
    await this.refresh(tx,actor,execution);
  }
  private async refresh(tx: Tx, actor: Principal, execution: WorkflowExecution) {
    const counts = await tx.workflowExecutionToken.groupBy({ by: ['status'],where: { workspaceId: execution.workspaceId,executionId: execution.id },_count: { _all: true } });
    const active = counts.filter(c => ['READY','RUNNING','WAITING'].includes(c.status));
    const failed = counts.some(c => c.status === 'FAILED');
    const status = failed ? 'FAILED' : !active.length ? 'COMPLETED' : active.some(c => c.status !== 'WAITING') ? 'RUNNING' : 'WAITING';
    const current = await tx.workflowExecution.findUniqueOrThrow({ where: { id: execution.id } });
    if (current.status === 'SUSPENDED' || !activeExecutionStatuses.includes(current.status)) return;
    await tx.workflowExecution.update({ where: { id: execution.id },data: { status,version: { increment: 1 },completedAt: ['FAILED','COMPLETED'].includes(status) ? new Date() : null } });
    if (['FAILED','COMPLETED'].includes(status)) await tx.workflowEntityLock.deleteMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id } });
    if (status !== current.status && ['WAITING','FAILED','COMPLETED'].includes(status)) await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_' + status,{});
  }
  private async waiting(tx: Tx, execution: WorkflowExecution, run: WorkflowNodeExecution, token: WorkflowExecutionToken) {
    await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'WAITING',leaseOwner: null,leaseUntil: null } });
    await tx.workflowExecutionToken.update({ where: { id: token.id },data: { status: 'WAITING',version: { increment: 1 } } });
  }
  private async failExecution(tx: Tx, actor: Principal, execution: WorkflowExecution, code: string) {
    await tx.workflowExecution.update({ where: { id: execution.id },data: { status: 'FAILED',resultCode: code,completedAt: new Date(),version: { increment: 1 } } });
    await tx.workflowEntityLock.deleteMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id } });
    await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_FAILED',{ errorCode: code });
  }
  async failWait(tx: Tx, workspaceId: string, executionId: string, nodeRunId: string, code: string) {
    await lock(tx,workspaceId,'workflow:execution:' + executionId);
    const execution = await tx.workflowExecution.findFirst({ where: { workspaceId,id: executionId,status: { in: ['RUNNING','WAITING'] } } });
    const run = await tx.workflowNodeExecution.findFirst({ where: { workspaceId,executionId,id: nodeRunId,status: 'WAITING' } });
    if (!execution || !run) return false;
    await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'FAILED',errorCode: code } });
    await tx.workflowExecutionToken.update({ where: { id: run.tokenId },data: { status: 'FAILED',version: { increment: 1 } } });
    const actor: Principal = { workspaceId,userId: execution.startedByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() };
    await this.failExecution(tx,actor,execution,code); return true;
  }
  private async dispatch(claim: Claimed): Promise<ProviderWork | null> {
    return this.db.$transaction(async tx => {
      const checkpoint = await this.checkpoint(tx,claim); if (!checkpoint) return null;
      const { execution,run,token,actor,snapshot,node,context,state } = checkpoint;
      if (execution.expiresAt <= new Date()) {
        await this.failExecution(tx,actor,execution,'WORKFLOW_RUNTIME_LIMIT_EXCEEDED'); return null;
      }
      const config = parse(configs[node.nodeType],node.config) as Record<string,unknown>;
      let output: unknown = {}, edgeType = 'NEXT';
      if (node.nodeType === 'START') { /* The published START dispatches its single declared successor. */ }
      else if (node.nodeType === 'END') {
        output = config.result ? this.expression(config.result,context) : {};
        await tx.workflowExecution.update({ where: { id: execution.id },data: { result: json(output) } });
      } else if (node.nodeType === 'CONDITION') {
        output = this.expression(config.expression,context);
        if (typeof output !== 'boolean') throw new AppError('WORKFLOW_UNSAFE_EXPRESSION','Condition must produce a Boolean.',422);
        edgeType = output ? 'TRUE' : 'FALSE';
      } else if (node.nodeType === 'SWITCH') {
        output = this.expression(config.expression,context);
        const match = (config.cases as Array<{ value: unknown; edgeType: string }>).find(c => canonical(c.value) === canonical(output));
        edgeType = match?.edgeType ?? 'DEFAULT';
      } else if (node.nodeType === 'SET_VARIABLE') {
        const definition = snapshot.variables.find(v => v.code === config.variable);
        if (!definition) throw new AppError('WORKFLOW_NODE_INVALID','Variable is not declared.',422);
        output = typedValue(definition,this.expression(config.expression,context));
        await this.executions.entities.validateReferences(tx,actor,{ [definition.code]: output });
        output = persistable(snapshot.variables,{ [definition.code]: output })[definition.code];
        const variables = { ...(execution.variables as Record<string,unknown>),[definition.code]: output };
        if (definition.datatype === 'USER' && output) await resolvePrincipal(tx,actor.workspaceId,String(output));
        await tx.workflowExecution.update({ where: { id: execution.id },data: { variables: json(variables) } });
        context.variables = variables;
      } else if (['WHILE','FOR_EACH'].includes(node.nodeType)) {
        const iterations = state.counts ?? {}, index = iterations[node.nodeKey] ?? 0;
        const limit = Number(config.maxIterations);
        const policy = await tx.workflowRuntimePolicy.findUnique({ where: { workspaceId: execution.workspaceId } });
        if (limit > (policy?.maxLoopIterations ?? 1000)) throw new AppError('WORKFLOW_LOOP_LIMIT_EXCEEDED','Loop exceeds current runtime policy.',422);
        let keepGoing: boolean;
        if (node.nodeType === 'FOR_EACH') {
          const collections = state.collections ?? {}, collection = collections[node.nodeKey] ?? this.expression(config.collection,context);
          if (!Array.isArray(collection) || collection.length > limit) throw new AppError('WORKFLOW_LOOP_LIMIT_EXCEEDED','Collection exceeds its bounded loop.',422);
          state.collections = { ...collections,[node.nodeKey]: collection }; keepGoing = index < collection.length;
          if (keepGoing) {
            state.item = collection[index]; state.index = index;
            const variable = snapshot.variables.find(v => v.code === config.itemVariable);
            if (!variable) throw new AppError('WORKFLOW_NODE_INVALID','Loop item variable is not declared.',422);
            const variables = { ...(execution.variables as Record<string,unknown>),...persistable(snapshot.variables,{ [variable.code]: typedValue(variable,collection[index]) }) };
            await tx.workflowExecution.update({ where: { id: execution.id },data: { variables: json(variables) } }); context.variables = variables;
          }
        } else {
          const condition = this.expression(config.expression,context);
          if (typeof condition !== 'boolean') throw new AppError('WORKFLOW_UNSAFE_EXPRESSION','Loop condition must produce a Boolean.',422);
          keepGoing = condition;
        }
        if (keepGoing && index >= limit) throw new AppError('WORKFLOW_LOOP_LIMIT_EXCEEDED','Loop iteration limit exhausted.',422);
        state.counts = { ...iterations,[node.nodeKey]: keepGoing ? index+1 : 0 };
        const targetKey = String(keepGoing ? config.bodyNodeKey : config.exitNodeKey), target = snapshot.nodes.find(n => n.nodeKey === targetKey);
        const selected = snapshot.edges.find(e => e.fromNodeId === node.id && e.toNodeId === target?.id);
        if (!target || !selected) throw new AppError('WORKFLOW_EDGE_INVALID','Loop successor must have a declared edge.',422);
        edgeType = selected.edgeType; output = { iteration: index,continuing: keepGoing };
      } else if (node.nodeType === 'TIMER') {
        const now = new Date();
        const scheduledFor = config.type === 'ABSOLUTE' ? new Date(String(config.scheduledFor)) : config.type === 'WORKDAY_AWARE'
          ? (await workflowBusinessTime(tx,actor)).due(now,Number(config.seconds),execution.expiresAt) : new Date(now.getTime()+Number(config.seconds)*1000);
        if (scheduledFor > execution.expiresAt) throw new AppError('WORKFLOW_RUNTIME_LIMIT_EXCEEDED','Timer exceeds the execution lifetime.',422);
        await tx.workflowTimer.upsert({ where: { workspaceId_resumeKey: { workspaceId: execution.workspaceId,resumeKey: 'timer:' + run.id } },
          create: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,type: String(config.type),scheduledFor,resumeKey: 'timer:' + run.id },update: {} });
        await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); return null;
      } else if (node.nodeType === 'WAIT_EVENT') {
        const correlationKey = this.expression(config.correlationKey,context);
        if (typeof correlationKey !== 'string' || !correlationKey || correlationKey.length > 200) throw new AppError('WORKFLOW_EVENT_CORRELATION_MISMATCH','Event correlation key must be bounded text.',422);
        await tx.workflowEventSubscription.upsert({ where: { workspaceId_executionId_nodeRunId_eventType_correlationKey: {
          workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,eventType: String(config.eventType),correlationKey } },
          create: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,eventType: String(config.eventType),correlationKey,
            expiresAt: config.timeoutSeconds ? new Date(Date.now()+Number(config.timeoutSeconds)*1000) : undefined },update: {} });
        await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); return null;
      } else if (['APPROVAL','REQUEST_INFO'].includes(node.nodeType)) {
        const ids = config.assigneeUserIds as string[];
        for (const id of ids) { const participant = await resolvePrincipal(tx,actor.workspaceId,id); await this.executions.entities.execution(tx,participant,execution); }
        const assignment = await tx.workflowHumanAssignment.upsert({ where: { workspaceId_nodeRunId: { workspaceId: execution.workspaceId,nodeRunId: run.id } },create: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,
          assignmentType: node.nodeType === 'APPROVAL' ? 'APPROVAL' : 'REQUEST_INFO',policy: String(config.policy),quorumCount: config.quorumCount as number | undefined,
          rejectPolicy: String(config.rejectPolicy),informationSchema: json(config.informationSchema),timeoutPolicy: json(config.timeoutPolicy),
          dueAt: config.dueSeconds ? new Date(Date.now()+Number(config.dueSeconds)*1000) : undefined },update: {} });
        await tx.workflowAssignmentParticipant.createMany({ data: ids.map(id => ({ workspaceId: actor.workspaceId,assignmentId: assignment.id,originalUserId: id,effectiveUserId: id })),skipDuplicates: true });
        await tx.workflowAssignmentHistory.create({ data: { workspaceId: actor.workspaceId,assignmentId: assignment.id,actorUserId: actor.userId,action: 'CREATED',metadata: { participantCount: ids.length } } });
        await evidence(tx,actor,'WORKFLOW_ASSIGNMENT',assignment.id,'WORKFLOW_ASSIGNMENT_CREATED',{ executionId: execution.id,nodeRunId: run.id,assigneeUserIds: ids });
        await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); return null;
      } else if (node.nodeType === 'SUB_WORKFLOW') {
        const parameters = Object.fromEntries(Object.entries(config.inputMapping as Record<string,string>).map(([code,source]) => [code,this.expression(source,context)]));
        const child = await this.executions.startInTransaction(tx,actor,String(config.workflowId),{ entityType: execution.entityType,entityId: execution.entityId,parameters },
          'workflow.child:' + run.id,{ executionId: execution.id,depth: execution.depth,ancestry: execution.ancestry as string[],versionId: config.versionId as string | undefined });
        await tx.workflowChildExecution.create({ data: { workspaceId: actor.workspaceId,parentExecutionId: execution.id,childExecutionId: child.executionId,
          parentNodeRunId: run.id,waitForCompletion: Boolean(config.waitForCompletion),resultMapping: json(config.outputMapping) } });
        await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_CHILD_STARTED',{ childExecutionId: child.executionId,nodeRunId: run.id });
        if (config.waitForCompletion) { await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); return null; }
        output = { childExecutionId: child.executionId };
      } else if (['HTTP_REQUEST','OUTBOUND_WEBHOOK'].includes(node.nodeType)) {
        const http = parse(httpConfig,node.config), effectKey = 'workflow.http:' + run.id;
        const prior = await tx.workflowActionInvocation.findUnique({ where: { workspaceId_nodeRunId_actionCode_idempotencyKey: {
          workspaceId: execution.workspaceId,nodeRunId: run.id,actionCode: node.nodeType,idempotencyKey: effectKey } } });
        if (prior?.status === 'SUCCEEDED') {
          if (http.waitForCallback) { await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); return null; }
          output = prior.resultReference;
        }
        else {
          const prepared = await this.executions.definitions.connections.prepare(tx,actor,http.connectionId,http.path);
          if (http.method !== 'GET' && !prepared.supportsIdempotency) throw new AppError('WORKFLOW_RETRY_UNSAFE','Provider must explicitly support durable idempotency for a side effect.',422);
          const callback = http.waitForCallback ? await this.callbacks.issue(tx,actor,execution.id,run.id) : null;
          const input = callback ? { ...http.body,callback } : http.body;
          await tx.workflowActionInvocation.upsert({ where: { workspaceId_nodeRunId_actionCode_idempotencyKey: {
            workspaceId: execution.workspaceId,nodeRunId: run.id,actionCode: node.nodeType,idempotencyKey: effectKey } },
            create: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,actionCode: node.nodeType,
              idempotencyKey: effectKey,requestHash: hash(canonical(http.body)),status: 'RUNNING' },update: { status: 'RUNNING' } });
          return { claim,config: http,input,effectKey,prepared };
        }
      } else if ('actionCode' in config) {
        const action = parse(actionConfig,node.config), adapter = this.executions.definitions.actions.get(action.actionCode);
        if (adapter.sideEffectClass !== 'TRANSACTIONAL') throw new AppError('WORKFLOW_ACTION_NOT_ALLOWED','Provider action requires its durable dispatcher.',422);
        const input = { ...action.input,...Object.fromEntries(Object.entries(action.inputExpressions).map(([key,source]) => [key,this.expression(source,context)])) };
        const effectKey = 'workflow.action:' + run.id;
        const invocation = await tx.workflowActionInvocation.upsert({ where: { workspaceId_nodeRunId_actionCode_idempotencyKey: {
          workspaceId: execution.workspaceId,nodeRunId: run.id,actionCode: action.actionCode,idempotencyKey: effectKey } },
          create: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,actionCode: action.actionCode,
            idempotencyKey: effectKey,requestHash: hash(canonical(input)),status: 'RUNNING' },update: {} });
        if (invocation.requestHash !== hash(canonical(input))) throw new AppError('WORKFLOW_RETRY_UNSAFE','Action input changed after its checkpoint.',409);
        await tx.$queryRaw`SELECT set_config('truecrm.workflow_execution_id',${execution.id},true),set_config('truecrm.workflow_depth',${String(execution.depth+1)},true)`;
        output = invocation.status === 'SUCCEEDED' ? invocation.resultReference : await this.executions.definitions.actions.execute(tx,actor,action.actionCode,input,effectKey);
        await tx.workflowActionInvocation.update({ where: { id: invocation.id },data: { status: 'SUCCEEDED',resultReference: json(output) } });
        if (action.compensation) {
          const compensation = action.compensation;
          if (adapter.inverse !== compensation.actionCode) throw new AppError('WORKFLOW_COMPENSATION_UNDEFINED','Compensation is not a declared inverse.',422);
          context.outputs = { ...(context.outputs as Record<string,unknown>),[node.nodeKey]: output };
          const input = { ...compensation.input,...Object.fromEntries(Object.entries(compensation.inputExpressions).map(([key,source]) => [key,this.expression(source,context)])) };
          await tx.workflowCompensationAction.create({ data: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,
            actionType: compensation.actionCode,configuration: json(input),sequence: await tx.workflowCompensationAction.count({ where: { workspaceId: execution.workspaceId,executionId: execution.id } }),
            idempotencyKey: 'workflow.compensate:' + run.id } });
        }
        await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_ACTION_COMPLETED',{ nodeRunId: run.id,actionCode: action.actionCode });
      } else if (['PARALLEL_SPLIT','EVENT_RACE','PARALLEL_JOIN','TERMINATE'].includes(node.nodeType)) {
        await this.parallelOrTerminate(tx,checkpoint,config); return null;
      } else throw new AppError('WORKFLOW_NODE_INVALID','Node dispatcher is unavailable.',422);
      await this.complete(tx,actor,execution,run,token,snapshot,node,context,output,edgeType,state); return null;
    },{ timeout: 60000 });
  }
  private async parallelOrTerminate(tx: Tx, checkpoint: NonNullable<Awaited<ReturnType<WorkflowRuntime['checkpoint']>>>, config: Record<string,unknown>) {
    const { execution,run,token,actor,snapshot,node,context,state } = checkpoint;
    if (node.nodeType === 'TERMINATE') {
      await tx.workflowExecutionToken.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: { in: ['READY','RUNNING','WAITING'] } },data: { status: 'CANCELLED',version: { increment: 1 } } });
      await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'SUCCEEDED',output: {},completedAt: new Date(),leaseOwner: null,leaseUntil: null } });
      await tx.workflowTimer.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: { in: ['PENDING','PAUSED'] } },data: { status: 'CANCELLED' } });
      await tx.workflowEventSubscription.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: 'PENDING' },data: { status: 'CANCELLED' } });
      await tx.workflowHumanAssignment.updateMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: 'PENDING' },data: { status: 'CANCELLED' } });
      await tx.workflowExecution.update({ where: { id: execution.id },data: { status: 'TERMINATED',resultCode: String(config.resultCode),completedAt: new Date(),version: { increment: 1 } } });
      await tx.workflowEntityLock.deleteMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id } });
      await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_TERMINATED',{ nodeRunId: run.id }); return;
    }
    if (node.nodeType !== 'PARALLEL_JOIN') {
      const edges = snapshot.edges.filter(e => e.fromNodeId === node.id), joinNode = snapshot.nodes.find(n => n.nodeKey === config.joinNodeKey)!;
      const joinConfig = parse(configs.PARALLEL_JOIN,joinNode.config) as { mode: string; requiredCount?: number };
      const join = await tx.workflowParallelJoin.create({ data: { workspaceId: execution.workspaceId,executionId: execution.id,
        splitActivationKey: token.activationKey,joinNodeKey: joinNode.nodeKey,joinMode: node.nodeType === 'EVENT_RACE' ? 'ANY' : joinConfig.mode,
        requiredCount: node.nodeType === 'EVENT_RACE' || joinConfig.mode === 'ANY' ? 1 : joinConfig.mode === 'QUORUM' ? joinConfig.requiredCount! : edges.length,
        branches: edges.map(e => e.id) } });
      for (const edge of edges) {
        const target = snapshot.nodes.find(n => n.id === edge.toNodeId)!;
        await this.enqueue(tx,execution,token,target,edge.id,{ ...state,joinStack: [...(state.joinStack ?? []),...(token.joinGroupId ? [{ id: token.joinGroupId,branchKey: token.branchKey }] : [])] },edge.id,join.id);
      }
      await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'SUCCEEDED',output: { joinGroupId: join.id },completedAt: new Date(),leaseOwner: null,leaseUntil: null } });
      await tx.workflowExecutionToken.update({ where: { id: token.id },data: { status: 'COMPLETED' } });
      await this.refresh(tx,actor,execution); return;
    }
    const join = token.joinGroupId ? await tx.workflowParallelJoin.findFirst({ where: { workspaceId: execution.workspaceId,executionId: execution.id,id: token.joinGroupId,joinNodeKey: node.nodeKey } }) : null;
    if (!join) throw new AppError('WORKFLOW_JOIN_INVALID','Join activation has no matching branch group.',422);
    if (join.status !== 'PENDING') {
      await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'CANCELLED',leaseOwner: null,leaseUntil: null,completedAt: new Date() } });
      await tx.workflowExecutionToken.update({ where: { id: token.id },data: { status: 'CANCELLED' } }); return;
    }
    const branches = join.branches as string[], complete = new Set(join.completedBranchTokens as string[]);
    if (!branches.includes(token.branchKey)) throw new AppError('WORKFLOW_JOIN_INVALID','Activation is outside the declared branches.',422);
    complete.add(token.branchKey);
    if (complete.size < join.requiredCount) {
      await tx.workflowParallelJoin.update({ where: { id: join.id },data: { completedBranchTokens: [...complete] } });
      await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); return;
    }
    await tx.workflowParallelJoin.update({ where: { id: join.id },data: { completedBranchTokens: [...complete],status: 'COMPLETED' } });
    const siblings = await tx.workflowExecutionToken.findMany({ where: { workspaceId: execution.workspaceId,executionId: execution.id,status: { in: ['READY','RUNNING','WAITING'] },id: { not: token.id } } });
    const losing = siblings.filter(t => t.joinGroupId === join.id || (t.loopState as LoopState).joinStack?.some(parent => parent.id === join.id));
    const runs = await tx.workflowNodeExecution.findMany({ where: { workspaceId: execution.workspaceId,tokenId: { in: losing.map(t => t.id) },status: { in: ['QUEUED','RUNNING','WAITING'] } } });
    for (const sibling of losing) {
      const winner = complete.has(sibling.branchKey) && sibling.joinGroupId === join.id;
      await tx.workflowExecutionToken.update({ where: { id: sibling.id },data: { status: winner ? 'COMPLETED' : 'CANCELLED',version: { increment: 1 } } });
      await tx.workflowNodeExecution.updateMany({ where: { workspaceId: execution.workspaceId,tokenId: sibling.id,status: { in: ['QUEUED','RUNNING','WAITING'] } },data: {
        status: winner ? 'SUCCEEDED' : 'CANCELLED',completedAt: new Date(),leaseOwner: null,leaseUntil: null } });
    }
    const runIds = runs.map(r => r.id);
    await tx.workflowTimer.updateMany({ where: { workspaceId: execution.workspaceId,nodeRunId: { in: runIds },status: { in: ['PENDING','PAUSED'] } },data: { status: 'CANCELLED' } });
    await tx.workflowEventSubscription.updateMany({ where: { workspaceId: execution.workspaceId,nodeRunId: { in: runIds },status: 'PENDING' },data: { status: 'CANCELLED' } });
    await tx.workflowHumanAssignment.updateMany({ where: { workspaceId: execution.workspaceId,nodeRunId: { in: runIds },status: 'PENDING' },data: { status: 'CANCELLED' } });
    const stack = [...(state.joinStack ?? [])], parent = stack.pop();
    const restored = { ...token,joinGroupId: parent?.id ?? null,branchKey: parent?.branchKey ?? 'ROOT' };
    await this.complete(tx,actor,execution,run,restored,snapshot,node,context,{ completedBranches: complete.size },'NEXT',{ ...state,joinStack: stack });
  }
  /** Called by approval/timer/event owners while holding this execution's transaction lock. */
  async resumeWait(tx: Tx, workspaceId: string, executionId: string, nodeRunId: string, output: unknown, edgeType = 'NEXT') {
    await lock(tx,workspaceId,'workflow:execution:' + executionId);
    const execution = await tx.workflowExecution.findFirst({ where: { workspaceId,id: executionId,status: { in: ['RUNNING','WAITING'] } } });
    const run = await tx.workflowNodeExecution.findFirst({ where: { workspaceId,executionId,id: nodeRunId,status: 'WAITING' } });
    if (!execution || !run) return false;
    const token = await tx.workflowExecutionToken.findFirst({ where: { workspaceId,id: run.tokenId,status: 'WAITING' } }); if (!token) return false;
    const actor = await resolvePrincipal(tx,workspaceId,execution.executionUserId); requirePermission(actor,'WORKFLOW.START');
    const entity = await this.executions.entities.execution(tx,actor,execution), snapshot = parse(graph,execution.snapshot), node = snapshot.nodes.find(n => n.id === run.nodeId)!;
    const context = { entity,parameters: execution.parameters,variables: execution.variables,constants: typedRecord(snapshot.constants,{}),
      actor: { id: actor.userId },outputs: { [node.nodeKey]: output },now: new Date().toISOString(),iteration: {} };
    await this.complete(tx,actor,execution,run,token,snapshot,node,context,output,edgeType); return true;
  }
  private async provider(work: ProviderWork) {
    let output: Awaited<ReturnType<WorkflowRuntime['executions']['definitions']['connections']['sendPrepared']>>;
    try { output = await this.executions.definitions.connections.sendPrepared(work.prepared,work.config.method,work.input,work.config.timeoutMs,work.effectKey); }
    catch (error) {
      // A definitive rejection (4xx or blocked destination) is a certain outcome; timeouts/5xx stay uncertain until reconciled.
      if (isAppError(error) && error.status < 500) await this.db.workflowActionInvocation.updateMany({ where: { workspaceId: work.claim.workspaceId,
        nodeRunId: work.claim.nodeRunId,idempotencyKey: work.effectKey,status: 'RUNNING' },data: { status: 'FAILED',errorCode: error.code } });
      throw error;
    }
    return this.db.$transaction(async tx => {
      const checkpoint = await this.checkpoint(tx,work.claim);
      if (!checkpoint) {
        // The remote effect remains durable evidence if cancellation wins the lease race.
        await tx.workflowActionInvocation.updateMany({ where: { workspaceId: work.claim.workspaceId,nodeRunId: work.claim.nodeRunId,idempotencyKey: work.effectKey,status: 'RUNNING' },
          data: { status: 'SUCCEEDED',resultReference: output } }); return false;
      }
      const { execution,run,token,actor,snapshot,node,context } = checkpoint;
      await tx.workflowActionInvocation.updateMany({ where: { workspaceId: execution.workspaceId,nodeRunId: run.id,idempotencyKey: work.effectKey },data: { status: 'SUCCEEDED',resultReference: output } });
      await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_ACTION_COMPLETED',{ nodeRunId: run.id,actionCode: node.nodeType });
      if (work.config.waitForCallback) { await this.waiting(tx,execution,run,token); await this.refresh(tx,actor,execution); }
      else await this.complete(tx,actor,execution,run,token,snapshot,node,context,output);
      return true;
    },{ timeout: 60000 });
  }
  async tick(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid workflow dispatch limit');
    const claims = await this.claim(limit); let completed = 0,failed = 0;
    for (const claim of claims) try {
      const provider = await this.dispatch(claim); if (provider) await this.provider(provider); completed++;
    } catch (error) {
      await this.db.$transaction(async tx => {
        await lock(tx,claim.workspaceId,'workflow:execution:' + claim.executionId);
        const run = await tx.workflowNodeExecution.findFirst({ where: { workspaceId: claim.workspaceId,id: claim.nodeRunId,status: 'RUNNING',leaseOwner: claim.leaseOwner } });
        const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: claim.workspaceId,id: claim.executionId,status: { in: ['RUNNING','WAITING','QUEUED'] } } });
        if (!run || !execution) return;
        const snapshot = parse(graph,execution.snapshot), node = snapshot.nodes.find(n => n.id === run.nodeId);
        const automatic = (!isAppError(error) || error.status >= 500) && run.attemptCount < Number(node?.config.maxAttempts ?? 3)+run.retryBudget;
        const code = isAppError(error) ? error.code : 'WORKFLOW_NODE_FAILED';
        await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: automatic ? 'QUEUED' : 'FAILED',errorCode: code,leaseOwner: null,leaseUntil: null } });
        await tx.workflowExecutionToken.update({ where: { id: run.tokenId },data: { status: automatic ? 'READY' : 'FAILED',availableAt: new Date(Date.now()+Math.min(3600000,10000*2**run.attemptCount)),version: { increment: 1 } } });
        await tx.workflowExecutionLog.create({ data: { workspaceId: execution.workspaceId,executionId: execution.id,nodeRunId: run.id,level: 'ERROR',code,
          metadata: { automaticRetry: automatic,attempt: run.attemptCount } } });
        const actor = await resolvePrincipal(tx,execution.workspaceId,execution.startedByUserId).catch(() => ({ workspaceId: execution.workspaceId,
          userId: execution.startedByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map<string,string>() }));
        if (!automatic) await this.failExecution(tx,actor,execution,code);
      }); failed++;
    }
    return { claimed: claims.length,completed,failed };
  }
}
