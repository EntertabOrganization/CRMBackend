import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(300_000);
let clock: jest.SpyInstance;
beforeAll(async () => { await prepareCollabDatabase(); const { appContext } = await import('@/src/server/app-context'); clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z')); });
afterAll(async () => { clock?.mockRestore(); await disconnect(); });
async function setup(mode = 'AUTO_CONFIRM', settings = {}) {
  const owner = await register('booking-lifecycle');
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Host', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: calendar.id, title: 'Host meeting', slug: 'book-' + randomUUID(), durationMinutes: 30, bookingMode: mode, ...settings } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  expectOk(await call(owner, 'POST', `booking-pages/${page.id}/publish`, { body: { version: 2 } }));
  const input = { guestName: 'Guest', guestEmail: 'guest@example.com', startAt: '2030-01-07T09:00:00Z', clientRequestId: randomUUID() };
  return { owner, calendar, page, input };
}
const create = (c: Awaited<ReturnType<typeof setup>>, body = c.input, headers?: Record<string, string>) => api('POST', '/api/v1/public/booking/[[...path]]', { params: { path: [c.page.slug, 'bookings'] }, body, headers });
const capability = (token: string, action: string, body = {}) => api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: [token, action] }, body });

describe('Public and authorized Booking lifecycle HTTP/PostgreSQL', () => {
  it('permits only one concurrent same-slot booking and commits one complete Calendar Event', async () => {
    const c = await setup(), second = { ...c.input, clientRequestId: randomUUID() };
    const results = await Promise.all([create(c), create(c, second)]);
    expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
    const winner = expectOk(results.find((row) => row.status === 200)!);
    expectError(results.find((row) => row.status === 409)!, 409, 'BOOKING_SLOT_UNAVAILABLE');
    const prisma = await db(), row = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: winner.bookingId } });
    expect(await prisma.calendarBooking.count({ where: { bookingPageId: c.page.id } })).toBe(1);
    expect(await prisma.calendarEvent.count({ where: { calendarId: c.calendar.id } })).toBe(1);
    expect(await prisma.calendarExternalGuest.count({ where: { eventId: row.eventId! } })).toBe(1);
    expect(row.status).toBe('CONFIRMED');
    for (const key of ['workspaceId', 'ownerUserId', 'calendarId', 'eventId', 'tokenNonce', 'requestHash']) expect(winner).not.toHaveProperty(key);
  });
  it('replays the original durable receipt and rejects changed payloads without duplicate writes', async () => {
    const c = await setup(), first = expectOk(await create(c));
    const before = await (await db()).auditLog.count({ where: { workspaceId: c.owner.workspaceId } });
    expect(expectOk(await create(c, { ...c.input, guestEmail: 'GUEST@example.com', startAt: '2030-01-07T11:00:00+02:00' }))).toEqual(first);
    expectError(await create(c, { ...c.input, guestName: 'Changed' }), 409, 'BOOKING_IDEMPOTENCY_CONFLICT');
    const prisma = await db(); expect(await prisma.auditLog.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(before);
    expect(await prisma.calendarBooking.count({ where: { bookingPageId: c.page.id } })).toBe(1);
    expectOk(await capability(first.cancellationToken, 'cancel'));
    expect(expectOk(await create(c))).toMatchObject({ bookingId: first.bookingId, status: 'CANCELLED', cancellationToken: null, rescheduleToken: null });
  });
  it('approves pending reservations and cancels their Events using Booking permissions alone', async () => {
    const c = await setup('REQUIRE_APPROVAL'), receipt = expectOk(await create(c)), prisma = await db();
    expect(receipt.status).toBe('PENDING'); expect(await prisma.calendarEvent.count({ where: { calendarId: c.calendar.id } })).toBe(0);
    const approver = await member(c.owner, 'booking-approver-only', [['booking.approve', 'WORKSPACE']]);
    expectError(await call(approver, 'POST', `bookings/${receipt.bookingId}/approve`, { body: { version: 0 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    const approved = expectOk(await call(approver, 'POST', `bookings/${receipt.bookingId}/approve`, { body: { version: 1 } }));
    expect(approved).toMatchObject({ status: 'CONFIRMED', version: 2 }); expect(approved.eventId).toBeTruthy();
    const canceler = await member(c.owner, 'booking-canceler-only', [['booking.cancel', 'WORKSPACE']]);
    expectOk(await call(canceler, 'POST', `bookings/${receipt.bookingId}/cancel`, { headers: { 'if-match': '2' }, body: {} }));
    expect((await prisma.calendarEvent.findUniqueOrThrow({ where: { id: approved.eventId } })).status).toBe('CANCELLED');
    expect((await prisma.calendarBooking.findUniqueOrThrow({ where: { id: receipt.bookingId } }))).toMatchObject({ status: 'CANCELLED', version: 3, cancellationTokenHash: null, rescheduleTokenHash: null });
  });
  it('rotates scoped capabilities on rescheduling and atomically moves the bound Event', async () => {
    const c = await setup(), first = expectOk(await create(c)), prisma = await db();
    expectError(await capability(first.bookingId, 'cancel'), 404, 'BOOKING_TOKEN_INVALID');
    expectError(await capability(first.rescheduleToken, 'cancel'), 404, 'BOOKING_TOKEN_INVALID');
    expectError(await capability(first.cancellationToken, 'reschedule', { startAt: '2030-01-07T10:00:00Z' }), 404, 'BOOKING_TOKEN_INVALID');
    const moved = expectOk(await capability(first.rescheduleToken, 'reschedule', { startAt: '2030-01-07T10:00:00Z' }));
    expect(moved).toMatchObject({ status: 'CONFIRMED', startAt: '2030-01-07T10:00:00.000Z', version: 2 });
    const row = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: moved.bookingId } });
    const event = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: row.eventId! } });
    expect(event.startAt).toEqual(row.startAt); expect(event.endAt).toEqual(row.endAt);
    expectError(await capability(first.rescheduleToken, 'reschedule', { startAt: c.input.startAt }), 404, 'BOOKING_TOKEN_INVALID');
    expectError(await capability(first.cancellationToken, 'cancel'), 404, 'BOOKING_TOKEN_INVALID');
    expectError(await call(c.owner, 'PATCH', `calendar-events/${event.id}`, { body: { startAt: '2030-01-07T11:00:00Z', endAt: '2030-01-07T11:30:00Z', version: event.version } }), 409, 'BOOKING_EVENT_MANAGED');
    expectOk(await capability(moved.cancellationToken, 'cancel'));
    expectError(await capability(moved.cancellationToken, 'cancel'), 404, 'BOOKING_TOKEN_INVALID');
    const privateText = JSON.stringify([await prisma.auditLog.findMany({ where: { workspaceId: c.owner.workspaceId } }), await prisma.outboxEvent.findMany({ where: { workspaceId: c.owner.workspaceId } })]);
    for (const secret of [first.cancellationToken, first.rescheduleToken, moved.cancellationToken, moved.rescheduleToken, row.tokenNonce, row.requestHash]) expect(privateText).not.toContain(secret);
  });
  it('rejects unauthorized/foreign lifecycle commands and releases rejected pending holds', async () => {
    const c = await setup('REQUIRE_APPROVAL'), receipt = expectOk(await create(c));
    const own = await member(c.owner, 'booking-own-commands', [['booking.approve', 'OWN'], ['booking.cancel', 'OWN'], ['booking.update', 'OWN']]);
    const denied = await member(c.owner, 'booking-read-only', [['booking.read', 'WORKSPACE']]), foreign = await register('foreign-booking-commands');
    for (const action of ['approve', 'reject', 'cancel', 'reschedule']) {
      const body = { version: 1, ...(action === 'reschedule' ? { startAt: '2030-01-07T10:00:00Z' } : {}) };
      expectError(await call(own, 'POST', `bookings/${receipt.bookingId}/${action}`, { body }), 404, 'BOOKING_NOT_FOUND');
      expectError(await call(denied, 'POST', `bookings/${receipt.bookingId}/${action}`, { body }), 403, 'PERMISSION_DENIED');
      expectError(await call(foreign, 'POST', `bookings/${receipt.bookingId}/${action}`, { body }), 404, 'BOOKING_NOT_FOUND');
      expectError(await call(null, 'POST', `bookings/${receipt.bookingId}/${action}`, { body }), 401);
    }
    expect(expectOk(await call(c.owner, 'POST', `bookings/${receipt.bookingId}/reject`, { body: { version: 1 } })).status).toBe('CANCELLED');
    expectError(await capability(receipt.cancellationToken, 'cancel'), 404, 'BOOKING_TOKEN_INVALID');
    expect(expectOk(await create(c, { ...c.input, clientRequestId: randomUUID() })).status).toBe('PENDING');
  });
  it('allows capability cancellation after unpublication and rejects expired capabilities', async () => {
    const c = await setup(), first = expectOk(await create(c));
    expectOk(await call(c.owner, 'POST', `booking-pages/${c.page.id}/unpublish`, { body: { version: 3 } }));
    expectOk(await capability(first.cancellationToken, 'cancel'));
    const expired = await setup(), receipt = expectOk(await create(expired));
    clock.mockReturnValue(new Date('2030-01-16T08:00:00Z'));
    try { expectError(await capability(receipt.cancellationToken, 'cancel'), 404, 'BOOKING_TOKEN_INVALID'); }
    finally { clock.mockReturnValue(new Date('2030-01-07T08:00:00Z')); }
    expect((await (await db()).calendarBooking.findUniqueOrThrow({ where: { id: receipt.bookingId } })).status).toBe('CONFIRMED');
  });
  it('rechecks configured guest requirements, notice and buffers and rate limits writes', async () => {
    const c = await setup('AUTO_CONFIRM', { requirePhone: true, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minNoticeMinutes: 60 });
    expectError(await create(c), 400, 'VALIDATION_ERROR');
    const input = { ...c.input, guestPhone: '+201000000000' };
    expectError(await create(c, input), 409, 'BOOKING_SLOT_UNAVAILABLE');
    const receipt = expectOk(await create(c, { ...input, startAt: '2030-01-07T09:15:00Z' }));
    const row = await (await db()).calendarBooking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    expect(row.reservedStartAt.toISOString()).toBe('2030-01-07T09:05:00.000Z'); expect(row.reservedEndAt.toISOString()).toBe('2030-01-07T09:55:00.000Z');
    const headers = { 'x-forwarded-for': '192.0.2.243' };
    for (let i = 0; i < 10; i++) expectError(await create(c, { ...input, guestName: '' }, headers), 400, 'VALIDATION_ERROR');
    expectError(await create(c, input, headers), 429, 'BOOKING_RATE_LIMITED');
    expect(await (await db()).calendarBooking.count({ where: { bookingPageId: c.page.id } })).toBe(1);
  });
  it('persists recurrence rebuild work with HTTP 202 and creates no partial Booking or Event', async () => {
    const c = await setup();
    const event = expectOk(await call(c.owner, 'POST', 'calendar-events', { body: { calendarId: c.calendar.id, title: 'Dense private series', startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T09:00:01Z' } }));
    expectOk(await call(c.owner, 'PUT', `calendar-events/${event.id}/recurrence`, { body: { rruleText: 'FREQ=SECONDLY;COUNT=10000', sourceTimezone: 'UTC', version: 0 } }));
    const response = expectOk(await create(c), 202); expect(response).toMatchObject({ booking: null, pending: true });
    const prisma = await db();
    expect(await prisma.calendarAvailabilityRebuild.count({ where: { workspaceId: c.owner.workspaceId, status: 'PENDING' } })).toBe(1);
    expect(await prisma.calendarBooking.count({ where: { bookingPageId: c.page.id } })).toBe(0);
    expect(await prisma.calendarEvent.count({ where: { calendarId: c.calendar.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { workspaceId: c.owner.workspaceId, eventType: 'BOOKING_CREATED' } })).toBe(0);
  });
  it('rolls back a resource-conflicting reschedule while preserving the original receipt and Event', async () => {
    const c = await setup(), receipt = expectOk(await create(c)), prisma = await db();
    const booking = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    const resource = expectOk(await call(c.owner, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Room', timezone: 'UTC', capacity: 2 } }));
    expectOk(await call(c.owner, 'POST', `calendar-events/${booking.eventId}/resources`, { body: { resourceId: resource.id } }));
    const peer = await member(c.owner, 'resource-peer', [['calendar.read', 'OWN'], ['calendar.create', 'OWN'], ['event.create', 'OWN'], ['event.read', 'OWN']]);
    const peerCalendar = expectOk(await call(peer, 'POST', 'calendars', { body: { name: 'Peer', type: 'PERSONAL', timezone: 'UTC' } }));
    const other = expectOk(await call(peer, 'POST', 'calendar-events', { body: { calendarId: peerCalendar.id, title: 'Other room occupant', startAt: '2030-01-07T10:00:00Z', endAt: '2030-01-07T10:30:00Z' } }));
    expectOk(await call(c.owner, 'POST', `calendar-events/${other.id}/resources`, { body: { resourceId: resource.id } }));
    const previousEvent = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: booking.eventId! } });
    const failed = await capability(receipt.rescheduleToken, 'reschedule', { startAt: '2030-01-07T10:00:00Z' });
    expectError(failed, 409, 'RESOURCE_BOOKING_CONFLICT');
    expect(await prisma.calendarBooking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(booking);
    expect(await prisma.calendarEvent.findUniqueOrThrow({ where: { id: booking.eventId! } })).toEqual(previousEvent);
    expect(expectOk(await create(c))).toEqual(receipt);
  });
});
