import { randomUUID } from 'node:crypto';
import { workflowDatabase, workflowFixture, linear, node, edge, typed } from '@/tests/support/workflow-contract';
import { spaFixture } from '@/tests/support/spa-fixture';

/** Real WorkflowDefinitionService/ExecutionService against an owned migrated database. */
const database = workflowDatabase('truecrm_workflow_definitions_test');

describe('Workflow Definitions, Versions and Publication — unit/integration contract', () => {
  it('publishing V2 leaves running V1 execution graph unchanged', async () => {
    const db = database(), f = await workflowFixture(db);
    const v1 = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 })));
    const v1Row = await db.workflowVersion.findUniqueOrThrow({ where: { id: v1.versionId } });
    const running = await f.start(v1.workflowId); await f.drain();
    expect((await f.execution(running.executionId)).status).toBe('WAITING');
    const draft = await f.definitions.newVersion(f.actor, v1.workflowId, {});
    const replaced = await f.definitions.editGraph(f.actor, v1.workflowId, draft.id, 'REPLACE', { expectedVersion: draft.version, ...linear(), parameters: [], variables: [], constants: [] });
    await f.definitions.publish(f.actor, v1.workflowId, draft.id, { expectedVersion: replaced.version });
    const pinned = await f.execution(running.executionId);
    expect(pinned.versionId).toBe(v1.versionId);
    expect((pinned.snapshot as { nodes: Array<{ nodeKey: string }> }).nodes.map(n => n.nodeKey)).toContain('HOLD');
    const after = await db.workflowVersion.findUniqueOrThrow({ where: { id: v1.versionId } });
    expect(after).toMatchObject({ status: 'SUPERSEDED', checksum: v1Row.checksum }); expect(after.definition).toEqual(v1Row.definition);
    // Completing V1 still follows its own pinned TIMER node; a new start uses V2.
    await db.workflowTimer.updateMany({ where: { executionId: running.executionId }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    expect((await f.waits.timers(50)).fired).toBeGreaterThanOrEqual(1); await f.drain();
    expect((await f.execution(running.executionId)).status).toBe('COMPLETED');
    expect((await f.runs(running.executionId, 'HOLD'))[0].status).toBe('SUCCEEDED');
    const second = await f.start(v1.workflowId); expect(second.versionId).toBe(draft.id);
  });

  it('cannot modify published graph or parameter schema', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define({ ...linear(), parameters: [typed('AMOUNT', 'NUMBER')] });
    const before = await db.workflowVersion.findUniqueOrThrow({ where: { id: w.versionId } }), events = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
    const graph = await f.definitions.getVersion(f.actor, w.workflowId, w.versionId, true) as unknown as { nodes: Array<{ id: string }>; version: number };
    const attempts = [
      () => f.definitions.editGraph(f.actor, w.workflowId, w.versionId, 'REPLACE', { expectedVersion: graph.version, ...linear(), parameters: [typed('AMOUNT', 'TEXT')], variables: [], constants: [] }),
      () => f.definitions.editGraph(f.actor, w.workflowId, w.versionId, 'ADD_NODE', { nodeKey: 'EXTRA', nodeType: 'END', config: {}, position: { x: 1, y: 1 } }),
      () => f.definitions.editGraph(f.actor, w.workflowId, w.versionId, 'PATCH_NODE', { expectedVersion: graph.version, position: { x: 5, y: 5 } }, graph.nodes[0].id),
      () => f.definitions.editGraph(f.actor, w.workflowId, w.versionId, 'DELETE_NODE', {}, graph.nodes[0].id),
      () => f.definitions.editGraph(f.actor, w.workflowId, w.versionId, 'ADD_EDGE', { fromNodeId: graph.nodes[0].id, toNodeId: graph.nodes[1].id }),
      () => f.definitions.publish(f.actor, w.workflowId, w.versionId, { expectedVersion: graph.version }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'WORKFLOW_PUBLISHED_IMMUTABLE', status: 409 });
    const after = await db.workflowVersion.findUniqueOrThrow({ where: { id: w.versionId } });
    expect(after.definition).toEqual(before.definition); expect(after.checksum).toBe(before.checksum); expect(after.revision).toBe(before.revision);
    expect(await db.workflowNode.count({ where: { versionId: w.versionId } })).toBe(2);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(events);
  });

  it('validator rejects no start/end, dangling edges or unsafe action', async () => {
    const db = database(), f = await workflowFixture(db);
    const created = await f.definitions.create(f.actor, { name: 'Invalid', code: 'INVALID_GRAPH', type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: f.type.id });
    const draft = await f.definitions.newVersion(f.actor, created.id, {});
    const lonely = node('ONLY', 'SET_VARIABLE', { variable: 'NOTE', expression: '"x"' });
    const saved = await f.definitions.editGraph(f.actor, created.id, draft.id, 'REPLACE', { expectedVersion: draft.version, nodes: [lonely], edges: [], parameters: [], variables: [typed('NOTE')], constants: [] });
    const report = await f.definitions.validate(f.actor, created.id, draft.id, {});
    expect(report.valid).toBe(false); expect(report.problems.map(p => p.code)).toContain('WORKFLOW_GRAPH_INVALID');
    await expect(f.definitions.publish(f.actor, created.id, draft.id, { expectedVersion: saved.version })).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', status: 422 });
    const start = node('START', 'START'), end = node('END', 'END');
    const dangling = { ...edge(start, end), toNodeId: randomUUID() };
    await expect(f.definitions.editGraph(f.actor, created.id, draft.id, 'REPLACE', { expectedVersion: saved.version, nodes: [start, end], edges: [dangling], parameters: [], variables: [], constants: [] }))
      .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: expect.arrayContaining([expect.objectContaining({ code: 'WORKFLOW_EDGE_INVALID' })]) } });
    const unsafe = node('RUN', 'ACTION', { actionCode: 'SYSTEM.SHELL_EXEC', input: { command: 'rm -rf /' } });
    await expect(f.definitions.editGraph(f.actor, created.id, draft.id, 'REPLACE', { expectedVersion: saved.version, ...linear(unsafe), parameters: [], variables: [], constants: [] }))
      .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: [expect.objectContaining({ code: 'WORKFLOW_ACTION_NOT_ALLOWED' })] } });
    const secret = node('SEND', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId: f.type.id, item: { title: 'x', assignedUserId: f.user.id, fieldValues: {} }, apiKey: 'raw' } });
    await expect(f.definitions.editGraph(f.actor, created.id, draft.id, 'REPLACE', { expectedVersion: saved.version, ...linear(secret), parameters: [], variables: [], constants: [] }))
      .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
    expect((await db.workflowVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  });

  it('publishing increments definition version and emits once', async () => {
    const db = database(), f = await workflowFixture(db);
    const created = await f.definitions.create(f.actor, { name: 'Publish', code: 'PUBLISH_ONCE', type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: f.type.id });
    const draft = await f.definitions.newVersion(f.actor, created.id, {});
    const saved = await f.definitions.editGraph(f.actor, created.id, draft.id, 'REPLACE', { expectedVersion: draft.version, ...linear(), parameters: [], variables: [], constants: [] });
    const before = (await db.workflowDefinition.findUniqueOrThrow({ where: { id: created.id } })).version;
    const results = await Promise.allSettled([1, 2].map(() => f.definitions.publish(f.actor, created.id, draft.id, { expectedVersion: saved.version })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const definition = await db.workflowDefinition.findUniqueOrThrow({ where: { id: created.id } });
    expect(definition).toMatchObject({ version: before + 1, status: 'ACTIVE', currentVersionId: draft.id });
    expect(await f.outbox('WORKFLOW_VERSION_PUBLISHED', created.id)).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: created.id, action: 'WORKFLOW_VERSION_PUBLISHED' } })).toBe(1);
  });

  it('archived definition rejects new manual/event starts but historical logs remain', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define(linear());
    const triggerVersion = (await f.triggers.get(f.actor, w.workflowId)).version;
    await f.triggers.update(f.actor, w.workflowId, { expectedVersion: triggerVersion, triggers: [{ type: 'MANUAL' }, { type: 'EVENT', config: { eventType: 'SPA_ITEM_UPDATED' } }] });
    const first = await f.start(w.workflowId); await f.drain();
    expect((await f.execution(first.executionId)).status).toBe('COMPLETED');
    const logsBefore = await f.executions.logs(f.actor, first.executionId, {});
    const current = await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } });
    await f.definitions.transition(f.actor, w.workflowId, 'archive', { expectedVersion: current.version });
    await expect(f.start(w.workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_ARCHIVED', status: 409 });
    const item = await f.items.get(f.actor, f.type.id, f.item.id);
    await f.items.update(f.actor, f.type.id, f.item.id, { expectedVersion: item.version, title: 'Changed after archive' });
    await f.triggerWorker.events(100);
    expect(await db.workflowExecution.count({ where: { definitionId: w.workflowId } })).toBe(1);
    expect((await f.executions.logs(f.actor, first.executionId, {})).entries).toEqual(logsBefore.entries);
    expect((await f.definitions.versions(f.actor, w.workflowId, {})).data[0]).toMatchObject({ id: w.versionId, status: 'PUBLISHED' });
    expect(await f.outbox('WORKFLOW_ARCHIVED', w.workflowId)).toBe(1);
  });

  it('service-account change requires permission and central audit', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define(linear());
    const service = await f.member({ 'WORKFLOW.SECURE_RUNAS_MANAGE': null });
    const designer = await f.member({ 'WORKFLOW.SECURE_RUNAS_MANAGE': null });
    const version = (await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } })).version;
    await expect(f.definitions.update(designer.actor, w.workflowId, { expectedVersion: version, runAs: { type: 'SERVICE_ACCOUNT', userId: service.user.id } }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    await expect(f.definitions.update(f.actor, w.workflowId, { expectedVersion: version, runAs: { type: 'SERVICE_ACCOUNT', userId: randomUUID() } })).rejects.toMatchObject({ status: 403 });
    const owner = await db.role.create({ data: { workspaceId: f.workspace.id, name: 'Owner', isOwnerRole: true } });
    const ownerUser = await db.user.create({ data: { firstName: 'Owner', lastName: 'Account', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: ownerUser.id, roleId: owner.id } });
    await expect(f.definitions.update(f.actor, w.workflowId, { expectedVersion: version, runAs: { type: 'SERVICE_ACCOUNT', userId: ownerUser.id } })).rejects.toMatchObject({ code: 'WORKFLOW_RUNAS_DENIED' });
    expect(await db.auditLog.count({ where: { entityId: w.workflowId, action: 'WORKFLOW_RUNAS_CHANGED' } })).toBe(0);
    const updated = await f.definitions.update(f.actor, w.workflowId, { expectedVersion: version, runAs: { type: 'SERVICE_ACCOUNT', userId: service.user.id } });
    expect(updated).toMatchObject({ runAs: 'SERVICE_ACCOUNT', serviceAccountUserId: service.user.id });
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: w.workflowId, action: 'WORKFLOW_RUNAS_CHANGED' } });
    expect(audit.actorUserId).toBe(f.user.id); expect(audit.afterData).toMatchObject({ runAs: 'SERVICE_ACCOUNT', executionUserId: service.user.id });
    const started = await f.start(w.workflowId);
    expect(await f.execution(started.executionId)).toMatchObject({ runAs: 'SERVICE_ACCOUNT', executionUserId: service.user.id, startedByUserId: f.user.id });
  });

  it('cross-workspace bound entity denied', async () => {
    const db = database(), f = await workflowFixture(db), foreign = await spaFixture(db), foreignItem = await foreign.create('Foreign');
    await expect(f.definitions.create(f.actor, { name: 'Foreign', code: 'FOREIGN_BINDING', type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: foreign.type.id }))
      .rejects.toMatchObject({ code: 'WORKFLOW_ENTITY_BINDING_INVALID', status: 422 });
    expect(await db.workflowDefinition.count({ where: { workspaceId: f.workspace.id, code: 'FOREIGN_BINDING' } })).toBe(0);
    const w = await f.define(linear());
    await expect(f.start(w.workflowId, {}, randomUUID(), f.actor, foreignItem.id)).rejects.toMatchObject({ code: 'WORKFLOW_ENTITY_BINDING_INVALID', status: 404 });
    await expect(f.definitions.get(foreign.actor, w.workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND', status: 404 });
    expect(await db.workflowExecution.count({ where: { definitionId: w.workflowId } })).toBe(0);
  });
});

export {};
