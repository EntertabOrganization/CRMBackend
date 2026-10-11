import { expectAppError } from '@/tests/support/domain';
import { expandRecurrence, recurrenceIdsBetween } from '@/src/server/collab/calendar/recurrence-engine';
import { b, collabApp, perms } from '../support/domain';
const range = { startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T18:00:00Z' };
const week = (start = '09:00', end = '17:00') => [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, localStartTime: start, localEndTime: end }));
async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Private', timezone: 'UTC' }));
  const event = (startAt = '2030-01-07T09:00:00Z', endAt = '2030-01-07T10:00:00Z') => calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Secret customer', description: 'Private notes', startAt, endAt }));
  return { ...c, get state() { return c.state; }, calendar, event, availability: calendar.availability, schedules: calendar.schedules };
}
describe('Authoritative free/busy and working-schedule slot queries', () => {
  it('exposes only merged intervals for private Events without requiring Event detail access', async () => {
    const c = await setup(), reader = await c.memberActor('busy-reader', perms('WORKSPACE', 'calendar.free_busy'));
    c.event(); c.event('2030-01-07T09:30:00Z', '2030-01-07T10:30:00Z');
    const result = c.availability.freeBusy(reader, b({ ...range, userIds: [c.owner.user.id] }));
    expect(result.users[0].busy).toEqual([{ startAt: new Date('2030-01-07T09:00:00Z'), endAt: new Date('2030-01-07T10:30:00Z'), state: 'BUSY' }]);
    expect(JSON.stringify(result)).not.toMatch(/Secret|Private|eventId|organizer|description|calendarId/);
  });
  it('enforces live membership and action scope for every selected user and resource', async () => {
    const c = await setup(), own = await c.memberActor('own-busy', perms('OWN', 'calendar.free_busy'));
    expect(c.availability.freeBusy(own, b(range)).users[0].userId).toBe(own.user.id);
    await expectAppError(() => c.availability.freeBusy(own, b({ ...range, userIds: [c.owner.user.id] })), 'AVAILABILITY_SUBJECT_NOT_FOUND', 404);
    const foreign = await c.foreignActor();
    await expectAppError(() => c.availability.freeBusy(c.owner, b({ ...range, userIds: [foreign.user.id] })), 'AVAILABILITY_SUBJECT_NOT_FOUND', 404);
    const resource = c.calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'Room', timezone: 'UTC' }));
    await expectAppError(() => c.availability.freeBusy(own, b({ ...range, resourceIds: [resource.id] })), 'PERMISSION_DENIED', 403);
  });
  it('ignores cancelled, deleted, FREE and declined-attendee Events', async () => {
    const c = await setup(), attendee = await c.memberActor('busy-attendee', perms('WORKSPACE', 'calendar.free_busy', 'event.read'));
    const event = c.event(); c.calendar.events.addAttendees(c.owner, event.id, b({ userId: attendee.user.id }));
    expect(c.availability.freeBusy(attendee, b(range)).users[0].busy).toHaveLength(1);
    c.calendar.events.respond(attendee, event.id, b({ response: 'DECLINED' }));
    expect(c.availability.freeBusy(attendee, b(range)).users[0].busy).toHaveLength(0);
    c.calendar.events.update(c.owner, event.id, b({ busyStatus: 'FREE', version: c.calendar.events.get(c.owner, event.id).version }));
    expect(c.availability.freeBusy(c.owner, b(range)).users[0].busy).toHaveLength(0);
    c.calendar.events.cancel(c.owner, event.id, b());
    expect(c.availability.freeBusy(c.owner, b(range)).users[0].busy).toHaveLength(0);
  });
  it('intersects business and user windows, excludes holidays/busy periods and honors date overrides', async () => {
    const c = await setup(); c.event();
    c.schedules.setBusiness(c.owner, b({ timezone: 'UTC', weekly: week(), holidays: ['2030-01-08'], version: 0 }));
    c.schedules.setUser(c.owner, c.owner.user.id, b({ timezone: 'UTC', weekly: week('10:00', '16:00'), version: 0 }));
    const result = c.availability.suggest(c.owner, b({ ...range, durationMinutes: 60, stepMinutes: 60, limit: 10 }));
    expect(result.slots).toHaveLength(6); expect(result.slots[0].startAt).toEqual(new Date('2030-01-07T10:00:00Z'));
    expect(result.slots.at(-1)!.endAt).toEqual(new Date('2030-01-07T16:00:00Z'));
    const holiday = { startAt: '2030-01-08T08:00:00Z', endAt: '2030-01-08T18:00:00Z', durationMinutes: 60 };
    expect(c.availability.suggest(c.owner, b(holiday)).slots).toHaveLength(0);
    c.schedules.setBusiness(c.owner, b({ timezone: 'UTC', weekly: week(), holidays: ['2030-01-08'], overrides: [{ date: '2030-01-08', windows: [{ localStartTime: '12:00', localEndTime: '14:00' }] }], version: 1 }));
    expect(c.availability.suggest(c.owner, b({ ...holiday, stepMinutes: 60 })).slots).toHaveLength(2);
  });
  it('considers selected attendees/resources together, capacity and disabled resources', async () => {
    const c = await setup(), room = c.calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'Room', timezone: 'UTC', capacity: 1 }));
    const event = c.event(); c.calendar.resources.book(c.owner, event.id, b({ resourceId: room.id }));
    const query = { ...range, resourceIds: [room.id], durationMinutes: 60, stepMinutes: 60 };
    expect(c.availability.suggest(c.owner, b(query)).slots.some((slot) => slot.startAt.toISOString() === '2030-01-07T09:00:00.000Z')).toBe(false);
    const other = await c.memberActor('capacity-busy', perms('WORKSPACE', 'calendar.free_busy'));
    await expectAppError(() => c.availability.suggest(c.owner, b({ ...query, userIds: [c.owner.user.id, other.user.id] })), 'RESOURCE_CAPACITY_INVALID', 400);
    c.calendar.resources.update(c.owner, room.id, b({ isActive: false, version: 1 }));
    expect(c.availability.freeBusy(c.owner, b({ ...range, resourceIds: [room.id] })).resources[0].free).toHaveLength(0);
    await expectAppError(() => c.availability.suggest(c.owner, b(query)), 'RESOURCE_INACTIVE', 409);
  });
  it('projects all-day and recurring Events across DST, including moved, cancelled and future overrides', async () => {
    const c = await setup(), event = c.calendar.events.create(c.owner, b({ calendarId: c.state.calendars[0].id, title: 'DST', sourceTimezone: 'Europe/Berlin', startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00' }));
    c.calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=4', sourceTimezone: 'Europe/Berlin', version: 0 }), true);
    const dst = { startAt: '2030-03-30T00:00:00Z', endAt: '2030-04-03T00:00:00Z' };
    expect(c.availability.freeBusy(c.owner, b(dst)).users[0].busy.map((row) => row.startAt.toISOString())).toEqual([
      '2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z', '2030-04-02T07:00:00.000Z',
    ]);
    c.calendar.recurrence.editOccurrence(c.owner, event.id, '2030-03-31T09:00:00.000', b({ startAt: '2030-04-10T12:00:00+02:00', version: 1 }));
    expect(c.availability.freeBusy(c.owner, b({ startAt: '2030-04-10T00:00:00Z', endAt: '2030-04-11T00:00:00Z' })).users[0].busy[0].startAt).toEqual(new Date('2030-04-10T10:00:00Z'));
    c.calendar.recurrence.cancelOccurrence(c.owner, event.id, '2030-04-01T09:00:00.000', b({ version: 2 }));
    c.calendar.recurrence.editFuture(c.owner, event.id, b({ recurrenceId: '2030-04-02T09:00:00.000', startAt: '2030-04-02T14:00:00+02:00', version: 3 }));
    expect(c.availability.freeBusy(c.owner, b(dst)).users[0].busy.map((row) => row.startAt.toISOString())).toEqual(['2030-03-30T08:00:00.000Z', '2030-04-02T12:00:00.000Z']);
  });
  it('uses source midnight for all-day events and skips nonexistent working-window boundaries', async () => {
    const c = await setup();
    c.calendar.events.create(c.owner, b({ calendarId: c.state.calendars[0].id, title: 'Day', isAllDay: true, startDate: '2030-03-31', endDate: '2030-04-01', sourceTimezone: 'Europe/Berlin' }));
    const result = c.availability.freeBusy(c.owner, b({ startAt: '2030-03-30T20:00:00Z', endAt: '2030-04-01T00:00:00Z' }));
    expect(result.users[0].busy[0]).toMatchObject({ startAt: new Date('2030-03-30T23:00:00Z'), endAt: new Date('2030-03-31T22:00:00Z') });
    c.schedules.setBusiness(c.owner, b({ timezone: 'Europe/Berlin', weekly: [{ dayOfWeek: 7, localStartTime: '02:30', localEndTime: '04:00' }], version: 0 }));
    expect(c.availability.suggest(c.owner, b({ startAt: '2030-03-31T00:00:00Z', endAt: '2030-03-31T06:00:00Z', durationMinutes: 30 })).slots).toHaveLength(0);
  });
  it('rejects invalid queries and schedule changes without partial writes', async () => {
    const c = await setup();
    for (const input of [{ ...range, endAt: range.startAt }, { ...range, startAt: '2030-02-31T08:00:00Z' }, { ...range, startAt: '2030-01-07T08:00:00' }, { ...range, userIds: [], resourceIds: [] }])
      await expectAppError(() => c.availability.freeBusy(c.owner, b(input)), 'AVAILABILITY_INVALID_RANGE', 400);
    await expectAppError(() => c.schedules.setBusiness(c.owner, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 8, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 })), 'AVAILABILITY_INVALID_RANGE', 400);
    expect(c.state.businessCalendars).toHaveLength(0);
    c.schedules.setBusiness(c.owner, b({ timezone: 'UTC', weekly: week(), version: 0 }));
    await expectAppError(() => c.schedules.setBusiness(c.owner, b({ timezone: 'UTC', weekly: [], version: 0 })), 'RESOURCE_VERSION_CONFLICT', 409);
    expect(c.state.businessCalendars[0].weekly).toHaveLength(5);
  });
  it('queues a dense window without exposing partial free time', async () => {
    const c = await setup(), event = c.event();
    c.calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=SECONDLY', sourceTimezone: 'UTC', version: 0 }), true);
    expect(c.availability.freeBusy(c.owner, b(range))).toMatchObject({ pending: true, users: [], resources: [] });
    expect(c.availability.suggest(c.owner, b({ ...range, durationMinutes: 30 }))).toMatchObject({ pending: true, slots: [] });
    expect(c.state.calendarAvailabilityRebuilds).toHaveLength(1);
  });
  it('queries an old unbounded series without replaying its entire history', async () => {
    const c = await setup(), event = c.calendar.events.create(c.owner, b({ calendarId: c.state.calendars[0].id, title: 'Old series',
      startAt: '2000-01-01T09:00:00Z', endAt: '2000-01-01T10:00:00Z', sourceTimezone: 'UTC' }));
    c.calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY', sourceTimezone: 'UTC', version: 0 }), true);
    const result = c.availability.freeBusy(c.owner, b(range));
    expect(result.users[0].busy).toEqual([{ startAt: new Date('2030-01-07T09:00:00Z'), endAt: new Date('2030-01-07T10:00:00Z'), state: 'BUSY' }]);
  });
  it('does not count a DST gap as an occurrence in free/busy', async () => {
    const c = await setup(), event = c.calendar.events.create(c.owner, b({ calendarId: c.state.calendars[0].id, title: 'Gap series',
      startAt: '2030-03-30T02:30:00+01:00', endAt: '2030-03-30T03:30:00+01:00', sourceTimezone: 'Europe/Berlin' }));
    c.calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', version: 0 }), true);
    const result = c.availability.freeBusy(c.owner, b({ startAt: '2030-03-30T00:00:00Z', endAt: '2030-04-04T00:00:00Z' }));
    expect(result.users[0].busy.map((row) => row.startAt.toISOString())).toEqual(['2030-03-30T01:30:00.000Z', '2030-04-01T00:30:00.000Z', '2030-04-02T00:30:00.000Z']);
  });
  it.each(['FREQ=YEARLY;INTERVAL=2', 'FREQ=MONTHLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    'FREQ=MONTHLY;BYDAY=-1SU', 'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH;WKST=SU',
    'FREQ=DAILY;INTERVAL=3;BYHOUR=9,14;BYMINUTE=10,40;BYSETPOS=-1', 'FREQ=HOURLY;INTERVAL=3;BYMINUTE=5,30'])('preserves DTSTART phase in window expansion: %s', (rruleText) => {
    const definition = { rruleText, sourceTimezone: 'UTC', dtstartLocal: '2030-03-30T09:23:11.000', isAllDay: false };
    const original = expandRecurrence(definition, { limit: 1000 });
    const from = original[5].recurrenceId, through = original[12].recurrenceId;
    expect(recurrenceIdsBetween(definition, { from, through })).toEqual(original.filter((row) => row.recurrenceId >= from && row.recurrenceId <= through).map((row) => row.recurrenceId));
  });
});
