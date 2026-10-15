import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { workflowDatabase, workflowFixture, linear, node, sandboxHttps, sandboxConnections, type WorkflowFixture, type HttpsCall } from '@/tests/support/workflow-contract';
import { SpaPolicyService } from '@/src/server/spa/policy-service';
import { canonical } from '@/src/server/process-platform/dto';

/** Owning-service action adapters, egress safety, signed callbacks and provider retry semantics. */
const database = workflowDatabase('truecrm_workflow_integrations_test');
const marker = 'sk_live_plaintext_marker_' + randomUUID();
const previous = { key: process.env.WORKFLOW_CALLBACK_SIGNING_KEY, origin: process.env.APP_PUBLIC_BASE_URL };
beforeAll(() => { process.env.WORKFLOW_CALLBACK_SIGNING_KEY = 'workflow-callback-test-signing-key-0123456789abcdef'; process.env.APP_PUBLIC_BASE_URL = 'https://crm.example.com'; });
afterAll(() => { process.env.WORKFLOW_CALLBACK_SIGNING_KEY = previous.key; process.env.APP_PUBLIC_BASE_URL = previous.origin; });

async function partner(db: PrismaClient, addresses: Record<string, string[]> = {}) {
  // The resolver reads this map by reference so tests can simulate DNS rebinding.
  const connections = sandboxConnections(db, Object.assign(addresses, { 'partner.example.com': ['93.184.216.34'] }), { 'partner-key': marker });
  const f = await workflowFixture(db, { connections });
  const connection = await connections.create(f.actor, { name: 'Partner', baseUrl: 'https://partner.example.com/', allowedHosts: ['partner.example.com'], secretReference: 'partner-key', supportsIdempotency: true });
  const http = (config: Record<string, unknown> = {}, key = 'CALL') => node(key, 'HTTP_REQUEST', { connectionId: connection.id, path: '/orders', method: 'POST', body: { orderRef: 'A-1' }, ...config });
  return { f, connections, connection, http };
}
const ready = (db: PrismaClient, executionId: string) => db.workflowExecutionToken.updateMany({ where: { executionId, status: 'READY' }, data: { availableAt: new Date() } });
async function callbackOf(call: HttpsCall) {
  const body = JSON.parse(call.body) as { callback: { url: string; nonce: string } };
  return { token: body.callback.url.split('/').pop()!, nonce: body.callback.nonce };
}
const sign = (nonce: string, payload: Record<string, unknown>) => createHmac('sha256', nonce).update(canonical({ nonce, payload })).digest('base64url');
async function receive(f: WorkflowFixture, token: string, nonce: string, payload: Record<string, unknown>, signature = sign(nonce, payload)) {
  return f.runtime.callbacks.receive(token, { nonce, payload }, signature);
}

