import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(300_000);
beforeAll(prepareCollabDatabase);
afterAll(disconnect);
async function setup(channel = 'IN_APP') {
  const owner = await register('notification-host'), foreign = await register('notification-foreign');
  const peer = await member(owner, 'notification-peer', [['event.read', 'OWN']]);
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Reminder', timezone: 'UTC' } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Private reminder title',
    startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } }));
  const reminder = expectOk(await call(owner, 'POST', `calendar-events/${event.id}/reminders`, { body: { channel, offsetSeconds: 600 } }));
  const { appContext } = await import('@/src/server/app-context');
  const { runCalendarReminders } = await import('@/src/server/response');
  return { owner, foreign, peer, event, reminder, appContext, runCalendarReminders, now: new Date('2030-01-01T08:50:00Z') };
}
describe('Shared Notifications integration with Calendar reminders', () => {
  it('delivers to the durable inbox through the real worker and deduplicates concurrent retries', async () => {
    const c = await setup(), prisma = await db();
    expect(await c.runCalendarReminders(25, c.now)).toMatchObject({ sent: 1 });
    const row = await prisma.userNotification.findFirstOrThrow({ where: { workspaceId: c.owner.workspaceId } });
    expect(row).toMatchObject({ recipientUserId: c.owner.userId, notificationType: 'CALENDAR_REMINDER', message: 'Private reminder title' });
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: c.reminder.id } })).toMatchObject({ status: 'SENT', deliveryReference: row.id });
    expect(await c.runCalendarReminders(25, c.now)).toMatchObject({ claimed: 0 });
    const input = { workspaceId: c.owner.workspaceId, actorUserId: c.owner.userId, recipientUserIds: [c.owner.userId],
      title: 'Calendar reminder', message: row.message, channel: 'IN_APP' as const, notificationType: row.notificationType, idempotencyKey: row.idempotencyKey };
    const retries = await Promise.all([c.appContext.notifications.notifyUsers(input), c.appContext.notifications.notifyUsers(input)]);
    expect(retries).toEqual([{ reference: row.id }, { reference: row.id }]);
    expect(await prisma.userNotification.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(1);
    const inbox = await call(c.owner, 'GET', 'notifications'); expectOk(inbox);
    expect(inbox.data).toHaveLength(1); expect(inbox.body.meta.total).toBe(1);
    expect(JSON.stringify(inbox.body)).not.toContain('idempotencyKey');
    expectOk(await call(c.owner, 'POST', `notifications/${row.id}/read`, { body: {} }));
    const read = (await prisma.userNotification.findUniqueOrThrow({ where: { id: row.id } })).readAt;
    expectOk(await call(c.owner, 'POST', `notifications/${row.id}/read`, { body: {} }));
    expect((await prisma.userNotification.findUniqueOrThrow({ where: { id: row.id } })).readAt).toEqual(read);
    for (const actor of [c.peer, c.foreign]) {
      expect(expectOk(await call(actor, 'GET', 'notifications'))).toEqual([]);
      expectError(await call(actor, 'POST', `notifications/${row.id}/read`, { body: {} }), 404, 'NOTIFICATION_NOT_FOUND');
    }
    expectError(await call(null, 'GET', 'notifications'), 401, 'UNAUTHENTICATED');
  });
  it('applies live preferences before dispatch and retains suppressed reminder evidence', async () => {
    const c = await setup(), prisma = await db();
    expectOk(await call(c.owner, 'PUT', 'notification-preferences', { body: { notificationType: 'CALENDAR_REMINDER', channel: 'IN_APP', enabled: false } }));
    expect(expectOk(await call(c.owner, 'GET', 'notification-preferences'))).toEqual([{ notificationType: 'CALENDAR_REMINDER', channel: 'IN_APP', enabled: false }]);
    expect(expectOk(await call(c.peer, 'GET', 'notification-preferences'))).toEqual([]);
    expect(await c.runCalendarReminders(25, c.now)).toMatchObject({ suppressed: 1 });
    expect(await prisma.userNotification.count({ where: { workspaceId: c.owner.workspaceId } })).toBe(0);
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: c.reminder.id } })).toMatchObject({ status: 'CANCELLED', lastErrorCode: 'NOTIFICATION_CHANNEL_DISABLED' });
    expectError(await call(c.owner, 'PUT', 'notification-preferences', { body: { userId: c.peer.userId, notificationType: 'CALENDAR_REMINDER', channel: 'IN_APP', enabled: false } }), 400, 'VALIDATION_ERROR');
    expectError(await call(null, 'PUT', 'notification-preferences', { body: {} }), 401, 'UNAUTHENTICATED');
  });
  it('keeps unconfigured external delivery retryable and refuses revoked recipients', async () => {
    const c = await setup('EMAIL'), prisma = await db();
    expect(await c.runCalendarReminders(25, c.now)).toMatchObject({ failed: 1 });
    expect(await prisma.calendarEventReminder.findUnique({ where: { id: c.reminder.id } })).toMatchObject({ status: 'FAILED', lastErrorCode: 'NOTIFICATION_SERVICE_UNAVAILABLE' });
    await prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: c.owner.workspaceId, userId: c.peer.userId } }, data: { status: 'SUSPENDED' } });
    expect(await c.appContext.notifications.notifyUsers({ workspaceId: c.owner.workspaceId, actorUserId: c.owner.userId,
      recipientUserIds: [c.peer.userId], title: 'Hidden', message: 'Hidden', idempotencyKey: randomUUID() })).toEqual({ reference: null });
    expect(await prisma.userNotification.count({ where: { recipientUserId: c.peer.userId } })).toBe(0);
    await expect(prisma.userNotification.create({ data: { workspaceId: c.foreign.workspaceId, recipientUserId: c.owner.userId,
      notificationType: 'GENERAL', title: 'Foreign', message: 'Foreign', idempotencyKey: randomUUID() } })).rejects.toMatchObject({ code: 'P2003' });
  });
});
