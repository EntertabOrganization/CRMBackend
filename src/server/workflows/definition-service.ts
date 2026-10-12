import { Prisma, type PrismaClient, type WorkflowDefinition, type WorkflowVersion } from '@prisma/client';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import { evidence, assertVersion, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { canonical, parse, uuid, version, pageQuery } from '../process-platform/dto';
import { createDefinition, patchDefinition, graph, node, edge, configs, type Graph } from './dto';
import { validateGraph } from './graph-validator';
import { compileExpression, evaluateExpression } from './expression';
import { typedRecord } from './typed-values';
import { workflowActions, type WorkflowActionRegistry } from './action-registry';
import { IntegrationConnectionService } from '../integration-connections';

const emptyGraph: Graph = { nodes: [], edges: [], parameters: [], variables: [], constants: [] };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export class WorkflowDefinitionService {
  readonly actions: WorkflowActionRegistry;
  readonly connections: IntegrationConnectionService;
  constructor(private readonly db: PrismaClient, actions?: WorkflowActionRegistry, connections?: IntegrationConnectionService) {
    this.actions = actions ?? workflowActions(db); this.connections = connections ?? new IntegrationConnectionService(db);
  }
  async definition(tx: Tx, actor: Principal, id: string, permission: string): Promise<WorkflowDefinition> {
    parse(uuid,id); requirePermission(actor,permission);
    const row = await tx.workflowDefinition.findFirst({ where: { workspaceId: actor.workspaceId, id } });
    if (!row || permission !== 'WORKFLOW.START' && !await ownerVisible(tx,actor,row.createdByUserId,permission)) throw new AppError('WORKFLOW_NOT_FOUND','Workflow was not found.',404);
    return row;
  }
  async workflowVersion(tx: Tx, actor: Principal, workflowId: string, versionId: string, permission: string, editable = false) {
    const definition = await this.definition(tx,actor,workflowId,permission); parse(uuid,versionId);
    const row = await tx.workflowVersion.findFirst({ where: { workspaceId: actor.workspaceId, definitionId: workflowId, id: versionId } });
    if (!row) throw new AppError('WORKFLOW_VERSION_NOT_FOUND','Workflow version was not found.',404);
    if (editable && row.status !== 'DRAFT') throw new AppError('WORKFLOW_PUBLISHED_IMMUTABLE','Only a draft graph can be changed.',409);
    if (editable && definition.status === 'ARCHIVED') throw new AppError('WORKFLOW_ARCHIVED','Archived Workflow is read only.',409);
    return { definition,row };
  }
  private async binding(tx: Tx, actor: Principal, type: string, subtypeId?: string) {
    if (type === 'SPA_ITEM') {
      if (!subtypeId || !await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: subtypeId, deletedAt: null } }))
        throw new AppError('WORKFLOW_ENTITY_BINDING_INVALID','Bound subtype is unavailable.',422);
    } else if (subtypeId) throw new AppError('WORKFLOW_ENTITY_BINDING_INVALID','Subtype does not apply to this entity.',422);
  }
  /** Template creation uses the same owning validation and persists definition/graph in one transaction. */
  async instantiateInTransaction(tx: Tx,actor: Principal,input: z.infer<typeof createDefinition>,snapshot: Graph) {
    await lock(tx,actor.workspaceId,'workflow:definitions'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.DESIGN');
    const entitlements = await this.entitled(tx,actor),maximum = entitlements?.maxWorkflowDefinitions;
    if (typeof maximum==='number' && await tx.workflowDefinition.count({ where: { workspaceId: actor.workspaceId,status: { not: 'ARCHIVED' } } })>=maximum)
      throw new AppError('WORKFLOW_PLAN_LIMIT','Workflow definition limit reached.',403);
    await this.binding(tx,actor,input.boundEntityType,input.boundEntityTypeId);
    const { runAs: _runAs,...data } = input;
    const definition = await tx.workflowDefinition.create({ data: { ...data,...await this.identity(tx,actor,input.runAs),workspaceId: actor.workspaceId,createdByUserId: actor.userId } });
    const problems = await this.graphProblems(tx,actor,definition,snapshot,false);
    if (problems.length) throw new AppError('WORKFLOW_TEMPLATE_INVALID','Template bindings are invalid.',422,{ problems });
    const row = await tx.workflowVersion.create({ data: { workspaceId: actor.workspaceId,definitionId: definition.id,versionNumber: 1,definition: json(snapshot) } });
    await this.persistGraph(tx,actor,row,snapshot);
    await evidence(tx,actor,'WORKFLOW_DEFINITION',definition.id,'WORKFLOW_CREATED',{ code: definition.code,versionId: row.id });
    return { ...definition,draftVersionId: row.id };
  }
  private async identity(tx: Tx, actor: Principal, identity: z.infer<typeof createDefinition>['runAs']) {
    if (identity === 'STARTER') return { runAs: 'STARTER', serviceAccountUserId: null };
    requirePermission(actor,'WORKFLOW.SECURE_RUNAS_MANAGE',true);
    const service = await resolvePrincipal(tx,actor.workspaceId,identity.userId);
    const role = await tx.role.findFirst({ where: { workspaceId: actor.workspaceId, id: service.roleId, isDeleted: false } });
    if (!role || role.isOwnerRole || !service.grants.has('WORKFLOW.START'))
      throw new AppError('WORKFLOW_RUNAS_DENIED','A scoped execution identity with explicit start permission is required.',403);
    return { runAs: 'SERVICE_ACCOUNT', serviceAccountUserId: identity.userId };
  }
  private async entitled(tx: Tx, actor: Principal) {
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    const settings = workspace.settings as Record<string,unknown>, entitlements = settings.entitlements as Record<string,unknown> | undefined;
    if (entitlements?.workflows === false) throw new AppError('WORKFLOW_PLAN_LIMIT','Workflows are unavailable for this Workspace.',403);
    return entitlements;
  }
  async create(actor: Principal, raw: unknown) {
    requirePermission(actor,'WORKFLOW.DESIGN'); const input = parse(createDefinition,raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:definitions'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.DESIGN');
      const entitlements = await this.entitled(tx,actor);
      const maximum = entitlements?.maxWorkflowDefinitions;
      if (typeof maximum === 'number' && await tx.workflowDefinition.count({ where: { workspaceId: actor.workspaceId, status: { not: 'ARCHIVED' } } }) >= maximum)
        throw new AppError('WORKFLOW_PLAN_LIMIT','Workflow definition limit reached.',403);
      await this.binding(tx,actor,input.boundEntityType,input.boundEntityTypeId);
      const { runAs: _runAs,...data } = input;
      const row = await tx.workflowDefinition.create({ data: { ...data,...await this.identity(tx,actor,input.runAs), workspaceId: actor.workspaceId, createdByUserId: actor.userId } });
      await evidence(tx,actor,'WORKFLOW_DEFINITION',row.id,'WORKFLOW_CREATED',{ code: row.code });
      if (row.runAs !== 'STARTER') await evidence(tx,actor,'WORKFLOW_DEFINITION',row.id,'WORKFLOW_RUNAS_CHANGED',{ executionUserId: row.serviceAccountUserId });
      return row;
    });
  }
  async list(actor: Principal, raw: unknown) {
    requirePermission(actor,'WORKFLOW.VIEW'); const query = parse(pageQuery.extend({ status: z.enum(['DRAFT','ACTIVE','PAUSED','ARCHIVED']).optional(),
      boundEntityType: createDefinition.shape.boundEntityType.optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.workflowDefinition.findMany({ where: { workspaceId: actor.workspaceId, status: query.status,
        boundEntityType: query.boundEntityType, ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}) }, orderBy: [{ createdAt: 'desc' },{ id: 'asc' }] });
      const data = [];
      for (const row of rows) if (await ownerVisible(tx,actor,row.createdByUserId,'WORKFLOW.VIEW')) data.push(row);
      return { data: data.slice((query.page-1)*query.limit,query.page*query.limit), meta: { page: query.page,limit: query.limit,total: data.length,totalPages: Math.ceil(data.length/query.limit) } };
    });
  }
  async get(actor: Principal, workflowId: string) {
    return this.db.$transaction(async tx => {
      const row = await this.definition(tx,actor,workflowId,'WORKFLOW.VIEW');
      const publication = row.currentVersionId ? await tx.workflowVersion.findFirst({ where: { workspaceId: actor.workspaceId, definitionId: workflowId,id: row.currentVersionId } }) : null;
      return { ...row, currentVersion: publication ? { id: publication.id,versionNumber: publication.versionNumber,checksum: publication.checksum,publishedAt: publication.publishedAt } : null };
    });
  }
  async update(actor: Principal, workflowId: string, raw: unknown) {
    const input = parse(patchDefinition,raw); requirePermission(actor,'WORKFLOW.DESIGN');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:' + workflowId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const current = await this.definition(tx,actor,workflowId,'WORKFLOW.DESIGN'); assertVersion(current.version,input.expectedVersion);
      if (current.status === 'ARCHIVED') throw new AppError('WORKFLOW_ARCHIVED','Archived Workflow is read only.',409);
      const runAs = input.runAs ? await this.identity(tx,actor,input.runAs) : {};
      if (input.startConditions) {
        for (const trigger of input.startConditions) if (trigger.condition) compileExpression(trigger.condition);
        await tx.workflowTrigger.deleteMany({ where: { workspaceId: actor.workspaceId,definitionId: workflowId,type: 'EVENT' } });
        for (const trigger of input.startConditions) await tx.workflowTrigger.create({ data: { workspaceId: actor.workspaceId,definitionId: workflowId,
          type: 'EVENT',configuration: json({ eventType: trigger.eventType,...(trigger.condition ? { condition: trigger.condition } : {}),parameters: {} }),enabled: trigger.enabled,priority: trigger.priority,revision: current.version+1 } });
      }
      const row = await tx.workflowDefinition.update({ where: { id: workflowId },data: { name: input.name, concurrencyMode: input.concurrencyMode,...runAs,version: { increment: 1 } } });
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_CONFIGURATION_CHANGED',{ version: row.version });
      if (input.runAs) await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_RUNAS_CHANGED',{ runAs: row.runAs,executionUserId: row.serviceAccountUserId });
      return row;
    });
  }
  async newVersion(actor: Principal, workflowId: string, raw: unknown) {
    const input = parse(z.strictObject({ baseVersionId: uuid.optional() }),raw); requirePermission(actor,'WORKFLOW.DESIGN');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:' + workflowId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const definition = await this.definition(tx,actor,workflowId,'WORKFLOW.DESIGN');
      if (definition.status === 'ARCHIVED') throw new AppError('WORKFLOW_ARCHIVED','Archived Workflow is read only.',409);
      const baseId = input.baseVersionId ?? definition.currentVersionId;
      const base = baseId ? (await this.workflowVersion(tx,actor,workflowId,baseId,'WORKFLOW.DESIGN')).row : null;
      const last = await tx.workflowVersion.findFirst({ where: { workspaceId: actor.workspaceId,definitionId: workflowId },orderBy: { versionNumber: 'desc' } });
      const snapshot = base ? parse(graph,base.definition) : structuredClone(emptyGraph);
      const mapping = new Map(snapshot.nodes.map(n => [n.id,randomUUID()]));
      snapshot.nodes = snapshot.nodes.map(n => ({ ...n,id: mapping.get(n.id)! }));
      snapshot.edges = snapshot.edges.map(e => ({ ...e,id: randomUUID(),fromNodeId: mapping.get(e.fromNodeId)!,toNodeId: mapping.get(e.toNodeId)! }));
      const row = await tx.workflowVersion.create({ data: { workspaceId: actor.workspaceId,definitionId: workflowId,versionNumber: (last?.versionNumber ?? 0)+1,definition: json(snapshot) } });
      await this.persistGraph(tx,actor,row,snapshot);
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_DRAFT_VERSION_CREATED',{ versionId: row.id,versionNumber: row.versionNumber });
      return { ...row,version: row.revision };
    });
  }
  private async persistGraph(tx: Tx, actor: Principal, row: WorkflowVersion, snapshot: Graph) {
    const foreignIds = await tx.workflowNode.count({ where: { id: { in: snapshot.nodes.map(n => n.id) }, OR: [{ workspaceId: { not: actor.workspaceId } },{ versionId: { not: row.id } }] } });
    if (foreignIds) throw new AppError('WORKFLOW_NODE_INVALID','Node identity belongs to another graph.',422);
    await tx.workflowEdge.deleteMany({ where: { workspaceId: actor.workspaceId,versionId: row.id } });
    await tx.workflowNode.deleteMany({ where: { workspaceId: actor.workspaceId,versionId: row.id } });
    if (snapshot.nodes.length) await tx.workflowNode.createMany({ data: snapshot.nodes.map(n => ({ workspaceId: actor.workspaceId,versionId: row.id,id: n.id,
      nodeKey: n.nodeKey,type: n.nodeType,configuration: json(n.config),positionX: n.position.x,positionY: n.position.y })) });
    if (snapshot.edges.length) await tx.workflowEdge.createMany({ data: snapshot.edges.map(e => ({ workspaceId: actor.workspaceId,versionId: row.id,
      id: e.id,fromNodeId: e.fromNodeId,toNodeId: e.toNodeId,edgeType: e.edgeType,condition: e.condition ? json(e.condition) : Prisma.DbNull,sortOrder: e.sortOrder })) });
  }
  async versions(actor: Principal, workflowId: string, raw: unknown) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.definition(tx,actor,workflowId,'WORKFLOW.VIEW'); const where = { workspaceId: actor.workspaceId,definitionId: workflowId };
      const [rows,total] = await Promise.all([tx.workflowVersion.findMany({ where,orderBy: { versionNumber: 'desc' },skip: (query.page-1)*query.limit,take: query.limit }),tx.workflowVersion.count({ where })]);
      return { data: rows.map(row => ({ id: row.id,versionNumber: row.versionNumber,status: row.status,version: row.revision,checksum: row.checksum,publishedAt: row.publishedAt })),
        meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async getVersion(actor: Principal, workflowId: string, versionId: string, graphOnly = false) {
    return this.db.$transaction(async tx => {
      const { row } = await this.workflowVersion(tx,actor,workflowId,versionId,'WORKFLOW.VIEW');
      return graphOnly ? { ...parse(graph,row.definition),version: row.revision } : { ...row,version: row.revision };
    });
  }
  private async graphProblems(tx: Tx, actor: Principal, definition: WorkflowDefinition, snapshot: Graph, publish: boolean) {
    const policy = await tx.workflowRuntimePolicy.findUnique({ where: { workspaceId: actor.workspaceId } });
    const executionActor = definition.runAs === 'SERVICE_ACCOUNT' && definition.serviceAccountUserId ? await resolvePrincipal(tx,actor.workspaceId,definition.serviceAccountUserId) : actor;
    return validateGraph(snapshot,{ actor: executionActor,actions: this.actions,maxLoopIterations: policy?.maxLoopIterations,
      connection: async (connectionId,path) => { await this.connections.destination(tx,executionActor,connectionId,path); },
      subworkflow: async (id,versionId) => {
        if (id === definition.id) throw new AppError('WORKFLOW_RECURSION_LIMIT','Direct recursion is forbidden.',422);
        const child = await this.definition(tx,executionActor,id,'WORKFLOW.START');
        if (child.status !== 'ACTIVE' || !child.currentVersionId) throw new AppError('WORKFLOW_CHILD_INVALID','Child must have an active publication.',422);
        if (versionId && !await tx.workflowVersion.findFirst({ where: { workspaceId: actor.workspaceId,definitionId: id,id: versionId,status: { in: ['PUBLISHED','SUPERSEDED'] } } }))
          throw new AppError('WORKFLOW_CHILD_INVALID','Child version is unavailable.',422);
      },
      user: async id => { await resolvePrincipal(tx,actor.workspaceId,id); } },publish);
  }
  async editGraph(actor: Principal, workflowId: string, versionId: string, operation: 'REPLACE'|'ADD_NODE'|'PATCH_NODE'|'DELETE_NODE'|'ADD_EDGE', raw: unknown, nodeId?: string) {
    requirePermission(actor,'WORKFLOW.DESIGN');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:' + workflowId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const { definition,row } = await this.workflowVersion(tx,actor,workflowId,versionId,'WORKFLOW.DESIGN',true);
      let snapshot = parse(graph,row.definition);
      if (operation === 'REPLACE') { const input = parse(graph.extend({ expectedVersion: version }),raw); assertVersion(row.revision,input.expectedVersion); const { expectedVersion: _expected,...next } = input; snapshot = next; }
      else if (operation === 'ADD_NODE') {
        const input = parse(node.omit({ id: true }),raw); snapshot.nodes.push({ id: randomUUID(),...input });
      } else if (operation === 'PATCH_NODE') {
        parse(uuid,nodeId); const input = parse(z.strictObject({ expectedVersion: version,config: node.shape.config.optional(),position: node.shape.position.optional() }),raw);
        assertVersion(row.revision,input.expectedVersion); const existing = snapshot.nodes.find(n => n.id === nodeId);
        if (!existing) throw new AppError('WORKFLOW_NODE_INVALID','Node is unavailable.',404);
        if (input.config) existing.config = input.config; if (input.position) existing.position = input.position;
      } else if (operation === 'DELETE_NODE') {
        parse(uuid,nodeId); parse(z.strictObject({}),raw);
        if (!snapshot.nodes.some(n => n.id === nodeId)) throw new AppError('WORKFLOW_NODE_INVALID','Node is unavailable.',404);
        snapshot.nodes = snapshot.nodes.filter(n => n.id !== nodeId); snapshot.edges = snapshot.edges.filter(e => e.fromNodeId !== nodeId && e.toNodeId !== nodeId);
      } else { const input = parse(edge.omit({ id: true,sortOrder: true }),raw); snapshot.edges.push({ id: randomUUID(),sortOrder: snapshot.edges.length,...input }); }
      snapshot.nodes = snapshot.nodes.map(n => ({ ...n,config: parse(node.shape.config,parse(configs[n.nodeType],n.config)) }));
      const problems = await this.graphProblems(tx,actor,definition,snapshot,false);
      if (problems.length) throw new AppError('WORKFLOW_GRAPH_INVALID','Draft graph validation failed.',422,{ problems });
      await this.persistGraph(tx,actor,row,snapshot);
      const updated = await tx.workflowVersion.update({ where: { id: row.id },data: { definition: json(snapshot),revision: { increment: 1 } } });
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_DRAFT_GRAPH_UPDATED',{ versionId,revision: updated.revision });
      return { ...snapshot,version: updated.revision };
    },{ timeout: 30000 });
  }
  async validate(actor: Principal, workflowId: string, versionId: string, raw: unknown) {
    parse(z.strictObject({}),raw); requirePermission(actor,'WORKFLOW.DESIGN');
    return this.db.$transaction(async tx => {
      const { definition,row } = await this.workflowVersion(tx,actor,workflowId,versionId,'WORKFLOW.DESIGN');
      const problems = await this.graphProblems(tx,actor,definition,parse(graph,row.definition),true);
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_GRAPH_VALIDATED',{ versionId,valid: problems.length===0 });
      return { valid: problems.length===0,problems,version: row.revision };
    },{ timeout: 30000 });
  }
  async publish(actor: Principal, workflowId: string, versionId: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: version }),raw); requirePermission(actor,'WORKFLOW.PUBLISH');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:' + workflowId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const { definition,row } = await this.workflowVersion(tx,actor,workflowId,versionId,'WORKFLOW.PUBLISH',true); assertVersion(row.revision,input.expectedVersion);
      await this.entitled(tx,actor);
      const snapshot = parse(graph,row.definition), problems = await this.graphProblems(tx,actor,definition,snapshot,true);
      if (problems.length) throw new AppError('WORKFLOW_GRAPH_INVALID','Graph cannot be published.',422,{ problems });
      const checksum = createHash('sha256').update(canonical(snapshot)).digest('hex');
      if (definition.currentVersionId) await tx.workflowVersion.update({ where: { id: definition.currentVersionId },data: { status: 'SUPERSEDED' } });
      const publication = await tx.workflowVersion.update({ where: { id: row.id },data: { status: 'PUBLISHED',checksum,publishedAt: new Date(),publishedByUserId: actor.userId } });
      await tx.workflowDefinition.update({ where: { id: workflowId },data: { currentVersionId: row.id,status: 'ACTIVE',version: { increment: 1 } } });
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_VERSION_PUBLISHED',{ versionId,versionNumber: row.versionNumber,checksum });
      return { ...publication,version: publication.revision,definitionVersion: definition.version+1 };
    },{ timeout: 30000 });
  }
  async transition(actor: Principal, workflowId: string, action: 'pause'|'archive', raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: version }),raw); requirePermission(actor,'WORKFLOW.PUBLISH');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:' + workflowId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const current = await this.definition(tx,actor,workflowId,'WORKFLOW.PUBLISH'); assertVersion(current.version,input.expectedVersion);
      if (action === 'pause' && current.status !== 'ACTIVE' || current.status === 'ARCHIVED') throw new AppError('WORKFLOW_INVALID_STATE','Workflow transition is unavailable.',409);
      const row = await tx.workflowDefinition.update({ where: { id: workflowId },data: { status: action === 'pause' ? 'PAUSED' : 'ARCHIVED',version: { increment: 1 } } });
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,action === 'pause' ? 'WORKFLOW_PAUSED' : 'WORKFLOW_ARCHIVED',{ version: row.version }); return row;
    });
  }
  async preview(actor: Principal, workflowId: string, versionId: string, raw: unknown) {
    const input = parse(z.strictObject({ testParameters: z.record(z.string(),z.json()),testContext: z.strictObject({ entity: z.record(z.string(),z.json()).default({}),now: z.iso.datetime({ offset: true }).optional() }) }),raw);
    return this.db.$transaction(async tx => {
      const { row } = await this.workflowVersion(tx,actor,workflowId,versionId,'WORKFLOW.DESIGN'); const snapshot = parse(graph,row.definition);
      const context = { parameters: typedRecord(snapshot.parameters,input.testParameters),variables: typedRecord(snapshot.variables,{}),
        constants: typedRecord(snapshot.constants,{}),entity: input.testContext.entity,outputs: {},actor: { id: actor.userId },now: input.testContext.now ?? new Date().toISOString(),iteration: {} };
      const results = [];
      for (const node of snapshot.nodes) if (['CONDITION','SWITCH','SET_VARIABLE','WHILE','FOR_EACH'].includes(node.nodeType)) {
        const source = node.config.expression ?? node.config.collection;
        if (typeof source !== 'string') throw new AppError('WORKFLOW_NODE_INVALID','Expression is missing.',422);
        results.push({ nodeId: node.id,result: evaluateExpression(compileExpression(source),context) });
      }
      return { dryRun: true,results };
    });
  }
}
