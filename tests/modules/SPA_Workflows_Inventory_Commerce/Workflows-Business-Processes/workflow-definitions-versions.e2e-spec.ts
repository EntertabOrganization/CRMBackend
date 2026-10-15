import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear } from '@/tests/support/workflow-graph';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
const contract = workflowHttpContract('truecrm_workflow_definitions_http_test', {
  'POST /api/v1/workflows': async (f, db) => ({ permission: 'WORKFLOW.DESIGN', ids: {},
    body: { name: 'HTTP workflow', code: 'HTTP_WORKFLOW', type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: f.type.id },
    verify: async data => { expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: data.id } })).toMatchObject({ workspaceId: f.workspace.id, code: 'HTTP_WORKFLOW', status: 'DRAFT', runAs: 'STARTER' }); } }),
  'GET /api/v1/workflows': async f => { const w = await f.define(linear()); return { permission: 'WORKFLOW.VIEW', ids: {}, query: '?status=ACTIVE&limit=10',
    verify: async (data, json) => { expect(data.map((d: { id: string }) => d.id)).toEqual([w.workflowId]); expect(json.meta).toMatchObject({ page: 1, limit: 10, total: 1 }); } }; },
  'GET /api/v1/workflows/:workflowId': async f => { const w = await f.define(linear()); return { permission: 'WORKFLOW.VIEW', ids: { workflowId: w.workflowId },
    verify: async data => { expect(data).toMatchObject({ id: w.workflowId, status: 'ACTIVE', currentVersion: { id: w.versionId, versionNumber: 1 } }); } }; },
  'PATCH /api/v1/workflows/:workflowId': async (f, db) => { const w = await f.define(linear()), current = await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } });
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: w.workflowId }, body: { expectedVersion: current.version, name: 'Renamed', concurrencyMode: 'ALLOW_PARALLEL' },
      verify: async data => { expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } })).toMatchObject({ name: 'Renamed', concurrencyMode: 'ALLOW_PARALLEL', version: current.version + 1 }); expect(data.version).toBe(current.version + 1); } }; },
  'POST /api/v1/workflows/:workflowId/versions': async (f, db) => { const w = await f.define(linear()); return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: w.workflowId }, body: { baseVersionId: w.versionId },
    verify: async data => { expect(await db.workflowVersion.findUniqueOrThrow({ where: { id: data.id } })).toMatchObject({ definitionId: w.workflowId, versionNumber: 2, status: 'DRAFT' });
      expect(await db.workflowNode.count({ where: { versionId: data.id } })).toBe(2); } }; },
  'GET /api/v1/workflows/:workflowId/versions': async f => { const w = await f.define(linear()); return { permission: 'WORKFLOW.VIEW', ids: { workflowId: w.workflowId },
    verify: async data => { expect(data).toEqual([expect.objectContaining({ id: w.versionId, status: 'PUBLISHED', versionNumber: 1 })]); } }; },
  'GET /api/v1/workflows/:workflowId/versions/:versionId': async f => { const w = await f.define(linear()); return { permission: 'WORKFLOW.VIEW', ids: { workflowId: w.workflowId, versionId: w.versionId },
    verify: async data => { expect(data).toMatchObject({ id: w.versionId, status: 'PUBLISHED', checksum: expect.stringMatching(/^[a-f0-9]{64}$/) }); } }; },
  'POST /api/v1/workflows/:workflowId/versions/:versionId/validate': async (f, db) => { const w = await f.define(linear()); return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: w.workflowId, versionId: w.versionId }, body: {},
    verify: async data => { expect(data).toMatchObject({ valid: true, problems: [] }); expect(await db.outboxEvent.count({ where: { entityId: w.workflowId, eventType: 'WORKFLOW_GRAPH_VALIDATED' } })).toBe(1); } }; },
  'POST /api/v1/workflows/:workflowId/versions/:versionId/publish': async (f, db) => {
    const w = await f.define(linear()), draft = await f.definitions.newVersion(f.actor, w.workflowId, {});
    return { permission: 'WORKFLOW.PUBLISH', ids: { workflowId: w.workflowId, versionId: draft.id }, body: { expectedVersion: draft.version },
      verify: async data => { expect(data).toMatchObject({ id: draft.id, status: 'PUBLISHED' });
        expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } })).toMatchObject({ currentVersionId: draft.id });
        expect(await db.workflowVersion.findUniqueOrThrow({ where: { id: w.versionId } })).toMatchObject({ status: 'SUPERSEDED' });
        expect(await db.outboxEvent.count({ where: { entityId: w.workflowId, eventType: 'WORKFLOW_VERSION_PUBLISHED' } })).toBe(2); } }; },
  'POST /api/v1/workflows/:workflowId/pause': async (f, db) => { const w = await f.define(linear()), current = await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } });
    return { permission: 'WORKFLOW.PUBLISH', ids: { workflowId: w.workflowId }, body: { expectedVersion: current.version },
      verify: async () => { expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } })).toMatchObject({ status: 'PAUSED' });
        await expect(f.start(w.workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_NO_PUBLISHED_VERSION' }); } }; },
  'POST /api/v1/workflows/:workflowId/archive': async (f, db) => { const w = await f.define(linear()), current = await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } });
    return { permission: 'WORKFLOW.PUBLISH', ids: { workflowId: w.workflowId }, body: { expectedVersion: current.version },
      verify: async () => { expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } })).toMatchObject({ status: 'ARCHIVED' });
        expect(await db.outboxEvent.count({ where: { entityId: w.workflowId, eventType: 'WORKFLOW_ARCHIVED' } })).toBe(1); } }; },
});

describe('Workflow Definitions, Versions and Publication — REST E2E contract', () => {
  it('POST /api/v1/workflows verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows'); });
  it('GET /api/v1/workflows verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows'); });
  it('GET /api/v1/workflows/:workflowId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/:workflowId'); });
  it('PATCH /api/v1/workflows/:workflowId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/workflows/:workflowId'); });
  it('POST /api/v1/workflows/:workflowId/versions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/versions'); });
  it('GET /api/v1/workflows/:workflowId/versions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/:workflowId/versions'); });
  it('GET /api/v1/workflows/:workflowId/versions/:versionId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/:workflowId/versions/:versionId'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/validate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/versions/:versionId/validate'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/publish verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/versions/:versionId/publish'); });
  it('POST /api/v1/workflows/:workflowId/pause verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/pause'); });
  it('POST /api/v1/workflows/:workflowId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/archive'); });
});

export {};
