import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
afterEach(() => jest.restoreAllMocks());
async function setup(mode = 'AUTO_CONFIRM') {
  const c = await collabApp(), calendar = c.collab.calendar;
  jest.spyOn(c.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
  const attendee = await c.memberActor('selected-attendee', perms('WORKSPACE', 'calendar.read', 'calendar.create', 'event.create', 'event.read', 'calendar.free_busy'));
  const resource = calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'Selected room', timezone: 'UTC', capacity: 3 }));
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Host', timezone: 'UTC' }));
  const page = calendar.bookingPages.create(c.owner, b({ calendarId: container.id, title: 'Meeting', slug: 'selected-meeting', durationMinutes: 30,
    attendeeUserIds: [attendee.user.id], resourceIds: [resource.id], bookingMode: mode, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }));
  calendar.bookingPages.setRules(c.owner, page.id, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 }));
  calendar.bookingPages.publication(c.owner, page.id, b({ version: 2 }), true);
  const input = { guestName: 'Guest', guestEmail: 'guest@example.com', startAt: '2030-01-07T10:00:00Z', clientRequestId: randomUUID() };
  return { ...c, calendar, attendee, resource, container, page, input };
}
describe('Configured Booking attendees and resources', () => {
  it('rejects publication after a selected attendee loses Workspace eligibility', async () => {
    const c = await setup();
    c.calendar.bookingPages.publication(c.owner, c.page.id, b({ version: 3 }), false);
    c.state.workspaceMemberships.find(row => row.workspaceId === c.owner.workspaceId && row.userId === c.attendee.user.id)!.status = 'SUSPENDED';
    await expectAppError(() => c.calendar.bookingPages.publication(c.owner, c.page.id, b({ version: 4 }), true), 'AVAILABILITY_SUBJECT_NOT_FOUND', 404);
    expect(c.page.status).toBe('UNPUBLISHED');
    expect(c.page.version).toBe(4);
  });

  it('confirms a snapshot roster, reserves its room and moves both through public rescheduling', async () => {
    const c = await setup(), receipt = c.calendar.bookings.create(c.page.slug, b(c.input)) as any;
    const booking = c.state.calendarBookings.find(row => row.id === receipt.bookingId)!;
    expect(booking.attendeeUserIds).toEqual([c.attendee.user.id]); expect(booking.resourceIds).toEqual([c.resource.id]);
    expect(c.state.calendarEventAttendees.filter(row => row.eventId === booking.eventId)).toHaveLength(2);
    const resourceBooking = c.state.calendarResourceBookings.find(row => row.eventId === booking.eventId)!;
    expect(resourceBooking.status).toBe('ACTIVE');
    c.calendar.bookingPages.update(c.owner, c.page.id, b({ attendeeUserIds: [], resourceIds: [], version: 3 }));
    c.calendar.bookings.publicReschedule(receipt.rescheduleToken, b({ startAt: '2030-01-07T11:00:00Z' }));
    expect(resourceBooking.startAt).toEqual(new Date('2030-01-07T11:00:00Z'));
    expect(booking.attendeeUserIds).toEqual([c.attendee.user.id]);
    const userBusy = c.calendar.availability.freeBusy(c.owner, b({ startAt: '2030-01-07T10:30:00Z', endAt: '2030-01-07T12:00:00Z', userIds: [c.attendee.user.id] }));
    expect(userBusy.users[0].busy).toEqual([{ startAt: new Date('2030-01-07T10:45:00Z'), endAt: new Date('2030-01-07T11:45:00Z'), state: 'BUSY' }]);
  });

  it('holds selected subjects while pending and releases every subject on rejection', async () => {
    const c = await setup('REQUIRE_APPROVAL'), receipt = c.calendar.bookings.create(c.page.slug, b(c.input)) as any;
    expect(c.state.calendarResourceBookings).toHaveLength(0);
    const container = c.calendar.calendars.create(c.attendee, b({ type: 'PERSONAL', name: 'Attendee', timezone: 'UTC' }));
    await expectAppError(() => c.calendar.events.create(c.attendee, b({ calendarId: container.id, title: 'Conflict',
      startAt: '2030-01-07T09:45:00Z', endAt: '2030-01-07T10:00:00Z' })), 'BOOKING_SLOT_UNAVAILABLE', 409);
    expect(c.calendar.resources.availability(c.owner, c.resource.id, new URLSearchParams({ startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T12:00:00Z' })).busy).toHaveLength(1);
    c.calendar.bookings.cancel(c.owner, receipt.bookingId, b({ version: 1 }), true);
    expect(c.calendar.resources.availability(c.owner, c.resource.id, new URLSearchParams({ startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T12:00:00Z' })).busy).toEqual([]);
  });

  it('intersects attendee working hours and rejects configured resources with insufficient capacity', async () => {
    const c = await setup();
    c.calendar.schedules.setUser(c.owner, c.attendee.user.id, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '12:00', localEndTime: '15:00' }], version: 0 }));
    const slots = c.calendar.bookingPublic.slots(c.page.slug, new URLSearchParams({ startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T17:00:00Z' }));
    expect(slots.slots[0].startAt).toEqual(new Date('2030-01-07T12:15:00Z'));
    await expectAppError(() => c.calendar.bookings.create(c.page.slug, b(c.input)), 'BOOKING_SLOT_UNAVAILABLE', 409);
    c.calendar.resources.update(c.owner, c.resource.id, b({ capacity: 2, version: 1 }));
    await expectAppError(() => c.calendar.bookingPages.publicView(c.page.slug), 'BOOKING_PAGE_NOT_FOUND', 404);
    expect(JSON.stringify(slots)).not.toMatch(/attendeeUserIds|resourceIds|workspaceId|Selected/);
  });

  it('rechecks live attendee eligibility but permits cancellation after revocation', async () => {
    const c = await setup(), receipt = c.calendar.bookings.create(c.page.slug, b(c.input)) as any;
    c.state.workspaceMemberships.find(row => row.workspaceId === c.owner.workspaceId && row.userId === c.attendee.user.id)!.status = 'SUSPENDED';
    await expectAppError(() => c.calendar.bookingPublic.slots(c.page.slug, new URLSearchParams({ startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T12:00:00Z' })), 'BOOKING_PAGE_NOT_FOUND', 404);
    c.calendar.bookings.publicCancel(receipt.cancellationToken, b());
    expect(c.state.calendarResourceBookings.every(row => row.status === 'CANCELLED')).toBe(true);
  });
});
