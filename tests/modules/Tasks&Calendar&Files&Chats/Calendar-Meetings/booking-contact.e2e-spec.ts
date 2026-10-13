import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { BookingNotificationDelivery } from '@/src/server/collab/calendar/booking-notification-delivery';
import type { NotificationPort } from '@/src/server/ports';
import { Body } from '@/src/server/collab/support';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180_000);
let clock: jest.SpyInstance;
beforeAll(async () => {
  await prepareCollabDatabase(); const { appContext } = await import('@/src/server/app-context');
  clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
});
afterAll(async () => { clock?.mockRestore(); await disconnect(); });
async function fixture(mode = 'AUTO_CONFIRM') {
  const owner = await register('booking-contact'), calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Contacts', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: calendar.id, title: 'Contacts', slug: `contact-${randomUUID()}`, durationMinutes: 30, bookingMode: mode } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  expectOk(await call(owner, 'POST', `booking-pages/${page.id}/publish`, { body: { version: 2 } }));
  const input = { guestName: 'Original', guestEmail: 'original@example.com', guestPhone: '123', startAt: '2030-01-07T09:00:00Z', clientRequestId: randomUUID() };
  const create = () => api('POST', '/api/v1/public/booking/[[...path]]', { params: { path: [page.slug, 'bookings'] }, body: input });
  const receipt = expectOk(await create());
  return { owner, page, calendar, input, create, receipt, path: `bookings/${receipt.bookingId}` };
}
const publicAction = (token: string, action: string, body = {}) => api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: [token, action] }, body });

it('commits a scoped Booking-only contact edit with Calendar guest synchronization, history and audit/outbox', async () => {
  const f = await fixture(), editor = await member(f.owner, 'booking-contact-only', [['booking.update', 'WORKSPACE']]), prisma = await db();
  const before = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: f.receipt.bookingId } });
  const changed = expectOk(await call(editor, 'PATCH', f.path, { body: { guestName: 'Changed', guestPhone: null }, headers: { 'if-match': '1' } }));
  expect(changed).toMatchObject({ version: 2, guestName: 'Changed', guestPhone: null, status: 'CONFIRMED' });
  expect(changed).not.toHaveProperty('publicReceiptRevoked'); expect(changed).not.toHaveProperty('tokenNonce');
  const row = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: before.id } });
  expect(row).toMatchObject({ startAt: before.startAt, endAt: before.endAt, reservedStartAt: before.reservedStartAt, reservedEndAt: before.reservedEndAt,
    requestHash: before.requestHash, idempotencyKey: before.idempotencyKey, cancellationTokenHash: before.cancellationTokenHash });
  expect(await prisma.calendarExternalGuest.findFirstOrThrow({ where: { eventId: before.eventId! } })).toMatchObject({ name: 'Changed', email: before.guestEmail });
  expect(await prisma.calendarEventHistory.count({ where: { eventId: before.eventId!, actorUserId: editor.userId, action: 'CALENDAR_EVENT_UPDATED' } })).toBe(1);
  expect(await prisma.auditLog.count({ where: { entityId: before.id, action: 'BOOKING.UPDATED', actorUserId: editor.userId } })).toBe(1);
  expect(await prisma.outboxEvent.count({ where: { entityId: before.id, eventType: 'BOOKING_UPDATED' } })).toBe(1);
});

