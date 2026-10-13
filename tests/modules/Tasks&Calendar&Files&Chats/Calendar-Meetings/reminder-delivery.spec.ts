import { randomUUID } from 'node:crypto';
import { RecordingNotificationPort } from '@/src/server/ports';
import { b, collabApp, perms } from '../support/domain';

async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar, port = new RecordingNotificationPort();
  c.app.setNotificationPort(port);
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Delivery', timezone: 'UTC' }));
  const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Meeting', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' }));
  const row = calendar.reminders.create(c.owner, event.id, b({ offsetSeconds: 900, channel: 'IN_APP' }));
  const runner = calendar.reminderRunner({ unit: async (fn) => fn() });
  const now = new Date('2030-01-01T08:45:00Z');
  return { ...c, get state() { return c.state; }, calendar, event, row, runner, port, now, delivery: calendar.reminderDelivery };
}
describe('Calendar reminder delivery contracts', () => {
  it('sends only due reminders and stores durable evidence with an occurrence-specific idempotency key', async () => {
    const c = await setup();
    expect((await c.runner.runDue({ now: new Date(c.now.getTime() - 1) })).claimed).toBe(0);
    expect(await c.runner.runDue({ now: c.now })).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(c.row).toMatchObject({ status: 'SENT', attempts: 1, sentAt: c.now, claimToken: null, leaseExpiresAt: null });
    expect(c.port.sent[0]).toMatchObject({ workspaceId: c.owner.workspaceId, recipientUserIds: [c.owner.user.id], channel: 'IN_APP', notificationType: 'CALENDAR_REMINDER',
      idempotencyKey: `calendar-reminder:${c.owner.workspaceId}:${c.row.id}:1` });
    expect((await c.runner.runDue({ now: c.now })).claimed).toBe(0);
    expect(c.port.sent).toHaveLength(1); expect(c.state.outboxEvents.filter((row) => row.eventType === 'CALENDAR_REMINDER_SENT')).toHaveLength(1);
  });
  it('retries an ambiguous provider failure with the same durable key without corrupting recurrence or duplicating delivery', async () => {
    const c = await setup();
    const rule = c.calendar.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'UTC', version: 0 }), true)!;
    const row = c.calendar.reminders.create(c.owner, c.event.id, b({ recurrenceId: rule.upcoming[1].recurrenceId, offsetSeconds: 900, channel: 'EMAIL' }));
    const before = structuredClone(c.state.calendarRecurrenceRules), notify = c.port.notifyUsers.bind(c.port);
    let fail = true;
    c.port.notifyUsers = (input) => { const result = notify(input); if (fail) { fail = false; throw new Error('secret provider response'); } return result; };
    const now = new Date('2030-01-02T08:45:00Z');
    expect(await c.runner.runDue({ now })).toMatchObject({ failed: 1 });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1, lastErrorCode: 'NOTIFICATION_DELIVERY_FAILED' });
    expect(JSON.stringify(row)).not.toContain('secret'); expect(c.state.calendarRecurrenceRules).toEqual(before);
    expect((await c.runner.runDue({ now: new Date(now.getTime() + 1) })).claimed).toBe(0);
    expect(await c.runner.runDue({ now: row.nextAttemptAt! })).toMatchObject({ sent: 1 });
    expect(row.status).toBe('SENT'); expect(c.port.sent).toHaveLength(1); expect(row.attempts).toBe(2);
  });
  it('respects channel preferences, denies adapters without preference evaluation and isolates job failures', async () => {
    const c = await setup();
    c.port.setChannelAllowed(c.owner.workspaceId, c.owner.user.id, 'IN_APP', false);
    const email = c.calendar.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'EMAIL' }));
    expect(await c.runner.runDue({ now: c.now })).toMatchObject({ suppressed: 1, sent: 1 });
    expect(c.row).toMatchObject({ status: 'CANCELLED', lastErrorCode: 'NOTIFICATION_CHANNEL_DISABLED' }); expect(email.status).toBe('SENT');
    const unavailable = c.calendar.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'PUSH' }));
    c.app.setNotificationPort({ notifyUsers: () => { throw new Error('Must not send without preferences'); } });
    expect(await c.runner.runDue({ now: c.now })).toMatchObject({ failed: 1 });
    expect(unavailable.lastErrorCode).toBe('NOTIFICATION_SERVICE_UNAVAILABLE');
  });
  it('rechecks Event access and attendee membership at dispatch and cancels revoked recipients', async () => {
    const c = await setup(), attendee = await c.memberActor('delivery-attendee', perms('OWN', 'event.read', 'event.reminder_manage'));
    c.calendar.events.addAttendees(c.owner, c.event.id, b({ userId: attendee.user.id }));
    const row = c.calendar.reminders.create(attendee, c.event.id, b({ offsetSeconds: 900, channel: 'PUSH' }));
    c.state.workspaceMemberships.find((item) => item.userId === attendee.user.id && item.workspaceId === c.owner.workspaceId)!.isDeleted = true;
    expect(await c.runner.runDue({ now: c.now })).toMatchObject({ sent: 1, skipped: 1 });
    expect(row.status).toBe('CANCELLED'); expect(c.port.sent.flatMap((item) => item.recipientUserIds)).not.toContain(attendee.user.id);
  });
  it('leases concurrent workers, recovers a crashed worker and fences late or changed outcomes', async () => {
    const c = await setup(), token = randomUUID();
    expect(c.delivery.claimDue(25, token, c.now)).toEqual([c.row.id]);
    const stale = c.delivery.prepare(c.row.id, token, c.now)!;
    expect(c.delivery.claimDue(25, randomUUID(), c.now)).toEqual([]);
    // Provider accepted, but worker crashed before persisting its outcome.
    const outcome = await c.delivery.deliver(stale);
    const later = new Date(c.now.getTime() + 300_001);
    expect(await c.runner.runDue({ now: later })).toMatchObject({ sent: 1 });
    expect(c.port.sent).toHaveLength(1); expect(c.row.attempts).toBe(2);
    expect(c.delivery.finish(stale, outcome, later)).toBe(false);
    const changed = c.calendar.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'EMAIL' }));
    const token2 = randomUUID(); c.delivery.claimDue(25, token2, later);
    const old = c.delivery.prepare(changed.id, token2, later)!;
    c.calendar.reminders.update(c.owner, changed.id, b({ offsetSeconds: 300, version: changed.version }));
    expect(c.delivery.finish(old, { kind: 'SENT', reference: 'stale' }, later)).toBe(false);
    expect(changed).toMatchObject({ status: 'SCHEDULED', sentAt: null, deliveryGeneration: 2, attempts: 0 });
  });
  it('caps failed retries, exposes dead-letter state and permits an authorized new delivery generation', async () => {
    const c = await setup(); c.app.setNotificationPort(null);
    let now = c.now;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await c.runner.runDue({ now })).failed).toBe(1); expect(c.row.attempts).toBe(attempt);
      now = c.row.nextAttemptAt ?? new Date(now.getTime() + 3_600_000);
    }
    expect(c.row).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
    expect((await c.runner.runDue({ now })).claimed).toBe(0);
    c.calendar.reminders.update(c.owner, c.row.id, b({ channel: 'EMAIL', version: c.row.version }));
    c.app.setNotificationPort(c.port);
    expect((await c.runner.runDue({ now: c.now })).sent).toBe(1); expect(c.row.deliveryGeneration).toBe(2);
  });
  it('bounds stalled provider calls, aborts their signal and continues processing other reminders', async () => {
    const c = await setup(), other = c.calendar.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'EMAIL' }));
    let stalledSignal: AbortSignal | undefined;
    c.app.setNotificationPort({ canDeliver: () => true, notifyUsers: (input) => {
      if (input.channel === 'IN_APP') { stalledSignal = input.signal; return new Promise(() => {}); }
      return c.port.notifyUsers(input);
    } });
    const runner = c.calendar.reminderRunner({ unit: async (fn) => fn() }, { deliveryTimeoutMs: 10 });
    expect(await runner.runDue({ now: c.now })).toMatchObject({ sent: 1, failed: 1 });
    expect(stalledSignal!.aborted).toBe(true); expect(c.row.lastErrorCode).toBe('JOB_DELIVERY_TIMEOUT'); expect(other.status).toBe('SENT');
  });
  it('never starts a send after preference evaluation completes beyond its timeout', async () => {
    const c = await setup();
    let resolvePreference!: (value: boolean) => void;
    c.app.setNotificationPort({ canDeliver: () => new Promise((resolve) => { resolvePreference = resolve; }), notifyUsers: (input) => c.port.notifyUsers(input) });
    const runner = c.calendar.reminderRunner({ unit: async (fn) => fn() }, { deliveryTimeoutMs: 10 });
    expect((await runner.runDue({ now: c.now })).failed).toBe(1);
    resolvePreference(true); await Promise.resolve(); await Promise.resolve();
    expect(c.port.sent).toHaveLength(0); expect(c.row.status).toBe('FAILED');
  });
  it('dead-letters an exhausted crashed lease instead of leaving it permanently scheduled', async () => {
    const c = await setup();
    let now = c.now;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(c.delivery.claimDue(25, randomUUID(), now)).toEqual([c.row.id]);
      now = new Date(now.getTime() + 300_001);
    }
    c.delivery.expireExhausted(now);
    expect(c.row).toMatchObject({ status: 'FAILED', attempts: 5, lastErrorCode: 'REMINDER_RETRY_EXHAUSTED', claimToken: null, leaseExpiresAt: null, nextAttemptAt: null });
    expect(c.delivery.claimDue(25, randomUUID(), now)).toEqual([]);
    expect(c.state.outboxEvents.filter((row) => row.eventType === 'CALENDAR_REMINDER_FAILED')).toHaveLength(1);
  });
  it('claims fresh bounded waves so a backlog cannot exhaust leases while waiting behind provider calls', async () => {
    const c = await setup();
    for (let index = 0; index < 10; index += 1) c.calendar.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'IN_APP' }));
    let active = 0, peak = 0;
    const claims: Array<{ count: number; active: number }> = [], original = c.delivery.claimDue.bind(c.delivery);
    c.delivery.claimDue = (limit, token, now) => { claims.push({ count: limit, active }); return original(limit, token, now); };
    c.app.setNotificationPort({ canDeliver: () => true, notifyUsers: async (input) => {
      active += 1; peak = Math.max(peak, active);
      try { await new Promise((resolve) => setTimeout(resolve, 20)); return c.port.notifyUsers(input); }
      finally { active -= 1; }
    } });
    expect(await c.runner.runDue({ limit: 11, now: c.now })).toMatchObject({ claimed: 11, sent: 11, failed: 0 });
    expect(claims).toEqual([{ count: 5, active: 0 }, { count: 5, active: 0 }, { count: 1, active: 0 }]);
    expect(peak).toBe(5); expect(c.port.sent).toHaveLength(11);
  });
});
