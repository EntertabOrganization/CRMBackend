import { RRule } from 'rrule';
import { AppError } from '../../errors';
import { isCalendarDate, isIanaTimezone } from '../support';
import { localParts, zoneOffsetMs } from '../time';

/** DTSTART is a wall-clock value, never an instant disguised as a local date. */
export type RecurrenceDefinition = { rruleText: string; sourceTimezone: string; dtstartLocal: string; isAllDay: boolean };
export type RecurrenceOccurrence = { recurrenceId: string; startAt: Date | null; startDate: string | null; ordinal: number };
const MAX_CANDIDATES = 20_000;
const invalid = (message: string) => new AppError('RECURRENCE_INVALID_RULE', message, 400);
const scopeInvalid = (message: string) => new AppError('RECURRENCE_SCOPE_INVALID', message, 400);
const PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST']);

export function wallClockOf(instant: Date, timezone: string) {
  const p = localParts(instant, timezone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}.${String(instant.getUTCMilliseconds()).padStart(3, '0')}`;
}

/** A gap has no instant. In an overlap iCalendar uses the first occurrence of the local time. */
export function recurrenceInstant(local: string, timezone: string): Date | null {
  const nominal = Date.parse(`${local}Z`);
  if (!Number.isFinite(nominal)) return null;
  if (timezone === 'UTC' || timezone === 'Etc/UTC') {
    const instant = new Date(nominal); return instant.toISOString().slice(0, -1) === local ? instant : null;
  }
  const offsets = new Set<number>();
  // Sampling both sides also handles half-hour DST and whole-day date-line changes.
  for (let hours = -36; hours <= 36; hours += 12) offsets.add(zoneOffsetMs(new Date(nominal + hours * 3_600_000), timezone));
  const candidates = [...offsets].map((offset) => new Date(nominal - offset))
    .filter((instant) => wallClockOf(instant, timezone) === local).sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

function localStart(definition: RecurrenceDefinition) {
  const local = definition.isAllDay ? `${definition.dtstartLocal}T00:00:00.000` : definition.dtstartLocal;
  if (!isCalendarDate(local.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(local))
    throw invalid('DTSTART must be a valid local date or local date-time matching the Event type.');
  if (definition.isAllDay && !isCalendarDate(definition.dtstartLocal)) throw invalid('All-day DTSTART must be a date.');
  if (!definition.isAllDay && !recurrenceInstant(local, definition.sourceTimezone)) throw invalid('DTSTART cannot fall in a timezone gap.');
  return new Date(`${local}Z`);
}

function parse(definition: RecurrenceDefinition) {
  if (!isIanaTimezone(definition.sourceTimezone)) throw invalid('Recurrence sourceTimezone must be an IANA timezone.');
  if (typeof definition.rruleText !== 'string' || definition.rruleText.length > 2000 || /[\r\n]/.test(definition.rruleText)) throw invalid('Supply one bounded RRULE.');
  const text = definition.rruleText.trim().replace(/^RRULE:/, '');
  const entries = text.split(';').map((part) => part.split('='));
  if (entries.some(([key, value, extra]) => !PARTS.has(key) || !value || extra !== undefined) || new Set(entries.map(([key]) => key)).size !== entries.length)
    throw invalid('RRULE contains an unknown, duplicate or malformed part.');
  const values: Record<string, string> = Object.fromEntries(entries);
  if (!['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'].includes(values.FREQ)) throw invalid('RRULE needs a valid FREQ.');
  for (const key of ['INTERVAL', 'COUNT']) if (values[key] && (!/^\d+$/.test(values[key]) || Number(values[key]) < 1 || Number(values[key]) > 1_000_000)) throw invalid(`${key} must be a positive bounded integer.`);
  if (values.COUNT && values.UNTIL) throw invalid('COUNT and UNTIL cannot both be supplied.');
  const numeric: Record<string, [number, number, boolean]> = {
    BYSECOND: [0, 59, false], BYMINUTE: [0, 59, false], BYHOUR: [0, 23, false], BYMONTH: [1, 12, false],
    BYMONTHDAY: [-31, 31, true], BYYEARDAY: [-366, 366, true], BYWEEKNO: [-53, 53, true], BYSETPOS: [-366, 366, true],
  };
  for (const [key, [min, max, nonzero]] of Object.entries(numeric)) if (values[key] && values[key].split(',').some((v) => !/^[+-]?\d+$/.test(v) || Number(v) < min || Number(v) > max || nonzero && Number(v) === 0)) throw invalid(`${key} is out of range.`);
  if (values.BYDAY && values.BYDAY.split(',').some((v) => !/^(?:[+-]?(?:[1-9]|[1-4]\d|5[0-3]))?(MO|TU|WE|TH|FR|SA|SU)$/.test(v))) throw invalid('BYDAY is invalid.');
  if (values.WKST && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(values.WKST)) throw invalid('WKST is invalid.');
  if (values.BYDAY && /\d/.test(values.BYDAY) && (!['MONTHLY', 'YEARLY'].includes(values.FREQ) || values.BYWEEKNO)) throw invalid('Ordinal BYDAY requires MONTHLY or YEARLY without BYWEEKNO.');
  if (values.BYMONTHDAY && values.FREQ === 'WEEKLY' || values.BYYEARDAY && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(values.FREQ) || values.BYWEEKNO && values.FREQ !== 'YEARLY') throw invalid('RRULE parts are incompatible with FREQ.');
  if (values.BYSETPOS && !Object.keys(values).some((key) => key.startsWith('BY') && key !== 'BYSETPOS')) throw invalid('BYSETPOS requires another BY part.');
  if (definition.isAllDay && ['BYSECOND', 'BYMINUTE', 'BYHOUR'].some((key) => values[key]) || definition.isAllDay && ['SECONDLY', 'MINUTELY', 'HOURLY'].includes(values.FREQ)) throw invalid('All-day rules cannot contain time-of-day recurrence parts.');
  const dtstart = localStart(definition);
  let until: Date | string | null = null;
  if (values.UNTIL) {
    const value = values.UNTIL;
    if (definition.isAllDay) {
      if (!/^\d{8}$/.test(value)) throw invalid('All-day UNTIL must be a date.');
      until = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      if (!isCalendarDate(until) || until < definition.dtstartLocal) throw invalid('UNTIL must be a valid date on or after DTSTART.');
    } else {
      if (!/^\d{8}T\d{6}Z$/.test(value)) throw invalid('Timed UNTIL must be a UTC date-time.');
      const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
      until = new Date(iso);
      if (!isCalendarDate(iso.slice(0, 10)) || Number.isNaN(until.getTime()) || until.toISOString() !== iso || until < recurrenceInstant(definition.dtstartLocal, definition.sourceTimezone)!) throw invalid('UNTIL must be a valid instant on or after DTSTART.');
    }
  }
  try {
    // RRule expands nominal local dates. COUNT/UNTIL are applied after timezone gap removal.
    const options = RRule.parseString(entries.filter(([key]) => key !== 'COUNT' && key !== 'UNTIL').map((p) => p.join('=')).join(';'));
    const rule = new RRule({ ...options, dtstart }, true);
    return { rule, count: values.COUNT ? Number(values.COUNT) : null, until, dtstart, text };
  } catch { throw invalid('RRULE could not be parsed.'); }
}

export function validateRecurrence(definition: RecurrenceDefinition): RecurrenceDefinition {
  const { text } = parse(definition);
  return { ...definition, rruleText: text };
}

/** Bounded expansion preserves original identity, even when a later exception moves the start. */
export function expandRecurrence(definition: RecurrenceDefinition, options: { after?: string; through?: string; limit?: number } = {}): RecurrenceOccurrence[] {
  const { rule, count, until } = parse(definition);
  const limit = options.limit ?? 100;
  const validBoundary = (value: string) => definition.isAllDay ? isCalendarDate(value) : /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(value) && isCalendarDate(value.slice(0, 10));
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || [options.after, options.through].some((v) => v !== undefined && !validBoundary(v))) throw scopeInvalid('Use valid local recurrence boundaries and a limit between 1 and 1000.');
  if (options.after && options.through && options.through < options.after) throw scopeInvalid('through must be after the lower boundary.');
  const result: RecurrenceOccurrence[] = [];
  let ordinal = 0, examined = 0;
  rule.all((nominal) => {
    const recurrenceId = nominal.toISOString().slice(0, definition.isAllDay ? 10 : -1);
    if (options.through && recurrenceId > options.through) return false;
    if (++examined > MAX_CANDIDATES) throw scopeInvalid('Expansion exceeds the synchronous candidate budget; use a recurrence backfill job.');
    const startAt = definition.isAllDay ? null : recurrenceInstant(recurrenceId, definition.sourceTimezone);
    if (!definition.isAllDay && !startAt) return true;
    if (until && (typeof until === 'string' ? recurrenceId > until : startAt! > until)) return false;
    if (count !== null && ordinal >= count) return false;
    ordinal += 1;
    if (!options.after || recurrenceId > options.after) result.push({ recurrenceId, startAt, startDate: definition.isAllDay ? recurrenceId : null, ordinal });
    return result.length < limit;
  });
  return result;
}

/** Resume inside the last validated frequency period, retaining the original DTSTART defaults.
 * Starting at the period boundary preserves BYSETPOS and interval phase without replaying earlier periods.
 */
function resumeRule(rule: RRule, cursor: Date): RRule {
  const period = new Date(cursor), { freq, wkst, dtstart } = rule.options;
  if (freq === RRule.YEARLY) period.setUTCMonth(0, 1);
  if (freq === RRule.MONTHLY) period.setUTCDate(1);
  if (freq === RRule.WEEKLY) period.setUTCDate(period.getUTCDate() - ((period.getUTCDay() + 6) % 7 - wkst + 7) % 7);
  if (freq <= RRule.DAILY) period.setUTCHours(0, 0, 0, dtstart.getUTCMilliseconds());
  else if (freq === RRule.HOURLY) period.setUTCMinutes(0, 0, dtstart.getUTCMilliseconds());
  else if (freq === RRule.MINUTELY) period.setUTCSeconds(0, dtstart.getUTCMilliseconds());
  if (period <= dtstart) return rule;
  const options = { ...rule.origOptions, dtstart: period };
  for (const key of ['bymonth', 'bymonthday', 'byweekday', 'byhour', 'byminute', 'bysecond'] as const) {
    if (options[key] == null && rule.options[key]?.length) options[key] = rule.options[key];
  }
  return new RRule(options, true);
}

/** Fast-forward an uncounted rule to the frequency period containing a query boundary.
 * Unlike a durable cursor, the boundary need not be an occurrence, so INTERVAL must retain its DTSTART phase.
 */
function windowRule(rule: RRule, boundary: Date) {
  const { freq, interval, dtstart, wkst } = rule.options;
  if (boundary <= dtstart) return rule;
  const period = new Date(dtstart), target = new Date(boundary);
  if (freq === RRule.YEARLY) {
    const year = dtstart.getUTCFullYear() + Math.floor((boundary.getUTCFullYear() - dtstart.getUTCFullYear()) / interval) * interval;
    period.setUTCFullYear(year, 0, 1);
  } else if (freq === RRule.MONTHLY) {
    const months = (boundary.getUTCFullYear() - dtstart.getUTCFullYear()) * 12 + boundary.getUTCMonth() - dtstart.getUTCMonth();
    period.setUTCDate(1); period.setUTCMonth(dtstart.getUTCMonth() + Math.floor(months / interval) * interval);
  } else {
    const unit = freq === RRule.WEEKLY ? 7 * 86_400_000 : freq === RRule.DAILY ? 86_400_000 : freq === RRule.HOURLY ? 3_600_000 : freq === RRule.MINUTELY ? 60_000 : 1000;
    if (freq <= RRule.DAILY) {
      period.setUTCHours(0, 0, 0, dtstart.getUTCMilliseconds()); target.setUTCHours(0, 0, 0, dtstart.getUTCMilliseconds());
      if (freq === RRule.WEEKLY) {
        for (const date of [period, target]) date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7 - wkst + 7) % 7);
      }
    } else if (freq === RRule.HOURLY) { period.setUTCMinutes(0, 0, dtstart.getUTCMilliseconds()); target.setUTCMinutes(0, 0, dtstart.getUTCMilliseconds()); }
    else if (freq === RRule.MINUTELY) { period.setUTCSeconds(0, dtstart.getUTCMilliseconds()); target.setUTCSeconds(0, dtstart.getUTCMilliseconds()); }
    period.setTime(period.getTime() + Math.floor((target.getTime() - period.getTime()) / (unit * interval)) * unit * interval);
  }
  return resumeRule(rule, period);
}

/** Identity-only window expansion for availability. No Event metadata or invented original ordinal is returned. */
export function recurrenceIdsBetween(definition: RecurrenceDefinition, options: { from: string; through: string; limit?: number }): string[] {
  const { rule, count, until } = parse(definition), limit = options.limit ?? 1000;
  const date = (id: string) => new Date(`${id}${definition.isAllDay ? 'T00:00:00.000' : ''}Z`);
  const from = date(options.from), through = date(options.through);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(from.getTime()) || !Number.isFinite(through.getTime()) || through < from)
    throw scopeInvalid('Invalid recurrence availability window.');
  const result: string[] = [];
  let ordinal = 0, examined = 0;
  const scanner = count === null ? windowRule(rule, from) : rule;
  scanner.between(count === null ? from : rule.options.dtstart, through, true, (nominal) => {
    if (++examined > MAX_CANDIDATES) throw scopeInvalid('Availability exceeds the synchronous recurrence budget.');
    const recurrenceId = nominal.toISOString().slice(0, definition.isAllDay ? 10 : -1);
    const startAt = definition.isAllDay ? null : recurrenceInstant(recurrenceId, definition.sourceTimezone);
    if (!definition.isAllDay && !startAt) return true;
    if (until && (typeof until === 'string' ? recurrenceId > until : startAt! > until)) return false;
    if (count !== null && ordinal >= count) return false;
    ordinal += 1;
    if (nominal >= from) {
      if (result.length >= limit) throw scopeInvalid('Availability occurrence output exceeds its budget.');
      result.push(recurrenceId);
    }
    return count === null || ordinal < count;
  });
  return result;
}

/** Durable jobs resume by nominal identity and valid-occurrence ordinal, including across skipped DST gaps. */
export function advanceRecurrence(definition: RecurrenceDefinition, options: {
  after: string | null; ordinal: number; through: string; candidateLimit?: number;
}) {
  const { rule, count, until, dtstart } = parse(definition), candidateLimit = options.candidateLimit ?? 1000;
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 1000 || !Number.isInteger(options.ordinal) || options.ordinal < 0)
    throw scopeInvalid('Invalid recurrence job cursor.');
  const validBoundary = (value: string) => definition.isAllDay ? isCalendarDate(value) :
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(value) && isCalendarDate(value.slice(0, 10));
  if (!validBoundary(options.through) || (options.after !== null && !validBoundary(options.after))) throw scopeInvalid('Invalid recurrence job boundary.');
  const date = (id: string) => new Date(`${id}${definition.isAllDay ? 'T00:00:00.000' : ''}Z`);
  const start = options.after ? new Date(date(options.after).getTime() + 1) : dtstart;
  const end = date(options.through);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw scopeInvalid('Invalid recurrence job boundary.');
  const occurrences: RecurrenceOccurrence[] = [];
  let cursor = options.after, ordinal = options.ordinal, examined = 0, exhausted = count !== null && ordinal >= count, bounded = false;
  const scanner = options.after ? resumeRule(rule, date(options.after)) : rule;
  if (!exhausted && start <= end) scanner.between(start, end, true, (nominal) => {
    if (examined >= candidateLimit) { bounded = true; return false; }
    examined += 1;
    const recurrenceId = nominal.toISOString().slice(0, definition.isAllDay ? 10 : -1);
    const startAt = definition.isAllDay ? null : recurrenceInstant(recurrenceId, definition.sourceTimezone);
    cursor = recurrenceId;
    if (!definition.isAllDay && !startAt) return true;
    if (until && (typeof until === 'string' ? recurrenceId > until : startAt! > until)) { exhausted = true; return false; }
    ordinal += 1;
    occurrences.push({ recurrenceId, startAt, startDate: definition.isAllDay ? recurrenceId : null, ordinal });
    if (count !== null && ordinal >= count) { exhausted = true; return false; }
    return true;
  });
  if (!bounded && until && (typeof until === 'string' ? options.through > until : end.getTime() > until.getTime() + 2 * 86_400_000)) exhausted = true;
  return { occurrences, cursor, ordinal, exhausted, bounded, examined };
}
