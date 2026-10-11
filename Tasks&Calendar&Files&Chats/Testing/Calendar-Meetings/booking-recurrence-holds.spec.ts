import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp } from '../support/domain';
async function setup() {
  const c = await collabApp(), cal = c.collab.calendar;
  jest.spyOn(c.collab.support, 'now').mockReturnValue(new Date('2030-01-07T08:00:00Z'));
  const container = cal.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Host', timezone: 'UTC' }));
  const page = cal.bookingPages.create(c.owner, b({ calendarId: container.id, title: 'Booking', slug: 'recurrence-hold', durationMinutes: 30, bookingMode: 'REQUIRE_APPROVAL', bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }));
  cal.bookingPages.setRules(c.owner, page.id, b({ timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 }));
  cal.bookingPages.publication(c.owner, page.id, b({ version: 2 }), true);
  const reserve = () => cal.bookings.create(page.slug, b({ guestName: 'Guest', guestEmail: 'guest@example.com', startAt: '2030-01-07T10:00:00Z', clientRequestId: randomUUID() }));
  const event = (startAt = '2030-01-06T10:00:00Z', endAt = '2030-01-06T10:30:00Z') => {
    const view = cal.events.create(c.owner, b({ calendarId: container.id, title: 'Series', startAt, endAt }));
    return c.state.calendarEvents.find((row) => row.id === view.id)!;
  };
  return { ...c, get state() { return c.state; }, cal, reserve, event, container };
}
afterEach(() => jest.restoreAllMocks());
describe('Existing Booking holds constrain recurring Event edits', () => {
  it('rejects recurrence creation that crosses a pending hold without changing the live graph', async () => {
    const c = await setup(), event = c.event(); c.reserve();
    await expectAppError(() => c.cal.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'UTC', version: 0 }), true), 'BOOKING_SLOT_UNAVAILABLE', 409);
    expect(c.state.calendarRecurrenceRules).toHaveLength(0); expect(event.recurrenceRuleId).toBeNull(); expect(event.version).toBe(1);
  });
  it('checks changed rules, moved exceptions, future edits and buffer boundaries before mutation', async () => {
    const c = await setup(), event = c.event('2030-01-06T12:00:00Z', '2030-01-06T12:30:00Z');
    c.cal.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'UTC', version: 0 }), true); c.reserve();
    const identity = '2030-01-07T12:00:00.000';
    for (const action of [
      () => c.cal.recurrence.editOccurrence(c.owner, event.id, identity, b({ startAt: '2030-01-07T09:30:00Z', endAt: '2030-01-07T10:00:00Z', version: 1 })),
      () => c.cal.recurrence.editFuture(c.owner, event.id, b({ recurrenceId: identity, startAt: '2030-01-07T10:30:00Z', version: 1 })),
      () => c.cal.events.update(c.owner, event.id, b({ startAt: '2030-01-06T10:00:00Z', endAt: '2030-01-06T10:30:00Z', version: event.version })),
    ]) await expectAppError(action, 'BOOKING_SLOT_UNAVAILABLE', 409);
    expect(c.state.calendarRecurrenceExceptions).toHaveLength(0); expect(c.state.calendarRecurrenceRanges).toHaveLength(0);
    expect(c.state.calendarEvents).toHaveLength(1); expect(c.state.calendarRecurrenceRules[0].version).toBe(1);
    c.cal.recurrence.editOccurrence(c.owner, event.id, identity, b({ startAt: '2030-01-07T10:45:00Z', version: 1 }));
    expect(c.state.calendarRecurrenceExceptions).toHaveLength(1);
  });
  it('rejects restoring a busy series and adding a held host to a series, while permitting free occurrences', async () => {
    const c = await setup(), peer = await c.memberActor('series-organizer', [['event.read', 'OWN']]), event = c.event();
    c.cal.events.update(c.owner, event.id, b({ busyStatus: 'FREE', version: 1 }));
    c.cal.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'UTC', version: 0 }), true); c.reserve();
    await expectAppError(() => c.cal.events.update(c.owner, event.id, b({ busyStatus: 'BUSY', version: event.version })), 'BOOKING_SLOT_UNAVAILABLE', 409);
    const other = c.event();
    // Use a second live host to isolate the attendee access path from the organizer path.
    other.organizerUserId = peer.user.id;
    const organizer = c.state.calendarEventAttendees.find((row) => row.eventId === other.id && row.userId === c.owner.user.id)!; organizer.removedAt = new Date();
    c.cal.recurrence.update(c.owner, other.id, b({ rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'UTC', version: 0 }), true);
    await expectAppError(() => c.cal.events.addAttendees(c.owner, other.id, b({ userId: c.owner.user.id })), 'BOOKING_SLOT_UNAVAILABLE', 409);
    expect(organizer.removedAt).not.toBeNull();
  });
});
