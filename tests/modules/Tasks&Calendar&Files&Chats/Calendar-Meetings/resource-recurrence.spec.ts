import { expectAppError } from '@/tests/support/domain';
import { b, collabApp } from '../support/domain';

async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Series', timezone: 'UTC' }));
  const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Private series',
    startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' }));
  const resource = calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'Room', timezone: 'UTC' }));
  const rule = calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'UTC', version: 0 }), true);
  expect(rule).not.toBeNull();
  const root = calendar.resources.book(c.owner, event.id, b({ resourceId: resource.id }));
  return { ...c, calendar, container, event, resource, rule: rule!, root };
}

describe('Authoritative recurring resource reservations', () => {
  it('follows moved and cancelled occurrences and retains history when recurrence is removed', async () => {
    const c = await setup(), id = '2030-01-02T09:00:00.000';
    const child = c.state.calendarResourceBookings.find(row => row.seriesBookingId === c.root.id && row.recurrenceId === id)!;
    c.calendar.recurrence.editOccurrence(c.owner, c.event.id, id, b({ startAt: '2030-06-02T12:00:00Z', endAt: '2030-06-02T13:00:00Z', version: 1 }));
    expect(child.startAt).toEqual(new Date('2030-06-02T12:00:00Z'));
    expect(c.calendar.resources.busy(c.resource.id, { startAt: new Date('2030-06-02'), endAt: new Date('2030-06-03') })).toEqual([
      { startAt: new Date('2030-06-02T12:00:00Z'), endAt: new Date('2030-06-02T13:00:00Z') }]);
    c.calendar.recurrence.cancelOccurrence(c.owner, c.event.id, id, b({ version: 2 }));
    expect(child.status).toBe('CANCELLED');
    expect(c.calendar.resources.busy(c.resource.id, { startAt: new Date('2030-06-02'), endAt: new Date('2030-06-03') })).toEqual([]);
    c.calendar.recurrence.remove(c.owner, c.event.id, b({ version: 3 }));
    expect(c.root.recurrenceId).toBe('SINGLE');
    expect(c.state.calendarResourceBookings.filter(row => row.seriesBookingId === c.root.id).every(row => row.status === 'CANCELLED')).toBe(true);
  });

  it('checks virtual future occurrences beyond the stored window and fails closed on dense rules', async () => {
    const c = await setup();
    c.calendar.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY', version: 1 }));
    const event = c.calendar.events.create(c.owner, b({ calendarId: c.container.id, title: 'Conflict',
      startAt: '2031-01-01T09:30:00Z', endAt: '2031-01-01T10:30:00Z' }));
    await expectAppError(() => c.calendar.resources.book(c.owner, event.id, b({ resourceId: c.resource.id })), 'RESOURCE_BOOKING_CONFLICT', 409);
    const before = structuredClone(c.state.calendarResourceBookings);
    await expectAppError(() => c.calendar.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=MINUTELY', version: 2 })), 'AVAILABILITY_UNAVAILABLE', 409);
    expect(c.state.calendarResourceBookings).toEqual(before);
    expect(c.state.calendarRecurrenceRules.find(row => row.id === c.rule.id)!.rruleText).toBe('FREQ=DAILY');
  });

  it('preflights exception conflicts without changing the recurrence graph or reservation intervals', async () => {
    const c = await setup();
    const event = c.calendar.events.create(c.owner, b({ calendarId: c.container.id, title: 'Other',
      startAt: '2030-01-02T12:00:00Z', endAt: '2030-01-02T13:00:00Z' }));
    c.calendar.resources.book(c.owner, event.id, b({ resourceId: c.resource.id }));
    const before = structuredClone(c.state.calendarResourceBookings);
    await expectAppError(() => c.calendar.recurrence.editOccurrence(c.owner, c.event.id, '2030-01-02T09:00:00.000',
      b({ startAt: '2030-01-02T12:00:00Z', endAt: '2030-01-02T13:00:00Z', version: 1 })), 'RESOURCE_BOOKING_CONFLICT', 409);
    expect(c.state.calendarRecurrenceExceptions).toHaveLength(0);
    expect(c.state.calendarResourceBookings).toEqual(before);
  });

  it('moves future ranges beyond the initial horizon while keeping occurrence identities', async () => {
    const c = await setup();
    const id = '2030-01-02T09:00:00.000';
    const child = c.state.calendarResourceBookings.find(row => row.seriesBookingId === c.root.id && row.recurrenceId === id)!;
    c.calendar.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: id, startAt: '2030-06-02T09:00:00Z', version: 1 }));
    expect(child.startAt).toEqual(new Date('2030-06-02T09:00:00Z'));
    expect(c.state.calendarResourceBookings.filter(row => row.seriesBookingId === c.root.id && row.status === 'ACTIVE')).toHaveLength(3);
  });

  it('reserves all-day occurrences using local midnight across daylight saving changes', async () => {
    const c = await collabApp(), calendar = c.collab.calendar;
    const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'DST', timezone: 'America/New_York' }));
    const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'DST', isAllDay: true,
      startDate: '2030-03-09', endDate: '2030-03-10', sourceTimezone: 'America/New_York' }));
    const resource = calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'DST Room', timezone: 'America/New_York' }));
    calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'America/New_York', version: 0 }), true);
    const root = calendar.resources.book(c.owner, event.id, b({ resourceId: resource.id }));
    const rows = c.state.calendarResourceBookings.filter(row => row.seriesBookingId === root.id);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.recurrenceId === '2030-03-10')!.endAt.getTime() - rows.find(row => row.recurrenceId === '2030-03-10')!.startAt.getTime()).toBe(23 * 3_600_000);
  });
});
