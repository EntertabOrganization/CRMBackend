import type { AccessService } from '../access-service';
import type { FilePort } from '../ports';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import { CollabRouter } from './http';
import { CollabSupport } from './support';
import { TasksProjectsModule } from './tasks';
import { tasksProjectsRoutes } from './tasks/routes';
import { CalendarModule } from './calendar';
import { calendarRoutes } from './calendar/routes';

export type CollaborationDeps = {
  store: InMemoryStore;
  access: AccessService;
  realtime: RealtimeHub;
  files: () => FilePort;
};

/**
 * TrueCRM collaboration modules (Tasks & Projects, Calendar & Meetings, Files/Drive/Documents, Communication) behind one
 * router. Each bounded context talks to the others only through the ports it exposes.
 */
export class CollaborationModule {
  readonly support: CollabSupport;
  readonly tasks: TasksProjectsModule;
  readonly calendar: CalendarModule;
  readonly router: CollabRouter;

  constructor(deps: CollaborationDeps) {
    this.support = new CollabSupport(deps);
    this.tasks = new TasksProjectsModule(this.support, deps.files);
    this.calendar = new CalendarModule(this.support, this.tasks, deps.files);
    this.router = new CollabRouter();
    tasksProjectsRoutes(this.router, () => this.tasks);
    calendarRoutes(this.router, () => this.calendar);
  }
}
