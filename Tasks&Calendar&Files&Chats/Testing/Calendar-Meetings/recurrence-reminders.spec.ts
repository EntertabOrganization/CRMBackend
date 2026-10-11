import { RecordingNotificationPort } from '@/src/server/ports';
import { b, collabApp } from '../support/domain';

async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Series', timezone: 'Europe/Berlin' }));
  const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Daily', startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin' }));
  const rule = calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=4', sourceTimezone: 'Europe/Berlin', version: 0 }), true)!;
  return { ...c, get state() { return c.state; }, calendar, event, rule };
}
describe('Calendar Recurrence & Reminders Specification contract', () => {
  it('DST recurrence.', async () => {
    const c = await setup();
    expect(c.rule.upcoming.map((row) => row.startAt!.toISOString())).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z', '2030-04-02T07:00:00.000Z']);
    expect(c.rule.upcoming[1].recurrenceId).toBe('2030-03-31T09:00:00.000');
  });
  it('Exception identity.', async () => {
    const c = await setup(), identity = c.rule.upcoming[1].recurrenceId;
    c.calendar.recurrence.editOccurrence(c.owner, c.event.id, identity, b({ startAt: '2030-04-10T12:00:00+02:00', version: 1 }));
    c.calendar.recurrence.cancelOccurrence(c.owner, c.event.id, identity, b({ version: 2 }));
    expect(c.calendar.recurrence.get(c.owner, c.event.id)!.upcoming[1]).toMatchObject({ recurrenceId: identity, startAt: new Date('2030-04-10T10:00:00Z'), status: 'CANCELLED' });
    expect(c.state.calendarRecurrenceExceptions).toHaveLength(1);
  });
  it('Edit one vs future vs all.', async () => {
    const c = await setup();
    c.calendar.recurrence.editOccurrence(c.owner, c.event.id, c.rule.upcoming[2].recurrenceId, b({ title: 'Independent', version: 1 }));
    c.calendar.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: c.rule.upcoming[1].recurrenceId, title: 'Future', version: 2 }));
    c.calendar.events.update(c.owner, c.event.id, b({ title: 'Series', version: c.calendar.events.get(c.owner, c.event.id).version }));
    expect(c.calendar.recurrence.get(c.owner, c.event.id)!.upcoming.map((row) => row.title)).toEqual(['Series', 'Future', 'Independent', 'Future']);
  });
  it('Retry reminder send.', async () => {
    const c = await setup(), port = new RecordingNotificationPort();
    let fail = true;
    c.app.setNotificationPort({ canDeliver: () => true, notifyUsers: (input) => { const result = port.notifyUsers(input); if (fail) { fail = false; throw new Error('Ambiguous provider response'); } return result; } });
    const row = c.calendar.reminders.create(c.owner, c.event.id, b({ recurrenceId: c.rule.upcoming[1].recurrenceId, offsetSeconds: 900, channel: 'EMAIL' }));
    const before = structuredClone(c.state.calendarRecurrenceRules), runner = c.calendar.reminderRunner({ unit: async (fn) => fn() });
    expect((await runner.runDue({ now: new Date('2030-03-31T06:45:00Z') })).failed).toBe(1);
    expect((await runner.runDue({ now: row.nextAttemptAt! })).sent).toBe(1);
    expect(row).toMatchObject({ status: 'SENT', attempts: 2 }); expect(port.sent).toHaveLength(1);
    expect(c.state.calendarRecurrenceRules).toEqual(before);
  });
});
