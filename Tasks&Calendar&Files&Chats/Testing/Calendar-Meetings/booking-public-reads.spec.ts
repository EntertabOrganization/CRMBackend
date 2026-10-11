import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
const range = { startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T18:00:00Z' };
const query = (extra: Record<string, string> = {}) => new URLSearchParams({ ...range, ...extra });
async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  jest.spyOn(c.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Private host', timezone: 'UTC' }));
  const page = calendar.bookingPages.create(c.owner, b({ calendarId: container.id, title: 'Public meeting', slug: 'public-meeting', durationMinutes: 30 }));
  calendar.bookingPages.setRules(c.owner, page.id, b({ timezone: 'UTC', weekly: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, localStartTime: '09:00', localEndTime: '17:00' })), version: 0 }));
  calendar.bookingPages.publication(c.owner, page.id, b({ version: 2 }), true);
  return { c, calendar, page, container };
}
afterEach(() => jest.restoreAllMocks());
describe('Published booking pages and private open-slot projection', () => {
  it('withdraws public access after the host loses Calendar Event creation permission', async () => {
    const { c, calendar } = await setup();
    const host = await c.memberActor('published-host', perms('OWN', 'calendar.read', 'calendar.create', 'event.create', 'booking_page.create', 'booking_page.update', 'booking_page.publish'));
    const container = calendar.calendars.create(host, b({ type: 'PERSONAL', name: 'Host calendar', timezone: 'UTC' }));
    const page = calendar.bookingPages.create(host, b({ calendarId: container.id, title: 'Limited host', slug: 'limited-host', durationMinutes: 30 }));
    calendar.bookingPages.setRules(host, page.id, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 }));
    calendar.bookingPages.publication(host, page.id, b({ version: 2 }), true);
    expect(calendar.bookingPages.publicView(page.slug).title).toBe('Limited host');
    const eventCreate = c.state.permissions.find((row) => row.key === 'event.create')!.id;
    c.state.rolePermissions = c.state.rolePermissions.filter((row) => row.roleId !== host.role.id || row.permissionId !== eventCreate);
    await expectAppError(() => calendar.bookingPages.publicView(page.slug), 'BOOKING_PAGE_NOT_FOUND', 404);
  });
  it('uses rule timezone across DST and supports a validated invitee display timezone', async () => {
    const { c, calendar, page } = await setup();
    calendar.bookingPages.setRules(c.owner, page.id, b({ timezone: 'Europe/Berlin', weekly: [{ dayOfWeek: 7, localStartTime: '02:30', localEndTime: '04:00' }], version: 1 }));
    calendar.bookingPages.update(c.owner, page.id, b({ timezonePolicy: 'INVITEE', version: 4 }));
    const dst = query({ startAt: '2030-03-31T00:00:00Z', endAt: '2030-03-31T06:00:00Z', timezone: 'America/New_York' });
    expect(calendar.bookingPublic.slots(page.slug, dst).slots).toEqual([]);
    calendar.bookingPages.setRules(c.owner, page.id, b({ timezone: 'Europe/Berlin', weekly: [{ dayOfWeek: 7, localStartTime: '03:00', localEndTime: '05:00' }], version: 2 }));
    const result = calendar.bookingPublic.slots(page.slug, dst);
    expect(result.timezone).toBe('America/New_York'); expect(result.slots[0].startAt).toEqual(new Date('2030-03-31T01:00:00Z'));
  });
  it('tiles buffer-expanded maximum-length requests within recurrence rebuild range budgets', async () => {
    const { c, calendar, page } = await setup();
    calendar.bookingPages.update(c.owner, page.id, b({ bufferBeforeMinutes: 1440, bufferAfterMinutes: 1440, version: 3 }));
    const spy = jest.spyOn(calendar.availability, 'bookingSubjects');
    calendar.bookingPublic.slots(page.slug, query({ startAt: '2030-01-07T08:00:00Z', endAt: '2030-02-07T08:00:00Z' }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.every(([, , , range]) => range.endAt.getTime() - range.startAt.getTime() <= 31 * 86_400_000)).toBe(true);
  });
  it('returns only configured public fields and never accepts internal page IDs as a slug', async () => {
    const { calendar, page } = await setup(); const result = calendar.bookingPages.publicView(page.slug);
    expect(result).toMatchObject({ title: 'Public meeting', durationMinutes: 30, requireName: true, requireEmail: true });
    expect(JSON.stringify(result)).not.toMatch(/ownerUserId|calendarId|workspaceId|createdBy|Private host/);
    await expectAppError(() => calendar.bookingPages.publicView(page.id), 'BOOKING_PAGE_NOT_FOUND', 404);
  });
  it('hides drafts, unpublished pages, missing pages and disabled host Calendars identically', async () => {
    const { c, calendar, page, container } = await setup();
    calendar.bookingPages.publication(c.owner, page.id, b({ version: 3 }), false);
    for (const slug of [page.slug, 'missing']) await expectAppError(() => calendar.bookingPages.publicView(slug), 'BOOKING_PAGE_NOT_FOUND', 404);
    calendar.bookingPages.publication(c.owner, page.id, b({ version: 4 }), true);
    calendar.calendars.update(c.owner, container.id, b({ isActive: false, version: 1 }));
    await expectAppError(() => calendar.bookingPublic.slots(page.slug, query()), 'BOOKING_PAGE_NOT_FOUND', 404);
  });
  it('rechecks live host membership on every public request', async () => {
    const { c, calendar, page } = await setup();
    const membership = c.state.workspaceMemberships.find((row) => row.workspaceId === c.owner.workspaceId && row.userId === c.owner.user.id)!;
    membership.status = 'SUSPENDED';
    await expectAppError(() => calendar.bookingPages.publicView(page.slug), 'BOOKING_PAGE_NOT_FOUND', 404);
  });
  it('intersects page/business/user schedules and excludes private busy time plus buffers', async () => {
    const { c, calendar, page, container } = await setup();
    calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Private customer', description: 'Confidential', startAt: '2030-01-07T11:00:00Z', endAt: '2030-01-07T12:00:00Z' }));
    calendar.schedules.setBusiness(c.owner, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '10:00', localEndTime: '16:00' }], version: 0 }));
    calendar.bookingPages.update(c.owner, page.id, b({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15, version: 3 }));
    const result = calendar.bookingPublic.slots(page.slug, query({ limit: '100' }));
    expect(result.slots[0]).toEqual({ startAt: new Date('2030-01-07T10:15:00Z'), endAt: new Date('2030-01-07T10:45:00Z') });
    expect(result.slots[1].startAt).toEqual(new Date('2030-01-07T12:15:00Z'));
    expect(result.slots.at(-1)!.endAt).toEqual(new Date('2030-01-07T15:45:00Z'));
    expect(JSON.stringify(result)).not.toMatch(/Private|Confidential|userId|eventId|workspaceId/);
  });
  it('observes notice/advance bounds and validates all query input without client-selected identities', async () => {
    const { c, calendar, page } = await setup();
    calendar.bookingPages.update(c.owner, page.id, b({ minNoticeMinutes: 120, maxAdvanceDays: 1, version: 3 }));
    expect(calendar.bookingPublic.slots(page.slug, query()).slots[0].startAt).toEqual(new Date('2030-01-07T10:00:00Z'));
    expect(calendar.bookingPublic.slots(page.slug, query({ startAt: '2030-01-08T09:00:00Z', endAt: '2030-01-08T17:00:00Z' })).slots).toEqual([]);
    for (const extra of [{ startAt: '2030-02-31T08:00:00Z' }, { endAt: range.startAt }, { timezone: 'Invalid/Zone' }, { limit: '1.5' }])
      await expectAppError(() => calendar.bookingPublic.slots(page.slug, query(extra)), 'AVAILABILITY_INVALID_RANGE', 400);
    await expectAppError(() => calendar.bookingPublic.slots(page.slug, query({ userIds: c.owner.user.id })), 'VALIDATION_ERROR', 400);
  });
  it('reads busy Events outside the requested interval when their buffer blocks a slot', async () => {
    const { c, calendar, page, container } = await setup();
    calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Previous', startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T09:00:00Z' }));
    calendar.bookingPages.update(c.owner, page.id, b({ bufferBeforeMinutes: 15, version: 3 }));
    expect(calendar.bookingPublic.slots(page.slug, query({ startAt: '2030-01-07T09:00:00Z' })).slots[0].startAt).toEqual(new Date('2030-01-07T09:15:00Z'));
  });
  it('withholds partial slots during dense backfill and serves authoritative merged coverage afterwards', async () => {
    const { c, calendar, page, container } = await setup();
    const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Secret dense', startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T09:01:00Z' }));
    calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=SECONDLY;COUNT=3000', sourceTimezone: 'UTC', version: 0 }), true);
    expect(calendar.bookingPublic.slots(page.slug, query())).toMatchObject({ pending: true, slots: [] });
    for (let i = 0; i < 5; i++) calendar.availabilityRebuilds.runOne();
    const result = calendar.bookingPublic.slots(page.slug, query());
    expect(result.pending).toBe(false); expect(result.slots[0].startAt).toEqual(new Date('2030-01-07T10:00:00Z'));
  });
});
