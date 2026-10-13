import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Rooms', timezone: 'UTC' }));
  const event = (startAt = '2030-01-01T09:00:00Z', endAt = '2030-01-01T10:00:00Z') => calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Private secret meeting', startAt, endAt }));
  const resource = calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'Room', timezone: 'UTC', capacity: 2 }));
  return { ...c, get state() { return c.state; }, calendar, event, resource, resources: calendar.resources };
}
describe('Calendar shared resource reservations', () => {
  it('checks configured business windows before acquiring or moving a reservation', async () => {
    const c = await setup();
    c.calendar.schedules.setBusiness(c.owner, b({ timezone: 'UTC', version: 0,
      weekly: [{ dayOfWeek: 2, localStartTime: '09:00', localEndTime: '17:00' }] }));
    const outside = c.event('2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z');
    await expectAppError(() => c.resources.book(c.owner, outside.id, b({ resourceId: c.resource.id })), 'RESOURCE_BOOKING_CONFLICT', 409);
    expect(c.state.calendarResourceBookings).toHaveLength(0);
    const inside = c.event(); const reservation = c.resources.book(c.owner, inside.id, b({ resourceId: c.resource.id }));
    await expectAppError(() => c.calendar.events.update(c.owner, inside.id, b({ startAt: '2030-01-01T16:30:00Z', endAt: '2030-01-01T17:30:00Z', version: 1 })), 'RESOURCE_BOOKING_CONFLICT', 409);
    expect(reservation.startAt).toEqual(new Date('2030-01-01T09:00:00Z'));
    c.resources.unbook(c.owner, inside.id, c.resource.id);
    expect(reservation.status).toBe('CANCELLED');
  });
  it('manages configuration with versions, validates capacity and retains deletion evidence', async () => {
    const c = await setup();
    await expectAppError(() => c.resources.update(c.owner, c.resource.id, b({ capacity: 0, version: 1 })), 'RESOURCE_CAPACITY_INVALID', 400);
    c.resources.update(c.owner, c.resource.id, b({ name: 'Updated', version: 1 }));
    await expectAppError(() => c.resources.update(c.owner, c.resource.id, b({ name: 'Stale', version: 1 })), 'RESOURCE_VERSION_CONFLICT', 409);
    c.resources.remove(c.owner, c.resource.id);
    await expectAppError(() => c.resources.get(c.owner, c.resource.id), 'RESOURCE_NOT_FOUND', 404);
    expect(c.state.auditLogs.some((row) => row.action === 'RESOURCE.DELETED')).toBe(true);
  });
  it('protects resource configuration and rejects foreign resources and unreadable Events', async () => {
    const c = await setup(), reader = await c.memberActor('room-reader', perms('WORKSPACE', 'resource.read'));
    expect(c.resources.get(reader, c.resource.id).name).toBe('Room');
    await expectAppError(() => c.resources.update(reader, c.resource.id, b({ version: 1, name: 'Denied' })), 'PERMISSION_DENIED', 403);
    const foreign = await c.foreignActor();
    await expectAppError(() => c.resources.get(foreign, c.resource.id), 'RESOURCE_NOT_FOUND', 404);
    await expectAppError(() => c.resources.book(reader, c.event().id, b({ resourceId: c.resource.id })), 'PERMISSION_DENIED', 403);
  });
  it('rejects overlaps but permits adjacent bookings and keeps availability free of Event details', async () => {
    const c = await setup(), first = c.event(), overlap = c.event(), adjacent = c.event('2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z');
    const row = c.resources.book(c.owner, first.id, b({ resourceId: c.resource.id }));
    expect(c.resources.book(c.owner, first.id, b({ resourceId: c.resource.id })).id).toBe(row.id);
    await expectAppError(() => c.resources.book(c.owner, overlap.id, b({ resourceId: c.resource.id })), 'RESOURCE_BOOKING_CONFLICT', 409);
    c.resources.book(c.owner, adjacent.id, b({ resourceId: c.resource.id }));
    const result = c.resources.availability(c.owner, c.resource.id, new URLSearchParams({ startAt: '2030-01-01T09:30:00Z', endAt: '2030-01-01T12:00:00Z' }));
    expect(result.busy[0].startAt).toEqual(new Date('2030-01-01T09:30:00Z'));
    expect(JSON.stringify(result)).not.toMatch(/secret|eventId|organizer|description/);
  });
  it('preflights moved Events, reschedules reservations and cancels on Event cancellation', async () => {
    const c = await setup(), first = c.event(), second = c.event('2030-01-01T11:00:00Z', '2030-01-01T12:00:00Z');
    const one = c.resources.book(c.owner, first.id, b({ resourceId: c.resource.id })); c.resources.book(c.owner, second.id, b({ resourceId: c.resource.id }));
    await expectAppError(() => c.calendar.events.update(c.owner, first.id, b({ startAt: '2030-01-01T11:00:00Z', endAt: '2030-01-01T12:00:00Z', version: 1 })), 'RESOURCE_BOOKING_CONFLICT', 409);
    expect(c.calendar.events.get(c.owner, first.id).startAt).toEqual(new Date('2030-01-01T09:00:00Z'));
    c.calendar.events.update(c.owner, first.id, b({ startAt: '2030-01-01T08:00:00Z', endAt: '2030-01-01T09:00:00Z', version: 1 }));
    expect(one.startAt).toEqual(new Date('2030-01-01T08:00:00Z'));
    c.calendar.events.cancel(c.owner, first.id, b()); expect(one.status).toBe('CANCELLED');
  });
  it('converts reservations into stable series bindings and blocks later occurrence conflicts', async () => {
    const c = await setup(), event = c.event(); const root = c.resources.book(c.owner, event.id, b({ resourceId: c.resource.id }));
    c.calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'UTC', version: 0 }), true);
    expect(root.recurrenceId).toBe('__SERIES__');
    expect(c.state.calendarResourceBookings.filter(row => row.seriesBookingId === root.id && row.status === 'ACTIVE')).toHaveLength(2);
    const conflicting = c.event('2030-01-02T09:30:00Z', '2030-01-02T10:30:00Z');
    await expectAppError(() => c.resources.book(c.owner, conflicting.id, b({ resourceId: c.resource.id })), 'RESOURCE_BOOKING_CONFLICT', 409);
    c.resources.unbook(c.owner, event.id, c.resource.id);
    expect(c.state.calendarResourceBookings.every(row => row.status === 'CANCELLED')).toBe(true);
    expect(c.resources.book(c.owner, event.id, b({ resourceId: c.resource.id })).id).toBe(root.id);
  });
  it('validates participant capacity, cancels disabled resources and reuses cancelled reservations safely', async () => {
    const c = await setup(), event = c.event(), row = c.resources.book(c.owner, event.id, b({ resourceId: c.resource.id }));
    c.resources.update(c.owner, c.resource.id, b({ isActive: false, version: 1 })); expect(row.status).toBe('CANCELLED');
    await expectAppError(() => c.resources.book(c.owner, event.id, b({ resourceId: c.resource.id })), 'RESOURCE_INACTIVE', 409);
    c.resources.update(c.owner, c.resource.id, b({ isActive: true, version: 2 }));
    expect(c.resources.book(c.owner, event.id, b({ resourceId: c.resource.id })).id).toBe(row.id);
    c.calendar.events.addGuest(c.owner, event.id, b({ email: 'guest@example.com' }));
    await expectAppError(() => c.calendar.events.addGuest(c.owner, event.id, b({ email: 'overflow@example.com' })), 'RESOURCE_CAPACITY_INVALID', 400);
    expect(c.calendar.events.guests(c.owner, event.id)).toHaveLength(1);
    await expectAppError(() => c.resources.update(c.owner, c.resource.id, b({ capacity: 1, version: 3 })), 'RESOURCE_CAPACITY_INVALID', 400);
    expect(c.resource.version).toBe(3);
  });
  it('rejects converting overlapping shared reservations into exclusive bookings', async () => {
    const c = await setup(); c.resources.update(c.owner, c.resource.id, b({ isExclusive: false, version: 1 }));
    for (const event of [c.event(), c.event()]) c.resources.book(c.owner, event.id, b({ resourceId: c.resource.id }));
    await expectAppError(() => c.resources.update(c.owner, c.resource.id, b({ isExclusive: true, version: 2 })), 'RESOURCE_BOOKING_CONFLICT', 409);
    expect(c.resource.isExclusive).toBe(false);
  });
});
