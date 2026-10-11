import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, foreign: Session, denied: Session, own: Session;
const rules = { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], holidays: [], overrides: [], version: 0 };
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('booking-page-owner'); foreign = await register('booking-page-foreign');
  denied = await member(owner, 'booking-page-denied', [['calendar.read', 'WORKSPACE']]);
  own = await member(owner, 'booking-page-own', [['booking.read', 'OWN'], ['booking_page.update', 'OWN'], ['booking_page.publish', 'OWN']]);
});
afterAll(disconnect);
async function setup() {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Host', timezone: 'UTC' } }));
  const input = { calendarId: calendar.id, title: 'Meet host', slug: 'meet-' + randomUUID(), durationMinutes: 30 };
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: input }));
  return { input, page, path: 'booking-pages/' + page.id };
}
async function routes() {
  const c = await setup();
  return { c, requests: [ ['POST', 'booking-pages', c.input], ['GET', 'booking-pages', undefined], ['GET', c.path, undefined],
    ['PUT', c.path, { ...c.input, version: 1 }], ['PATCH', c.path, { title: 'No', version: 1 }], ['DELETE', c.path, undefined],
    ['POST', c.path + '/publish', { version: 1 }], ['POST', c.path + '/unpublish', { version: 1 }],
    ['GET', c.path + '/rules', undefined], ['PUT', c.path + '/rules', rules] ] as const };
}
describe('Booking page configuration HTTP/PostgreSQL contracts', () => {
  it('exposes all configuration, rules and publication routes with durable versions', async () => {
    const c = await setup();
    expect(expectOk(await call(owner, 'GET', 'booking-pages'))).toContainEqual(expect.objectContaining({ id: c.page.id }));
    expectOk(await call(owner, 'GET', c.path)); expect(expectOk(await call(owner, 'GET', c.path + '/rules'))).toBeNull();
    expectOk(await call(owner, 'PATCH', c.path, { body: { title: 'Updated host', requirePhone: true, version: 1 } }));
    expectOk(await call(owner, 'PUT', c.path, { body: { ...c.input, version: 2 } }));
    expectOk(await call(owner, 'PUT', c.path + '/rules', { body: rules }));
    expect(expectOk(await call(owner, 'GET', c.path + '/rules')).weekly).toEqual(rules.weekly);
    expect(expectOk(await call(owner, 'POST', c.path + '/publish', { body: { version: 4 } })).status).toBe('PUBLISHED');
    expect(expectOk(await call(owner, 'POST', c.path + '/unpublish', { body: { version: 5 } })).status).toBe('UNPUBLISHED');
    expectOk(await call(owner, 'DELETE', c.path)); expectError(await call(owner, 'GET', c.path), 404, 'BOOKING_PAGE_NOT_FOUND');
    expect(await (await db()).calendarBookingPage.findUniqueOrThrow({ where: { id: c.page.id } })).toMatchObject({ isDeleted: true, version: 7, requirePhone: false });
  });
  it('requires authentication and the scoped action on all ten routes', async () => {
    const { requests } = await routes();
    for (const [method, path, body] of requests) {
      expectError(await call(null, method, path, { body, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
      expectError(await call(denied, method, path, { body }), 403, 'PERMISSION_DENIED');
      if (path !== 'booking-pages') expectError(await call(own, method, path, { body }), 404, 'BOOKING_PAGE_NOT_FOUND');
    }
    expect(expectOk(await call(own, 'GET', 'booking-pages'))).toEqual([]);
  });
  it('hides foreign IDs on every route and rejects foreign owner/Calendar links', async () => {
    const { c, requests } = await routes();
    for (const [method, path, body] of requests.filter(([, path]) => path !== 'booking-pages'))
      expectError(await call(foreign, method, path, { body }), 404, 'BOOKING_PAGE_NOT_FOUND');
    expect(expectOk(await call(foreign, 'GET', 'booking-pages'))).toEqual([]);
    expectError(await call(foreign, 'POST', 'booking-pages', { body: { ...c.input, slug: 'foreign-' + randomUUID() } }), 404, 'CALENDAR_NOT_FOUND');
    expectError(await call(owner, 'POST', 'booking-pages', { body: { ...c.input, slug: 'owner-' + randomUUID(), ownerUserId: foreign.userId } }), 404, 'BOOKING_PAGE_NOT_FOUND');
    const other = expectOk(await call(foreign, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Foreign', timezone: 'UTC' } }));
    expectError(await call(owner, 'PATCH', c.path, { body: { calendarId: other.id, version: 1 } }), 404, 'CALENDAR_NOT_FOUND');
  });
  it('returns stable errors, prevents duplicate addresses and fences concurrent configuration/rule edits', async () => {
    const c = await setup();
    expectError(await call(owner, 'POST', c.path + '/publish', { body: { version: 1 } }), 400, 'BOOKING_PAGE_INVALID');
    expectError(await call(owner, 'PATCH', c.path, { body: { requireName: false, version: 1 } }), 400, 'BOOKING_PAGE_INVALID');
    expectError(await call(owner, 'PUT', c.path + '/rules', { body: { ...rules, timezone: 'Invalid/Timezone' } }), 400, 'AVAILABILITY_INVALID_RANGE');
    expectError(await call(owner, 'POST', 'booking-pages', { body: c.input }), 409, 'BOOKING_PAGE_SLUG_CONFLICT');
    const writes = await Promise.all(['First', 'Second'].map((title) => call(owner, 'PATCH', c.path, { body: { title, version: 1 } })));
    expect(writes.map((row) => row.status).sort()).toEqual([200, 409]);
    expectError(writes.find((row) => row.status === 409)!, 409, 'RESOURCE_VERSION_CONFLICT');
    const ruleWrites = await Promise.all([rules, { ...rules, timezone: 'Europe/Berlin' }].map((body) => call(owner, 'PUT', c.path + '/rules', { body })));
    expect(ruleWrites.map((row) => row.status).sort()).toEqual([200, 409]);
  });
  it('commits audit/outbox and enforces tenant, version and rule constraints independently in PostgreSQL', async () => {
    const c = await setup(); expectOk(await call(owner, 'PUT', c.path + '/rules', { body: rules }));
    const prisma = await db(), row = await prisma.calendarBookingPage.findUniqueOrThrow({ where: { id: c.page.id } });
    const config = await prisma.calendarBookingPageRules.findUniqueOrThrow({ where: { pageId: row.id } });
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: 'BOOKING_PAGE.CREATED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: 'BOOKING_PAGE.RULES_UPDATED' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { entityId: row.id, eventType: 'BOOKING_PAGE_CREATED' } })).toBe(1);
    await expect(prisma.calendarBookingPage.update({ where: { id: row.id }, data: { title: 'Stale', version: row.version } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.calendarBookingPage.update({ where: { id: row.id }, data: { ownerUserId: foreign.userId, version: row.version + 1 } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.calendarBookingPageRules.update({ where: { id: config.id }, data: { weekly: [{ dayOfWeek: 9, localStartTime: '09:00', localEndTime: '17:00' }], version: 2 } })).rejects.toThrow('AVAILABILITY_INVALID_RANGE');
    await expect(prisma.calendarBookingPage.update({ where: { id: row.id }, data: { timezone: 'Invalid/Timezone', version: row.version + 1 } })).rejects.toThrow('BOOKING_PAGE_INVALID');
  });
});
