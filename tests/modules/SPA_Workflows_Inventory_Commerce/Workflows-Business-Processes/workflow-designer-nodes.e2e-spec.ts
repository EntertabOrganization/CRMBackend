import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear, node, edge, typed } from '@/tests/support/workflow-graph';
import type { WorkflowFixture } from '@/tests/support/workflow-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
async function draft(f: WorkflowFixture) {
  const w = await f.define(linear()), version = await f.definitions.newVersion(f.actor, w.workflowId, {});
  const graph = await f.definitions.getVersion(f.actor, w.workflowId, version.id, true) as unknown as { nodes: Array<{ id: string; nodeKey: string }> };
  return { w, version, start: graph.nodes.find(n => n.nodeKey === 'START')!, end: graph.nodes.find(n => n.nodeKey === 'END')! };
}
const contract = workflowHttpContract('truecrm_workflow_designer_http_test', {
  'GET /api/v1/workflows/:workflowId/versions/:versionId/graph': async f => { const w = await f.define(linear()); return { permission: 'WORKFLOW.VIEW', ids: { workflowId: w.workflowId, versionId: w.versionId },
    verify: async data => { expect(data.nodes.map((n: { nodeKey: string }) => n.nodeKey).sort()).toEqual(['END', 'START']); expect(data.edges).toHaveLength(1); expect(data.parameters).toEqual([]); } }; },
  'PUT /api/v1/workflows/:workflowId/versions/:versionId/graph': async (f, db) => { const d = await draft(f), graph = linear(node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"x"' }));
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: d.w.workflowId, versionId: d.version.id }, body: { expectedVersion: d.version.version, ...graph, parameters: [], variables: [typed('NOTE')], constants: [] },
      verify: async data => { expect(data.version).toBe(d.version.version + 1);
        expect((await db.workflowNode.findMany({ where: { versionId: d.version.id } })).map(n => n.nodeKey).sort()).toEqual(['END', 'MARK', 'START']);
        expect(await db.outboxEvent.count({ where: { entityId: d.w.workflowId, eventType: 'WORKFLOW_DRAFT_GRAPH_UPDATED', payload: { path: ['versionId'], equals: d.version.id } } })).toBe(1); } }; },
  'POST /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes': async (f, db) => { const d = await draft(f);
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: d.w.workflowId, versionId: d.version.id }, body: { nodeKey: 'SECOND_END', nodeType: 'END', config: {}, position: { x: 5, y: 5 } },
      verify: async () => { expect(await db.workflowNode.findFirstOrThrow({ where: { versionId: d.version.id, nodeKey: 'SECOND_END' } })).toMatchObject({ type: 'END', positionX: 5 }); } }; },
  'PATCH /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId': async (f, db) => { const d = await draft(f);
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: d.w.workflowId, versionId: d.version.id, nodeId: d.start.id }, body: { expectedVersion: d.version.version, position: { x: 9, y: -3 } },
      verify: async () => { expect(await db.workflowNode.findUniqueOrThrow({ where: { id: d.start.id } })).toMatchObject({ positionX: 9, positionY: -3 }); } }; },
  'DELETE /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId': async (f, db) => { const d = await draft(f);
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: d.w.workflowId, versionId: d.version.id, nodeId: d.end.id }, body: {},
      verify: async () => { expect(await db.workflowNode.count({ where: { id: d.end.id } })).toBe(0); expect(await db.workflowEdge.count({ where: { versionId: d.version.id } })).toBe(0);
        expect(await db.workflowNode.count({ where: { versionId: d.w.versionId } })).toBe(2); } }; },
  'POST /api/v1/workflows/:workflowId/versions/:versionId/graph/edges': async (f, db) => { const d = await draft(f);
    const extra = await f.definitions.editGraph(f.actor, d.w.workflowId, d.version.id, 'ADD_NODE', { nodeKey: 'OTHER_END', nodeType: 'END', config: {}, position: { x: 1, y: 1 } });
    const target = extra.nodes.find(n => n.nodeKey === 'OTHER_END')!;
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: d.w.workflowId, versionId: d.version.id }, body: { fromNodeId: d.start.id, toNodeId: target.id, edgeType: 'NEXT' },
      verify: async () => { expect(await db.workflowEdge.count({ where: { versionId: d.version.id, fromNodeId: d.start.id, toNodeId: target.id } })).toBe(1); } }; },
  'POST /api/v1/workflows/:workflowId/versions/:versionId/graph/preview': async (f, db) => {
    const start = node('START', 'START'), check = node('CHECK', 'CONDITION', { expression: 'parameters.AMOUNT > 10' }), end = node('END', 'END');
    const w = await f.define({ nodes: [start, check, end], edges: [edge(start, check), edge(check, end, 'TRUE'), edge(check, end, 'FALSE')], parameters: [typed('AMOUNT', 'NUMBER')] });
    const executions = await db.workflowExecution.count({ where: { workspaceId: f.workspace.id } });
    return { permission: 'WORKFLOW.DESIGN', ids: { workflowId: w.workflowId, versionId: w.versionId }, body: { testParameters: { AMOUNT: 25 }, testContext: { entity: {} } }, effects: false,
      verify: async data => { expect(data).toMatchObject({ dryRun: true, results: [expect.objectContaining({ result: true })] });
        expect(await db.workflowExecution.count({ where: { workspaceId: f.workspace.id } })).toBe(executions); } }; },
});

describe('Workflow Designer, Nodes, Variables and Expressions — REST E2E contract', () => {
  it('GET /api/v1/workflows/:workflowId/versions/:versionId/graph verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflows/:workflowId/versions/:versionId/graph'); });
  it('PUT /api/v1/workflows/:workflowId/versions/:versionId/graph verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/workflows/:workflowId/versions/:versionId/graph'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes'); });
  it('PATCH /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId'); });
  it('DELETE /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('DELETE /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/edges verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/edges'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/preview verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/preview'); });
});

export {};
