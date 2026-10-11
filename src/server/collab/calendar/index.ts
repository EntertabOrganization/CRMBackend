import { CalendarSyncService } from './sync-service';
import type { CollabSupport } from '../support';
import type { TasksProjectsModule } from '../tasks';
import { CalendarService } from './calendar-service';
import { CalendarEventService } from './event-service';
import type { FilePort, NotificationPort } from '../../ports';
import { CalendarRecurrenceService } from './recurrence-service';
import { CalendarReminderService } from './reminder-service';
import { CalendarReminderDelivery } from './reminder-delivery';
import { CalendarResourceService } from './resource-service';
import { WorkingScheduleService } from './working-schedule-service';
import { CalendarAvailabilityService } from './availability-service';
import { CalendarAvailabilityRebuildService } from './availability-rebuild-service';
import { CalendarBookingPageService } from './booking-page-service';
import { CalendarBookingPublicService } from './booking-public-service';
import { CalendarBookingService } from './booking-service';
import { LeaseJobRunner, type LeaseStateRunner } from '../../jobs/lease-runner';

export class CalendarModule {
  readonly calendars: CalendarService;
  readonly events: CalendarEventService;
  readonly recurrence: CalendarRecurrenceService;
  readonly sync: CalendarSyncService;
  readonly reminders: CalendarReminderService;
  readonly reminderDelivery: CalendarReminderDelivery;
  readonly resources: CalendarResourceService;
  readonly schedules: WorkingScheduleService;
  readonly availability: CalendarAvailabilityService;
  readonly availabilityRebuilds: CalendarAvailabilityRebuildService;
  readonly bookingPages: CalendarBookingPageService;
  readonly bookingPublic: CalendarBookingPublicService;
  readonly bookings: CalendarBookingService;
  constructor(support: CollabSupport, tasks: TasksProjectsModule, files: () => FilePort, notifications: () => NotificationPort | null = () => null) {
    this.calendars = new CalendarService(support, tasks.policy, tasks.projects);
    this.events = new CalendarEventService(support, this.calendars, tasks, files);
    this.recurrence = new CalendarRecurrenceService(support, this.events);
    this.sync = new CalendarSyncService(support, this.calendars.policy, this.events, this.recurrence);
    this.events.beforeChange((event) => this.recurrence.assertBookingHolds(event));
    this.events.beforePartyChange((event, _size, participants) => this.recurrence.assertBookingHolds(event, participants));
    this.reminders = new CalendarReminderService(support, this.events, this.recurrence);
    this.events.onChange((event) => this.reminders.reconcile(event));
    this.schedules = new WorkingScheduleService(support);
    this.resources = new CalendarResourceService(support, this.events, this.schedules, this.recurrence);
    this.bookingPages = new CalendarBookingPageService(support, this.calendars, this.schedules, this.resources);
    this.availabilityRebuilds = new CalendarAvailabilityRebuildService(support, this.recurrence);
    this.availability = new CalendarAvailabilityService(support, this.recurrence, this.resources, this.schedules, this.availabilityRebuilds);
    this.bookingPublic = new CalendarBookingPublicService(support, this.bookingPages, this.availability, this.schedules);
    this.bookings = new CalendarBookingService(support, this.bookingPages, this.bookingPublic, this.events, this.resources);
    this.events.beforeChange((event) => this.resources.validateEvent(event));
    this.events.beforePartyChange((event, size) => this.resources.validateParty(event, size));
    this.events.onChange((event) => this.resources.reconcile(event));
    this.reminderDelivery = new CalendarReminderDelivery(support, this.reminders, this.events, notifications);
    tasks.projects.registerProvisioner(this.calendars.projectProvisioner());
    tasks.tasks.registerBindingResolver({ entityType: 'CALENDAR_EVENT', canBind: (actor, id) => {
      const event = support.state.calendarEvents.find((row) => row.id === id);
      return Boolean(event && this.events.canRead(actor, event));
    } });
  }
  reminderRunner(state: LeaseStateRunner, options: { deliveryTimeoutMs?: number } = {}) {
    return new LeaseJobRunner(this.reminderDelivery, state, options);
  }
}