describe('Workflow Action Registry, HTTP and Domain Integrations — unit/integration contract', () => {
  it('workflow action cannot modify SPA field starter cannot edit', async () => {
    const db = database(), f = await workflowFixture(db), starter = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null });
    const policies = new SpaPolicyService(db), matrix = await policies.matrix(f.actor, f.type.id);
    await policies.replace(f.actor, f.type.id, { expectedVersion: matrix.version, rolePolicies: [], stagePolicies: [],
      fieldPolicies: [{ fieldId: f.field.id, subjectType: 'ROLE', subjectId: starter.role.id, canView: true, canEdit: false }] });
    const update = node('UPDATE', 'ACTION', { actionCode: 'SPA.UPDATE_ITEM', input: { typeId: f.type.id, itemId: f.item.id, changes: { fieldValues: { VALUE: 'overwritten' } } },
      inputExpressions: { expectedVersion: 'entity.version' } });
    const w = await f.define(linear(update));
    const denied = await f.start(w.workflowId, {}, randomUUID(), starter.actor); await f.drain();
    expect(await f.execution(denied.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'SPA_FIELD_PERMISSION_DENIED', executionUserId: starter.user.id });
    expect((await f.items.get(f.actor, f.type.id, f.item.id)).fieldValues.VALUE).toBe('Initial');
    expect(await db.workflowActionInvocation.count({ where: { executionId: denied.executionId, status: 'SUCCEEDED' } })).toBe(0);
    const allowed = await f.start(w.workflowId); await f.drain();
    expect((await f.execution(allowed.executionId)).status).toBe('COMPLETED');
    expect((await f.items.get(f.actor, f.type.id, f.item.id)).fieldValues.VALUE).toBe('overwritten');
    const noUpdate = await f.member({ 'SPA.ITEM.UPDATE': null });
    await expect(f.actions.validate(noUpdate.actor, w.workflowId, 'SPA.UPDATE_ITEM', { versionId: w.versionId, nodeKey: 'UPDATE', config: { actionCode: 'SPA.UPDATE_ITEM',
      input: { typeId: f.type.id, itemId: f.item.id, changes: {} }, inputExpressions: { expectedVersion: 'entity.version' } } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
  });

  it('HTTP node cannot reach 127.0.0.1 or cloud metadata services', async () => {
    const db = database(), addresses = { 'metadata.google.internal': ['169.254.169.254'], 'rebind.example.com': ['93.184.216.40'] };
    const { f, connections, http } = await partner(db, addresses);
    for (const baseUrl of ['https://127.0.0.1/', 'https://127.1.2.3/', 'https://169.254.169.254/', 'https://[::ffff:127.0.0.1]/', 'https://[fd00::1]/', 'https://metadata.google.internal/', 'https://0.0.0.0/'])
      await expect(connections.create(f.actor, { name: 'Internal', baseUrl, allowedHosts: [new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')] })).rejects.toMatchObject({ code: 'WORKFLOW_HTTP_DESTINATION_BLOCKED' });
    const rebind = await connections.create(f.actor, { name: 'Rebind', baseUrl: 'https://rebind.example.com/', allowedHosts: ['rebind.example.com'], supportsIdempotency: true });
    const w = await f.define(linear(http({ connectionId: rebind.id })));
    addresses['rebind.example.com'] = ['169.254.169.254'];
    const sandbox = sandboxHttps(() => ({ status: 200 }));
    try {
      const run = await f.start(w.workflowId); await f.drain();
      expect(await f.execution(run.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_HTTP_DESTINATION_BLOCKED' });
      expect(sandbox.calls).toHaveLength(0);
    } finally { sandbox.restore(); }
  });

  it('workflow configuration never serializes plaintext integration secret', async () => {
    const db = database(), { f, http } = await partner(db);
    await expect(f.define(linear(http({ body: { apiKey: marker } })))).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
    const w = await f.define(linear(http()));
    const sandbox = sandboxHttps(() => ({ status: 201, body: JSON.stringify({ echoedSecret: marker }) }));
    let run: { executionId: string };
    try { run = await f.start(w.workflowId); await f.drain(); } finally { sandbox.restore(); }
    expect(sandbox.calls[0].headers.authorization).toBe('Bearer ' + marker);
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED' });
    expect((await f.runs(run.executionId, 'CALL'))[0].output).toEqual({ httpStatus: 201, responseBytes: expect.any(Number) });
    const tables = ['workflow_versions', 'workflow_nodes', 'workflow_executions', 'workflow_node_executions', 'workflow_action_invocations', 'workflow_execution_logs',
      'outbox_events', 'audit_logs', 'integration_outbound_connections', 'idempotency_records'];
    for (const table of tables) {
      const [row] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`, marker);
      expect([table, Number(row.count)]).toEqual([table, 0]);
    }
    expect(JSON.stringify(await f.actions.list(f.actor, {}))).not.toContain(marker);
    expect(JSON.stringify(await f.definitions.getVersion(f.actor, w.workflowId, w.versionId))).not.toContain(marker);
  });

  it('unauthorized callback or replay cannot resume node', async () => {
    const db = database(), { f, http } = await partner(db);
    const w = await f.define(linear(http({ waitForCallback: true })));
    const sandbox = sandboxHttps(() => ({ status: 202 })); let run: { executionId: string };
    try { run = await f.start(w.workflowId); await f.drain(); } finally { sandbox.restore(); }
    expect((await f.execution(run.executionId)).status).toBe('WAITING');
    const { token, nonce } = await callbackOf(sandbox.calls[0]), payload = { status: 'DONE' };
    expect(await db.workflowExternalCallback.count({ where: { tokenHash: token } })).toBe(0);
    const [body] = token.split('.');
    await expect(receive(f, body + '.' + 'A'.repeat(43), nonce, payload)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    await expect(receive(f, token, nonce, payload, sign(nonce, { status: 'FORGED' }))).rejects.toMatchObject({ status: 403 });
    await expect(receive(f, token, 'B'.repeat(43), payload)).rejects.toMatchObject({ status: 403 });
    await expect(f.runtime.callbacks.receive(token, { nonce, payload }, null)).rejects.toMatchObject({ status: 403 });
    expect(await f.runtime.callbacks.tick(50)).toMatchObject({ resumed: 0 });
    expect(await receive(f, token, nonce, payload)).toEqual({ accepted: true, duplicate: false });
    expect(await receive(f, token, nonce, payload)).toEqual({ accepted: true, duplicate: true });
    await expect(receive(f, token, nonce, { status: 'CHANGED' })).rejects.toMatchObject({ code: 'WORKFLOW_CALLBACK_REPLAY', status: 409 });
    expect((await f.runtime.callbacks.tick(50)).resumed).toBe(1); expect((await f.runtime.callbacks.tick(50)).resumed).toBe(0); await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
    expect(await f.outbox('WORKFLOW_EXTERNAL_CALLBACK_RECEIVED', run.executionId)).toBe(1);
    // An expired correlation cannot resume even with a valid proof.
    const other = await f.create('Expired'), sandbox2 = sandboxHttps(() => ({ status: 202 })); let late: { executionId: string };
    try { late = await f.start(w.workflowId, {}, randomUUID(), f.actor, other.id); await f.drain(); } finally { sandbox2.restore(); }
    const expired = await callbackOf(sandbox2.calls[0]);
    await db.workflowExternalCallback.updateMany({ where: { executionId: late.executionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(receive(f, expired.token, expired.nonce, payload)).rejects.toMatchObject({ code: 'WORKFLOW_CALLBACK_EXPIRED', status: 410 });
    await f.runtime.callbacks.tick(50);
    expect(await f.execution(late.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_CALLBACK_EXPIRED' });
  });

  it('successful callback resumes correct waiting execution once', async () => {
    const db = database(), { f, http } = await partner(db), second = await f.create('Second');
    const w = await f.define(linear(http({ waitForCallback: true })));
    const sandbox = sandboxHttps(() => ({ status: 202 })); let a: { executionId: string }, b: { executionId: string };
    try { a = await f.start(w.workflowId); b = await f.start(w.workflowId, {}, randomUUID(), f.actor, second.id); await f.drain(); } finally { sandbox.restore(); }
    expect(sandbox.calls).toHaveLength(2);
    const callbacks = await Promise.all(sandbox.calls.map(callbackOf));
    // Each signed correlation names exactly one Workspace+execution+node; select B's credential by its signed claims.
    const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as { executionId: string; workspaceId: string };
    const forB = callbacks.find(c => claims(c.token).executionId === b.executionId)!;
    expect(claims(forB.token).workspaceId).toBe(f.workspace.id);
    const target = await db.workflowExternalCallback.findFirstOrThrow({ where: { executionId: b.executionId } });
    expect(await receive(f, forB.token, forB.nonce, { shipment: 'S-9' })).toEqual({ accepted: true, duplicate: false });
    expect(await db.workflowExternalCallback.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'RECEIVED' });
    await Promise.all([f.runtime.callbacks.tick(50), f.runtime.callbacks.tick(50)]); await f.drain();
    expect((await f.execution(b.executionId)).status).toBe('COMPLETED');
    expect((await f.execution(a.executionId)).status).toBe('WAITING');
    expect((await f.runs(b.executionId, 'CALL'))[0].output).toEqual({ callback: { shipment: 'S-9' } });
    expect(await f.runs(b.executionId, 'END')).toHaveLength(1);
    expect(await db.workflowExternalCallback.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'FULFILLED' });
  });

  it('HTTP provider 429 retries according bounded policy and does not double-write', async () => {
    const db = database(), { f, http } = await partner(db);
    const flaky = await f.define(linear(http({ maxAttempts: 3 })));
    let replies = [429, 200];
    const sandbox = sandboxHttps(() => ({ status: replies.shift() ?? 500 }));
    try {
      const run = await f.start(flaky.workflowId); await f.drain();
      const pending = (await f.runs(run.executionId, 'CALL'))[0];
      expect(pending).toMatchObject({ status: 'QUEUED', errorCode: 'WORKFLOW_NODE_FAILED', attemptCount: 1 });
      expect((await db.workflowExecutionToken.findUniqueOrThrow({ where: { id: pending.tokenId } })).availableAt.getTime()).toBeGreaterThan(Date.now());
      await ready(db, run.executionId); await f.drain();
      expect(sandbox.calls).toHaveLength(2);
      expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED' });
      expect(await db.workflowActionInvocation.findMany({ where: { executionId: run.executionId } })).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
      // Exhausted bounded retries fail the node; non-retryable 4xx never retries.
      sandbox.calls.length = 0; replies = [429, 429, 429, 429];
      const second = await f.create('Exhausted'), exhausted = await f.start(flaky.workflowId, {}, randomUUID(), f.actor, second.id);
      for (let i = 0; i < 5; i++) { await f.drain(); await ready(db, exhausted.executionId); }
      expect(sandbox.calls).toHaveLength(3);
      expect(await f.execution(exhausted.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_NODE_FAILED' });
      sandbox.calls.length = 0; replies = [400];
      const third = await f.create('Rejected'), rejected = await f.start(flaky.workflowId, {}, randomUUID(), f.actor, third.id);
      for (let i = 0; i < 3; i++) { await f.drain(); await ready(db, rejected.executionId); }
      expect(sandbox.calls).toHaveLength(1);
      expect((await f.execution(rejected.executionId)).status).toBe('FAILED');
    } finally { sandbox.restore(); }
  });

  it('same node retry reuses idempotency effect key', async () => {
    const db = database(), { f, http } = await partner(db);
    const w = await f.define(linear(http({ maxAttempts: 1 })));
    let replies = [400, 200];
    const sandbox = sandboxHttps(() => ({ status: replies.shift() ?? 200 }));
    try {
      const run = await f.start(w.workflowId); await f.drain();
      const failed = (await f.runs(run.executionId, 'CALL'))[0];
      expect(await f.execution(run.executionId)).toMatchObject({ status: 'FAILED' });
      expect(await db.workflowActionInvocation.findFirstOrThrow({ where: { nodeRunId: failed.id } })).toMatchObject({ status: 'FAILED', errorCode: 'WORKFLOW_NODE_FAILED' });
      await f.executions.control(f.actor, run.executionId, 'retry', { expectedVersion: (await f.execution(run.executionId)).version, failedNodeRunId: failed.id });
      await f.drain();
      expect(sandbox.calls).toHaveLength(2);
      const keys = sandbox.calls.map(call => call.headers['idempotency-key']);
      expect(keys[0]).toBe('workflow.http:' + failed.id); expect(keys[1]).toBe(keys[0]);
      expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED' });
      expect(await db.workflowActionInvocation.count({ where: { executionId: run.executionId } })).toBe(1);
      expect((await f.runs(run.executionId, 'CALL'))).toEqual([expect.objectContaining({ id: failed.id, status: 'SUCCEEDED', attemptCount: 2 })]);
    } finally { sandbox.restore(); }
    // Domain actions reuse the owning command key: a retried checkpoint creates exactly one SPA Item.
    const create = node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId: f.type.id, item: { title: 'Keyed effect', assignedUserId: f.user.id, fieldValues: {} } } });
    const keyed = await f.define(linear(create)), adapter = f.definitions.actions.get('SPA.CREATE_ITEM'), original = adapter.execute, keysSeen: string[] = [];
    adapter.execute = async context => { keysSeen.push(context.idempotencyKey); const result = await original(context); if (keysSeen.length === 1) throw new Error('lost acknowledgement'); return result; };
    try { const other = await f.create('Keyed'), run = await f.start(keyed.workflowId, {}, randomUUID(), f.actor, other.id); await f.drain(); await ready(db, run.executionId); await f.drain(); }
    finally { adapter.execute = original; }
    expect(keysSeen).toHaveLength(2); expect(keysSeen[1]).toBe(keysSeen[0]);
    expect(await db.spaItem.count({ where: { workspaceId: f.workspace.id, title: 'Keyed effect' } })).toBe(1);
  });
});

export {};
