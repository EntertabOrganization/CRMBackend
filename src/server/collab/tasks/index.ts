import type { FilePort } from '../../ports';
import type { CollabSupport } from '../support';
import { ChecklistService } from './checklist-service';
import { DependencyService } from './dependency-service';
import { TasksPolicy } from './policy';
import { ProjectService } from './project-service';
import { StageService } from './stage-service';
import { TaskService } from './task-service';
import { TemplateService } from './template-service';
import { TimeService } from './time-service';

/** Tasks & Projects bounded context: Projects/Workgroups, members, tools, Kanban stages, Tasks and their sub-resources. */
export class TasksProjectsModule {
  readonly policy: TasksPolicy;
  readonly projects: ProjectService;
  readonly tasks: TaskService;
  readonly stages: StageService;
  readonly checklists: ChecklistService;
  readonly dependencies: DependencyService;
  readonly time: TimeService;
  readonly templates: TemplateService;

  constructor(support: CollabSupport, files: () => FilePort) {
    this.policy = new TasksPolicy(support);
    this.projects = new ProjectService(support, this.policy);
    this.tasks = new TaskService(support, this.policy, this.projects, files);
    this.stages = new StageService(support, this.policy, this.tasks);
    this.checklists = new ChecklistService(support, this.policy, this.tasks);
    this.dependencies = new DependencyService(support, this.policy, this.tasks);
    this.time = new TimeService(support, this.policy, this.tasks);
    this.templates = new TemplateService(support, this.policy, this.tasks, files);
  }
}
