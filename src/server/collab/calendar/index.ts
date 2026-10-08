import type { CollabSupport } from '../support';
import type { TasksProjectsModule } from '../tasks';
import { CalendarService } from './calendar-service';
import { CalendarEventService } from './event-service';
import type { FilePort } from '../../ports';
import { CalendarRecurrenceService } from './recurrence-service';

export class CalendarModule {
  readonly calendars: CalendarService;
  readonly events: CalendarEventService;
  readonly recurrence: CalendarRecurrenceService;
  constructor(support: CollabSupport, tasks: TasksProjectsModule, files: () => FilePort) {
    this.calendars = new CalendarService(support, tasks.policy, tasks.projects);
    this.events = new CalendarEventService(support, this.calendars, tasks, files);
    this.recurrence = new CalendarRecurrenceService(support, this.events);
    tasks.projects.registerProvisioner(this.calendars.projectProvisioner());
    tasks.tasks.registerBindingResolver({ entityType: 'CALENDAR_EVENT', canBind: (actor, id) => {
      const event = support.state.calendarEvents.find((row) => row.id === id);
      return Boolean(event && this.events.canRead(actor, event));
    } });
  }
}
