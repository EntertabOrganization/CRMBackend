import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { WithStatus } from '@/src/server/collab/http';
import { b, collabApp, perms } from '../support/domain';
async function setup(mode: 'AUTO_CONFIRM' | 'REQUIRE_APPROVAL' = 'AUTO_CONFIRM') {
  const c = await collabApp(), cal = c.collab.calendar;
  jest.spyOn(c.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
  const container = cal.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Host', timezone: 'UTC' }));
  const page = cal.bookingPages.create(c.owner, b({ calendarId: container.id, title: 'Meet host', slug: 'meet-host', durationMinutes: 30, bookingMode: mode }));
  cal.bookingPages.setRules(c.owner, page.id, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 }));
  cal.bookingPages.publication(c.owner, page.id, b({ version: 2 }), true);
  const input = { guestName: 'Guest', guestEmail: 'guest@example.com', startAt: '2030-01-07T09:00:00Z', clientRequestId: randomUUID() };
  const create = () => { const result = cal.bookings.create(page.slug, b(input)); if (result instanceof WithStatus) throw new Error('Unexpected pending coverage'); return result; };
  return { c, cal, page, input, svc: cal.bookings, create };
}
afterEach(() => jest.restoreAllMocks());
describe('Booking Pages & Bookings Specification contract', () => {
  it('Concurrent same-slot booking.', async () => {
    const { svc, page, input, c } = await setup();
    const results = await Promise.allSettled([Promise.resolve().then(() => svc.create(page.slug, b(input))),
      Promise.resolve().then(() => svc.create(page.slug, b({ ...input, clientRequestId: randomUUID() })))]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((row) => row.status === 'rejected')).toMatchObject({ reason: { code: 'BOOKING_SLOT_UNAVAILABLE' } });
    expect(c.state.calendarBookings).toHaveLength(1); expect(c.state.calendarEvents).toHaveLength(1);
  });
  it('Public token replay.', async () => {
    const { svc, input, c, create } = await setup(), receipt = create();
    await expectAppError(() => svc.publicCancel(receipt.bookingId, b()), 'BOOKING_TOKEN_INVALID', 404);
    await expectAppError(() => svc.publicCancel(receipt.rescheduleToken!, b()), 'BOOKING_TOKEN_INVALID', 404);
    const moved = svc.publicReschedule(receipt.rescheduleToken!, b({ startAt: '2030-01-07T10:00:00Z' }));
    if (moved instanceof WithStatus) throw new Error('Unexpected pending coverage');
    expect(moved.cancellationToken).not.toBe(receipt.cancellationToken);
    await expectAppError(() => svc.publicCancel(receipt.cancellationToken!, b()), 'BOOKING_TOKEN_INVALID', 404);
    await expectAppError(() => svc.publicReschedule(receipt.rescheduleToken!, b({ startAt: input.startAt })), 'BOOKING_TOKEN_INVALID', 404);
    svc.publicCancel(moved.cancellationToken!, b());
    await expectAppError(() => svc.publicCancel(moved.cancellationToken!, b()), 'BOOKING_TOKEN_INVALID', 404);
    expect(c.state.calendarBookings[0]).toMatchObject({ status: 'CANCELLED', cancellationTokenHash: null, rescheduleTokenHash: null });
    expect(c.state.calendarEvents[0].status).toBe('CANCELLED');
  });
  it('Retry same idempotency key.', async () => {
    const { svc, page, input, c, create } = await setup(), receipt = create();
    expect(svc.create(page.slug, b({ ...input, guestEmail: 'GUEST@example.com', startAt: '2030-01-07T11:00:00+02:00' }))).toEqual(receipt);
    expect(c.state.calendarBookings).toHaveLength(1); expect(c.state.calendarEvents).toHaveLength(1);
    await expectAppError(() => svc.create(page.slug, b({ ...input, guestName: 'Changed' })), 'BOOKING_IDEMPOTENCY_CONFLICT', 409);
  });
  it('Approval vs auto-confirm.', async () => {
    const auto = await setup(), pending = await setup('REQUIRE_APPROVAL');
    expect(auto.create().status).toBe('CONFIRMED'); expect(auto.c.state.calendarExternalGuests[0].response).toBe('ACCEPTED');
    const requested = pending.create(); expect(requested.status).toBe('PENDING'); expect(pending.c.state.calendarEvents).toHaveLength(0);
    const approver = await pending.c.memberActor('approver', perms('WORKSPACE', 'booking.approve'));
    const result = pending.svc.approve(approver, requested.bookingId, b({ version: 1 }));
    if (result instanceof WithStatus) throw new Error('Unexpected pending coverage');
    expect(result.status).toBe('CONFIRMED'); expect(pending.c.state.calendarEvents).toHaveLength(1);
    expect(pending.c.state.calendarEventHistory[0].actorUserId).toBe(approver.user.id);
  });
  it('keeps raw capabilities and fingerprints out of audit/outbox and protected reads', async () => {
    const { svc, c, create } = await setup(), receipt = create();
    const text = JSON.stringify([c.state.auditLogs, c.state.outboxEvents, svc.get(c.owner, receipt.bookingId)]);
    for (const value of [receipt.cancellationToken, receipt.rescheduleToken, c.state.calendarBookings[0].tokenNonce, c.state.calendarBookings[0].requestHash]) expect(text).not.toContain(value);
    expect(c.state.auditLogs.find((row) => row.action === 'BOOKING.CREATED')?.actorUserId).toBeNull();
  });
  it('rejects invalid identity, dates, keys and fields before mutations', async () => {
    const { svc, page, input, c } = await setup();
    for (const patch of [{ workspaceId: c.owner.workspaceId }, { guestEmail: 'invalid' }, { guestName: '' }, { clientRequestId: null }, { startAt: '2030-02-31T09:00:00Z' }]) expect(() => svc.create(page.slug, b({ ...input, ...patch }))).toThrow();
    expect(c.state.calendarBookings).toHaveLength(0); expect(c.state.calendarEvents).toHaveLength(0);
  });
  it('enforces scoped mutation authority and versions', async () => {
    const { svc, c, create } = await setup('REQUIRE_APPROVAL'), receipt = create();
    const own = await c.memberActor('own-approver', perms('OWN', 'booking.approve', 'booking.cancel', 'booking.update')), foreign = await c.foreignActor();
    for (const actor of [own, foreign]) for (const action of [() => svc.approve(actor, receipt.bookingId, b({ version: 1 })), () => svc.cancel(actor, receipt.bookingId, b({ version: 1 })), () => svc.reschedule(actor, receipt.bookingId, b({ version: 1, startAt: '2030-01-07T10:00:00Z' }))]) await expectAppError(action, 'BOOKING_NOT_FOUND', 404);
    await expectAppError(() => svc.approve(c.owner, receipt.bookingId, b({ version: 0 })), 'RESOURCE_VERSION_CONFLICT', 409);
    expect(c.state.calendarBookings[0].status).toBe('PENDING');
  });
  it('rejects pending requests, prevents resurrection and guards Booking-managed Event changes', async () => {
    const pending = await setup('REQUIRE_APPROVAL'), receipt = pending.create();
    expect(pending.svc.cancel(pending.c.owner, receipt.bookingId, b({ version: 1 }), true).status).toBe('CANCELLED');
    await expectAppError(() => pending.svc.approve(pending.c.owner, receipt.bookingId, b({ version: 2 })), 'BOOKING_STATE_INVALID', 409);
    const auto = await setup(), confirmed = auto.create(), event = auto.c.state.calendarEvents[0];
    await expectAppError(() => auto.cal.events.update(auto.c.owner, event.id, b({ startAt: '2030-01-07T10:00:00Z', endAt: '2030-01-07T10:30:00Z', version: 1 })), 'BOOKING_EVENT_MANAGED', 409);
    await expectAppError(() => auto.cal.events.cancel(auto.c.owner, event.id, b({ version: 1 })), 'BOOKING_EVENT_MANAGED', 409);
    expect(auto.svc.cancel(auto.c.owner, confirmed.bookingId, b({ version: 1 })).status).toBe('CANCELLED');
    expect(event.status).toBe('CANCELLED');
  });
});
