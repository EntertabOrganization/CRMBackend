import { createHash, randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(300_000);
beforeAll(prepareCollabDatabase);
afterAll(disconnect);

async function setup() {
  const owner = await register('booking-read'), prisma = await db();
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Host', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: calendar.id, title: 'Host page', slug: 'read-' + randomUUID(), durationMinutes: 30, bookingMode: 'REQUIRE_APPROVAL' } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  expectOk(await call(owner, 'POST', `booking-pages/${page.id}/publish`, { body: { version: 2 } }));
  const epoch = await prisma.calendarAvailabilityEpoch.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } });
  const startAt = new Date('2030-01-07T09:00:00Z'), endAt = new Date('2030-01-07T09:30:00Z');
  // Native reservations exercise HTTP hydration before the public creation pipeline is wired.
  const booking = await prisma.calendarBooking.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, bookingPageId: page.id,
    ownerUserId: owner.userId, calendarId: calendar.id, guestName: 'Reserved Guest', guestEmail: 'reserved@example.com', guestPhone: '+201000000000',
    startAt, endAt, reservedStartAt: startAt, reservedEndAt: endAt, status: 'PENDING', eventId: null,
    idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64), tokenNonce: 'n'.repeat(43), tokenGeneration: 1,
    tokenExpiresAt: new Date('2030-02-01T00:00:00Z'), cancellationTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    rescheduleTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    sourceEpoch: epoch.epoch, pageVersion: 3, rulesVersion: 1, version: 1, createdAt: new Date(), updatedAt: new Date() } });
  return { owner, page, calendar, booking };
}

describe('Protected Booking read HTTP/PostgreSQL contracts', () => {
  it('hydrates reservation details and paginates without exposing persistence/capability fields', async () => {
    const c = await setup(), detail = expectOk(await call(c.owner, 'GET', `bookings/${c.booking.id}`));
    const list = await call(c.owner, 'GET', 'bookings', { query: { search: 'reserved@example.com', status: 'PENDING', limit: '1' } });
    expectOk(list); expect(list.data).toEqual([detail]); expect(list.body.meta).toMatchObject({ total: 1, totalPages: 1, limit: 1 });
    expect(detail).toMatchObject({ id: c.booking.id, bookingPageId: c.page.id, ownerUserId: c.owner.userId, calendarId: c.calendar.id,
      guestName: 'Reserved Guest', guestEmail: 'reserved@example.com', guestPhone: '+201000000000', status: 'PENDING', version: 1,
      startAt: '2030-01-07T09:00:00.000Z', endAt: '2030-01-07T09:30:00.000Z', eventId: null });
    for (const key of ['idempotencyKey', 'requestHash', 'tokenNonce', 'tokenGeneration', 'tokenExpiresAt', 'cancellationTokenHash',
      'rescheduleTokenHash', 'sourceEpoch', 'pageVersion', 'rulesVersion', 'reservedStartAt', 'reservedEndAt']) expect(detail).not.toHaveProperty(key);
    expectError(await call(c.owner, 'GET', 'bookings', { query: { filters: JSON.stringify({ tokenNonce: c.booking.tokenNonce }) } }), 400, 'QUERY_FIELD_NOT_ALLOWED');
    expectError(await call(c.owner, 'GET', 'bookings', { query: { sortBy: 'requestHash' } }), 400, 'QUERY_FIELD_NOT_ALLOWED');
    expect(expectOk(await call(c.owner, 'GET', 'bookings', { query: { search: c.booking.requestHash } }))).toEqual([]);
  });
  it('requires authentication and scoped read authority on both routes', async () => {
    const c = await setup(), reader = await member(c.owner, 'read-own', [['booking.read', 'OWN']]);
    const denied = await member(c.owner, 'no-booking-read', [['booking.update', 'WORKSPACE']]);
    for (const path of ['bookings', `bookings/${c.booking.id}`]) {
      expectError(await call(null, 'GET', path), 401);
      expectError(await call(denied, 'GET', path), 403, 'PERMISSION_DENIED');
    }
    expect(expectOk(await call(reader, 'GET', 'bookings'))).toEqual([]);
    expectError(await call(reader, 'GET', `bookings/${c.booking.id}`), 404, 'BOOKING_NOT_FOUND');
    const workspace = await member(c.owner, 'read-workspace', [['booking.read', 'WORKSPACE']]);
    expect(expectOk(await call(workspace, 'GET', `bookings/${c.booking.id}`)).id).toBe(c.booking.id);
  });
  it('keeps foreign/missing identities indistinguishable and ignores attempts to expand the Workspace', async () => {
    const c = await setup(), other = await register('foreign-booking-read');
    const foreign = expectError(await call(other, 'GET', `bookings/${c.booking.id}`), 404, 'BOOKING_NOT_FOUND');
    const missing = expectError(await call(other, 'GET', `bookings/${randomUUID()}`), 404, 'BOOKING_NOT_FOUND');
    expect(foreign).toEqual(missing);
    expect(expectOk(await call(other, 'GET', 'bookings', { query: { workspaceId: c.owner.workspaceId, ownerUserId: c.owner.userId } }))).toEqual([]);
    expectError(await call(other, 'GET', 'bookings', { workspaceId: c.owner.workspaceId }), 403);
  });
  it('re-evaluates revoked role grants and membership on every request', async () => {
    const c = await setup(), reader = await member(c.owner, 'revoked-booking-reader', [['booking.read', 'WORKSPACE']]);
    expect(expectOk(await call(reader, 'GET', 'bookings'))).toHaveLength(1);
    const prisma = await db(), membership = await prisma.workspaceMembership.findFirstOrThrow({ where: { userId: reader.userId, workspaceId: c.owner.workspaceId } });
    await prisma.rolePermission.updateMany({ where: { roleId: membership.roleId }, data: { isDeleted: true } });
    expectError(await call(reader, 'GET', 'bookings'), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'GET', `bookings/${c.booking.id}`), 403, 'PERMISSION_DENIED');
    await prisma.workspaceMembership.update({ where: { id: membership.id }, data: { status: 'SUSPENDED' } });
    expectError(await call(reader, 'GET', 'bookings'), 403);
  });
  it('retains historical reads after page deletion and reservation cancellation without creating read audit/outbox writes', async () => {
    const c = await setup(), prisma = await db();
    expectOk(await call(c.owner, 'DELETE', `booking-pages/${c.page.id}`));
    await prisma.calendarBooking.update({ where: { id: c.booking.id }, data: { status: 'CANCELLED', cancellationTokenHash: null, rescheduleTokenHash: null, version: 2 } });
    const before = [await prisma.auditLog.count({ where: { workspaceId: c.owner.workspaceId } }), await prisma.outboxEvent.count({ where: { workspaceId: c.owner.workspaceId } })];
    expect(expectOk(await call(c.owner, 'GET', `bookings/${c.booking.id}`))).toMatchObject({ status: 'CANCELLED', version: 2 });
    expect(expectOk(await call(c.owner, 'GET', 'bookings', { query: { status: 'CANCELLED' } }))).toHaveLength(1);
    expect([await prisma.auditLog.count({ where: { workspaceId: c.owner.workspaceId } }), await prisma.outboxEvent.count({ where: { workspaceId: c.owner.workspaceId } })]).toEqual(before);
  });
});
