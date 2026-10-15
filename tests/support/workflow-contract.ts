import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { prepareProcessPlatformDatabase } from './process-platform-db';
import { spaFixture } from './spa-fixture';
import { resolvePrincipal } from '../../src/server/process-platform/context';
import { resetRateLimits } from '../../src/server/rate-limit';
import { workflowActions, type WorkflowActionOptions } from '../../src/server/workflows/action-registry';
import { WorkflowDefinitionService } from '../../src/server/workflows/definition-service';
import { WorkflowExecutionService } from '../../src/server/workflows/execution-service';
import { WorkflowRuntime } from '../../src/server/workflows/runtime';
import { WorkflowAssignmentService } from '../../src/server/workflows/assignment-service';
import { WorkflowWaitWorker } from '../../src/server/workflows/wait-worker';
import { WorkflowTriggerService } from '../../src/server/workflows/trigger-service';
import { WorkflowTriggerWorker } from '../../src/server/workflows/trigger-worker';
import { WorkflowCompensationService } from '../../src/server/workflows/compensation-service';
import { WorkflowGovernanceService } from '../../src/server/workflows/governance-service';
import { WorkflowTemplateService } from '../../src/server/workflows/template-service';
import { WorkflowActionsService } from '../../src/server/workflows/actions-service';
import { IntegrationConnectionService } from '../../src/server/integration-connections';

/** Each Workflow contract suite recreates one owned disposable database; each case uses fresh Workspaces. */
export function workflowDatabase(name: string) {
  let db: PrismaClient;
  beforeAll(async () => {
    const url = await prepareProcessPlatformDatabase(name);
    db = new PrismaClient({ datasources: { db: { url } } });
  }, 300000);
  afterAll(async () => { await db?.$disconnect(); const { prisma } = await import('../../src/server/prisma-client'); await prisma.$disconnect(); });
  beforeEach(() => resetRateLimits());
  jest.setTimeout(180000);
  return () => db;
}

export { node, edge, typed, linear, type GraphNode, type GraphInput } from './workflow-graph';
import { node, edge, type GraphNode, type GraphInput } from './workflow-graph';

