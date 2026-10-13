import { expandRecurrence, recurrenceInstant, validateRecurrence, wallClockOf } from '@/src/server/collab/calendar/recurrence-engine';
import type { RecurrenceDefinition } from '@/src/server/collab/calendar/recurrence-engine';

const timed = (extra: Partial<RecurrenceDefinition> = {}): RecurrenceDefinition => ({
  rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', dtstartLocal: '2030-03-30T09:00:00.000', isAllDay: false, ...extra,
});
const invalid = (fn: () => unknown, code = 'RECURRENCE_INVALID_RULE') => {
  try { fn(); throw new Error('Expected validation failure'); } catch (error) { expect(error).toMatchObject({ code, status: 400 }); }
};

describe('Calendar recurrence expansion engine', () => {
  it('keeps daily local time through spring/fall DST and preserves millisecond precision', () => {
    const spring = expandRecurrence(timed());
    expect(spring.map((row) => row.startAt!.toISOString())).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z']);
    const fall = expandRecurrence(timed({ dtstartLocal: '2030-10-26T09:00:00.123' }));
    expect(fall.map((row) => row.startAt!.toISOString())).toEqual(['2030-10-26T07:00:00.123Z', '2030-10-27T08:00:00.123Z', '2030-10-28T08:00:00.123Z']);
    expect(fall.map((row) => row.recurrenceId)).toEqual(['2030-10-26T09:00:00.123', '2030-10-27T09:00:00.123', '2030-10-28T09:00:00.123']);
  });
  it('skips nonexistent generated times without consuming COUNT, and chooses the earlier overlap', () => {
    const rows = expandRecurrence(timed({ dtstartLocal: '2030-03-30T02:30:00.000' }));
    expect(rows.map((row) => row.recurrenceId)).toEqual(['2030-03-30T02:30:00.000', '2030-04-01T02:30:00.000', '2030-04-02T02:30:00.000']);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(recurrenceInstant('2030-03-31T02:30:00.000', 'Europe/Berlin')).toBeNull();
    expect(recurrenceInstant('2030-10-27T02:30:00.000', 'Europe/Berlin')!.toISOString()).toBe('2030-10-27T00:30:00.000Z');
    invalid(() => validateRecurrence(timed({ dtstartLocal: '2030-03-31T02:30:00.000' })));
  });
  it('handles half-hour DST and skipped date-line days', () => {
    expect(recurrenceInstant('2030-10-06T02:15:00.000', 'Australia/Lord_Howe')).toBeNull();
    expect(recurrenceInstant('2011-12-30T09:00:00.000', 'Pacific/Apia')).toBeNull();
    const rows = expandRecurrence(timed({ sourceTimezone: 'Pacific/Apia', dtstartLocal: '2011-12-29T09:00:00.000' }));
    expect(rows.map((row) => row.recurrenceId)).toEqual(['2011-12-29T09:00:00.000', '2011-12-31T09:00:00.000', '2012-01-01T09:00:00.000']);
    for (const row of rows) expect(wallClockOf(row.startAt!, 'Pacific/Apia')).toBe(row.recurrenceId);
  });
  it('skips impossible monthly dates, handles leap-year recurrence and ordinal/set-position rules', () => {
    expect(expandRecurrence(timed({ sourceTimezone: 'UTC', dtstartLocal: '2030-01-31T09:00:00.000', rruleText: 'FREQ=MONTHLY;COUNT=3' })).map((row) => row.recurrenceId.slice(0, 10)))
      .toEqual(['2030-01-31', '2030-03-31', '2030-05-31']);
    expect(expandRecurrence(timed({ sourceTimezone: 'UTC', dtstartLocal: '2028-02-29T09:00:00.000', rruleText: 'FREQ=YEARLY;COUNT=3' })).map((row) => row.recurrenceId.slice(0, 10)))
      .toEqual(['2028-02-29', '2032-02-29', '2036-02-29']);
    expect(expandRecurrence(timed({ dtstartLocal: '2030-01-28T09:00:00.000', rruleText: 'FREQ=MONTHLY;BYDAY=-1MO;COUNT=3' })).map((row) => row.recurrenceId.slice(0, 10)))
      .toEqual(['2030-01-28', '2030-02-25', '2030-03-25']);
    expect(expandRecurrence(timed({ dtstartLocal: '2030-01-31T09:00:00.000', rruleText: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3' })).map((row) => row.recurrenceId.slice(0, 10)))
      .toEqual(['2030-01-31', '2030-02-28', '2030-03-29']);
  });
  it('keeps all-day values as dates across DST and accepts an inclusive date UNTIL', () => {
    const rows = expandRecurrence({ rruleText: 'FREQ=DAILY;UNTIL=20300401', sourceTimezone: 'Europe/Berlin', dtstartLocal: '2030-03-30', isAllDay: true });
    expect(rows.map((row) => row.startDate)).toEqual(['2030-03-30', '2030-03-31', '2030-04-01']);
    expect(rows.every((row) => row.startAt === null && row.recurrenceId === row.startDate)).toBe(true);
  });
  it('applies UTC UNTIL after timezone conversion and bounds queries without changing original ordinals', () => {
    const definition = timed({ rruleText: 'FREQ=DAILY;UNTIL=20300331T070000Z' });
    expect(expandRecurrence(definition)).toHaveLength(2);
    const rows = expandRecurrence(timed(), { after: '2030-03-30T09:00:00.000', through: '2030-03-31T09:00:00.000' });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ ordinal: 2, recurrenceId: '2030-03-31T09:00:00.000' });
  });
  it('supports weekly intervals/week starts and sub-day rules without treating local values as UTC', () => {
    expect(expandRecurrence(timed({ dtstartLocal: '2030-01-07T09:00:00.000', rruleText: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO;COUNT=4' })).map((row) => row.recurrenceId.slice(0, 10)))
      .toEqual(['2030-01-07', '2030-01-09', '2030-01-21', '2030-01-23']);
    expect(expandRecurrence(timed({ dtstartLocal: '2030-03-31T01:30:00.000', rruleText: 'FREQ=HOURLY;COUNT=3' })).map((row) => row.recurrenceId))
      .toEqual(['2030-03-31T01:30:00.000', '2030-03-31T03:30:00.000', '2030-03-31T04:30:00.000']);
  });
  it('rejects invalid dates, timezones, duplicated/unknown/contradictory/out-of-range rule parts', () => {
    for (const rruleText of ['FREQ=BAD', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;DTSTART=20300101', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;INTERVAL=-1',
      'FREQ=DAILY;COUNT=3;UNTIL=20300401T000000Z', 'FREQ=DAILY;BYHOUR=24', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=DAILY;BYDAY=2MO',
      'FREQ=DAILY;BYDAY=54MO', 'FREQ=DAILY;BYSETPOS=2', 'FREQ=WEEKLY;BYMONTHDAY=10', 'FREQ=DAILY;UNTIL=20300230T090000Z',
      'FREQ=DAILY;UNTIL=20300331T250000Z', 'FREQ=DAILY;UNTIL=20300301T090000Z', 'FREQ=DAILY\nEXDATE:20300401']) invalid(() => validateRecurrence(timed({ rruleText })));
    invalid(() => validateRecurrence(timed({ sourceTimezone: 'Mars/Orbit' })));
    invalid(() => validateRecurrence(timed({ dtstartLocal: '2030-02-30T09:00:00.000' })));
    invalid(() => validateRecurrence({ ...timed(), isAllDay: true, dtstartLocal: '2030-03-30', rruleText: 'FREQ=DAILY;BYHOUR=9' }));
    invalid(() => validateRecurrence({ ...timed(), isAllDay: true, dtstartLocal: '2030-03-30', rruleText: 'FREQ=DAILY;UNTIL=20300401T000000Z' }));
    invalid(() => expandRecurrence(timed(), { limit: 1001 }), 'RECURRENCE_SCOPE_INVALID');
    invalid(() => expandRecurrence(timed(), { after: '2030-02-30T09:00:00.000' }), 'RECURRENCE_SCOPE_INVALID');
  });
  it('fails explicitly when an unbounded high-frequency scan exceeds its synchronous budget', () => {
    invalid(() => expandRecurrence(timed({ sourceTimezone: 'UTC', dtstartLocal: '2030-01-01T00:00:00.000', rruleText: 'FREQ=SECONDLY' }), { after: '2030-01-02T00:00:00.000', limit: 1 }), 'RECURRENCE_SCOPE_INVALID');
  });
});
