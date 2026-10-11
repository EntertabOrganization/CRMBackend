import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session;
beforeAll(async () => { await prepareCollabDatabase(); owner = await register('resource-series-owner'); });
afterAll(disconnect);
async function setup() {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Series', timezone: 'UTC' } }));
  const create = async (startAt = '2030-01-01T09:00:00Z', endAt = '2030-01-01T10:00:00Z') => expectOk(await call(owner, 'POST', 'calendar-events', {
    body: { calendarId: calendar.id, title: 'Private series', startAt, endAt } }));
  const event = await create();
  const resource = expectOk(await call(owner, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Room', timezone: 'UTC' } }));
  const booking = expectOk(await call(owner, 'POST', `calendar-events/${event.id}/resources`, { body: { resourceId: resource.id } }));
  expectOk(await call(owner, 'PUT', `calendar-events/${event.id}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'UTC', version: 0 } }));
  return { event, resource, booking, create };
}

describe('Recurring resource HTTP/PostgreSQL reservations', () => {
  it('persists stable series identity, occurrence moves, cancellations and recurrence removal atomically', async () => {
    const c = await setup(), prisma = await db(), id = '2030-01-02T09:00:00.000';
    expect(await prisma.calendarResourceBooking.findUnique({ where: { id: c.booking.id } })).toMatchObject({ recurrenceId: '__SERIES__', seriesBookingId: null });
    expect(await prisma.calendarResourceBooking.count({ where: { seriesBookingId: c.booking.id, status: 'ACTIVE' } })).toBe(3);
    const child = await prisma.calendarResourceBooking.findFirstOrThrow({ where: { seriesBookingId: c.booking.id, recurrenceId: id } });
    expectOk(await call(owner, 'PATCH', `calendar-events/${c.event.id}/occurrences/${id}`, { body: {
      startAt: '2030-06-02T12:00:00Z', endAt: '2030-06-02T13:00:00Z', version: 1 } }));
    expect(await prisma.calendarResourceBooking.findUnique({ where: { id: child.id } })).toMatchObject({ startAt: new Date('2030-06-02T12:00:00Z') });
    const result = expectOk(await call(owner, 'GET', `calendar-resources/${c.resource.id}/availability`, { query: {
      startAt: '2030-06-02T00:00:00Z', endAt: '2030-06-03T00:00:00Z' } }));
    expect(result.busy).toHaveLength(1); expect(JSON.stringify(result)).not.toMatch(/Private|eventId|organizer/);
    expectOk(await call(owner, 'POST', `calendar-events/${c.event.id}/occurrences/${id}/cancel`, { body: { version: 2 } }));
    expect(await prisma.calendarResourceBooking.findUnique({ where: { id: child.id } })).toMatchObject({ status: 'CANCELLED' });
    expectOk(await call(owner, 'DELETE', `calendar-events/${c.event.id}/recurrence`, { body: { version: 3 } }));
    expect(await prisma.calendarResourceBooking.findUnique({ where: { id: c.booking.id } })).toMatchObject({ recurrenceId: 'SINGLE', status: 'ACTIVE' });
    expect(await prisma.calendarResourceBooking.count({ where: { seriesBookingId: c.booking.id, status: 'ACTIVE' } })).toBe(0);
  });

  it('blocks racing future occurrence reservations and enforces occurrence exclusion independently in SQL', async () => {
    const c = await setup(), prisma = await db();
    const other = await c.create('2030-01-02T09:30:00Z', '2030-01-02T10:30:00Z');
    expectError(await call(owner, 'POST', `calendar-events/${other.id}/resources`, { body: { resourceId: c.resource.id } }), 409, 'RESOURCE_BOOKING_CONFLICT');
    await expect(prisma.calendarResourceBooking.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId,
      resourceId: c.resource.id, eventId: other.id, startAt: new Date(other.startAt), endAt: new Date(other.endAt),
      exclusive: true, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow('calendar_resource_booking_exclusive');
    expectOk(await call(owner, 'PATCH', `calendar-events/${c.event.id}/recurrence`, { body: { rruleText: 'FREQ=DAILY', version: 1 } }));
    const availability = expectOk(await call(owner, 'GET', `calendar-resources/${c.resource.id}/availability`, { query: {
      startAt: '2031-01-01T00:00:00Z', endAt: '2031-01-02T00:00:00Z' } }));
    expect(availability.busy).toHaveLength(1);
    expect(await prisma.calendarResourceBooking.count({ where: { seriesBookingId: c.booking.id, recurrenceId: '2031-01-01T09:00:00.000', status: 'ACTIVE' } })).toBe(1);
    const future = await c.create('2031-01-01T09:30:00Z', '2031-01-01T10:30:00Z');
    expectError(await call(owner, 'POST', `calendar-events/${future.id}/resources`, { body: { resourceId: c.resource.id } }), 409, 'RESOURCE_BOOKING_CONFLICT');
    await expect(prisma.calendarResourceBooking.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId,
      resourceId: c.resource.id, eventId: future.id, startAt: new Date(future.startAt), endAt: new Date(future.endAt),
      exclusive: true, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow('calendar_resource_booking_exclusive');
    expectOk(await call(owner, 'DELETE', `calendar-events/${c.event.id}/resources/${c.resource.id}`));
    expect(await prisma.calendarResourceBooking.count({ where: { eventId: c.event.id, status: 'ACTIVE' } })).toBe(0);
    const replay = expectOk(await call(owner, 'POST', `calendar-events/${c.event.id}/resources`, { body: { resourceId: c.resource.id } }));
    expect(replay.id).toBe(c.booking.id);
  });

  it('rolls back conflicting and over-budget graph edits with no partial occurrence changes', async () => {
    const c = await setup(), prisma = await db();
    const other = await c.create('2030-01-02T12:00:00Z', '2030-01-02T13:00:00Z');
    expectOk(await call(owner, 'POST', `calendar-events/${other.id}/resources`, { body: { resourceId: c.resource.id } }));
    const before = await prisma.calendarResourceBooking.findMany({ where: { eventId: c.event.id }, orderBy: { id: 'asc' } });
    expectError(await call(owner, 'PATCH', `calendar-events/${c.event.id}/occurrences/2030-01-02T09:00:00.000`, {
      body: { startAt: other.startAt, endAt: other.endAt, version: 1 } }), 409, 'RESOURCE_BOOKING_CONFLICT');
    expectError(await call(owner, 'PATCH', `calendar-events/${c.event.id}/recurrence`, { body: { rruleText: 'FREQ=MINUTELY', version: 1 } }), 409, 'AVAILABILITY_UNAVAILABLE');
    expect(await prisma.calendarResourceBooking.findMany({ where: { eventId: c.event.id }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.calendarRecurrenceException.count({ where: { recurrenceRuleId: (await prisma.calendarEvent.findUniqueOrThrow({ where: { id: c.event.id } })).recurrenceRuleId! } })).toBe(0);
  });
});
