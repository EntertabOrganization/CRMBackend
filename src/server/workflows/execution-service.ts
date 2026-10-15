import { Prisma, type PrismaClient, type WorkflowExecution } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, command, evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { canonical, pageQuery, parse, uuid, version } from '../process-platform/dto';
import { entityType, graph, type Graph } from './dto';
import { typedRecord, persistable } from './typed-values';
import { WorkflowDefinitionService } from './definition-service';
import { WorkflowEntityAuthority } from './entity-authority';
import { workflowBusinessTime } from './business-time';

export const activeExecutionStatuses = ['QUEUED','RUNNING','WAITING','SUSPENDED'];
export const terminalExecutionStatuses = ['COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT'];
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const startInput = z.strictObject({ entityType,entityId: uuid,parameters: z.record(z.string(),z.json()) });
const administrative = z.strictObject({ expectedVersion: version,reason: z.string().trim().min(1).max(2000) });
export class WorkflowExecutionService {
  readonly definitions: WorkflowDefinitionService;
  readonly entities: WorkflowEntityAuthority;
  constructor(private readonly db: PrismaClient, definitions?: WorkflowDefinitionService, entities?: WorkflowEntityAuthority) {
    this.definitions = definitions ?? new WorkflowDefinitionService(db); this.entities = entities ?? new WorkflowEntityAuthority(db);
  }
  async load(tx: Tx, actor: Principal, executionId: string, permission = 'WORKFLOW.EXECUTION_VIEW') {
    parse(uuid,executionId); requirePermission(actor,permission);
    const row = await tx.workflowExecution.findFirst({ where: { workspaceId: actor.workspaceId,id: executionId } });
    if (!row || !await ownerVisible(tx,actor,row.startedByUserId,permission)) throw new AppError('WORKFLOW_EXECUTION_NOT_FOUND','Execution was not found.',404);
    await this.entities.execution(tx,actor,row); return row;
  }
  private async projection(tx: Tx, actor: Principal, row: WorkflowExecution) {
    const snapshot = parse(graph,row.snapshot);
    const redact = (definitions: Graph['parameters'], values: Prisma.JsonValue) => {
      const record = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string,unknown> : {};
      return Object.fromEntries(definitions.filter(d => d.classification === 'PUBLIC' ||
        d.classification === 'BUSINESS' && (row.startedByUserId === actor.userId || actor.grants.has('WORKFLOW.EXECUTION_ADMIN')) ||
        d.classification === 'SENSITIVE' && row.executionUserId === actor.userId && actor.grants.has('WORKFLOW.EXECUTION_ADMIN'))
        .map(d => [d.code,record[d.code] ?? null]));
    };
    const tokenCounts = await tx.workflowExecutionToken.groupBy({ by: ['status'],where: { workspaceId: actor.workspaceId,executionId: row.id },_count: { _all: true } });
    return { id: row.id,workflowId: row.definitionId,versionId: row.versionId,entityType: row.entityType,entityId: row.entityId,
      status: row.status,resultCode: row.resultCode,version: row.version,startedAt: row.startedAt,completedAt: row.completedAt,
      parameters: redact(snapshot.parameters,row.parameters),variables: redact(snapshot.variables,row.variables),
      progress: Object.fromEntries(tokenCounts.map(count => [count.status,count._count._all])) };
  }
  async start(actor: Principal, workflowId: string, raw: unknown, idempotencyKey: string | null) {
    const input = parse(startInput,raw); requirePermission(actor,'WORKFLOW.START');
    return this.db.$transaction(async tx => {
      const result = await this.startInTransaction(tx,actor,workflowId,input,idempotencyKey);
      const current = await tx.workflowExecution.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: result.executionId } });
      await this.entities.execution(tx,actor,current);
      return { executionId: current.id,status: current.status,versionId: current.versionId };
    },{ timeout: 60000 });
  }
  async startInTransaction(tx: Tx, actor: Principal, workflowId: string, raw: unknown, key: string | null,
    parent?: { executionId: string; depth: number; ancestry: string[]; versionId?: string }, origin?: { type: 'EVENT'|'SCHEDULE'; id: string }) {
    const input = parse(startInput,raw); requirePermission(actor,'WORKFLOW.START');
    await lock(tx,actor.workspaceId,'workflow:starts');
    await lock(tx,actor.workspaceId,'workflow:' + workflowId);
    actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.START');
    return command(tx,actor,'workflow.start:' + workflowId,key,{ ...input,parentExecutionId: parent?.executionId ?? null },async () => {
      const definition = await this.definitions.definition(tx,actor,workflowId,'WORKFLOW.START');
      if (definition.status === 'ARCHIVED') throw new AppError('WORKFLOW_ARCHIVED','Archived Workflow cannot start.',409);
      if (definition.status !== 'ACTIVE' || !definition.currentVersionId) throw new AppError('WORKFLOW_NO_PUBLISHED_VERSION','Active publication is required.',409);
      if (!origin && !parent && await tx.workflowTrigger.findFirst({ where: { workspaceId: actor.workspaceId,definitionId: workflowId,type: 'MANUAL',enabled: false } }))
        throw new AppError('WORKFLOW_INVALID_STATE','Manual starts are disabled for this Workflow.',409);
      if (definition.boundEntityType !== input.entityType) throw new AppError('WORKFLOW_ENTITY_BINDING_INVALID','Entity does not match the Workflow binding.',422);
      const source = await this.entities.read(tx,actor,input.entityType,input.entityId,definition.boundEntityTypeId ?? undefined);
      void source;
      const effective = definition.runAs === 'SERVICE_ACCOUNT' && definition.serviceAccountUserId ? await resolvePrincipal(tx,actor.workspaceId,definition.serviceAccountUserId) : actor;
      requirePermission(effective,'WORKFLOW.START');
      await this.entities.read(tx,effective,input.entityType,input.entityId,definition.boundEntityTypeId ?? undefined);
      const publication = await tx.workflowVersion.findFirst({ where: { workspaceId: actor.workspaceId,definitionId: workflowId,
        id: parent?.versionId ?? definition.currentVersionId,status: { in: ['PUBLISHED','SUPERSEDED'] } } });
      if (!publication) throw new AppError('WORKFLOW_NO_PUBLISHED_VERSION','Publication is unavailable.',409);
      const snapshot = parse(graph,publication.definition);
      if (createHash('sha256').update(canonical(snapshot)).digest('hex') !== publication.checksum) throw new AppError('WORKFLOW_GRAPH_INVALID','Publication checksum failed.',409);
      const parameters = typedRecord(snapshot.parameters,input.parameters);
      await this.entities.validateReferences(tx,effective,parameters);
      for (const definition of snapshot.parameters.filter(p => p.datatype === 'USER')) {
        if (parameters[definition.code]) await resolvePrincipal(tx,actor.workspaceId,String(parameters[definition.code]));
      }
      const policy = await tx.workflowRuntimePolicy.findUnique({ where: { workspaceId: actor.workspaceId } });
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
      const entitlements = (workspace.settings as Record<string,unknown>).entitlements as Record<string,unknown> | undefined;
      if (entitlements?.workflows === false) throw new AppError('WORKFLOW_PLAN_LIMIT','Workflows are unavailable.',403);
      const depth = parent ? parent.depth+1 : 0, ancestry = parent?.ancestry ?? [];
      if (depth > (policy?.maxDepth ?? 10) || ancestry.includes(workflowId)) throw new AppError('WORKFLOW_RECURSION_LIMIT','Child Workflow exceeds ancestry or depth limits.',422);
      const planMax = typeof entitlements?.maxConcurrentWorkflows === 'number' ? entitlements.maxConcurrentWorkflows : 10000;
      if (await tx.workflowExecution.count({ where: { workspaceId: actor.workspaceId,status: { in: activeExecutionStatuses } } }) >= Math.min(planMax,policy?.maxConcurrentExecutions ?? 100))
        throw new AppError('WORKFLOW_RUNTIME_LIMIT_EXCEEDED','Concurrent execution limit reached.',409);
      await lock(tx,actor.workspaceId,'workflow:entity:' + input.entityType + ':' + input.entityId);
      const concurrent = await tx.workflowExecution.findMany({ where: { workspaceId: actor.workspaceId,entityType: input.entityType,entityId: input.entityId,status: { in: activeExecutionStatuses } } });
      if (concurrent.some(e => e.concurrencyMode === 'ONE_WORKFLOW_PER_ENTITY') || definition.concurrencyMode === 'ONE_WORKFLOW_PER_ENTITY' && concurrent.length ||
        definition.concurrencyMode === 'ONE_PER_DEFINITION_PER_ENTITY' && concurrent.some(e => e.definitionId === workflowId))
        throw new AppError('WORKFLOW_ALREADY_RUNNING','Concurrency policy prevents another execution.',409);
      let concurrencyKey: string | null = null;
      if (definition.concurrencyMode === 'ONE_PER_DEFINITION_PER_ENTITY') concurrencyKey = workflowId + ':' + input.entityType + ':' + input.entityId;
      if (definition.concurrencyMode === 'ONE_WORKFLOW_PER_ENTITY') concurrencyKey = 'ENTITY:' + input.entityType + ':' + input.entityId;
      if (definition.concurrencyMode === 'CUSTOM_KEY') {
        const customKey = parameters.CONCURRENCY_KEY;
        if (typeof customKey !== 'string' || !customKey || customKey.length > 200) throw new AppError('WORKFLOW_PARAMETER_INVALID','CUSTOM_KEY requires a declared CONCURRENCY_KEY parameter.',422);
        concurrencyKey = 'CUSTOM:' + workflowId + ':' + customKey;
        if (await tx.workflowExecution.findFirst({ where: { workspaceId: actor.workspaceId,concurrencyKey,status: { in: activeExecutionStatuses } } }))
          throw new AppError('WORKFLOW_ALREADY_RUNNING','Concurrency key is already active.',409);
      }
      const startNode = snapshot.nodes.find(n => n.nodeType === 'START');
      if (!startNode) throw new AppError('WORKFLOW_GRAPH_INVALID','Publication START is missing.',409);
      const row = await tx.workflowExecution.create({ data: { workspaceId: actor.workspaceId,definitionId: workflowId,versionId: publication.id,
        snapshot: json(snapshot),entityType: input.entityType,entityId: input.entityId,runAs: definition.runAs,executionUserId: effective.userId,
        startedByUserId: actor.userId,startedByType: origin?.type ?? (parent ? 'WORKFLOW' : 'USER'),parameters: json(persistable(snapshot.parameters,parameters)),variables: json(typedRecord(snapshot.variables,{})),
        concurrencyMode: definition.concurrencyMode,concurrencyKey,parentExecutionId: parent?.executionId,depth,ancestry: [...ancestry,workflowId],
        expiresAt: new Date(Date.now() + (policy?.maxLifetimeDays ?? 365)*86400000) } });
      await tx.workflowExecutionToken.create({ data: { workspaceId: actor.workspaceId,executionId: row.id,nodeKey: startNode.nodeKey,branchKey: 'ROOT',activationKey: 'ROOT' } });
      if (concurrencyKey) await tx.workflowEntityLock.create({ data: { workspaceId: actor.workspaceId,entityType: input.entityType,entityId: input.entityId,
        lockScope: concurrencyKey,executionId: row.id,expiresAt: row.expiresAt } });
      await tx.workflowExecutionLog.create({ data: { workspaceId: actor.workspaceId,executionId: row.id,level: 'INFO',code: 'WORKFLOW_STARTED',metadata: { versionId: publication.id } } });
      await evidence(tx,actor,'WORKFLOW_EXECUTION',row.id,'WORKFLOW_STARTED',{ workflowId,versionId: publication.id,entityType: input.entityType,entityId: input.entityId,executionUserId: effective.userId,sourceEventId: origin?.id ?? null });
      return { executionId: row.id };
    });
  }
  async list(actor: Principal, raw: unknown) {
    requirePermission(actor,'WORKFLOW.EXECUTION_VIEW'); const query = parse(pageQuery.extend({ workflowId: uuid.optional(),entityId: uuid.optional(),
      status: z.enum(['QUEUED','RUNNING','WAITING','SUSPENDED','COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT']).optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.workflowExecution.findMany({ where: { workspaceId: actor.workspaceId,definitionId: query.workflowId,entityId: query.entityId,status: query.status },orderBy: [{ startedAt: 'desc' },{ id: 'asc' }] });
      const allowed: WorkflowExecution[] = [];
      for (const row of rows) if (await ownerVisible(tx,actor,row.startedByUserId,'WORKFLOW.EXECUTION_VIEW')) {
        try { await this.entities.execution(tx,actor,row); allowed.push(row); } catch (error) { if (!(error instanceof AppError && [403,404].includes(error.status))) throw error; }
      }
      const data = [];
      for (const row of allowed.slice((query.page-1)*query.limit,query.page*query.limit)) data.push(await this.projection(tx,actor,row));
      return { data,meta: { page: query.page,limit: query.limit,total: allowed.length,totalPages: Math.ceil(allowed.length/query.limit) } };
    },{ timeout: 60000 });
  }
  async get(actor: Principal, executionId: string) {
    return this.db.$transaction(async tx => this.projection(tx,actor,await this.load(tx,actor,executionId)));
  }
  async nodes(actor: Principal, executionId: string, raw: unknown) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.load(tx,actor,executionId); const where = { workspaceId: actor.workspaceId,executionId };
      const [rows,total] = await Promise.all([tx.workflowNodeExecution.findMany({ where,orderBy: [{ createdAt: 'asc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.workflowNodeExecution.count({ where })]);
      return { data: rows.map(n => ({ id: n.id,nodeId: n.nodeId,iterationNumber: n.iterationNumber,attemptCount: n.attemptCount,status: n.status,
        errorCode: n.errorCode,createdAt: n.createdAt,completedAt: n.completedAt })),meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async logs(actor: Principal, executionId: string, raw: unknown) {
    const query = parse(z.strictObject({ cursor: uuid.optional(),limit: z.coerce.number().int().min(1).max(100).default(50),level: z.enum(['INFO','WARN','ERROR']).optional() }),raw);
    return this.db.$transaction(async tx => {
      const execution = await this.load(tx,actor,executionId,'WORKFLOW.LOG_VIEW');
      if (query.cursor && !await tx.workflowExecutionLog.findFirst({ where: { workspaceId: actor.workspaceId,executionId,id: query.cursor } }))
        throw new AppError('INVALID_ARGUMENT','Cursor is unavailable.',400);
      const rows = await tx.workflowExecutionLog.findMany({ where: { workspaceId: actor.workspaceId,executionId,level: query.level,
        classification: { in: execution.startedByUserId === actor.userId || actor.grants.has('WORKFLOW.EXECUTION_ADMIN') ? ['PUBLIC','BUSINESS'] : ['PUBLIC'] } },
        orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }],take: query.limit+1,...(query.cursor ? { cursor: { id: query.cursor },skip: 1 } : {}) });
      return { entries: rows.slice(0,query.limit).map(row => ({ id: row.id,nodeRunId: row.nodeRunId,level: row.level,code: row.code,occurredAt: row.occurredAt,
        metadata: row.classification === 'PUBLIC' ? row.metadata : {} })),nextCursor: rows.length>query.limit ? rows[query.limit-1].id : null };
    });
  }
  async control(actor: Principal, executionId: string, action: 'cancel'|'suspend'|'resume'|'retry'|'terminate', raw: unknown) {
    const input = action === 'resume' ? parse(z.strictObject({ expectedVersion: version }),raw) : action === 'retry'
      ? parse(z.strictObject({ expectedVersion: version,failedNodeRunId: uuid }),raw) : parse(administrative,raw);
    const permission = action === 'cancel' ? actor.grants.has('WORKFLOW.CANCEL_ALL') ? 'WORKFLOW.CANCEL_ALL' : 'WORKFLOW.CANCEL_OWN' : 'WORKFLOW.EXECUTION_ADMIN';
    requirePermission(actor,permission);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:execution:' + executionId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const current = await this.load(tx,actor,executionId,permission); assertVersion(current.version,input.expectedVersion);
      if (permission === 'WORKFLOW.CANCEL_OWN' && current.startedByUserId !== actor.userId) throw new AppError('PERMISSION_DENIED','Only your execution can be cancelled.',403);
      let status: string;
      if (action === 'resume') { if (current.status !== 'SUSPENDED') throw new AppError('WORKFLOW_INVALID_STATE','Only a suspended execution can resume.',409); status = 'RUNNING'; }
      else if (action === 'retry') {
        if (current.status !== 'FAILED' || !('failedNodeRunId' in input)) throw new AppError('WORKFLOW_INVALID_STATE','Failed execution and node are required.',409);
        const run = await tx.workflowNodeExecution.findFirst({ where: { workspaceId: actor.workspaceId,executionId,id: parse(uuid,input.failedNodeRunId),status: 'FAILED' } });
        if (!run) throw new AppError('WORKFLOW_RETRY_UNSAFE','Failed checkpoint is unavailable.',409);
        const uncertain = await tx.workflowActionInvocation.findFirst({ where: { workspaceId: actor.workspaceId,nodeRunId: run.id,status: 'RUNNING' } });
        if (uncertain) throw new AppError('WORKFLOW_RETRY_UNSAFE','Provider outcome requires reconciliation before retry.',409);
        const conflicting = current.concurrencyKey ? await tx.workflowExecution.findFirst({ where: { workspaceId: actor.workspaceId,
          concurrencyKey: current.concurrencyKey,status: { in: activeExecutionStatuses },id: { not: current.id } } }) : null;
        if (conflicting) throw new AppError('WORKFLOW_ALREADY_RUNNING','Execution concurrency key was reused.',409);
        const node = parse(graph,current.snapshot).nodes.find(n => n.id===run.nodeId);
        await tx.workflowNodeExecution.update({ where: { id: run.id },data: { status: 'QUEUED',retryBudget: { increment: Number(node?.config.maxAttempts ?? 3) },leaseOwner: null,leaseUntil: null } });
        await tx.workflowExecutionToken.update({ where: { id: run.tokenId },data: { status: 'READY',availableAt: new Date(),version: { increment: 1 } } });
        status = 'RUNNING';
      } else {
        if (!activeExecutionStatuses.includes(current.status)) throw new AppError('WORKFLOW_INVALID_STATE','Execution is already terminal.',409);
        status = action === 'suspend' ? 'SUSPENDED' : action === 'terminate' ? 'TERMINATED' : 'CANCELLED';
        if (action === 'suspend' && current.status === 'SUSPENDED') throw new AppError('WORKFLOW_INVALID_STATE','Execution is already suspended.',409);
      }
      const now = new Date();
      if (action === 'suspend') {
        const timers = await tx.workflowTimer.findMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING',type: { in: ['RELATIVE','WORKDAY_AWARE'] } } });
        for (const timer of timers) {
          const remainingSeconds = timer.type === 'WORKDAY_AWARE' ? (await workflowBusinessTime(tx,await resolvePrincipal(tx,current.workspaceId,current.executionUserId))).remaining(now,timer.scheduledFor)
            : Math.max(0,Math.ceil((timer.scheduledFor.getTime()-now.getTime())/1000));
          await tx.workflowTimer.update({ where: { id: timer.id },data: { status: 'PAUSED',remainingSeconds } });
        }
      }
      if (action === 'resume') {
        const timers = await tx.workflowTimer.findMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PAUSED' } });
        for (const timer of timers) {
          const scheduledFor = timer.type === 'WORKDAY_AWARE' ? (await workflowBusinessTime(tx,await resolvePrincipal(tx,current.workspaceId,current.executionUserId))).due(now,timer.remainingSeconds ?? 0,current.expiresAt)
            : new Date(now.getTime()+(timer.remainingSeconds ?? 0)*1000);
          await tx.workflowTimer.update({ where: { id: timer.id },data: { status: 'PENDING',scheduledFor,remainingSeconds: null } });
        }
      }
      if (['cancel','terminate'].includes(action)) {
        await tx.workflowExecutionToken.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: { in: ['READY','RUNNING','WAITING'] } },data: { status: 'CANCELLED',version: { increment: 1 } } });
        await tx.workflowNodeExecution.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: { in: ['QUEUED','RUNNING','WAITING'] } },data: { status: 'CANCELLED',leaseOwner: null,leaseUntil: null,completedAt: now } });
        await tx.workflowHumanAssignment.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING' },data: { status: 'CANCELLED',version: { increment: 1 } } });
        await tx.workflowTimer.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: { in: ['PENDING','PAUSED'] } },data: { status: 'CANCELLED' } });
        await tx.workflowEventSubscription.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING' },data: { status: 'CANCELLED' } });
        await tx.workflowParallelJoin.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING' },data: { status: 'CANCELLED' } });
        await tx.workflowEntityLock.deleteMany({ where: { workspaceId: actor.workspaceId,executionId } });
        if (action === 'cancel') await tx.workflowCompensationAction.updateMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING' },data: { requested: true } });
      }
      const row = await tx.workflowExecution.update({ where: { id: executionId },data: { status,version: { increment: 1 },
        completedAt: terminalExecutionStatuses.includes(status) ? now : null } });
      const event = action === 'cancel' ? 'WORKFLOW_CANCELLED' : action === 'terminate' ? 'WORKFLOW_TERMINATED' : 'WORKFLOW_EXECUTION_' + action.toUpperCase();
      await tx.workflowExecutionLog.create({ data: { workspaceId: actor.workspaceId,executionId,level: 'INFO',code: event,metadata: { actorUserId: actor.userId } } });
      await evidence(tx,actor,'WORKFLOW_EXECUTION',executionId,event,{ version: row.version,reason: 'reason' in input && typeof input.reason === 'string' ? input.reason : null });
      return { id: row.id,status: row.status,version: row.version };
    },{ timeout: 60000 });
  }
}
