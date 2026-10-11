import { AppError } from '../../errors';
import type { CollabSupport } from '../support';
import { advanceRecurrence, recurrenceInstant } from './recurrence-engine';
import type { CalendarEvent } from './event-types';
import type { CalendarRecurrenceService } from './recurrence-service';
import { intersectIntervals, mergeIntervals, type CalendarAvailabilityRebuild, type Interval } from './availability-types';

export function busyInterval(event: CalendarEvent): Interval | null {
  if (event.isDeleted || event.status === 'CANCELLED' || event.busyStatus === 'FREE') return null;
  const startAt = event.isAllDay ? recurrenceInstant(`${event.startDate}T00:00:00.000`, event.sourceTimezone) : event.startAt;
  const endAt = event.isAllDay ? recurrenceInstant(`${event.endDate}T00:00:00.000`, event.sourceTimezone) : event.endAt;
  return startAt && endAt && endAt > startAt ? { startAt, endAt } : null;
}
export class CalendarAvailabilityRebuildService {
  constructor(private readonly support: CollabSupport, private readonly recurrence: CalendarRecurrenceService) {}
  private get state() { return this.support.state; }
  private find(event: CalendarEvent, range: Interval) {
    const rule = this.state.calendarRecurrenceRules.find((row) => row.id === event.recurrenceRuleId && !row.isDeleted);
    if (!rule) return undefined;
    return this.state.calendarAvailabilityRebuilds.find((row) => row.workspaceId === event.workspaceId && row.eventId === event.id &&
      row.recurrenceRuleId === rule?.id && row.eventVersion === event.version && row.ruleVersion === rule.version &&
      row.startAt.getTime() === range.startAt.getTime() && row.endAt.getTime() === range.endAt.getTime());
  }
  ready(event: CalendarEvent, range: Interval) {
    const row = this.find(event, range);
    if (row?.status !== 'READY' || row.expiresAt <= this.support.now()) return null;
    return row.busy.map((interval) => ({ startAt: new Date(interval.startAt), endAt: new Date(interval.endAt) }));
  }
  enqueue(event: CalendarEvent, range: Interval) {
    const rule = this.state.calendarRecurrenceRules.find((row) => row.id === event.recurrenceRuleId && !row.isDeleted);
    if (!rule) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The recurrence definition is unavailable.', 409);
    const old = this.find(event, range), now = this.support.now();
    if (old && old.expiresAt > now && old.status !== 'CANCELLED') {
      if (old.status === 'FAILED' && old.failures >= 3) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The recurrence availability rebuild failed.', 409);
      return old;
    }
    if (old) {
      Object.assign(old, { status: 'PENDING', cursorRecurrenceId: null, cursorOrdinal: 0, busy: [], failures: 0,
        nextAttemptAt: null, lastErrorCode: null, expiresAt: new Date(now.getTime() + 86_400_000) });
      this.support.touch(old); return old;
    }
    this.state.calendarAvailabilityRebuilds = this.state.calendarAvailabilityRebuilds.filter((row) => row.workspaceId !== event.workspaceId || row.expiresAt > now);
    if (this.state.calendarAvailabilityRebuilds.filter((row) => row.workspaceId === event.workspaceId).length >= 1000)
      throw new AppError('AVAILABILITY_UNAVAILABLE', 'The availability rebuild queue is at capacity.', 409);
    const row: CalendarAvailabilityRebuild = { id: this.support.id(), workspaceId: event.workspaceId, eventId: event.id,
      recurrenceRuleId: rule.id, eventVersion: event.version, ruleVersion: rule.version, ...range, status: 'PENDING',
      cursorRecurrenceId: null, cursorOrdinal: 0, busy: [], failures: 0, nextAttemptAt: null, lastErrorCode: null,
      expiresAt: new Date(now.getTime() + 86_400_000), version: 1, createdAt: now, updatedAt: now };
    this.state.calendarAvailabilityRebuilds.push(row); return row;
  }
  /** One resumable page per committed state unit. PostgreSQL version fencing rejects competing stale workers. */
  runOne(now = this.support.now()) {
    const job = this.state.calendarAvailabilityRebuilds.filter((row) => (row.status === 'PENDING' || row.status === 'FAILED' && row.failures < 3) &&
      (!row.nextAttemptAt || row.nextAttemptAt <= now)).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))[0];
    if (!job) return null;
    const event = this.state.calendarEvents.find((row) => row.id === job.eventId && row.workspaceId === job.workspaceId);
    const rule = this.state.calendarRecurrenceRules.find((row) => row.id === job.recurrenceRuleId && row.eventId === job.eventId && !row.isDeleted);
    if (!event || event.isDeleted || event.status === 'CANCELLED' || event.recurrenceRuleId !== rule?.id || event.version !== job.eventVersion || rule?.version !== job.ruleVersion || job.expiresAt <= now) {
      job.status = 'CANCELLED'; job.busy = []; job.nextAttemptAt = null; this.support.touch(job); return { status: job.status };
    }
    try {
      let { from, through } = this.recurrence.windowBounds(event, job.startAt, job.endAt);
      for (const exception of this.state.calendarRecurrenceExceptions.filter((row) => row.recurrenceRuleId === rule.id && row.overrideEventId && row.exceptionType !== 'CANCELLED')) {
        const override = this.state.calendarEvents.find((row) => row.id === exception.overrideEventId);
        const interval = override ? busyInterval(override) : null;
        if (interval && interval.startAt < job.endAt && interval.endAt > job.startAt) {
          if (exception.recurrenceId > through) through = exception.recurrenceId;
          if (exception.recurrenceId < from) from = exception.recurrenceId;
        }
      }
      // COUNT requires the valid historical ordinal. Unbounded rules can resume at the query's earliest identity.
      const initialAfter = !/(?:^|;)COUNT=/i.test(rule.rruleText) && from > rule.dtstartLocal
        ? new Date(Date.parse(`${from}${rule.isAllDay ? 'T00:00:00.000' : ''}Z`) - (rule.isAllDay ? 86_400_000 : 1)).toISOString().slice(0, rule.isAllDay ? 10 : -1) : null;
      const page = advanceRecurrence(rule, { after: job.cursorRecurrenceId ?? initialAfter, ordinal: job.cursorOrdinal, through });
      const intervals = page.occurrences.flatMap((occurrence) => {
        const interval = busyInterval(this.recurrence.resolveKnown(event, occurrence));
        return interval ? intersectIntervals([interval], [job]) : [];
      });
      const previous = job.busy.map((interval) => ({ startAt: new Date(interval.startAt), endAt: new Date(interval.endAt) }));
      const merged = mergeIntervals([...previous, ...intervals]);
      // Compute the full page before mutation; failures retain the last committed cursor and intervals.
      job.busy = merged.map((interval) => ({ startAt: interval.startAt.toISOString(), endAt: interval.endAt.toISOString() }));
      job.cursorRecurrenceId = page.cursor; job.cursorOrdinal = page.ordinal; job.status = page.bounded ? 'PENDING' : 'READY';
      job.nextAttemptAt = null; job.lastErrorCode = null; this.support.touch(job); return { status: job.status };
    } catch {
      job.status = 'FAILED'; job.failures += 1; job.lastErrorCode = 'AVAILABILITY_REBUILD_FAILED';
      job.nextAttemptAt = job.failures < 3 ? new Date(now.getTime() + 30_000 * 2 ** (job.failures - 1)) : null;
      this.support.touch(job); return { status: job.status };
    }
  }
}
