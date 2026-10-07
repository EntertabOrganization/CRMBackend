/**
 * TrueCRM executable contract test for Task Time Tracking Specification.
 * Service-level; the HTTP/Postgres path is covered by task-time-tracking.e2e-spec.ts.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function setup() {
  const ctx = await collabApp();
  const worker = await ctx.memberActor('worker', perms('OWN', 'task.read', 'task.update', 'task.time_add', 'task.time_edit_own', 'task.time_delete'));
  const task = ctx.collab.tasks.tasks.create(ctx.owner, { title: 'Tracked', responsibleUserId: worker.user.id, isTimeTrackingEnabled: true, plannedDurationSeconds: 7200 });
  return { ...ctx, worker, task, svc: ctx.collab.tasks.time };
}

describe('Task Time Tracking Specification contract', () => {
  it('Timer double-start.', async () => {
    const { svc, worker, task, owner, collab } = await setup();
    const timer = svc.startTimer(worker, task.id);
    expect(timer).toMatchObject({ status: 'ACTIVE', source: 'TIMER', userId: worker.user.id, endedAt: null });
    const error = await expectAppError(() => svc.startTimer(worker, task.id), 'TIME_ENTRY_ACTIVE_TIMER_EXISTS', 409);
    expect(error.details.timeEntryId).toBe(timer.id);
    // Another user has an independent timer.
    expect(svc.startTimer(owner, task.id).userId).toBe(owner.user.id);
    // Disabled tracking refuses timers.
    const untracked = collab.tasks.tasks.create(owner, { title: 'Untracked', responsibleUserId: worker.user.id });
    await expectAppError(() => svc.startTimer(worker, untracked.id), 'TASK_TIME_TRACKING_DISABLED', 409);
  });

  it('Retry stop.', async () => {
    const ctx = await setup();
    const { svc, worker, task, owner, collab } = ctx;
    const timer = svc.startTimer(worker, task.id);
    const stopped = svc.stopTimer(worker, task.id);
    expect(stopped).toMatchObject({ id: timer.id, status: 'COMPLETED', alreadyStopped: false });
    expect(stopped.durationSeconds).toBeGreaterThanOrEqual(1);
    // A retried stop returns the same session and records nothing new.
    const retried = svc.stopTimer(worker, task.id);
    expect(retried).toMatchObject({ id: timer.id, alreadyStopped: true, durationSeconds: stopped.durationSeconds });
    expect(ctx.state.taskTimeEntries.filter((row) => row.taskId === task.id)).toHaveLength(1);
    // Stopping when no timer ever ran is a clean not-found.
    const fresh = collab.tasks.tasks.create(owner, { title: 'Fresh', isTimeTrackingEnabled: true });
    await expectAppError(() => svc.stopTimer(owner, fresh.id), 'TIME_ENTRY_NOT_FOUND', 404);
  });

  it('Invalid time range.', async () => {
    const { svc, worker, task } = await setup();
    await expectAppError(() => svc.addManual(worker, task.id, b({ startedAt: ago(30), endedAt: ago(60) })), 'TIME_ENTRY_INVALID_RANGE', 400);
    await expectAppError(() => svc.addManual(worker, task.id, b({ startedAt: ago(30), endedAt: ago(30) })), 'TIME_ENTRY_INVALID_RANGE', 400);
    await expectAppError(() => svc.addManual(worker, task.id, b({ startedAt: ago(30), durationSeconds: 0 })), 'TIME_ENTRY_INVALID_RANGE', 400);
    await expectAppError(() => svc.addManual(worker, task.id, b({ startedAt: ago(60), endedAt: ago(30), durationSeconds: 60 })), 'TIME_ENTRY_INVALID_RANGE', 400);
    await expectAppError(() => svc.addManual(worker, task.id, b({ startedAt: ago(-30), durationSeconds: 60 })), 'TIME_ENTRY_INVALID_RANGE', 400);
    await expectAppError(() => svc.addManual(worker, task.id, b({ startedAt: ago(60) })), 'VALIDATION_ERROR', 400);
    const ok = svc.addManual(worker, task.id, b({ startedAt: ago(60), endedAt: ago(30), durationSeconds: 1800 }));
    expect(ok.durationSeconds).toBe(1800);
    const fromDuration = svc.addManual(worker, task.id, b({ startedAt: ago(120), durationSeconds: 600 }));
    expect(fromDuration.endedAt!.getTime() - fromDuration.startedAt.getTime()).toBe(600_000);
    expect(svc.summary(worker, task.id)).toMatchObject({ totalSeconds: 2400, plannedDurationSeconds: 7200, remainingSeconds: 4800 });
  });

  it('Own vs all edit permission.', async () => {
    const ctx = await setup();
    const { svc, worker, task, owner, memberActor } = ctx;
    const peer = await memberActor('peer', perms('WORKSPACE', 'task.read', 'task.time_add', 'task.time_edit_own', 'task.time_delete'));
    const mine = svc.addManual(worker, task.id, b({ startedAt: ago(90), durationSeconds: 900, note: 'mine' }));
    expect(svc.update(worker, mine.id, b({ note: 'edited', version: mine.version })).note).toBe('edited');
    await expectAppError(() => svc.update(peer, mine.id, b({ note: 'peer edit', version: mine.version })), 'PERMISSION_DENIED', 403);
    await expectAppError(() => svc.remove(peer, mine.id), 'PERMISSION_DENIED', 403);
    // Workspace owner holds time_edit_all: the administrative correction is centrally audited.
    const corrected = svc.update(owner, mine.id, b({ durationSeconds: 1200, version: mine.version }));
    expect(corrected.durationSeconds).toBe(1200);
    const audit = ctx.state.auditLogs.filter((row) => row.entityId === mine.id).map((row) => row.action);
    expect(audit).toEqual(['TIME_ENTRY.ADMIN_UPDATED']);
    // The owner's own edit of their own entry is not an administrative action.
    const ownEntry = svc.addManual(owner, task.id, b({ startedAt: ago(200), durationSeconds: 60 }));
    svc.update(owner, ownEntry.id, b({ note: 'self', version: ownEntry.version }));
    expect(ctx.state.auditLogs.some((row) => row.entityId === ownEntry.id)).toBe(false);
    svc.remove(owner, mine.id);
    expect(ctx.state.auditLogs.filter((row) => row.entityId === mine.id).map((row) => row.action)).toEqual(['TIME_ENTRY.ADMIN_UPDATED', 'TIME_ENTRY.DELETED']);
    await expectAppError(() => svc.get(worker, mine.id), 'TIME_ENTRY_NOT_FOUND', 404);
  });
});
