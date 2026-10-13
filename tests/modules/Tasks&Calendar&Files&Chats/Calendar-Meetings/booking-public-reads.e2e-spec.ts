import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { resetRateLimits } from '@/src/server/rate-limit';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, foreign: Session;
let clock: jest.SpyInstance;
const range = { startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T18:00:00Z' };
const template = '/api/v1/public/booking/[[...path]]';
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('public-booking-owner'); foreign = await register('public-booking-foreign');
  const { appContext } = await import('@/src/server/app-context');
  clock = jest.spyOn(appContext.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
});
afterAll(async () => { clock?.mockRestore(); resetRateLimits(); await disconnect(); });
async function setup() {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Private host calendar', timezone: 'UTC' } }));
  const page = expectOk(await call(owner, 'POST', 'booking-pages', { body: { calendarId: calendar.id, slug: 'public-' + randomUUID(), title: 'Public consultation', durationMinutes: 30 } }));
  expectOk(await call(owner, 'PUT', `booking-pages/${page.id}/rules`, { body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  return { calendar, page };
}
const publicRead = (slug: string, slots = false, extra: Record<string, string> = {}) => api('GET', template,
  { params: { path: slots ? [slug, 'slots'] : [slug] }, query: slots ? { ...range, ...extra } : undefined });
describe('Anonymous published Booking page and slot HTTP contracts', () => {
  it('exposes only configured fields after publication and hides drafts/missing/internal IDs identically', async () => {
    const c = await setup();
    for (const slug of [c.page.slug, c.page.id, 'missing-page']) expectError(await publicRead(slug), 404, 'BOOKING_PAGE_NOT_FOUND');
    expectOk(await call(owner, 'POST', `booking-pages/${c.page.id}/publish`, { body: { version: 2 } }));
    const result = expectOk(await publicRead(c.page.slug)); expect(result.title).toBe('Public consultation');
    expect(JSON.stringify(result)).not.toMatch(/ownerUserId|workspaceId|calendarId|Private host|email|createdBy/);
    expectOk(await call(owner, 'POST', `booking-pages/${c.page.id}/unpublish`, { body: { version: 3 } }));
    expectError(await publicRead(c.page.slug), 404, 'BOOKING_PAGE_NOT_FOUND');
    expectError(await publicRead(c.page.slug, true), 404, 'BOOKING_PAGE_NOT_FOUND');
  });
  it('returns private busy-safe slots, ignores client Workspace claims and rejects selected user IDs', async () => {
    const c = await setup();
    expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: c.calendar.id, title: 'Sensitive private customer', description: 'Confidential notes', startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T10:00:00Z' } }));
    expectOk(await call(owner, 'POST', `booking-pages/${c.page.id}/publish`, { body: { version: 2 } }));
    const result = expectOk(await api('GET', template, { workspaceId: foreign.workspaceId, token: foreign.token, params: { path: [c.page.slug, 'slots'] }, query: range }));
    expect(result.slots[0].startAt).toBe('2030-01-07T10:00:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(/Sensitive|Confidential|eventId|userId|workspaceId|calendarId/);
    expectError(await publicRead(c.page.slug, true, { userIds: foreign.userId }), 400, 'VALIDATION_ERROR');
    expectError(await publicRead(c.page.slug, true, { startAt: '2030-02-31T08:00:00Z' }), 400, 'AVAILABILITY_INVALID_RANGE');
  });
  it('persists pending recurrence work before exposing complete slots', async () => {
    const c = await setup();
    const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: c.calendar.id, title: 'Dense private', startAt: '2030-01-07T10:00:00Z', endAt: '2030-01-07T10:01:00Z' } }));
    expectOk(await call(owner, 'PUT', `calendar-events/${event.id}/recurrence`, { body: { rruleText: 'FREQ=SECONDLY;COUNT=3000', sourceTimezone: 'UTC', version: 0 } }));
    expectOk(await call(owner, 'POST', `booking-pages/${c.page.id}/publish`, { body: { version: 2 } }));
    expect(expectOk(await publicRead(c.page.slug, true), 202)).toMatchObject({ pending: true, slots: [] });
    expect(await (await db()).calendarAvailabilityRebuild.count({ where: { eventId: event.id } })).toBe(1);
    const { runCalendarAvailability } = await import('@/src/server/response'); await runCalendarAvailability(10);
    const result = expectOk(await publicRead(c.page.slug, true)); expect(result.pending).toBe(false);
    expect(result.slots.every((slot: { startAt: string; endAt: string }) => slot.endAt <= '2030-01-07T09:00:00.000Z' || slot.startAt >= '2030-01-07T11:00:00.000Z')).toBe(true);
  });
  it('rechecks host membership and rejects public reads after host suspension', async () => {
    const other = await register('public-suspended-host'), previous = owner; owner = other;
    try {
      const c = await setup(); expectOk(await call(owner, 'POST', `booking-pages/${c.page.id}/publish`, { body: { version: 2 } }));
      expectOk(await publicRead(c.page.slug));
      await (await db()).workspaceMembership.updateMany({ where: { workspaceId: owner.workspaceId, userId: owner.userId }, data: { status: 'SUSPENDED' } });
      expectError(await publicRead(c.page.slug), 404, 'BOOKING_PAGE_NOT_FOUND');
      expectError(await publicRead(c.page.slug, true), 404, 'BOOKING_PAGE_NOT_FOUND');
    } finally { owner = previous; }
  });
  it('rate limits anonymous reads before database work with the stable Booking error', async () => {
    resetRateLimits(); const headers = { 'x-forwarded-for': 'booking-client-' + randomUUID() };
    for (let i = 0; i < 60; i++) expectError(await api('GET', template, { headers, params: { path: ['missing-page'] } }), 404, 'BOOKING_PAGE_NOT_FOUND');
    expectError(await api('GET', template, { headers, params: { path: ['missing-page', 'slots'] }, query: range }), 429, 'BOOKING_RATE_LIMITED');
    resetRateLimits();
  });
});
