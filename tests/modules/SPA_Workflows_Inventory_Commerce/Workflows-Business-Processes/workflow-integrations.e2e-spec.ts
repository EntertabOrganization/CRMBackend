import { createHmac } from 'node:crypto';
import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear, node } from '@/tests/support/workflow-graph';
import { canonical } from '@/src/server/process-platform/dto';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
const previous = { key: process.env.WORKFLOW_CALLBACK_SIGNING_KEY, origin: process.env.APP_PUBLIC_BASE_URL };
beforeAll(() => { process.env.WORKFLOW_CALLBACK_SIGNING_KEY = 'workflow-callback-http-signing-key-0123456789abcdef'; process.env.APP_PUBLIC_BASE_URL = 'https://crm.example.com'; });
afterAll(() => { process.env.WORKFLOW_CALLBACK_SIGNING_KEY = previous.key; process.env.APP_PUBLIC_BASE_URL = previous.origin; });
const createNode = (typeId: string, userId: string) => node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId, item: { title: 'Integrated', assignedUserId: userId, fieldValues: {} } } });

const contract = workflowHttpContract('truecrm_workflow_integrations_http_test', {
  'GET /api/v1/workflows/actions': async () => ({ permission: 'WORKFLOW.DESIGN', ids: {}, query: '?domain=INVENTORY',
    verify: async data => { expect(data.map((a: { actionCode: string }) => a.actionCode).sort()).toEqual(['INVENTORY.RELEASE_RESERVATION', 'INVENTORY.RESERVE']);
      expect(data.find((a: { actionCode: string }) => a.actionCode === 'INVENTORY.RESERVE')).toMatchObject({ requiredPermission: 'INVENTORY.RESERVATION_CREATE', sideEffectClass: 'TRANSACTIONAL', inverseActionCode: 'INVENTORY.RELEASE_RESERVATION' }); } }),
  'POST /api/v1/workflows/:workflowId/actions/:actionCode/validate': async (f, db) => { const create = createNode(f.type.id, f.user.id), w = await f.define(linear(create));
    const items = await db.spaItem.count({ where: { workspaceId: f.workspace.id } });
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: w.workflowId, actionCode: 'SPA.CREATE_ITEM' }, body: { versionId: w.versionId, nodeKey: 'CREATE', config: create.config }, effects: false,
      verify: async data => { expect(data).toEqual({ valid: true, actionCode: 'SPA.CREATE_ITEM', nodeKey: 'CREATE', requiresRuntimeValidation: false });
        expect(await db.spaItem.count({ where: { workspaceId: f.workspace.id } })).toBe(items); } }; },
  'POST /api/v1/workflows/callbacks/:token': { public: true, run: async (call, f, db) => {
    const w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 }))), run = await f.start(w.workflowId); await f.drain();
    const wait = (await f.runs(run.executionId, 'HOLD'))[0];
    const issued = await db.$transaction(tx => f.runtime.callbacks.issue(tx, f.actor, run.executionId, wait.id));
    const token = issued.url.split('/').pop()!, payload = { result: 'accepted' };
    const sign = (body: Record<string, unknown>) => createHmac('sha256', issued.nonce).update(canonical({ nonce: issued.nonce, payload: body })).digest('base64url');
    const path = '/api/v1/workflows/callbacks/';
    expect((await call(path + token.split('.')[0] + '.' + 'A'.repeat(43), { nonce: issued.nonce, payload }, { 'x-workflow-signature': sign(payload) })).status).toBe(403);
    expect((await call(path + token, { nonce: issued.nonce, payload })).status).toBe(403);
    expect((await call(path + token, { nonce: issued.nonce, payload, workspaceId: f.workspace.id }, { 'x-workflow-signature': sign(payload) })).status).toBe(400);
    expect(await db.outboxEvent.count({ where: { entityId: run.executionId, eventType: 'WORKFLOW_EXTERNAL_CALLBACK_RECEIVED' } })).toBe(0);
    const accepted = await call(path + token, { nonce: issued.nonce, payload }, { 'x-workflow-signature': sign(payload) });
    expect(accepted).toMatchObject({ status: 202, json: { success: true, data: { accepted: true, duplicate: false } } });
    expect((await call(path + token, { nonce: issued.nonce, payload }, { 'x-workflow-signature': sign(payload) })).json.data).toEqual({ accepted: true, duplicate: true });
    const changed = { result: 'changed' };
    expect(await call(path + token, { nonce: issued.nonce, payload: changed }, { 'x-workflow-signature': sign(changed) })).toMatchObject({ status: 409, json: { error: { code: 'WORKFLOW_CALLBACK_REPLAY' } } });
    expect(await db.outboxEvent.count({ where: { entityId: run.executionId, eventType: 'WORKFLOW_EXTERNAL_CALLBACK_RECEIVED' } })).toBe(1);
    expect((await f.runtime.callbacks.tick(50)).resumed).toBe(1); await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
  } },
  'GET /api/v1/workflow-executions/:executionId/actions': async f => { const w = await f.define(linear(createNode(f.type.id, f.user.id))), run = await f.start(w.workflowId); await f.drain();
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data).toEqual([expect.objectContaining({ actionCode: 'SPA.CREATE_ITEM', status: 'SUCCEEDED', errorCode: null })]);
        expect(JSON.stringify(data)).not.toContain('Integrated'); } }; },
});

describe('Workflow Action Registry, HTTP and Domain Integrations — REST E2E contract', () => {
  it('GET /api/v1/workflows/actions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/actions'); });
  it('POST /api/v1/workflows/:workflowId/actions/:actionCode/validate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/actions/:actionCode/validate'); });
  it('POST /api/v1/workflows/callbacks/:token verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/callbacks/:token'); });
  it('GET /api/v1/workflow-executions/:executionId/actions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/actions'); });
});

export {};
