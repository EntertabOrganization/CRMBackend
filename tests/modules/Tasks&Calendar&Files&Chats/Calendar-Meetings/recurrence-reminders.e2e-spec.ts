import { randomUUID } from 'node:crypto';
import { RecordingNotificationPort } from '@/src/server/ports';
import { api } from '@/tests/support/api';
import { claimCalendarReminders } from '@/src/server/collab/calendar/reminder-delivery';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
const previousToken = process.env.INTERNAL_JOB_TOKEN, jobToken = randomUUID();
let owner: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('delivery-owner'); foreign = await register('delivery-foreign');
  process.env.INTERNAL_JOB_TOKEN = jobToken;
});
afterAll(async () => {
  if (previousToken === undefined) delete process.env.INTERNAL_JOB_TOKEN; else process.env.INTERNAL_JOB_TOKEN = previousToken;
  await disconnect();
});
async function setup() {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Delivery', timezone: 'UTC' } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Series', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } }));
  const path = `calendar-events/${event.id}`;
  return { calendar, event, path };
}
async function pending(eventId: string, channel = 'IN_APP') {
  const row = expectOk(await call(owner, 'POST', `calendar-events/${eventId}/reminders`, { body: { remindAt: '2030-01-01T08:45:00Z', channel } }));
  const at = new Date(Date.now() - 1000);
  return (await db()).calendarEventReminder.update({ where: { id: row.id }, data: { remindAt: at, dueAt: at, version: 2 } });
}
async function context() { return (await import('@/src/server/app-context')).appContext; }
async function worker(body: unknown = {}) {
  return api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'calendar-reminders' }, headers: { 'x-internal-job-token': jobToken }, body });
}
describe('Calendar Recurrence & Reminders Specification E2E contract', () => {
  it('exposes and enforces representative recurrence routes', async () => {
    const c = await setup();
    const rule = expectOk(await call(owner, 'PUT', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'UTC', version: 0 } }));
    expect(expectOk(await call(owner, 'GET', `${c.path}/recurrence`)).id).toBe(rule.id);
    expectOk(await call(owner, 'PATCH', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=WEEKLY;COUNT=3', version: 1 } }));
    expectOk(await call(owner, 'DELETE', `${c.path}/recurrence`, { body: { version: 2 } }));
    expect(expectOk(await call(owner, 'GET', `${c.path}/recurrence`))).toBeNull();
  });
  it('requires authenticated/authorized workspace context and an independent internal scheduler token', async () => {
    const c = await setup();
    expectError(await call(null, 'GET', `${c.path}/reminders`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    const path = '/api/v1/internal/crm/jobs/[job]', params = { job: 'calendar-reminders' };
    expectError(await api('POST', path, { params, token: owner.token, body: {} }), 401, 'UNAUTHENTICATED');
    expectError(await api('POST', path, { params, headers: { 'x-internal-job-token': 'wrong' }, body: {} }), 401, 'UNAUTHENTICATED');
    expectOk(await worker());
  });
  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const c = await setup(), row = await pending(c.event.id);
    expectError(await call(foreign, 'GET', `${c.path}/reminders`), 404, 'EVENT_NOT_FOUND');
    expectError(await call(foreign, 'PATCH', `calendar-reminders/${row.id}`, { body: { offsetSeconds: 900, version: row.version } }), 404, 'REMINDER_NOT_FOUND');
    const port = new RecordingNotificationPort(); (await context()).setNotificationPort(port);
    expectOk(await worker());
    expect(port.sent.find((item) => item.idempotencyKey.includes(row.id))).toMatchObject({ workspaceId: owner.workspaceId, recipientUserIds: [owner.userId] });
  });
  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const c = await setup();
    expectError(await worker({ limit: -1 }), 400, 'VALIDATION_ERROR');
    expectError(await worker({ limit: 1.5 }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `${c.path}/reminders`, { body: { offsetSeconds: -1, channel: 'EMAIL' } }), 400, 'REMINDER_INVALID_TIME');
    expectError(await call(owner, 'PUT', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=0', sourceTimezone: 'UTC', version: 0 } }), 400, 'RECURRENCE_INVALID_RULE');
  });
  it('persists delivery evidence/outbox, retries provider failures and deduplicates ambiguous sends', async () => {
    const c = await setup(), row = await pending(c.event.id), port = new RecordingNotificationPort(), app = await context();
    let fail = true;
    app.setNotificationPort({ canDeliver: () => true, notifyUsers: (input) => { const result = port.notifyUsers(input); if (fail) { fail = false; throw new Error('Secret external error'); } return result; } });
    expect(expectOk(await worker())).toMatchObject({ failed: 1 });
    const prisma = await db(), failed = (await prisma.calendarEventReminder.findUnique({ where: { id: row.id } }))!;
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, lastErrorCode: 'NOTIFICATION_DELIVERY_FAILED' });
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    await prisma.calendarEventReminder.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1000), version: failed.version + 1 } });
    expect(expectOk(await worker())).toMatchObject({ sent: 1 });
    expect(port.sent).toHaveLength(1);
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'SENT', attempts: 2, claimToken: null, leaseExpiresAt: null, deliveryReference: port.sent[0].idempotencyKey });
    expect(await prisma.outboxEvent.count({ where: { entityId: c.event.id, eventType: 'CALENDAR_REMINDER_SENT' } })).toBe(1);
    expect(expectOk(await worker()).claimed).toBe(0);
  });
  it('atomically leases across database workers, recovers a crash and fences expired outcomes', async () => {
    const c = await setup(), row = await pending(c.event.id), prisma = await db(), port = new RecordingNotificationPort(), app = await context();
    app.setNotificationPort(port);
    const tokenA = randomUUID(), tokenB = randomUUID(), now = new Date();
    const claims = await Promise.all([claimCalendarReminders(prisma, 1, tokenA, now), claimCalendarReminders(prisma, 1, tokenB, now)]);
    expect(claims.flat()).toEqual([row.id]);
    const token = claims[0].length ? tokenA : tokenB;
    const { runStateUnit } = await import('@/src/server/response');
    const ticket = (await runStateUnit(() => app.collab.calendar.reminderDelivery.prepare(row.id, token, now)))!;
    const outcome = await app.collab.calendar.reminderDelivery.deliver(ticket);
    const claimed = (await prisma.calendarEventReminder.findUnique({ where: { id: row.id } }))!;
    await prisma.calendarEventReminder.update({ where: { id: row.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000), version: claimed.version + 1 } });
    expect(expectOk(await worker())).toMatchObject({ sent: 1 });
    expect(port.sent).toHaveLength(1);
    expect(await runStateUnit(() => app.collab.calendar.reminderDelivery.finish(ticket, outcome, new Date()))).toBe(false);
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'SENT', attempts: 2 });
  });
  it('runs provider I/O outside the request state queue and respects opt-outs', async () => {
    const c = await setup(), row = await pending(c.event.id), app = await context(), port = new RecordingNotificationPort();
    const { runStateUnit } = await import('@/src/server/response');
    app.setNotificationPort({ canDeliver: () => true, notifyUsers: async (input) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([runStateUnit(() => expect(app.store.state.calendarEvents.some((item) => item.id === c.event.id)).toBe(true)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('State queue held during provider I/O')), 10_000); })]); }
      finally { if (timer) clearTimeout(timer); }
      return port.notifyUsers(input);
    } });
    expect(expectOk(await worker())).toMatchObject({ sent: 1 });
    expect(port.sent).toHaveLength(1);
    const optedOut = await pending(c.event.id, 'PUSH');
    port.setChannelAllowed(owner.workspaceId, owner.userId, 'PUSH', false); app.setNotificationPort(port);
    expect(expectOk(await worker())).toMatchObject({ suppressed: 1 });
    expect(await (await db()).calendarEventReminder.findUnique({ where: { id: optedOut.id } })).toMatchObject({ status: 'CANCELLED', lastErrorCode: 'NOTIFICATION_CHANNEL_DISABLED' });
    expect(await (await db()).calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'SENT' });
  });
});