it('rejects unauthorized, foreign, stale and lifecycle writes and serializes competing metadata edits', async () => {
  const f = await fixture(), foreign = await register('contact-foreign');
  const denied = await member(f.owner, 'contact-readonly', [['booking.read', 'WORKSPACE']]), own = await member(f.owner, 'contact-own', [['booking.update', 'OWN']]);
  expectError(await call(null, 'PATCH', f.path, { body: { version: 1 } }), 401, 'UNAUTHENTICATED');
  expectError(await call(denied, 'PATCH', f.path, { body: { version: 1 } }), 403, 'PERMISSION_DENIED');
  for (const actor of [foreign, own]) {
    expectError(await call(actor, 'PATCH', f.path, { body: { version: 1 } }), 404, 'BOOKING_NOT_FOUND');
    expectError(await call(actor, 'PATCH', `bookings/${randomUUID()}`, { body: { version: 1 } }), 404, 'BOOKING_NOT_FOUND');
  }
  for (const fields of [{ guestEmail: 'invalid' }, { guestName: null }, { status: 'CANCELLED' }, { startAt: f.input.startAt }, { publicReceiptRevoked: false }])
    expectError(await call(f.owner, 'PATCH', f.path, { body: { ...fields, version: 1 } }), 400, 'VALIDATION_ERROR');
  const results = await Promise.all(['First', 'Second'].map(guestName => call(f.owner, 'PATCH', f.path, { body: { guestName, version: 1 } })));
  expect(results.map(row => row.status).sort()).toEqual([200, 409]);
  expectError(results.find(row => row.status === 409)!, 409, 'RESOURCE_VERSION_CONFLICT');
  const winner = expectOk(results.find(row => row.status === 200)!);
  const prisma = await db(); expect(await prisma.outboxEvent.count({ where: { entityId: f.receipt.bookingId, eventType: 'BOOKING_UPDATED' } })).toBe(1);
  expect((await prisma.calendarExternalGuest.findFirstOrThrow({ where: { eventId: winner.eventId } })).name).toBe(winner.guestName);
  expectOk(await call(f.owner, 'POST', `${f.path}/cancel`, { body: { version: 2 } }));
  expectError(await call(f.owner, 'PATCH', f.path, { body: { guestName: 'Late', version: 3 } }), 409, 'BOOKING_STATE_INVALID');
});

it('revokes old capabilities, suppresses old notifications and gives the changed guest a new capability without public retry recovery', async () => {
  const f = await fixture(), prisma = await db();
  expectOk(await call(f.owner, 'PATCH', f.path, { body: { guestEmail: 'NEW@example.com', version: 1 } }));
  expectError(await publicAction(f.receipt.cancellationToken, 'cancel'), 404, 'BOOKING_TOKEN_INVALID');
  expectError(await publicAction(f.receipt.rescheduleToken, 'reschedule', { startAt: '2030-01-07T10:00:00Z' }), 404, 'BOOKING_TOKEN_INVALID');
  expect(expectOk(await f.create())).toMatchObject({ cancellationToken: null, rescheduleToken: null });
  const notifyGuests = jest.fn(async (_input: Parameters<NonNullable<NotificationPort['notifyGuests']>>[0]) => ({ reference: 'TEST-EMAIL' }));
  const worker = new BookingNotificationDelivery(prisma, () => ({ canDeliver: () => true, notifyUsers: async () => ({ reference: 'TEST-INBOX' }), notifyGuests }));
  await worker.runDue(100);
  const deliveries = notifyGuests.mock.calls.map(([input]) => input).filter(input => input.workspaceId === f.owner.workspaceId);
  expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ recipientEmails: ['new@example.com'], notificationType: 'BOOKING_UPDATED' });
  const newToken = deliveries[0].link!.split('/').at(-1)!;
  const moved = expectOk(await publicAction(newToken, 'reschedule', { startAt: '2030-01-07T10:00:00Z' }));
  expect(moved.rescheduleToken).toBeTruthy(); expect(moved.rescheduleToken).not.toBe(newToken);
  expect(expectOk(await f.create())).toMatchObject({ cancellationToken: null, rescheduleToken: null });
  const row = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: f.receipt.bookingId } });
  const evidence = JSON.stringify([await prisma.auditLog.findMany({ where: { entityId: row.id } }), await prisma.outboxEvent.findMany({ where: { entityId: row.id } })]);
  for (const secret of [row.tokenNonce, f.receipt.rescheduleToken, newToken, moved.rescheduleToken]) expect(evidence).not.toContain(secret);
  await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { publicReceiptRevoked: false, version: row.version + 1 } })).rejects.toThrow();
});

