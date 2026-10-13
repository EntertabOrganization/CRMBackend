import { RecordingNotificationPort } from '@/src/server/ports';
import { advanceRecurrence, expandRecurrence } from '@/src/server/collab/calendar/recurrence-engine';
import { b, collabApp } from '../support/domain';

async function setup(ruleText = 'FREQ=DAILY;COUNT=5') {
  const c = await collabApp(), calendar = c.collab.calendar, port = new RecordingNotificationPort();
  c.app.setNotificationPort(port);
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Series', timezone: 'Europe/Berlin' }));
  const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Series',
    startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin' }));
  calendar.recurrence.update(c.owner, event.id, b({ rruleText: ruleText, sourceTimezone: 'Europe/Berlin', version: 0 }), true);
  const parent = calendar.reminders.create(c.owner, event.id, b({ offsetSeconds: 900, channel: 'IN_APP' }));
  return { ...c, get state() { return c.state; }, calendar, event, parent, port,
    children: () => c.state.calendarEventReminders.filter((row) => row.seriesReminderId === parent.id),
    runner: calendar.reminderRunner({ unit: async (fn) => fn() }) };
}

describe('Automatic recurring Calendar reminder materialization', () => {
  it('creates one durable delivery per original identity, follows DST and never dispatches the series configuration', async () => {
    const c = await setup(), now = new Date('2030-03-30T07:45:00Z');
    expect(c.parent).toMatchObject({ isSeries: true, dueAt: null, recurrenceId: null });
    expect(await c.runner.runDue({ now })).toMatchObject({ sent: 1 });
    expect(c.children().find((row) => row.recurrenceId === '2030-03-31T09:00:00.000')?.dueAt).toEqual(new Date('2030-03-31T06:45:00Z'));
    const ids = c.children().map((row) => row.id);
    expect(await c.runner.runDue({ now })).toMatchObject({ claimed: 0 });
    expect(c.children().map((row) => row.id)).toEqual(ids); expect(c.parent.attempts).toBe(0);
    expect(await c.runner.runDue({ now: new Date('2030-03-31T06:45:00Z') })).toMatchObject({ sent: 1 });
    expect(c.port.sent).toHaveLength(2);
  });
  it('revalidates moved, cancelled and future occurrences without resending sent history', async () => {
    const c = await setup(), now = new Date('2030-03-30T07:45:00Z');
    await c.runner.runDue({ now });
    const sent = c.children().find((row) => row.status === 'SENT')!, identity = '2030-03-31T09:00:00.000';
    c.calendar.recurrence.editOccurrence(c.owner, c.event.id, identity, b({ startAt: '2030-03-31T12:00:00+02:00', version: 1 }));
    const moved = c.children().find((row) => row.recurrenceId === identity)!;
    expect(c.calendar.reminders.canClaim(moved)).toBe(false);
    c.calendar.reminders.materialize(now);
    expect(moved.dueAt).toEqual(new Date('2030-03-31T09:45:00Z')); expect(c.calendar.reminders.canClaim(moved)).toBe(true);
    c.calendar.recurrence.cancelOccurrence(c.owner, c.event.id, identity, b({ version: 2 }));
    c.calendar.reminders.materialize(now); expect(moved.status).toBe('CANCELLED');
    c.calendar.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: '2030-04-01T09:00:00.000', startAt: '2030-04-01T13:00:00+02:00', version: 3 }));
    c.calendar.reminders.materialize(now);
    expect(c.children().find((row) => row.recurrenceId === '2030-04-01T09:00:00.000')?.dueAt).toEqual(new Date('2030-04-01T10:45:00Z'));
    expect(sent.status).toBe('SENT'); expect(sent.sentAt).toEqual(now); expect(c.port.sent).toHaveLength(1);
  });
  it('propagates parent edits, preserves explicit occurrence overrides and cancels pending children', async () => {
    const c = await setup(), now = new Date('2030-03-30T07:00:00Z');
    c.calendar.reminders.materialize(now);
    const override = c.children()[0];
    c.calendar.reminders.update(c.owner, override.id, b({ offsetSeconds: 600, channel: 'EMAIL', version: override.version }));
    c.calendar.reminders.update(c.owner, c.parent.id, b({ offsetSeconds: 1800, channel: 'PUSH', version: c.parent.version }));
    c.calendar.reminders.materialize(now);
    expect(override).toMatchObject({ channel: 'EMAIL', offsetSeconds: 600, isSeriesOverride: true });
    expect(c.children()[1]).toMatchObject({ channel: 'PUSH', offsetSeconds: 1800, dueAt: new Date('2030-03-31T06:30:00Z') });
    c.calendar.reminders.remove(c.owner, c.parent.id, b({ version: c.parent.version }));
    expect(c.children().every((row) => row.status === 'CANCELLED')).toBe(true);
    expect((await c.runner.runDue({ now: new Date('2030-04-02T12:00:00Z') })).claimed).toBe(0);
  });
  it('removes pending identities excluded by a rule change, without changing sent evidence', async () => {
    const c = await setup(), now = new Date('2030-03-30T07:45:00Z');
    await c.runner.runDue({ now }); const sent = c.children()[0], removed = c.children()[1];
    c.calendar.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY;INTERVAL=2;COUNT=3', version: 1 }));
    c.calendar.reminders.materialize(now);
    expect(removed.status).toBe('CANCELLED'); expect(sent.status).toBe('SENT');
    expect(c.children().filter((row) => row.recurrenceId === sent.recurrenceId)).toHaveLength(1);
  });
  it('resumes bounded backfill pages and skips historical deliveries', async () => {
    const c = await setup('FREQ=DAILY;COUNT=1500'), now = new Date('2033-01-01T00:00:00Z');
    c.calendar.reminders.materialize(now);
    expect(c.parent.cursorOrdinal).toBe(1000); expect(c.children()).toHaveLength(0);
    c.calendar.reminders.materialize(now);
    expect(c.parent.cursorOrdinal).toBeGreaterThan(1000); expect(c.children().length).toBeGreaterThan(0);
    expect(c.children().every((row) => row.dueAt! >= now)).toBe(true);
  });
  it('does not consume COUNT for DST gaps across durable pages', () => {
    const definition = { rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', dtstartLocal: '2030-03-30T02:30:00.000', isAllDay: false };
    const first = advanceRecurrence(definition, { after: null, ordinal: 0, through: '2030-04-04T23:00:00.000', candidateLimit: 2 });
    expect(first).toMatchObject({ cursor: '2030-03-31T02:30:00.000', ordinal: 1, bounded: true });
    const next = advanceRecurrence(definition, { after: first.cursor, ordinal: first.ordinal, through: '2030-04-04T23:00:00.000', candidateLimit: 2 });
    expect(next.occurrences.map((row) => row.ordinal)).toEqual([2, 3]); expect(next.exhausted).toBe(true);
  });
  it('resumes an old dense series directly from its durable cursor', () => {
    const page = advanceRecurrence({ rruleText: 'FREQ=SECONDLY', sourceTimezone: 'UTC',
      dtstartLocal: '2000-01-01T00:00:00.000', isAllDay: false }, {
      after: '2030-01-01T00:00:00.000', ordinal: 946_771_201, through: '2030-01-01T00:00:05.000', candidateLimit: 3,
    });
    expect(page.occurrences.map((row) => row.recurrenceId)).toEqual([
      '2030-01-01T00:00:01.000', '2030-01-01T00:00:02.000', '2030-01-01T00:00:03.000',
    ]);
    expect(page).toMatchObject({ cursor: '2030-01-01T00:00:03.000', ordinal: 946_771_204, bounded: true });
  });
  it('edits an occurrence materialized beyond the synchronous recurrence preview budget', async () => {
    const c = await setup('FREQ=DAILY'), now = new Date('2090-01-01T07:00:00Z');
    // Resume a persisted backfill checkpoint, rather than replaying sixty years in a request.
    c.parent.cursorRecurrenceId = '2089-12-31T09:00:00.000';
    c.parent.cursorOrdinal = (Date.parse('2089-12-31T00:00:00Z') - Date.parse('2030-03-30T00:00:00Z')) / 86_400_000 + 1;
    c.parent.cursorRuleVersion = 1; c.parent.cursorEventVersion = c.calendar.events.get(c.owner, c.event.id).version;
    c.calendar.reminders.materialize(now);
    const child = c.children()[0]; expect(child.recurrenceOrdinal).toBeGreaterThan(20_000);
    c.calendar.reminders.update(c.owner, child.id, b({ offsetSeconds: 600, channel: 'EMAIL', version: child.version }));
    expect(child).toMatchObject({ dueAt: new Date('2090-01-01T07:50:00Z'), channel: 'EMAIL', isSeriesOverride: true });
  });
  it('materializes all-day reminders at source midnight and suppresses disabled channels for every occurrence', async () => {
    const c = await collabApp(), calendar = c.collab.calendar, port = new RecordingNotificationPort();
    c.app.setNotificationPort(port);
    const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Days', timezone: 'Europe/Berlin' }));
    const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Days', isAllDay: true,
      startDate: '2030-03-31', endDate: '2030-04-01', sourceTimezone: 'Europe/Berlin' }));
    calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'Europe/Berlin', version: 0 }), true);
    const parent = calendar.reminders.create(c.owner, event.id, b({ offsetSeconds: 0, channel: 'PUSH' }));
    port.setChannelAllowed(c.owner.workspaceId, c.owner.user.id, 'PUSH', false);
    const runner = calendar.reminderRunner({ unit: async (fn) => fn() });
    expect(await runner.runDue({ now: new Date('2030-03-30T23:00:00Z') })).toMatchObject({ suppressed: 1 });
    expect(await runner.runDue({ now: new Date('2030-03-31T22:00:00Z') })).toMatchObject({ suppressed: 1 });
    const children = c.state.calendarEventReminders.filter((row) => row.seriesReminderId === parent.id);
    expect(children.map((row) => row.dueAt)).toEqual([new Date('2030-03-30T23:00:00Z'), new Date('2030-03-31T22:00:00Z')]);
    expect(children.every((row) => row.status === 'CANCELLED')).toBe(true); expect(port.sent).toHaveLength(0);
  });
  it.each([
    'FREQ=YEARLY;INTERVAL=2;COUNT=18',
    'FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO,WE;COUNT=18',
    'FREQ=MONTHLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=18',
    'FREQ=MONTHLY;BYDAY=-1SU;COUNT=18',
    'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=18',
    'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH;WKST=SU;COUNT=18',
    'FREQ=WEEKLY;INTERVAL=2;COUNT=18',
    'FREQ=DAILY;INTERVAL=3;BYHOUR=9,14;BYMINUTE=10,40;BYSETPOS=-1;COUNT=18',
    'FREQ=HOURLY;INTERVAL=3;BYMINUTE=5,30;COUNT=18',
    'FREQ=MINUTELY;INTERVAL=7;BYSECOND=5,40;COUNT=18',
    'FREQ=SECONDLY;INTERVAL=7;COUNT=18',
  ])('preserves original defaults, interval phase and BYSETPOS across pages: %s', (rruleText) => {
    const definition = { rruleText, sourceTimezone: 'Europe/Berlin', dtstartLocal: '2030-03-30T09:23:11.000', isAllDay: false };
    const expected = expandRecurrence(definition, { limit: 18 });
    let after: string | null = null, ordinal = 0, exhausted = false;
    const actual: typeof expected = [];
    for (let page = 0; !exhausted && page < 20; page += 1) {
      const result = advanceRecurrence(definition, { after, ordinal, through: '2070-12-31T23:59:59.000', candidateLimit: 2 });
      actual.push(...result.occurrences); after = result.cursor; ordinal = result.ordinal; exhausted = result.exhausted;
    }
    expect(actual).toEqual(expected); expect(exhausted).toBe(true);
  });
});
