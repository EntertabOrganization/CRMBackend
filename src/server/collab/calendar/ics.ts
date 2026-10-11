import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { isIanaTimezone } from '../support';
import { recurrenceInstant, wallClockOf } from './recurrence-engine';

/** Parsed VEVENT in TrueCRM terms. `etag` changes whenever the source content changes. */
export type IcsEvent = {
  uid: string; etag: string; title: string; description: string | null; location: string | null;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'; isAllDay: boolean; startAt: Date | null; endAt: Date | null;
  startDate: string | null; endDate: string | null; sourceTimezone: string; rrule: string | null;
};
export type IcsParseResult = { events: IcsEvent[]; warnings: Array<{ uid: string | null; code: string; message: string }> };

const MAX_BYTES = 1024 * 1024, MAX_EVENTS = 2000, MAX_LINE = 10_000;
const invalid = (message: string, details: Record<string, unknown> = {}) => new AppError('ICS_IMPORT_INVALID', message, 400, details);

type Line = { name: string; params: Record<string, string>; value: string; number: number };
function contentLines(text: string): Line[] {
  const physical = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const logical: Array<{ text: string; number: number }> = [];
  physical.forEach((line, index) => {
    if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length) logical[logical.length - 1].text += line.slice(1);
    else if (line.length) logical.push({ text: line, number: index + 1 });
  });
  return logical.map(({ text: line, number }) => {
    if (line.length > MAX_LINE) throw invalid('An iCalendar line is too long.', { line: number });
    let colon = -1, quoted = false;
    for (let i = 0; i < line.length; i++) { if (line[i] === '"') quoted = !quoted; else if (line[i] === ':' && !quoted) { colon = i; break; } }
    if (colon <= 0) throw invalid('Malformed iCalendar content line.', { line: number });
    const [rawName, ...rawParams] = line.slice(0, colon).split(';');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(rawName)) throw invalid('Malformed iCalendar property name.', { line: number });
    const params: Record<string, string> = {};
    for (const param of rawParams) {
      const eq = param.indexOf('=');
      if (eq <= 0) throw invalid('Malformed iCalendar parameter.', { line: number });
      params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1), number };
  });
}
const unescapeText = (value: string) => value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
export const escapeText = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

