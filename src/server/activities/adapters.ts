import { AppError } from '../errors';
import type { CalendarMeetingInput, CalendarMeetingResult, CalendarPort, TaskInput, TaskPort } from '../ports';
import { AdapterUnavailableError } from '../ports';
import type { ActivityAdapterKind } from './activity-types';

/**
 * Registry of specialist ports. Calendar/Tasks own their lifecycles; the Activity layer only delegates to a registered
 * port and mirrors the confirmed outcome. With no port registered, the Activity stays a CRM-side record and no
 * specialist behaviour is invented.
 */
export class ActivityAdapterRegistry {
  private calendar: CalendarPort | null = null;
  private tasks: TaskPort | null = null;

  registerCalendar(port: CalendarPort | null) {
    this.calendar = port;
  }

  registerTasks(port: TaskPort | null) {
    this.tasks = port;
  }

  has(kind: ActivityAdapterKind | undefined) {
    if (kind === 'CALENDAR') return this.calendar !== null;
    if (kind === 'TASKS') return this.tasks !== null;
    return false;
  }

  getCalendar() {
    return this.calendar;
  }

  getTasks() {
    return this.tasks;
  }

  /** Translates any adapter failure into a stable domain error without leaking provider details. */
  static wrap(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (error instanceof AdapterUnavailableError) throw new AppError('ACTIVITY_ADAPTER_UNAVAILABLE', 'The specialist module is temporarily unavailable.', 503);
    throw new AppError('ACTIVITY_ADAPTER_CONFLICT', 'The specialist module rejected the operation.', 409);
  }
}

// ---- deterministic fakes (used by contract tests until the real modules exist) ---------------------------------------

export class FakeCalendarPort implements CalendarPort {
  readonly calls: Array<{ op: string; eventId?: string; key: string }> = [];
  private readonly events = new Map<string, CalendarMeetingResult>();
  failNext: Error | null = null;
  private counter = 0;

  private maybeFail() {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  createMeeting(input: CalendarMeetingInput): CalendarMeetingResult {
    this.maybeFail();
    const existing = [...this.events.entries()].find(([, value]) => (value as unknown as { key?: string }).key === input.idempotencyKey);
    if (existing) return existing[1];
    const eventId = `cal-${++this.counter}`;
    const result: CalendarMeetingResult & { key?: string } = { eventId, startAt: input.startAt, endAt: input.endAt, location: input.location, key: input.idempotencyKey };
    this.events.set(eventId, result);
    this.calls.push({ op: 'create', eventId, key: input.idempotencyKey });
    return result;
  }

  updateMeeting(eventId: string, input: CalendarMeetingInput): CalendarMeetingResult {
    this.maybeFail();
    const result: CalendarMeetingResult = { eventId, startAt: input.startAt, endAt: input.endAt, location: input.location };
    this.events.set(eventId, result);
    this.calls.push({ op: 'update', eventId, key: input.idempotencyKey });
    return result;
  }

  cancelMeeting(eventId: string, input: { idempotencyKey: string }) {
    this.maybeFail();
    this.calls.push({ op: 'cancel', eventId, key: input.idempotencyKey });
  }

  completeMeeting(eventId: string, input: { idempotencyKey: string }) {
    this.maybeFail();
    this.calls.push({ op: 'complete', eventId, key: input.idempotencyKey });
  }
}

export class FakeTaskPort implements TaskPort {
  readonly calls: Array<{ op: string; taskId?: string; key: string }> = [];
  failNext: Error | null = null;
  private counter = 0;

  private maybeFail() {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  createTask(input: TaskInput) {
    this.maybeFail();
    const taskId = `task-${++this.counter}`;
    this.calls.push({ op: 'create', taskId, key: input.idempotencyKey });
    return { taskId };
  }

  updateTask(taskId: string, input: TaskInput) {
    this.maybeFail();
    this.calls.push({ op: 'update', taskId, key: input.idempotencyKey });
  }

  completeTask(taskId: string, input: { idempotencyKey: string }) {
    this.maybeFail();
    this.calls.push({ op: 'complete', taskId, key: input.idempotencyKey });
  }

  cancelTask(taskId: string, input: { idempotencyKey: string }) {
    this.maybeFail();
    this.calls.push({ op: 'cancel', taskId, key: input.idempotencyKey });
  }

  reopenTask(taskId: string, input: { idempotencyKey: string }) {
    this.maybeFail();
    this.calls.push({ op: 'reopen', taskId, key: input.idempotencyKey });
  }
}