it('rolls back contact conflicts and independently rejects SQL contact drift and unrotated email changes', async () => {
  const f = await fixture(), prisma = await db(), row = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: f.receipt.bookingId } });
  expectOk(await call(f.owner, 'POST', `calendar-events/${row.eventId}/guests`, { body: { name: 'Existing', email: 'existing@example.com' } }));
  const guest = await prisma.calendarExternalGuest.findFirstOrThrow({ where: { eventId: row.eventId!, email: row.guestEmail } });
  expectError(await call(f.owner, 'PATCH', f.path, { body: { guestName: 'Wrong', guestEmail: 'existing@example.com', version: 1 } }), 409, 'BOOKING_GUEST_CONFLICT');
  expect((await prisma.calendarBooking.findUniqueOrThrow({ where: { id: row.id } })).version).toBe(1);
  expect(await prisma.outboxEvent.count({ where: { entityId: row.id, eventType: 'BOOKING_UPDATED' } })).toBe(0);
  await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { guestName: 'Unsynchronized', version: 2 } })).rejects.toThrow();
  await expect(prisma.calendarBooking.update({ where: { id: row.id }, data: { guestEmail: 'unrotated@example.com', version: 2 } })).rejects.toThrow();
  await expect(prisma.calendarExternalGuest.update({ where: { id: guest.id }, data: { name: 'Unsynchronized' } })).rejects.toThrow();
  expectError(await call(f.owner, 'DELETE', `calendar-events/${row.eventId}/guests/${guest.id}`), 409, 'BOOKING_EVENT_MANAGED');
  expect((await prisma.calendarExternalGuest.findUniqueOrThrow({ where: { id: guest.id } })).name).toBe('Original');
});

it('updates pending contacts after page unpublication and keeps no-op writes free of duplicate evidence', async () => {
  const f = await fixture('REQUIRE_APPROVAL'), prisma = await db();
  expectOk(await call(f.owner, 'POST', `booking-pages/${f.page.id}/unpublish`, { body: { version: 3 } }));
  expect(expectOk(await call(f.owner, 'PATCH', f.path, { body: { guestName: 'Pending', version: 1 } }))).toMatchObject({ status: 'PENDING', eventId: null, version: 2 });
  expect(expectOk(await call(f.owner, 'PATCH', f.path, { body: { guestName: 'Pending', version: 2 } }))).toMatchObject({ version: 2 });
  expect(await prisma.calendarEvent.count({ where: { calendarId: f.calendar.id } })).toBe(0);
  expect(await prisma.auditLog.count({ where: { entityId: f.receipt.bookingId, action: 'BOOKING.UPDATED' } })).toBe(1);
});

it('rolls back phone-only edits if editor membership is revoked after authorization and before persistence', async () => {
  const f = await fixture(), editor = await member(f.owner, 'contact-revoked', [['booking.update', 'WORKSPACE']]), prisma = await db();
  const { appContext } = await import('@/src/server/app-context'), { runStateUnit } = await import('@/src/server/response');
  await expect(runStateUnit(async () => {
    const user = appContext.store.state.users.find(row => row.id === editor.userId)!;
    appContext.collab.calendar.bookings.update(appContext.access.actor(user, editor.workspaceId), f.receipt.bookingId, new Body({ guestPhone: '456', version: 1 }));
    await prisma.workspaceMembership.updateMany({ where: { workspaceId: editor.workspaceId, userId: editor.userId }, data: { isDeleted: true } });
  })).rejects.toMatchObject({ code: 'BOOKING_SLOT_UNAVAILABLE' });
  expect(await prisma.calendarBooking.findUniqueOrThrow({ where: { id: f.receipt.bookingId } })).toMatchObject({ guestPhone: '123', version: 1 });
  expect(await prisma.auditLog.count({ where: { entityId: f.receipt.bookingId, action: 'BOOKING.UPDATED' } })).toBe(0);
  expect(await prisma.outboxEvent.count({ where: { entityId: f.receipt.bookingId, eventType: 'BOOKING_UPDATED' } })).toBe(0);
});