function dateOf(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const check = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === date ? date : null;
}
/** DATE-TIME as an instant: UTC (`Z`), TZID-qualified or floating (interpreted in the target calendar timezone). */
function instantOf(line: Line, fallbackTimezone: string) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(line.value);
  if (!match) return null;
  if (!dateOf(match[1] + match[2] + match[3]) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000`;
  if (match[7]) { const date = new Date(`${local}Z`); return Number.isNaN(date.getTime()) ? null : { instant: date, timezone: 'UTC' }; }
  const timezone = line.params.TZID ?? fallbackTimezone;
  if (!isIanaTimezone(timezone)) throw invalid('Only IANA TZID values are supported.', { line: line.number, tzid: timezone });
  const instant = recurrenceInstant(local, timezone);
  return instant ? { instant, timezone } : null;
}
function durationMs(value: string) {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match || value === 'P' || value === 'PT') return null;
  const [, w, d, h, m, s] = match.map(part => Number(part ?? 0));
  return (((w * 7 + d) * 24 + h) * 60 + m) * 60_000 + s * 1000;
}

/** Validates untrusted iCalendar content. Unsupported constructs are reported as warnings instead of being guessed. */
export function parseIcs(text: string, fallbackTimezone: string): IcsParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw invalid('iCalendar content may be at most 1 MiB.');
  const lines = contentLines(text);
  if (lines[0]?.name !== 'BEGIN' || lines[0].value.toUpperCase() !== 'VCALENDAR') throw invalid('Content must start with BEGIN:VCALENDAR.');
  const events: IcsEvent[] = [], warnings: IcsParseResult['warnings'] = [], seen = new Set<string>();
  const stack: string[] = [];
  let closed = false;
  let current: Line[] | null = null;
  for (const line of lines) {
    if (closed) throw invalid('Content after END:VCALENDAR is not allowed.');
    if (line.name === 'BEGIN') {
      stack.push(line.value.toUpperCase());
      if (line.value.toUpperCase() === 'VEVENT' && stack.length === 2) current = [];
      continue;
    }
    if (line.name === 'END') {
      const name = stack.pop();
      if (name !== line.value.toUpperCase()) throw invalid('Unbalanced BEGIN/END components.', { line: line.number });
      if (name === 'VCALENDAR' && stack.length === 0) closed = true;
      if (name === 'VEVENT' && current && stack.length === 1) {
        const parsed = toEvent(current, fallbackTimezone, warnings);
        if (parsed) {
          if (seen.has(parsed.uid)) warnings.push({ uid: parsed.uid, code: 'DUPLICATE_UID', message: 'Duplicate UID ignored.' });
          else { seen.add(parsed.uid); events.push(parsed); }
        }
        current = null;
        if (events.length > MAX_EVENTS) throw invalid(`At most ${MAX_EVENTS} events can be imported at once.`);
      }
      continue;
    }
    if (current && stack.length === 2) current.push(line);
  }
  if (stack.length) throw invalid('Unterminated iCalendar component.');
  return { events, warnings };
}

function toEvent(lines: Line[], fallbackTimezone: string, warnings: IcsParseResult['warnings']): IcsEvent | null {
  const get = (name: string) => lines.find(line => line.name === name);
  const uid = get('UID')?.value.trim();
  if (!uid || uid.length > 500) { warnings.push({ uid: null, code: 'MISSING_UID', message: 'VEVENT without a usable UID was skipped.' }); return null; }
  if (get('RECURRENCE-ID')) { warnings.push({ uid, code: 'RECURRENCE_OVERRIDE_UNSUPPORTED', message: 'Individual occurrence overrides are not imported.' }); return null; }
  const start = get('DTSTART');
  if (!start) { warnings.push({ uid, code: 'MISSING_DTSTART', message: 'VEVENT without DTSTART was skipped.' }); return null; }
  const end = get('DTEND'), duration = get('DURATION');
  const allDay = start.params.VALUE === 'DATE' || /^\d{8}$/.test(start.value);
  let startAt: Date | null = null, endAt: Date | null = null, startDate: string | null = null, endDate: string | null = null, sourceTimezone = fallbackTimezone;
  if (allDay) {
    startDate = dateOf(start.value);
    if (!startDate) throw invalid('Invalid DATE value.', { line: start.number });
    endDate = end ? dateOf(end.value) : null;
    if (end && !endDate) throw invalid('Invalid DATE value.', { line: end.number });
    if (!endDate) {
      const days = duration ? Math.max(1, Math.round((durationMs(duration.value) ?? 86_400_000) / 86_400_000)) : 1;
      endDate = new Date(Date.parse(`${startDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    }
    if (endDate <= startDate) throw invalid('DTEND must be after DTSTART.', { line: end?.number ?? start.number });
  } else {
    const parsed = instantOf(start, fallbackTimezone);
    if (!parsed) throw invalid('Invalid or non-existent DTSTART time.', { line: start.number });
    startAt = parsed.instant; sourceTimezone = parsed.timezone;
    if (end) {
      const parsedEnd = instantOf(end, parsed.timezone === 'UTC' ? fallbackTimezone : parsed.timezone);
      if (!parsedEnd) throw invalid('Invalid or non-existent DTEND time.', { line: end.number });
      endAt = parsedEnd.instant;
    } else {
      const ms = duration ? durationMs(duration.value) : null;
      if (duration && ms === null) throw invalid('Invalid DURATION value.', { line: duration.number });
      endAt = new Date(startAt.getTime() + (ms || 3_600_000));
    }
    if (endAt <= startAt) throw invalid('DTEND must be after DTSTART.', { line: end?.number ?? start.number });
  }
  const rawStatus = get('STATUS')?.value.toUpperCase();
  const status = rawStatus === 'CANCELLED' ? 'CANCELLED' : rawStatus === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED';
  const rrule = get('RRULE')?.value ?? null;
  if (get('EXDATE') || get('RDATE')) warnings.push({ uid, code: 'RECURRENCE_DATES_UNSUPPORTED', message: 'EXDATE/RDATE values are not imported.' });
  const text = (name: string, max: number) => { const value = get(name); return value ? unescapeText(value.value).slice(0, max) : null; };
  const event: Omit<IcsEvent, 'etag'> = { uid, title: (text('SUMMARY', 500) ?? '').trim() || '(No title)', description: text('DESCRIPTION', 50_000), location: text('LOCATION', 2000),
    status, isAllDay: allDay, startAt, endAt, startDate, endDate, sourceTimezone, rrule };
  const etag = createHash('sha256').update(JSON.stringify({ ...event, sequence: get('SEQUENCE')?.value ?? null })).digest('hex');
  return { ...event, etag };
}

const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 75) cut--;
    if (cut > 0 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    out.push(rest.slice(0, cut)); rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
};
const utc = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const compactDate = (date: string) => date.replace(/-/g, '');

export type ExportEvent = { id: string; title: string; description: string | null; location: string | null; status: string; isAllDay: boolean;
  startAt: Date | null; endAt: Date | null; startDate: string | null; endDate: string | null; updatedAt: Date; rrule: string | null; sequence: number; sourceTimezone: string };
export function serializeIcs(name: string, events: ExportEvent[]) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TrueCRM//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.id}@truecrm`, `DTSTAMP:${utc(event.updatedAt)}`, `SEQUENCE:${event.sequence}`);
    if (event.isAllDay) lines.push(`DTSTART;VALUE=DATE:${compactDate(event.startDate!)}`, `DTEND;VALUE=DATE:${compactDate(event.endDate!)}`);
    else if (event.rrule && event.sourceTimezone !== 'UTC') {
      // Recurrence expands in local wall-clock time, so recurring timed events keep their TZID across DST.
      const local = (date: Date) => wallClockOf(date, event.sourceTimezone).slice(0, 19).replace(/[-:]/g, '');
      lines.push(`DTSTART;TZID=${event.sourceTimezone}:${local(event.startAt!)}`, `DTEND;TZID=${event.sourceTimezone}:${local(event.endAt!)}`);
    } else lines.push(`DTSTART:${utc(event.startAt!)}`, `DTEND:${utc(event.endAt!)}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    lines.push(`STATUS:${event.status === 'CANCELLED' ? 'CANCELLED' : event.status === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED'}`);
    if (event.rrule) lines.push(`RRULE:${event.rrule.replace(/^RRULE:/i, '').replace(/[\r\n]/g, '')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
