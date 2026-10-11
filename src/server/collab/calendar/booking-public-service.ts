import { AppError } from '../../errors';
import { Body, type CollabSupport, isCalendarDate, isIanaTimezone } from '../support';
import type { CalendarBookingPageService } from './booking-page-service';
import type { CalendarAvailabilityService } from './availability-service';
import type { WorkingScheduleService } from './working-schedule-service';
import type { CalendarBooking } from './booking-types';
import { bookingUserIds } from './booking-subjects';
import { intersectIntervals, mergeIntervals, subtractIntervals, type Interval } from './availability-types';

const DAY = 86_400_000;
const invalid = () => new AppError('AVAILABILITY_INVALID_RANGE', 'Supply a positive offset-aware range within 31 days and a valid display timezone.', 400);
export class CalendarBookingPublicService {
  constructor(private readonly support: CollabSupport, private readonly pages: CalendarBookingPageService,
    private readonly availability: CalendarAvailabilityService, private readonly schedules: WorkingScheduleService) {}
  slots(slug: string, query: URLSearchParams, excluding?: CalendarBooking) {
    const { page, rules } = this.pages.published(slug), body = new Body(Object.fromEntries(query));
    const userIds = excluding ? bookingUserIds(this.support.state, excluding) : [...new Set([page.ownerUserId, ...(page.attendeeUserIds ?? [])])];
    const resourceIds = excluding?.resourceIds ?? page.resourceIds ?? [];
    if (excluding) {
      const host = this.support.access.actor(this.support.state.users.find(row => row.id === page.ownerUserId)!, page.workspaceId);
      this.pages.assertSubjects(host, { ownerUserId: page.ownerUserId, attendeeUserIds: userIds.filter(id => id !== page.ownerUserId), resourceIds });
    }
    body.only(['startAt', 'endAt', 'timezone', 'limit']);
    let startAt: Date, endAt: Date, timezone: string, limit: number;
    try {
      startAt = body.instant('startAt', { required: true }); endAt = body.instant('endAt', { required: true });
      if (!['startAt', 'endAt'].every((key) => isCalendarDate(String(body.raw[key]).slice(0, 10))) || endAt <= startAt || endAt.getTime() - startAt.getTime() > 31 * DAY) throw invalid();
      const display = body.str('timezone', { required: body.has('timezone'), max: 100 });
      if (display && !isIanaTimezone(display)) throw invalid();
      timezone = page.timezonePolicy === 'INVITEE' ? display ?? page.timezone : page.timezone;
      const rawLimit = query.get('limit'); limit = rawLimit === null ? 20 : Number(rawLimit);
      if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
    } catch { throw invalid(); }
    const now = this.support.now().getTime(), duration = page.durationMinutes * 60_000;
    const effective = { startAt: new Date(Math.max(startAt.getTime(), now + page.minNoticeMinutes * 60_000)),
      endAt: new Date(Math.min(endAt.getTime(), now + page.maxAdvanceDays * DAY)) };
    const base = { startAt, endAt, durationMinutes: page.durationMinutes, timezone };
    if (effective.endAt <= effective.startAt) return { ...base, slots: [] as Interval[], pending: false, retryAfterSeconds: null };
    const before = page.bufferBeforeMinutes * 60_000, after = page.bufferAfterMinutes * 60_000;
    const expanded = { startAt: new Date(effective.startAt.getTime() - before), endAt: new Date(effective.endAt.getTime() + after) };
    const busy: Interval[] = []; let pending = false;
    // Buffers can extend a 31-day request. Tile reads so every durable recurrence rebuild stays within its budget.
    for (let from = expanded.startAt.getTime(); from < expanded.endAt.getTime(); from += 31 * DAY) {
      const snapshot = this.availability.bookingSubjects(page.workspaceId, userIds, resourceIds,
        { startAt: new Date(from), endAt: new Date(Math.min(from + 31 * DAY, expanded.endAt.getTime())) }, excluding);
      pending ||= snapshot.pending;
      if (!snapshot.pending) busy.push(...snapshot.users.flatMap(row => row.busy), ...snapshot.resources.flatMap(row => row.busy));
    }
    if (pending) return { ...base, slots: [] as Interval[], pending: true, retryAfterSeconds: 5 };
    let working = this.schedules.scheduleWindows(rules, expanded);
    for (const id of userIds) working = intersectIntervals(working, this.schedules.windows(page.workspaceId, id, expanded).intervals);
    if (resourceIds.length) working = intersectIntervals(working, this.schedules.windows(page.workspaceId, null, expanded).intervals);
    const interiors = working.map((window) => ({ startAt: new Date(window.startAt.getTime() + before), endAt: new Date(window.endAt.getTime() - after) }))
      .filter((window) => window.endAt > window.startAt);
    const expandedBusy = mergeIntervals(busy.map((window) => ({ startAt: new Date(window.startAt.getTime() - after), endAt: new Date(window.endAt.getTime() + before) })));
    const free = intersectIntervals(subtractIntervals(interiors, expandedBusy), [effective]);
    const slots: Interval[] = [], step = 15 * 60_000;
    for (const window of free) {
      let start = startAt.getTime() + Math.ceil((window.startAt.getTime() - startAt.getTime()) / step) * step;
      while (start + duration <= window.endAt.getTime() && slots.length < limit) {
        slots.push({ startAt: new Date(start), endAt: new Date(start + duration) }); start += step;
      }
      if (slots.length >= limit) break;
    }
    return { ...base, slots, pending: false, retryAfterSeconds: null };
  }
}
