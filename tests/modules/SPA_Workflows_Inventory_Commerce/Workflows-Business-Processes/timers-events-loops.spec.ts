import { randomUUID } from 'node:crypto';
import { workflowDatabase, workflowFixture, linear, node, edge, typed, type WorkflowFixture } from '@/tests/support/workflow-contract';
import { workflowBusinessTime } from '@/src/server/workflows/business-time';
import { WorkflowExecutionService } from '@/src/server/workflows/execution-service';
import { WorkflowWaitWorker } from '@/src/server/workflows/wait-worker';

/** Durable timers, event correlation, joins and bounded loops against an owned migrated database. */
const database = workflowDatabase('truecrm_workflow_timers_test');
const due = (db: ReturnType<typeof database>, where: object) => db.workflowTimer.updateMany({ where, data: { scheduledFor: new Date(Date.now() - 1000) } });
async function touch(f: WorkflowFixture, itemId: string, title: string) {
  const current = await f.items.get(f.actor, f.type.id, itemId);
  await f.items.update(f.actor, f.type.id, itemId, { expectedVersion: current.version, title });
}
const waitFor = (key = 'WAIT') => node(key, 'WAIT_EVENT', { eventType: 'SPA_ITEM_UPDATED', correlationKey: 'entity.id' });

describe('Timers, Events, Parallelism and Loops — unit/integration contract', () => {
  it('same timer tick delivered twice unblocks node once', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define({ ...linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 600 }), node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"after"' })), variables: [typed('NOTE')] });
    const run = await f.start(w.workflowId); await f.drain();
    const timer = await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(timer.resumeKey).toBe('timer:' + timer.nodeRunId);
    await due(db, { id: timer.id });
    const deliveries = await Promise.all([new WorkflowWaitWorker(db, f.runtime).timers(50), new WorkflowWaitWorker(db, f.runtime).timers(50)]);
    expect(deliveries.reduce((sum, d) => sum + d.fired, 0)).toBe(1);
    await f.drain(); await f.waits.timers(50); await f.drain();
    expect(await db.workflowTimer.findUniqueOrThrow({ where: { id: timer.id } })).toMatchObject({ status: 'FIRED' });
    expect(await f.runs(run.executionId, 'MARK')).toHaveLength(1);
    expect(await f.outbox('WORKFLOW_TIMER_FIRED', run.executionId)).toBe(1);
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { NOTE: 'after' } });
  });

  it('unrelated event correlation key does not resume workflow', async () => {
    const db = database(), f = await workflowFixture(db), other = await f.create('Unrelated');
    const w = await f.define(linear(waitFor()));
    const run = await f.start(w.workflowId); await f.drain();
    const wait = await db.workflowEventSubscription.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(wait).toMatchObject({ eventType: 'SPA_ITEM_UPDATED', correlationKey: f.item.id, status: 'PENDING' });
    await touch(f, other.id, 'Other changed'); await f.triggerWorker.events(100); await f.drain();
    expect(await db.workflowEventSubscription.findUniqueOrThrow({ where: { id: wait.id } })).toMatchObject({ status: 'PENDING' });
    expect((await f.execution(run.executionId)).status).toBe('WAITING');
    await touch(f, f.item.id, 'Bound changed'); await f.triggerWorker.events(100); await f.drain();
    const fulfilled = await db.workflowEventSubscription.findUniqueOrThrow({ where: { id: wait.id } });
    const event = await db.outboxEvent.findUniqueOrThrow({ where: { id: fulfilled.fulfilledByEventId! } });
    expect(fulfilled.status).toBe('FULFILLED'); expect(event.entityId).toBe(f.item.id);
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
    expect(await f.outbox('WORKFLOW_WAIT_RESUMED', run.executionId)).toBe(1);
  });

  it('parallel ALL join does not proceed early', async () => {
    const db = database(), f = await workflowFixture(db);
    const start = node('START', 'START'), split = node('SPLIT', 'PARALLEL_SPLIT', { joinNodeKey: 'JOIN' }), end = node('END', 'END');
    const quick = node('QUICK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"quick"' }), slow = node('SLOW', 'TIMER', { type: 'RELATIVE', seconds: 600 });
    const join = node('JOIN', 'PARALLEL_JOIN', { splitNodeKey: 'SPLIT', mode: 'ALL' });
    const w = await f.define({ nodes: [start, split, quick, slow, join, end], variables: [typed('NOTE')],
      edges: [edge(start, split), edge(split, quick), edge(split, slow), edge(quick, join), edge(slow, join), edge(join, end)] });
    const run = await f.start(w.workflowId); await f.drain();
    const group = await db.workflowParallelJoin.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(group).toMatchObject({ joinMode: 'ALL', requiredCount: 2, status: 'PENDING' }); expect(group.completedBranchTokens).toHaveLength(1);
    expect(await f.runs(run.executionId, 'END')).toHaveLength(0);
    expect((await f.execution(run.executionId)).status).toBe('WAITING');
    await due(db, { executionId: run.executionId }); await f.waits.timers(50); await f.drain();
    expect(await db.workflowParallelJoin.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({ status: 'COMPLETED' });
    expect(await f.runs(run.executionId, 'END')).toHaveLength(1);
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
  });

  it('EVENT_RACE winner cancels losing branches', async () => {
    const db = database(), f = await workflowFixture(db);
    const start = node('START', 'START'), race = node('RACE', 'EVENT_RACE', { joinNodeKey: 'JOIN' }), end = node('END', 'END');
    const wait = waitFor(), deadline = node('DEADLINE', 'TIMER', { type: 'RELATIVE', seconds: 3600 }), join = node('JOIN', 'PARALLEL_JOIN', { splitNodeKey: 'RACE', mode: 'ANY' });
    const w = await f.define({ nodes: [start, race, wait, deadline, join, end], edges: [edge(start, race), edge(race, wait), edge(race, deadline), edge(wait, join), edge(deadline, join), edge(join, end)] });
    const run = await f.start(w.workflowId); await f.drain();
    expect((await f.triggers.waits(f.actor, run.executionId))).toMatchObject({ timers: [expect.objectContaining({ status: 'PENDING' })], events: [expect.objectContaining({ eventType: 'SPA_ITEM_UPDATED' })] });
    await touch(f, f.item.id, 'Winner'); await f.triggerWorker.events(100); await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
    const loser = (await f.runs(run.executionId, 'DEADLINE'))[0];
    expect(loser.status).toBe('CANCELLED');
    expect(await db.workflowTimer.findFirstOrThrow({ where: { nodeRunId: loser.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(await f.triggers.waits(f.actor, run.executionId)).toEqual({ timers: [], events: [] });
    await due(db, { executionId: run.executionId }); expect((await f.waits.timers(50)).fired).toBe(0);
    expect(await f.runs(run.executionId, 'END')).toHaveLength(1);
  });

  it('nested FOR_EACH/WHILE stop at safety limit', async () => {
    const db = database(), f = await workflowFixture(db);
    // Outer FOR_EACH over two items; the inner WHILE never exits on its own and must stop at its bound.
    const start = node('START', 'START'), end = node('END', 'END');
    const outer = node('OUTER', 'FOR_EACH', { collection: 'parameters.ITEMS', maxIterations: 5, itemVariable: 'CURRENT', bodyNodeKey: 'INNER', exitNodeKey: 'END' });
    const inner = node('INNER', 'WHILE', { expression: 'true', maxIterations: 2, bodyNodeKey: 'STEP', exitNodeKey: 'OUTER' });
    const step = node('STEP', 'SET_VARIABLE', { variable: 'NOTE', expression: '"step"' });
    const w = await f.define({ nodes: [start, outer, inner, step, end], parameters: [typed('ITEMS', 'JSON_TYPED', { validation: { schema: { type: 'array', items: { type: 'number' } } } })],
      variables: [typed('CURRENT', 'NUMBER'), typed('NOTE')], edges: [edge(start, outer), edge(outer, inner, 'BODY'), edge(outer, end, 'EXIT'), edge(inner, step, 'BODY'), edge(inner, outer, 'EXIT'), edge(step, inner)] });
    const run = await f.start(w.workflowId, { ITEMS: [1, 2] }); await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_LOOP_LIMIT_EXCEEDED' });
    expect(await f.runs(run.executionId, 'STEP')).toHaveLength(2);
    expect((await f.runs(run.executionId, 'INNER')).find(r => r.status === 'FAILED')).toMatchObject({ errorCode: 'WORKFLOW_LOOP_LIMIT_EXCEEDED' });
    expect(await f.runs(run.executionId, 'END')).toHaveLength(0);
    // A collection larger than the declared bound is refused before any body work.
    const bounded = await f.define({ ...linear(node('EACH', 'FOR_EACH', { collection: 'parameters.ITEMS', maxIterations: 2, itemVariable: 'CURRENT', bodyNodeKey: 'END', exitNodeKey: 'END' })),
      parameters: [typed('ITEMS', 'JSON_TYPED', { validation: { schema: { type: 'array', items: { type: 'number' } } } })], variables: [typed('CURRENT', 'NUMBER')] });
    const other = await f.create('Other'), refused = await f.start(bounded.workflowId, { ITEMS: [1, 2, 3] }, randomUUID(), f.actor, other.id); await f.drain();
    expect(await f.execution(refused.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_LOOP_LIMIT_EXCEEDED' });
    // The Workspace node-run ceiling also stops runaway loops.
    await f.triggers.setLimits(f.actor, { maxLoopIterations: 1000, maxNodeRuns: 4, maxDepth: 10, maxLifetimeDays: 365 });
    const third = await f.create('Third'), capped = await f.start(w.workflowId, { ITEMS: [1, 2, 3] }, randomUUID(), f.actor, third.id); await f.drain();
    expect(await f.execution(capped.executionId)).toMatchObject({ status: 'FAILED', resultCode: 'WORKFLOW_RUNTIME_LIMIT_EXCEEDED' });
    expect(await db.workflowNodeExecution.count({ where: { executionId: capped.executionId } })).toBe(4);
  });

  it('runtime configuration refuses exceeding platform ceilings', async () => {
    const db = database(), f = await workflowFixture(db);
    expect(await f.triggers.runtimeLimits(f.actor)).toMatchObject({ maxLoopIterations: 1000, maxNodeRuns: 10000, maxDepth: 10, maxLifetimeDays: 365, retentionDays: 365 });
    const valid = { maxLoopIterations: 20, maxNodeRuns: 500, maxDepth: 3, maxLifetimeDays: 30 };
    for (const excess of [{ maxLoopIterations: 1001 }, { maxNodeRuns: 10001 }, { maxDepth: 11 }, { maxLifetimeDays: 366 }, { maxDepth: 0 }])
      await expect(f.triggers.setLimits(f.actor, { ...valid, ...excess })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
    expect(await db.workflowRuntimePolicy.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    const scoped = await f.member({ 'WORKFLOW.RUNTIME_MANAGE': 'OWN' });
    await expect(f.triggers.setLimits(scoped.actor, valid)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    await f.triggers.setLimits(f.actor, valid);
    expect(await f.triggers.runtimeLimits(f.actor)).toMatchObject({ ...valid, version: 1 });
    expect(await f.outbox('WORKFLOW_RUNTIME_POLICY_CHANGED')).toBe(1);
    const created = await f.definitions.create(f.actor, { name: 'Loop', code: 'LOOP_LIMIT', type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: f.type.id });
    const draft = await f.definitions.newVersion(f.actor, created.id, {});
    const loop = node('LOOP', 'WHILE', { expression: 'false', maxIterations: 50, bodyNodeKey: 'END', exitNodeKey: 'END' });
    const graph = linear(loop);
    const saved = await f.definitions.editGraph(f.actor, created.id, draft.id, 'REPLACE', { expectedVersion: draft.version, ...graph, parameters: [], variables: [], constants: [] }).catch(error => error);
    expect(saved).toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: [expect.objectContaining({ code: 'WORKFLOW_LOOP_LIMIT_EXCEEDED' })] } });
    await db.workspace.update({ where: { id: f.workspace.id }, data: { settings: { entitlements: { workflows: false } } } });
    await expect(f.definitions.create(f.actor, { name: 'Disabled', code: 'DISABLED_PLAN', type: 'SEQUENTIAL', boundEntityType: 'SPA_ITEM', boundEntityTypeId: f.type.id })).rejects.toMatchObject({ code: 'WORKFLOW_PLAN_LIMIT', status: 403 });
  });

  it('suspend relative timer preserves remaining duration across restart', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 1800 })));
    const run = await f.start(w.workflowId); await f.drain();
    const timer = await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } });
    // Simulate 10 minutes elapsed before suspension.
    await db.workflowTimer.update({ where: { id: timer.id }, data: { scheduledFor: new Date(Date.now() + 1200 * 1000) } });
    await f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: (await f.execution(run.executionId)).version, reason: 'Freeze' });
    const paused = await db.workflowTimer.findUniqueOrThrow({ where: { id: timer.id } });
    expect(paused.status).toBe('PAUSED'); expect(paused.remainingSeconds).toBeGreaterThanOrEqual(1195); expect(paused.remainingSeconds).toBeLessThanOrEqual(1200);
    // A restarted process has no in-memory timer state; only the durable remaining duration matters.
    const restarted = new WorkflowExecutionService(db, f.definitions), worker = new WorkflowWaitWorker(db);
    await due(db, { id: timer.id }); expect((await worker.timers(50)).fired).toBe(0);
    const resumedAt = Date.now();
    await restarted.control(f.actor, run.executionId, 'resume', { expectedVersion: (await f.execution(run.executionId)).version });
    const resumed = await db.workflowTimer.findUniqueOrThrow({ where: { id: timer.id } });
    expect(resumed).toMatchObject({ status: 'PENDING', remainingSeconds: null });
    expect(Math.abs(resumed.scheduledFor.getTime() - (resumedAt + paused.remainingSeconds! * 1000))).toBeLessThan(5000);
    expect((await worker.timers(50)).fired).toBe(0);
    await due(db, { id: timer.id }); expect((await worker.timers(50)).fired).toBe(1); await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
  });

  it('DST and business-day waits do not depend on server timezone', async () => {
    const db = database(), f = await workflowFixture(db), now = new Date();
    const weekly = [1, 2, 3, 4, 5].map(dayOfWeek => ({ dayOfWeek, localStartTime: '09:00', localEndTime: '17:00' }));
    await db.businessCalendar.create({ data: { id: randomUUID(), workspaceId: f.workspace.id, timezone: 'America/New_York', weekly, holidays: [], overrides: [], createdAt: now, updatedAt: now } });
    const original = process.env.TZ, results: string[] = [];
    try {
      for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/London']) {
        process.env.TZ = zone;
        results.push(await db.$transaction(async tx => {
          const time = await workflowBusinessTime(tx, f.actor);
          // Friday 2026-03-06 16:00 EST + 2 business hours crosses the 2026-03-08 DST change and the weekend.
          return time.due(new Date('2026-03-06T21:00:00Z'), 7200, new Date('2026-12-31T00:00:00Z')).toISOString();
        }));
      }
    } finally { process.env.TZ = original; }
    expect(new Set(results)).toEqual(new Set(['2026-03-09T14:00:00.000Z']));
    const w = await f.define(linear(node('BUSINESS', 'TIMER', { type: 'WORKDAY_AWARE', seconds: 3600 })));
    const run = await f.start(w.workflowId); await f.drain();
    const timer = await db.workflowTimer.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(timer.type).toBe('WORKDAY_AWARE');
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timer.scheduledFor);
    const part = (type: string) => local.find(p => p.type === type)!.value, minutes = Number(part('hour')) * 60 + Number(part('minute'));
    expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(part('weekday'));
    expect(minutes).toBeGreaterThan(9 * 60); expect(minutes).toBeLessThanOrEqual(17 * 60);
  });
});

export {};
