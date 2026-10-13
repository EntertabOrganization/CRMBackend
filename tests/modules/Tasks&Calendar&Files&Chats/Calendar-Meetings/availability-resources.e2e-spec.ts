import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, reader: Session, ownReader: Session, foreign: Session;
const range = { startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T18:00:00Z' };
const weekly = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, localStartTime: '09:00', localEndTime: '17:00' }));
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('availability-owner'); foreign = await register('availability-foreign');
  reader = await member(owner, 'availability-reader', [['calendar.free_busy', 'WORKSPACE'], ['resource.read', 'WORKSPACE']]);
  ownReader = await member(owner, 'availability-own', [['calendar.free_busy', 'OWN'], ['calendar.working_schedule_manage', 'OWN']]);
});
afterAll(disconnect);
async function setup() {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Private', timezone: 'UTC' } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Secret private customer', description: 'Sensitive notes',
    startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T10:00:00Z' } }));
  const resource = expectOk(await call(owner, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Room', timezone: 'UTC', capacity: 10 } }));
  return { calendar, event, resource };
}
describe('Availability & Resources HTTP/PostgreSQL contracts', () => {
  it('serves private free/busy and suggestions from durable schedules and selected resources', async () => {
    const c = await setup();
    expectOk(await call(owner, 'POST', 'calendar-events/' + c.event.id + '/resources', { body: { resourceId: c.resource.id } }));
    expectOk(await call(owner, 'PUT', 'availability/business-calendar', { body: { timezone: 'UTC', weekly, version: 0 } }));
    expectOk(await call(owner, 'PUT', 'availability/working-schedules/' + owner.userId, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '10:00', localEndTime: '16:00' }], version: 0 } }));
    const busy = expectOk(await call(reader, 'POST', 'availability/free-busy', { body: { ...range, userIds: [owner.userId], resourceIds: [c.resource.id] } }));
    expect(busy.users[0].busy[0]).toMatchObject({ startAt: '2030-01-07T09:00:00.000Z', endAt: '2030-01-07T10:00:00.000Z', state: 'BUSY' });
    expect(JSON.stringify(busy)).not.toMatch(/Secret|Sensitive|eventId|description|organizer|calendarId/);
    const slots = expectOk(await call(reader, 'POST', 'availability/suggest-slots', { body: { ...range, userIds: [owner.userId], resourceIds: [c.resource.id], durationMinutes: 60, stepMinutes: 60 } }));
    expect(slots.slots).toHaveLength(6); expect(slots.slots[0].startAt).toBe('2030-01-07T10:00:00.000Z');
    expectOk(await call(reader, 'GET', 'availability/business-calendar'));
    expectOk(await call(reader, 'GET', 'availability/working-schedules/' + owner.userId));
    const availability = expectOk(await call(reader, 'GET', 'calendar-resources/' + c.resource.id + '/availability', { query: range }));
    expect(availability.free[0].startAt).toBe('2030-01-07T10:00:00.000Z');
  });
  it('authenticates all new routes and enforces management permissions and user scopes', async () => {
    const noBusy = await member(owner, 'availability-no-grant', [['resource.read', 'WORKSPACE']]);
    for (const path of ['availability/free-busy', 'availability/suggest-slots']) {
      const body = { ...range, userIds: [owner.userId], ...(path.endsWith('suggest-slots') ? { durationMinutes: 60 } : {}) };
      expectError(await call(null, 'POST', path, { workspaceId: owner.workspaceId, body }), 401, 'UNAUTHENTICATED');
      expectError(await call(ownReader, 'POST', path, { body }), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
      expectError(await call(noBusy, 'POST', path, { body }), 403, 'PERMISSION_DENIED');
    }
    for (const path of ['availability/business-calendar', 'availability/working-schedules/' + owner.userId]) {
      for (const method of ['GET', 'PUT'] as const) expectError(await call(null, method, path, { workspaceId: owner.workspaceId,
        body: method === 'PUT' ? { timezone: 'UTC', weekly, version: 1 } : undefined }), 401, 'UNAUTHENTICATED');
      expectError(await call(reader, 'PUT', path, { body: { timezone: 'UTC', weekly, version: 1 } }), 403, 'PERMISSION_DENIED');
    }
    expectError(await call(ownReader, 'PUT', 'availability/working-schedules/' + owner.userId, { body: { timezone: 'UTC', weekly, version: 1 } }), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
    expectError(await call(ownReader, 'GET', 'availability/working-schedules/' + owner.userId), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
    expectOk(await call(ownReader, 'PUT', 'availability/working-schedules/' + ownReader.userId, { body: { timezone: 'UTC', weekly, version: 0 } }));
  });
  it('hides foreign users/resources and rechecks recipient membership', async () => {
    const c = await setup();
    expectError(await call(null, 'GET', 'calendar-resources/' + c.resource.id + '/availability', { workspaceId: owner.workspaceId, query: range }), 401, 'UNAUTHENTICATED');
    expectError(await call(foreign, 'GET', 'calendar-resources/' + c.resource.id + '/availability', { query: range }), 404, 'RESOURCE_NOT_FOUND');
    for (const path of ['availability/free-busy', 'availability/suggest-slots']) {
      expectError(await call(owner, 'POST', path, { body: { ...range, userIds: [foreign.userId], ...(path.endsWith('suggest-slots') ? { durationMinutes: 60 } : {}) } }), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
      expectError(await call(foreign, 'POST', path, { body: { ...range, resourceIds: [c.resource.id], ...(path.endsWith('suggest-slots') ? { durationMinutes: 60 } : {}) } }), 404, 'RESOURCE_NOT_FOUND');
    }
    expectError(await call(foreign, 'GET', 'availability/working-schedules/' + owner.userId), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
    expectError(await call(foreign, 'PUT', 'availability/working-schedules/' + owner.userId, { body: { timezone: 'UTC', weekly, version: 1 } }), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
    const departed = await member(owner, 'departed-availability', [['calendar.free_busy', 'WORKSPACE']]), prisma = await db();
    await prisma.workspaceMembership.updateMany({ where: { workspaceId: owner.workspaceId, userId: departed.userId }, data: { isDeleted: true } });
    expectError(await call(owner, 'POST', 'availability/free-busy', { body: { ...range, userIds: [departed.userId] } }), 404, 'AVAILABILITY_SUBJECT_NOT_FOUND');
  });
  it('returns stable validation errors and fences concurrently edited schedules', async () => {
    for (const body of [{ ...range, endAt: range.startAt }, { ...range, startAt: '2030-02-31T00:00:00Z' }, { ...range, startAt: '2030-01-07T08:00:00' }])
      expectError(await call(owner, 'POST', 'availability/free-busy', { body }), 400, 'AVAILABILITY_INVALID_RANGE');
    expectError(await call(owner, 'POST', 'availability/suggest-slots', { body: { ...range, durationMinutes: 0 } }), 400, 'AVAILABILITY_INVALID_RANGE');
    const writes = await Promise.all(['UTC', 'Europe/Berlin'].map((timezone) => call(owner, 'PUT', 'availability/business-calendar', { body: { timezone, weekly, version: 1 } })));
    expect(writes.map((row) => row.status).sort()).toEqual([200, 409]);
    expectError(writes.find((row) => row.status === 409)!, 409, 'RESOURCE_VERSION_CONFLICT');
  });
  it('persists audit/configuration and rejects malformed or foreign schedule rows in PostgreSQL', async () => {
    const prisma = await db(), row = await prisma.businessCalendar.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } });
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: 'BUSINESS_CALENDAR.UPDATED' } })).toBeGreaterThan(0);
    await expect(prisma.businessCalendar.update({ where: { id: row.id }, data: { weekly: [{ dayOfWeek: 8, localStartTime: '09:00', localEndTime: '17:00' }], version: row.version + 1 } })).rejects.toThrow('AVAILABILITY_INVALID_RANGE');
    await expect(prisma.businessCalendar.update({ where: { id: row.id }, data: { holidays: ['2030-02-31'], version: row.version + 1 } })).rejects.toThrow('AVAILABILITY_INVALID_RANGE');
    await expect(prisma.businessCalendar.update({ where: { id: row.id }, data: { timezone: 'UTC', version: row.version } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    const now = new Date();
    await expect(prisma.userWorkingSchedule.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, userId: foreign.userId,
      timezone: 'UTC', weekly, holidays: [], overrides: [], createdAt: now, updatedAt: now } })).rejects.toMatchObject({ code: 'P2003' });
  });
});
