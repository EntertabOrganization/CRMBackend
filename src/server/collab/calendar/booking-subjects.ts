import type { DbState } from '../../store';
import type { CalendarBooking } from './booking-types';

/** Pending holds reserve the snapshot roster. Confirmed attendees release their
 * personal hold on removal or decline, while the organizer always retains it. */
export function bookingUserIds(state: DbState, booking: CalendarBooking) {
  const event = booking.eventId ? state.calendarEvents.find(row => row.id === booking.eventId) : null;
  const attendees = (booking.attendeeUserIds ?? []).filter(userId => booking.status === 'PENDING' || !event ||
    state.calendarEventAttendees.some(row => row.eventId === event.id && row.userId === userId && !row.removedAt && row.response !== 'DECLINED'));
  return [...new Set([booking.ownerUserId, ...attendees])];
}
