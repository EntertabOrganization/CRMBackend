import { randomUUID } from 'node:crypto';
import { workflowDatabase, workflowFixture, linear, node, edge, typed } from '@/tests/support/workflow-contract';

/** Real durable interpreter, leases and recovery against an owned migrated database. */
const database = workflowDatabase('truecrm_workflow_executions_test');
const createItem = (typeId: string, userId: string, title = 'Created by Workflow') =>
  node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId, item: { title, assignedUserId: userId, fieldValues: { VALUE: 'workflow' } } } });

describe('Workflow Executions, Tokens, Dispatch and Recovery — unit/integration contract', () => {
  it('same Idempotency-Key returns one execution across retries', async () => {
    const db = database(), f = await workflowFixture(db), w = await f.define(linear()), key = randomUUID();
    const [a, b] = await Promise.all([f.start(w.workflowId, {}, key), f.start(w.workflowId, {}, key)]);
    expect(a.executionId).toBe(b.executionId);
    const retry = await f.start(w.workflowId, {}, key); expect(retry.executionId).toBe(a.executionId);
    expect(await db.workflowExecution.count({ where: { definitionId: w.workflowId } })).toBe(1);
    expect(await f.outbox('WORKFLOW_STARTED', a.executionId)).toBe(1);
    const other = await f.create('Other');
    await expect(f.start(w.workflowId, {}, key, f.actor, other.id)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    await expect(f.start(w.workflowId, {}, null as unknown as string)).rejects.toMatchObject({ status: 400 });
  });

  it('second default concurrent execution same entity+definition rejected', async () => {
    const db = database(), f = await workflowFixture(db), hold = () => linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 }));
    const w = await f.define(hold());
    expect((await db.workflowDefinition.findUniqueOrThrow({ where: { id: w.workflowId } })).concurrencyMode).toBe('ONE_PER_DEFINITION_PER_ENTITY');
    const first = await f.start(w.workflowId);
    await expect(f.start(w.workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_ALREADY_RUNNING', status: 409 });
    const race = await f.create('Race');
    const racers = await Promise.allSettled([1, 2].map(() => f.start(w.workflowId, {}, randomUUID(), f.actor, race.id)));
    expect(racers.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(racers.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'WORKFLOW_ALREADY_RUNNING', status: 409 } });
    expect(await db.workflowExecution.count({ where: { definitionId: w.workflowId, entityId: race.id } })).toBe(1);
    expect(await db.workflowEntityLock.count({ where: { executionId: first.executionId } })).toBe(1);
    const parallel = await f.define(hold(), { concurrencyMode: 'ALLOW_PARALLEL' });
    await f.start(parallel.workflowId); await f.start(parallel.workflowId);
    expect(await db.workflowExecution.count({ where: { definitionId: parallel.workflowId } })).toBe(2);
    const version = (await f.execution(first.executionId)).version;
    await f.executions.control(f.actor, first.executionId, 'cancel', { expectedVersion: version, reason: 'Done' });
    expect(await db.workflowEntityLock.count({ where: { executionId: first.executionId } })).toBe(0);
    await expect(f.start(w.workflowId)).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('run remains pinned to initial published version across later publish', async () => {
    const db = database(), f = await workflowFixture(db), variables = [typed('NOTE')];
    const v1 = await f.define({ ...linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 600 }), node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"from-v1"' })), variables });
    const run = await f.start(v1.workflowId); await f.drain();
    const draft = await f.definitions.newVersion(f.actor, v1.workflowId, {});
    const saved = await f.definitions.editGraph(f.actor, v1.workflowId, draft.id, 'REPLACE', { expectedVersion: draft.version, parameters: [], constants: [], variables,
      ...linear(node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"from-v2"' })) });
    await f.definitions.publish(f.actor, v1.workflowId, draft.id, { expectedVersion: saved.version });
    await db.workflowTimer.updateMany({ where: { executionId: run.executionId }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await f.waits.timers(50); await f.drain();
    const finished = await f.execution(run.executionId);
    expect(finished).toMatchObject({ status: 'COMPLETED', versionId: v1.versionId, variables: { NOTE: 'from-v1' } });
    const v1Nodes = await db.workflowNode.findMany({ where: { versionId: v1.versionId } });
    for (const row of await f.runs(run.executionId)) expect(v1Nodes.map(n => n.id)).toContain(row.nodeId);
  });

  it('worker crash after checkpoint resumes without duplicate node side effects', async () => {
    const db = database(), f = await workflowFixture(db), w = await f.define(linear(createItem(f.type.id, f.user.id)));
    const count = () => db.spaItem.count({ where: { workspaceId: f.workspace.id, title: 'Created by Workflow' } });
    // 1) A worker claims the activation and dies before dispatch: the lease expires and another worker resumes once.
    const run = await f.start(w.workflowId);
    const claimed = await (f.runtime as unknown as { claim(limit: number): Promise<unknown[]> }).claim(10);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    expect(await f.drain()).toBe(0);
    await db.workflowNodeExecution.updateMany({ where: { executionId: run.executionId, status: 'RUNNING' }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    // 2) The owning effect commits, then the process crashes before commit: the whole checkpoint rolls back.
    const adapter = f.definitions.actions.get('SPA.CREATE_ITEM'), original = adapter.execute; let crashes = 0;
    adapter.execute = async context => { const result = await original(context); if (crashes++ === 0) throw new Error('worker process crashed'); return result; };
    await f.drain();
    expect(crashes).toBe(1); expect(await count()).toBe(0);
    const failedRun = (await f.runs(run.executionId, 'CREATE'))[0];
    expect(failedRun).toMatchObject({ status: 'QUEUED', errorCode: 'WORKFLOW_NODE_FAILED' });
    await db.workflowExecutionToken.updateMany({ where: { executionId: run.executionId, status: 'READY' }, data: { availableAt: new Date() } });
    await f.drain(); adapter.execute = original;
    expect(await count()).toBe(1);
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
    const done = (await f.runs(run.executionId, 'CREATE'))[0];
    expect(done.status).toBe('SUCCEEDED');
    // 3) Duplicate redelivery of the committed activation is ignored.
    await db.workflowExecutionToken.updateMany({ where: { id: done.tokenId }, data: { status: 'READY' } });
    await db.workflowExecution.update({ where: { id: run.executionId }, data: { status: 'RUNNING' } });
    await f.drain();
    expect(await count()).toBe(1);
    expect((await f.runs(run.executionId, 'CREATE'))[0].attemptCount).toBe(done.attemptCount);
    expect(await db.workflowActionInvocation.count({ where: { executionId: run.executionId } })).toBe(1);
  });

  it('parallel join completes only after configured branch condition', async () => {
    const db = database(), f = await workflowFixture(db);
    const start = node('START', 'START'), split = node('SPLIT', 'PARALLEL_SPLIT', { joinNodeKey: 'JOIN' }), end = node('END', 'END');
    const fast = node('FAST', 'SET_VARIABLE', { variable: 'NOTE', expression: '"fast"' });
    const slowA = node('SLOW_A', 'TIMER', { type: 'RELATIVE', seconds: 3600 }), slowB = node('SLOW_B', 'TIMER', { type: 'RELATIVE', seconds: 7200 });
    const join = node('JOIN', 'PARALLEL_JOIN', { splitNodeKey: 'SPLIT', mode: 'QUORUM', requiredCount: 2 });
    const w = await f.define({ nodes: [start, split, fast, slowA, slowB, join, end], variables: [typed('NOTE')],
      edges: [edge(start, split), edge(split, fast), edge(split, slowA), edge(split, slowB), edge(fast, join), edge(slowA, join), edge(slowB, join), edge(join, end)] });
    const run = await f.start(w.workflowId); await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('WAITING');
    expect(await f.runs(run.executionId, 'END')).toHaveLength(0);
    const group = await db.workflowParallelJoin.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(group).toMatchObject({ joinMode: 'QUORUM', requiredCount: 2, status: 'PENDING' }); expect(group.completedBranchTokens).toHaveLength(1);
    const slowRun = (await f.runs(run.executionId, 'SLOW_A'))[0];
    await db.workflowTimer.updateMany({ where: { nodeRunId: slowRun.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await f.waits.timers(50); await f.drain();
    const finished = await f.execution(run.executionId);
    expect(finished.status).toBe('COMPLETED');
    expect(await f.runs(run.executionId, 'END')).toHaveLength(1);
    expect(await db.workflowParallelJoin.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({ status: 'COMPLETED' });
    const loser = (await f.runs(run.executionId, 'SLOW_B'))[0];
    expect(loser.status).toBe('CANCELLED');
    expect(await db.workflowTimer.findFirstOrThrow({ where: { nodeRunId: loser.id } })).toMatchObject({ status: 'CANCELLED' });
  });

  it('stale execution expectedVersion returns conflict', async () => {
    const db = database(), f = await workflowFixture(db), w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 600 })));
    const run = await f.start(w.workflowId); await f.drain();
    const current = await f.execution(run.executionId), events = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
    for (const action of ['suspend', 'cancel', 'terminate'] as const)
      await expect(f.executions.control(f.actor, run.executionId, action, { expectedVersion: current.version - 1, reason: 'Stale' })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT', status: 409 });
    expect(await f.execution(run.executionId)).toMatchObject({ status: current.status, version: current.version });
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(events);
    const results = await Promise.allSettled([1, 2].map(() => f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: current.version, reason: 'Race' })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('suspended execution has no node dispatch and resumes correctly', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define({ ...linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 600 }), node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"resumed"' })), variables: [typed('NOTE')] });
    const run = await f.start(w.workflowId);
    let version = (await f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: 1, reason: 'Hold' })).version;
    await f.drain();
    expect(await f.runs(run.executionId)).toHaveLength(0);
    expect((await f.execution(run.executionId)).status).toBe('SUSPENDED');
    version = (await f.executions.control(f.actor, run.executionId, 'resume', { expectedVersion: version })).version;
    await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('WAITING');
    version = (await f.execution(run.executionId)).version;
    await f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: version, reason: 'Hold timer' });
    const paused = await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(paused.status).toBe('PAUSED'); expect(paused.remainingSeconds).toBeGreaterThan(590); expect(paused.remainingSeconds).toBeLessThanOrEqual(600);
    await db.workflowTimer.update({ where: { id: paused.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    expect((await f.waits.timers(50)).fired).toBe(0);
    await expect(f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: (await f.execution(run.executionId)).version, reason: 'Twice' })).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_STATE' });
    const resumedAt = Date.now();
    await f.executions.control(f.actor, run.executionId, 'resume', { expectedVersion: (await f.execution(run.executionId)).version });
    const resumed = await db.workflowTimer.findUniqueOrThrow({ where: { id: paused.id } });
    expect(resumed.status).toBe('PENDING');
    expect(Math.abs(resumed.scheduledFor.getTime() - (resumedAt + paused.remainingSeconds! * 1000))).toBeLessThan(5000);
    await db.workflowTimer.update({ where: { id: paused.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await f.waits.timers(50); await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { NOTE: 'resumed' } });
  });

  it('unauthorized user cannot inspect sensitive variables or logs', async () => {
    const db = database(), f = await workflowFixture(db);
    const parameters = [typed('OPEN', 'TEXT', { classification: 'PUBLIC' }), typed('DEAL', 'TEXT', { classification: 'BUSINESS' }), typed('SALARY', 'TEXT', { classification: 'SENSITIVE' })];
    const w = await f.define({ ...linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 600 })), parameters });
    const run = await f.start(w.workflowId, { OPEN: 'open-value', DEAL: 'business-value', SALARY: 'sensitive-value' }); await f.drain();
    await db.workflowExecutionLog.create({ data: { workspaceId: f.workspace.id, executionId: run.executionId, level: 'INFO', code: 'BUSINESS_DETAIL', classification: 'BUSINESS', metadata: { detail: 'business-log' } } });
    const viewer = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null });
    const seen = await f.executions.get(viewer.actor, run.executionId);
    expect(seen.parameters).toEqual({ OPEN: 'open-value' });
    expect(JSON.stringify(seen)).not.toMatch(/business-value|sensitive-value/);
    const viewerLogs = await f.executions.logs(viewer.actor, run.executionId, {});
    expect(viewerLogs.entries.map(e => e.code)).not.toContain('BUSINESS_DETAIL');
    expect(JSON.stringify(viewerLogs)).not.toContain('business-log');
    // The execution identity with explicit admin grant may inspect SENSITIVE values; a non-admin starter may not.
    expect((await f.executions.get(f.actor, run.executionId)).parameters).toEqual({ OPEN: 'open-value', DEAL: 'business-value', SALARY: 'sensitive-value' });
    const starterMember = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null }), other = await f.create('Other');
    const own = await f.start(w.workflowId, { OPEN: 'o', DEAL: 'starter-business', SALARY: 'starter-sensitive' }, randomUUID(), starterMember.actor, other.id);
    const starter = await f.executions.get(starterMember.actor, own.executionId);
    expect(starter.parameters).toEqual({ OPEN: 'o', DEAL: 'starter-business' });
    expect(JSON.stringify(starter)).not.toContain('starter-sensitive');
    const blind = await f.member({ 'WORKFLOW.LOG_VIEW': null });
    await expect(f.executions.logs(blind.actor, run.executionId, {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    const scoped = await f.member({ 'WORKFLOW.EXECUTION_VIEW': 'OWN', 'WORKFLOW.LOG_VIEW': 'OWN' });
    await expect(f.executions.get(scoped.actor, run.executionId)).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_NOT_FOUND', status: 404 });
    await expect(f.executions.logs(scoped.actor, run.executionId, {})).rejects.toMatchObject({ status: 404 });
    expect((await f.executions.list(scoped.actor, {})).data).toHaveLength(0);
  });
});

export {};
