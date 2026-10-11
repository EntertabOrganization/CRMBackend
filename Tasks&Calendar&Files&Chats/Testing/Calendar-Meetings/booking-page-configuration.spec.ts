import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
const rules = { timezone: 'Europe/Berlin', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }],
  holidays: ['2030-01-01'], overrides: [{ date: '2030-01-02', windows: [] }], version: 0 };
async function setup() {
  const c = await collabApp(), calendars = c.collab.calendar.calendars, pages = c.collab.calendar.bookingPages;
  const calendar = calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Host', timezone: 'UTC' }));
  const input = { calendarId: calendar.id, title: 'Meet us', slug: 'meet-us', durationMinutes: 30 };
  return { c, pages, input };
}
describe('Booking page configuration and publication', () => {
  it('allows scoped creation for self and rejects creating for another Workspace member', async () => {
    const { c, pages, input } = await setup();
    const actor = await c.memberActor('own-page-creator', perms('OWN', 'calendar.read', 'calendar.create', 'booking_page.create', 'booking.read'));
    const calendar = c.collab.calendar.calendars.create(actor, b({ type: 'PERSONAL', name: 'Own', timezone: 'UTC' }));
    expect(pages.create(actor, b({ ...input, calendarId: calendar.id })).ownerUserId).toBe(actor.user.id);
    await expectAppError(() => pages.create(actor, b({ ...input, calendarId: calendar.id, slug: 'another-host', ownerUserId: c.owner.user.id })), 'BOOKING_PAGE_NOT_FOUND', 404);
  });
  it('rejects publication when the target Calendar has become inactive', async () => {
    const { c, pages, input } = await setup(), page = pages.create(c.owner, b(input));
    pages.setRules(c.owner, page.id, b(rules));
    c.collab.calendar.calendars.update(c.owner, input.calendarId, b({ isActive: false, version: 1 }));
    await expectAppError(() => pages.publication(c.owner, page.id, b({ version: 2 }), true), 'BOOKING_PAGE_INVALID', 409);
    expect(page.status).toBe('DRAFT');
  });
  it('creates a draft with mandatory guest identity and explicit defaults', async () => {
    const { c, pages, input } = await setup(); const page = pages.create(c.owner, b(input));
    expect(page).toMatchObject({ ownerUserId: c.owner.user.id, status: 'DRAFT', bookingMode: 'AUTO_CONFIRM', requireName: true, requireEmail: true,
      requirePhone: false, maxAdvanceDays: 90, minNoticeMinutes: 0, timezonePolicy: 'HOST', timezone: 'UTC', version: 1 });
    expect(pages.list(c.owner, new URLSearchParams()).data).toHaveLength(1);
  });
  it('requires configured rules before publication and versions page/rules independently', async () => {
    const { c, pages, input } = await setup(), page = pages.create(c.owner, b(input));
    await expectAppError(() => pages.publication(c.owner, page.id, b({ version: 1 }), true), 'BOOKING_PAGE_INVALID', 400);
    expect(page.status).toBe('DRAFT'); expect(page.version).toBe(1);
    const saved = pages.setRules(c.owner, page.id, b(rules));
    expect(saved.version).toBe(1); expect(page.version).toBe(2);
    expect(pages.publication(c.owner, page.id, b({ version: 2 }), true).status).toBe('PUBLISHED');
    expect(pages.publication(c.owner, page.id, b({ version: 3 }), true).version).toBe(3);
    expect(pages.publication(c.owner, page.id, b({ version: 3 }), false).status).toBe('UNPUBLISHED');
  });
  it('preserves patch values and resets optional fields on full replacement', async () => {
    const { c, pages, input } = await setup(), page = pages.create(c.owner, b({ ...input, requirePhone: true, bookingMode: 'REQUIRE_APPROVAL', bufferAfterMinutes: 15 }));
    pages.update(c.owner, page.id, b({ title: 'Changed', version: 1 })); expect(page.requirePhone).toBe(true);
    pages.update(c.owner, page.id, b({ ...input, version: 2 }), true);
    expect(page).toMatchObject({ requirePhone: false, bookingMode: 'AUTO_CONFIRM', bufferAfterMinutes: 0 });
    await expectAppError(() => pages.update(c.owner, page.id, b({ title: 'Stale', version: 2 })), 'RESOURCE_VERSION_CONFLICT', 409);
  });
  it('rejects invalid values, resource links and duplicate public slugs without mutations', async () => {
    const { c, pages, input } = await setup();
    for (const body of [{ ...input, slug: 'Bad Slug' }, { ...input, durationMinutes: 0 }, { ...input, requireEmail: false }, { ...input, bufferBeforeMinutes: -1 }, { ...input, timezone: 'Invalid/Zone' }])
      expect(() => pages.create(c.owner, b(body))).toThrow();
    expect(c.state.calendarBookingPages).toHaveLength(0);
    pages.create(c.owner, b(input));
    await expectAppError(() => pages.create(c.owner, b(input)), 'BOOKING_PAGE_SLUG_CONFLICT', 409);
    expect(c.state.calendarBookingPages).toHaveLength(1);
  });
  it('applies scoped actions to every read, write and rule/publication operation', async () => {
    const { c, pages, input } = await setup();
    const own = await c.memberActor('own-pages', perms('OWN', 'booking.read', 'booking_page.update', 'booking_page.publish'));
    const page = pages.create(c.owner, b(input));
    expect(pages.list(own, new URLSearchParams()).data).toEqual([]);
    for (const action of [() => pages.get(own, page.id), () => pages.update(own, page.id, b({ title: 'No', version: 1 })),
      () => pages.remove(own, page.id), () => pages.rules(own, page.id), () => pages.setRules(own, page.id, b(rules)),
      () => pages.publication(own, page.id, b({ version: 1 }), true), () => pages.publication(own, page.id, b({ version: 1 }), false)])
      await expectAppError(action, 'BOOKING_PAGE_NOT_FOUND', 404);
  });
  it('hides foreign pages and owners and preserves deleted public addresses', async () => {
    const { c, pages, input } = await setup(), page = pages.create(c.owner, b(input)), foreign = await c.foreignActor();
    await expectAppError(() => pages.get(foreign, page.id), 'BOOKING_PAGE_NOT_FOUND', 404);
    await expectAppError(() => pages.create(c.owner, b({ ...input, slug: 'foreign-owner', ownerUserId: foreign.user.id })), 'BOOKING_PAGE_NOT_FOUND', 404);
    pages.remove(c.owner, page.id);
    await expectAppError(() => pages.get(c.owner, page.id), 'BOOKING_PAGE_NOT_FOUND', 404);
    await expectAppError(() => pages.create(c.owner, b(input)), 'BOOKING_PAGE_SLUG_CONFLICT', 409);
  });
  it('validates availability rules before changing either row and audits the actual rule data', async () => {
    const { c, pages, input } = await setup(), page = pages.create(c.owner, b(input));
    await expectAppError(() => pages.setRules(c.owner, page.id, b({ ...rules, overrides: [{ date: '2030-02-31', windows: [] }] })), 'AVAILABILITY_INVALID_RANGE', 400);
    expect(page.version).toBe(1); expect(pages.rules(c.owner, page.id)).toBeNull();
    const saved = pages.setRules(c.owner, page.id, b(rules));
    await expectAppError(() => pages.setRules(c.owner, page.id, b(rules)), 'RESOURCE_VERSION_CONFLICT', 409);
    expect(c.state.auditLogs.find((row) => row.action === 'BOOKING_PAGE.RULES_UPDATED')?.afterData).toMatchObject({ weekly: saved.weekly, holidays: saved.holidays });
    expect(c.state.outboxEvents.filter((row) => row.entityId === page.id).map((row) => row.eventType)).toContain('BOOKING_PAGE_RULES_UPDATED');
  });
});
