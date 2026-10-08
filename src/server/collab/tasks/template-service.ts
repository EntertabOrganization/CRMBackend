import type { ActorContext } from '../../access-service';
import { AppError, forbidden, isAppError } from '../../errors';
import type { FilePort } from '../../ports';
import type { Body, CollabSupport } from '../support';
import { isCalendarDate, isIanaTimezone, notFoundError, pageOf, validationError } from '../support';
import { addDays, daysInMonth, isLocalTime, isoWeekday, localDate, zonedDateTimeToInstant } from '../time';
import type { TasksPolicy } from './policy';
import type { TaskService } from './task-service';
import type { Task, TaskRecurrenceRule, TaskTemplate } from './types';
import { RECURRENCE_FREQUENCIES, SUBTASK_POLICIES, TASK_PRIORITIES } from './types';

const SCOPES = ['WORKSPACE', 'PERSONAL', 'PROJECT'] as const;
const MAX_SUBTASK_DEPTH = 3;
const RETRY_DELAY_MS = 15 * 60_000;

type ChecklistInput = { name: string; items: Array<{ title: string; children?: ChecklistInput['items'] }> };

/**
 * Reusable Task templates and recurrence. A recurrence run creates an ordinary Task through TaskService; each scheduled
 * occurrence is created at most once (UNIQUE(recurrence_rule_id, scheduled_for) + in-transaction check), and a failing
 * occurrence is recorded visibly and retried without creating partial duplicates.
 */
export class TemplateService {
  constructor(
    private readonly support: CollabSupport,
    private readonly policy: TasksPolicy,
    private readonly tasks: TaskService,
    private readonly files: () => FilePort,
  ) {}

  private get state() {
    return this.support.state;
  }

  // ---- access -------------------------------------------------------------------------------------------------------

  private canView(actor: ActorContext, template: TaskTemplate) {
    if (template.workspaceId !== actor.workspaceId || template.isDeleted) return false;
    if (!this.support.scope(actor, 'task_template.read')) return false;
    if (template.scopeType === 'PERSONAL') return template.createdByUserId === actor.user.id;
    if (template.scopeType === 'PROJECT') {
      const project = this.state.projects.find((row) => row.id === template.scopeId && !row.isDeleted);
      return Boolean(project && this.policy.canViewProject(actor, project));
    }
    return true;
  }

  private template(actor: ActorContext, id: string) {
    this.support.require(actor, 'task_template.read');
    const template = this.state.taskTemplates.find((row) => row.id === id && row.workspaceId === actor.workspaceId);
    if (!template || !this.canView(actor, template)) throw notFoundError('TASK_TEMPLATE_NOT_FOUND', 'Task template');
    return template;
  }

  /** Mutation: the permission key plus authorship, a managing Project role (PROJECT scope) or a workspace-wide grant. */
  private requireManage(actor: ActorContext, template: TaskTemplate, permission: string) {
    const scope = this.support.require(actor, permission);
    if (actor.role.isOwnerRole || scope === 'WORKSPACE' || template.createdByUserId === actor.user.id) return;
    if (template.scopeType === 'PROJECT') {
      const project = this.state.projects.find((row) => row.id === template.scopeId);
      if (project && this.policy.isProjectManager(project, actor.user.id)) return;
    }
    throw forbidden(`${permission} is not granted for this template.`);
  }

  // ---- views --------------------------------------------------------------------------------------------------------

  view(template: TaskTemplate) {
    const members = this.state.taskTemplateMembers.filter((row) => row.templateId === template.id);
    const items = this.state.taskTemplateChecklistItems.filter((row) => row.templateId === template.id).sort((a, b) => a.sortOrder - b.sortOrder);
    const build = (checklistName: string, parentId: string | null): ChecklistInput['items'] =>
      items.filter((row) => row.checklistName === checklistName && row.parentItemId === parentId).map((row) => ({ title: row.title, children: build(checklistName, row.id) }));
    const checklistNames = [...new Set(items.map((row) => row.checklistName))];
    const rule = this.state.taskRecurrenceRules.find((row) => row.templateId === template.id && !row.isDeleted) ?? null;
    return {
      ...template,
      participantUserIds: members.filter((row) => row.role === 'PARTICIPANT').map((row) => row.userId),
      observerUserIds: members.filter((row) => row.role === 'OBSERVER').map((row) => row.userId),
      checklists: checklistNames.map((name) => ({ name, items: build(name, null) })),
      subtaskTemplateIds: this.state.taskTemplateSubtasks.filter((row) => row.templateId === template.id).sort((a, b) => a.sortOrder - b.sortOrder).map((row) => row.childTemplateId),
      recurrence: rule,
    };
  }

  // ---- write helpers ------------------------------------------------------------------------------------------------

