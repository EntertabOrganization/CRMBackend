import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isCalendarDate, notFoundError } from '../support';
import { advanceRecurrence, recurrenceInstant, wallClockOf } from './recurrence-engine';
import type { CalendarEventService } from './event-service';
import type { CalendarRecurrenceService } from './recurrence-service';
import type { CalendarEvent } from './event-types';
import type { CalendarEventReminder } from './recurrence-types';

const invalidTime = () => new AppError('REMINDER_INVALID_TIME', 'Supply offsetSeconds or an offset-aware remindAt before the Event starts.', 400);
const EDITABLE = ['offsetSeconds', 'remindAt', 'channel'];

/** Calendar owns reminder configuration. Delivery remains the shared Jobs/Notifications responsibility. */
export class CalendarReminderService {
  constructor(private readonly support: CollabSupport, private readonly events: CalendarEventService,
    private readonly recurrence: CalendarRecurrenceService) {}
  private get state() { return this.support.state; }
  private event(actor: ActorContext, id: string, write = false) {
    const event = this.events.eventOf(actor, id);
    if (event.recurrenceParentEventId) throw new AppError('RECURRENCE_SCOPE_INVALID', 'Use the series Event ID and recurrenceId.', 400);
    if (write) this.events.assertReminderManage(actor, event);
    return event;
  }
  private visible(actor: ActorContext, reminder: CalendarEventReminder) {
    return reminder.workspaceId === actor.workspaceId && (reminder.attendeeUserId === actor.user.id ||
      this.support.scope(actor, 'event.reminder_manage') === 'WORKSPACE');
  }
  private reminder(actor: ActorContext, id: string) {
    const row = this.state.calendarEventReminders.find((item) => item.id === id && this.visible(actor, item));
    if (!row) throw notFoundError('REMINDER_NOT_FOUND', 'Reminder');
    this.event(actor, row.eventId, true);
    return row;
  }
  private recipient(actor: ActorContext, event: CalendarEvent, body: Body) {
    const userId = body.uuid('attendeeUserId') ?? actor.user.id;
    if (userId !== actor.user.id) {
      this.support.requireWorkspaceScope(actor, 'event.reminder_manage');
      this.events.assertReminderRecipientManage(actor, event);
    }
    if (!this.support.isEligibleUser(actor.workspaceId, userId) ||
      !(event.organizerUserId === userId || this.state.calendarEventAttendees.some((row) => row.eventId === event.id && row.userId === userId && !row.removedAt)))
      throw new AppError('EVENT_ATTENDEE_INVALID', 'The reminder recipient must be an active Event attendee.', 400);
    return userId;
  }
  private timing(event: CalendarEvent, body: Body, recurrenceId: string | null, previous?: CalendarEventReminder) {
    const rule = this.state.calendarRecurrenceRules.find((row) => row.id === event.recurrenceRuleId && !row.isDeleted);
    const known = previous?.seriesReminderId && previous.sourceRuleVersion === rule?.version;
    const occurrence = recurrenceId ? known ? this.recurrence.resolveKnown(event, { recurrenceId,
      ordinal: previous.recurrenceOrdinal!, startAt: null, startDate: null }) : this.recurrence.resolve(event, recurrenceId) : event;
    const isSeries = Boolean(event.recurrenceRuleId && !recurrenceId);
    if (occurrence.status === 'CANCELLED') throw new AppError('EVENT_CANCELLED', 'The occurrence is cancelled.', 409);
    const start = occurrence.isAllDay ? recurrenceInstant(`${occurrence.startDate}T00:00:00.000`, occurrence.sourceTimezone) : occurrence.startAt;
    if (!start) throw invalidTime();
    let offsetSeconds: number | null, remindAt: Date | null;
    if (body.has('offsetSeconds') || body.has('remindAt')) {
      if (body.has('offsetSeconds') === body.has('remindAt')) throw invalidTime();
      try {
        offsetSeconds = body.has('offsetSeconds') ? body.int('offsetSeconds', { required: true, min: 0, max: 31_536_000 }) : null;
        remindAt = body.has('remindAt') ? body.instant('remindAt', { required: true }) : null;
        if (remindAt && !isCalendarDate(String(body.raw.remindAt).slice(0, 10))) throw invalidTime();
      } catch { throw invalidTime(); }
    } else {
      if (!previous) throw invalidTime();
      offsetSeconds = previous.offsetSeconds; remindAt = previous.remindAt;
    }
    if (isSeries) {
      if (remindAt || offsetSeconds === null) throw new AppError('RECURRENCE_SCOPE_INVALID', 'Series reminders require offsetSeconds.', 400);
      return { offsetSeconds, remindAt: null, dueAt: null };
    }
    const dueAt = remindAt ?? new Date(start.getTime() - offsetSeconds! * 1000);
    if (!Number.isFinite(dueAt.getTime()) || dueAt > start || dueAt <= this.support.now()) throw invalidTime();
    return { offsetSeconds, remindAt, dueAt };
  }
  private publish(actor: ActorContext | null, row: CalendarEventReminder, cancelled = false) {
    this.support.event({ workspaceId: row.workspaceId, type: cancelled ? 'CALENDAR_REMINDER_CANCELLED' : 'CALENDAR_REMINDER_SCHEDULED',
      entityType: 'CALENDAR_EVENT', entityId: row.eventId, actorUserId: actor?.user.id ?? null,
      changes: { reminderId: row.id, recurrenceId: row.recurrenceId, channel: row.channel, dueAt: row.dueAt, version: row.version },
      audienceUserIds: [row.attendeeUserId] });
  }
  reconcile(event: CalendarEvent, includeOccurrences = true) {
    for (const row of this.state.calendarEventReminders.filter((item) => item.eventId === event.id && (includeOccurrences || item.isSeries) && (item.status === 'SCHEDULED' || item.status === 'FAILED'))) {
      let cancel = event.isDeleted || event.status === 'CANCELLED' || row.recurrenceRuleId !== event.recurrenceRuleId ||
        !this.support.isEligibleUser(event.workspaceId, row.attendeeUserId) ||
        !(event.organizerUserId === row.attendeeUserId || this.state.calendarEventAttendees.some((item) => item.eventId === event.id && item.userId === row.attendeeUserId && !item.removedAt));
      const parent = row.seriesReminderId ? this.state.calendarEventReminders.find((item) => item.id === row.seriesReminderId) : null;
      cancel ||= Boolean(row.seriesReminderId && (!parent || parent.status === 'CANCELLED'));
      if (cancel) { this.cancel(row); continue; }
      if (row.isSeries) continue;
      const rule = this.state.calendarRecurrenceRules.find((item) => item.id === event.recurrenceRuleId);
      // A changed rule requires bounded revalidation by the series scanner before delivery.
      if (parent && row.sourceRuleVersion !== rule?.version) {
        if (row.claimToken) { row.claimToken = null; row.leaseExpiresAt = null; this.support.touch(row); }
        continue;
      }
      let start: Date | null = null;
      if (!cancel) {
        try {
          const occurrence = parent ? this.recurrence.resolveKnown(event, { recurrenceId: row.recurrenceId!, ordinal: row.recurrenceOrdinal!, startAt: null, startDate: null })
            : row.recurrenceId ? this.recurrence.resolve(event, row.recurrenceId) : event;
          cancel = occurrence.status === 'CANCELLED';
          start = occurrence.isAllDay ? recurrenceInstant(`${occurrence.startDate}T00:00:00.000`, occurrence.sourceTimezone) : occurrence.startAt;
          cancel ||= !start || Boolean(row.remindAt && row.remindAt > start);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'RECURRENCE_OCCURRENCE_NOT_FOUND') throw error;
          cancel = true;
        }
      }
      if (cancel) { this.cancel(row); }
      else if (row.offsetSeconds !== null) {
        const dueAt = new Date(start!.getTime() - row.offsetSeconds * 1000);
        if (dueAt.getTime() !== row.dueAt!.getTime()) { row.dueAt = dueAt; this.invalidateDelivery(row); this.support.touch(row); }
      }
    }
  }
  private cancel(row: CalendarEventReminder) {
    row.status = 'CANCELLED'; row.claimToken = null; row.leaseExpiresAt = null; row.nextAttemptAt = null;
    this.support.touch(row);
  }
  private invalidateDelivery(row: CalendarEventReminder) {
    row.deliveryGeneration += 1; row.attempts = 0; row.nextAttemptAt = null; row.lastErrorCode = null;
    row.claimToken = null; row.leaseExpiresAt = null;
  }
  /** One bounded page per series. Cursor state and occurrence records commit in the same state unit. */
  materialize(now: Date, limit = 25) {
    const parents = this.state.calendarEventReminders.filter((row) => row.isSeries && ['SCHEDULED', 'FAILED'].includes(row.status) &&
      (!row.scanComplete || row.cursorEventVersion !== this.state.calendarEvents.find((event) => event.id === row.eventId)?.version ||
        row.cursorRuleVersion !== this.state.calendarRecurrenceRules.find((rule) => rule.id === row.recurrenceRuleId)?.version))
      .sort((a, b) => (a.materializedAt?.getTime() ?? 0) - (b.materializedAt?.getTime() ?? 0) || a.id.localeCompare(b.id)).slice(0, limit);
    for (const parent of parents) {
      const event = this.state.calendarEvents.find((row) => row.id === parent.eventId && row.workspaceId === parent.workspaceId);
      if (!event) { this.cancel(parent); continue; }
      this.reconcile(event, false);
      if (parent.status === 'CANCELLED') { this.reconcile(event); continue; }
      const rule = this.state.calendarRecurrenceRules.find((row) => row.id === event.recurrenceRuleId && !row.isDeleted);
      if (!rule) { this.cancel(parent); this.reconcile(event); continue; }
      const reset = parent.cursorRuleVersion !== rule.version || parent.cursorEventVersion !== event.version;
      const after = reset ? null : parent.cursorRecurrenceId, ordinal = reset ? 0 : parent.cursorOrdinal;
      if (!reset && parent.scanComplete) continue;
      try {
        const horizon = now.getTime() + 86_400_000 + parent.offsetSeconds! * 1000;
        const baseShift = event.isAllDay ? Date.parse(`${event.startDate}T00:00:00Z`) - Date.parse(`${rule.dtstartLocal}T00:00:00Z`)
          : Date.parse(`${wallClockOf(event.startAt!, rule.sourceTimezone)}Z`) - Date.parse(`${rule.dtstartLocal}Z`);
        const shifts = this.state.calendarRecurrenceRanges.filter((row) => row.recurrenceRuleId === rule.id).map((row) => row.shiftMilliseconds ?? baseShift);
        // Two days cover timezone offset changes; negative range shifts can bring later nominal identities into the window.
        const end = new Date(horizon - Math.min(0, baseShift, ...shifts) + 2 * 86_400_000);
        let through = end.toISOString().slice(0, rule.isAllDay ? 10 : -1);
        for (const exception of this.state.calendarRecurrenceExceptions.filter((row) => row.recurrenceRuleId === rule.id && row.overrideEventId)) {
          const override = this.state.calendarEvents.find((row) => row.id === exception.overrideEventId);
          const start = override?.isAllDay ? recurrenceInstant(`${override.startDate}T00:00:00.000`, override.sourceTimezone) : override?.startAt;
          if (start && start.getTime() <= horizon && exception.recurrenceId > through) through = exception.recurrenceId;
        }
        const page = advanceRecurrence(rule, { after, ordinal, through });
        // Resolve the whole page before any writes so a bad series cannot leave half a page committed.
        const planned = page.occurrences.map((occurrence) => ({ occurrence, scheduled: this.recurrence.resolveKnown(event, occurrence) }));
        const valid = new Set(page.occurrences.map((row) => row.recurrenceId));
        for (const { occurrence, scheduled } of planned) {
          const start = scheduled.isAllDay ? recurrenceInstant(`${scheduled.startDate}T00:00:00.000`, scheduled.sourceTimezone) : scheduled.startAt;
          const endAt = scheduled.isAllDay ? recurrenceInstant(`${scheduled.endDate}T00:00:00.000`, scheduled.sourceTimezone) : scheduled.endAt;
          let child = this.state.calendarEventReminders.find((row) => row.seriesReminderId === parent.id && row.recurrenceId === occurrence.recurrenceId);
          if (scheduled.status === 'CANCELLED' || !start || !endAt || endAt <= now) {
            if (child && ['SCHEDULED', 'FAILED'].includes(child.status)) this.cancel(child);
            continue;
          }
          if (child && !['SCHEDULED', 'FAILED'].includes(child.status)) continue;
          const dueAt = new Date(start.getTime() - (child?.isSeriesOverride ? child.offsetSeconds ?? 0 : parent.offsetSeconds!) * 1000);
          if (child) {
            const nextDue = child.isSeriesOverride && child.remindAt ? child.remindAt : dueAt;
            if (nextDue > start) { this.cancel(child); continue; }
            const changed = child.dueAt!.getTime() !== nextDue.getTime();
            child.dueAt = nextDue; child.sourceRuleVersion = rule.version; child.sourceEventVersion = event.version; child.recurrenceOrdinal = occurrence.ordinal;
            if (changed) this.invalidateDelivery(child);
            this.support.touch(child);
          } else {
            child = { ...parent, id: this.support.id(), isSeries: false, seriesReminderId: parent.id,
              recurrenceId: occurrence.recurrenceId, recurrenceOrdinal: occurrence.ordinal, sourceRuleVersion: rule.version, sourceEventVersion: event.version,
              dueAt, version: 1, createdAt: now, updatedAt: now, deliveryGeneration: 1, attempts: 0, lastErrorCode: null,
              cursorRecurrenceId: null, cursorOrdinal: 0, cursorRuleVersion: null, cursorEventVersion: null, scanComplete: false, materializedAt: null };
            this.state.calendarEventReminders.push(child); this.publish(null, child);
          }
        }
        for (const child of this.state.calendarEventReminders.filter((row) => row.seriesReminderId === parent.id && ['SCHEDULED', 'FAILED'].includes(row.status))) {
          if (child.sourceRuleVersion === rule.version && child.sourceEventVersion === event.version) continue;
          if (page.exhausted || (page.cursor && child.recurrenceId! <= page.cursor && !valid.has(child.recurrenceId!))) this.cancel(child);
        }
        parent.cursorRecurrenceId = page.cursor; parent.cursorOrdinal = page.ordinal; parent.cursorRuleVersion = rule.version;
        parent.cursorEventVersion = event.version; parent.scanComplete = page.exhausted; parent.materializedAt = now;
        parent.status = 'SCHEDULED'; parent.lastErrorCode = null; this.support.touch(parent);
      } catch (error) {
        parent.status = 'FAILED'; parent.lastErrorCode = error instanceof AppError ? error.code : 'REMINDER_MATERIALIZATION_FAILED';
        parent.materializedAt = now; this.support.touch(parent);
      }
    }
  }
  canClaim(row: CalendarEventReminder) {
    if (row.isSeries || !row.dueAt) return false;
    if (!row.seriesReminderId) return true;
    const parent = this.state.calendarEventReminders.find((item) => item.id === row.seriesReminderId);
    const event = this.state.calendarEvents.find((item) => item.id === row.eventId);
    const rule = this.state.calendarRecurrenceRules.find((item) => item.id === row.recurrenceRuleId);
    return Boolean(parent && parent.status === 'SCHEDULED' && event && rule &&
      row.sourceRuleVersion === rule.version && row.sourceEventVersion === event.version);
  }
  deliveryEvent(row: CalendarEventReminder, event: CalendarEvent) {
    if (!row.recurrenceId) return event;
    return row.seriesReminderId ? this.recurrence.resolveKnown(event, { recurrenceId: row.recurrenceId,
      ordinal: row.recurrenceOrdinal!, startAt: null, startDate: null }) : this.recurrence.resolve(event, row.recurrenceId);
  }
  list(actor: ActorContext, id: string) {
    this.event(actor, id);
    this.support.require(actor, 'event.reminder_manage');
    return this.state.calendarEventReminders.filter((row) => row.eventId === id && this.visible(actor, row));
  }
  create(actor: ActorContext, id: string, body: Body, idempotencyKey?: string) {
    const event = this.event(actor, id, true);
    body.only([...EDITABLE, 'attendeeUserId', 'recurrenceId']);
    const key = this.support.idempotencyKey(idempotencyKey), scope = `calendar.reminder.create:${id}`;
    const replay = this.support.recall(actor, scope, key, body.raw);
    if (replay) {
      const row = this.state.calendarEventReminders.find((item) => item.id === replay.reminderId && this.visible(actor, item));
      if (!row) throw notFoundError('REMINDER_NOT_FOUND', 'Reminder');
      return row;
    }
    const attendeeUserId = this.recipient(actor, event, body);
    const recurrenceId = body.str('recurrenceId', { max: 32 }) ?? null;
    const timing = this.timing(event, body, recurrenceId);
    const channel = body.enumOf('channel', ['IN_APP', 'EMAIL', 'PUSH'] as const, { required: true });
    const now = this.support.now();
    const row: CalendarEventReminder = { id: this.support.id(), workspaceId: actor.workspaceId, eventId: id,
      attendeeUserId, recurrenceId, recurrenceRuleId: event.recurrenceRuleId, ...timing, channel, status: 'SCHEDULED',
      version: 1, createdAt: now, updatedAt: now, deliveryGeneration: 1, attempts: 0, nextAttemptAt: null,
      claimToken: null, leaseExpiresAt: null, sentAt: null, deliveryReference: null, lastErrorCode: null,
      isSeries: Boolean(event.recurrenceRuleId && !recurrenceId), seriesReminderId: null, isSeriesOverride: false,
      recurrenceOrdinal: null, sourceRuleVersion: null, sourceEventVersion: null,
      cursorRecurrenceId: null, cursorOrdinal: 0, cursorRuleVersion: null, cursorEventVersion: null, scanComplete: false, materializedAt: null };
    this.state.calendarEventReminders.push(row); this.publish(actor, row);
    this.support.remember(actor, scope, key, body.raw, { reminderId: row.id });
    return row;
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const row = this.reminder(actor, id), event = this.event(actor, row.eventId, true);
    body.only([...EDITABLE, 'version']); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status !== 'SCHEDULED' && row.status !== 'FAILED') throw new AppError('REMINDER_NOT_EDITABLE', 'Only pending reminders can be changed.', 409);
    if (row.recurrenceRuleId !== event.recurrenceRuleId) throw new AppError('RECURRENCE_SCOPE_INVALID', 'The original series was removed or replaced.', 400);
    this.recipient(actor, event, new Body({ attendeeUserId: row.attendeeUserId }));
    const timing = this.timing(event, body, row.recurrenceId, row);
    const channel = body.enumOf('channel', ['IN_APP', 'EMAIL', 'PUSH'] as const) ?? row.channel;
    const previousOffset = row.offsetSeconds;
    Object.assign(row, timing, { channel, status: 'SCHEDULED' }); this.invalidateDelivery(row); this.support.touch(row); this.publish(actor, row);
    if (row.seriesReminderId) row.isSeriesOverride = true;
    if (row.isSeries) {
      row.cursorRecurrenceId = null; row.cursorOrdinal = 0; row.scanComplete = false; row.materializedAt = null;
      for (const child of this.state.calendarEventReminders.filter((item) => item.seriesReminderId === row.id && !item.isSeriesOverride && ['SCHEDULED', 'FAILED'].includes(item.status))) {
        child.offsetSeconds = row.offsetSeconds; child.channel = row.channel;
        child.dueAt = new Date(child.dueAt!.getTime() + (previousOffset! - row.offsetSeconds!) * 1000);
        this.invalidateDelivery(child); this.support.touch(child);
      }
    }
    return row;
  }
  remove(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    // Cancellation is allowed after the parent Event is cancelled, but still requires live read and reminder permission.
    const row = this.state.calendarEventReminders.find((item) => item.id === id && this.visible(actor, item));
    if (!row) throw notFoundError('REMINDER_NOT_FOUND', 'Reminder');
    const event = this.event(actor, row.eventId); this.support.require(actor, 'event.reminder_manage');
    if (row.attendeeUserId !== actor.user.id) this.events.assertReminderRecipientManage(actor, event);
    body.only(['version']); body.int('version', { min: 1 });
    if (row.status === 'CANCELLED') return { id, cancelled: true };
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status === 'SENT') throw new AppError('REMINDER_NOT_EDITABLE', 'A sent reminder cannot be cancelled.', 409);
    row.status = 'CANCELLED'; row.claimToken = null; row.leaseExpiresAt = null; row.nextAttemptAt = null;
    if (row.seriesReminderId) row.isSeriesOverride = true;
    this.support.touch(row); this.publish(actor, row, true);
    if (row.isSeries) this.reconcile(event);
    return { id, cancelled: true };
  }
}
