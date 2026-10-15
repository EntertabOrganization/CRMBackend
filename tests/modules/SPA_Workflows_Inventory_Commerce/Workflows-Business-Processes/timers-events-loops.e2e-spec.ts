import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear, node } from '@/tests/support/workflow-graph';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
const contract = workflowHttpContract('truecrm_workflow_timers_http_test', {
  'GET /api/v1/workflows/:workflowId/triggers': async f => { const w = await f.define(linear());
    const version = (await f.triggers.get(f.actor, w.workflowId)).version;
    await f.triggers.update(f.actor, w.workflowId, { expectedVersion: version, triggers: [{ type: 'MANUAL' }, { type: 'EVENT', priority: 5, config: { eventType: 'SPA_ITEM_UPDATED' } }] });
    return { permission: 'WORKFLOW.VIEW', ids: { workflowId: w.workflowId },
      verify: async data => { expect(data.version).toBe(version + 1); expect(data.triggers.map((t: { type: string }) => t.type)).toEqual(['MANUAL', 'EVENT']); } }; },
  'PUT /api/v1/workflows/:workflowId/triggers': async (f, db) => { const w = await f.define(linear()), version = (await f.triggers.get(f.actor, w.workflowId)).version;
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: w.workflowId },
      body: { expectedVersion: version, triggers: [{ type: 'MANUAL', enabled: false }, { type: 'SCHEDULE', config: { rrule: 'FREQ=DAILY', timeZone: 'Africa/Cairo', startsAt: '2035-01-01T08:00:00+02:00', entityId: f.item.id } }] },
      verify: async data => { expect(data.version).toBe(version + 1);
        const rows = await db.workflowTrigger.findMany({ where: { definitionId: w.workflowId }, orderBy: { type: 'asc' } });
        expect(rows).toEqual([expect.objectContaining({ type: 'MANUAL', enabled: false }), expect.objectContaining({ type: 'SCHEDULE', nextScheduledAt: new Date('2035-01-01T06:00:00Z') })]);
        expect(await db.auditLog.count({ where: { entityId: w.workflowId, action: 'WORKFLOW_TRIGGERS_CHANGED' } })).toBe(1);
        await expect(f.start(w.workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_STATE' }); } }; },
  'GET /api/v1/workflow-executions/:executionId/waits': async f => { const w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 })));
    const run = await f.start(w.workflowId); await f.drain();
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data.timers).toEqual([expect.objectContaining({ type: 'RELATIVE', status: 'PENDING' })]); expect(data.events).toEqual([]); } }; },
  'GET /api/v1/workflows/runtime-limits': async () => ({ permission: 'WORKFLOW.RUNTIME_MANAGE', ids: {},
    verify: async data => { expect(data).toEqual({ maxLoopIterations: 1000, maxNodeRuns: 10000, maxDepth: 10, maxLifetimeDays: 365, maxConcurrentExecutions: 100, retentionDays: 365, version: 0 }); } }),
  'PUT /api/v1/workflows/runtime-limits': async (f, db) => ({ permission: 'WORKFLOW.RUNTIME_MANAGE', ids: {}, body: { maxLoopIterations: 50, maxNodeRuns: 500, maxDepth: 4, maxLifetimeDays: 30, retentionDays: 90 },
    verify: async () => { expect(await db.workflowRuntimePolicy.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).toMatchObject({ maxLoopIterations: 50, maxNodeRuns: 500, maxDepth: 4, maxLifetimeDays: 30, retentionDays: 90 });
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'WORKFLOW_RETENTION_CHANGED' } })).toBe(1); } }),
});

describe('Timers, Events, Parallelism and Loops — REST E2E contract', () => {
  it('GET /api/v1/workflows/:workflowId/triggers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/:workflowId/triggers'); });
  it('PUT /api/v1/workflows/:workflowId/triggers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/workflows/:workflowId/triggers'); });
  it('GET /api/v1/workflow-executions/:executionId/waits verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/waits'); });
  it('GET /api/v1/workflows/runtime-limits verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/runtime-limits'); });
  it('PUT /api/v1/workflows/runtime-limits verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/workflows/runtime-limits'); });
});

export {};
