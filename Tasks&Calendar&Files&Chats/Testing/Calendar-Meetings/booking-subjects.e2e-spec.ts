import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let clock: jest.SpyInstance;
beforeAll(async () => {
  await prepareCollabDatabase();
  const { appContext } = await import('@/src/server/app-context');
  clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
});
afterAll(async () => { clock?.mockRestore(); await disconnect(); });
const hostGrants = ['calendar.read', 'calendar.create', 'event.create', 'event.read', 'calendar.free_busy',
  'booking_page.create', 'booking_page.update', 'booking_page.publish', 'booking.read', 'resource.read', 'resource.book'] as const;
async function page(host: Session, attendeeId: string, resourceId?: string, mode = 'REQUIRE_APPROVAL') {
  const calendar = expectOk(await call(host, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Host', timezone: 'UTC' } }));
  const row = expectOk(await call(host, 'POST', 'booking-pages', { body: { calendarId: calendar.id, title: 'Selected meeting', slug: 'selected-' + randomUUID(),
    durationMinutes: 30, bookingMode: mode, attendeeUserIds: [attendeeId], resourceIds: resourceId ? [resourceId] : [], bufferBeforeMinutes: 15, bufferAfterMinutes: 15 } }));
  expectOk(await call(host, 'PUT', `booking-pages/${row.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  expectOk(await call(host, 'POST', `booking-pages/${row.id}/publish`, { body: { version: 2 } }));
  return { ...row, version: 3 };
}
async function setup(mode = 'AUTO_CONFIRM') {
  const owner = await register('booking-subject-owner');
  const attendee = await member(owner, 'booking-subject-attendee', hostGrants.map(key => [key, 'WORKSPACE']));
  const resource = expectOk(await call(owner, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Private room', timezone: 'UTC', capacity: 3 } }));
  const row = await page(owner, attendee.userId, resource.id, mode);
  return { owner, attendee, resource, page: row };
}
const create = (slug: string, startAt = '2030-01-07T10:00:00Z', extra = {}) => api('POST', '/api/v1/public/booking/[[...path]]', {
  params: { path: [slug, 'bookings'] }, body: { guestName: 'Guest', guestEmail: 'guest@example.com', startAt, clientRequestId: randomUUID(), ...extra } });
const cap = (token: string, action: string, body = {}) => api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: [token, action] }, body });

describe('Configured Booking subjects HTTP/PostgreSQL contracts', () => {
  it('confirms attendee and room reservations, hides configuration from public views and rejects forged selection', async () => {
    const c = await setup(), prisma = await db();
    const publicView = expectOk(await api('GET', '/api/v1/public/booking/[[...path]]', { params: { path: [c.page.slug] } }));
    expect(JSON.stringify(publicView)).not.toMatch(/attendeeUserIds|resourceIds|ownerUserId|workspaceId|Private/);
    expectError(await create(c.page.slug, undefined, { resourceIds: [] }), 400, 'VALIDATION_ERROR');
    const receipt = expectOk(await create(c.page.slug));
    const booking = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    expect(booking).toMatchObject({ attendeeUserIds: [c.attendee.userId], resourceIds: [c.resource.id] });
    expect(await prisma.calendarEventAttendee.count({ where: { eventId: booking.eventId! } })).toBe(2);
    expect(await prisma.calendarResourceBooking.count({ where: { eventId: booking.eventId!, resourceId: c.resource.id, status: 'ACTIVE' } })).toBe(1);
    const busy = expectOk(await call(c.owner, 'POST', 'availability/free-busy', { body: { startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T12:00:00Z',
      userIds: [c.attendee.userId], resourceIds: [c.resource.id] } }));
    expect(busy.users[0].busy[0]).toMatchObject({ startAt: '2030-01-07T09:45:00.000Z', endAt: '2030-01-07T10:45:00.000Z' });
    expect(busy.resources[0].busy).toHaveLength(1);
  });

  it('preserves the original roster through page edits, Booking-only approval, rescheduling and cancellation', async () => {
    const c = await setup('REQUIRE_APPROVAL'), prisma = await db(), receipt = expectOk(await create(c.page.slug));
    expect(await prisma.calendarResourceBooking.count({ where: { resourceId: c.resource.id } })).toBe(0);
    expectOk(await call(c.owner, 'PATCH', `booking-pages/${c.page.id}`, { body: { attendeeUserIds: [], resourceIds: [], version: 3 } }));
    const manager = await member(c.owner, 'subject-booking-manager', [['booking.approve', 'WORKSPACE'], ['booking.update', 'WORKSPACE'], ['booking.cancel', 'WORKSPACE']]);
    const approved = expectOk(await call(manager, 'POST', `bookings/${receipt.bookingId}/approve`, { body: { version: 1 } }));
    expect(await prisma.calendarEventAttendee.count({ where: { eventId: approved.eventId, userId: c.attendee.userId } })).toBe(1);
    expectOk(await call(manager, 'POST', `bookings/${receipt.bookingId}/reschedule`, { body: { startAt: '2030-01-07T11:00:00Z', version: 2 } }));
    expect(await prisma.calendarResourceBooking.findFirst({ where: { eventId: approved.eventId } })).toMatchObject({ startAt: new Date('2030-01-07T11:00:00Z') });
    expectOk(await call(manager, 'POST', `bookings/${receipt.bookingId}/cancel`, { body: { version: 3 } }));
    expect(await prisma.calendarResourceBooking.count({ where: { eventId: approved.eventId, status: 'ACTIVE' } })).toBe(0);
  });

  it('serializes competing hosts sharing an attendee and rejects an independent SQL hold', async () => {
    const c = await setup('REQUIRE_APPROVAL'), prisma = await db();
    const otherHost = await member(c.owner, 'other-subject-host', hostGrants.map(key => [key, 'WORKSPACE']));
    const other = await page(otherHost, c.attendee.userId);
    const responses = await Promise.all([create(c.page.slug), create(other.slug)]);
    expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
    expectError(responses.find(row => row.status === 409)!, 409, 'BOOKING_SLOT_UNAVAILABLE');
    const receipt = expectOk(responses.find(row => row.status === 200)!);
    const winner = await prisma.calendarBooking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    const losingPage = await prisma.calendarBookingPage.findUniqueOrThrow({ where: { id: winner.bookingPageId === c.page.id ? other.id : c.page.id } });
    const rules = await prisma.calendarBookingPageRules.findFirstOrThrow({ where: { pageId: losingPage.id } });
    const epoch = await prisma.calendarAvailabilityEpoch.findFirstOrThrow({ where: { workspaceId: c.owner.workspaceId } });
    await expect(prisma.calendarBooking.create({ data: { ...winner, id: randomUUID(), eventId: null, bookingPageId: losingPage.id,
      ownerUserId: losingPage.ownerUserId, calendarId: losingPage.calendarId, attendeeUserIds: losingPage.attendeeUserIds, resourceIds: losingPage.resourceIds,
      idempotencyKey: randomUUID(), cancellationTokenHash: null, rescheduleTokenHash: null, pageVersion: losingPage.version, rulesVersion: rules.version, sourceEpoch: epoch.epoch } })).rejects.toThrow('BOOKING_SLOT_UNAVAILABLE');
  });

  it('protects pending room holds from ordinary resource acquisition and releases them through guest cancellation', async () => {
    const c = await setup('REQUIRE_APPROVAL'), prisma = await db(), receipt = expectOk(await create(c.page.slug));
    const otherHost = await member(c.owner, 'room-only-host', hostGrants.map(key => [key, 'WORKSPACE']));
    const calendar = expectOk(await call(otherHost, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Other', timezone: 'UTC' } }));
    const event = expectOk(await call(otherHost, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Room conflict', startAt: '2030-01-07T09:45:00Z', endAt: '2030-01-07T10:00:00Z' } }));
    await expect(prisma.calendarResourceBooking.create({ data: { id: randomUUID(), workspaceId: c.owner.workspaceId, resourceId: c.resource.id, eventId: event.id,
      startAt: new Date(event.startAt), endAt: new Date(event.endAt), status: 'ACTIVE', exclusive: true, createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow('BOOKING_SLOT_UNAVAILABLE');
    expectOk(await cap(receipt.cancellationToken, 'cancel'));
    expectOk(await create(c.page.slug));
  });
});
