import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { FilePort } from '../../ports';
import type { TasksProjectsModule } from '../tasks';
import type { BindingTargetResolver } from '../tasks/ports';
import { Body, isCalendarDate, isIanaTimezone, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { CollabSupport } from '../support';
import type { CalendarService } from './calendar-service';
import type { CalendarEvent, CalendarExternalGuest, MeetingRecord } from './event-types';
import type { CalendarBooking } from './booking-types';
import { CALENDAR_LEVELS } from './types';

const EDITABLE = ['title', 'description', 'location', 'isAllDay', 'startAt', 'endAt', 'startDate', 'endDate', 'sourceTimezone', 'status', 'busyStatus', 'fileIds'];
const CRM_TYPES = ['LEAD', 'DEAL', 'CONTACT', 'COMPANY'];
export class CalendarEventService {
  private readonly bindingResolvers = new Map<string, BindingTargetResolver>();
  private readonly changeListeners: Array<(event: CalendarEvent) => void> = [];
  private readonly beforeChangeListeners: Array<(event: CalendarEvent) => void> = [];
  private readonly partyListeners: Array<(event: CalendarEvent, size: number, participantIds: string[]) => void> = [];
  beforePartyChange(listener: (event: CalendarEvent, size: number, participantIds: string[]) => void) { this.partyListeners.push(listener); }
  beforeChange(listener: (event: CalendarEvent) => void) { this.beforeChangeListeners.push(listener); }
  validateChange(event: CalendarEvent) {
    const booking = this.state.calendarBookings.find((row) => row.eventId === event.id);
    if (booking && (event.workspaceId !== booking.workspaceId || event.calendarId !== booking.calendarId || event.organizerUserId !== booking.ownerUserId ||
      event.isAllDay || event.recurrenceRuleId || event.recurrenceParentEventId || event.startAt?.getTime() !== booking.startAt.getTime() ||
      event.endAt?.getTime() !== booking.endAt.getTime() || booking.status === 'CONFIRMED' && (event.isDeleted || event.status === 'CANCELLED' || event.busyStatus !== 'BUSY') ||
      booking.status === 'CANCELLED' && !event.isDeleted && event.status !== 'CANCELLED'))
      throw new AppError('BOOKING_EVENT_MANAGED', 'Change the Event through its Booking.', 409);
    for (const listener of this.beforeChangeListeners) listener(event);
  }
  onChange(listener: (event: CalendarEvent) => void) { this.changeListeners.push(listener); }
  constructor(private readonly support: CollabSupport, private readonly calendars: CalendarService,
    private readonly tasks: TasksProjectsModule, private readonly files: () => FilePort) {}
  private get state() { return this.support.state; }
  registerBindingResolver(resolver: BindingTargetResolver) { this.bindingResolvers.set(resolver.entityType, resolver); }
  private calendar(event: CalendarEvent) {
    const c = this.state.calendars.find((row) => row.id === event.calendarId && row.workspaceId === event.workspaceId && !row.isDeleted);
    if (!c) throw notFoundError('EVENT_NOT_FOUND', 'Event');
    return c;
  }
  canRead(actor: ActorContext, event: CalendarEvent): boolean {
    if (event.workspaceId !== actor.workspaceId || event.isDeleted || !this.support.scope(actor, 'event.read')) return false;
    if (event.recurrenceParentEventId) {
      const parent = this.state.calendarEvents.find((row) => row.id === event.recurrenceParentEventId && !row.recurrenceParentEventId);
      return Boolean(parent && this.canRead(actor, parent));
    }
    const c = this.state.calendars.find((row) => row.id === event.calendarId && row.workspaceId === actor.workspaceId && !row.isDeleted);
    return Boolean(c && (actor.role.isOwnerRole || event.organizerUserId === actor.user.id ||
      this.state.calendarEventAttendees.some((row) => row.eventId === event.id && row.userId === actor.user.id && !row.removedAt) ||
      this.calendars.policy.level(actor, c)));
  }
  eventOf(actor: ActorContext, id: string) {
    this.support.require(actor, 'event.read');
    const event = this.state.calendarEvents.find((row) => row.id === id && this.canRead(actor, row));
    if (!event) throw notFoundError('EVENT_NOT_FOUND', 'Event');
    return event;
  }
  private canEdit(actor: ActorContext, event: CalendarEvent) {
    const level = this.calendars.policy.level(actor, this.calendar(event));
    return Boolean(level && (CALENDAR_LEVELS.indexOf(level) >= CALENDAR_LEVELS.indexOf('EDIT_ALL') ||
      level === 'EDIT_OWN' && event.organizerUserId === actor.user.id));
  }
  private requireEdit(actor: ActorContext, event: CalendarEvent, permission: string) {
    this.support.require(actor, permission);
    if (!this.canEdit(actor, event)) throw forbidden('Calendar permissions do not allow editing this Event.');
  }
  private writable(event: CalendarEvent, allowCancelled = false) {
    if (event.recurrenceParentEventId) throw new AppError('RECURRENCE_SCOPE_INVALID', 'Edit this occurrence through its parent recurrence.', 400);
    const c = this.calendar(event);
    this.calendars.policy.assertWritable(c);
    if (!c.isActive) throw new AppError('CALENDAR_INACTIVE', 'The Calendar is inactive.', 409);
    if (event.status === 'CANCELLED' && !allowCancelled) throw new AppError('EVENT_CANCELLED', 'The Event is cancelled.', 409);
  }
  assertReminderManage(actor: ActorContext, event: CalendarEvent) {
    this.support.require(actor, 'event.reminder_manage'); this.writable(event);
  }
  assertReminderRecipientManage(actor: ActorContext, event: CalendarEvent) {
    this.requireEdit(actor, event, 'event.update');
  }
  assertResourceManage(actor: ActorContext, event: CalendarEvent, allowCancelled = false) {
    this.requireEdit(actor, event, 'event.update'); this.writable(event, allowCancelled);
  }
  private publish(event: CalendarEvent, actor: ActorContext | null, type: string, changes: Record<string, unknown> = {}) {
    for (const listener of this.changeListeners) listener(event);
    const audience = this.state.calendarEventAttendees.filter((row) => row.eventId === event.id && !row.removedAt).map((row) => row.userId);
    this.support.event({ workspaceId: event.workspaceId, type, entityType: 'CALENDAR_EVENT', entityId: event.id,
      actorUserId: actor?.user.id ?? null, changes, audienceUserIds: type === 'CALENDAR_GUEST_INVITED'
        ? [...new Set([event.organizerUserId, ...(actor ? [actor.user.id] : [])])]
        : [...new Set([event.organizerUserId, ...audience])] });
    this.state.calendarEventHistory.push({ id: this.support.id(), workspaceId: event.workspaceId, eventId: event.id,
      actorUserId: actor?.user.id ?? null, action: type, changes: JSON.parse(JSON.stringify(changes)), occurredAt: this.support.now() });
  }
  /** Internal Booking domain port. HTTP Event authority never reaches this method. */
  confirmBooking(booking: CalendarBooking, host: ActorContext, title: string, timezone: string, actor: ActorContext | null) {
    if (!this.state.calendarBookings.includes(booking) || booking.status !== 'CONFIRMED' || booking.eventId ||
      host.workspaceId !== booking.workspaceId || host.user.id !== booking.ownerUserId)
      throw new AppError('BOOKING_STATE_INVALID', 'The Booking cannot be confirmed.', 409);
    const calendar = this.calendars.policy.calendar(host, booking.calendarId);
    this.calendars.policy.requireLevel(host, calendar, 'CREATE', 'event.create'); this.calendars.policy.assertWritable(calendar);
    if (!calendar.isActive) throw new AppError('BOOKING_SLOT_UNAVAILABLE', 'The target Calendar is unavailable.', 409);
    const now = this.support.now();
    const event: CalendarEvent = { id: this.support.id(), workspaceId: booking.workspaceId, calendarId: booking.calendarId,
      organizerUserId: booking.ownerUserId, title, description: null, location: null, isAllDay: false,
      startAt: booking.startAt, endAt: booking.endAt, startDate: null, endDate: null, sourceTimezone: timezone,
      status: 'CONFIRMED', busyStatus: 'BUSY', recurrenceRuleId: null, recurrenceParentEventId: null, recurrenceIdentity: null,
      statusBeforeCancel: null, cancelledAt: null, isDeleted: false, deletedAt: null, version: 1, createdAt: now, updatedAt: now };
    booking.eventId = event.id;
    try { this.validateChange(event); this.validateParty(event, booking.attendeeUserIds ?? [], undefined, 1); }
    catch (error) { booking.eventId = null; throw error; }
    this.state.calendarEvents.push(event); booking.eventId = event.id; this.addAttendeeRow(event, booking.ownerUserId);
    for (const id of booking.attendeeUserIds ?? []) this.addAttendeeRow(event, id);
    const guest: CalendarExternalGuest = { id: this.support.id(), workspaceId: booking.workspaceId, eventId: event.id,
      email: booking.guestEmail, name: booking.guestName, response: 'ACCEPTED', inviteTokenHash: null, removedAt: null, createdAt: now };
    this.state.calendarExternalGuests.push(guest);
    this.publish(event, actor, 'CALENDAR_EVENT_CREATED', { ...this.snapshot(event), bookingId: booking.id });
    return event;
  }
  /** Contact edits use Booking authority and preserve time, attendee and resource reservations. */
  updateBookingGuest(booking: CalendarBooking, contact: { guestName: string; guestEmail: string }, actor: ActorContext) {
    if (!this.state.calendarBookings.includes(booking) || booking.status !== 'CONFIRMED' || actor.workspaceId !== booking.workspaceId)
      throw new AppError('BOOKING_STATE_INVALID', 'The Booking guest cannot be edited.', 409);
    const event = this.state.calendarEvents.find(row => row.id === booking.eventId && row.workspaceId === booking.workspaceId &&
      row.calendarId === booking.calendarId && row.organizerUserId === booking.ownerUserId && !row.isDeleted && row.status !== 'CANCELLED' &&
      !row.recurrenceRuleId && !row.recurrenceParentEventId);
    const guest = event && this.state.calendarExternalGuests.find(row => row.eventId === event.id && row.workspaceId === booking.workspaceId &&
      row.email === booking.guestEmail && !row.removedAt);
    if (!event || !guest) throw new AppError('BOOKING_EVENT_MANAGED', 'The Booking guest is unavailable.', 409);
    if (this.state.calendarExternalGuests.some(row => row.id !== guest.id && row.eventId === event.id && row.email === contact.guestEmail))
      throw new AppError('BOOKING_GUEST_CONFLICT', 'Another Event guest already uses this email address.', 409);
    const before = { name: guest.name, email: guest.email };
    guest.name = contact.guestName; guest.email = contact.guestEmail;
    // Invitation capabilities for the previous address may never survive reassignment.
    guest.inviteTokenHash = null;
    this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { bookingId: booking.id, version: event.version,
      guestUpdated: guest.id, before, after: { name: guest.name, email: guest.email } });
  }
  cancelBooking(booking: CalendarBooking, actor: ActorContext | null) {
    if (!this.state.calendarBookings.includes(booking) || booking.status !== 'CANCELLED')
      throw new AppError('BOOKING_STATE_INVALID', 'The Booking cannot be cancelled.', 409);
    if (!booking.eventId) return;
    const event = this.state.calendarEvents.find((row) => row.id === booking.eventId && row.workspaceId === booking.workspaceId &&
      row.calendarId === booking.calendarId && row.organizerUserId === booking.ownerUserId && !row.recurrenceRuleId && !row.recurrenceParentEventId);
    if (!event) throw new AppError('BOOKING_EVENT_MANAGED', 'The Booking Event is unavailable.', 409);
    if (event.status === 'CANCELLED') return;
    event.statusBeforeCancel = event.status; event.status = 'CANCELLED'; event.cancelledAt = this.support.now(); this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_CANCELLED', { bookingId: booking.id, version: event.version });
  }
  rescheduleBooking(booking: CalendarBooking, timezone: string, actor: ActorContext | null) {
    if (!this.state.calendarBookings.includes(booking) || booking.status !== 'CONFIRMED')
      throw new AppError('BOOKING_STATE_INVALID', 'The Booking cannot be rescheduled.', 409);
    const event = this.state.calendarEvents.find((row) => row.id === booking.eventId && row.workspaceId === booking.workspaceId &&
      row.calendarId === booking.calendarId && row.organizerUserId === booking.ownerUserId && !row.isDeleted && row.status !== 'CANCELLED' &&
      !row.recurrenceRuleId && !row.recurrenceParentEventId);
    if (!event) throw new AppError('BOOKING_EVENT_MANAGED', 'The Booking Event is unavailable.', 409);
    const values = { startAt: booking.startAt, endAt: booking.endAt, sourceTimezone: timezone };
    this.validateChange({ ...event, ...values }); Object.assign(event, values); this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { bookingId: booking.id, version: event.version, ...values });
  }
  private snapshot(event: CalendarEvent) {
    return { calendarId: event.calendarId, organizerUserId: event.organizerUserId, title: event.title,
      description: event.description, location: event.location, isAllDay: event.isAllDay,
      startAt: event.startAt, endAt: event.endAt, startDate: event.startDate, endDate: event.endDate,
      sourceTimezone: event.sourceTimezone, status: event.status, busyStatus: event.busyStatus,
      fileIds: this.state.calendarEventFiles.filter((row) => row.eventId === event.id).map((row) => row.fileId) };
  }
  view(actor: ActorContext, event: CalendarEvent) {
    const parent = event.recurrenceParentEventId ? this.state.calendarEvents.find((row) => row.id === event.recurrenceParentEventId) : null;
    const exception = parent ? this.state.calendarRecurrenceExceptions.find((row) => row.overrideEventId === event.id) : null;
    const cancelled = parent?.status === 'CANCELLED' || exception?.exceptionType === 'CANCELLED';
    return { ...event, ...(cancelled ? { status: 'CANCELLED' as const, cancelledAt: parent?.cancelledAt ?? exception?.updatedAt ?? null } : {}),
      fileIds: this.state.calendarEventFiles.filter((row) => row.eventId === (event.recurrenceParentEventId ?? event.id) &&
      this.files().check(event.workspaceId, actor, row.fileId) === 'OK').map((row) => row.fileId) };
  }
  get(actor: ActorContext, id: string) { return this.view(actor, this.eventOf(actor, id)); }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'event.read');
    const page = pageOf(this.state.calendarEvents.filter((row) => !row.recurrenceParentEventId && this.canRead(actor, row)), query, {
      searchable: ['title', 'description', 'location'], filterable: ['calendarId', 'organizerUserId', 'status', 'busyStatus', 'isAllDay', 'startAt', 'endAt', 'startDate', 'endDate'],
      sortable: ['title', 'startAt', 'startDate', 'createdAt', 'updatedAt'], defaultSort: 'createdAt',
    });
    return { ...page, data: page.data.map((row) => this.view(actor, row)) };
  }
  private range(body: Body, previous?: CalendarEvent, replace = false) {
    const isAllDay = body.bool('isAllDay', replace ? { required: true } : {}) ?? previous?.isAllDay ?? false;
    const sameMode = previous?.isAllDay === isAllDay && !replace;
    const invalid = (allDay: boolean) => new AppError(allDay ? 'EVENT_ALL_DAY_INVALID' : 'EVENT_INVALID_TIME_RANGE',
      allDay ? 'All-day Events require an exclusive end date after their start date and no timed instants.' : 'Timed Events require offset-aware startAt < endAt and no all-day dates.', 400);
    if (isAllDay) {
      if (['startAt', 'endAt'].some((key) => body.has(key) && body.raw[key] != null)) throw invalid(true);
      const startDate = body.has('startDate') ? body.raw.startDate : sameMode ? previous!.startDate : null;
      const endDate = body.has('endDate') ? body.raw.endDate : sameMode ? previous!.endDate : null;
      if (typeof startDate !== 'string' || typeof endDate !== 'string' || !isCalendarDate(startDate) || !isCalendarDate(endDate) || endDate <= startDate) throw invalid(true);
      return { isAllDay, startAt: null, endAt: null, startDate, endDate };
    }
    if (['startDate', 'endDate'].some((key) => body.has(key) && body.raw[key] != null)) throw invalid(false);
    const instant = (key: string, fallback: Date | null) => {
      if (!body.has(key)) return fallback;
      const value = body.raw[key];
      if (typeof value !== 'string' || !isCalendarDate(value.slice(0, 10))) throw invalid(false);
      try { return body.instant(key, { required: true }); } catch { throw invalid(false); }
    };
    const startAt = instant('startAt', sameMode ? previous!.startAt : null), endAt = instant('endAt', sameMode ? previous!.endAt : null);
    if (!startAt || !endAt || endAt <= startAt) throw invalid(false);
    return { isAllDay, startAt, endAt, startDate: null, endDate: null };
  }
  private timezone(body: Body, fallback?: string) {
    const value = body.str('sourceTimezone') ?? fallback;
    if (!isIanaTimezone(value)) throw validationError('sourceTimezone', 'sourceTimezone must be a valid IANA time zone.');
    return value;
  }
  private fileIds(actor: ActorContext, body: Body): string[] | undefined {
    const input = body.array('fileIds', { max: 100 });
    if (!input) return undefined;
    return [...new Set(input.map((id) => {
      if (!isUuid(id)) throw validationError('fileIds', 'File IDs must be UUIDs.');
      const normalized = id.toLowerCase(), check = this.files().check(actor.workspaceId, actor, normalized);
      if (check === 'UNAVAILABLE') throw new AppError('FILE_SERVICE_UNAVAILABLE', 'File references are not available.', 503);
      if (check !== 'OK') throw notFoundError('FILE_NOT_FOUND', 'File');
      return normalized;
    }))];
  }
  private replaceFiles(event: CalendarEvent, fileIds: string[]) {
    this.state.calendarEventFiles = this.state.calendarEventFiles.filter((row) => row.eventId !== event.id);
    this.state.calendarEventFiles.push(...fileIds.map((fileId) => ({ id: this.support.id(), workspaceId: event.workspaceId,
      eventId: event.id, fileId, createdAt: this.support.now() })));
  }
  private attendeeIds(actor: ActorContext, body: Body) {
    return [...new Set((body.array('attendeeUserIds', { max: 500 }) ?? []).map((id) => {
      if (!isUuid(id) || !this.support.isEligibleUser(actor.workspaceId, id.toLowerCase())) throw new AppError('EVENT_ATTENDEE_INVALID', 'Attendees must be active internal Workspace members.', 400);
      return id.toLowerCase();
    }))];
  }
  private addAttendeeRow(event: CalendarEvent, userId: string) {
    const existing = this.state.calendarEventAttendees.find((row) => row.eventId === event.id && row.userId === userId);
    if (existing && !existing.removedAt) return false;
    if (existing) Object.assign(existing, { removedAt: null, response: 'NEEDS_ACTION', respondedAt: null });
    else this.state.calendarEventAttendees.push({ id: this.support.id(), workspaceId: event.workspaceId, eventId: event.id,
      userId, response: userId === event.organizerUserId ? 'ACCEPTED' : 'NEEDS_ACTION', respondedAt: null, removedAt: null });
    return true;
  }
  create(actor: ActorContext, body: Body, idempotencyKey?: string) {
    this.support.require(actor, 'event.create');
    body.only([...EDITABLE, 'calendarId', 'organizerUserId', 'attendeeUserIds', 'bindings']);
    const key = this.support.idempotencyKey(idempotencyKey), replay = this.support.recall(actor, 'calendar.event.create', key, body.raw);
    if (replay) return this.get(actor, String(replay.eventId));
    const c = this.calendars.policy.calendar(actor, body.uuid('calendarId', { required: true }));
    this.calendars.policy.requireLevel(actor, c, 'CREATE', 'event.create');
    this.calendars.policy.assertWritable(c);
    if (!c.isActive) throw new AppError('CALENDAR_INACTIVE', 'The Calendar is inactive.', 409);
    const organizerUserId = body.uuid('organizerUserId') ?? actor.user.id;
    if (!this.support.isEligibleUser(actor.workspaceId, organizerUserId)) throw new AppError('EVENT_ATTENDEE_INVALID', 'Organizer must be an active internal Workspace member.', 400);
    if (organizerUserId !== actor.user.id) {
      this.support.requireWorkspaceScope(actor, 'event.create');
      const organizer = this.support.access.actor(this.state.users.find((row) => row.id === organizerUserId)!, actor.workspaceId);
      this.calendars.policy.requireLevel(organizer, c, 'CREATE', 'event.create');
    }
    const range = this.range(body), title = body.str('title', { required: true, max: 500 });
    const sourceTimezone = this.timezone(body, c.timezone);
    const status = body.enumOf('status', ['CONFIRMED', 'TENTATIVE'] as const) ?? 'CONFIRMED';
    const busyStatus = body.enumOf('busyStatus', ['FREE', 'BUSY'] as const) ?? 'BUSY';
    const attendees = this.attendeeIds(actor, body), fileIds = this.fileIds(actor, body) ?? [];
    const bindings = (body.array('bindings', { max: 50 }) ?? []).map((raw) => this.readBinding(actor, new Body(raw as Record<string, unknown>)));
    const now = this.support.now();
    const event: CalendarEvent = { id: this.support.id(), workspaceId: actor.workspaceId, calendarId: c.id, organizerUserId,
      title, description: body.str('description', { max: 50_000 }) ?? null, location: body.str('location', { max: 2000 }) ?? null,
      ...range, sourceTimezone, status, busyStatus, recurrenceRuleId: null, recurrenceParentEventId: null, recurrenceIdentity: null,
      statusBeforeCancel: null, cancelledAt: null,
      isDeleted: false, deletedAt: null, version: 1, createdAt: now, updatedAt: now };
    this.validateChange(event); this.validateParty(event, attendees);
    this.state.calendarEvents.push(event);
    for (const userId of new Set([organizerUserId, ...attendees])) this.addAttendeeRow(event, userId);
    this.replaceFiles(event, fileIds);
    for (const binding of bindings) this.addBindingRow(actor, event, binding);
    this.publish(event, actor, 'CALENDAR_EVENT_CREATED', { ...this.snapshot(event), attendeeUserIds: attendees });
    this.support.remember(actor, 'calendar.event.create', key, body.raw, { eventId: event.id });
    return this.view(actor, event);
  }
  update(actor: ActorContext, id: string, body: Body, replace = false, ifMatch?: number) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.update'); this.writable(event);
    body.only([...EDITABLE, 'version']);
    this.support.expectVersion(event, body.raw.version ?? ifMatch);
    const range = this.range(body, event, replace);
    if (event.recurrenceRuleId && range.isAllDay !== event.isAllDay) throw new AppError('RECURRENCE_SCOPE_INVALID', 'Remove recurrence before changing the series value type.', 400);
    const title = replace || body.has('title') ? body.str('title', { required: true, max: 500 }) : event.title;
    const description = replace || body.has('description') ? body.str('description', { max: 50_000 }) ?? null : event.description;
    const location = replace || body.has('location') ? body.str('location', { max: 2000 }) ?? null : event.location;
    const sourceTimezone = this.timezone(body, replace ? undefined : event.sourceTimezone);
    const status = body.enumOf('status', ['CONFIRMED', 'TENTATIVE'] as const) ?? (replace ? 'CONFIRMED' : event.status);
    const busyStatus = body.enumOf('busyStatus', ['FREE', 'BUSY'] as const) ?? (replace ? 'BUSY' : event.busyStatus);
    const fileIds = this.fileIds(actor, body);
    const before = this.snapshot(event);
    this.validateChange({ ...event, ...range, sourceTimezone, status, busyStatus });
    Object.assign(event, range, { title, description, location, sourceTimezone, status, busyStatus });
    if (replace || fileIds !== undefined) this.replaceFiles(event, fileIds ?? []);
    this.support.touch(event); this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { version: event.version, before, after: this.snapshot(event) });
    return this.view(actor, event);
  }
  assertRecurrenceManage(actor: ActorContext, event: CalendarEvent) {
    this.requireEdit(actor, event, 'event.update');
    this.support.require(actor, 'event.recurrence_manage');
    this.writable(event);
  }
  recordRecurrenceChange(actor: ActorContext, event: CalendarEvent, type: string, changes: Record<string, unknown>) {
    this.support.touch(event); this.publish(event, actor, type, changes);
  }
  /** Shared Event validation, with no mutation, for occurrence and THISANDFUTURE edits. */
  prepareOccurrence(base: CalendarEvent, body: Body) {
    body.only(EDITABLE.filter((key) => key !== 'fileIds'));
    return { ...this.range(body, base),
      title: body.has('title') ? body.str('title', { required: true, max: 500 }) : base.title,
      description: body.has('description') ? body.str('description', { max: 50_000 }) ?? null : base.description,
      location: body.has('location') ? body.str('location', { max: 2000 }) ?? null : base.location,
      sourceTimezone: this.timezone(body, base.sourceTimezone),
      status: body.enumOf('status', ['CONFIRMED', 'TENTATIVE'] as const) ?? (base.status === 'CANCELLED' ? 'CONFIRMED' : base.status),
      busyStatus: body.enumOf('busyStatus', ['FREE', 'BUSY'] as const) ?? base.busyStatus,
    };
  }
  saveOccurrence(parent: CalendarEvent, recurrenceIdentity: string, values: ReturnType<CalendarEventService['prepareOccurrence']>, existing?: CalendarEvent, proposedId?: string) {
    if (existing) {
      Object.assign(existing, values, { cancelledAt: null, statusBeforeCancel: null }); this.support.touch(existing); return existing;
    }
    const now = this.support.now();
    const override: CalendarEvent = { ...parent, ...values, id: proposedId ?? this.support.id(), recurrenceRuleId: null,
      recurrenceParentEventId: parent.id, recurrenceIdentity, cancelledAt: null, statusBeforeCancel: null,
      version: 1, createdAt: now, updatedAt: now };
    this.state.calendarEvents.push(override); return override;
  }
  cancel(actor: ActorContext, id: string, body: Body, restore = false, ifMatch?: number) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.cancel'); this.writable(event, true);
    body.only(['version']); this.support.expectVersion(event, body.raw.version ?? ifMatch, false);
    if (!restore && event.status === 'CANCELLED') return this.view(actor, event);
    if (restore && event.status !== 'CANCELLED') throw new AppError('EVENT_NOT_CANCELLED', 'The Event is not cancelled.', 409);
    this.validateChange({ ...event, status: restore ? event.statusBeforeCancel ?? 'CONFIRMED' : 'CANCELLED' });
    if (restore) { event.status = event.statusBeforeCancel ?? 'CONFIRMED'; event.statusBeforeCancel = null; event.cancelledAt = null; }
    else { event.statusBeforeCancel = event.status as 'CONFIRMED' | 'TENTATIVE'; event.status = 'CANCELLED'; event.cancelledAt = this.support.now(); }
    this.support.touch(event); this.publish(event, actor, restore ? 'CALENDAR_EVENT_UPDATED' : 'CALENDAR_EVENT_CANCELLED', { ...this.snapshot(event), restored: restore });
    return this.view(actor, event);
  }
  remove(actor: ActorContext, id: string) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.delete_admin'); this.writable(event, true);
    this.validateChange({ ...event, isDeleted: true });
    event.isDeleted = true; event.deletedAt = this.support.now(); this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { administrativelyDeleted: true });
    this.support.audit(actor, event.workspaceId, 'CALENDAR_EVENT.DELETED', 'CALENDAR_EVENT', id, { title: event.title, status: event.status }, null);
    return { id, deleted: true };
  }
  attendees(actor: ActorContext, id: string) {
    const event = this.eventOf(actor, id);
    return this.state.calendarEventAttendees.filter((row) => row.eventId === (event.recurrenceParentEventId ?? id) && !row.removedAt);
  }
  private validateParty(event: CalendarEvent, added: string[] = [], response?: { userId: string; value: string }, guestsAdded = 0) {
    const participants = new Set([event.organizerUserId, ...this.state.calendarEventAttendees.filter((row) => row.eventId === event.id && !row.removedAt &&
      (row.userId === response?.userId ? response.value !== 'DECLINED' : row.response !== 'DECLINED')).map((row) => row.userId), ...added]);
    const size = participants.size + guestsAdded + this.state.calendarExternalGuests.filter((row) => row.eventId === event.id && !row.removedAt && row.response !== 'DECLINED').length;
    for (const listener of this.partyListeners) listener(event, size, [...participants]);
  }
  addAttendees(actor: ActorContext, id: string, body: Body) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.attendee_manage'); this.writable(event);
    body.only(['attendeeUserIds', 'userId']);
    if (body.has('userId') && body.has('attendeeUserIds')) throw validationError('attendeeUserIds', 'Supply userId or attendeeUserIds.');
    const ids = body.has('userId') ? this.attendeeIds(actor, new Body({ attendeeUserIds: [body.uuid('userId', { required: true })] })) : this.attendeeIds(actor, body);
    if (!ids.length) throw validationError('attendeeUserIds', 'At least one attendee is required.');
    this.validateParty(event, ids.filter((userId) => !this.state.calendarEventAttendees.some((row) => row.eventId === id && row.userId === userId && !row.removedAt)));
    const added = ids.filter((userId) => this.addAttendeeRow(event, userId));
    if (added.length) { this.support.touch(event); this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { attendeesAdded: added }); }
    return this.attendees(actor, id);
  }
  removeAttendee(actor: ActorContext, id: string, userId: string) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.attendee_manage'); this.writable(event);
    if (userId === event.organizerUserId) throw new AppError('EVENT_ATTENDEE_INVALID', 'Organizer cannot be removed as an attendee.', 400);
    const row = this.state.calendarEventAttendees.find((item) => item.eventId === id && item.userId === userId && !item.removedAt);
    if (!row) throw notFoundError('EVENT_ATTENDEE_NOT_FOUND', 'Attendee');
    row.removedAt = this.support.now(); this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { attendeeRemoved: userId });
    return { removed: true };
  }
  respond(actor: ActorContext, id: string, body: Body) {
    const event = this.eventOf(actor, id); this.writable(event);
    body.only(['response']);
    const row = this.state.calendarEventAttendees.find((item) => item.eventId === id && item.userId === actor.user.id && !item.removedAt);
    if (!row) throw forbidden('Only an invited attendee may respond.');
    const response = body.enumOf('response', ['ACCEPTED', 'TENTATIVE', 'DECLINED'] as const, { required: true });
    this.validateParty(event, [], { userId: actor.user.id, value: response });
    if (row.response !== response) { row.response = response; row.respondedAt = this.support.now(); this.support.touch(event);
      this.publish(event, actor, 'CALENDAR_ATTENDEE_RESPONDED', { userId: actor.user.id, response }); }
    return row;
  }
  guests(actor: ActorContext, id: string) {
    const event = this.eventOf(actor, id);
    if (event.organizerUserId !== actor.user.id && !this.canEdit(actor, event)) throw forbidden('Guest contact details require organizer or Calendar editing access.');
    return this.state.calendarExternalGuests.filter((row) => row.eventId === (event.recurrenceParentEventId ?? id) && !row.removedAt).map(({ inviteTokenHash: _secret, ...row }) => row);
  }
  addGuest(actor: ActorContext, id: string, body: Body) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.attendee_manage'); this.writable(event);
    body.only(['email', 'name']);
    const email = body.str('email', { required: true, max: 320 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationError('email', 'email must be a valid email address.');
    const name = body.str('name', { max: 200 }) ?? null;
    let row = this.state.calendarExternalGuests.find((item) => item.eventId === id && item.email === email);
    if (row && !row.removedAt) return this.guests(actor, id).find((item) => item.id === row!.id)!;
    this.validateParty(event, [], undefined, 1);
    if (row) Object.assign(row, { name, removedAt: null, response: 'NEEDS_ACTION', inviteTokenHash: null });
    else { row = { id: this.support.id(), workspaceId: event.workspaceId, eventId: id, email, name, response: 'NEEDS_ACTION', inviteTokenHash: null,
      removedAt: null, createdAt: this.support.now() } satisfies CalendarExternalGuest; this.state.calendarExternalGuests.push(row); }
    this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_GUEST_INVITED', { guestId: row.id, email, invitation: { title: event.title, isAllDay: event.isAllDay,
      startAt: event.startAt, endAt: event.endAt, startDate: event.startDate, endDate: event.endDate, sourceTimezone: event.sourceTimezone } });
    this.support.audit(actor, event.workspaceId, 'CALENDAR_EVENT.GUEST_INVITED', 'CALENDAR_EVENT', id, null, { guestId: row.id, email });
    return this.guests(actor, id).find((item) => item.id === row!.id)!;
  }
  removeGuest(actor: ActorContext, id: string, guestId: string) {
    const event = this.eventOf(actor, id);
    this.requireEdit(actor, event, 'event.attendee_manage'); this.writable(event);
    const row = this.state.calendarExternalGuests.find((item) => item.id === guestId && item.eventId === id && !item.removedAt);
    if (!row) throw notFoundError('EVENT_GUEST_NOT_FOUND', 'Guest');
    if (this.state.calendarBookings.some(booking => booking.workspaceId === event.workspaceId && booking.eventId === event.id &&
      booking.status === 'CONFIRMED' && booking.guestEmail === row.email))
      throw new AppError('BOOKING_EVENT_MANAGED', 'Edit the Booking to change its guest.', 409);
    row.removedAt = this.support.now(); row.inviteTokenHash = null; this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { guestRemoved: guestId });
    this.support.audit(actor, event.workspaceId, 'CALENDAR_EVENT.GUEST_REMOVED', 'CALENDAR_EVENT', id, { guestId, email: row.email }, null);
    return { removed: true };
  }
  private canBind(actor: ActorContext, entityType: string, entityId: string) {
    if (CRM_TYPES.includes(entityType)) return this.support.access.canAccessCrmRecord(actor, entityType, entityId, 'read');
    if (entityType === 'TASK') { const row = this.state.tasks.find((item) => item.id === entityId && !item.isDeleted); return Boolean(row && this.tasks.policy.canViewTask(actor, row)); }
    if (entityType === 'PROJECT') { const row = this.state.projects.find((item) => item.id === entityId && !item.isDeleted); return Boolean(row && this.tasks.policy.canViewProject(actor, row)); }
    return this.bindingResolvers.get(entityType)?.canBind(actor, entityId) ?? false;
  }
  private readBinding(actor: ActorContext, body: Body) {
    body.only(['entityType', 'entityId']);
    const entityType = body.str('entityType', { required: true, max: 50 }), entityId = body.uuid('entityId', { required: true });
    if (!this.canBind(actor, entityType, entityId)) throw new AppError('EVENT_BINDING_INVALID', 'Binding target must be readable in this Workspace.', 400);
    return { entityType, entityId };
  }
  private addBindingRow(actor: ActorContext, event: CalendarEvent, binding: { entityType: string; entityId: string }) {
    const existing = this.state.calendarEventBindings.find((row) => row.eventId === event.id && row.entityType === binding.entityType && row.entityId === binding.entityId);
    if (existing) return existing;
    const row = { id: this.support.id(), workspaceId: event.workspaceId, eventId: event.id, ...binding, createdByUserId: actor.user.id, createdAt: this.support.now() };
    this.state.calendarEventBindings.push(row); return row;
  }
  bindings(actor: ActorContext, id: string) {
    this.eventOf(actor, id);
    return this.state.calendarEventBindings.filter((row) => row.eventId === id && this.canBind(actor, row.entityType, row.entityId));
  }
  addBinding(actor: ActorContext, id: string, body: Body) {
    const event = this.eventOf(actor, id); this.requireEdit(actor, event, 'event.update'); this.writable(event);
    const binding = this.readBinding(actor, body), before = this.state.calendarEventBindings.length;
    const row = this.addBindingRow(actor, event, binding);
    if (before !== this.state.calendarEventBindings.length) { this.support.touch(event); this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { bindingAdded: binding }); }
    return row;
  }
  removeBinding(actor: ActorContext, id: string, bindingId: string) {
    const event = this.eventOf(actor, id); this.requireEdit(actor, event, 'event.update'); this.writable(event);
    const row = this.state.calendarEventBindings.find((item) => item.id === bindingId && item.eventId === id);
    if (!row) throw notFoundError('EVENT_BINDING_NOT_FOUND', 'Event binding');
    this.state.calendarEventBindings = this.state.calendarEventBindings.filter((item) => item !== row);
    this.support.touch(event); this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { bindingRemoved: bindingId });
    return { removed: true };
  }
  meetingRecord(actor: ActorContext, id: string) {
    this.eventOf(actor, id);
    const record = this.state.meetingRecords.find((row) => row.eventId === id) ?? { eventId: id, agenda: null, notes: null, version: 0 };
    return { ...record, decisions: this.state.meetingDecisions.filter((row) => row.eventId === id) };
  }
  putMeetingRecord(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const event = this.eventOf(actor, id); this.requireEdit(actor, event, 'event.meeting_record_manage'); this.writable(event);
    body.only(['agenda', 'notes', 'version']);
    let record = this.state.meetingRecords.find((row) => row.eventId === id);
    this.support.expectVersion(record ?? { version: 0 }, body.raw.version ?? ifMatch);
    const agenda = body.str('agenda', { max: 50_000 }) ?? null, notes = body.str('notes', { max: 100_000 }) ?? null;
    const before = record ? { agenda: record.agenda, notes: record.notes } : null;
    if (record) { Object.assign(record, { agenda, notes, updatedByUserId: actor.user.id }); this.support.touch(record); }
    else { const now = this.support.now(); record = { id: this.support.id(), workspaceId: event.workspaceId, eventId: id, agenda, notes,
      updatedByUserId: actor.user.id, version: 1, createdAt: now, updatedAt: now } satisfies MeetingRecord; this.state.meetingRecords.push(record); }
    this.support.touch(event); this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { meetingRecordChanged: true });
    this.support.audit(actor, event.workspaceId, 'CALENDAR_EVENT.MEETING_RECORD_CHANGED', 'CALENDAR_EVENT', id, before, { agenda, notes });
    return this.meetingRecord(actor, id);
  }
  addDecision(actor: ActorContext, id: string, body: Body, idempotencyKey?: string) {
    const event = this.eventOf(actor, id); this.requireEdit(actor, event, 'event.meeting_record_manage'); this.writable(event);
    body.only(['text']);
    const key = this.support.idempotencyKey(idempotencyKey), operation = `calendar.meeting.decision:${id}`;
    const replay = this.support.recall(actor, operation, key, body.raw);
    if (replay) return this.state.meetingDecisions.find((row) => row.id === replay.decisionId)!;
    const row = { id: this.support.id(), workspaceId: event.workspaceId, eventId: id, text: body.str('text', { required: true, max: 20_000 }),
      createdByUserId: actor.user.id, createdAt: this.support.now() };
    this.state.meetingDecisions.push(row); this.support.touch(event);
    this.publish(event, actor, 'CALENDAR_EVENT_UPDATED', { meetingDecisionId: row.id });
    this.support.audit(actor, event.workspaceId, 'CALENDAR_EVENT.MEETING_DECISION_ADDED', 'CALENDAR_EVENT', id, null, { decisionId: row.id, text: row.text });
    this.support.remember(actor, operation, key, body.raw, { decisionId: row.id });
    return row;
  }
}
