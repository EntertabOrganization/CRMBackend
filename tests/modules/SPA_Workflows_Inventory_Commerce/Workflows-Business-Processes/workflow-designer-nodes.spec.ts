import { randomUUID } from 'node:crypto';
import { workflowDatabase, workflowFixture, linear, node, edge, typed, sandboxHttps, sandboxConnections, type WorkflowFixture, type GraphInput } from '@/tests/support/workflow-contract';
import { compileExpression, evaluateExpression } from '@/src/server/workflows/expression';

/** Graph designer validation and dry-run preview against an owned migrated database. */
const database = workflowDatabase('truecrm_workflow_designer_test');
async function draft(f: WorkflowFixture) {
  const created = await f.definitions.create(f.actor, { name: 'Designer', code: 'DESIGN_' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(), type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: f.type.id });
  const version = await f.definitions.newVersion(f.actor, created.id, {});
  const replace = (graph: GraphInput, expectedVersion = version.version) => f.definitions.editGraph(f.actor, created.id, version.id, 'REPLACE', { expectedVersion, parameters: [], variables: [], constants: [], ...graph });
  return { workflowId: created.id, versionId: version.id, revision: version.version, replace };
}

describe('Workflow Designer, Nodes, Variables and Expressions — unit/integration contract', () => {
  it('graph replacement rejects unknown node types and cross-version edges', async () => {
    const db = database(), f = await workflowFixture(db), d = await draft(f);
    const unknown = linear(); unknown.nodes.push(node('SCRIPT', 'EVAL_JAVASCRIPT', { code: 'process.exit()' }));
    await expect(d.replace(unknown)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
    const published = await f.define(linear());
    const foreignNode = await db.workflowNode.findFirstOrThrow({ where: { versionId: published.versionId } });
    const own = linear();
    await expect(d.replace({ ...own, edges: [...own.edges, { ...edge(own.nodes[0], own.nodes[1]), toNodeId: foreignNode.id }] }))
      .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: [expect.objectContaining({ code: 'WORKFLOW_EDGE_INVALID' })] } });
    const stolen = linear(); stolen.nodes[1] = { ...stolen.nodes[1], id: foreignNode.id }; stolen.edges[0] = { ...stolen.edges[0], toNodeId: foreignNode.id };
    await expect(d.replace(stolen)).rejects.toMatchObject({ code: 'WORKFLOW_NODE_INVALID', status: 422 });
    await expect(f.definitions.editGraph(f.actor, d.workflowId, d.versionId, 'ADD_EDGE', { fromNodeId: foreignNode.id, toNodeId: foreignNode.id })).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
    expect(await db.workflowNode.count({ where: { versionId: d.versionId } })).toBe(0);
    expect((await db.workflowVersion.findUniqueOrThrow({ where: { id: d.versionId } })).revision).toBe(d.revision);
  });

  it('arbitrary cycles without bounded loop rejected', async () => {
    const db = database(), f = await workflowFixture(db), d = await draft(f);
    const start = node('START', 'START'), a = node('STEP_A', 'SET_VARIABLE', { variable: 'NOTE', expression: '"a"' }), b = node('CHECK_B', 'CONDITION', { expression: 'variables.NOTE == "done"' }), end = node('END', 'END');
    const saved = await d.replace({ nodes: [start, a, b, end], variables: [typed('NOTE')], edges: [edge(start, a), edge(a, b), edge(b, a, 'FALSE'), edge(b, end, 'TRUE')] });
    const report = await f.definitions.validate(f.actor, d.workflowId, d.versionId, {});
    expect(report.valid).toBe(false); expect(report.problems.map(p => p.code)).toContain('WORKFLOW_GRAPH_CYCLE');
    await expect(f.definitions.publish(f.actor, d.workflowId, d.versionId, { expectedVersion: saved.version })).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
    const loop = node('LOOP', 'WHILE', { expression: 'variables.NOTE != "done"', maxIterations: 5, bodyNodeKey: 'STEP_A', exitNodeKey: 'END' });
    const bounded = await d.replace({ nodes: [start, loop, a, end], variables: [typed('NOTE')], edges: [edge(start, loop), edge(loop, a, 'BODY'), edge(loop, end, 'EXIT'), edge(a, loop)] }, saved.version);
    expect((await f.definitions.validate(f.actor, d.workflowId, d.versionId, {})).valid).toBe(true);
    await expect(f.definitions.publish(f.actor, d.workflowId, d.versionId, { expectedVersion: bounded.version })).resolves.toMatchObject({ status: 'PUBLISHED' });
  });

  it('expression cannot execute arbitrary code, SQL or filesystem access', async () => {
    const db = database(), f = await workflowFixture(db), d = await draft(f);
    const attacks = ["require('fs').readFileSync('/etc/passwd')", 'process.exit(1)', 'constructor.constructor("return this")()', 'entity.__proto__.polluted',
      'eval("1+1")', 'SELECT * FROM users', 'variables["x"]', '`${process.env}`', 'new Function("return 1")', 'globalThis', 'entity.constructor', 'a; DROP TABLE users'];
    for (const source of attacks) {
      expect(() => compileExpression(source)).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNSAFE_EXPRESSION' }));
      await expect(d.replace({ ...linear(node('SET', 'SET_VARIABLE', { variable: 'NOTE', expression: source })), variables: [typed('NOTE')] }))
        .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: [expect.objectContaining({ code: 'WORKFLOW_UNSAFE_EXPRESSION' })] } });
    }
    expect(evaluateExpression(compileExpression('length(parameters.NAME) + 2 >= 5 && contains(parameters.NAME, "bc")'), { parameters: { NAME: 'abc' } })).toBe(true);
    expect(evaluateExpression(compileExpression('addDays("2026-01-30", 3)'), {})).toBe('2026-02-02T00:00:00.000Z');
    expect(evaluateExpression(compileExpression('entity.toString'), { entity: {} })).toBeNull();
    expect(() => evaluateExpression(compileExpression('1 / 0'), {})).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNSAFE_EXPRESSION' }));
    expect(await db.workflowNode.count({ where: { versionId: d.versionId } })).toBe(0);
  });

  it('HTTP_REQUEST rejects loopback/private/metadata address and redirect bypass', async () => {
    const db = database(), addresses: Record<string, string[]> = { 'partner.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.5'] };
    const connections = sandboxConnections(db, addresses), f = await workflowFixture(db, { connections });
    for (const baseUrl of ['https://127.0.0.1/', 'https://169.254.169.254/latest/', 'https://[::1]/', 'https://10.1.2.3/', 'http://partner.example.com/', 'https://internal.example.com/', 'https://localhost/'])
      await expect(connections.create(f.actor, { name: 'Blocked', baseUrl, allowedHosts: [new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')] })).rejects.toMatchObject({ code: 'WORKFLOW_HTTP_DESTINATION_BLOCKED' });
    const connection = await connections.create(f.actor, { name: 'Partner', baseUrl: 'https://partner.example.com/', allowedHosts: ['partner.example.com'], supportsIdempotency: true });
    const httpNode = (path = '/hooks') => node('CALL', 'HTTP_REQUEST', { connectionId: connection.id, path, method: 'POST', body: { ping: true }, maxAttempts: 1 });
    const d = await draft(f);
    for (const path of ['//169.254.169.254/x', '/\\evil', 'https://evil.example.com/'])
      await expect(d.replace(linear(httpNode(path)))).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
    // Redirect bypass: the provider redirects to the metadata service; the second hop is never requested.
    const w = await f.define(linear(httpNode()));
    const sandbox = sandboxHttps(call => call.url.hostname === 'partner.example.com' ? { status: 302, location: 'https://169.254.169.254/latest/meta-data/' } : { status: 200 });
    try {
      const run = await f.start(w.workflowId); await f.drain();
      expect(sandbox.calls.map(c => c.url.hostname)).toEqual(['partner.example.com']);
      expect(await f.execution(run.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_HTTP_DESTINATION_BLOCKED' });
      // DNS rebinding: the allowlisted host later resolves to a private address and is refused before connecting.
      addresses['partner.example.com'] = ['127.0.0.1'];
      const other = await f.create('Rebinding'), rebound = await f.start(w.workflowId, {}, randomUUID(), f.actor, other.id); await f.drain();
      expect(await f.execution(rebound.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_HTTP_DESTINATION_BLOCKED' });
      expect(sandbox.calls).toHaveLength(1);
    } finally { sandbox.restore(); }
  });

  it('publish validator rejects no START or dead-end branch', async () => {
    const db = database(), f = await workflowFixture(db), d = await draft(f);
    const end = node('END', 'END'), lonely = node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"x"' });
    let saved = await d.replace({ nodes: [lonely, end], edges: [edge(lonely, end)], variables: [typed('NOTE')] });
    expect((await f.definitions.validate(f.actor, d.workflowId, d.versionId, {})).problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'WORKFLOW_GRAPH_INVALID', message: expect.stringContaining('START') })]));
    const start = node('START', 'START'), check = node('CHECK', 'CONDITION', { expression: 'true' }), dead = node('DEAD', 'SET_VARIABLE', { variable: 'NOTE', expression: '"dead"' });
    saved = await d.replace({ nodes: [start, check, dead, end], variables: [typed('NOTE')], edges: [edge(start, check), edge(check, end, 'TRUE'), edge(check, dead, 'FALSE')] }, saved.version);
    const report = await f.definitions.validate(f.actor, d.workflowId, d.versionId, {});
    expect(report.valid).toBe(false);
    expect(report.problems).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: dead.id, message: 'Nonterminal branch has no successor.' })]));
    await expect(f.definitions.publish(f.actor, d.workflowId, d.versionId, { expectedVersion: saved.version })).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', status: 422 });
    saved = await d.replace({ nodes: [start, check, end], edges: [edge(start, check), edge(check, end, 'TRUE')] }, saved.version);
    expect((await f.definitions.validate(f.actor, d.workflowId, d.versionId, {})).problems).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Condition requires TRUE and FALSE branches.' })]));
    expect(await f.outbox('WORKFLOW_GRAPH_VALIDATED', d.workflowId)).toBe(3);
    expect((await db.workflowVersion.findUniqueOrThrow({ where: { id: d.versionId } })).status).toBe('DRAFT');
  });

  it('preview mode never sends notifications/HTTP or writes business records', async () => {
    const db = database(), connections = sandboxConnections(db, { 'partner.example.com': ['93.184.216.34'] }), f = await workflowFixture(db, { connections });
    const connection = await connections.create(f.actor, { name: 'Partner', baseUrl: 'https://partner.example.com/', allowedHosts: ['partner.example.com'], supportsIdempotency: true });
    const d = await draft(f), start = node('START', 'START'), end = node('END', 'END');
    const check = node('CHECK', 'CONDITION', { expression: 'parameters.AMOUNT > 100' }), mark = node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: 'entity.title' });
    const create = node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId: f.type.id, item: { title: 'Preview', assignedUserId: f.user.id, fieldValues: {} } } });
    const call = node('CALL', 'HTTP_REQUEST', { connectionId: connection.id, path: '/notify', body: { message: 'hello' } });
    await d.replace({ nodes: [start, check, mark, create, call, end], parameters: [typed('AMOUNT', 'NUMBER')], variables: [typed('NOTE')],
      edges: [edge(start, check), edge(check, mark, 'TRUE'), edge(check, end, 'FALSE'), edge(mark, create), edge(create, call), edge(call, end)] });
    const counts = async () => ({ items: await db.spaItem.count({ where: { workspaceId: f.workspace.id } }), outbox: await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } }),
      audit: await db.auditLog.count({ where: { workspaceId: f.workspace.id } }), notifications: await db.userNotification.count({ where: { workspaceId: f.workspace.id } }),
      executions: await db.workflowExecution.count({ where: { workspaceId: f.workspace.id } }), invocations: await db.workflowActionInvocation.count({ where: { workspaceId: f.workspace.id } }) });
    const before = await counts(), sandbox = sandboxHttps(() => ({ status: 200 }));
    try {
      const preview = await f.definitions.preview(f.actor, d.workflowId, d.versionId, { testParameters: { AMOUNT: 250 }, testContext: { entity: { title: 'Sample' } } });
      expect(preview).toEqual({ dryRun: true, results: [{ nodeId: check.id, result: true }, { nodeId: mark.id, result: 'Sample' }] });
      await expect(f.definitions.preview(f.actor, d.workflowId, d.versionId, { testParameters: { UNKNOWN: 1 }, testContext: {} })).rejects.toMatchObject({ code: 'WORKFLOW_PARAMETER_INVALID' });
      expect(sandbox.calls).toHaveLength(0);
    } finally { sandbox.restore(); }
    expect(await counts()).toEqual(before);
  });

  it('immutable published version graph cannot change', async () => {
    const db = database(), f = await workflowFixture(db), w = await f.define({ ...linear(node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"v1"' })), variables: [typed('NOTE')] });
    const nodes = await db.workflowNode.findMany({ where: { versionId: w.versionId }, orderBy: { nodeKey: 'asc' } });
    const clone = await f.definitions.newVersion(f.actor, w.workflowId, { baseVersionId: w.versionId });
    const cloned = await f.definitions.getVersion(f.actor, w.workflowId, clone.id, true) as unknown as { nodes: Array<{ id: string; nodeKey: string }> };
    expect(cloned.nodes.map(n => n.id).filter(id => nodes.some(original => original.id === id))).toEqual([]);
    const mark = cloned.nodes.find(n => n.nodeKey === 'MARK')!;
    const edited = await f.definitions.editGraph(f.actor, w.workflowId, clone.id, 'PATCH_NODE', { expectedVersion: clone.version, config: { variable: 'NOTE', expression: '"v2"' } }, mark.id);
    expect(edited.nodes.find(n => n.nodeKey === 'MARK')!.config).toEqual({ variable: 'NOTE', expression: '"v2"' });
    await expect(f.definitions.editGraph(f.actor, w.workflowId, w.versionId, 'PATCH_NODE', { expectedVersion: 1, config: { variable: 'NOTE', expression: '"tampered"' } }, nodes[0].id))
      .rejects.toMatchObject({ code: 'WORKFLOW_PUBLISHED_IMMUTABLE', status: 409 });
    expect(await db.workflowNode.findMany({ where: { versionId: w.versionId }, orderBy: { nodeKey: 'asc' } })).toEqual(nodes);
    const published = await f.definitions.getVersion(f.actor, w.workflowId, w.versionId, true) as unknown as { nodes: Array<{ nodeKey: string; config: Record<string, unknown> }> };
    expect(published.nodes.find(n => n.nodeKey === 'MARK')!.config).toEqual({ variable: 'NOTE', expression: '"v1"' });
  });
});

export {};
