import type { PrismaClient } from '@prisma/client';
import type { NotificationPort } from '../../ports';
import { AdapterUnavailableError } from '../../ports';
import type { DeliveryOutcome, LeaseJobHandler } from '../../jobs/lease-runner';
import type { CollabSupport } from '../support';
import type { CalendarEventService } from './event-service';
import type { CalendarReminderService } from './reminder-service';
import type { CalendarEventReminder } from './recurrence-types';

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
type Ticket = { id: string; workspaceId: string; userId: string; generation: number; token: string;
  notification: Parameters<NotificationPort['notifyUsers']>[0] };

export class CalendarReminderDelivery implements LeaseJobHandler<Ticket> {
  constructor(private readonly support: CollabSupport, private readonly reminders: CalendarReminderService,
    private readonly events: CalendarEventService, private readonly notifications: () => NotificationPort | null) {}
  private get state() { return this.support.state; }
  expireExhausted(now: Date) {
    for (const row of this.state.calendarEventReminders.filter((item) => item.attempts >= MAX_ATTEMPTS && item.leaseExpiresAt && item.leaseExpiresAt <= now && ['SCHEDULED', 'FAILED'].includes(item.status))) {
      row.status = 'FAILED'; row.lastErrorCode = 'REMINDER_RETRY_EXHAUSTED'; row.claimToken = null; row.leaseExpiresAt = null; row.nextAttemptAt = null;
      this.support.touch(row);
      this.support.event({ workspaceId: row.workspaceId, type: 'CALENDAR_REMINDER_FAILED', entityType: 'CALENDAR_EVENT', entityId: row.eventId,
        actorUserId: null, audienceUserIds: [row.attendeeUserId], changes: { reminderId: row.id, attempts: row.attempts, lastErrorCode: row.lastErrorCode } });
    }
  }
  claimDue(limit: number, token: string, now: Date) {
    this.reminders.materialize(now);
    this.expireExhausted(now);
    const due = this.state.calendarEventReminders.filter((row) => (row.status === 'SCHEDULED' || row.status === 'FAILED') &&
      this.reminders.canClaim(row) && row.dueAt! <= now && (!row.nextAttemptAt || row.nextAttemptAt <= now) && row.attempts < MAX_ATTEMPTS &&
      (!row.leaseExpiresAt || row.leaseExpiresAt <= now)).sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of due) {
      row.claimToken = token; row.leaseExpiresAt = new Date(now.getTime() + LEASE_MS); row.attempts += 1; this.support.touch(row);
    }
    return due.map((row) => row.id);
  }
  prepare(id: string, token: string, now: Date): Ticket | null {
    const row = this.state.calendarEventReminders.find((item) => item.id === id);
    if (!row || row.claimToken !== token || !row.leaseExpiresAt || row.leaseExpiresAt <= now || !['SCHEDULED', 'FAILED'].includes(row.status)) return null;
    const event = this.state.calendarEvents.find((item) => item.id === row.eventId && item.workspaceId === row.workspaceId);
    if (!event) { this.cancel(row); return null; }
    this.reminders.reconcile(event);
    if (!this.reminders.canClaim(row)) return null;
    if (row.claimToken !== token || row.status === 'CANCELLED') return null;
    const calendar = this.state.calendars.find((item) => item.id === event.calendarId && !item.isDeleted && item.isActive);
    const user = this.state.users.find((item) => item.id === row.attendeeUserId && !item.isDeleted);
    let allowed = Boolean(calendar && !calendar.isReadOnly && user && this.support.isEligibleUser(row.workspaceId, row.attendeeUserId));
    if (allowed) {
      try { allowed = this.events.canRead(this.support.access.actor(user!, row.workspaceId), event); } catch { allowed = false; }
    }
    if (!allowed) { this.cancel(row); return null; }
    if (row.dueAt! > now) { row.claimToken = null; row.leaseExpiresAt = null; this.support.touch(row); return null; }
    const occurrence = this.reminders.deliveryEvent(row, event);
    return { id, workspaceId: row.workspaceId, userId: row.attendeeUserId, generation: row.deliveryGeneration, token,
      notification: { workspaceId: row.workspaceId, actorUserId: event.organizerUserId, recipientUserIds: [row.attendeeUserId],
        title: 'Calendar reminder', message: occurrence.title, link: `/calendar/events/${event.id}${row.recurrenceId ? `?recurrenceId=${encodeURIComponent(row.recurrenceId)}` : ''}`,
        channel: row.channel, notificationType: 'CALENDAR_REMINDER',
        idempotencyKey: `calendar-reminder:${row.workspaceId}:${id}:${row.deliveryGeneration}` } };
  }
  private cancel(row: CalendarEventReminder) {
    row.status = 'CANCELLED'; row.claimToken = null; row.leaseExpiresAt = null; row.nextAttemptAt = null; this.support.touch(row);
  }
  async deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome> {
    const port = this.notifications();
    if (!port || !port.canDeliver) return { kind: 'FAILED', code: 'NOTIFICATION_SERVICE_UNAVAILABLE' };
    try {
      const allowed = await port.canDeliver({ workspaceId: ticket.workspaceId, recipientUserId: ticket.userId,
        channel: ticket.notification.channel!, notificationType: 'CALENDAR_REMINDER' });
      if (signal?.aborted) return { kind: 'FAILED', code: 'JOB_DELIVERY_TIMEOUT' };
      if (!allowed) return { kind: 'SUPPRESSED' };
      const result = await port.notifyUsers({ ...ticket.notification, signal });
      return { kind: 'SENT', reference: result.reference ?? null };
    } catch (error) {
      return { kind: 'FAILED', code: error instanceof AdapterUnavailableError ? 'NOTIFICATION_SERVICE_UNAVAILABLE' : 'NOTIFICATION_DELIVERY_FAILED' };
    }
  }
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date) {
    const row = this.state.calendarEventReminders.find((item) => item.id === ticket.id && item.workspaceId === ticket.workspaceId);
    if (!row || row.claimToken !== ticket.token || row.deliveryGeneration !== ticket.generation || !row.leaseExpiresAt || row.leaseExpiresAt <= now || !['SCHEDULED', 'FAILED'].includes(row.status)) return false;
    row.claimToken = null; row.leaseExpiresAt = null;
    if (outcome.kind === 'SENT') { row.status = 'SENT'; row.sentAt = now; row.deliveryReference = outcome.reference; row.lastErrorCode = null; row.nextAttemptAt = null; }
    else if (outcome.kind === 'SUPPRESSED') { row.status = 'CANCELLED'; row.lastErrorCode = 'NOTIFICATION_CHANNEL_DISABLED'; row.nextAttemptAt = null; }
    else {
      row.status = 'FAILED'; row.lastErrorCode = outcome.code;
      row.nextAttemptAt = row.attempts < MAX_ATTEMPTS ? new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** (row.attempts - 1))) : null;
    }
    this.support.touch(row);
    this.support.event({ workspaceId: row.workspaceId, type: outcome.kind === 'SENT' ? 'CALENDAR_REMINDER_SENT' : outcome.kind === 'SUPPRESSED' ? 'CALENDAR_REMINDER_CANCELLED' : 'CALENDAR_REMINDER_FAILED',
      entityType: 'CALENDAR_EVENT', entityId: row.eventId, actorUserId: null, audienceUserIds: [row.attendeeUserId],
      changes: { reminderId: row.id, generation: row.deliveryGeneration, channel: row.channel, attempts: row.attempts, lastErrorCode: row.lastErrorCode } });
    return true;
  }
}

