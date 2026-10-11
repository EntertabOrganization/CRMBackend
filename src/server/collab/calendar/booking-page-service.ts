import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isIanaTimezone, notFoundError, pageOf } from '../support';
import type { CalendarService } from './calendar-service';
import type { CalendarBookingPage, CalendarBookingPageRules } from './booking-types';
import { WorkingScheduleService } from './working-schedule-service';
import type { CalendarResourceService } from './resource-service';

const FIELDS = ['ownerUserId', 'calendarId', 'title', 'slug', 'bookingMode', 'durationMinutes', 'timezonePolicy', 'timezone',
  'requireName', 'requireEmail', 'requirePhone', 'minNoticeMinutes', 'maxAdvanceDays', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'attendeeUserIds', 'resourceIds'];
export class CalendarBookingPageService {
  constructor(private readonly support: CollabSupport, private readonly calendars: CalendarService,
    private readonly schedules: WorkingScheduleService, private readonly resources: CalendarResourceService) {}
  private get state() { return this.support.state; }
  assertSubjects(actor: ActorContext, subjects: Pick<CalendarBookingPage, 'ownerUserId' | 'attendeeUserIds' | 'resourceIds'>) {
    const users = [...new Set([subjects.ownerUserId, ...(subjects.attendeeUserIds ?? [])])];
    if (users.length + (subjects.resourceIds?.length ?? 0) > 50) throw new AppError('BOOKING_PAGE_INVALID', 'Select at most 50 availability subjects.', 400);
    for (const id of subjects.attendeeUserIds ?? []) this.schedules.assertSubject(actor, id);
    for (const id of subjects.resourceIds ?? []) {
      this.support.require(actor, 'resource.book');
      const resource = this.resources.get(actor, id);
      if (!resource.isActive || resource.capacity !== null && resource.capacity < users.length + 1)
        throw new AppError('BOOKING_PAGE_INVALID', 'A selected resource is unavailable or has insufficient capacity.', 409);
    }
  }
  private visible(actor: ActorContext, page: CalendarBookingPage, permission: string) {
    return page.workspaceId === actor.workspaceId && !page.isDeleted && this.support.scopeCovers(actor, this.support.scope(actor, permission), [page.ownerUserId]);
  }
  private page(actor: ActorContext, id: string, permission = 'booking.read') {
    this.support.require(actor, permission);
    const page = this.state.calendarBookingPages.find((row) => row.id === id && this.visible(actor, row, permission));
    if (!page) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page'); return page;
  }
  private values(actor: ActorContext, body: Body, old?: CalendarBookingPage, replace = false) {
    const full = !old || replace;
    const ownerUserId = body.uuid('ownerUserId', { required: body.has('ownerUserId') }) ?? old?.ownerUserId ?? actor.user.id;
    const permission = old ? 'booking_page.update' : 'booking_page.create';
    if (!this.support.isEligibleUser(actor.workspaceId, ownerUserId) || !this.support.scopeCovers(actor, this.support.scope(actor, permission), [ownerUserId]))
      throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page owner');
    const calendarId = body.uuid('calendarId', { required: full || body.has('calendarId') }) ?? old!.calendarId;
    const calendar = this.calendars.policy.calendar(actor, calendarId);
    this.calendars.policy.requireLevel(actor, calendar, 'CREATE', permission);
    this.calendars.policy.assertWritable(calendar);
    if (!calendar.isActive) throw new AppError('BOOKING_PAGE_INVALID', 'The target Calendar must be active.', 400);
    const title = body.str('title', { required: full || body.has('title'), max: 500 }) ?? old!.title;
    const slug = body.str('slug', { required: full || body.has('slug'), min: 3, max: 80 }) ?? old!.slug;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new AppError('BOOKING_PAGE_INVALID', 'slug must contain lowercase letters, digits and single hyphens.', 400);
    if (this.state.calendarBookingPages.some((row) => row.slug === slug && row.id !== old?.id))
      throw new AppError('BOOKING_PAGE_SLUG_CONFLICT', 'This public address is unavailable.', 409);
    const timezone = body.str('timezone', { required: body.has('timezone'), max: 100 }) ?? (full ? calendar.timezone : old!.timezone);
    if (!isIanaTimezone(timezone)) throw new AppError('BOOKING_PAGE_INVALID', 'timezone must be an IANA timezone.', 400);
    for (const key of ['requireName', 'requireEmail']) if (body.has(key) && body.bool(key, { required: true }) !== true)
      throw new AppError('BOOKING_PAGE_INVALID', 'Guest name and email are required.', 400);
    const integer = (key: 'durationMinutes' | 'minNoticeMinutes' | 'maxAdvanceDays' | 'bufferBeforeMinutes' | 'bufferAfterMinutes', min: number, max: number, fallback: number) =>
      body.int(key, { required: body.has(key) || key === 'durationMinutes' && full, min, max }) ?? (full ? fallback : old![key]);
    const attendeeUserIds = (body.uuids('attendeeUserIds', { max: 49 }) ?? (full ? [] : old?.attendeeUserIds ?? [])).filter(id => id !== ownerUserId);
    const resourceIds = body.uuids('resourceIds', { max: 49 }) ?? (full ? [] : old?.resourceIds ?? []);
    this.assertSubjects(actor, { ownerUserId, attendeeUserIds, resourceIds });
    return { ownerUserId, calendarId, title, slug, timezone, attendeeUserIds, resourceIds,
      bookingMode: body.enumOf('bookingMode', ['AUTO_CONFIRM', 'REQUIRE_APPROVAL'] as const, { required: body.has('bookingMode') }) ?? (full ? 'AUTO_CONFIRM' as const : old!.bookingMode),
      timezonePolicy: body.enumOf('timezonePolicy', ['HOST', 'INVITEE'] as const, { required: body.has('timezonePolicy') }) ?? (full ? 'HOST' as const : old!.timezonePolicy),
      durationMinutes: integer('durationMinutes', 1, 1440, 30), minNoticeMinutes: integer('minNoticeMinutes', 0, 525600, 0),
      maxAdvanceDays: integer('maxAdvanceDays', 1, 365, 90), bufferBeforeMinutes: integer('bufferBeforeMinutes', 0, 1440, 0),
      bufferAfterMinutes: integer('bufferAfterMinutes', 0, 1440, 0), requireName: true as const, requireEmail: true as const,
      requirePhone: body.bool('requirePhone', { required: body.has('requirePhone') }) ?? (full ? false : old!.requirePhone) };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'booking.read');
    return pageOf(this.state.calendarBookingPages.filter((row) => this.visible(actor, row, 'booking.read')), query,
      { searchable: ['title', 'slug'], filterable: ['status', 'ownerUserId', 'bookingMode'], sortable: ['title', 'createdAt', 'updatedAt'], defaultSort: 'createdAt' });
  }
  get(actor: ActorContext, id: string) { return this.page(actor, id); }
  /** Resolve limited public authority from a live publication, never from internal IDs or client Workspace claims. */
  published(slug: string) {
    const page = this.state.calendarBookingPages.find((row) => row.slug === slug && row.status === 'PUBLISHED' && !row.isDeleted);
    if (!page || !this.support.isEligibleUser(page.workspaceId, page.ownerUserId)) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page');
    try {
      const user = this.state.users.find((row) => row.id === page.ownerUserId)!;
      const host = this.support.access.actor(user, page.workspaceId);
      this.assertSubjects(host, page);
      const calendar = this.calendars.policy.calendar(host, page.calendarId);
      this.calendars.policy.requireLevel(host, calendar, 'CREATE', 'event.create');
      this.calendars.policy.assertWritable(calendar);
      if (!calendar.isActive) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page');
      const rules = this.state.calendarBookingPageRules.find((row) => row.pageId === page.id && row.workspaceId === page.workspaceId);
      if (!rules || !rules.weekly.length && !rules.overrides.some((row) => row.windows.length)) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page');
      return { page, rules };
    } catch (error) {
      if (error instanceof AppError) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page');
      throw error;
    }
  }
  publicView(slug: string) {
    const { page } = this.published(slug);
    return { title: page.title, slug: page.slug, durationMinutes: page.durationMinutes, bookingMode: page.bookingMode,
      timezonePolicy: page.timezonePolicy, timezone: page.timezone, requireName: page.requireName, requireEmail: page.requireEmail,
      requirePhone: page.requirePhone, minNoticeMinutes: page.minNoticeMinutes, maxAdvanceDays: page.maxAdvanceDays,
      bufferBeforeMinutes: page.bufferBeforeMinutes, bufferAfterMinutes: page.bufferAfterMinutes };
  }
  create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'booking_page.create'); body.only(FIELDS);
    const values = this.values(actor, body), now = this.support.now();
    const row: CalendarBookingPage = { id: this.support.id(), workspaceId: actor.workspaceId, createdByUserId: actor.user.id,
      ...values, status: 'DRAFT', isDeleted: false, version: 1, createdAt: now, updatedAt: now };
    this.state.calendarBookingPages.push(row); this.record(actor, row, 'CREATED', null); return row;
  }
  update(actor: ActorContext, id: string, body: Body, replace = false, ifMatch?: number) {
    const row = this.page(actor, id, 'booking_page.update'); body.only([...FIELDS, 'version']);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const values = this.values(actor, body, row, replace), before = structuredClone(row);
    Object.assign(row, values); this.support.touch(row); this.record(actor, row, 'UPDATED', before); return row;
  }
  remove(actor: ActorContext, id: string) {
    const row = this.page(actor, id, 'booking_page.update'), before = structuredClone(row);
    row.isDeleted = true; row.status = 'UNPUBLISHED'; this.support.touch(row); this.record(actor, row, 'DELETED', before);
    return { id, deleted: true };
  }
  publication(actor: ActorContext, id: string, body: Body, publish: boolean, ifMatch?: number) {
    const row = this.page(actor, id, 'booking_page.publish'); body.only(['version']); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (publish) {
      this.assertSubjects(actor, row);
      if (!this.support.isEligibleUser(row.workspaceId, row.ownerUserId)) throw new AppError('BOOKING_PAGE_INVALID', 'The host must be an active Workspace member.', 409);
      const calendar = this.calendars.policy.calendar(actor, row.calendarId);
      this.calendars.policy.assertWritable(calendar);
      if (!calendar.isActive) throw new AppError('BOOKING_PAGE_INVALID', 'The target Calendar must be active.', 409);
      const rules = this.state.calendarBookingPageRules.find((item) => item.pageId === id);
      if (!rules || !rules.weekly.length && !rules.overrides.some((item) => item.windows.length))
        throw new AppError('BOOKING_PAGE_INVALID', 'Configure availability rules before publishing.', 400);
    }
    const status = publish ? 'PUBLISHED' : 'UNPUBLISHED';
    if (row.status === status) return row;
    const before = structuredClone(row); row.status = status; this.support.touch(row); this.record(actor, row, status, before); return row;
  }
  rules(actor: ActorContext, id: string) { this.page(actor, id); return this.state.calendarBookingPageRules.find((row) => row.pageId === id) ?? null; }
  setRules(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const page = this.page(actor, id, 'booking_page.update'), values = WorkingScheduleService.values(body);
    const old = this.state.calendarBookingPageRules.find((row) => row.pageId === id);
    this.support.expectVersion(old ?? { version: 0 }, body.raw.version ?? ifMatch);
    const before = old ? structuredClone(old) : null, now = this.support.now();
    let row: CalendarBookingPageRules;
    if (old) { Object.assign(old, values); this.support.touch(old); row = old; }
    else { row = { id: this.support.id(), workspaceId: actor.workspaceId, pageId: id, ...values, version: 1, createdAt: now, updatedAt: now }; this.state.calendarBookingPageRules.push(row); }
    this.support.touch(page); this.record(actor, page, 'RULES_UPDATED', before, row); return row;
  }
  private record(actor: ActorContext, row: CalendarBookingPage, action: string, before: unknown, after: unknown = row) {
    this.support.audit(actor, row.workspaceId, `BOOKING_PAGE.${action}`, 'CALENDAR_BOOKING_PAGE', row.id, before, after);
    this.support.event({ workspaceId: row.workspaceId, type: `BOOKING_PAGE_${action}`, entityType: 'CALENDAR_BOOKING_PAGE', entityId: row.id,
      actorUserId: actor.user.id, changes: { version: row.version, status: row.status } });
  }
}
