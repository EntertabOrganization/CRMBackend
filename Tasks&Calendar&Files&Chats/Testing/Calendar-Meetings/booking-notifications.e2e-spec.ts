import { randomUUID } from 'node:crypto';
import { BookingNotificationDelivery } from '@/src/server/collab/calendar/booking-notification-delivery';
import { AdapterUnavailableError, type NotificationPort } from '@/src/server/ports';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import { api } from '@/tests/support/api';

jest.setTimeout(180_000);
let clock: jest.SpyInstance;
beforeAll(async () => {
  await prepareCollabDatabase(); const { appContext } = await import('@/src/server/app-context');
  clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
});
afterAll(async () => { clock?.mockRestore(); await disconnect(); });
async function setup(mode = 'AUTO_CONFIRM') {
  const owner = await register('booking-notification-owner');
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Host', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: calendar.id, title: 'Private host',
    slug: `notify-${randomUUID()}`, durationMinutes: 30, bookingMode: mode, maxAdvanceDays: 365, timezone: 'UTC' } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', version: 0,
    weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }] } }));
  expectOk(await call(owner, 'POST', `booking-pages/${page.id}/publish`, { body: { version: 2 } }));
  const options = { body: { guestName: 'Guest', guestEmail: 'guest@example.com', startAt: '2030-01-07T09:00:00Z', clientRequestId: randomUUID() } };
  const booking = expectOk(await api('POST', '/api/v1/public/booking/[[...path]]', { params: { path: [page.slug, 'bookings'] }, ...options }));
  return { owner, page, options, booking };
}
async function adapted() {
  const { appContext } = await import('@/src/server/app-context');
  const notifyGuests = jest.fn(async (_input: Parameters<NonNullable<NotificationPort['notifyGuests']>>[0]) => ({ reference: 'TEST-ONLY-EMAIL' }));
  const port: NotificationPort = { canDeliver: input => appContext.notifications.canDeliver(input),
    notifyUsers: input => appContext.notifications.notifyUsers(input), notifyGuests };
  return { worker: new BookingNotificationDelivery(await db(), () => port), port, notifyGuests };
}

