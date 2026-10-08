import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { Body, CollabSupport } from '../support';
import { notFoundError, pageOf, validationError } from '../support';
import type { TasksPolicy } from './policy';
import type { TaskService } from './task-service';
import type { Task, TaskTimeEntry } from './types';

const MAX_ENTRY_SECONDS = 7 * 24 * 3600;

/** Actual effort: manual entries and timer sessions. Planned duration stays on the Task. */
export class TimeService {
  constructor(private readonly support: CollabSupport, private readonly policy: TasksPolicy, private readonly tasks: TaskService) {}

  private get state() {
    return this.support.state;
  }

  private assertTracking(task: Task) {
    if (!task.isTimeTrackingEnabled) throw new AppError('TASK_TIME_TRACKING_DISABLED', 'Time tracking is not enabled for this Task.', 409);
  }

  private entry(actor: ActorContext, id: string) {
    const entry = this.state.taskTimeEntries.find((row) => row.id === id && row.workspaceId === actor.workspaceId);
    if (!entry) throw notFoundError('TIME_ENTRY_NOT_FOUND', 'Time entry');
    const task = this.state.tasks.find((row) => row.id === entry.taskId && !row.isDeleted);
    if (!task || !this.support.scope(actor, 'task.read') || !this.policy.canViewTask(actor, task)) throw notFoundError('TIME_ENTRY_NOT_FOUND', 'Time entry');
    return { entry, task };
  }

  private event(actor: ActorContext, task: Task, type: string, entry: TaskTimeEntry) {
    this.support.event({
      workspaceId: task.workspaceId, type, entityType: 'TASK', entityId: task.id, actorUserId: actor.user.id,
      changes: { timeEntryId: entry.id, userId: entry.userId, durationSeconds: entry.durationSeconds, source: entry.source },
      audienceUserIds: [entry.userId, task.responsibleUserId],
    });
  }

  list(actor: ActorContext, taskId: string, query: URLSearchParams) {
    const task = this.policy.task(actor, taskId);
    return pageOf(this.state.taskTimeEntries.filter((row) => row.taskId === task.id), query, {
      searchable: ['note'], filterable: ['userId', 'source', 'status'], sortable: ['startedAt', 'createdAt', 'durationSeconds'], defaultSort: 'startedAt', defaultOrder: 'desc',
    });
  }

