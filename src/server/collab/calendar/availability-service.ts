import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isCalendarDate } from '../support';
import { busyInterval, type CalendarAvailabilityRebuildService } from './availability-rebuild-service';
import type { CalendarEvent } from './event-types';
import type { CalendarBooking } from './booking-types';
import { bookingUserIds } from './booking-subjects';
import type { CalendarRecurrenceService } from './recurrence-service';
import type { CalendarResourceService } from './resource-service';
import type { WorkingScheduleService } from './working-schedule-service';
import { intersectIntervals, mergeIntervals, subtractIntervals, type Interval } from './availability-types';

const invalid = () => new AppError('AVAILABILITY_INVALID_RANGE', 'Use offset-aware startAt < endAt within 31 days and valid slot parameters.', 400);
export class CalendarAvailabilityService {
  constructor(private readonly support: CollabSupport, private readonly recurrence: CalendarRecurrenceService,
    private readonly resources: CalendarResourceService, private readonly schedules: WorkingScheduleService,
    private readonly rebuilds: CalendarAvailabilityRebuildService) {}
  private get state() { return this.support.state; }
  private query(actor: ActorContext, body: Body, suggest = false) {
    this.support.require(actor, 'calendar.free_busy');
    body.only(['startAt', 'endAt', 'userIds', 'resourceIds', ...(suggest ? ['durationMinutes', 'stepMinutes', 'limit'] : [])]);
    let startAt: Date, endAt: Date;
    try {
      startAt = body.instant('startAt', { required: true }); endAt = body.instant('endAt', { required: true });
      if (!['startAt', 'endAt'].every((key) => isCalendarDate(String(body.raw[key]).slice(0, 10)))) throw invalid();
      if (endAt <= startAt || endAt.getTime() - startAt.getTime() > 31 * 86_400_000) throw invalid();
    } catch { throw invalid(); }
    const resourceIds = body.uuids('resourceIds', { max: 50 }) ?? [];
    const userIds = body.uuids('userIds', { max: 50 }) ?? (resourceIds.length ? [] : [actor.user.id]);
    if (!userIds.length && !resourceIds.length || userIds.length + resourceIds.length > 50) throw invalid();
    for (const userId of userIds) this.schedules.assertSubject(actor, userId);
    const resources = resourceIds.map((id) => this.resources.get(actor, id));
    return { startAt, endAt, userIds, resources };
  }
  private snapshot(actor: Pick<ActorContext, 'workspaceId'>, input: ReturnType<CalendarAvailabilityService['query']>, excluding?: CalendarBooking) {
    const range = { startAt: input.startAt, endAt: input.endAt }, intervals = new Map<string, Interval[]>();
    for (const id of input.userIds) intervals.set(id, []);
    const events = this.state.calendarEvents.filter((event) => event.id !== excluding?.eventId && event.workspaceId === actor.workspaceId && !event.isDeleted && !event.recurrenceParentEventId && event.status !== 'CANCELLED' &&
      input.userIds.some((id) => event.organizerUserId === id || this.state.calendarEventAttendees.some((row) => row.eventId === event.id && row.userId === id && !row.removedAt && row.response !== 'DECLINED')));
    if (events.length > 1000) throw new AppError('AVAILABILITY_UNAVAILABLE', 'This availability query exceeds its synchronous budget.', 409);
    let examined = 0, pending = false;
    for (const event of events) {
      let busy = event.recurrenceRuleId ? this.rebuilds.ready(event, range) : null;
      try {
        if (!busy) {
          const occurrences = event.recurrenceRuleId ? this.recurrence.within(event, input.startAt, input.endAt) : [event];
          examined += occurrences.length;
          if (examined > 5000) throw new AppError('AVAILABILITY_UNAVAILABLE', 'This availability query exceeds its synchronous budget.', 409);
          busy = occurrences.flatMap((row) => { const interval = busyInterval(row); return interval ? intersectIntervals([interval], [range]) : []; });
        }
      }
      catch (error) {
        if (error instanceof AppError && error.code === 'RECURRENCE_SCOPE_INVALID' && event.recurrenceRuleId) {
          this.rebuilds.enqueue(event, range); pending = true; continue;
        }
        if (error instanceof AppError && error.code === 'RECURRENCE_NOT_FOUND')
          throw new AppError('AVAILABILITY_UNAVAILABLE', 'The recurrence definition is unavailable.', 409);
        throw error;
      }
      for (const userId of input.userIds) {
        if (event.organizerUserId === userId || this.state.calendarEventAttendees.some((row) => row.eventId === event.id && row.userId === userId && !row.removedAt && row.response !== 'DECLINED'))
          intervals.get(userId)!.push(...busy);
      }
    }
    const users = input.userIds.map((userId) => {
      intervals.get(userId)!.push(...this.state.calendarBookings.filter((row) => row.id !== excluding?.id && row.workspaceId === actor.workspaceId && bookingUserIds(this.state, row).includes(userId) &&
        ['PENDING', 'CONFIRMED'].includes(row.status)).flatMap((row) => intersectIntervals([{ startAt: row.reservedStartAt, endAt: row.reservedEndAt }], [range])));
      const busy = mergeIntervals(intervals.get(userId)!), working = this.schedules.windows(actor.workspaceId, userId, range);
      return { userId, busy: busy.map((row) => ({ ...row, state: 'BUSY' })), working: working.intervals,
        free: subtractIntervals(working.intervals, busy), scheduleSource: working.source };
    });
    const resources = input.resources.map((resource) => {
      const busy = mergeIntervals([...this.resources.busy(resource.id, range, excluding?.eventId ?? undefined, true),
        ...this.state.calendarBookings.filter(row => row.id !== excluding?.id && row.workspaceId === actor.workspaceId &&
          ['PENDING', 'CONFIRMED'].includes(row.status) && row.resourceIds?.includes(resource.id))
          .flatMap(row => intersectIntervals([{ startAt: row.reservedStartAt, endAt: row.reservedEndAt }], [range]))]);
      const working = this.schedules.windows(actor.workspaceId, null, range);
      return { resourceId: resource.id, isActive: resource.isActive, busy: busy.map((row) => ({ ...row, state: 'BUSY' })),
        free: resource.isActive ? subtractIntervals(working.intervals, busy) : [], scheduleSource: working.source };
    });
    return { ...range, users: pending ? [] : users, resources: pending ? [] : resources, pending, retryAfterSeconds: pending ? 5 : null };
  }
  freeBusy(actor: ActorContext, body: Body) { return this.snapshot(actor, this.query(actor, body)); }
  /** Trusted Booking service only: the published page selects the live host; public input never selects user IDs. */
  bookingHost(workspaceId: string, userId: string, range: Interval, excluding?: CalendarBooking) {
    if (!this.support.isEligibleUser(workspaceId, userId)) throw new AppError('BOOKING_PAGE_NOT_FOUND', 'Booking page was not found.', 404);
    if (excluding && (excluding.workspaceId !== workspaceId || excluding.ownerUserId !== userId || !this.state.calendarBookings.includes(excluding)))
      throw new AppError('BOOKING_NOT_FOUND', 'Booking was not found.', 404);
    return this.snapshot({ workspaceId }, { ...range, userIds: [userId], resources: [] }, excluding);
  }
  /** Subjects are selected by the published page or immutable reservation snapshot. */
  bookingSubjects(workspaceId: string, userIds: string[], resourceIds: string[], range: Interval, excluding?: CalendarBooking) {
    for (const id of userIds) if (!this.support.isEligibleUser(workspaceId, id))
      throw new AppError('BOOKING_PAGE_NOT_FOUND', 'Booking page was not found.', 404);
    const resources = resourceIds.map(id => {
      const row = this.state.calendarResources.find(row => row.id === id && row.workspaceId === workspaceId && !row.isDeleted && row.isActive);
      if (!row) throw new AppError('BOOKING_PAGE_NOT_FOUND', 'Booking page was not found.', 404);
      return row;
    });
    if (excluding && (excluding.workspaceId !== workspaceId || !this.state.calendarBookings.includes(excluding)))
      throw new AppError('BOOKING_NOT_FOUND', 'Booking was not found.', 404);
    return this.snapshot({ workspaceId }, { ...range, userIds, resources }, excluding);
  }
  suggest(actor: ActorContext, body: Body) {
    const input = this.query(actor, body, true);
    let durationMinutes: number, stepMinutes: number, limit: number;
    try {
      durationMinutes = body.int('durationMinutes', { required: true, min: 1, max: 1440 });
      stepMinutes = body.int('stepMinutes', { min: 1, max: 1440 }) ?? 15; limit = body.int('limit', { min: 1, max: 100 }) ?? 20;
      if (['stepMinutes', 'limit'].some((key) => body.has(key) && body.raw[key] === null)) throw invalid();
    } catch { throw invalid(); }
    for (const resource of input.resources) {
      if (!resource.isActive) throw new AppError('RESOURCE_INACTIVE', 'The resource is inactive.', 409);
      if (resource.capacity !== null && input.userIds.length > resource.capacity) throw new AppError('RESOURCE_CAPACITY_INVALID', 'Selected attendees exceed resource capacity.', 400);
    }
    const snapshot = this.snapshot(actor, input);
    if (snapshot.pending) return { startAt: input.startAt, endAt: input.endAt, durationMinutes, slots: [] as Interval[], pending: true, retryAfterSeconds: 5 };
    let windows: Interval[] = [{ startAt: input.startAt, endAt: input.endAt }];
    for (const subject of [...snapshot.users, ...snapshot.resources]) windows = intersectIntervals(windows, subject.free);
    const slots: Interval[] = [], duration = durationMinutes * 60_000, step = stepMinutes * 60_000;
    // Grid is anchored to the requested start instant; elapsed duration remains exact over DST transitions.
    for (const window of windows) {
      let start = input.startAt.getTime() + Math.ceil((window.startAt.getTime() - input.startAt.getTime()) / step) * step;
      while (start + duration <= window.endAt.getTime() && slots.length < limit) {
        slots.push({ startAt: new Date(start), endAt: new Date(start + duration) }); start += step;
      }
      if (slots.length >= limit) break;
    }
    return { startAt: input.startAt, endAt: input.endAt, durationMinutes, slots, pending: false, retryAfterSeconds: null };
  }
}
