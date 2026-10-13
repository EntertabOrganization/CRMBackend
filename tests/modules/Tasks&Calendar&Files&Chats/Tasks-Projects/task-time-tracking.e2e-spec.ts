import { randomUUID } from 'node:crypto';
import { ALL_TASK_PERMISSIONS, MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);
let owner: Session, worker: Session, peer: Session, reader: Session, outsider: Session;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('time-owner');
  worker = await member(owner, 'time-worker', [...ALL_TASK_PERMISSIONS, ['task.time_delete', 'OWN']]);
  peer = await member(owner, 'time-peer', [['task.read', 'WORKSPACE'], ['task.time_edit_own', 'WORKSPACE'], ['task.time_delete', 'WORKSPACE']]);
  reader = await member(owner, 'time-reader', [['task.read', 'WORKSPACE']]);
  outsider = await register('time-outsider');
});
afterAll(disconnect);
async function tracked() {
  return expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Tracked', responsibleUserId: worker.userId, isTimeTrackingEnabled: true, plannedDurationSeconds: 7200 } }));
}
async function manual(taskId: string) {
  return expectOk(await call(worker, 'POST', `tasks/${taskId}/time-entries`, { body: { startedAt: ago(60), durationSeconds: 600, note: 'Work' } }));
}

describe('Task Time Tracking HTTP/PostgreSQL contract', () => {
  it('persists manual entries, lists actual effort and enforces optimistic edits', async () => {
    const task = await tracked(), entry = await manual(task.id);
    expect(entry).toMatchObject({ taskId: task.id, workspaceId: owner.workspaceId, userId: worker.userId, source: 'MANUAL', durationSeconds: 600, status: 'COMPLETED' });
    expect(expectOk(await call(worker, 'GET', `tasks/${task.id}/time-entries`)).map((row: any) => row.id)).toEqual([entry.id]);
    expect(expectOk(await call(reader, 'GET', `task-time-entries/${entry.id}`)).id).toBe(entry.id);
    expect(expectOk(await call(worker, 'PATCH', `task-time-entries/${entry.id}`, { body: { durationSeconds: 900, note: 'Corrected', version: 1 } }))).toMatchObject({ durationSeconds: 900, version: 2 });
    expectError(await call(worker, 'PATCH', `task-time-entries/${entry.id}`, { body: { note: 'Stale', version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(worker, 'PATCH', `task-time-entries/${entry.id}`, { body: { note: 'Missing version' } }), 400, 'VALIDATION_ERROR');
    expect(expectOk(await call(worker, 'GET', `tasks/${task.id}/time-summary`))).toMatchObject({ totalSeconds: 900, remainingSeconds: 6300, byUser: [{ userId: worker.userId, totalSeconds: 900, entryCount: 1, runningSince: null }] });
    expectOk(await call(worker, 'DELETE', `task-time-entries/${entry.id}`));
    expectError(await call(worker, 'GET', `task-time-entries/${entry.id}`), 404, 'TIME_ENTRY_NOT_FOUND');
    expect(await (await db()).taskTimeEntry.count({ where: { id: entry.id } })).toBe(0);
  });
  it('records one timer session and one stop event across retries', async () => {
    const task = await tracked();
    const timer = expectOk(await call(worker, 'POST', `tasks/${task.id}/timer/start`));
    expect(timer).toMatchObject({ source: 'TIMER', status: 'ACTIVE', endedAt: null });
    expectError(await call(worker, 'POST', `tasks/${task.id}/timer/start`), 409, 'TIME_ENTRY_ACTIVE_TIMER_EXISTS');
    expectError(await call(worker, 'PATCH', `task-time-entries/${timer.id}`, { body: { startedAt: ago(20), version: 1 } }), 409, 'TIME_ENTRY_INVALID_RANGE');
    const done = expectOk(await call(worker, 'POST', `tasks/${task.id}/timer/stop`));
    expect(done).toMatchObject({ id: timer.id, status: 'COMPLETED', alreadyStopped: false });
    expect(done.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(expectOk(await call(worker, 'POST', `tasks/${task.id}/timer/stop`))).toMatchObject({ id: timer.id, durationSeconds: done.durationSeconds, version: done.version, alreadyStopped: true });
    const prisma = await db();
    expect(await prisma.taskTimeEntry.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { entityId: task.id, eventType: 'TIME_TIMER_STOPPED' } })).toBe(1);
    expect(await prisma.taskHistory.count({ where: { taskId: task.id, action: 'TIME_RECORDED' } })).toBe(1);
  });
  it('enforces authentication, permissions and ownership; audits administrative corrections', async () => {
    const task = await tracked(), entry = await manual(task.id);
    expectError(await call(null, 'GET', `task-time-entries/${entry.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(reader, 'POST', `tasks/${task.id}/timer/start`), 403, 'PERMISSION_DENIED');
    expectError(await call(peer, 'PATCH', `task-time-entries/${entry.id}`, { body: { note: 'Other user', version: 1 } }), 403, 'PERMISSION_DENIED');
    expectError(await call(peer, 'DELETE', `task-time-entries/${entry.id}`), 403, 'PERMISSION_DENIED');
    expectOk(await call(owner, 'PATCH', `task-time-entries/${entry.id}`, { body: { durationSeconds: 1200, version: 1 } }));
    expectOk(await call(owner, 'DELETE', `task-time-entries/${entry.id}`));
    const prisma = await db();
    expect((await prisma.auditLog.findMany({ where: { entityId: entry.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['TIME_ENTRY.ADMIN_UPDATED', 'TIME_ENTRY.DELETED']));
    expect((await prisma.outboxEvent.findMany({ where: { entityId: task.id } })).map((row) => row.eventType)).toEqual(expect.arrayContaining(['TIME_ENTRY_RECORDED', 'TIME_ENTRY_UPDATED']));
  });
  it('conceals foreign entries and tasks on every route', async () => {
    const task = await tracked(), entry = await manual(task.id);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) expectError(await call(outsider, method, `task-time-entries/${entry.id}`, { body: method === 'PATCH' ? { note: 'x', version: 1 } : undefined }), 404, 'TIME_ENTRY_NOT_FOUND');
    expectError(await call(outsider, 'GET', `task-time-entries/${MISSING_ID}`), 404, 'TIME_ENTRY_NOT_FOUND');
    for (const suffix of ['time-entries', 'time-summary']) expectError(await call(outsider, 'GET', `tasks/${task.id}/${suffix}`), 404, 'TASK_NOT_FOUND');
    for (const suffix of ['time-entries', 'timer/start', 'timer/stop']) expectError(await call(outsider, 'POST', `tasks/${task.id}/${suffix}`, { body: { startedAt: ago(60), durationSeconds: 60 } }), 404, 'TASK_NOT_FOUND');
    expectError(await call(outsider, 'GET', `task-time-entries/${entry.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
  });
  it('rejects invalid ranges without saving entries or events and requires tracking', async () => {
    const task = await tracked(), start = new Date(Date.now() - 60_000);
    for (const body of [
      { startedAt: ago(30), endedAt: ago(60) }, { startedAt: ago(30), durationSeconds: 0 },
      { startedAt: ago(60), endedAt: ago(30), durationSeconds: 60 }, { startedAt: ago(-10), durationSeconds: 60 },
      { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 100).toISOString() },
    ]) expectError(await call(worker, 'POST', `tasks/${task.id}/time-entries`, { body }), 400, 'TIME_ENTRY_INVALID_RANGE');
    expectError(await call(worker, 'POST', `tasks/${task.id}/time-entries`, { body: { startedAt: ago(60) } }), 400, 'VALIDATION_ERROR');
    const prisma = await db();
    expect(await prisma.taskTimeEntry.count({ where: { taskId: task.id } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { entityId: task.id, eventType: 'TIME_ENTRY_RECORDED' } })).toBe(0);
    const untracked = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Untracked', responsibleUserId: worker.userId } }));
    expectError(await call(worker, 'POST', `tasks/${untracked.id}/timer/start`), 409, 'TASK_TIME_TRACKING_DISABLED');
    expectError(await call(worker, 'POST', `tasks/${untracked.id}/time-entries`, { body: { startedAt: ago(60), durationSeconds: 60 } }), 409, 'TASK_TIME_TRACKING_DISABLED');
  });
  it('allows only one active timer per task/user across database writers', async () => {
    const task = await tracked(), prisma = await db();
    const insert = () => prisma.taskTimeEntry.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, taskId: task.id, userId: worker.userId, startedAt: new Date(), durationSeconds: 0, source: 'TIMER', status: 'ACTIVE', version: 1, createdAt: new Date(), updatedAt: new Date() } });
    const results = await Promise.allSettled([insert(), insert()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain('task_time_entries_one_active_timer_excl');
    expect(await prisma.taskTimeEntry.count({ where: { taskId: task.id, status: 'ACTIVE' } })).toBe(1);
  });
});