/** PostgreSQL is the claim authority across processes. The version/claim token fences expired or changed attempts. */
export async function claimCalendarReminders(prisma: PrismaClient, limit: number, token: string, now: Date): Promise<string[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE calendar_event_reminders SET claim_token = CAST(${token} AS uuid), lease_expires_at = ${lease}, attempts = attempts + 1,
      version = version + 1, updated_at = ${now}
    WHERE id IN (SELECT id FROM calendar_event_reminders
      WHERE NOT is_series AND status IN ('SCHEDULED'::"CalendarReminderStatus", 'FAILED'::"CalendarReminderStatus") AND due_at <= ${now}
        AND (series_reminder_id IS NULL OR EXISTS (
          SELECT 1 FROM calendar_event_reminders parent JOIN calendar_events event ON event.id = parent.event_id
            JOIN calendar_recurrence_rules rule ON rule.id = parent.recurrence_rule_id
          WHERE parent.id = calendar_event_reminders.series_reminder_id AND parent.status = 'SCHEDULED'
            AND event.version = calendar_event_reminders.source_event_version AND rule.version = calendar_event_reminders.source_rule_version))
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}) AND attempts < ${MAX_ATTEMPTS}
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY due_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id::text AS id`;
  return rows.map((row) => row.id);
}
