import { CollabRouter, listed, WithStatus } from '../http';
import type { CalendarModule } from './index';

export function calendarRoutes(router: CollabRouter, module: () => CalendarModule) {
  const c = () => module().calendars;
  router
    .post('calendars', (r) => c().create(r.actor, r.body))
    .get('calendars', (r) => listed(c().list(r.actor, r.query)))
    .get('calendars/:id', (r) => c().get(r.actor, r.params.id))
    .put('calendars/:id', (r) => c().update(r.actor, r.params.id, r.body, true, r.ifMatch))
    .patch('calendars/:id', (r) => c().update(r.actor, r.params.id, r.body, false, r.ifMatch))
    .delete('calendars/:id', (r) => c().remove(r.actor, r.params.id))
    .get('calendars/:id/permissions', (r) => c().permissions(r.actor, r.params.id))
    .put('calendars/:id/permissions', (r) => c().replacePermissions(r.actor, r.params.id, r.body, r.ifMatch))
    .get('calendars/:id/preferences', (r) => c().preferences(r.actor, r.params.id))
    .patch('calendars/:id/preferences', (r) => c().updatePreferences(r.actor, r.params.id, r.body, r.ifMatch));
  const e = () => module().events;
  router
    .post('calendar-events', (r) => e().create(r.actor, r.body, r.idempotencyKey))
    .get('calendar-events', (r) => listed(e().list(r.actor, r.query)))
    .get('calendar-events/:id', (r) => e().get(r.actor, r.params.id))
    .put('calendar-events/:id', (r) => e().update(r.actor, r.params.id, r.body, true, r.ifMatch))
    .patch('calendar-events/:id', (r) => e().update(r.actor, r.params.id, r.body, false, r.ifMatch))
    .delete('calendar-events/:id', (r) => e().remove(r.actor, r.params.id))
    .post('calendar-events/:id/cancel', (r) => e().cancel(r.actor, r.params.id, r.body, false, r.ifMatch))
    .post('calendar-events/:id/restore', (r) => e().cancel(r.actor, r.params.id, r.body, true, r.ifMatch))
    .get('calendar-events/:id/attendees', (r) => e().attendees(r.actor, r.params.id))
    .post('calendar-events/:id/attendees', (r) => e().addAttendees(r.actor, r.params.id, r.body))
    .delete('calendar-events/:id/attendees/:userId', (r) => e().removeAttendee(r.actor, r.params.id, r.params.userId))
    .post('calendar-events/:id/respond', (r) => e().respond(r.actor, r.params.id, r.body))
    .get('calendar-events/:id/guests', (r) => e().guests(r.actor, r.params.id))
    .post('calendar-events/:id/guests', (r) => e().addGuest(r.actor, r.params.id, r.body))
    .delete('calendar-events/:id/guests/:guestId', (r) => e().removeGuest(r.actor, r.params.id, r.params.guestId))
    .get('calendar-events/:id/bindings', (r) => e().bindings(r.actor, r.params.id))
    .post('calendar-events/:id/bindings', (r) => e().addBinding(r.actor, r.params.id, r.body))
    .delete('calendar-events/:id/bindings/:bindingId', (r) => e().removeBinding(r.actor, r.params.id, r.params.bindingId))
    .get('calendar-events/:id/meeting-record', (r) => e().meetingRecord(r.actor, r.params.id))
    .put('calendar-events/:id/meeting-record', (r) => e().putMeetingRecord(r.actor, r.params.id, r.body, r.ifMatch))
    .post('calendar-events/:id/meeting-decisions', (r) => e().addDecision(r.actor, r.params.id, r.body, r.idempotencyKey));
  const recurrence = () => module().recurrence;
  router
    .get('calendar-events/:id/recurrence', (r) => recurrence().get(r.actor, r.params.id, r.query))
    .put('calendar-events/:id/recurrence', (r) => recurrence().update(r.actor, r.params.id, r.body, true, r.ifMatch))
    .patch('calendar-events/:id/recurrence', (r) => recurrence().update(r.actor, r.params.id, r.body, false, r.ifMatch))
    .delete('calendar-events/:id/recurrence', (r) => recurrence().remove(r.actor, r.params.id, r.body, r.ifMatch))
    .post('calendar-events/:id/occurrences/:recurrenceId/cancel', (r) => recurrence().cancelOccurrence(r.actor, r.params.id, r.params.recurrenceId, r.body, r.ifMatch))
    .patch('calendar-events/:id/occurrences/:recurrenceId', (r) => recurrence().editOccurrence(r.actor, r.params.id, r.params.recurrenceId, r.body, r.ifMatch))
    .patch('calendar-events/:id/recurrence/future', (r) => recurrence().editFuture(r.actor, r.params.id, r.body, r.ifMatch));
  const reminders = () => module().reminders;
  router
    .get('calendar-events/:id/reminders', (r) => reminders().list(r.actor, r.params.id))
    .post('calendar-events/:id/reminders', (r) => reminders().create(r.actor, r.params.id, r.body, r.idempotencyKey))
    .patch('calendar-reminders/:id', (r) => reminders().update(r.actor, r.params.id, r.body, r.ifMatch))
    .delete('calendar-reminders/:id', (r) => reminders().remove(r.actor, r.params.id, r.body, r.ifMatch));
  const resources = () => module().resources;
  router
    .get('calendar-resources', (r) => listed(resources().list(r.actor, r.query)))
    .post('calendar-resources', (r) => resources().create(r.actor, r.body))
    .get('calendar-resources/:id', (r) => resources().get(r.actor, r.params.id))
    .put('calendar-resources/:id', (r) => resources().update(r.actor, r.params.id, r.body, true, r.ifMatch))
    .patch('calendar-resources/:id', (r) => resources().update(r.actor, r.params.id, r.body, false, r.ifMatch))
    .delete('calendar-resources/:id', (r) => resources().remove(r.actor, r.params.id))
    .get('calendar-resources/:id/availability', (r) => resources().availability(r.actor, r.params.id, r.query))
    .post('calendar-events/:id/resources', (r) => resources().book(r.actor, r.params.id, r.body))
    .delete('calendar-events/:id/resources/:resourceId', (r) => resources().unbook(r.actor, r.params.id, r.params.resourceId));
  const availability = () => module().availability, schedules = () => module().schedules;
  const pages = () => module().bookingPages;
  router
    .get('bookings', (r) => listed(module().bookings.list(r.actor, r.query)))
    .get('bookings/:id', (r) => module().bookings.get(r.actor, r.params.id))
    .patch('bookings/:id', (r) => module().bookings.update(r.actor, r.params.id, r.body, r.ifMatch))
    .post('bookings/:id/approve', (r) => module().bookings.approve(r.actor, r.params.id, r.body, r.ifMatch))
    .post('bookings/:id/reject', (r) => module().bookings.cancel(r.actor, r.params.id, r.body, true, r.ifMatch))
    .post('bookings/:id/reschedule', (r) => module().bookings.reschedule(r.actor, r.params.id, r.body, r.ifMatch))
    .post('bookings/:id/cancel', (r) => module().bookings.cancel(r.actor, r.params.id, r.body, false, r.ifMatch));
  router
    .post('booking-pages', (r) => pages().create(r.actor, r.body))
    .get('booking-pages', (r) => listed(pages().list(r.actor, r.query)))
    .get('booking-pages/:id', (r) => pages().get(r.actor, r.params.id))
    .put('booking-pages/:id', (r) => pages().update(r.actor, r.params.id, r.body, true, r.ifMatch))
    .patch('booking-pages/:id', (r) => pages().update(r.actor, r.params.id, r.body, false, r.ifMatch))
    .delete('booking-pages/:id', (r) => pages().remove(r.actor, r.params.id))
    .post('booking-pages/:id/publish', (r) => pages().publication(r.actor, r.params.id, r.body, true, r.ifMatch))
    .post('booking-pages/:id/unpublish', (r) => pages().publication(r.actor, r.params.id, r.body, false, r.ifMatch))
    .get('booking-pages/:id/rules', (r) => pages().rules(r.actor, r.params.id))
    .put('booking-pages/:id/rules', (r) => pages().setRules(r.actor, r.params.id, r.body, r.ifMatch));
  const availabilityResult = <T extends { pending: boolean }>(result: T) => result.pending ? new WithStatus(202, result) : result;
  router.publicRoute('GET', 'public/booking/:slug', (r) => pages().publicView(r.params.slug))
    .publicRoute('GET', 'public/booking/:slug/slots', (r) => availabilityResult(module().bookingPublic.slots(r.params.slug, r.query)))
    .publicRoute('POST', 'public/booking/:slug/bookings', (r) => module().bookings.create(r.params.slug, r.body, r.idempotencyKey))
    .publicRoute('POST', 'public/bookings/:token/cancel', (r) => module().bookings.publicCancel(r.params.token, r.body))
    .publicRoute('POST', 'public/bookings/:token/reschedule', (r) => module().bookings.publicReschedule(r.params.token, r.body));
  router
    .post('availability/free-busy', (r) => availabilityResult(availability().freeBusy(r.actor, r.body)))
    .post('availability/suggest-slots', (r) => availabilityResult(availability().suggest(r.actor, r.body)))
    .get('availability/business-calendar', (r) => schedules().business(r.actor))
    .put('availability/business-calendar', (r) => schedules().setBusiness(r.actor, r.body, r.ifMatch))
    .get('availability/working-schedules/:userId', (r) => schedules().user(r.actor, r.params.userId))
    .put('availability/working-schedules/:userId', (r) => schedules().setUser(r.actor, r.params.userId, r.body, r.ifMatch));
  return router;
}
