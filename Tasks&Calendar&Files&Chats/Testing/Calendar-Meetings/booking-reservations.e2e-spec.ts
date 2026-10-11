import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import { api } from '@/tests/support/api';
jest.setTimeout(300_000);
let clock: jest.SpyInstance;
beforeAll(async () => { await prepareCollabDatabase(); const { appContext } = await import('@/src/server/app-context'); clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z')); });
afterAll(async () => { clock?.mockRestore(); await disconnect(); });
async function setup() {
  const owner = await register('booking-reservation');
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Host', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: calendar.id, title: 'Reserve', slug: 'reserve-' + randomUUID(), durationMinutes: 30 } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  expectOk(await call(owner, 'POST', `booking-pages/${page.id}/publish`, { body: { version: 2 } }));
  return { owner, calendar, page };
}
async function booking(c: Awaited<ReturnType<typeof setup>>, time = '09:00') {
  const prisma = await db(), epoch = await prisma.calendarAvailabilityEpoch.findUniqueOrThrow({ where: { workspaceId: c.owner.workspaceId } });
  const startAt = new Date(`2030-01-07T${time}:00Z`), endAt = new Date(startAt.getTime() + 30 * 60_000), now = new Date();
  return { id: randomUUID(), workspaceId: c.owner.workspaceId, ownerUserId: c.owner.userId, calendarId: c.calendar.id, bookingPageId: c.page.id,
    guestName: 'Guest', guestEmail: 'guest@example.com', guestPhone: null, startAt, endAt, reservedStartAt: startAt, reservedEndAt: endAt,
    status: 'PENDING', eventId: null, sourceEpoch: epoch.epoch, pageVersion: 3, rulesVersion: 1, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64),
    tokenNonce: 'n'.repeat(43), tokenGeneration: 1, tokenExpiresAt: new Date('2030-02-01T00:00:00Z'), cancellationTokenHash: null, rescheduleTokenHash: null,
    version: 1, createdAt: now, updatedAt: now };
}
function event(c: Awaited<ReturnType<typeof setup>>, id: string, startAt: Date, endAt: Date) {
  return { id, workspaceId: c.owner.workspaceId, calendarId: c.calendar.id, organizerUserId: c.owner.userId, title: 'Reserved Event', sourceTimezone: 'UTC',
    startAt, endAt, version: 1, createdAt: new Date(), updatedAt: new Date() };
}
async function waitingFor(table: string) {
  const prisma = await db(), deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ${'%INSERT%' + table + '%'}`;
    if (Number(rows[0].count)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
describe('Native Booking reservation and authoritative-source fences', () => {
  it('rechecks the source revision after waiting for a concurrent Event transaction to commit', async () => {
    const c = await setup(), prisma = await db(), stale = await booking(c);
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), locked = new Promise<void>((resolve) => { acquired = resolve; });
    const edit = prisma.$transaction(async (tx) => { await tx.calendarEvent.create({ data: event(c, randomUUID(), new Date('2030-01-07T13:00:00Z'), new Date('2030-01-07T14:00:00Z')) }); acquired(); await gate; }, { timeout: 15_000 });
    await locked;
    const attempt = prisma.calendarBooking.create({ data: stale }).then(() => null, (error: unknown) => error);
    let observed = false;
    try { observed = await waitingFor('calendar_bookings'); } finally { release(); }
    await edit; expect(observed).toBe(true); expect(String(await attempt)).toContain('BOOKING_SLOT_UNAVAILABLE');
    expect(await prisma.calendarBooking.count({ where: { bookingPageId: c.page.id } })).toBe(0);
  });
  it('rechecks a hold acquired while an overlapping Event waits for its source lock', async () => {
    const c = await setup(), prisma = await db(), planned = await booking(c);
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), locked = new Promise<void>((resolve) => { acquired = resolve; });
    const reserve = prisma.$transaction(async (tx) => { await tx.calendarBooking.create({ data: planned }); acquired(); await gate; }, { timeout: 15_000 });
    await locked;
    const attempt = prisma.calendarEvent.create({ data: event(c, randomUUID(), planned.startAt, planned.endAt) }).then(() => null, (error: unknown) => error);
    let observed = false;
    try { observed = await waitingFor('calendar_events'); } finally { release(); }
    await reserve; expect(observed).toBe(true); expect(String(await attempt)).toContain('BOOKING_SLOT_UNAVAILABLE');
    expect(await prisma.calendarEvent.count({ where: { calendarId: c.calendar.id } })).toBe(0);
  });
  it('rejects adding a held host to an overlapping one-off Event without partial Event/attendee changes', async () => {
    const c = await setup(), prisma = await db(), peer = await member(c.owner, 'reservation-peer', [['calendar.read', 'OWN']]);
    const other = await prisma.calendarEvent.create({ data: { ...event(c, randomUUID(), new Date('2030-01-07T09:00:00Z'), new Date('2030-01-07T09:30:00Z')), organizerUserId: peer.userId } });
    await prisma.calendarBooking.create({ data: await booking(c) });
    expectError(await call(c.owner, 'POST', `calendar-events/${other.id}/attendees`, { body: { userId: c.owner.userId } }), 409, 'BOOKING_SLOT_UNAVAILABLE');
    expect(await prisma.calendarEventAttendee.count({ where: { eventId: other.id, userId: c.owner.userId } })).toBe(0);
    expect((await prisma.calendarEvent.findUniqueOrThrow({ where: { id: other.id } })).version).toBe(1);
  });
  it('rejects missing rules and missing confirmed Event links without retaining a hold', async () => {
    const c = await setup(), prisma = await db();
    const draft = expectOk(await call(c.owner, 'POST', 'booking-pages', { body: { calendarId: c.calendar.id, title: 'Draft', slug: 'draft-' + randomUUID(), durationMinutes: 30 } }));
    await expect(prisma.calendarBooking.create({ data: { ...await booking(c), bookingPageId: draft.id } })).rejects.toThrow('BOOKING_SLOT_UNAVAILABLE');
    await expect(prisma.calendarBooking.create({ data: { ...await booking(c), status: 'CONFIRMED', eventId: randomUUID() } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.calendarBooking.count({ where: { ownerUserId: c.owner.userId } })).toBe(0);
  });
  it('allows only one concurrent same-host hold, enforces cross-page exclusion and permits touching intervals', async () => {
    const c = await setup(), prisma = await db(), first = await booking(c), second = await booking(c);
    const writes = await Promise.allSettled([prisma.calendarBooking.create({ data: first }), prisma.calendarBooking.create({ data: second })]);
    expect(writes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(await prisma.calendarBooking.count({ where: { ownerUserId: c.owner.userId } })).toBe(1);
    await prisma.calendarBooking.create({ data: await booking(c, '09:30') });
    const other = expectOk(await call(c.owner, 'POST', 'booking-pages', { body: { calendarId: c.calendar.id, title: 'Other page', slug: 'other-' + randomUUID(), durationMinutes: 30 } }));
    expectOk(await call(c.owner, 'PUT', `booking-pages/${other.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
    expectOk(await call(c.owner, 'POST', `booking-pages/${other.id}/publish`, { body: { version: 2 } }));
    await expect(prisma.calendarBooking.create({ data: { ...await booking(c), bookingPageId: other.id } })).rejects.toThrow('calendar_booking_host_exclusive');
  });
  it('rejects source changes after the authoritative read even when the changed Event does not overlap', async () => {
    const c = await setup(), prisma = await db(), stale = await booking(c);
    expectOk(await call(c.owner, 'POST', 'calendar-events', { body: { calendarId: c.calendar.id, title: 'Unrelated later Event', startAt: '2030-01-07T13:00:00Z', endAt: '2030-01-07T14:00:00Z' } }));
    await expect(prisma.calendarBooking.create({ data: stale })).rejects.toThrow('BOOKING_SLOT_UNAVAILABLE');
    await prisma.calendarBooking.create({ data: await booking(c) });
    const held = await booking(c, '11:00');
    expectOk(await call(c.owner, 'PUT', 'availability/business-calendar', { body: { timezone: 'UTC', weekly: [], version: 0 } }));
    await expect(prisma.calendarBooking.create({ data: held })).rejects.toThrow('BOOKING_SLOT_UNAVAILABLE');
  });
  it('commits confirmed Booking and Calendar Event together with deferred links and rejects direct Event moves', async () => {
    const c = await setup(), prisma = await db(), planned = { ...await booking(c), status: 'CONFIRMED', eventId: randomUUID() };
    await prisma.$transaction(async (tx) => { await tx.calendarBooking.create({ data: planned }); await tx.calendarEvent.create({ data: event(c, planned.eventId, planned.startAt, planned.endAt) }); });
    await expect(prisma.calendarEvent.update({ where: { id: planned.eventId }, data: { startAt: new Date('2030-01-07T10:00:00Z'), endAt: new Date('2030-01-07T10:30:00Z'), version: 2 } })).rejects.toThrow('BOOKING_EVENT_MANAGED');
    expect((await prisma.calendarEvent.findUniqueOrThrow({ where: { id: planned.eventId } })).startAt).toEqual(planned.startAt);
    const epoch = await prisma.calendarAvailabilityEpoch.findUniqueOrThrow({ where: { workspaceId: c.owner.workspaceId } });
    const range = { startAt: new Date('2030-01-07T10:00:00Z'), endAt: new Date('2030-01-07T10:30:00Z') };
    await prisma.$transaction(async (tx) => {
      await tx.calendarBooking.update({ where: { id: planned.id }, data: { ...range, reservedStartAt: range.startAt, reservedEndAt: range.endAt, sourceEpoch: epoch.epoch, version: 2 } });
      await tx.calendarEvent.update({ where: { id: planned.eventId }, data: { ...range, version: 2 } });
    });
    expect((await prisma.calendarBooking.findUniqueOrThrow({ where: { id: planned.id } })).startAt).toEqual(range.startAt);
  });
  it('rejects one-off Event creation into a pending hold and retains the reservation', async () => {
    const c = await setup(), prisma = await db(), row = await prisma.calendarBooking.create({ data: await booking(c) });
    expectError(await call(c.owner, 'POST', 'calendar-events', { body: { calendarId: c.calendar.id, title: 'Conflict', startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() } }), 409, 'BOOKING_SLOT_UNAVAILABLE');
    expect(await prisma.calendarEvent.count({ where: { calendarId: c.calendar.id } })).toBe(0);
    expect((await prisma.calendarBooking.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');
    const slots = expectOk(await api('GET', '/api/v1/public/booking/[[...path]]', { params: { path: [c.page.slug, 'slots'] }, query: { startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T12:00:00Z' } }));
    expect(slots.slots[0].startAt).toBe('2030-01-07T09:30:00.000Z');
  });
  it('enforces tenant parents, immutable request identity, version advancement and revocation on cancellation', async () => {
    const c = await setup(), other = await setup(), prisma = await db();
    await expect(prisma.calendarBooking.create({ data: { ...await booking(c), bookingPageId: other.page.id } })).rejects.toMatchObject({ code: 'P2003' });
    const row = await prisma.calendarBooking.create({ data: { ...await booking(c), cancellationTokenHash: 'c'.repeat(64), rescheduleTokenHash: 'd'.repeat(64) } });
    await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { idempotencyKey: randomUUID(), version: 2 } })).rejects.toThrow('BOOKING_STATE_INVALID');
    await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { guestName: 'Stale', version: 1 } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { status: 'CANCELLED', version: 2 } })).rejects.toThrow();
    await prisma.calendarBooking.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancellationTokenHash: null, rescheduleTokenHash: null, version: 2 } });
    expect(await prisma.calendarBooking.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ cancellationTokenHash: null, rescheduleTokenHash: null });
    await prisma.calendarBooking.create({ data: await booking(c) });
    await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { status: 'PENDING', version: 3 } })).rejects.toThrow('BOOKING_STATE_INVALID');
  });
});
