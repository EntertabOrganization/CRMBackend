import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isCalendarDate, isIanaTimezone, notFoundError, pageOf } from '../support';
import { advanceRecurrence, recurrenceInstant } from './recurrence-engine';
import type { CalendarRecurrenceService } from './recurrence-service';
import type { CalendarEventService } from './event-service';
import type { CalendarEvent } from './event-types';
import type { CalendarResource, CalendarResourceBooking } from './resource-types';
import type { WorkingScheduleService } from './working-schedule-service';
import type { CalendarBooking } from './booking-types';
import { mergeIntervals, subtractIntervals } from './availability-types';

const EDITABLE = ['type', 'name', 'description', 'capacity', 'timezone', 'isExclusive', 'isActive'];
const overlap = (a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }) => a.startAt < b.endAt && b.startAt < a.endAt;
export class CalendarResourceService {
  constructor(private readonly support: CollabSupport, private readonly events: CalendarEventService, private readonly schedules: WorkingScheduleService,
    private readonly recurrence: CalendarRecurrenceService) {}
  private get state() { return this.support.state; }
  private roots() { return this.state.calendarResourceBookings.filter(row => !row.seriesBookingId); }
  private occurrences(event: CalendarEvent, range: { startAt: Date; endAt: Date }, budget = { remaining: 5000 }) {
    if (event.isDeleted || event.status === 'CANCELLED') return [];
    if (!event.recurrenceRuleId) return overlap(this.range(event), range) ? [{ ...this.range(event), recurrenceId: 'SINGLE' }] : [];
    const rule = this.state.calendarRecurrenceRules.find(row => row.id === event.recurrenceRuleId && !row.isDeleted);
    if (!rule) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource recurrence definition is unavailable.', 409);
    let { from, through } = this.recurrence.windowBounds(event, range.startAt, range.endAt);
    for (const exception of this.state.calendarRecurrenceExceptions.filter(row => row.recurrenceRuleId === rule.id && row.overrideEventId)) {
      const override = this.state.calendarEvents.find(row => row.id === exception.overrideEventId);
      if (override && !override.isDeleted && overlap(this.range(override), range)) {
        if (exception.recurrenceId < from) from = exception.recurrenceId;
        if (exception.recurrenceId > through) through = exception.recurrenceId;
      }
    }
    let after = !/(?:^|;)COUNT=/i.test(rule.rruleText) && from > rule.dtstartLocal
      ? new Date(Date.parse(`${from}${rule.isAllDay ? 'T00:00:00.000' : ''}Z`) - (rule.isAllDay ? 86_400_000 : 1)).toISOString().slice(0, rule.isAllDay ? 10 : -1) : null;
    let ordinal = 0;
    const result: { startAt: Date; endAt: Date; recurrenceId: string }[] = [];
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      if (budget.remaining <= 0) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource recurrence query exceeds its synchronous budget.', 409);
      const page = advanceRecurrence(rule, { after, ordinal, through, candidateLimit: Math.min(1000, budget.remaining) });
      budget.remaining -= page.examined;
      for (const occurrence of page.occurrences) {
        const scheduled = this.recurrence.resolveKnown(event, occurrence);
        if (!scheduled.isDeleted && scheduled.status !== 'CANCELLED') {
          const interval = this.range(scheduled);
          if (overlap(interval, range)) result.push({ ...interval, recurrenceId: occurrence.recurrenceId });
        }
      }
      if (!page.bounded) return result;
      after = page.cursor; ordinal = page.ordinal;
    }
    throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource recurrence query exceeds its synchronous budget.', 409);
  }
  busy(resourceId: string, range: { startAt: Date; endAt: Date }, excludingEventId?: string, materialize = false) {
    const roots = this.roots().filter(row => row.resourceId === resourceId && row.status === 'ACTIVE' && row.eventId !== excludingEventId);
    if (roots.length > 1000) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource availability query exceeds its synchronous budget.', 409);
    const budget = { remaining: 5000 };
    const intervals = roots.flatMap(row => {
      const event = this.state.calendarEvents.find(event => event.id === row.eventId && event.workspaceId === row.workspaceId);
      if (!event) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource Event is unavailable.', 409);
      return this.occurrences(event, range, budget);
    });
    if (intervals.length > 5000) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource availability query exceeds its synchronous budget.', 409);
    const busy = mergeIntervals(intervals.map(row => ({ startAt: new Date(Math.max(row.startAt.getTime(), range.startAt.getTime())),
      endAt: new Date(Math.min(row.endAt.getTime(), range.endAt.getTime())) })));
    if (materialize) {
      // Compute every complete projection before changing any reservation. Read requests
      // extend the durable horizon; conflict preflights remain mutation-free.
      const plans = roots.flatMap(root => {
        const event = this.state.calendarEvents.find(event => event.id === root.eventId)!;
        return event.recurrenceRuleId ? [{ root, event, occurrences: this.projection(event, [range]) }] : [];
      });
      for (const plan of plans) this.materialize(plan.root, plan.event, plan.occurrences);
    }
    return busy;
  }
  private coverage(event: CalendarEvent) {
    const base = this.range(event);
    const windows = [event.recurrenceRuleId ? { startAt: base.startAt, endAt: new Date(base.startAt.getTime() + 93 * 86_400_000) } : base];
    for (const row of this.state.calendarResourceBookings.filter(row => row.eventId === event.id && row.seriesBookingId)) {
      windows.push(row);
      if (event.recurrenceRuleId && row.recurrenceId) {
        const scheduled = this.recurrence.resolveKnown(event, { recurrenceId: row.recurrenceId, ordinal: 0, startAt: null, startDate: null });
        if (!scheduled.isDeleted && scheduled.status !== 'CANCELLED') windows.push(this.range(scheduled));
      }
    }
    for (const exception of this.state.calendarRecurrenceExceptions.filter(row => row.recurrenceRuleId === event.recurrenceRuleId && row.overrideEventId)) {
      const override = this.state.calendarEvents.find(row => row.id === exception.overrideEventId);
      if (override && !override.isDeleted) windows.push(this.range(override));
    }
    return mergeIntervals(windows);
  }
  private projection(event: CalendarEvent, extra: { startAt: Date; endAt: Date }[] = []) {
    const result = new Map<string, { startAt: Date; endAt: Date; recurrenceId: string }>();
    const budget = { remaining: 5000 };
    for (const range of mergeIntervals([...this.coverage(event), ...extra]))
      for (const occurrence of this.occurrences(event, range, budget)) result.set(occurrence.recurrenceId, occurrence);
    if (result.size > 5000) throw new AppError('AVAILABILITY_UNAVAILABLE', 'The resource reservation exceeds its synchronous budget.', 409);
    return [...result.values()];
  }
  private materialize(root: CalendarResourceBooking, event: CalendarEvent, projected?: ReturnType<CalendarResourceService['projection']>) {
    const occurrences = projected ?? (event.recurrenceRuleId ? this.projection(event) : []);
    Object.assign(root, this.range(event), { recurrenceId: event.recurrenceRuleId ? '__SERIES__' : 'SINGLE', seriesBookingId: null });
    for (const row of this.state.calendarResourceBookings.filter(row => row.seriesBookingId === root.id)) {
      row.status = 'CANCELLED'; row.updatedAt = this.support.now();
    }
    for (const occurrence of occurrences) {
      let row = this.state.calendarResourceBookings.find(row => row.seriesBookingId === root.id && row.recurrenceId === occurrence.recurrenceId);
      if (row) Object.assign(row, occurrence, { status: 'ACTIVE', exclusive: root.exclusive, updatedAt: this.support.now() });
      else {
        row = { ...root, ...occurrence, id: this.support.id(), seriesBookingId: root.id, createdAt: this.support.now(), updatedAt: this.support.now() };
        this.state.calendarResourceBookings.push(row);
      }
    }
  }
  private resource(actor: ActorContext, id: string, manage = false) {
    this.support.require(actor, 'resource.read');
    const row = this.state.calendarResources.find((item) => item.workspaceId === actor.workspaceId && item.id === id && !item.isDeleted);
    if (!row) throw notFoundError('RESOURCE_NOT_FOUND', 'Resource');
    if (manage) this.support.requireWorkspaceScope(actor, 'resource.manage');
    return row;
  }
  private values(body: Body, old?: CalendarResource, replace = false) {
    const required = !old || replace;
    const type = body.enumOf('type', ['ROOM', 'EQUIPMENT', 'OTHER'] as const, { required }) ?? old!.type;
    const name = body.str('name', { required: required || body.has('name'), max: 500 }) ?? old!.name;
    const timezone = body.str('timezone', { required: required || body.has('timezone'), max: 100 }) ?? old!.timezone;
    if (!isIanaTimezone(timezone)) throw new AppError('VALIDATION_ERROR', 'timezone must be an IANA timezone.', 400);
    let capacity: number | null;
    try { capacity = required || body.has('capacity') ? body.int('capacity', { min: 1, max: 1_000_000 }) ?? null : old!.capacity; }
    catch { throw new AppError('RESOURCE_CAPACITY_INVALID', 'capacity must be a positive integer or null.', 400); }
    return { type, name, timezone, capacity,
      description: required || body.has('description') ? body.str('description', { max: 50_000 }) ?? null : old!.description,
      isExclusive: body.bool('isExclusive', { required: body.has('isExclusive') }) ?? (required ? true : old!.isExclusive),
      isActive: body.bool('isActive', { required: body.has('isActive') }) ?? (required ? true : old!.isActive) };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'resource.read');
    return pageOf(this.state.calendarResources.filter((row) => row.workspaceId === actor.workspaceId && !row.isDeleted), query,
      { searchable: ['name', 'description'], filterable: ['type', 'isActive', 'isExclusive'], sortable: ['name', 'createdAt', 'updatedAt'], defaultSort: 'name' });
  }
  get(actor: ActorContext, id: string) { return this.resource(actor, id); }
  create(actor: ActorContext, body: Body) {
    this.support.requireWorkspaceScope(actor, 'resource.manage'); body.only(EDITABLE);
    const values = this.values(body), now = this.support.now();
    const row: CalendarResource = { id: this.support.id(), workspaceId: actor.workspaceId, createdByUserId: actor.user.id,
      ...values, isDeleted: false, version: 1, createdAt: now, updatedAt: now };
    this.state.calendarResources.push(row);
    this.support.audit(actor, actor.workspaceId, 'RESOURCE.CREATED', 'CALENDAR_RESOURCE', row.id, null, row);
    this.emit(actor, row, 'RESOURCE_CREATED'); return row;
  }
  private party(event: CalendarEvent) {
    return new Set([event.organizerUserId, ...this.state.calendarEventAttendees.filter((row) => row.eventId === event.id && !row.removedAt && row.response !== 'DECLINED').map((row) => row.userId)]).size +
      this.state.calendarExternalGuests.filter((row) => row.eventId === event.id && !row.removedAt && row.response !== 'DECLINED').length;
  }
  private range(event: CalendarEvent) {
    const startAt = event.isAllDay ? recurrenceInstant(`${event.startDate}T00:00:00.000`, event.sourceTimezone) : event.startAt;
    const endAt = event.isAllDay ? recurrenceInstant(`${event.endDate}T00:00:00.000`, event.sourceTimezone) : event.endAt;
    if (!startAt || !endAt || endAt <= startAt) throw new AppError('AVAILABILITY_INVALID_RANGE', 'Event boundaries must resolve to a valid interval.', 400);
    return { startAt, endAt };
  }
  private assertBooking(resource: CalendarResource, event: CalendarEvent) {
    if (!resource.isActive || resource.isDeleted) throw new AppError('RESOURCE_INACTIVE', 'The resource is inactive.', 409);
    if (event.recurrenceParentEventId) throw new AppError('RECURRENCE_SCOPE_INVALID', 'Manage reservations through the parent Event.', 400);
    if (resource.capacity !== null && this.party(event) > resource.capacity) throw new AppError('RESOURCE_CAPACITY_INVALID', 'The Event exceeds resource capacity.', 400);
    const holds = this.state.calendarBookings.filter(row => row.workspaceId === event.workspaceId && row.eventId !== event.id &&
      ['PENDING', 'CONFIRMED'].includes(row.status) && row.resourceIds?.includes(resource.id));
    if (holds.length > 1000) throw new AppError('AVAILABILITY_UNAVAILABLE', 'Resource hold validation exceeds its synchronous budget.', 409);
    const occurrences = this.projection(event, holds.map(row => ({ startAt: row.reservedStartAt, endAt: row.reservedEndAt })))
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    for (const [index, range] of occurrences.entries()) {
      const working = this.schedules.windows(resource.workspaceId, null, range).intervals;
      if (!working.some(window => window.startAt <= range.startAt && window.endAt >= range.endAt))
        throw new AppError('RESOURCE_BOOKING_CONFLICT', 'The resource is outside its configured working hours.', 409);
      if (resource.isExclusive && (index > 0 && overlap(occurrences[index - 1], range) || this.busy(resource.id, range, event.id).length))
        throw new AppError('RESOURCE_BOOKING_CONFLICT', 'The resource is already reserved for this interval.', 409);
      if (holds.some(row => overlap(range, { startAt: row.reservedStartAt, endAt: row.reservedEndAt })))
        throw new AppError('BOOKING_SLOT_UNAVAILABLE', 'The resource conflicts with a Booking reservation.', 409);
    }
    return this.range(event);
  }
  update(actor: ActorContext, id: string, body: Body, replace = false, ifMatch?: number) {
    const row = this.resource(actor, id, true); body.only([...EDITABLE, 'version']); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const values = this.values(body, row, replace), candidate = { ...row, ...values };
    if (candidate.isActive) {
      const active = this.roots().filter((item) => item.resourceId === id && item.status === 'ACTIVE');
      for (const booking of active) {
        const event = this.state.calendarEvents.find((item) => item.id === booking.eventId)!;
        this.assertBooking(candidate, event);
      }
    }
    const before = { ...row }; Object.assign(row, values); this.support.touch(row);
    for (const booking of this.state.calendarResourceBookings.filter((item) => item.resourceId === id && item.status === 'ACTIVE')) {
      booking.exclusive = row.isExclusive; booking.updatedAt = this.support.now();
      if (!row.isActive) { booking.status = 'CANCELLED'; this.emit(actor, row, 'RESOURCE_BOOKING_CANCELLED', booking); }
    }
    this.support.audit(actor, row.workspaceId, 'RESOURCE.UPDATED', 'CALENDAR_RESOURCE', id, before, row); return row;
  }
  remove(actor: ActorContext, id: string) {
    const row = this.resource(actor, id, true), before = { ...row };
    row.isDeleted = true; row.isActive = false; this.support.touch(row);
    for (const booking of this.state.calendarResourceBookings.filter((item) => item.resourceId === id && item.status === 'ACTIVE')) {
      booking.status = 'CANCELLED'; booking.updatedAt = this.support.now(); this.emit(actor, row, 'RESOURCE_BOOKING_CANCELLED', booking);
    }
    this.support.audit(actor, row.workspaceId, 'RESOURCE.DELETED', 'CALENDAR_RESOURCE', id, before, null); return { id, deleted: true };
  }
  book(actor: ActorContext, eventId: string, body: Body) {
    const event = this.events.eventOf(actor, eventId); this.events.assertResourceManage(actor, event);
    this.support.require(actor, 'resource.book'); body.only(['resourceId']);
    const resource = this.resource(actor, body.uuid('resourceId', { required: true }));
    return this.acquire(actor, event, resource);
  }
  /** A Booking's live host authorizes its selected resources; approvers need no
   * independent Event editing grant. Public bodies cannot select resource IDs. */
  bookForBooking(booking: CalendarBooking, host: ActorContext) {
    if (!this.state.calendarBookings.includes(booking) || booking.status !== 'CONFIRMED' || host.workspaceId !== booking.workspaceId || host.user.id !== booking.ownerUserId)
      throw new AppError('BOOKING_STATE_INVALID', 'The resource reservation cannot be finalized.', 409);
    const event = this.state.calendarEvents.find(row => row.id === booking.eventId && row.workspaceId === booking.workspaceId && row.organizerUserId === booking.ownerUserId);
    if (!event) throw new AppError('BOOKING_EVENT_MANAGED', 'The Booking Event is unavailable.', 409);
    for (const id of booking.resourceIds ?? []) {
      this.support.require(host, 'resource.book');
      this.acquire(host, event, this.resource(host, id));
    }
  }
  private acquire(actor: ActorContext, event: CalendarEvent, resource: CalendarResource) {
    const eventId = event.id, range = this.assertBooking(resource, event);
    let row = this.roots().find((item) => item.eventId === eventId && item.resourceId === resource.id);
    if (row?.status === 'ACTIVE') return row;
    const now = this.support.now();
    if (row) Object.assign(row, range, { status: 'ACTIVE', exclusive: resource.isExclusive, updatedAt: now });
    else { row = { id: this.support.id(), workspaceId: actor.workspaceId, resourceId: resource.id, eventId, ...range, status: 'ACTIVE', exclusive: resource.isExclusive, createdAt: now, updatedAt: now }; this.state.calendarResourceBookings.push(row); }
    this.materialize(row, event);
    this.emit(actor, resource, 'RESOURCE_BOOKED', row); return row;
  }
  unbook(actor: ActorContext, eventId: string, resourceId: string) {
    const event = this.events.eventOf(actor, eventId); this.events.assertResourceManage(actor, event, true); this.support.require(actor, 'resource.book');
    const resource = this.resource(actor, resourceId), row = this.roots().find((item) => item.eventId === eventId && item.resourceId === resourceId);
    if (this.state.calendarBookings.some(booking => booking.eventId === eventId && booking.status === 'CONFIRMED' && booking.resourceIds?.includes(resourceId)))
      throw new AppError('BOOKING_EVENT_MANAGED', 'Release the selected resource through its Booking.', 409);
    if (row?.status === 'ACTIVE') {
      for (const item of this.state.calendarResourceBookings.filter(item => item.id === row.id || item.seriesBookingId === row.id)) {
        item.status = 'CANCELLED'; item.updatedAt = this.support.now();
      }
      this.emit(actor, resource, 'RESOURCE_BOOKING_CANCELLED', row);
    }
    return { resourceId, cancelled: true };
  }
  validateEvent(event: CalendarEvent) {
    if (event.status === 'CANCELLED' || event.isDeleted) return;
    for (const booking of this.roots().filter((row) => row.eventId === event.id && row.status === 'ACTIVE')) {
      this.assertBooking(this.state.calendarResources.find((row) => row.id === booking.resourceId)!, event);
    }
  }
  validateParty(event: CalendarEvent, size: number) {
    for (const booking of this.roots().filter((row) => row.eventId === event.id && row.status === 'ACTIVE')) {
      const resource = this.state.calendarResources.find((row) => row.id === booking.resourceId)!;
      if (resource.capacity !== null && size > resource.capacity) throw new AppError('RESOURCE_CAPACITY_INVALID', 'The Event exceeds resource capacity.', 400);
    }
  }
  reconcile(event: CalendarEvent) {
    this.validateEvent(event);
    for (const row of this.roots().filter((item) => item.eventId === event.id && item.status === 'ACTIVE')) {
      if (event.isDeleted || event.status === 'CANCELLED') {
        for (const item of this.state.calendarResourceBookings.filter(item => item.id === row.id || item.seriesBookingId === row.id)) item.status = 'CANCELLED';
        this.emit(null, this.state.calendarResources.find((resource) => resource.id === row.resourceId)!, 'RESOURCE_BOOKING_CANCELLED', row);
      }
      else this.materialize(row, event);
      row.updatedAt = this.support.now();
    }
  }
  availability(actor: ActorContext, id: string, query: URLSearchParams) {
    const resource = this.resource(actor, id), body = new Body(Object.fromEntries(query));
    body.only(['startAt', 'endAt']);
    let startAt: Date, endAt: Date;
    try { startAt = body.instant('startAt', { required: true }); endAt = body.instant('endAt', { required: true }); }
    catch { throw new AppError('AVAILABILITY_INVALID_RANGE', 'Supply offset-aware startAt and endAt.', 400); }
    if (!['startAt', 'endAt'].every((key) => isCalendarDate(String(body.raw[key]).slice(0, 10)))) throw new AppError('AVAILABILITY_INVALID_RANGE', 'Use valid calendar dates.', 400);
    if (endAt <= startAt || endAt.getTime() - startAt.getTime() > 93 * 86_400_000) throw new AppError('AVAILABILITY_INVALID_RANGE', 'Use a positive range of at most 93 days.', 400);
    const intervals = mergeIntervals([...this.busy(id, { startAt, endAt }, undefined, true), ...this.state.calendarBookings
      .filter(row => row.workspaceId === resource.workspaceId && row.resourceIds?.includes(id) && ['PENDING', 'CONFIRMED'].includes(row.status))
      .flatMap(row => {
        const interval = { startAt: new Date(Math.max(row.reservedStartAt.getTime(), startAt.getTime())), endAt: new Date(Math.min(row.reservedEndAt.getTime(), endAt.getTime())) };
        return interval.endAt > interval.startAt ? [interval] : [];
      })]);
    const working = this.schedules.windows(actor.workspaceId, null, { startAt, endAt });
    return { resourceId: id, isActive: resource.isActive, startAt, endAt, busy: intervals.map((row) => ({ ...row, state: 'BUSY' })),
      working: working.intervals, free: resource.isActive ? subtractIntervals(working.intervals, intervals) : [], scheduleSource: working.source };
  }
  private emit(actor: ActorContext | null, resource: CalendarResource, type: string, booking?: CalendarResourceBooking) {
    this.support.event({ workspaceId: resource.workspaceId, type, entityType: 'CALENDAR_RESOURCE', entityId: resource.id,
      actorUserId: actor?.user.id ?? null, changes: booking ? { bookingId: booking.id, eventId: booking.eventId } : { version: resource.version } });
  }
}
