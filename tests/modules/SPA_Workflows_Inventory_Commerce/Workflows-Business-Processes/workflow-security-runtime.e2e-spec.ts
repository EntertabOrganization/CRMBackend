import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear, node } from '@/tests/support/workflow-graph';
import type { WorkflowFixture } from '@/tests/support/workflow-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
async function waiting(f: WorkflowFixture) {
  const w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 }))), run = await f.start(w.workflowId); await f.drain();
  return { w, run };
}
const contract = workflowHttpContract('truecrm_workflow_security_http_test', {
  'GET /api/v1/workflow-templates': async f => { const w = await f.define(linear()), template = await f.templates.create(f.actor, { name: 'Ops template', category: 'Ops', sourceVersionId: w.versionId });
    return { permission: 'WORKFLOW.TEMPLATE_MANAGE', ids: {}, query: '?category=Ops',
      verify: async data => { expect(data.map((t: { id: string }) => t.id)).toEqual([template.id]); } }; },
  'POST /api/v1/workflow-templates': async (f, db) => { const w = await f.define(linear());
    return { permission: 'WORKFLOW.TEMPLATE_MANAGE', ids: {}, body: { name: 'Captured', category: 'Ops', sourceVersionId: w.versionId },
      verify: async data => { const row = await db.workflowTemplate.findUniqueOrThrow({ where: { id: data.id } });
        expect(row).toMatchObject({ workspaceId: f.workspace.id, status: 'ACTIVE', ownerUserId: f.user.id }); expect(JSON.stringify(row.snapshot)).not.toContain(f.type.id); } }; },
  'POST /api/v1/workflow-templates/:templateId/instantiate': async (f, db) => { const w = await f.define(linear()), template = await f.templates.create(f.actor, { name: 'Base', category: 'Ops', sourceVersionId: w.versionId });
    return { permission: 'WORKFLOW.DESIGN', ids: { templateId: template.id }, body: { name: 'Instantiated', code: 'INSTANTIATED', bindings: { boundEntityTypeId: f.type.id, values: {} } },
      verify: async data => { expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: data.id } })).toMatchObject({ workspaceId: f.workspace.id, code: 'INSTANTIATED', status: 'DRAFT', boundEntityTypeId: f.type.id });
        expect(await db.workflowVersion.count({ where: { definitionId: data.id, status: 'DRAFT' } })).toBe(1); } }; },
  'GET /api/v1/workflow-executions/:executionId/discussion': async f => { const { run } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data).toMatchObject({ provider: 'TIMELINE', sharedDiscussionId: run.executionId }); } }; },
  'GET /api/v1/workflows/admin/health': async f => { await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: {}, query: '?status=WAITING',
      verify: async data => { expect(data).toMatchObject({ executions: { WAITING: 1 }, expiredLeases: 0, failedNodes: 0, uncertainActions: 0 }); expect(data.queueLagSeconds).toBeGreaterThanOrEqual(0); } }; },
  'POST /api/v1/workflows/admin/reconcile': async (f, db) => { const { run } = await waiting(f);
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: {}, body: { executionIds: [run.executionId] },
      verify: async data => { expect(await db.workflowReconciliationJob.findUniqueOrThrow({ where: { id: data.jobId } })).toMatchObject({ status: 'QUEUED', executionIds: [run.executionId], requestedByUserId: f.user.id });
        expect(data.status).toBe('QUEUED'); } }; },
});

describe('Workflow Security, Runtime Policies, Templates and Administration — REST E2E contract', () => {
  it('GET /api/v1/workflow-templates verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-templates'); });
  it('POST /api/v1/workflow-templates verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-templates'); });
  it('POST /api/v1/workflow-templates/:templateId/instantiate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-templates/:templateId/instantiate'); });
  it('GET /api/v1/workflow-executions/:executionId/discussion verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/discussion'); });
  it('GET /api/v1/workflows/admin/health verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/admin/health'); });
  it('POST /api/v1/workflows/admin/reconcile verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/admin/reconcile'); });
});

export {};
