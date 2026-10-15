import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear, node } from '@/tests/support/workflow-graph';
import type { WorkflowFixture } from '@/tests/support/workflow-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
async function waiting(f: WorkflowFixture) {
  const w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 })));
  const run = await f.start(w.workflowId); await f.drain();
  return { w, run, version: async () => (await f.execution(run.executionId)).version };
}
const contract = workflowHttpContract('truecrm_workflow_executions_http_test', {
  'POST /api/v1/workflows/:workflowId/start': async (f, db) => { const w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 })));
    return { permission: 'WORKFLOW.START', ids: { workflowId: w.workflowId }, body: { entityType: 'SPA_ITEM', entityId: f.item.id, parameters: {} },
      verify: async data => { expect(data).toMatchObject({ status: 'QUEUED', versionId: w.versionId });
        expect(await db.workflowExecution.findUniqueOrThrow({ where: { id: data.executionId } })).toMatchObject({ workspaceId: f.workspace.id, entityId: f.item.id, startedByUserId: f.user.id });
        expect(await db.outboxEvent.count({ where: { entityId: data.executionId, eventType: 'WORKFLOW_STARTED' } })).toBe(1); } }; },
  'GET /api/v1/workflow-executions': async f => { const { w, run } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: {}, query: '?workflowId=' + w.workflowId + '&status=WAITING',
      verify: async (data, json) => { expect(data.map((e: { id: string }) => e.id)).toEqual([run.executionId]); expect(json.meta.total).toBe(1); } }; },
  'GET /api/v1/workflow-executions/:executionId': async f => { const { w, run } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data).toMatchObject({ id: run.executionId, workflowId: w.workflowId, status: 'WAITING', progress: { COMPLETED: 1, WAITING: 1 } }); } }; },
  'GET /api/v1/workflow-executions/:executionId/nodes': async f => { const { run } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data.map((n: { status: string }) => n.status)).toEqual(['SUCCEEDED', 'WAITING']); } }; },
  'GET /api/v1/workflow-executions/:executionId/logs': async f => { const { run } = await waiting(f);
    return { permission: 'WORKFLOW.LOG_VIEW', ids: { executionId: run.executionId }, query: '?limit=10',
      verify: async data => { expect(data.entries[0]).toMatchObject({ code: 'WORKFLOW_STARTED', level: 'INFO' }); expect(data.nextCursor).toBeNull(); } }; },
  'POST /api/v1/workflow-executions/:executionId/cancel': async (f, db) => { const { run, version } = await waiting(f);
    return { permission: ['WORKFLOW.CANCEL_ALL', 'WORKFLOW.CANCEL_OWN'], ids: { executionId: run.executionId }, body: { expectedVersion: await version(), reason: 'No longer needed' },
      verify: async data => { expect(data.status).toBe('CANCELLED');
        expect(await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } })).toMatchObject({ status: 'CANCELLED' });
        expect(await db.outboxEvent.count({ where: { entityId: run.executionId, eventType: 'WORKFLOW_CANCELLED' } })).toBe(1); } }; },
  'POST /api/v1/workflow-executions/:executionId/suspend': async (f, db) => { const { run, version } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: { executionId: run.executionId }, body: { expectedVersion: await version(), reason: 'Audit hold' },
      verify: async data => { expect(data.status).toBe('SUSPENDED');
        expect(await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } })).toMatchObject({ status: 'PAUSED' }); } }; },
  'POST /api/v1/workflow-executions/:executionId/resume': async (f, db) => { const { run, version } = await waiting(f);
    await f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: await version(), reason: 'Hold' });
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: { executionId: run.executionId }, body: { expectedVersion: await version() },
      verify: async data => { expect(data.status).toBe('RUNNING');
        expect(await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } })).toMatchObject({ status: 'PENDING', remainingSeconds: null }); } }; },
  'POST /api/v1/workflow-executions/:executionId/retry': async (f, db) => {
    const stale = node('UPDATE', 'ACTION', { actionCode: 'SPA.UPDATE_ITEM', input: { typeId: f.type.id, itemId: f.item.id, expectedVersion: 999, changes: { title: 'Never' } } });
    const w = await f.define(linear(stale)), run = await f.start(w.workflowId); await f.drain();
    const failed = (await f.runs(run.executionId, 'UPDATE'))[0];
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'RESOURCE_VERSION_CONFLICT' });
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: { executionId: run.executionId }, body: { expectedVersion: (await f.execution(run.executionId)).version, failedNodeRunId: failed.id },
      verify: async data => { expect(data.status).toBe('RUNNING');
        expect(await db.workflowNodeExecution.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: 'QUEUED', retryBudget: 3 }); } }; },
  'POST /api/v1/workflow-executions/:executionId/terminate': async (f, db) => { const { run, version } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: { executionId: run.executionId }, body: { expectedVersion: await version(), reason: 'Emergency stop' },
      verify: async data => { expect(data.status).toBe('TERMINATED');
        expect(await db.workflowExecutionToken.count({ where: { executionId: run.executionId, status: { in: ['READY', 'RUNNING', 'WAITING'] } } })).toBe(0);
        expect(await db.auditLog.count({ where: { entityId: run.executionId, action: 'WORKFLOW_TERMINATED' } })).toBe(1); } }; },
});

describe('Workflow Executions, Tokens, Dispatch and Recovery — REST E2E contract', () => {
  it('POST /api/v1/workflows/:workflowId/start verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/start'); });
  it('GET /api/v1/workflow-executions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions'); });
  it('GET /api/v1/workflow-executions/:executionId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId'); });
  it('GET /api/v1/workflow-executions/:executionId/nodes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/nodes'); });
  it('GET /api/v1/workflow-executions/:executionId/logs verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/logs'); });
  it('POST /api/v1/workflow-executions/:executionId/cancel verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/cancel'); });
  it('POST /api/v1/workflow-executions/:executionId/suspend verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/suspend'); });
  it('POST /api/v1/workflow-executions/:executionId/resume verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/resume'); });
  it('POST /api/v1/workflow-executions/:executionId/retry verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/retry'); });
  it('POST /api/v1/workflow-executions/:executionId/terminate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/terminate'); });
});

export {};
