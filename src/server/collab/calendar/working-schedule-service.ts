import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isCalendarDate, isIanaTimezone, notFoundError } from '../support';
import { addDays, isoWeekday, isLocalTime, localDate } from '../time';
import { recurrenceInstant } from './recurrence-engine';
import { intersectIntervals, mergeIntervals, type Interval, type WorkingSchedule, type UserWorkingSchedule, type WorkingWindow, type WorkingDateOverride } from './availability-types';

const invalid = () => new AppError('AVAILABILITY_INVALID_RANGE', 'Supply valid timezone, working windows, holidays and date overrides.', 400);
export class WorkingScheduleService {
  constructor(private readonly support: CollabSupport) {}
  private get state() { return this.support.state; }
  assertSubject(actor: ActorContext, userId: string) {
    const scope = this.support.require(actor, 'calendar.free_busy');
    if (!this.support.isEligibleUser(actor.workspaceId, userId) || !this.support.scopeCovers(actor, scope, [userId]))
      throw notFoundError('AVAILABILITY_SUBJECT_NOT_FOUND', 'Availability subject');
  }
  business(actor: ActorContext) {
    this.support.require(actor, 'calendar.free_busy');
    return this.state.businessCalendars.find((row) => row.workspaceId === actor.workspaceId) ?? null;
  }
  user(actor: ActorContext, userId: string) {
    this.assertSubject(actor, userId);
    return this.state.userWorkingSchedules.find((row) => row.workspaceId === actor.workspaceId && row.userId === userId) ?? null;
  }
  static values(body: Body) {
    body.only(['timezone', 'weekly', 'holidays', 'overrides', 'version']);
    try {
      const timezone = body.str('timezone', { required: true, max: 100 });
      if (!isIanaTimezone(timezone)) throw invalid();
      const readWindow = (raw: unknown, weekly: boolean) => {
        const window = new Body(raw as Record<string, unknown>);
        window.only(weekly ? ['dayOfWeek', 'localStartTime', 'localEndTime'] : ['localStartTime', 'localEndTime']);
        const localStartTime = window.str('localStartTime', { required: true }), localEndTime = window.str('localEndTime', { required: true });
        if (!isLocalTime(localStartTime) || !(isLocalTime(localEndTime) || localEndTime === '24:00') || localEndTime <= localStartTime) throw invalid();
        return { localStartTime, localEndTime, ...(weekly ? { dayOfWeek: window.int('dayOfWeek', { required: true, min: 1, max: 7 }) } : {}) };
      };
      const weekly = body.array('weekly', { required: true, max: 70 })!.map((raw) => readWindow(raw, true) as WorkingWindow);
      const holidays = (body.array('holidays', { max: 366 }) ?? []).map((date) => {
        if (typeof date !== 'string' || !isCalendarDate(date)) throw invalid(); return date;
      });
      const overrides = (body.array('overrides', { max: 366 }) ?? []).map((raw) => {
        const override = new Body(raw as Record<string, unknown>); override.only(['date', 'windows']);
        const date = override.date('date', { required: true });
        return { date, windows: override.array('windows', { required: true, max: 10 })!.map((value) => readWindow(value, false)) } as WorkingDateOverride;
      });
      if (new Set(overrides.map((row) => row.date)).size !== overrides.length) throw invalid();
      return { timezone, weekly, holidays: [...new Set(holidays)].sort(), overrides };
    } catch { throw invalid(); }
  }
  setBusiness(actor: ActorContext, body: Body, ifMatch?: number) {
    this.support.requireWorkspaceScope(actor, 'calendar.business_calendar_manage');
    const values = WorkingScheduleService.values(body), old = this.state.businessCalendars.find((row) => row.workspaceId === actor.workspaceId);
    this.support.expectVersion(old ?? { version: 0 }, body.raw.version ?? ifMatch);
    const before = old ? structuredClone(old) : null, now = this.support.now();
    let row: WorkingSchedule;
    if (old) { Object.assign(old, values); this.support.touch(old); row = old; }
    else { row = { id: this.support.id(), workspaceId: actor.workspaceId, ...values, version: 1, createdAt: now, updatedAt: now }; this.state.businessCalendars.push(row); }
    this.support.audit(actor, actor.workspaceId, 'BUSINESS_CALENDAR.UPDATED', 'BUSINESS_CALENDAR', row.id, before, row);
    return row;
  }
  setUser(actor: ActorContext, userId: string, body: Body, ifMatch?: number) {
    const scope = this.support.require(actor, 'calendar.working_schedule_manage');
    if (!this.support.isEligibleUser(actor.workspaceId, userId) || !this.support.scopeCovers(actor, scope, [userId]))
      throw notFoundError('AVAILABILITY_SUBJECT_NOT_FOUND', 'Availability subject');
    const values = WorkingScheduleService.values(body), old = this.state.userWorkingSchedules.find((row) => row.workspaceId === actor.workspaceId && row.userId === userId);
    this.support.expectVersion(old ?? { version: 0 }, body.raw.version ?? ifMatch);
    const before = old ? structuredClone(old) : null, now = this.support.now();
    let row: UserWorkingSchedule;
    if (old) { Object.assign(old, values); this.support.touch(old); row = old; }
    else { row = { id: this.support.id(), workspaceId: actor.workspaceId, userId, ...values, version: 1, createdAt: now, updatedAt: now }; this.state.userWorkingSchedules.push(row); }
    this.support.audit(actor, actor.workspaceId, 'WORKING_SCHEDULE.UPDATED', 'USER_WORKING_SCHEDULE', row.id, before, row);
    return row;
  }
  private expand(schedule: WorkingSchedule | undefined, range: Interval): Interval[] {
    if (!schedule) return [range]; // No working-hours restriction has been configured.
    const result: Interval[] = [];
    const lastDate = localDate(range.endAt, schedule.timezone);
    for (let date = localDate(range.startAt, schedule.timezone); date <= lastDate; date = addDays(date, 1)) {
      const override = schedule.overrides.find((row) => row.date === date);
      const windows = override ? override.windows : schedule.holidays.includes(date) ? [] : schedule.weekly.filter((row) => row.dayOfWeek === isoWeekday(date));
      for (const window of windows) {
        const startAt = recurrenceInstant(`${date}T${window.localStartTime}:00.000`, schedule.timezone);
        const endAt = window.localEndTime === '24:00' ? recurrenceInstant(`${addDays(date, 1)}T00:00:00.000`, schedule.timezone)
          : recurrenceInstant(`${date}T${window.localEndTime}:00.000`, schedule.timezone);
        // A nonexistent boundary does not create guessed availability through a DST gap.
        if (startAt && endAt && endAt > startAt) result.push({ startAt, endAt });
      }
    }
    return intersectIntervals(mergeIntervals(result), [range]);
  }
  windows(workspaceId: string, userId: string | null, range: Interval) {
    const business = this.state.businessCalendars.find((row) => row.workspaceId === workspaceId);
    const user = userId ? this.state.userWorkingSchedules.find((row) => row.workspaceId === workspaceId && row.userId === userId) : undefined;
    return { intervals: intersectIntervals(this.expand(business, range), this.expand(user, range)),
      source: user ? business ? 'USER_AND_BUSINESS' : 'USER_SCHEDULE' : business ? 'BUSINESS_CALENDAR' : 'UNRESTRICTED' };
  }
  scheduleWindows(schedule: WorkingSchedule, range: Interval) { return this.expand(schedule, range); }
}
