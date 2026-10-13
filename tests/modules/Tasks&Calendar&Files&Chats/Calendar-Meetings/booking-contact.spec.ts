import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { WithStatus } from '@/src/server/collab/http';
import { b, collabApp, perms } from '../support/domain';

async function fixture(mode: 'AUTO_CONFIRM' | 'REQUIRE_APPROVAL' = 'AUTO_CONFIRM') {
  const c = await collabApp(), cal = c.collab.calendar;
  jest.spyOn(c.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
  const calendar = cal.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Contacts', timezone: 'UTC' }));
  const page = cal.bookingPages.create(c.owner, b({ calendarId: calendar.id, title: 'Contact meeting', slug: 'contact-meeting', durationMinutes: 30, bookingMode: mode }));
  cal.bookingPages.setRules(c.owner, page.id, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 }));
  cal.bookingPages.publication(c.owner, page.id, b({ version: 2 }), true);
  const input = { guestName: 'Original', guestEmail: 'original@example.com', guestPhone: '123', startAt: '2030-01-07T09:00:00Z', clientRequestId: randomUUID() };
  const receipt = cal.bookings.create(page.slug, b(input));
  if (receipt instanceof WithStatus) throw new Error('Unexpected queued availability');
  const row = c.state.calendarBookings[0];
  return { c, cal, page, input, receipt, row, svc: cal.bookings };
}
afterEach(() => jest.restoreAllMocks());

it('edits only supplied contact fields under Booking authority while preserving reservation identity and times', async () => {
  const f = await fixture(), editor = await f.c.memberActor('contact-editor', perms('WORKSPACE', 'booking.update'));
  const before = structuredClone(f.row), guestId = f.c.state.calendarExternalGuests[0].id;
  const result = f.svc.update(editor, f.row.id, b({ guestName: 'Changed', guestPhone: null, version: 1 }));
  expect(result).toMatchObject({ guestName: 'Changed', guestEmail: before.guestEmail, guestPhone: null, version: 2 });
  for (const key of ['startAt', 'endAt', 'reservedStartAt', 'reservedEndAt', 'eventId', 'requestHash', 'idempotencyKey', 'tokenGeneration'] as const)
    expect(f.row[key]).toEqual(before[key]);
  expect(f.c.state.calendarExternalGuests[0]).toMatchObject({ id: guestId, name: 'Changed', email: before.guestEmail });
  expect(f.c.state.calendarEventHistory.at(-1)).toMatchObject({ actorUserId: editor.user.id, action: 'CALENDAR_EVENT_UPDATED' });
  expect(f.c.state.outboxEvents.some(row => row.eventType === 'BOOKING_UPDATED' && row.entityId === f.row.id)).toBe(true);
  expect(result).not.toHaveProperty('publicReceiptRevoked');
});

it('rotates guest capabilities and permanently denies capability recovery through the original public request', async () => {
  const f = await fixture();
  f.svc.update(f.c.owner, f.row.id, b({ guestEmail: 'NEW@example.com', version: 1 }));
  expect(f.row).toMatchObject({ guestEmail: 'new@example.com', publicReceiptRevoked: true, tokenGeneration: 2 });
  await expectAppError(() => f.svc.publicCancel(f.receipt.cancellationToken!, b()), 'BOOKING_TOKEN_INVALID', 404);
  await expectAppError(() => f.svc.publicReschedule(f.receipt.rescheduleToken!, b({ startAt: '2030-01-07T10:00:00Z' })), 'BOOKING_TOKEN_INVALID', 404);
  expect(f.svc.create(f.page.slug, b(f.input))).toMatchObject({ cancellationToken: null, rescheduleToken: null });
  f.svc.reschedule(f.c.owner, f.row.id, b({ startAt: '2030-01-07T10:00:00Z', version: 2 }));
  expect(f.svc.create(f.page.slug, b(f.input))).toMatchObject({ cancellationToken: null, rescheduleToken: null });
});

it('requires update permission, host scope and tenant authority before validating private fields', async () => {
  const f = await fixture(), own = await f.c.memberActor('contact-own', perms('OWN', 'booking.update'));
  const denied = await f.c.memberActor('contact-denied', perms('WORKSPACE', 'booking.read')), foreign = await f.c.foreignActor();
  await expectAppError(() => f.svc.update(denied, f.row.id, b({ status: 'CANCELLED' })), 'PERMISSION_DENIED', 403);
  for (const actor of [own, foreign]) await expectAppError(() => f.svc.update(actor, f.row.id, b({ version: 1 })), 'BOOKING_NOT_FOUND', 404);
});

it('rejects stale, invalid and lifecycle writes without changing either contact record', async () => {
  const f = await fixture(), before = structuredClone(f.c.state.calendarExternalGuests);
  await expectAppError(() => f.svc.update(f.c.owner, f.row.id, b({ guestName: 'Stale', version: 0 })), 'RESOURCE_VERSION_CONFLICT', 409);
  for (const fields of [{ guestName: null }, { guestName: '' }, { guestEmail: 'bad' }, { guestPhone: 'x'.repeat(51) },
    { startAt: '2030-01-07T10:00:00Z' }, { status: 'CANCELLED' }, { ownerUserId: randomUUID() }, { publicReceiptRevoked: false }])
    await expectAppError(() => f.svc.update(f.c.owner, f.row.id, b({ ...fields, version: 1 })), 'VALIDATION_ERROR', 400);
  expect(f.row.version).toBe(1); expect(f.c.state.calendarExternalGuests).toEqual(before);
  const count = f.c.state.outboxEvents.length;
  expect(f.svc.update(f.c.owner, f.row.id, b({ guestEmail: 'ORIGINAL@example.com', version: 1 })).version).toBe(1);
  expect(f.c.state.outboxEvents).toHaveLength(count);
  f.svc.cancel(f.c.owner, f.row.id, b({ version: 1 }));
  await expectAppError(() => f.svc.update(f.c.owner, f.row.id, b({ guestName: 'Late', version: 2 })), 'BOOKING_STATE_INVALID', 409);
});

it('edits pending contacts after unpublication and applies phone requirements on explicit phone edits', async () => {
  const f = await fixture('REQUIRE_APPROVAL');
  f.cal.bookingPages.publication(f.c.owner, f.page.id, b({ version: 3 }), false);
  f.c.state.calendarBookingPages[0].requirePhone = true;
  await expectAppError(() => f.svc.update(f.c.owner, f.row.id, b({ guestPhone: null, version: 1 })), 'VALIDATION_ERROR', 400);
  expect(f.svc.update(f.c.owner, f.row.id, b({ guestName: 'Pending change', version: 1 })).status).toBe('PENDING');
  expect(f.c.state.calendarEvents).toHaveLength(0);
});

it('fails closed on guest conflicts and token revision exhaustion before mutating contacts', async () => {
  const f = await fixture();
  f.cal.events.addGuest(f.c.owner, f.row.eventId!, b({ name: 'Other', email: 'other@example.com' }));
  await expectAppError(() => f.svc.update(f.c.owner, f.row.id, b({ guestEmail: 'other@example.com', version: 1 })), 'BOOKING_GUEST_CONFLICT', 409);
  f.row.tokenGeneration = 2147483647;
  await expectAppError(() => f.svc.update(f.c.owner, f.row.id, b({ guestEmail: 'new@example.com', version: 1 })), 'BOOKING_TOKEN_LIMIT', 409);
  expect(f.row.guestEmail).toBe('original@example.com'); expect(f.c.state.calendarExternalGuests[0].email).toBe('original@example.com');
});
