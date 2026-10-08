import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isIanaTimezone, notFoundError } from '../support';
import { addDays } from '../time';
import type { CalendarEvent } from './event-types';
import type { CalendarEventService } from './event-service';
import { expandRecurrence, recurrenceInstant, validateRecurrence, wallClockOf, type RecurrenceOccurrence } from './recurrence-engine';
import type { CalendarRecurrenceException, CalendarRecurrenceRange, CalendarRecurrenceRule } from './recurrence-types';

const DAY = 86_400_000;
const scopeInvalid = (message: string) => new AppError('RECURRENCE_SCOPE_INVALID', message, 400);
const EDITABLE = ['title', 'description', 'location', 'isAllDay', 'startAt', 'endAt', 'startDate', 'endDate', 'sourceTimezone', 'status', 'busyStatus'];
export class CalendarRecurrenceService {
  constructor(private readonly support: CollabSupport, private readonly events: CalendarEventService) {}
  private get state() { return this.support.state; }
  private rule(event: CalendarEvent) {
    const rule = this.state.calendarRecurrenceRules.find((row) => row.id === event.recurrenceRuleId && row.eventId === event.id && !row.isDeleted);
    if (!rule) throw notFoundError('RECURRENCE_NOT_FOUND', 'Recurrence');
    return rule;
  }
  private root(actor: ActorContext, id: string, write = false) {
    const event = this.events.eventOf(actor, id);
    if (event.recurrenceParentEventId) throw scopeInvalid('Use the series Event ID.');
    if (write) this.events.assertRecurrenceManage(actor, event);
    return event;
  }
  private occurrence(rule: CalendarRecurrenceRule, recurrenceId: string) {
    const rows = expandRecurrence(rule, { through: recurrenceId, limit: 1000 });
    let last = rows.at(-1);
    // Continue bounded pages; no silent truncation of an otherwise valid identity.
    while (last && last.recurrenceId < recurrenceId && rows.length === 1000) {
      const next = expandRecurrence(rule, { after: last.recurrenceId, through: recurrenceId, limit: 1000 });
      if (!next.length) break;
      rows.splice(0, rows.length, ...next); last = rows.at(-1);
    }
    if (!last || last.recurrenceId !== recurrenceId) throw notFoundError('RECURRENCE_OCCURRENCE_NOT_FOUND', 'Occurrence');
    return last;
  }
  private exception(rule: CalendarRecurrenceRule, recurrenceId: string) {
    return this.state.calendarRecurrenceExceptions.find((row) => row.recurrenceRuleId === rule.id && row.recurrenceId === recurrenceId);
  }
  private scheduled(event: CalendarEvent, rule: CalendarRecurrenceRule, occurrence: RecurrenceOccurrence): CalendarEvent {
    let shift = event.isAllDay
      ? Date.parse(`${event.startDate}T00:00:00Z`) - Date.parse(`${rule.dtstartLocal}T00:00:00Z`)
      : Date.parse(`${wallClockOf(event.startAt!, rule.sourceTimezone)}Z`) - Date.parse(`${rule.dtstartLocal}Z`);
    let duration = event.isAllDay
      ? Date.parse(`${event.endDate}T00:00:00Z`) - Date.parse(`${event.startDate}T00:00:00Z`)
      : event.endAt!.getTime() - event.startAt!.getTime();
    const result = { ...event, sourceTimezone: rule.sourceTimezone };
    const ranges = this.state.calendarRecurrenceRanges.filter((row) => row.recurrenceRuleId === rule.id && row.recurrenceId <= occurrence.recurrenceId)
      .sort((a, b) => a.recurrenceId.localeCompare(b.recurrenceId));
    for (const range of ranges) {
      if (range.title !== null) result.title = range.title;
      if (range.hasDescription) result.description = range.description;
      if (range.hasLocation) result.location = range.location;
      if (range.sourceTimezone !== null) result.sourceTimezone = range.sourceTimezone;
      if (range.status !== null) result.status = range.status;
      if (range.busyStatus !== null) result.busyStatus = range.busyStatus;
      shift = range.shiftMilliseconds ?? shift; duration = range.durationMilliseconds ?? duration;
    }
    if (event.isAllDay) {
      result.startDate = addDays(occurrence.recurrenceId, shift / DAY); result.endDate = addDays(result.startDate, duration / DAY);
    } else {
      const nominal = new Date(Date.parse(`${occurrence.recurrenceId}Z`) + shift).toISOString().slice(0, -1);
      result.startAt = recurrenceInstant(nominal, result.sourceTimezone);
      result.endAt = result.startAt ? new Date(result.startAt.getTime() + duration) : null;
    }
    return result;
  }
  private projected(actor: ActorContext, event: CalendarEvent, rule: CalendarRecurrenceRule, occurrence: RecurrenceOccurrence) {
    const exception = this.exception(rule, occurrence.recurrenceId);
    const override = exception?.overrideEventId ? this.state.calendarEvents.find((row) => row.id === exception.overrideEventId) : null;
    const scheduled = override ?? this.scheduled(event, rule, occurrence);
    return { ...this.events.view(actor, scheduled), eventId: event.id, recurrenceId: occurrence.recurrenceId,
      ordinal: occurrence.ordinal, recurrenceVersion: rule.version, overrideEventId: override?.id ?? null,
      status: event.status === 'CANCELLED' || exception?.exceptionType === 'CANCELLED' ? 'CANCELLED' as const : scheduled.status,
      skipped: !scheduled.isAllDay && !scheduled.startAt,
    };
  }
  get(actor: ActorContext, id: string, query = new URLSearchParams()) {
    const event = this.root(actor, id);
    if (!event.recurrenceRuleId) return null;
    const rule = this.rule(event), limit = query.has('limit') ? Number(query.get('limit')) : 20;
    const upcoming = expandRecurrence(rule, { after: query.get('after') ?? undefined, through: query.get('through') ?? undefined, limit })
      .map((row) => this.projected(actor, event, rule, row));
    return { ...rule, upcoming, exceptions: this.state.calendarRecurrenceExceptions.filter((row) => row.recurrenceRuleId === rule.id),
      ranges: this.state.calendarRecurrenceRanges.filter((row) => row.recurrenceRuleId === rule.id).sort((a, b) => a.recurrenceId.localeCompare(b.recurrenceId)) };
  }
  update(actor: ActorContext, id: string, body: Body, replace = false, ifMatch?: number) {
    const event = this.root(actor, id, true);
    body.only(['rruleText', 'sourceTimezone', 'version']);
    const old = this.state.calendarRecurrenceRules.find((row) => row.id === event.recurrenceRuleId && !row.isDeleted);
    if (!replace && (!old || old.isDeleted)) throw notFoundError('RECURRENCE_NOT_FOUND', 'Recurrence');
    this.support.expectVersion(old ?? { version: 0 }, body.raw.version ?? ifMatch);
    const sourceTimezone = body.str('sourceTimezone', replace ? { required: true } : {}) ?? old!.sourceTimezone;
    if (!isIanaTimezone(sourceTimezone)) throw new AppError('RECURRENCE_INVALID_RULE', 'sourceTimezone must be an IANA timezone.', 400);
    const dtstartLocal = old?.dtstartLocal ?? (event.isAllDay ? event.startDate! : wallClockOf(event.startAt!, sourceTimezone));
    const definition = validateRecurrence({ rruleText: body.str('rruleText', replace ? { required: true, max: 2000 } : { max: 2000 }) ?? old!.rruleText,
      sourceTimezone, dtstartLocal, isAllDay: event.isAllDay });
    // Validate the preview before mutation as expansion can reject a pathological rule.
    expandRecurrence(definition, { limit: 20 });
    const nextStart = old && sourceTimezone !== old.sourceTimezone && !event.isAllDay
      ? recurrenceInstant(wallClockOf(event.startAt!, old.sourceTimezone), sourceTimezone) : event.startAt;
    if (!event.isAllDay && !nextStart) throw new AppError('RECURRENCE_INVALID_RULE', 'The series start cannot fall in a timezone gap.', 400);
    const nextEnd = !event.isAllDay ? new Date(nextStart!.getTime() + event.endAt!.getTime() - event.startAt!.getTime()) : null;
    const before = old ? { rruleText: old.rruleText, sourceTimezone: old.sourceTimezone, version: old.version, isDeleted: old.isDeleted } : null;
    const now = this.support.now();
    let rule: CalendarRecurrenceRule;
    if (old) { Object.assign(old, definition, { isDeleted: false }); this.support.touch(old); rule = old; }
    else { rule = { id: this.support.id(), workspaceId: event.workspaceId, eventId: id, ...definition, isDeleted: false, version: 1, createdAt: now, updatedAt: now }; this.state.calendarRecurrenceRules.push(rule); }
    event.recurrenceRuleId = rule.id;
    event.sourceTimezone = sourceTimezone;
    if (!event.isAllDay) { event.startAt = nextStart; event.endAt = nextEnd; }
    this.events.recordRecurrenceChange(actor, event, 'CALENDAR_RECURRENCE_CHANGED', { ruleId: rule.id, before, after: definition, version: rule.version });
    return this.get(actor, id);
  }
  remove(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const event = this.root(actor, id, true), rule = this.rule(event);
    body.only(['version']); this.support.expectVersion(rule, body.raw.version ?? ifMatch);
    rule.isDeleted = true; this.support.touch(rule); event.recurrenceRuleId = null;
    this.events.recordRecurrenceChange(actor, event, 'CALENDAR_RECURRENCE_CHANGED', { ruleId: rule.id, deleted: true, version: rule.version });
    return { id: rule.id, deleted: true };
  }
  editOccurrence(actor: ActorContext, id: string, recurrenceId: string, body: Body, ifMatch?: number) {
    const event = this.root(actor, id, true), rule = this.rule(event), occurrence = this.occurrence(rule, recurrenceId);
    body.only([...EDITABLE, 'version']); this.support.expectVersion(rule, body.raw.version ?? ifMatch);
    const current = this.projected(actor, event, rule, occurrence);
    if (current.status === 'CANCELLED') throw new AppError('EVENT_CANCELLED', 'The occurrence is cancelled.', 409);
    if (current.skipped && !(body.has('startAt') && body.has('endAt'))) throw scopeInvalid('A range-shifted gap needs explicit valid start/end values.');
    const values = this.prepareEdit(current, new Body(Object.fromEntries(Object.entries(body.raw).filter(([key]) => key !== 'version'))));
    const exception = this.exception(rule, recurrenceId), existing = exception?.overrideEventId ? this.state.calendarEvents.find((row) => row.id === exception.overrideEventId) : undefined;
    const override = this.events.saveOccurrence(event, recurrenceId, values, existing);
    this.saveException(rule, recurrenceId, 'MODIFIED', override.id);
    this.support.touch(rule); this.events.recordRecurrenceChange(actor, event, 'CALENDAR_OCCURRENCE_EXCEPTION_CREATED', { ruleId: rule.id, recurrenceId, overrideEventId: override.id, exceptionType: 'MODIFIED' });
    return this.projected(actor, event, rule, occurrence);
  }
  private prepareEdit(current: CalendarEvent, edit: Body) {
    const raw = { ...edit.raw };
    if (current.isAllDay && edit.has('startDate') && !edit.has('endDate') && !edit.has('isAllDay')) {
      const start = edit.date('startDate', { required: true });
      raw.endDate = addDays(start, (Date.parse(`${current.endDate}T00:00:00Z`) - Date.parse(`${current.startDate}T00:00:00Z`)) / DAY);
    } else if (!current.isAllDay && edit.has('startAt') && !edit.has('endAt') && !edit.has('isAllDay')) {
      const start = edit.instant('startAt', { required: true });
      raw.endAt = new Date(start.getTime() + current.endAt!.getTime() - current.startAt!.getTime()).toISOString();
    }
    return this.events.prepareOccurrence(current, new Body(raw));
  }
  private saveException(rule: CalendarRecurrenceRule, recurrenceId: string, exceptionType: CalendarRecurrenceException['exceptionType'], overrideEventId: string | null) {
    const existing = this.exception(rule, recurrenceId), now = this.support.now();
    if (existing) Object.assign(existing, { exceptionType, overrideEventId, updatedAt: now });
    else this.state.calendarRecurrenceExceptions.push({ id: this.support.id(), workspaceId: rule.workspaceId, recurrenceRuleId: rule.id, recurrenceId, exceptionType, overrideEventId, createdAt: now, updatedAt: now });
  }
  cancelOccurrence(actor: ActorContext, id: string, recurrenceId: string, body: Body, ifMatch?: number) {
    const event = this.root(actor, id, true), rule = this.rule(event), occurrence = this.occurrence(rule, recurrenceId);
    body.only(['version']);
    body.int('version', { min: 0 });
    const existing = this.exception(rule, recurrenceId);
    if (existing?.exceptionType === 'CANCELLED') return this.projected(actor, event, rule, occurrence);
    this.support.expectVersion(rule, body.raw.version ?? ifMatch);
    this.saveException(rule, recurrenceId, 'CANCELLED', existing?.overrideEventId ?? null);
    this.support.touch(rule); this.events.recordRecurrenceChange(actor, event, 'CALENDAR_OCCURRENCE_EXCEPTION_CREATED', { ruleId: rule.id, recurrenceId, exceptionType: 'CANCELLED' });
    return this.projected(actor, event, rule, occurrence);
  }
  editFuture(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const event = this.root(actor, id, true), rule = this.rule(event);
    body.only([...EDITABLE, 'recurrenceId', 'version']); this.support.expectVersion(rule, body.raw.version ?? ifMatch);
    const recurrenceId = body.str('recurrenceId', { required: true, max: 32 }), occurrence = this.occurrence(rule, recurrenceId);
    const current = this.scheduled(event, rule, occurrence);
    if (!current.isAllDay && !current.startAt && !(body.has('startAt') && body.has('endAt'))) throw scopeInvalid('This boundary needs explicit valid start/end values.');
    const edit = new Body(Object.fromEntries(Object.entries(body.raw).filter(([key]) => EDITABLE.includes(key))));
    if (!Object.keys(edit.raw).length) throw scopeInvalid('Supply a future change.');
    const values = this.prepareEdit(current, edit);
    if (values.isAllDay !== rule.isAllDay) throw scopeInvalid('Future edits must retain the original DATE or DATE-TIME value type.');
    const existing = this.state.calendarRecurrenceRanges.find((row) => row.recurrenceRuleId === rule.id && row.recurrenceId === recurrenceId), now = this.support.now();
    const range: CalendarRecurrenceRange = existing ? { ...existing } : { id: this.support.id(), workspaceId: rule.workspaceId, recurrenceRuleId: rule.id, recurrenceId,
      title: null, hasDescription: false, description: null, hasLocation: false, location: null, sourceTimezone: null, status: null, busyStatus: null,
      shiftMilliseconds: null, durationMilliseconds: null, createdAt: now, updatedAt: now };
    if (edit.has('title')) range.title = values.title;
    if (edit.has('description')) { range.hasDescription = true; range.description = values.description; }
    if (edit.has('location')) { range.hasLocation = true; range.location = values.location; }
    if (edit.has('sourceTimezone')) range.sourceTimezone = values.sourceTimezone;
    if (edit.has('status')) range.status = values.status;
    if (edit.has('busyStatus')) range.busyStatus = values.busyStatus;
    if (edit.has('startAt') || edit.has('startDate')) range.shiftMilliseconds = values.isAllDay
      ? Date.parse(`${values.startDate}T00:00:00Z`) - Date.parse(`${recurrenceId}T00:00:00Z`)
      : Date.parse(`${wallClockOf(values.startAt!, values.sourceTimezone)}Z`) - Date.parse(`${recurrenceId}Z`);
    if (edit.has('endAt') || edit.has('endDate')) range.durationMilliseconds = values.isAllDay
      ? Date.parse(`${values.endDate}T00:00:00Z`) - Date.parse(`${values.startDate}T00:00:00Z`) : values.endAt!.getTime() - values.startAt!.getTime();
    if ([range.shiftMilliseconds, range.durationMilliseconds].some((value) => value !== null && (!Number.isSafeInteger(value) || Math.abs(value) > 3_155_760_000_000)))
      throw scopeInvalid('Future timing changes must fit the supported 100-year range.');
    range.updatedAt = now;
    if (existing) Object.assign(existing, range); else this.state.calendarRecurrenceRanges.push(range);
    this.support.touch(rule); this.events.recordRecurrenceChange(actor, event, 'CALENDAR_RECURRENCE_CHANGED', { ruleId: rule.id, scope: 'THISANDFUTURE', recurrenceId, range, version: rule.version });
    return this.get(actor, id);
  }
}