type ExistingIdentity = { user: { id: string }; workspace: { id: string }; role: { id: string } };
export async function workflowFixture(db: PrismaClient, options: WorkflowActionOptions & { connections?: IntegrationConnectionService; existing?: ExistingIdentity } = {}) {
  const spa = await spaFixture(db, 'TEXT', options.existing);
  const item = await spa.create('Initial');
  const definitions = new WorkflowDefinitionService(db, workflowActions(db, options), options.connections);
  const executions = new WorkflowExecutionService(db, definitions);
  const runtime = new WorkflowRuntime(db, executions);
  const assignments = new WorkflowAssignmentService(db, runtime);
  const waits = new WorkflowWaitWorker(db, runtime);
  const triggers = new WorkflowTriggerService(db, executions);
  const triggerWorker = new WorkflowTriggerWorker(db, runtime, triggers);
  const compensations = new WorkflowCompensationService(db, executions);
  const governance = new WorkflowGovernanceService(db, executions);
  const templates = new WorkflowTemplateService(db, definitions);
  const actions = new WorkflowActionsService(db, executions);
  const define = async (graph: GraphInput, extra: Record<string, unknown> = {}, actor = spa.actor) => {
    const created = await definitions.create(actor, { name: 'Workflow', code: 'WF_' + randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase(),
      type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: spa.type.id, ...extra });
    const draft = await definitions.newVersion(actor, created.id, {});
    const edited = await definitions.editGraph(actor, created.id, draft.id, 'REPLACE', { expectedVersion: draft.version, parameters: [], variables: [], constants: [], ...graph });
    const published = await definitions.publish(actor, created.id, draft.id, { expectedVersion: edited.version });
    return { workflowId: created.id, versionId: draft.id, published };
  };
  const start = async (workflowId: string, parameters: Record<string, unknown> = {}, key: string = randomUUID(), actor = spa.actor, entityId = item.id) =>
    executions.start(actor, workflowId, { entityType: 'SPA_ITEM', entityId, parameters }, key);
  /** Run the durable dispatcher until no ready activation remains (bounded). */
  const drain = async (rounds = 40) => {
    let claimed = 0;
    for (let i = 0; i < rounds; i++) { const result = await runtime.tick(100); claimed += result.claimed; if (!result.claimed) break; }
    return claimed;
  };
  const execution = (id: string) => db.workflowExecution.findUniqueOrThrow({ where: { id } });
  const runs = async (executionId: string, nodeKey?: string) => {
    const rows = await db.workflowNodeExecution.findMany({ where: { executionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!nodeKey) return rows;
    const snapshot = (await execution(executionId)).snapshot as { nodes: GraphNode[] };
    const id = snapshot.nodes.find(n => n.nodeKey === nodeKey)?.id;
    return rows.filter(row => row.nodeId === id);
  };
  /** Additional Workspace member. `grants` maps permission key to scope; null withholds the grant entirely. */
  const member = async (grants: Record<string, string | null> = {}, all = true) => {
    const user = await db.user.create({ data: { firstName: 'Workflow', lastName: 'Member', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    const role = await db.role.create({ data: { workspaceId: spa.workspace.id, name: 'Member ' + randomUUID().slice(0, 8) } });
    await db.workspaceMembership.create({ data: { workspaceId: spa.workspace.id, userId: user.id, roleId: role.id } });
    const permissions = await db.permission.findMany();
    await db.rolePermission.createMany({ data: permissions.filter(p => grants[p.key] !== null && (all || grants[p.key]))
      .map(p => ({ roleId: role.id, permissionId: p.id, scope: (grants[p.key] ?? 'WORKSPACE') as 'WORKSPACE' })) });
    return { user, role, actor: await resolvePrincipal(db, spa.workspace.id, user.id) };
  };
  const revoke = async (roleId: string, key: string) => {
    const permission = await db.permission.findUniqueOrThrow({ where: { key } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, data: { isDeleted: true } });
  };
  const outbox = (eventType: string, entityId?: string) => db.outboxEvent.count({ where: { workspaceId: spa.workspace.id, eventType, ...(entityId ? { entityId } : {}) } });
  return { ...spa, item, definitions, executions, runtime, assignments, waits, triggers, triggerWorker, compensations, governance, templates, actions,
    define, start, drain, execution, runs, member, revoke, outbox };
}
export type WorkflowFixture = Awaited<ReturnType<typeof workflowFixture>>;

export type HttpsCall = { url: URL; method: string; headers: Record<string, unknown>; body: string };
type HttpsReply = { status: number; location?: string; body?: string } | 'TIMEOUT';
/** Sandbox provider at the socket boundary: production DNS pinning, SSRF and redirect checks still run unchanged. */
export function sandboxHttps(respond: (call: HttpsCall) => HttpsReply) {
  const https = require('node:https') as typeof import('node:https'), calls: HttpsCall[] = [];
  const spy = jest.spyOn(https, 'request').mockImplementation(((target: URL, options: { method: string; headers: Record<string, unknown> }, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & Record<string, unknown>; let body = '';
    request.write = (chunk: string) => { body += chunk; return true; };
    request.destroy = (error?: Error) => { request.emit('error', error ?? new Error('destroyed')); return request; };
    request.end = () => { setImmediate(() => {
      const call = { url: new URL(target.toString()), method: options.method, headers: options.headers, body }; calls.push(call);
      const reply = respond(call);
      if (reply === 'TIMEOUT') { request.emit('timeout'); return; }
      const response = new EventEmitter() as EventEmitter & Record<string, unknown>;
      response.statusCode = reply.status; response.headers = reply.location ? { location: reply.location } : {};
      callback(response); if (reply.body) response.emit('data', Buffer.from(reply.body)); response.emit('end');
    }); return request; };
    return request;
  }) as never);
  return { calls, restore: () => spy.mockRestore() };
}
/** Integration connection authority with a controlled resolver and SecretPort (no live DNS or credentials). */
export function sandboxConnections(db: PrismaClient, addresses: Record<string, string[]>, secrets: Record<string, string> = {}) {
  const resolver = async (host: string) => { const list = addresses[host]; if (!list) throw new Error('NXDOMAIN'); return list.map(address => ({ address, family: address.includes(':') ? 6 : 4 })); };
  return new IntegrationConnectionService(db, { resolve: (_workspaceId: string, reference: string) => secrets[reference] ?? null }, resolver);
}
