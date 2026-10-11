import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import { api } from '@/tests/support/api';
jest.setTimeout(300_000);
let clock: jest.SpyInstance;
beforeAll(async () => {
  await prepareCollabDatabase();
  const { appContext } = await import('@/src/server/app-context');
  clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
});
afterAll(async () => { clock?.mockRestore(); await disconnect(); });
async function setup() {
  const owner = await register('recurrence-held');
  const container = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Held host', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: container.id, title: 'Booking', slug: 'held-' + randomUUID(), durationMinutes: 30, bookingMode: 'REQUIRE_APPROVAL' } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  expectOk(await call(owner, 'POST', `booking-pages/${page.id}/publish`, { body: { version: 2 } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: container.id, title: 'Recurring', startAt: '2030-01-06T12:00:00Z', endAt: '2030-01-06T12:30:00Z' } }));
  const root = `calendar-events/${event.id}`;
  expectOk(await call(owner, 'PUT', `${root}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'UTC', version: 0 } }));
  const reserve = () => api('POST', '/api/v1/public/booking/[[...path]]', { params: { path: [page.slug, 'bookings'] }, body: {
    guestName: 'Guest', guestEmail: 'guest@example.com', startAt: '2030-01-07T10:00:00Z', clientRequestId: randomUUID() } });
  return { owner, event, root, reserve };
}
describe('Recurring Event writes preserve Booking holds over HTTP/PostgreSQL', () => {
  it('rolls back conflicting occurrence, future and root edits without audit/outbox changes', async () => {
    const c = await setup(), prisma = await db(); expectOk(await c.reserve());
    const count = await prisma.outboxEvent.count({ where: { workspaceId: c.owner.workspaceId } });
    const identity = '2030-01-07T12:00:00.000';
    for (const [path, body] of [
      [`${c.root}/occurrences/${identity}`, { startAt: '2030-01-07T10:00:00Z', version: 1 }],
      [`${c.root}/recurrence/future`, { recurrenceId: identity, startAt: '2030-01-07T10:00:00Z', version: 1 }],
      [c.root, { startAt: '2030-01-06T10:00:00Z', endAt: '2030-01-06T10:30:00Z', version: 2 }],
    ] as const) expectError(await call(c.owner, 'PATCH', path, { body }), 409, 'BOOKING_SLOT_UNAVAILABLE');
    expect(await prisma.calendarRecurrenceException.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(0);
    expect(await prisma.calendarRecurrenceRange.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(count);
    expectOk(await call(c.owner, 'PATCH', `${c.root}/occurrences/${identity}`, { body: { startAt: '2030-01-07T10:30:00Z', version: 1 } }));
    expect(await prisma.calendarRecurrenceException.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(1);
  });
  it('fences a recurrence write using a graph read before a pending hold committed', async () => {
    const c = await setup(), prisma = await db();
    const { hydrateState, persistState } = await import('@/src/server/persistence');
    const before = await hydrateState(prisma), after = structuredClone(before);
    const event = after.calendarEvents.find((row) => row.id === c.event.id)!;
    event.startAt = new Date('2030-01-06T10:00:00Z'); event.endAt = new Date('2030-01-06T10:30:00Z'); event.version++;
    expectOk(await c.reserve());
    await expect(persistState(prisma, before, after)).rejects.toMatchObject({ code: 'BOOKING_SLOT_UNAVAILABLE', status: 409 });
    expect((await prisma.calendarEvent.findUniqueOrThrow({ where: { id: c.event.id } })).startAt).toEqual(new Date('2030-01-06T12:00:00Z'));
    expect(await prisma.calendarBooking.count({ where: { workspaceId: c.owner.workspaceId, status: 'PENDING' } })).toBe(1);
  });
});
