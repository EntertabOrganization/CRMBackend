import { randomUUID } from 'node:crypto';
import type { PrismaClient, CalendarBookingNotificationDelivery } from '@prisma/client';
import { AdapterUnavailableError, type NotificationPort } from '../../ports';
import { bookingToken } from './booking-capabilities';

const LEASE_MS = 5 * 60_000, MAX_ATTEMPTS = 5;

/** Calendar's committed outbox is the delivery intent. Provider I/O runs outside business transactions. */
export class BookingNotificationDelivery {
  constructor(private readonly db: PrismaClient, private readonly notifications: () => NotificationPort | null) {}
  async ingest(limit = 100) {
    return this.db.$transaction(async tx => {
      const events = await tx.$queryRaw<Array<{ id: string; workspace_id: string; entity_id: string; event_type: string; payload: { version: number } }>>`
        SELECT e.id, e.workspace_id, e.entity_id, e.event_type, e.payload FROM outbox_events e
        WHERE e.entity_type = 'CALENDAR_BOOKING' AND e.event_type IN
          ('BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'BOOKING_REJECTED', 'BOOKING_UPDATED')
          AND NOT EXISTS (SELECT 1 FROM calendar_booking_notification_events seen WHERE seen.event_id = e.id)
        ORDER BY e.occurred_at, e.id LIMIT ${limit} FOR UPDATE OF e SKIP LOCKED`;
      for (const event of events) {
        const booking = await tx.calendarBooking.findFirst({ where: { id: event.entity_id, workspaceId: event.workspace_id } });
        if (booking) {
          const recipients = new Set([booking.ownerUserId]);
          if (booking.eventId) {
            const attendees = await tx.calendarEventAttendee.findMany({ where: { eventId: booking.eventId, workspaceId: booking.workspaceId, removedAt: null, response: { not: 'DECLINED' } } });
            for (const attendee of attendees) recipients.add(attendee.userId);
          }
          for (const recipientUserId of recipients) await tx.calendarBookingNotificationDelivery.create({ data: {
            id: randomUUID(), workspaceId: booking.workspaceId, bookingId: booking.id, eventId: event.id,
            sourceVersion: event.payload.version, notificationType: event.event_type, recipientKey: recipientUserId,
            recipientUserId, guestEmail: null, status: 'SCHEDULED', nextAttemptAt: new Date(0),
          } });
          await tx.calendarBookingNotificationDelivery.create({ data: {
            id: randomUUID(), workspaceId: booking.workspaceId, bookingId: booking.id, eventId: event.id,
            sourceVersion: event.payload.version, notificationType: event.event_type, recipientKey: 'GUEST',
            recipientUserId: null, guestEmail: booking.guestEmail, status: 'SCHEDULED', nextAttemptAt: new Date(0),
          } });
        }
        await tx.calendarBookingNotificationEvent.create({ data: { eventId: event.id } });
      }
      return events.length;
    });
  }
  async claim(limit: number, token: string, now: Date) {
    const lease = new Date(now.getTime() + LEASE_MS);
    return this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE calendar_booking_notification_deliveries SET claim_token = CAST(${token} AS uuid), lease_expires_at = ${lease},
        attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (SELECT id FROM calendar_booking_notification_deliveries
        WHERE status IN ('SCHEDULED', 'FAILED') AND next_attempt_at <= ${now} AND attempts < ${MAX_ATTEMPTS}
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        ORDER BY next_attempt_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING id::text`;
  }
  private async deliver(job: CalendarBookingNotificationDelivery, signal: AbortSignal) {
    const booking = await this.db.calendarBooking.findFirst({ where: { id: job.bookingId, workspaceId: job.workspaceId } });
    if (!booking || booking.version !== job.sourceVersion) return { status: 'SUPPRESSED', code: 'BOOKING_NOTIFICATION_STALE' };
    const port = this.notifications();
    if (!port) throw new AdapterUnavailableError('Notification service unavailable.');
    const title = job.notificationType.replace('BOOKING_', 'Booking ').toLowerCase();
    const message = `${title}: ${booking.startAt.toISOString()} – ${booking.endAt.toISOString()}.`;
    const key = `booking-notification:${job.eventId}:${job.recipientKey}`;
    if (job.recipientUserId) {
      if (job.recipientUserId !== booking.ownerUserId && (!booking.eventId || !await this.db.calendarEventAttendee.findFirst({
        where: { eventId: booking.eventId, workspaceId: job.workspaceId, userId: job.recipientUserId, removedAt: null, response: { not: 'DECLINED' } },
      }))) return { status: 'SUPPRESSED', code: 'BOOKING_NOTIFICATION_ACCESS_REVOKED' };
      if (!port.canDeliver) throw new AdapterUnavailableError('Notification preference service unavailable.');
      if (!await port.canDeliver({ workspaceId: job.workspaceId, recipientUserId: job.recipientUserId,
        channel: 'IN_APP', notificationType: job.notificationType })) return { status: 'SUPPRESSED', code: 'NOTIFICATION_CHANNEL_DISABLED' };
      const delivered = await port.notifyUsers({ workspaceId: job.workspaceId, actorUserId: booking.ownerUserId, recipientUserIds: [job.recipientUserId],
        title, message, idempotencyKey: key, notificationType: job.notificationType, channel: 'IN_APP', link: `/bookings/${booking.id}`, signal });
      if (delivered.reference === null) return { status: 'SUPPRESSED', code: 'NOTIFICATION_CHANNEL_DISABLED' };
    } else {
      if (job.guestEmail !== booking.guestEmail) return { status: 'SUPPRESSED', code: 'BOOKING_NOTIFICATION_STALE' };
      if (!port.notifyGuests) throw new AdapterUnavailableError('Guest email delivery is not configured.');
      // Guest credentials are reconstructed only at dispatch; they never enter outbox, audit or queue payloads.
      const link = ['PENDING', 'CONFIRMED'].includes(booking.status) && booking.tokenExpiresAt > new Date()
        ? `/public/bookings/${bookingToken(booking, 'reschedule')}` : null;
      await port.notifyGuests({ workspaceId: job.workspaceId, recipientEmails: [job.guestEmail!], title, message, link,
        notificationType: job.notificationType, idempotencyKey: key, signal });
    }
    return { status: 'SENT', code: null };
  }
  async runDue(limit = 25, now = new Date()) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Job limit must be an integer between 1 and 100.');
    await this.ingest();
    await this.db.calendarBookingNotificationDelivery.updateMany({ where: { attempts: { gte: MAX_ATTEMPTS },
      status: { in: ['SCHEDULED', 'FAILED'] }, leaseExpiresAt: { lte: now } }, data: {
      status: 'FAILED', lastErrorCode: 'NOTIFICATION_RETRY_EXHAUSTED', claimToken: null, leaseExpiresAt: null, nextAttemptAt: null,
    } });
    const token = randomUUID();
    const result = { claimed: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0 };
    while (result.claimed < limit) {
      // Claim at most five immediately before dispatch, keeping each wave within its five-minute lease.
      const jobs = await this.claim(Math.min(5, limit - result.claimed), token, new Date(Math.max(now.getTime(), Date.now())));
      if (!jobs.length) break;
      result.claimed += jobs.length;
      for (const { id } of jobs) {
        const job = await this.db.calendarBookingNotificationDelivery.findUniqueOrThrow({ where: { id } });
        const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
        let outcome: { status: string; code: string | null };
        try {
          outcome = await Promise.race([this.deliver(job, controller.signal), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => { controller.abort(); reject(new AdapterUnavailableError('Delivery timeout.')); }, 30_000);
          })]);
        } catch (error) {
          outcome = { status: 'FAILED', code: error instanceof AdapterUnavailableError ? 'NOTIFICATION_SERVICE_UNAVAILABLE' : 'NOTIFICATION_DELIVERY_FAILED' };
        } finally { if (timeout) clearTimeout(timeout); }
        const finishedAt = new Date();
        const committed = await this.db.$transaction(async tx => {
          const updated = await tx.calendarBookingNotificationDelivery.updateMany({ where: { id, claimToken: token, leaseExpiresAt: { gt: finishedAt } }, data: {
            status: outcome.status, lastErrorCode: outcome.code, claimToken: null, leaseExpiresAt: null,
            nextAttemptAt: outcome.status === 'FAILED' && job.attempts < MAX_ATTEMPTS ? new Date(Math.max(now.getTime(), finishedAt.getTime()) + 30_000 * 2 ** (job.attempts - 1)) : null,
            sentAt: outcome.status === 'SENT' ? finishedAt : null,
          } });
          if (updated.count) await tx.outboxEvent.create({ data: { workspaceId: job.workspaceId,
            eventType: `BOOKING_NOTIFICATION_${outcome.status}`, entityType: 'CALENDAR_BOOKING', entityId: job.bookingId,
            payload: { deliveryId: id, notificationType: job.notificationType, attempts: job.attempts,
              recipientKind: job.recipientUserId ? 'USER' : 'GUEST', lastErrorCode: outcome.code } } });
          return updated;
        });
        if (!committed.count) result.skipped++;
        else if (outcome.status === 'SENT') result.sent++;
        else if (outcome.status === 'SUPPRESSED') result.suppressed++;
        else result.failed++;
      }
    }
    return result;
  }
}
