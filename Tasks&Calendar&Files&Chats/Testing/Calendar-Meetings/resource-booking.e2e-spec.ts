import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, foreign: Session;
beforeAll(async () => { await prepareCollabDatabase(); owner = await register('resource-owner'); foreign = await register('resource-foreign'); });
afterAll(disconnect);
async function setup() {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Rooms', timezone: 'UTC' } }));
  const event = async (startAt = '2030-01-01T09:00:00Z', endAt = '2030-01-01T10:00:00Z') => expectOk(await call(owner, 'POST', 'calendar-events', {
    body: { calendarId: calendar.id, title: 'Private resource meeting', startAt, endAt } }));
  const resource = expectOk(await call(owner, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Room', timezone: 'UTC', capacity: 2 } }));
  return { event, resource };
}
describe('Calendar resource HTTP/PostgreSQL contracts', () => {
  it('authorizes and tenant-scopes Event resource acquisition and release independently', async () => {
    const c = await setup(), event = await c.event(), booked = `calendar-events/${event.id}/resources`, release = `${booked}/${c.resource.id}`;
    const body = { resourceId: c.resource.id };
    for (const [method, path] of [['POST', booked], ['DELETE', release]] as const) {
      expectError(await call(null, method, path, { workspaceId: owner.workspaceId, body: method === 'POST' ? body : undefined }), 401, 'UNAUTHENTICATED');
      expectError(await call(foreign, method, path, { body: method === 'POST' ? body : undefined }), 404, 'EVENT_NOT_FOUND');
    }
    const reader = await member(owner, 'resource-book-reader', [['calendar.read', 'WORKSPACE'], ['event.read', 'WORKSPACE'], ['resource.read', 'WORKSPACE']]);
    const editor = await member(owner, 'resource-book-editor', [['calendar.read', 'WORKSPACE'], ['event.read', 'WORKSPACE'], ['event.update', 'WORKSPACE'], ['resource.read', 'WORKSPACE']]);
    expectOk(await call(owner, 'PUT', `calendars/${event.calendarId}/permissions`, { body: { version: 1,
      permissions: [{ subjectType: 'USER', subjectId: reader.userId, level: 'VIEW' }, { subjectType: 'USER', subjectId: editor.userId, level: 'EDIT_ALL' }] } }));
    for (const caller of [reader, editor]) {
      expectError(await call(caller, 'POST', booked, { body }), 403, 'PERMISSION_DENIED');
      expectError(await call(caller, 'DELETE', release), 403, 'PERMISSION_DENIED');
    }
    const remote = expectOk(await call(foreign, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Remote', timezone: 'UTC' } }));
    expectError(await call(owner, 'POST', booked, { body: { resourceId: remote.id } }), 404, 'RESOURCE_NOT_FOUND');
    expectError(await call(owner, 'DELETE', `${booked}/${remote.id}`), 404, 'RESOURCE_NOT_FOUND');
    expectOk(await call(owner, 'POST', booked, { body }));
    expectOk(await call(owner, 'DELETE', release));
  });

  it('enforces business working hours and rejects a stale acquisition after a schedule edit', async () => {
    const c = await setup(), event = await c.event(), prisma = await db();
    expectOk(await call(owner, 'PUT', 'availability/business-calendar', { body: { timezone: 'UTC', version: 0,
      weekly: [{ dayOfWeek: 2, localStartTime: '09:00', localEndTime: '17:00' }] } }));
    const outside = await c.event('2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z');
    expectError(await call(owner, 'POST', `calendar-events/${outside.id}/resources`, { body: { resourceId: c.resource.id } }), 409, 'RESOURCE_BOOKING_CONFLICT');
    const { appContext } = await import('@/src/server/app-context');
    const { hydrateState, persistState } = await import('@/src/server/persistence');
    await hydrateState(prisma, appContext.store.state); const before = structuredClone(appContext.store.state);
    const actor = appContext.access.actor(appContext.store.state.users.find(u => u.id === owner.userId)!, owner.workspaceId);
    appContext.collab.calendar.resources.book(actor, event.id, new (await import('@/src/server/collab/support')).Body({ resourceId: c.resource.id }));
    const after = structuredClone(appContext.store.state);
    const schedule = (await prisma.businessCalendar.findFirst({ where: { workspaceId: owner.workspaceId } }))!;
    await prisma.businessCalendar.update({ where: { id: schedule.id }, data: { weekly: [{ dayOfWeek: 2, localStartTime: '11:00', localEndTime: '17:00' }], version: schedule.version + 1 } });
    await expect(persistState(prisma, before, after)).rejects.toMatchObject({ code: 'RESOURCE_BOOKING_CONFLICT' });
    expect(await prisma.calendarResourceBooking.count({ where: { eventId: event.id } })).toBe(0);
    // This suite's later contracts use unrestricted hours; remove this isolated fixture policy.
    await prisma.businessCalendar.delete({ where: { id: schedule.id } });
  });
  it('persists CRUD, authorizes all routes and hides foreign IDs', async () => {
    const c = await setup(), path = `calendar-resources/${c.resource.id}`;
    expectOk(await call(owner, 'GET', 'calendar-resources')); expectOk(await call(owner, 'GET', path));
    const reader = await member(owner, 'resource-reader', [['resource.read', 'WORKSPACE']]);
    expectOk(await call(reader, 'GET', path));
    expectError(await call(reader, 'POST', 'calendar-resources', { body: { type: 'ROOM', name: 'Denied', timezone: 'UTC' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'PATCH', path, { body: { name: 'Denied', version: 1 } }), 403, 'PERMISSION_DENIED');
    expectError(await call(null, 'POST', 'calendar-resources', { workspaceId: owner.workspaceId, body: { type: 'ROOM', name: 'Denied', timezone: 'UTC' } }), 401, 'UNAUTHENTICATED');
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      expectError(await call(null, method, path, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
      expectError(await call(foreign, method, path, { body: method === 'GET' ? undefined : { version: 1 } }), 404, 'RESOURCE_NOT_FOUND');
    }
    expectOk(await call(owner, 'PATCH', path, { body: { version: 1, name: 'Updated' } }));
    expectError(await call(owner, 'PATCH', path, { body: { version: 1, name: 'Stale' } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectOk(await call(owner, 'PUT', path, { body: { type: 'EQUIPMENT', name: 'Projector', timezone: 'UTC', version: 2 } }));
    expectOk(await call(owner, 'DELETE', path));
    expect(await (await db()).calendarResource.findUnique({ where: { id: c.resource.id } })).toMatchObject({ isDeleted: true, version: 4 });
  });
  it('rejects racing exclusive bookings through HTTP and independently through database constraints', async () => {
    const c = await setup(), [one, two] = await Promise.all([c.event(), c.event()]);
    const responses = await Promise.all([one, two].map((event) => call(owner, 'POST', `calendar-events/${event.id}/resources`, { body: { resourceId: c.resource.id } })));
    expect(responses.map((row) => row.status).sort()).toEqual([200, 409]);
    expectError(responses.find((row) => row.status === 409)!, 409, 'RESOURCE_BOOKING_CONFLICT');
    const prisma = await db(), second = await setup(), [a, b] = await Promise.all([second.event(), second.event()]), now = new Date();
    const concurrent = await Promise.allSettled([a, b].map((event) => prisma.calendarResourceBooking.create({ data: {
      id: randomUUID(), workspaceId: owner.workspaceId, resourceId: second.resource.id, eventId: event.id,
      startAt: new Date(event.startAt), endAt: new Date(event.endAt), exclusive: false, status: 'ACTIVE', createdAt: now, updatedAt: now } })));
    expect(concurrent.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(String((concurrent.find((row) => row.status === 'rejected') as PromiseRejectedResult).reason)).toContain('calendar_resource_booking_exclusive');
  });
  it('updates reservations atomically with Event changes and cancels on resource disable', async () => {
    const c = await setup(), one = await c.event(), two = await c.event('2030-01-01T11:00:00Z', '2030-01-01T12:00:00Z'), prisma = await db();
    for (const event of [one, two]) expectOk(await call(owner, 'POST', `calendar-events/${event.id}/resources`, { body: { resourceId: c.resource.id } }));
    expectError(await call(owner, 'PATCH', `calendar-events/${one.id}`, { body: { startAt: two.startAt, endAt: two.endAt, version: 1 } }), 409, 'RESOURCE_BOOKING_CONFLICT');
    expect(await prisma.calendarEvent.findUnique({ where: { id: one.id } })).toMatchObject({ version: 1 });
    await expect(prisma.calendarEvent.update({ where: { id: one.id }, data: { startAt: new Date(two.startAt), endAt: new Date(two.endAt), version: 2 } })).rejects.toThrow('calendar_resource_booking_exclusive');
    expectOk(await call(owner, 'PATCH', `calendar-events/${one.id}`, { body: { startAt: '2030-01-01T08:00:00Z', endAt: '2030-01-01T09:00:00Z', version: 1 } }));
    expect(await prisma.calendarResourceBooking.findFirst({ where: { eventId: one.id } })).toMatchObject({ startAt: new Date('2030-01-01T08:00:00Z') });
    const availability = expectOk(await call(owner, 'GET', `calendar-resources/${c.resource.id}/availability`, { query: { startAt: '2030-01-01T00:00:00Z', endAt: '2030-01-02T00:00:00Z' } }));
    expect(JSON.stringify(availability)).not.toMatch(/Private|eventId|description/);
    expectOk(await call(owner, 'PATCH', `calendar-resources/${c.resource.id}`, { body: { isActive: false, version: 1 } }));
    expect(await prisma.calendarResourceBooking.count({ where: { resourceId: c.resource.id, status: 'ACTIVE' } })).toBe(0);
    expectError(await call(owner, 'POST', `calendar-events/${one.id}/resources`, { body: { resourceId: c.resource.id } }), 409, 'RESOURCE_INACTIVE');
  });
  it('rechecks attendee capacity in PostgreSQL, rejects cross-tenant links and preserves explicit cancellation evidence', async () => {
    const c = await setup(), event = await c.event(), prisma = await db();
    expectOk(await call(owner, 'PATCH', `calendar-resources/${c.resource.id}`, { body: { capacity: 1, version: 1 } }));
    const booking = expectOk(await call(owner, 'POST', `calendar-events/${event.id}/resources`, { body: { resourceId: c.resource.id } }));
    expectError(await call(owner, 'POST', `calendar-events/${event.id}/guests`, { body: { email: 'overflow@example.com' } }), 400, 'RESOURCE_CAPACITY_INVALID');
    expect(await prisma.calendarExternalGuest.count({ where: { eventId: event.id } })).toBe(0);
    await expect(prisma.calendarExternalGuest.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, eventId: event.id,
      email: 'raw-overflow@example.com', name: null, response: 'NEEDS_ACTION', removedAt: null, createdAt: new Date() } })).rejects.toThrow('RESOURCE_CAPACITY_INVALID');
    await expect(prisma.calendarResourceBooking.create({ data: { ...await prisma.calendarResourceBooking.findUniqueOrThrow({ where: { id: booking.id } }), id: randomUUID(), workspaceId: foreign.workspaceId } })).rejects.toThrow();
    expectOk(await call(owner, 'DELETE', `calendar-events/${event.id}/resources/${c.resource.id}`));
    expect(await prisma.calendarResourceBooking.findUnique({ where: { id: booking.id } })).toMatchObject({ status: 'CANCELLED' });
  });
  it('rechecks a resource disabled while the booking waits for its database lock', async () => {
    const c = await setup(), event = await c.event(), prisma = await db();
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), acquired = new Promise<void>((resolve) => { locked = resolve; });
    const disable = prisma.$transaction(async (tx) => {
      await tx.calendarResource.update({ where: { id: c.resource.id }, data: { isActive: false, version: 2 } });
      locked(); await gate;
    }, { timeout: 15_000 });
    await acquired;
    const now = new Date(), attempt = prisma.calendarResourceBooking.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId,
      resourceId: c.resource.id, eventId: event.id, startAt: new Date(event.startAt), endAt: new Date(event.endAt),
      exclusive: true, status: 'ACTIVE', createdAt: now, updatedAt: now } }).then(() => null, (error: unknown) => error);
    let observed = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT%calendar_resource_bookings%'`;
        if (Number(rows[0].count) > 0) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally { release(); }
    await disable; const error = await attempt;
    expect(observed).toBe(true); expect(String(error)).toContain('RESOURCE_INACTIVE');
    expect(await prisma.calendarResourceBooking.count({ where: { resourceId: c.resource.id } })).toBe(0);
  });
  it('serializes a new reservation with a concurrent Event move and keeps the persisted interval authoritative', async () => {
    const c = await setup(), event = await c.event(), prisma = await db();
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), acquired = new Promise<void>((resolve) => { locked = resolve; });
    const now = new Date(), id = randomUUID();
    const reserve = prisma.$transaction(async (tx) => {
      await tx.calendarResourceBooking.create({ data: { id, workspaceId: owner.workspaceId, resourceId: c.resource.id, eventId: event.id,
        startAt: new Date(event.startAt), endAt: new Date(event.endAt), exclusive: true, status: 'ACTIVE', createdAt: now, updatedAt: now } });
      locked(); await gate;
    }, { timeout: 15_000 });
    await acquired;
    const move = prisma.calendarEvent.update({ where: { id: event.id }, data: { startAt: new Date('2030-01-01T11:00:00Z'), endAt: new Date('2030-01-01T12:00:00Z'), version: 2 } }).then((row) => row, (error: unknown) => { throw error; });
    let observed = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE%calendar_events%'`;
        if (Number(rows[0].count) > 0) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally { release(); }
    await reserve; await move; expect(observed).toBe(true);
    expect(await prisma.calendarResourceBooking.findUnique({ where: { id } })).toMatchObject({ startAt: new Date('2030-01-01T11:00:00Z'), endAt: new Date('2030-01-01T12:00:00Z') });
  });
});
