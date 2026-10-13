import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, attendee: Session, other: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('reminder-owner'); foreign = await register('reminder-foreign');
  attendee = await member(owner, 'reminder-attendee', [['event.read', 'OWN'], ['event.reminder_manage', 'OWN']]);
  other = await member(owner, 'reminder-other', [['event.read', 'OWN'], ['event.reminder_manage', 'OWN']]);
});
afterAll(disconnect);
async function setup(recurring = false) {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Reminders', timezone: 'Europe/Berlin' } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Meeting',
    startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin', attendeeUserIds: [attendee.userId, other.userId] } }));
  const path = `calendar-events/${event.id}`;
  const rule = recurring ? expectOk(await call(owner, 'PUT', `${path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', version: 0 } })) : null;
  return { calendar, event, path, rule };
}
describe('Calendar reminder configuration HTTP/PostgreSQL contracts', () => {
  it('persists all four routes, replays creation, switches timing modes and retains cancellation/outbox evidence', async () => {
    const c = await setup(), input = { offsetSeconds: 900, channel: 'IN_APP' };
    const row = expectOk(await call(owner, 'POST', `${c.path}/reminders`, { body: input, headers: { 'idempotency-key': 'reminder-replay' } }));
    expect(row).toMatchObject({ dueAt: '2030-03-30T07:45:00.000Z', status: 'SCHEDULED', version: 1, attendeeUserId: owner.userId });
    expect(expectOk(await call(owner, 'POST', `${c.path}/reminders`, { body: input, headers: { 'idempotency-key': 'reminder-replay' } })).id).toBe(row.id);
    expect(expectOk(await call(owner, 'GET', `${c.path}/reminders`))).toHaveLength(1);
    const updated = expectOk(await call(owner, 'PATCH', `calendar-reminders/${row.id}`, { body: { remindAt: '2030-03-30T07:00:00Z', channel: 'EMAIL' }, headers: { 'if-match': '"1"' } }));
    expect(updated).toMatchObject({ offsetSeconds: null, version: 2, dueAt: '2030-03-30T07:00:00.000Z' });
    expectOk(await call(owner, 'DELETE', `calendar-reminders/${row.id}`, { headers: { 'if-match': '"2"' } }));
    expectOk(await call(owner, 'DELETE', `calendar-reminders/${row.id}`, { body: { version: 2 } }));
    const prisma = await db();
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'CANCELLED', version: 3 });
    expect(await prisma.outboxEvent.count({ where: { entityId: c.event.id, eventType: 'CALENDAR_REMINDER_SCHEDULED' } })).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { entityId: c.event.id, eventType: 'CALENDAR_REMINDER_CANCELLED' } })).toBe(1);
  });
  it('authenticates all reminder routes, protects recipients and hides cross-tenant IDs', async () => {
    const c = await setup(), row = expectOk(await call(attendee, 'POST', `${c.path}/reminders`, { body: { offsetSeconds: 600, channel: 'IN_APP' } }));
    for (const [method, path, body] of [['GET', `${c.path}/reminders`, undefined], ['POST', `${c.path}/reminders`, { offsetSeconds: 600, channel: 'IN_APP' }],
      ['PATCH', `calendar-reminders/${row.id}`, { offsetSeconds: 100, version: 1 }], ['DELETE', `calendar-reminders/${row.id}`, { version: 1 }]] as const) {
      expectError(await call(null, method, path, { workspaceId: owner.workspaceId, body }), 401, 'UNAUTHENTICATED');
      expectError(await call(foreign, method, path, { body }), 404, path.includes('calendar-reminders/') ? 'REMINDER_NOT_FOUND' : 'EVENT_NOT_FOUND');
    }
    expect(expectOk(await call(other, 'GET', `${c.path}/reminders`))).toEqual([]);
    expectError(await call(other, 'PATCH', `calendar-reminders/${row.id}`, { body: { offsetSeconds: 100, version: 1 } }), 404, 'REMINDER_NOT_FOUND');
    expectError(await call(other, 'POST', `${c.path}/reminders`, { body: { attendeeUserId: attendee.userId, offsetSeconds: 100, channel: 'IN_APP' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(owner, 'POST', `${c.path}/reminders`, { body: { attendeeUserId: foreign.userId, offsetSeconds: 100, channel: 'IN_APP' } }), 400, 'EVENT_ATTENDEE_INVALID');
    expectOk(await call(owner, 'DELETE', `${c.path}/attendees/${attendee.userId}`));
    expect(await (await db()).calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'CANCELLED' });
  });
  it('rejects bad timing and stale writes atomically and enforces database tenant/timing/version guards', async () => {
    const c = await setup(), prisma = await db();
    for (const input of [{ offsetSeconds: -1 }, { remindAt: '2020-01-01T00:00:00Z' }, { remindAt: '2030-03-30T12:00:00Z' }, { offsetSeconds: 100, remindAt: '2030-03-30T07:00:00Z' }])
      expectError(await call(owner, 'POST', `${c.path}/reminders`, { body: { ...input, channel: 'IN_APP' } }), 400, 'REMINDER_INVALID_TIME');
    expect(await prisma.calendarEventReminder.count({ where: { eventId: c.event.id } })).toBe(0);
    const row = expectOk(await call(owner, 'POST', `${c.path}/reminders`, { body: { offsetSeconds: 100, channel: 'IN_APP' } }));
    const writes = await Promise.all([200, 300].map((offsetSeconds) => call(owner, 'PATCH', `calendar-reminders/${row.id}`, { body: { offsetSeconds, version: 1 } })));
    expect(writes.map((item) => item.status).sort()).toEqual([200, 409]);
    await expect(prisma.calendarEventReminder.update({ where: { id: row.id }, data: { offsetSeconds: -1, version: 3 } })).rejects.toThrow();
    await expect(prisma.calendarEventReminder.update({ where: { id: row.id }, data: { offsetSeconds: 400, version: 2 } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.calendarEventReminder.update({ where: { id: row.id }, data: { workspaceId: foreign.workspaceId, version: 3 } })).rejects.toThrow('RECURRENCE_SCOPE_INVALID');
    const now = new Date();
    await expect(prisma.calendarEventReminder.create({ data: { id: randomUUID(), workspaceId: foreign.workspaceId, eventId: c.event.id, attendeeUserId: foreign.userId,
      offsetSeconds: 100, dueAt: new Date(row.dueAt), channel: 'IN_APP', createdAt: now, updatedAt: now } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('reschedules original recurrence identities and cancels occurrence and parent reminders durably', async () => {
    const c = await setup(true), identity = c.rule.upcoming[1].recurrenceId;
    const row = expectOk(await call(owner, 'POST', `${c.path}/reminders`, { body: { recurrenceId: identity, offsetSeconds: 900, channel: 'IN_APP' } }));
    expect(row.dueAt).toBe('2030-03-31T06:45:00.000Z');
    expectOk(await call(owner, 'PATCH', `${c.path}/occurrences/${identity}`, { body: { startAt: '2030-04-10T12:00:00+02:00', version: 1 } }));
    expect(await (await db()).calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ recurrenceId: identity, dueAt: new Date('2030-04-10T09:45:00Z'), version: 2 });
    expectOk(await call(owner, 'POST', `${c.path}/occurrences/${identity}/cancel`, { body: { version: 2 } }));
    expect(await (await db()).calendarEventReminder.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'CANCELLED' });
    const next = expectOk(await call(owner, 'POST', `${c.path}/reminders`, { body: { recurrenceId: c.rule.upcoming[2].recurrenceId, offsetSeconds: 900, channel: 'EMAIL' } }));
    expectOk(await call(owner, 'POST', `${c.path}/cancel`, { body: {} }));
    expect(await (await db()).calendarEventReminder.findUnique({ where: { id: next.id } })).toMatchObject({ status: 'CANCELLED' });
  });
});