describe('Durable Booking lifecycle notifications', () => {
  it('uses the default inbox adapter, deduplicates retries and records unconfigured guest email failures', async () => {
    const c = await setup(); const prisma = await db();
    const { appContext } = await import('@/src/server/app-context');
    await appContext.bookingNotifications.runDue(100);
    expect(await prisma.userNotification.count({ where: { workspaceId: c.owner.workspaceId, recipientUserId: c.owner.userId } })).toBe(2);
    const failed = await prisma.calendarBookingNotificationDelivery.findMany({ where: { bookingId: c.booking.bookingId, recipientKey: 'GUEST' } });
    expect(failed).toHaveLength(2); expect(failed.every(j => j.status === 'FAILED' && j.lastErrorCode === 'NOTIFICATION_SERVICE_UNAVAILABLE')).toBe(true);
    expectOk(await api('POST', '/api/v1/public/booking/[[...path]]', { params: { path: [c.page.slug, 'bookings'] }, ...c.options }));
    await appContext.bookingNotifications.runDue(100);
    expect(await prisma.calendarBookingNotificationDelivery.count({ where: { bookingId: c.booking.bookingId } })).toBe(4);
    expect(await prisma.userNotification.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(2);
    const foreign = await register('notification-foreign');
    const inbox = expectOk(await call(foreign, 'GET', 'notifications'));
    expect(inbox).toEqual([]);
  });

  it('delivers confirmation, administrative rescheduling and cancellation with a fake guest provider', async () => {
    const c = await setup('REQUIRE_APPROVAL'); const { worker, notifyGuests } = await adapted(); const prisma = await db();
    await worker.runDue(100);
    expectOk(await call(c.owner, 'POST', `bookings/${c.booking.bookingId}/approve`, { body: { version: 1 } }));
    await worker.runDue(100);
    expectOk(await call(c.owner, 'POST', `bookings/${c.booking.bookingId}/reschedule`, { body: { startAt: '2030-01-07T10:00:00Z', version: 2 } }));
    await worker.runDue(100);
    expectOk(await call(c.owner, 'POST', `bookings/${c.booking.bookingId}/cancel`, { body: { version: 3 } }));
    await worker.runDue(100);
    const jobs = await prisma.calendarBookingNotificationDelivery.findMany({ where: { bookingId: c.booking.bookingId } });
    expect(jobs).toHaveLength(8); expect(jobs.every(j => j.status === 'SENT')).toBe(true);
    expect(new Set(jobs.map(j => j.notificationType))).toEqual(new Set(['BOOKING_CREATED','BOOKING_CONFIRMED','BOOKING_RESCHEDULED','BOOKING_CANCELLED']));
    expect(notifyGuests.mock.calls.map(([input]) => input.notificationType)).toEqual(expect.arrayContaining(['BOOKING_CONFIRMED','BOOKING_RESCHEDULED','BOOKING_CANCELLED']));
    const events = await prisma.outboxEvent.findMany({ where: { entityId: c.booking.bookingId } });
    expect(JSON.stringify(events)).not.toContain(c.booking.rescheduleToken);
    expect(events.filter(e => e.eventType === 'BOOKING_NOTIFICATION_SENT')).toHaveLength(8);
  });

  it('suppresses stale intents and disabled preferences and handles rejection and public capabilities', async () => {
    const c = await setup('REQUIRE_APPROVAL'); const { worker } = await adapted(); const prisma = await db();
    expectOk(await call(c.owner, 'POST', `bookings/${c.booking.bookingId}/reject`, { body: { version: 1 } }));
    expectOk(await call(c.owner, 'PUT', 'notification-preferences', { body: { notificationType: 'BOOKING_REJECTED', channel: 'IN_APP', enabled: false } }));
    await worker.runDue(100);
    const jobs = await prisma.calendarBookingNotificationDelivery.findMany({ where: { bookingId: c.booking.bookingId } });
    expect(jobs.filter(j => j.notificationType === 'BOOKING_CREATED').every(j => j.status === 'SUPPRESSED')).toBe(true);
    expect(jobs.find(j => j.notificationType === 'BOOKING_REJECTED' && j.recipientUserId)?.status).toBe('SUPPRESSED');
    expect(jobs.find(j => j.notificationType === 'BOOKING_REJECTED' && !j.recipientUserId)?.status).toBe('SENT');
    const next = await setup();
    const moved = expectOk(await api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: [next.booking.rescheduleToken, 'reschedule'] }, body: { startAt: '2030-01-07T11:00:00Z' } }));
    await worker.runDue(100);
    expectOk(await api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: [moved.cancellationToken, 'cancel'] }, body: {} }));
    await worker.runDue(100);
    expect(await prisma.userNotification.count({ where: { workspaceId: next.owner.workspaceId, notificationType: { in: ['BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'] } } })).toBe(2);
  });

  it('uses PostgreSQL leases across workers and expires abandoned final attempts', async () => {
    const c = await setup(); const { worker } = await adapted(); const prisma = await db();
    await worker.ingest();
    const now = new Date(Date.now() + 60_000);
    const claims = await Promise.all([worker.claim(100, randomUUID(), now), worker.claim(100, randomUUID(), now)]);
    const ids = claims.flat().map(row => row.id); expect(new Set(ids).size).toBe(ids.length);
    const job = (await prisma.calendarBookingNotificationDelivery.findFirst({ where: { bookingId: c.booking.bookingId } }))!;
    await prisma.calendarBookingNotificationDelivery.update({ where: { id: job.id }, data: { attempts: 5, leaseExpiresAt: new Date(0) } });
    await worker.runDue(100);
    expect(await prisma.calendarBookingNotificationDelivery.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', lastErrorCode: 'NOTIFICATION_RETRY_EXHAUSTED', claimToken: null });
  });

  it('retries provider failure without duplicate inbox delivery and protects the operational endpoint', async () => {
    const c = await setup(); const { worker, port, notifyGuests } = await adapted(); const prisma = await db();
    notifyGuests.mockImplementationOnce(async () => { throw new AdapterUnavailableError('TEST-ONLY provider failure'); });
    await worker.runDue(100);
    const failed = (await prisma.calendarBookingNotificationDelivery.findFirst({ where: { bookingId: c.booking.bookingId, status: 'FAILED' } }))!;
    expect(failed).not.toBeNull();
    await prisma.calendarBookingNotificationDelivery.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(0) } });
    await worker.runDue(100);
    expect(await prisma.calendarBookingNotificationDelivery.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(await prisma.userNotification.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(2);
    expect(port.notifyGuests).toBeDefined();
    expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'booking-notifications' }, body: {} }), 401, 'UNAUTHENTICATED');
    const previous = process.env.INTERNAL_JOB_TOKEN; process.env.INTERNAL_JOB_TOKEN = randomUUID();
    try {
      const headers = { 'x-internal-job-token': process.env.INTERNAL_JOB_TOKEN };
      expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'booking-notifications' }, headers, body: { limit: 0 } }), 400, 'VALIDATION_ERROR');
      expectOk(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'booking-notifications' }, headers, body: { limit: 1 } }));
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_JOB_TOKEN; else process.env.INTERNAL_JOB_TOKEN = previous;
    }
  });
});
