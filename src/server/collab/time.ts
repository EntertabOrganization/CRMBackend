/**
 * Time-zone arithmetic on top of Intl (no extra dependency). Recurrences are defined in LOCAL time of an IANA zone and
 * converted to instants per occurrence, so "09:00 Europe/Berlin" stays 09:00 local across DST changes.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let dtf = formatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(timeZone, dtf);
  }
  return dtf;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock parts of an instant in a zone. weekday: ISO 1 = Monday ... 7 = Sunday. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS[parts.weekday],
  };
}

/** Offset (ms) of the zone from UTC at an instant. */
export function zoneOffsetMs(instant: Date, timeZone: string) {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function localDate(instant: Date, timeZone: string) {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Instant for a local date + time in a zone. A time skipped by a DST gap resolves to the same wall-clock distance after
 * the gap (02:30 on a spring-forward night becomes 03:30); an ambiguous fall-back time resolves to the earlier instant.
 */
export function zonedDateTimeToInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const local = Date.UTC(y, m - 1, d, hh, mm);
  const before = zoneOffsetMs(new Date(local - 3 * 3_600_000), timeZone);
  const after = zoneOffsetMs(new Date(local + 3 * 3_600_000), timeZone);
  const matches = (candidate: number) => {
    const p = localParts(new Date(candidate), timeZone);
    return p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm;
  };
  const candidates = [local - before, local - after].filter(matches).sort((a, b) => a - b);
  if (candidates.length > 0) return new Date(candidates[0]);
  return new Date(local - before);
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function isoWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const isLocalTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