  /** Resolves start/end/duration and rejects inconsistent combinations. */
  private range(startedAt: Date, endedAt: Date | null | undefined, duration: number | null | undefined) {
    if (endedAt && endedAt <= startedAt) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'endedAt must be after startedAt.', 400);
    if (duration !== null && duration !== undefined && duration <= 0) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'durationSeconds must be positive.', 400);
    let end = endedAt ?? null;
    let seconds = duration ?? null;
    if (end && seconds !== null) {
      const span = Math.round((end.getTime() - startedAt.getTime()) / 1000);
      if (Math.abs(span - seconds) > 1) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'durationSeconds does not match startedAt/endedAt.', 400, { expectedDurationSeconds: span });
    }
    if (!end && seconds === null) throw validationError('endedAt', 'Provide endedAt or durationSeconds.');
    if (end) seconds = Math.round((end.getTime() - startedAt.getTime()) / 1000);
    if (!end) end = new Date(startedAt.getTime() + seconds! * 1000);
    if (seconds! <= 0) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'Time entries must record at least one second.', 400);
    if (seconds! > MAX_ENTRY_SECONDS) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'A single entry cannot exceed 7 days.', 400);
    if (end > new Date(Date.now() + 60_000)) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'Time entries cannot end in the future.', 400);
    return { end, seconds: seconds! };
  }

  addManual(actor: ActorContext, taskId: string, body: Body) {
    const task = this.policy.task(actor, taskId);
    this.policy.requireTaskAction(actor, task, 'task.time_add');
    this.policy.assertTaskWritable(task);
    this.assertTracking(task);
    body.only(['startedAt', 'endedAt', 'durationSeconds', 'note']);
    const startedAt = body.instant('startedAt', { required: true });
    const { end, seconds } = this.range(startedAt, body.instant('endedAt'), body.int('durationSeconds'));
    const now = this.support.now();
    const entry: TaskTimeEntry = {
      id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, userId: actor.user.id, startedAt, endedAt: end, durationSeconds: seconds,
      source: 'MANUAL', note: body.str('note', { max: 2000 }) ?? null, status: 'COMPLETED', version: 1, createdAt: now, updatedAt: now,
    };
    this.state.taskTimeEntries.push(entry);
    this.tasks.history(task, actor.user.id, 'TIME_RECORDED', 'timeEntry', null, { timeEntryId: entry.id, durationSeconds: seconds });
    this.event(actor, task, 'TIME_ENTRY_RECORDED', entry);
    return entry;
  }

  get(actor: ActorContext, id: string) {
    return this.entry(actor, id).entry;
  }

  /** Own entries need task.time_edit_own; anyone else's needs task.time_edit_all and is audited. */
  private requireEdit(actor: ActorContext, task: Task, entry: TaskTimeEntry, permission: 'task.time_edit_own' | 'task.time_delete') {
    if (entry.userId === actor.user.id) {
      this.support.require(actor, permission);
      return false;
    }
    this.support.require(actor, 'task.time_edit_all');
    if (permission === 'task.time_delete') this.support.require(actor, 'task.time_delete');
    if (!this.policy.canActOnTask(actor, task, 'task.time_edit_all', 'member')) throw forbidden('task.time_edit_all is not granted for this Task.');
    return true;
  }

  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const { entry, task } = this.entry(actor, id);
    const administrative = this.requireEdit(actor, task, entry, 'task.time_edit_own');
    this.policy.assertTaskWritable(task);
    body.only(['startedAt', 'endedAt', 'durationSeconds', 'note', 'version']);
    this.support.expectVersion(entry, body.raw.version ?? ifMatch);
    const before = { startedAt: entry.startedAt, endedAt: entry.endedAt, durationSeconds: entry.durationSeconds, note: entry.note };
    if (entry.status === 'ACTIVE' && (body.has('startedAt') || body.has('endedAt') || body.has('durationSeconds'))) throw new AppError('TIME_ENTRY_INVALID_RANGE', 'Stop the running timer before changing its time range.', 409);
    if (body.has('note') || body.raw.note === null) entry.note = body.str('note', { max: 2000 }) ?? null;
    if (entry.status === 'COMPLETED' && (body.has('startedAt') || body.has('endedAt') || body.has('durationSeconds'))) {
      const startedAt = body.instant('startedAt') ?? entry.startedAt;
      const endedAt = body.has('endedAt') ? body.instant('endedAt') : body.has('durationSeconds') ? null : entry.endedAt;
      const { end, seconds } = this.range(startedAt, endedAt, body.has('durationSeconds') ? body.int('durationSeconds') : endedAt ? null : entry.durationSeconds);
      entry.startedAt = startedAt;
      entry.endedAt = end;
      entry.durationSeconds = seconds;
    }
    this.support.touch(entry);
    this.tasks.history(task, actor.user.id, 'TIME_UPDATED', 'timeEntry', before, { timeEntryId: entry.id, durationSeconds: entry.durationSeconds });
    this.event(actor, task, 'TIME_ENTRY_UPDATED', entry);
    // Administrative corrections and corrections on finished Tasks are material: centrally audited.
    if (administrative || task.status === 'COMPLETED') {
      this.support.audit(actor, task.workspaceId, administrative ? 'TIME_ENTRY.ADMIN_UPDATED' : 'TIME_ENTRY.CORRECTED', 'TASK_TIME_ENTRY', entry.id, before, { startedAt: entry.startedAt, endedAt: entry.endedAt, durationSeconds: entry.durationSeconds, note: entry.note }, { taskId: task.id, ownerUserId: entry.userId });
    }
    return entry;
  }

  remove(actor: ActorContext, id: string) {
    const { entry, task } = this.entry(actor, id);
    const administrative = this.requireEdit(actor, task, entry, 'task.time_delete');
    this.policy.assertTaskWritable(task);
    this.state.taskTimeEntries = this.state.taskTimeEntries.filter((row) => row.id !== entry.id);
    this.tasks.history(task, actor.user.id, 'TIME_DELETED', 'timeEntry', { timeEntryId: entry.id, durationSeconds: entry.durationSeconds }, null);
    this.event(actor, task, 'TIME_ENTRY_UPDATED', { ...entry, durationSeconds: 0 });
    if (administrative || task.status === 'COMPLETED') {
      this.support.audit(actor, task.workspaceId, 'TIME_ENTRY.DELETED', 'TASK_TIME_ENTRY', entry.id, { startedAt: entry.startedAt, endedAt: entry.endedAt, durationSeconds: entry.durationSeconds }, null, { taskId: task.id, ownerUserId: entry.userId });
    }
    return { id: entry.id, deleted: true };
  }

  startTimer(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    this.policy.requireTaskAction(actor, task, 'task.time_add');
    this.policy.assertTaskWritable(task);
    this.assertTracking(task);
    const running = this.state.taskTimeEntries.find((row) => row.taskId === task.id && row.userId === actor.user.id && row.status === 'ACTIVE');
    if (running) throw new AppError('TIME_ENTRY_ACTIVE_TIMER_EXISTS', 'A timer is already running for this Task.', 409, { timeEntryId: running.id });
    const now = this.support.now();
    const entry: TaskTimeEntry = {
      id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, userId: actor.user.id, startedAt: now, endedAt: null, durationSeconds: 0,
      source: 'TIMER', note: null, status: 'ACTIVE', version: 1, createdAt: now, updatedAt: now,
    };
    this.state.taskTimeEntries.push(entry);
    this.event(actor, task, 'TIME_TIMER_STARTED', entry);
    return entry;
  }

  /** Stops the caller's running timer. A retried stop (nothing running) returns the session it already stopped. */
  stopTimer(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    this.policy.requireTaskAction(actor, task, 'task.time_add');
    const running = this.state.taskTimeEntries.find((row) => row.taskId === task.id && row.userId === actor.user.id && row.status === 'ACTIVE');
    if (!running) {
      const last = this.state.taskTimeEntries
        .filter((row) => row.taskId === task.id && row.userId === actor.user.id && row.source === 'TIMER' && row.status === 'COMPLETED')
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      if (!last) throw notFoundError('TIME_ENTRY_NOT_FOUND', 'Running timer');
      return { ...last, alreadyStopped: true };
    }
    const now = this.support.now();
    running.endedAt = now > running.startedAt ? now : new Date(running.startedAt.getTime() + 1000);
    running.durationSeconds = Math.max(1, Math.round((running.endedAt.getTime() - running.startedAt.getTime()) / 1000));
    running.status = 'COMPLETED';
    this.support.touch(running);
    this.tasks.history(task, actor.user.id, 'TIME_RECORDED', 'timeEntry', null, { timeEntryId: running.id, durationSeconds: running.durationSeconds });
    this.event(actor, task, 'TIME_TIMER_STOPPED', running);
    return { ...running, alreadyStopped: false };
  }

  summary(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    const entries = this.state.taskTimeEntries.filter((row) => row.taskId === task.id);
    const byUser = new Map<string, { userId: string; totalSeconds: number; entryCount: number; runningSince: Date | null }>();
    for (const entry of entries) {
      const row = byUser.get(entry.userId) ?? { userId: entry.userId, totalSeconds: 0, entryCount: 0, runningSince: null };
      if (entry.status === 'COMPLETED') {
        row.totalSeconds += entry.durationSeconds;
        row.entryCount += 1;
      } else {
        row.runningSince = entry.startedAt;
      }
      byUser.set(entry.userId, row);
    }
    const totalSeconds = [...byUser.values()].reduce((sum, row) => sum + row.totalSeconds, 0);
    return {
      taskId: task.id,
      isTimeTrackingEnabled: task.isTimeTrackingEnabled,
      plannedDurationSeconds: task.plannedDurationSeconds,
      totalSeconds,
      remainingSeconds: task.plannedDurationSeconds === null ? null : task.plannedDurationSeconds - totalSeconds,
      byUser: [...byUser.values()],
    };
  }
}
