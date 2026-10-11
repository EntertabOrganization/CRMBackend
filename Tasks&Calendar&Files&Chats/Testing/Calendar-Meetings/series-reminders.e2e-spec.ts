import { randomUUID } from 'node:crypto';
import { RecordingNotificationPort } from '@/src/server/ports';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, foreign: Session;
beforeAll(async () => { await prepareCollabDatabase(); owner = await register('series-reminders'); foreign = await register('foreign-series-reminders'); });
afterAll(disconnect);
async function setup() {
  const container = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Series', timezone: 'Europe/Berlin' } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: container.id, title: 'Series',
    startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin' } }));
  const path = `calendar-events/${event.id}`;
  expectOk(await call(owner, 'PUT', `${path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=5', sourceTimezone: 'Europe/Berlin', version: 0 } }));
  const parent = expectOk(await call(owner, 'POST', `${path}/reminders`, { body: { offsetSeconds: 900, channel: 'IN_APP' } }));
  const { appContext } = await import('@/src/server/app-context'), { runCalendarReminders, runStateUnit } = await import('@/src/server/response');
  const port = new RecordingNotificationPort(); appContext.setNotificationPort(port);
  return { event, path, parent, port, runCalendarReminders, runStateUnit, appContext };
}
describe('Series reminder HTTP/PostgreSQL contracts', () => {
  it('materializes and delivers through real persisted leases without duplicating occurrence records', async () => {
    const c = await setup(), now = new Date('2030-03-30T07:45:00Z'), prisma = await db();
    expect(c.parent).toMatchObject({ isSeries: true, dueAt: null, recurrenceId: null });
    expect(await c.runCalendarReminders(25, now)).toMatchObject({ sent: 1 });
    const children = await prisma.calendarEventReminder.findMany({ where: { seriesReminderId: c.parent.id }, orderBy: { recurrenceId: 'asc' } });
    expect(children[0]).toMatchObject({ status: 'SENT', attempts: 1, sentAt: now });
    expect(children[1].dueAt).toEqual(new Date('2030-03-31T06:45:00Z'));
    expect(await c.runCalendarReminders(25, now)).toMatchObject({ claimed: 0 });
    expect(await prisma.calendarEventReminder.count({ where: { seriesReminderId: c.parent.id } })).toBe(children.length);
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: c.parent.id } })).toMatchObject({ attempts: 0, status: 'SCHEDULED' });
    expect(c.port.sent).toHaveLength(1);
    expectError(await call(foreign, 'GET', `${c.path}/reminders`), 404, 'EVENT_NOT_FOUND');
    expectError(await call(foreign, 'PATCH', `calendar-reminders/${children[1].id}`, { body: { version: children[1].version, channel: 'EMAIL' } }), 404, 'REMINDER_NOT_FOUND');
  });
  it('persists edits, revalidates occurrence schedules and cascades cancellation while preserving sent history', async () => {
    const c = await setup(), now = new Date('2030-03-30T07:45:00Z'), prisma = await db();
    await c.runCalendarReminders(25, now);
    expectOk(await call(owner, 'PATCH', `${c.path}/occurrences/2030-03-31T09:00:00.000`, { body: { startAt: '2030-03-31T12:00:00+02:00', version: 1 } }));
    await c.runCalendarReminders(25, now);
    const moved = await prisma.calendarEventReminder.findFirstOrThrow({ where: { seriesReminderId: c.parent.id, recurrenceId: '2030-03-31T09:00:00.000' } });
    expect(moved.dueAt).toEqual(new Date('2030-03-31T09:45:00Z'));
    let parent = await prisma.calendarEventReminder.findUniqueOrThrow({ where: { id: c.parent.id } });
    expectOk(await call(owner, 'PATCH', `calendar-reminders/${parent.id}`, { body: { version: parent.version, channel: 'EMAIL', offsetSeconds: 1800 } }));
    await c.runCalendarReminders(25, now);
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: moved.id } })).toMatchObject({ channel: 'EMAIL', dueAt: new Date('2030-03-31T09:30:00Z') });
    parent = await prisma.calendarEventReminder.findUniqueOrThrow({ where: { id: parent.id } });
    expectOk(await call(owner, 'DELETE', `calendar-reminders/${parent.id}`, { body: { version: parent.version } }));
    const children = await prisma.calendarEventReminder.findMany({ where: { seriesReminderId: parent.id } });
    expect(children.filter((row) => row.status === 'SENT')).toHaveLength(1);
    expect(children.filter((row) => row.status === 'SCHEDULED' || row.status === 'FAILED')).toHaveLength(0);
    await c.runCalendarReminders(25, new Date('2030-04-01T12:00:00Z'));
    expect(await prisma.calendarEventReminder.count({ where: { seriesReminderId: parent.id, status: 'SENT' } })).toBe(1);
  });
  it('enforces occurrence uniqueness, parent ownership, immutable identity and series configuration shape in PostgreSQL', async () => {
    const c = await setup(), prisma = await db();
    await c.runStateUnit(() => c.appContext.collab.calendar.reminders.materialize(new Date('2030-03-30T07:00:00Z')));
    const child = await prisma.calendarEventReminder.findFirstOrThrow({ where: { seriesReminderId: c.parent.id } });
    await expect(prisma.calendarEventReminder.create({ data: { ...child, id: randomUUID() } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.calendarEventReminder.update({ where: { id: child.id }, data: { seriesReminderId: null, version: child.version + 1 } })).rejects.toThrow('RECURRENCE_SCOPE_INVALID');
    await expect(prisma.calendarEventReminder.create({ data: { ...child, id: randomUUID(), seriesReminderId: child.id, recurrenceId: '2030-04-05T09:00:00.000' } })).rejects.toThrow('RECURRENCE_SCOPE_INVALID');
    const parent = await prisma.calendarEventReminder.findUniqueOrThrow({ where: { id: c.parent.id } });
    await expect(prisma.calendarEventReminder.update({ where: { id: parent.id }, data: { dueAt: new Date(), version: parent.version + 1 } })).rejects.toThrow();
    await expect(prisma.calendarEventReminder.update({ where: { id: child.id }, data: { cursorOrdinal: 1, version: child.version + 1 } })).rejects.toThrow();
    await expect(prisma.calendarEventReminder.update({ where: { id: parent.id }, data: { isSeriesOverride: true, version: parent.version + 1 } })).rejects.toThrow();
    expectError(await call(owner, 'POST', `${c.path}/reminders`, { body: { remindAt: '2030-03-30T07:00:00Z', channel: 'IN_APP' } }), 400, 'RECURRENCE_SCOPE_INVALID');
  });
});