  private readChecklists(body: Body): ChecklistInput[] | undefined {
    const raw = body.array('checklists', { max: 20 });
    if (!raw) return undefined;
    let count = 0;
    const readItems = (items: unknown, path: string, depth: number): ChecklistInput['items'] => {
      if (!Array.isArray(items)) throw validationError(path, `${path} must be an array.`);
      if (depth > 5) throw validationError(path, 'Checklist nesting is limited to 5 levels.');
      return items.map((item, index) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        if (typeof entry.title !== 'string' || !entry.title.trim()) throw validationError(`${path}[${index}].title`, 'title is required.');
        if ((count += 1) > 500) throw validationError(path, 'A template may hold at most 500 checklist items.');
        return { title: entry.title.trim().slice(0, 1000), children: entry.children === undefined ? [] : readItems(entry.children, `${path}[${index}].children`, depth + 1) };
      });
    };
    return raw.map((checklist, index) => {
      const entry = (checklist ?? {}) as Record<string, unknown>;
      if (typeof entry.name !== 'string' || !entry.name.trim()) throw validationError(`checklists[${index}].name`, 'name is required.');
      return { name: entry.name.trim().slice(0, 200), items: readItems(entry.items ?? [], `checklists[${index}].items`, 1) };
    });
  }

  private assertFiles(actor: ActorContext, fileIds: string[]) {
    for (const fileId of fileIds) {
      const check = this.files().check(actor.workspaceId, actor, fileId);
      if (check === 'UNAVAILABLE') throw new AppError('FILE_SERVICE_UNAVAILABLE', 'File references are not available.', 503);
      if (check !== 'OK') throw notFoundError('FILE_NOT_FOUND', 'File');
    }
  }

  /** Template subtask references must stay inside the Workspace and acyclic. */
  private assertSubtaskTemplates(actor: ActorContext, templateId: string, childIds: string[]) {
    for (const childId of childIds) {
      if (childId === templateId) throw validationError('subtaskTemplateIds', 'A template cannot be its own subtask.');
      this.template(actor, childId);
      const seen = new Set<string>();
      const walk = (id: string, depth: number) => {
        if (id === templateId) throw validationError('subtaskTemplateIds', 'Subtask templates would form a cycle.');
        if (depth > MAX_SUBTASK_DEPTH) throw validationError('subtaskTemplateIds', `Subtask templates nest at most ${MAX_SUBTASK_DEPTH} levels.`);
        if (seen.has(id)) return;
        seen.add(id);
        for (const row of this.state.taskTemplateSubtasks.filter((item) => item.templateId === id)) walk(row.childTemplateId, depth + 1);
      };
      walk(childId, 1);
    }
  }

  private replaceChildren(template: TaskTemplate, input: { participants?: string[]; observers?: string[]; checklists?: ChecklistInput[]; subtasks?: string[] }) {
    const s = this.state;
    if (input.participants || input.observers) {
      s.taskTemplateMembers = s.taskTemplateMembers.filter((row) => row.templateId !== template.id);
      for (const [role, ids] of [['PARTICIPANT', input.participants ?? []], ['OBSERVER', input.observers ?? []]] as const) {
        for (const userId of ids) s.taskTemplateMembers.push({ id: this.support.id(), workspaceId: template.workspaceId, templateId: template.id, userId, role });
      }
    }
    if (input.checklists) {
      s.taskTemplateChecklistItems = s.taskTemplateChecklistItems.filter((row) => row.templateId !== template.id);
      let order = 0;
      const add = (checklistName: string, items: ChecklistInput['items'], parentItemId: string | null) => {
        for (const item of items) {
          const id = this.support.id();
          s.taskTemplateChecklistItems.push({ id, workspaceId: template.workspaceId, templateId: template.id, checklistName, parentItemId, title: item.title, sortOrder: (order += 1) * 100 });
          add(checklistName, item.children ?? [], id);
        }
      };
      for (const checklist of input.checklists) add(checklist.name, checklist.items, null);
    }
    if (input.subtasks) {
      s.taskTemplateSubtasks = s.taskTemplateSubtasks.filter((row) => row.templateId !== template.id);
      input.subtasks.forEach((childTemplateId, index) => s.taskTemplateSubtasks.push({ id: this.support.id(), workspaceId: template.workspaceId, templateId: template.id, childTemplateId, sortOrder: (index + 1) * 100 }));
    }
  }

  private readFields(actor: ActorContext, body: Body, replace: boolean, existing?: TaskTemplate) {
    const fields = {
      name: replace || body.has('name') ? body.str('name', { required: true, max: 200 }) : existing!.name,
      titleTemplate: replace || body.has('titleTemplate') ? body.str('titleTemplate', { required: true, max: 500 }) : existing!.titleTemplate,
      descriptionTemplate: body.has('descriptionTemplate') || replace ? body.str('descriptionTemplate', { max: 50_000 }) ?? null : existing!.descriptionTemplate,
      scopeType: (body.enumOf('scopeType', SCOPES) ?? (replace || !existing ? 'WORKSPACE' : existing.scopeType)) as TaskTemplate['scopeType'],
      scopeId: body.has('scopeId') || replace ? body.uuid('scopeId') ?? null : existing!.scopeId,
      projectId: body.has('projectId') || replace ? body.uuid('projectId') ?? null : existing!.projectId,
      defaultResponsibleUserId: body.has('defaultResponsibleUserId') || replace ? body.uuid('defaultResponsibleUserId') ?? null : existing!.defaultResponsibleUserId,
      priority: body.enumOf('priority', TASK_PRIORITIES) ?? (replace || !existing ? 'NORMAL' : existing.priority),
      deadlineOffsetSeconds: body.has('deadlineOffsetSeconds') || replace ? body.int('deadlineOffsetSeconds', { min: 0, max: 31_536_000 * 5 }) ?? null : existing!.deadlineOffsetSeconds,
      plannedDurationSeconds: body.has('plannedDurationSeconds') || replace ? body.int('plannedDurationSeconds', { min: 0, max: 2_000_000_000 }) ?? null : existing!.plannedDurationSeconds,
      isTimeTrackingEnabled: body.bool('isTimeTrackingEnabled') ?? (replace || !existing ? false : existing.isTimeTrackingEnabled),
      completionControl: body.bool('completionControl') ?? (replace || !existing ? false : existing.completionControl),
      requiresResult: body.bool('requiresResult') ?? (replace || !existing ? false : existing.requiresResult),
      subtaskCompletionPolicy: body.enumOf('subtaskCompletionPolicy', SUBTASK_POLICIES) ?? (replace || !existing ? 'WARN' : existing.subtaskCompletionPolicy),
      isActive: body.bool('isActive') ?? (replace || !existing ? true : existing.isActive),
      fileIds: body.uuids('fileIds', { max: 50 }) ?? (replace || !existing ? [] : existing.fileIds),
    };
    if (fields.scopeType === 'PERSONAL' && fields.scopeId && fields.scopeId !== (existing?.createdByUserId ?? actor.user.id)) throw validationError('scopeId', 'A personal template belongs to its author.');
    if (fields.scopeType === 'PERSONAL') fields.scopeId = existing?.createdByUserId ?? actor.user.id;
    if (fields.scopeType === 'WORKSPACE') fields.scopeId = null;
    if (fields.scopeType === 'PROJECT') {
      if (!fields.scopeId) throw validationError('scopeId', 'scopeId (the Project) is required for PROJECT templates.');
      this.policy.project(actor, fields.scopeId);
    }
    if (fields.projectId) this.policy.project(actor, fields.projectId);
    if (fields.defaultResponsibleUserId && !this.support.isEligibleUser(actor.workspaceId, fields.defaultResponsibleUserId)) {
      throw new AppError('TASK_RESPONSIBLE_INVALID', 'defaultResponsibleUserId must be an active internal member of this Workspace.', 400);
    }
    if (body.has('fileIds')) this.assertFiles(actor, fields.fileIds);
    return fields;
  }

  private readMembers(actor: ActorContext, body: Body) {
    const participants = body.uuids('participantUserIds', { max: 200 });
    const observers = body.uuids('observerUserIds', { max: 200 });
    for (const userId of [...(participants ?? []), ...(observers ?? [])]) {
      if (!this.support.isEligibleUser(actor.workspaceId, userId)) throw new AppError('TASK_MEMBER_INVALID', 'Template members must be active internal members of this Workspace.', 400, { userId });
    }
    return { participants, observers };
  }

  private static readonly FIELDS = [
    'name', 'titleTemplate', 'descriptionTemplate', 'scopeType', 'scopeId', 'projectId', 'defaultResponsibleUserId', 'priority', 'deadlineOffsetSeconds',
    'plannedDurationSeconds', 'isTimeTrackingEnabled', 'completionControl', 'requiresResult', 'subtaskCompletionPolicy', 'isActive', 'fileIds',
    'participantUserIds', 'observerUserIds', 'checklists', 'subtaskTemplateIds',
  ];

  // ---- CRUD ---------------------------------------------------------------------------------------------------------

  create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'task_template.create');
    body.only(TemplateService.FIELDS);
    const fields = this.readFields(actor, body, true);
    const members = this.readMembers(actor, body);
    const checklists = this.readChecklists(body);
    const id = this.support.id();
    const subtasks = body.uuids('subtaskTemplateIds', { max: 20 });
    if (subtasks) this.assertSubtaskTemplates(actor, id, subtasks);
    const now = this.support.now();
    const template: TaskTemplate = { id, workspaceId: actor.workspaceId, ...fields, isDeleted: false, createdByUserId: actor.user.id, version: 1, createdAt: now, updatedAt: now };
    this.state.taskTemplates.push(template);
    this.replaceChildren(template, { ...members, checklists, subtasks });
    this.support.event({ workspaceId: actor.workspaceId, type: 'TASK_TEMPLATE_CREATED', entityType: 'TASK_TEMPLATE', entityId: id, actorUserId: actor.user.id, changes: { name: template.name, scopeType: template.scopeType } });
    this.support.audit(actor, actor.workspaceId, 'TASK_TEMPLATE.CREATED', 'TASK_TEMPLATE', id, null, { name: template.name, scopeType: template.scopeType });
    return this.view(template);
  }

  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'task_template.read');
    const rows = this.state.taskTemplates.filter((row) => row.workspaceId === actor.workspaceId && this.canView(actor, row));
    const page = pageOf(rows, query, { searchable: ['name', 'titleTemplate'], filterable: ['scopeType', 'scopeId', 'projectId', 'isActive', 'priority'], sortable: ['name', 'createdAt', 'updatedAt'], defaultSort: 'name' });
    return { data: page.data.map((row) => this.view(row)), meta: page.meta };
  }

  get(actor: ActorContext, id: string) {
    return this.view(this.template(actor, id));
  }

  /** Editing a template never rewrites Tasks already created from it. */
  update(actor: ActorContext, id: string, body: Body, replace: boolean, ifMatch?: number) {
    const template = this.template(actor, id);
    this.requireManage(actor, template, 'task_template.update');
    body.only([...TemplateService.FIELDS, 'version']);
    this.support.expectVersion(template, body.raw.version ?? ifMatch);
    const fields = this.readFields(actor, body, replace, template);
    const members = this.readMembers(actor, body);
    const checklists = this.readChecklists(body);
    const subtasks = body.uuids('subtaskTemplateIds', { max: 20 });
    if (subtasks) this.assertSubtaskTemplates(actor, template.id, subtasks);
    const before = { name: template.name, titleTemplate: template.titleTemplate, priority: template.priority, isActive: template.isActive };
    Object.assign(template, fields);
    this.support.touch(template);
    this.replaceChildren(template, replace
      ? { participants: members.participants ?? [], observers: members.observers ?? [], checklists: checklists ?? [], subtasks: subtasks ?? [] }
      : { participants: members.participants ?? (members.observers ? this.memberIds(template, 'PARTICIPANT') : undefined), observers: members.observers ?? (members.participants ? this.memberIds(template, 'OBSERVER') : undefined), checklists, subtasks });
    this.support.event({ workspaceId: template.workspaceId, type: 'TASK_TEMPLATE_UPDATED', entityType: 'TASK_TEMPLATE', entityId: template.id, actorUserId: actor.user.id, changes: { version: template.version } });
    this.support.audit(actor, template.workspaceId, 'TASK_TEMPLATE.UPDATED', 'TASK_TEMPLATE', template.id, before, { name: template.name, titleTemplate: template.titleTemplate, priority: template.priority, isActive: template.isActive });
    return this.view(template);
  }

  private memberIds(template: TaskTemplate, role: 'PARTICIPANT' | 'OBSERVER') {
    return this.state.taskTemplateMembers.filter((row) => row.templateId === template.id && row.role === role).map((row) => row.userId);
  }

  remove(actor: ActorContext, id: string) {
    const template = this.template(actor, id);
    this.requireManage(actor, template, 'task_template.delete');
    if (this.state.taskTemplateSubtasks.some((row) => row.childTemplateId === template.id && this.state.taskTemplates.some((parent) => parent.id === row.templateId && !parent.isDeleted))) {
      throw new AppError('TASK_TEMPLATE_IN_USE', 'Another template uses this template as a subtask.', 409);
    }
    template.isDeleted = true;
    template.isActive = false;
    this.support.touch(template);
    const rule = this.state.taskRecurrenceRules.find((row) => row.templateId === template.id && !row.isDeleted);
    if (rule) {
      rule.isActive = false;
      rule.nextRunAt = null;
      this.support.touch(rule);
    }
    this.support.event({ workspaceId: template.workspaceId, type: 'TASK_TEMPLATE_DELETED', entityType: 'TASK_TEMPLATE', entityId: template.id, actorUserId: actor.user.id });
    this.support.audit(actor, template.workspaceId, 'TASK_TEMPLATE.DELETED', 'TASK_TEMPLATE', template.id, { name: template.name }, null);
    return { id: template.id, deleted: true };
  }

  // ---- instantiate --------------------------------------------------------------------------------------------------

  /**
   * Creates an independent Task (and its subtasks) from the template. Every row goes through TaskService.create, so the
   * new Task is indistinguishable from a manually created one afterwards.
   */
  private materialize(actor: ActorContext, template: TaskTemplate, options: { responsibleUserId?: string; projectId?: string | null; deadlineAt?: Date | null; title?: string; parentTaskId?: string | null; recurrenceInstanceId?: string | null; scheduledFor?: Date; timezone?: string }, depth = 0): Task {
    const base = options.scheduledFor ?? this.support.now();
    const dateLabel = localDate(base, options.timezone ?? 'UTC');
    const title = (options.title ?? template.titleTemplate.replace(/\{\{\s*date\s*\}\}/g, dateLabel)).slice(0, 500);
    const deadlineAt = options.deadlineAt !== undefined ? options.deadlineAt : template.deadlineOffsetSeconds !== null ? new Date(base.getTime() + template.deadlineOffsetSeconds * 1000) : null;
    const projectId = options.projectId !== undefined ? options.projectId : template.projectId;
    const participants = this.memberIds(template, 'PARTICIPANT');
    const observers = this.memberIds(template, 'OBSERVER');
    const task = this.tasks.create(actor, {
      title,
      description: template.descriptionTemplate?.replace(/\{\{\s*date\s*\}\}/g, dateLabel) ?? null,
      responsibleUserId: options.responsibleUserId ?? template.defaultResponsibleUserId ?? actor.user.id,
      priority: template.priority,
      projectId,
      parentTaskId: options.parentTaskId ?? null,
      deadlineAt,
      startAt: deadlineAt && deadlineAt < base ? null : options.scheduledFor ?? null,
      plannedDurationSeconds: template.plannedDurationSeconds,
      requiresResult: template.requiresResult,
      completionControl: template.completionControl,
      subtaskCompletionPolicy: template.subtaskCompletionPolicy,
      isTimeTrackingEnabled: template.isTimeTrackingEnabled,
      participantUserIds: participants,
      observerUserIds: observers.filter((id) => !participants.includes(id)),
      templateId: template.id,
      recurrenceInstanceId: options.recurrenceInstanceId ?? null,
    });
    this.copyChecklists(template, task);
    if (depth < MAX_SUBTASK_DEPTH) {
      for (const link of this.state.taskTemplateSubtasks.filter((row) => row.templateId === template.id).sort((a, b) => a.sortOrder - b.sortOrder)) {
        const child = this.state.taskTemplates.find((row) => row.id === link.childTemplateId && !row.isDeleted);
        if (child) this.materialize(actor, child, { parentTaskId: task.id, projectId: task.projectId, scheduledFor: options.scheduledFor, timezone: options.timezone }, depth + 1);
      }
    }
    return task;
  }

  private copyChecklists(template: TaskTemplate, task: Task) {
    const items = this.state.taskTemplateChecklistItems.filter((row) => row.templateId === template.id).sort((a, b) => a.sortOrder - b.sortOrder);
    const now = this.support.now();
    const names = [...new Set(items.map((row) => row.checklistName))];
    names.forEach((name, index) => {
      const checklist = { id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, name, sortOrder: (index + 1) * 100, version: 1, createdAt: now, updatedAt: now };
      this.state.taskChecklists.push(checklist);
      const idMap = new Map<string, string>();
      for (const item of items.filter((row) => row.checklistName === name)) {
        const id = this.support.id();
        idMap.set(item.id, id);
        this.state.taskChecklistItems.push({
          id, workspaceId: task.workspaceId, checklistId: checklist.id, taskId: task.id, parentItemId: item.parentItemId ? idMap.get(item.parentItemId) ?? null : null,
          title: item.title, assignedUserId: null, isCompleted: false, completedByUserId: null, completedAt: null, sortOrder: item.sortOrder, version: 1, createdAt: now, updatedAt: now,
        });
      }
    });
  }

  instantiate(actor: ActorContext, id: string, body: Body, idempotencyKey?: string) {
    const template = this.template(actor, id);
    this.support.require(actor, 'task.create');
    if (!template.isActive) throw new AppError('TASK_TEMPLATE_INACTIVE', 'The template is inactive.', 409);
    body.only(['responsibleUserId', 'projectId', 'deadlineAt', 'title']);
    const key = this.support.idempotencyKey(idempotencyKey);
    const replay = this.support.recall(actor, `task_template.instantiate:${template.id}`, key, body.raw);
    if (replay) {
      const existing = this.state.tasks.find((row) => row.id === replay.taskId);
      if (existing) return this.tasks.view(actor, existing);
    }
    const task = this.materialize(actor, template, {
      responsibleUserId: body.uuid('responsibleUserId') ?? undefined,
      projectId: body.has('projectId') || body.raw.projectId === null ? body.uuid('projectId') ?? null : undefined,
      deadlineAt: body.has('deadlineAt') || body.raw.deadlineAt === null ? body.instant('deadlineAt') ?? null : undefined,
      title: body.str('title', { max: 500 }) ?? undefined,
    });
    this.support.remember(actor, `task_template.instantiate:${template.id}`, key, body.raw, { taskId: task.id });
    return this.tasks.view(actor, task);
  }

  // ---- recurrence ---------------------------------------------------------------------------------------------------

  private ruleOf(template: TaskTemplate) {
    return this.state.taskRecurrenceRules.find((row) => row.templateId === template.id) ?? null;
  }

  getRecurrence(actor: ActorContext, id: string) {
    const template = this.template(actor, id);
    const rule = this.ruleOf(template);
    if (!rule || rule.isDeleted) throw notFoundError('RECURRENCE_NOT_FOUND', 'Recurrence rule');
    return { ...rule, upcoming: this.occurrences(rule, new Date(Date.now() - 1), 5) };
  }

  /** PUT replaces the rule; PATCH merges into the existing one. Invalid combinations yield RECURRENCE_INVALID_RULE. */
  setRecurrence(actor: ActorContext, id: string, body: Body, replace: boolean, ifMatch?: number) {
    const template = this.template(actor, id);
    this.requireManage(actor, template, 'task_template.recurrence_manage');
    body.only(['frequency', 'intervalValue', 'daysOfWeek', 'dayOfMonth', 'startDate', 'endDate', 'maxOccurrences', 'creationLocalTime', 'timezone', 'isActive', 'version']);
    const existing = this.ruleOf(template);
    const live = existing && !existing.isDeleted ? existing : null;
    if (!replace && !live) throw notFoundError('RECURRENCE_NOT_FOUND', 'Recurrence rule');
    if (live) this.support.expectVersion(live, body.raw.version ?? ifMatch, !replace);
    const invalid = (message: string, field: string) => new AppError('RECURRENCE_INVALID_RULE', message, 400, { field });
    const pick = <T>(key: string, read: () => T, fallback: T): T => (body.has(key) || body.raw[key] === null ? read() : replace || !live ? fallback : (live as unknown as Record<string, T>)[key]);
    const frequency = pick('frequency', () => body.enumOf('frequency', RECURRENCE_FREQUENCIES) ?? null, null);
    if (!frequency) throw invalid('frequency is required.', 'frequency');
    const intervalValue = pick('intervalValue', () => body.raw.intervalValue as number, 1);
    if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 366) throw invalid('intervalValue must be an integer between 1 and 366.', 'intervalValue');
    const daysOfWeek = pick('daysOfWeek', () => body.raw.daysOfWeek as number[], [] as number[]);
    if (!Array.isArray(daysOfWeek) || !daysOfWeek.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) throw invalid('daysOfWeek must contain ISO weekdays 1 (Mon) .. 7 (Sun).', 'daysOfWeek');
    if (frequency === 'WEEKLY' && daysOfWeek.length === 0) throw invalid('WEEKLY recurrence needs at least one weekday.', 'daysOfWeek');
    const dayOfMonth = pick('dayOfMonth', () => (body.raw.dayOfMonth ?? null) as number | null, null);
    if (dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) throw invalid('dayOfMonth must be between 1 and 31.', 'dayOfMonth');
    const startDate = pick('startDate', () => body.raw.startDate as string, '');
    if (typeof startDate !== 'string' || !isCalendarDate(startDate)) throw invalid('startDate (YYYY-MM-DD) is required.', 'startDate');
    const endDate = pick('endDate', () => (body.raw.endDate ?? null) as string | null, null);
    if (endDate !== null && (typeof endDate !== 'string' || !isCalendarDate(endDate) || endDate < startDate)) throw invalid('endDate must be a date on or after startDate.', 'endDate');
    const maxOccurrences = pick('maxOccurrences', () => (body.raw.maxOccurrences ?? null) as number | null, null);
    if (maxOccurrences !== null && (!Number.isInteger(maxOccurrences) || maxOccurrences < 1)) throw invalid('maxOccurrences must be a positive integer.', 'maxOccurrences');
    const creationLocalTime = pick('creationLocalTime', () => body.raw.creationLocalTime as string, '09:00');
    if (!isLocalTime(creationLocalTime)) throw invalid('creationLocalTime must be HH:MM.', 'creationLocalTime');
    const timezone = pick('timezone', () => body.raw.timezone as string, '');
    if (!isIanaTimezone(timezone)) throw invalid('timezone must be an IANA time zone such as Europe/Berlin.', 'timezone');
    const isActive = pick('isActive', () => body.bool('isActive') ?? true, true);

    const now = this.support.now();
    const values = { frequency, intervalValue, daysOfWeek: [...new Set(daysOfWeek)].sort(), dayOfMonth, startDate, endDate, maxOccurrences, creationLocalTime, timezone, isActive };
    let rule: TaskRecurrenceRule;
    if (existing) {
      Object.assign(existing, values, { isDeleted: false, lastErrorCode: null, lastErrorAt: null });
      if (!live) existing.occurrenceCount = existing.occurrenceCount ?? 0;
      this.support.touch(existing);
      rule = existing;
    } else {
      rule = { id: this.support.id(), workspaceId: template.workspaceId, templateId: template.id, ...values, nextRunAt: null, occurrenceCount: 0, isDeleted: false, lastErrorCode: null, lastErrorAt: null, version: 1, createdAt: now, updatedAt: now };
      this.state.taskRecurrenceRules.push(rule);
    }
    rule.nextRunAt = rule.isActive ? this.nextAfter(rule, now) : null;
    this.support.event({ workspaceId: template.workspaceId, type: 'TASK_RECURRENCE_CHANGED', entityType: 'TASK_TEMPLATE', entityId: template.id, actorUserId: actor.user.id, changes: { ruleId: rule.id, frequency, timezone, nextRunAt: rule.nextRunAt?.toISOString() ?? null } });
    this.support.audit(actor, template.workspaceId, 'TASK_TEMPLATE.RECURRENCE_CHANGED', 'TASK_TEMPLATE', template.id, null, { ...values });
    return { ...rule, upcoming: this.occurrences(rule, new Date(now.getTime() - 1), 5) };
  }

  deleteRecurrence(actor: ActorContext, id: string) {
    const template = this.template(actor, id);
    this.requireManage(actor, template, 'task_template.recurrence_manage');
    const rule = this.ruleOf(template);
    if (!rule || rule.isDeleted) throw notFoundError('RECURRENCE_NOT_FOUND', 'Recurrence rule');
    rule.isDeleted = true;
    rule.isActive = false;
    rule.nextRunAt = null;
    this.support.touch(rule);
    this.support.event({ workspaceId: template.workspaceId, type: 'TASK_RECURRENCE_CHANGED', entityType: 'TASK_TEMPLATE', entityId: template.id, actorUserId: actor.user.id, changes: { ruleId: rule.id, deleted: true } });
    this.support.audit(actor, template.workspaceId, 'TASK_TEMPLATE.RECURRENCE_DELETED', 'TASK_TEMPLATE', template.id, { ruleId: rule.id }, null);
    return { id: rule.id, deleted: true };
  }

  /** Read-only: which occurrences are due up to `until` (default now) and whether each one already produced a Task. */
  runDuePreview(actor: ActorContext, id: string, body: Body) {
    const template = this.template(actor, id);
    body.only(['until']);
    const until = body.instant('until') ?? this.support.now();
    const rule = this.ruleOf(template);
    if (!rule || rule.isDeleted) throw notFoundError('RECURRENCE_NOT_FOUND', 'Recurrence rule');
    const due = this.occurrences(rule, new Date(0), 1000).filter((when) => when <= until);
    return {
      ruleId: rule.id,
      until,
      occurrences: due.slice(-100).map((scheduledFor) => {
        const instance = this.state.taskRecurrenceInstances.find((row) => row.recurrenceRuleId === rule.id && row.scheduledFor.getTime() === scheduledFor.getTime());
        return { scheduledFor, status: instance?.status ?? 'PENDING', taskId: instance?.taskId ?? null, attempts: instance?.attempts ?? 0, lastErrorCode: instance?.lastErrorCode ?? null };
      }),
    };
  }

  // ---- occurrence math ----------------------------------------------------------------------------------------------

  /** Local calendar dates of the rule in order (unbounded generator, capped by the caller). */
  private *dates(rule: TaskRecurrenceRule): Generator<string> {
    const [startYear, startMonth, startDay] = rule.startDate.split('-').map(Number);
    for (let k = 0; k < 20_000; k += 1) {
      if (rule.frequency === 'DAILY') {
        yield addDays(rule.startDate, k * rule.intervalValue);
      } else if (rule.frequency === 'WEEKLY') {
        const monday = addDays(rule.startDate, -(isoWeekday(rule.startDate) - 1) + k * 7 * rule.intervalValue);
        for (const day of rule.daysOfWeek) {
          const date = addDays(monday, day - 1);
          if (date >= rule.startDate) yield date;
        }
      } else if (rule.frequency === 'MONTHLY') {
        const monthIndex = startMonth - 1 + k * rule.intervalValue;
        const year = startYear + Math.floor(monthIndex / 12);
        const month = (monthIndex % 12) + 1;
        const day = Math.min(rule.dayOfMonth ?? startDay, daysInMonth(year, month));
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (date >= rule.startDate) yield date;
      } else {
        const year = startYear + k * rule.intervalValue;
        const day = Math.min(startDay, daysInMonth(year, startMonth));
        yield `${year}-${String(startMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  /** Instants of the occurrences strictly after `after`, honouring endDate and maxOccurrences (counted from the start). */
  occurrences(rule: TaskRecurrenceRule, after: Date, limit: number) {
    const result: Date[] = [];
    let index = 0;
    for (const date of this.dates(rule)) {
      if (rule.endDate && date > rule.endDate) break;
      if (rule.maxOccurrences !== null && index >= rule.maxOccurrences) break;
      index += 1;
      const instant = zonedDateTimeToInstant(date, rule.creationLocalTime, rule.timezone);
      if (instant > after) result.push(instant);
      if (result.length >= limit) break;
    }
    return result;
  }

  private nextAfter(rule: TaskRecurrenceRule, after: Date) {
    // The first occurrence at or after "now" is still due today; earlier ones are not back-filled on (re)configuration.
    return this.occurrences(rule, new Date(after.getTime() - 1), 1)[0] ?? null;
  }

  // ---- scheduler ----------------------------------------------------------------------------------------------------

  /**
   * Scheduler entry point (internal job). Each due occurrence runs atomically: the Task, its children and the instance
   * row commit together or not at all. A duplicate delivery finds the CREATED instance and does nothing; a failure is
   * recorded on a FAILED instance (visible), emits TASK_RECURRENCE_FAILED and is retried on a later run.
   */
  runDue(now = this.support.now(), limit = 100) {
    const results: Array<{ ruleId: string; scheduledFor: string; outcome: 'CREATED' | 'DUPLICATE' | 'FAILED' | 'RETRY_DEFERRED'; taskId?: string; errorCode?: string }> = [];
    const due = this.state.taskRecurrenceRules
      .filter((rule) => rule.isActive && !rule.isDeleted && rule.nextRunAt && rule.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())
      .slice(0, limit);
    for (const rule of due) {
      const scheduledFor = rule.nextRunAt!;
      const existing = this.state.taskRecurrenceInstances.find((row) => row.recurrenceRuleId === rule.id && row.scheduledFor.getTime() === scheduledFor.getTime());
      if (existing?.status === 'CREATED') {
        this.advance(rule, scheduledFor);
        results.push({ ruleId: rule.id, scheduledFor: scheduledFor.toISOString(), outcome: 'DUPLICATE', taskId: existing.taskId ?? undefined });
        continue;
      }
      // Failed occurrences are retried with a backoff so a persistent error does not spin on every scheduler tick.
      if (existing?.status === 'FAILED' && existing.updatedAt.getTime() + RETRY_DELAY_MS > now.getTime()) {
        results.push({ ruleId: rule.id, scheduledFor: scheduledFor.toISOString(), outcome: 'RETRY_DEFERRED', errorCode: existing.lastErrorCode ?? undefined });
        continue;
      }
      try {
        const taskId = this.support.store.atomicSync(() => this.createOccurrence(rule, scheduledFor, existing ?? null));
        this.advance(rule, scheduledFor);
        results.push({ ruleId: rule.id, scheduledFor: scheduledFor.toISOString(), outcome: 'CREATED', taskId });
      } catch (error) {
        const code = isAppError(error) ? error.code : 'RECURRENCE_RUN_FAILED';
        this.recordFailure(rule, scheduledFor, code, now);
        results.push({ ruleId: rule.id, scheduledFor: scheduledFor.toISOString(), outcome: 'FAILED', errorCode: code });
      }
    }
    return { processed: results.length, results };
  }

  /** Creates the Task for one occurrence on behalf of the template author; ineligible targets fail the run visibly. */
  private createOccurrence(rule: TaskRecurrenceRule, scheduledFor: Date, failed: { id: string; attempts: number } | null): string {
    const template = this.state.taskTemplates.find((row) => row.id === rule.templateId && !row.isDeleted && row.isActive);
    if (!template) throw new AppError('RECURRENCE_TARGET_INVALID', 'The template is no longer active.', 409);
    const author = this.state.users.find((row) => row.id === template.createdByUserId && !row.isDeleted);
    if (!author || !this.support.isEligibleUser(template.workspaceId, author.id)) throw new AppError('RECURRENCE_TARGET_INVALID', 'The template author is no longer an active member.', 409);
    let actor: ActorContext;
    try {
      actor = this.support.access.actor(author, template.workspaceId);
    } catch {
      throw new AppError('RECURRENCE_TARGET_INVALID', 'The template author is no longer an active member.', 409);
    }
    if (template.projectId) {
      const project = this.state.projects.find((row) => row.id === template.projectId && !row.isDeleted);
      if (!project || project.status === 'ARCHIVED') throw new AppError('RECURRENCE_TARGET_INVALID', 'The template Project is not available.', 409);
    }
    if (template.defaultResponsibleUserId && !this.support.isEligibleUser(template.workspaceId, template.defaultResponsibleUserId)) {
      throw new AppError('RECURRENCE_TARGET_INVALID', 'The default responsible user is no longer eligible.', 409);
    }
    const nowTs = this.support.now();
    const instanceId = failed?.id ?? this.support.id();
    let instance = this.state.taskRecurrenceInstances.find((row) => row.id === instanceId);
    if (!instance) {
      instance = { id: instanceId, workspaceId: rule.workspaceId, recurrenceRuleId: rule.id, templateId: template.id, taskId: null, scheduledFor, status: 'FAILED', attempts: 0, lastErrorCode: null, createdAt: nowTs, updatedAt: nowTs };
      this.state.taskRecurrenceInstances.push(instance);
    }
    const task = this.materialize(actor, template, { recurrenceInstanceId: instance.id, scheduledFor, timezone: rule.timezone });
    // Replace (not mutate) so an atomicSync rollback restores the previous row exactly.
    Object.assign(instance, { taskId: task.id, status: 'CREATED', attempts: (failed?.attempts ?? 0) + 1, lastErrorCode: null, updatedAt: nowTs });
    this.support.event({ workspaceId: rule.workspaceId, type: 'TASK_RECURRING_INSTANCE_CREATED', entityType: 'TASK', entityId: task.id, actorUserId: null, changes: { ruleId: rule.id, templateId: template.id, scheduledFor: scheduledFor.toISOString() }, idempotencyKey: `task-recurrence:${rule.id}:${scheduledFor.toISOString()}` });
    return task.id;
  }

  private advance(rule: TaskRecurrenceRule, scheduledFor: Date) {
    rule.occurrenceCount = this.state.taskRecurrenceInstances.filter((row) => row.recurrenceRuleId === rule.id && row.status === 'CREATED').length;
    rule.nextRunAt = this.occurrences(rule, scheduledFor, 1)[0] ?? null;
    rule.lastErrorCode = null;
    rule.lastErrorAt = null;
    this.support.touch(rule);
  }

  private recordFailure(rule: TaskRecurrenceRule, scheduledFor: Date, code: string, now: Date) {
    let instance = this.state.taskRecurrenceInstances.find((row) => row.recurrenceRuleId === rule.id && row.scheduledFor.getTime() === scheduledFor.getTime());
    if (!instance) {
      instance = { id: this.support.id(), workspaceId: rule.workspaceId, recurrenceRuleId: rule.id, templateId: rule.templateId, taskId: null, scheduledFor, status: 'FAILED', attempts: 0, lastErrorCode: null, createdAt: now, updatedAt: now };
      this.state.taskRecurrenceInstances.push(instance);
    }
    instance.attempts += 1;
    instance.lastErrorCode = code;
    instance.updatedAt = now;
    rule.lastErrorCode = code;
    rule.lastErrorAt = now;
    // nextRunAt deliberately stays on the failed slot: the retry fills THIS occurrence (same scheduledFor key), never a new one.
    this.support.touch(rule);
    this.support.event({ workspaceId: rule.workspaceId, type: 'TASK_RECURRENCE_FAILED', entityType: 'TASK_TEMPLATE', entityId: rule.templateId, actorUserId: null, changes: { ruleId: rule.id, scheduledFor: scheduledFor.toISOString(), errorCode: code, attempts: instance.attempts } });
  }
}
