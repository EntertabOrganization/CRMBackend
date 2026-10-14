import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { FilePort } from '../../ports';
import { WithMeta } from '../http';
import type { Body, CollabSupport, Json } from '../support';
import { isUuid, notFoundError, pageOf, validationError } from '../support';
import type { TasksPolicy } from './policy';
import type { BindingTargetResolver, TaskChatPort } from './ports';
import type { ProjectService } from './project-service';
import type { Task, TaskMemberRole, TaskResult, TaskStatus } from './types';
import { SUBTASK_POLICIES, TASK_PRIORITIES, TASK_RESULT_TYPES } from './types';

const CRM_BINDING_TYPES = ['LEAD', 'DEAL', 'CONTACT', 'COMPANY'];
const OPEN_STATUSES: TaskStatus[] = ['PENDING', 'IN_PROGRESS', 'REVIEW', 'DEFERRED'];
const EDITABLE_FIELDS = [
  'title', 'description', 'priority', 'responsibleUserId', 'startAt', 'deadlineAt', 'plannedDurationSeconds', 'progressPercent',
  'requiresResult', 'completionControl', 'subtaskCompletionPolicy', 'isTimeTrackingEnabled', 'projectId', 'parentTaskId',
] as const;

/** Allowed lifecycle moves. COMPLETED from REVIEW is only reachable through approval. */
const TRANSITIONS: Record<string, { from: TaskStatus[]; to: TaskStatus }> = {
  start: { from: ['PENDING', 'DEFERRED'], to: 'IN_PROGRESS' },
  defer: { from: ['PENDING', 'IN_PROGRESS'], to: 'DEFERRED' },
  cancel: { from: ['PENDING', 'IN_PROGRESS', 'DEFERRED', 'REVIEW'], to: 'CANCELLED' },
  complete: { from: ['PENDING', 'IN_PROGRESS', 'DEFERRED'], to: 'COMPLETED' },
  reopen: { from: ['COMPLETED', 'CANCELLED'], to: 'PENDING' },
};

export type TaskCreateInput = {
  title: string;
  description?: string | null;
  responsibleUserId?: string;
  priority?: Task['priority'];
  projectId?: string | null;
  parentTaskId?: string | null;
  startAt?: Date | null;
  deadlineAt?: Date | null;
  plannedDurationSeconds?: number | null;
  requiresResult?: boolean;
  completionControl?: boolean;
  subtaskCompletionPolicy?: Task['subtaskCompletionPolicy'];
  isTimeTrackingEnabled?: boolean;
  participantUserIds?: string[];
  observerUserIds?: string[];
  bindings?: Array<{ entityType: string; entityId: string }>;
  templateId?: string | null;
  recurrenceInstanceId?: string | null;
};

export class TaskService {
  private chatPort: TaskChatPort | null = null;
  private readonly bindingResolvers = new Map<string, BindingTargetResolver>();

  constructor(
    private readonly support: CollabSupport,
    private readonly policy: TasksPolicy,
    private readonly projects: ProjectService,
    private readonly files: () => FilePort,
  ) {}

  private get state() {
    return this.support.state;
  }

  setTaskChatPort(port: TaskChatPort | null) {
    this.chatPort = port;
  }

  registerBindingResolver(resolver: BindingTargetResolver) {
    this.bindingResolvers.set(resolver.entityType, resolver);
  }

  // ---- journal ------------------------------------------------------------------------------------------------------

  history(task: Task, actorUserId: string | null, action: string, field: string | null = null, oldValue: unknown = null, newValue: unknown = null) {
    this.state.taskHistory.push({
      id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, action, field,
      oldValue: serialize(oldValue), newValue: serialize(newValue), actorUserId, occurredAt: this.support.now(),
    });
  }

  event(actorUserId: string | null, task: Task, type: string, changes: Json = {}, idempotencyKey?: string | null) {
    this.support.event({
      workspaceId: task.workspaceId, type, entityType: 'TASK', entityId: task.id, actorUserId, changes,
      audienceUserIds: this.policy.taskAudience(task), idempotencyKey,
    });
  }

  /** Task Chat membership is derived from Task access only; re-sync after every access-relevant change. */
  private syncChat(task: Task) {
    this.chatPort?.syncTaskChatAccess(task, this.policy.taskAudience(task));
  }

  view(actor: ActorContext, task: Task) {
    const members = this.state.taskMembers.filter((row) => row.taskId === task.id);
    return {
      ...task,
      participantUserIds: members.filter((row) => row.role === 'PARTICIPANT').map((row) => row.userId),
      observerUserIds: members.filter((row) => row.role === 'OBSERVER').map((row) => row.userId),
      myRoles: this.myRoles(actor, task),
    };
  }

  private myRoles(actor: ActorContext, task: Task) {
    const roles: string[] = [];
    if (task.createdByUserId === actor.user.id) roles.push('CREATOR');
    if (task.responsibleUserId === actor.user.id) roles.push('RESPONSIBLE');
    roles.push(...this.policy.memberRoles(task, actor.user.id));
    return roles;
  }

  // ---- create -------------------------------------------------------------------------------------------------------

  readCreateInput(body: Body): TaskCreateInput {
    body.only([...EDITABLE_FIELDS, 'participantUserIds', 'observerUserIds', 'bindings']);
    const bindingsRaw = body.array('bindings', { max: 50 });
    return {
      title: body.str('title', { required: true, max: 500 }),
      description: body.str('description', { max: 50_000 }),
      responsibleUserId: body.uuid('responsibleUserId') ?? undefined,
      priority: body.enumOf('priority', TASK_PRIORITIES) ?? undefined,
      projectId: body.uuid('projectId'),
      parentTaskId: body.uuid('parentTaskId'),
      startAt: body.instant('startAt'),
      deadlineAt: body.instant('deadlineAt'),
      plannedDurationSeconds: body.int('plannedDurationSeconds', { min: 0, max: 2_000_000_000 }),
      requiresResult: body.bool('requiresResult'),
      completionControl: body.bool('completionControl'),
      subtaskCompletionPolicy: body.enumOf('subtaskCompletionPolicy', SUBTASK_POLICIES) ?? undefined,
      isTimeTrackingEnabled: body.bool('isTimeTrackingEnabled'),
      participantUserIds: body.uuids('participantUserIds', { max: 200 }),
      observerUserIds: body.uuids('observerUserIds', { max: 200 }),
      bindings: bindingsRaw?.map((item, index) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        if (typeof entry.entityType !== 'string' || !isUuid(entry.entityId)) throw validationError(`bindings[${index}]`, 'Each binding needs entityType and a UUID entityId.');
        return { entityType: entry.entityType.toUpperCase(), entityId: entry.entityId.toLowerCase() };
      }),
    };
  }

  createFromRequest(actor: ActorContext, body: Body, idempotencyKey?: string) {
    const key = this.support.idempotencyKey(idempotencyKey);
    const replay = this.support.recall(actor, 'task.create', key, body.raw);
    if (replay) {
      const existing = this.state.tasks.find((row) => row.id === replay.taskId && row.workspaceId === actor.workspaceId);
      if (existing) return this.view(actor, existing);
    }
    const task = this.create(actor, this.readCreateInput(body), key ?? null);
    this.support.remember(actor, 'task.create', key, body.raw, { taskId: task.id });
    return this.view(actor, task);
  }

  private assertEligible(workspaceId: string, userId: string, code: string, field: string) {
    if (!this.support.isEligibleUser(workspaceId, userId)) throw new AppError(code, `${field} must be an active internal member of this Workspace.`, 400, { field, userId });
  }

  /** Validates the Project link: same Workspace, live, writable, Tasks tool enabled, caller participates in it. */
  private resolveProject(actor: ActorContext, projectId: string) {
    const project = this.state.projects.find((row) => row.id === projectId && row.workspaceId === actor.workspaceId && !row.isDeleted);
    if (!project || !this.policy.canViewProject(actor, project)) throw notFoundError('PROJECT_NOT_FOUND', 'Project');
    this.policy.assertNotArchived(project);
    if (!this.policy.isToolEnabled(project, 'TASKS')) throw new AppError('PROJECT_TOOL_DISABLED', 'The Tasks tool is disabled for this Project.', 409);
    const role = this.policy.projectRole(project, actor.user.id);
    if (!role && !actor.role.isOwnerRole && this.support.scope(actor, 'project.update') !== 'WORKSPACE') {
      throw new AppError('TASK_PROJECT_ACCESS_DENIED', 'Only Project members can add Tasks to this Project.', 403);
    }
    return project;
  }

  /** Parent must be a visible live Task of this Workspace, in the same Project, and not a descendant of `taskId`. */
  private resolveParent(actor: ActorContext, parentTaskId: string, projectId: string | null, taskId?: string) {
    const parent = this.state.tasks.find((row) => row.id === parentTaskId && row.workspaceId === actor.workspaceId && !row.isDeleted);
    if (!parent || !this.policy.canViewTask(actor, parent)) throw notFoundError('TASK_NOT_FOUND', 'Parent Task');
    if ((parent.projectId ?? null) !== (projectId ?? null)) throw new AppError('TASK_PROJECT_MISMATCH', 'A subtask must belong to the same Project as its parent.', 409);
    if (taskId) {
      let cursor: Task | undefined = parent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor.id === taskId) throw new AppError('TASK_PARENT_INVALID', 'A Task cannot be its own ancestor.', 400);
        if (seen.has(cursor.id) || !cursor.parentTaskId) break;
        seen.add(cursor.id);
        cursor = this.state.tasks.find((row) => row.id === cursor!.parentTaskId);
      }
    }
    return parent;
  }

  private assertBindable(actor: ActorContext, entityType: string, entityId: string) {
    if (CRM_BINDING_TYPES.includes(entityType)) {
      if (!this.support.access.canAccessCrmRecord(actor, entityType, entityId, 'read')) throw notFoundError('BINDING_TARGET_NOT_FOUND', 'Binding target');
      return;
    }
    const resolver = this.bindingResolvers.get(entityType);
    if (!resolver) throw validationError('entityType', `Binding to ${entityType} is not supported.`, 'BINDING_TYPE_UNSUPPORTED');
    if (!resolver.canBind(actor, entityId)) throw notFoundError('BINDING_TARGET_NOT_FOUND', 'Binding target');
  }

  /** The single creation path (API, subtasks, templates, recurrence, cross-module "create Task from message"). */
  create(actor: ActorContext, input: TaskCreateInput, idempotencyKey: string | null = null): Task {
    this.support.require(actor, 'task.create');
    const workspaceId = actor.workspaceId;
    const responsibleUserId = input.responsibleUserId ?? actor.user.id;
    this.assertEligible(workspaceId, responsibleUserId, 'TASK_RESPONSIBLE_INVALID', 'responsibleUserId');
    for (const userId of [...(input.participantUserIds ?? []), ...(input.observerUserIds ?? [])]) this.assertEligible(workspaceId, userId, 'TASK_MEMBER_INVALID', 'member');
    const project = input.projectId ? this.resolveProject(actor, input.projectId) : null;
    if (input.parentTaskId) this.resolveParent(actor, input.parentTaskId, project?.id ?? null);
    if (input.startAt && input.deadlineAt && input.deadlineAt < input.startAt) throw validationError('deadlineAt', 'deadlineAt must not be before startAt.');
    for (const binding of input.bindings ?? []) this.assertBindable(actor, binding.entityType, binding.entityId);

    const now = this.support.now();
    const task: Task = {
      id: this.support.id(),
      workspaceId,
      projectId: project?.id ?? null,
      projectStageId: null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: 'PENDING',
      priority: input.priority ?? 'NORMAL',
      createdByUserId: actor.user.id,
      responsibleUserId,
      startAt: input.startAt ?? null,
      deadlineAt: input.deadlineAt ?? null,
      plannedDurationSeconds: input.plannedDurationSeconds ?? null,
      progressPercent: 0,
      requiresResult: input.requiresResult ?? false,
      completionControl: input.completionControl ?? false,
      subtaskCompletionPolicy: input.subtaskCompletionPolicy ?? 'WARN',
      isTimeTrackingEnabled: input.isTimeTrackingEnabled ?? false,
      templateId: input.templateId ?? null,
      recurrenceInstanceId: input.recurrenceInstanceId ?? null,
      overdueNotifiedAt: null,
      version: 1,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      completedAt: null,
      completedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    if (project && this.policy.isToolEnabled(project, 'KANBAN')) {
      const stage = this.projects.ensureDefaultStages(project).find((row) => row.isDefault) ?? null;
      if (stage) {
        task.projectStageId = stage.id;
        this.state.projectStageHistory.push({ id: this.support.id(), workspaceId, taskId: task.id, projectId: project.id, oldStageId: null, newStageId: stage.id, movedByUserId: actor.user.id, movedAt: now });
      }
    }
    for (const userId of input.participantUserIds ?? []) this.addMemberRow(task, userId, 'PARTICIPANT', actor.user.id);
    for (const userId of input.observerUserIds ?? []) this.addMemberRow(task, userId, 'OBSERVER', actor.user.id);
    for (const binding of input.bindings ?? []) this.addBindingRow(task, binding.entityType, binding.entityId, actor.user.id);
    this.history(task, actor.user.id, 'CREATED');
    this.event(actor.user.id, task, 'TASK_CREATED', { title: task.title, projectId: task.projectId, responsibleUserId, parentTaskId: task.parentTaskId }, idempotencyKey);
    if (responsibleUserId !== actor.user.id) this.event(actor.user.id, task, 'TASK_ASSIGNED', { responsibleUserId, previousResponsibleUserId: null });
    this.support.audit(actor, workspaceId, 'TASK.CREATED', 'TASK', task.id, null, { title: task.title, responsibleUserId, projectId: task.projectId });
    this.chatPort?.ensureTaskChat(task, this.policy.taskAudience(task), actor.user.id);
    return task;
  }

  // ---- read ---------------------------------------------------------------------------------------------------------

  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'task.read');
    const deleted = query.get('deleted') === 'true';
    if (deleted) this.support.require(actor, 'task.delete');
    const role = query.get('role');
    const userId = actor.user.id;
    const rows = this.state.tasks.filter((task) => {
      if (task.workspaceId !== actor.workspaceId || task.isDeleted !== deleted || !this.policy.canViewTask(actor, task)) return false;
      if (role === 'RESPONSIBLE') return task.responsibleUserId === userId;
      if (role === 'CREATOR') return task.createdByUserId === userId;
      if (role === 'PARTICIPANT' || role === 'OBSERVER') return this.policy.memberRoles(task, userId).includes(role);
      if (role) throw validationError('role', 'role must be RESPONSIBLE, CREATOR, PARTICIPANT or OBSERVER.');
      return true;
    });
    const page = pageOf(rows, query, {
      searchable: ['title', 'description'],
      filterable: ['status', 'priority', 'projectId', 'projectStageId', 'responsibleUserId', 'createdByUserId', 'parentTaskId', 'deadlineAt', 'startAt', 'createdAt', 'templateId'],
      sortable: ['createdAt', 'updatedAt', 'deadlineAt', 'startAt', 'priority', 'status', 'title'],
      defaultSort: 'createdAt',
      defaultOrder: 'desc',
    });
    return { data: page.data.map((task) => this.view(actor, task)), meta: page.meta };
  }

  get(actor: ActorContext, id: string) {
    return this.view(actor, this.policy.task(actor, id));
  }

  // ---- update -------------------------------------------------------------------------------------------------------

  update(actor: ActorContext, id: string, body: Body, replace: boolean, ifMatch?: number) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.update');
    this.policy.assertTaskWritable(task);
    if (body.has('status')) throw validationError('status', 'Status changes use the lifecycle action endpoints (start, defer, complete, ...).', 'TASK_INVALID_STATUS_TRANSITION');
    body.only([...EDITABLE_FIELDS, 'version', 'deadlineChangeReason']);
    this.support.expectVersion(task, body.raw.version ?? ifMatch);
    const pick = <T>(key: (typeof EDITABLE_FIELDS)[number], read: () => T, fallback: T): T => (body.has(key) ? read() : replace ? fallback : (task[key] as unknown as T));
    const next = {
      title: replace || body.has('title') ? body.str('title', { required: true, max: 500 }) : task.title,
      description: pick('description', () => body.str('description', { max: 50_000 }) ?? null, null),
      priority: replace ? body.enumOf('priority', TASK_PRIORITIES, { required: true }) : body.enumOf('priority', TASK_PRIORITIES) ?? task.priority,
      responsibleUserId: replace ? body.uuid('responsibleUserId', { required: true }) : body.uuid('responsibleUserId') ?? task.responsibleUserId,
      startAt: pick('startAt', () => body.instant('startAt') ?? null, null),
      deadlineAt: pick('deadlineAt', () => body.instant('deadlineAt') ?? null, null),
      plannedDurationSeconds: pick('plannedDurationSeconds', () => body.int('plannedDurationSeconds', { min: 0, max: 2_000_000_000 }) ?? null, null),
      progressPercent: pick('progressPercent', () => body.int('progressPercent', { min: 0, max: 100 }) ?? 0, 0),
      requiresResult: pick('requiresResult', () => body.bool('requiresResult') ?? false, false),
      completionControl: pick('completionControl', () => body.bool('completionControl') ?? false, false),
      subtaskCompletionPolicy: pick('subtaskCompletionPolicy', () => body.enumOf('subtaskCompletionPolicy', SUBTASK_POLICIES) ?? 'WARN', 'WARN' as Task['subtaskCompletionPolicy']),
      isTimeTrackingEnabled: pick('isTimeTrackingEnabled', () => body.bool('isTimeTrackingEnabled') ?? false, false),
      projectId: pick('projectId', () => body.uuid('projectId') ?? null, null),
      parentTaskId: pick('parentTaskId', () => body.uuid('parentTaskId') ?? null, null),
    };
    if (next.startAt && next.deadlineAt && next.deadlineAt < next.startAt) throw validationError('deadlineAt', 'deadlineAt must not be before startAt.');
    if (next.responsibleUserId !== task.responsibleUserId) {
      this.policy.requireTaskAction(actor, task, 'task.change_responsible');
      this.assertEligible(task.workspaceId, next.responsibleUserId, 'TASK_RESPONSIBLE_INVALID', 'responsibleUserId');
    }
    const deadlineChanged = (next.deadlineAt?.getTime() ?? null) !== (task.deadlineAt?.getTime() ?? null);
    if (deadlineChanged) this.policy.requireTaskAction(actor, task, 'task.change_deadline');
    if (next.projectId !== task.projectId && next.projectId) this.resolveProject(actor, next.projectId);
    if (next.parentTaskId && (next.parentTaskId !== task.parentTaskId || next.projectId !== task.projectId)) this.resolveParent(actor, next.parentTaskId, next.projectId, task.id);
    if (next.projectId !== task.projectId) {
      const children = this.state.tasks.filter((row) => row.parentTaskId === task.id && !row.isDeleted);
      if (children.length > 0) throw new AppError('TASK_PROJECT_MISMATCH', 'Move subtasks together with their parent or detach them first.', 409);
    }

    const before = { ...task };
    const previousProjectId = task.projectId;
    Object.assign(task, next);
    if (task.projectId !== previousProjectId) this.moveToProject(actor, task, previousProjectId);
    const changed = EDITABLE_FIELDS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(task[key]));
    if (changed.length === 0) return this.view(actor, task);
    this.support.touch(task);
    for (const field of changed) this.history(task, actor.user.id, 'UPDATED', field, before[field], task[field]);
    if (deadlineChanged) this.recordDeadline(actor, task, before.deadlineAt, typeof body.raw.deadlineChangeReason === 'string' ? body.raw.deadlineChangeReason.slice(0, 1000) : null);
    if (before.responsibleUserId !== task.responsibleUserId) this.recordReassignment(actor, task, before.responsibleUserId);
    this.event(actor.user.id, task, 'TASK_UPDATED', { changedFields: changed });
    return this.view(actor, task);
  }

  /** Project change re-places the Task on the new Project's default Kanban stage (Task status is untouched). */
  private moveToProject(actor: ActorContext, task: Task, previousProjectId: string | null) {
    const oldStageId = task.projectStageId;
    task.projectStageId = null;
    const project = task.projectId ? this.state.projects.find((row) => row.id === task.projectId) ?? null : null;
    if (project && this.policy.isToolEnabled(project, 'KANBAN')) {
      const stage = this.projects.ensureDefaultStages(project).find((row) => row.isDefault);
      if (stage) {
        task.projectStageId = stage.id;
        this.state.projectStageHistory.push({ id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, projectId: project.id, oldStageId: previousProjectId ? oldStageId : null, newStageId: stage.id, movedByUserId: actor.user.id, movedAt: this.support.now() });
      }
    }
  }

  private recordDeadline(actor: ActorContext, task: Task, oldDeadline: Date | null, reason: string | null) {
    this.state.taskDeadlineHistory.push({
      id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, oldDeadlineAt: oldDeadline, newDeadlineAt: task.deadlineAt,
      changedByUserId: actor.user.id, reason, changedAt: this.support.now(),
    });
    task.overdueNotifiedAt = null;
    this.event(actor.user.id, task, 'TASK_DEADLINE_CHANGED', { oldDeadlineAt: oldDeadline?.toISOString() ?? null, newDeadlineAt: task.deadlineAt?.toISOString() ?? null });
    this.support.audit(actor, task.workspaceId, 'TASK.DEADLINE_CHANGED', 'TASK', task.id, { deadlineAt: oldDeadline }, { deadlineAt: task.deadlineAt }, { reason });
  }

  private recordReassignment(actor: ActorContext, task: Task, previous: string) {
    this.event(actor.user.id, task, 'TASK_ASSIGNED', { responsibleUserId: task.responsibleUserId, previousResponsibleUserId: previous });
    this.support.audit(actor, task.workspaceId, 'TASK.REASSIGNED', 'TASK', task.id, { responsibleUserId: previous }, { responsibleUserId: task.responsibleUserId });
    this.syncChat(task);
  }

  changeResponsible(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.change_responsible');
    this.policy.assertTaskWritable(task);
    body.only(['responsibleUserId', 'version']);
    this.support.expectVersion(task, body.raw.version ?? ifMatch, false);
    const responsibleUserId = body.uuid('responsibleUserId', { required: true });
    this.assertEligible(task.workspaceId, responsibleUserId, 'TASK_RESPONSIBLE_INVALID', 'responsibleUserId');
    if (responsibleUserId === task.responsibleUserId) return this.view(actor, task);
    const previous = task.responsibleUserId;
    task.responsibleUserId = responsibleUserId;
    this.support.touch(task);
    this.history(task, actor.user.id, 'UPDATED', 'responsibleUserId', previous, responsibleUserId);
    this.recordReassignment(actor, task, previous);
    return this.view(actor, task);
  }

  changeDeadline(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.change_deadline');
    this.policy.assertTaskWritable(task);
    body.only(['deadlineAt', 'reason', 'version']);
    this.support.expectVersion(task, body.raw.version ?? ifMatch, false);
    if (!body.has('deadlineAt') && body.raw.deadlineAt !== null) throw validationError('deadlineAt', 'deadlineAt is required (null clears it).');
    const deadlineAt = body.instant('deadlineAt') ?? null;
    const reason = body.str('reason', { max: 1000 }) ?? null;
    if (deadlineAt && task.startAt && deadlineAt < task.startAt) throw validationError('deadlineAt', 'deadlineAt must not be before startAt.');
    if ((deadlineAt?.getTime() ?? null) === (task.deadlineAt?.getTime() ?? null)) return this.view(actor, task);
    const previous = task.deadlineAt;
    task.deadlineAt = deadlineAt;
    this.support.touch(task);
    this.history(task, actor.user.id, 'UPDATED', 'deadlineAt', previous, deadlineAt);
    this.recordDeadline(actor, task, previous, reason);
    return this.view(actor, task);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------

  private transition(actor: ActorContext, task: Task, action: keyof typeof TRANSITIONS) {
    const rule = TRANSITIONS[action];
    if (!rule.from.includes(task.status)) {
      if (action === 'complete' && task.status === 'REVIEW') throw new AppError('TASK_COMPLETION_REVIEW_REQUIRED', 'The Task is waiting for completion review.', 409);
      throw new AppError('TASK_INVALID_STATUS_TRANSITION', `Cannot ${action} a Task in status ${task.status}.`, 409, { from: task.status, action });
    }
    const previous = task.status;
    task.status = rule.to;
    this.support.touch(task);
    this.history(task, actor.user.id, 'STATUS_CHANGED', 'status', previous, task.status);
    return previous;
  }

  private loadForAction(actor: ActorContext, id: string, body: Body, ifMatch: number | undefined, permission: string, relation: 'worker' | 'creator' | 'member' = 'worker') {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, permission, relation);
    this.policy.assertTaskWritable(task);
    this.support.expectVersion(task, body.raw.version ?? ifMatch, false);
    return task;
  }

  start(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.loadForAction(actor, id, body, ifMatch, 'task.update');
    const previous = this.transition(actor, task, 'start');
    this.event(actor.user.id, task, 'TASK_UPDATED', { status: task.status, previousStatus: previous });
    return this.view(actor, task);
  }

  defer(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.loadForAction(actor, id, body, ifMatch, 'task.update');
    const previous = this.transition(actor, task, 'defer');
    this.event(actor.user.id, task, 'TASK_UPDATED', { status: task.status, previousStatus: previous });
    return this.view(actor, task);
  }

  cancel(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.loadForAction(actor, id, body, ifMatch, 'task.update', 'creator');
    const previous = this.transition(actor, task, 'cancel');
    this.closePendingReview(task, null);
    this.event(actor.user.id, task, 'TASK_CANCELLED', { previousStatus: previous });
    return this.view(actor, task);
  }

  private activeSubtasks(task: Task) {
    return this.state.tasks.filter((row) => row.parentTaskId === task.id && !row.isDeleted && OPEN_STATUSES.includes(row.status));
  }

  /**
   * Completion: subtask policy (IGNORE / WARN / REQUIRE_ALL) and required result are checked first; a completion-controlled
   * Task then enters REVIEW with a review submission instead of completing.
   */
  complete(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.loadForAction(actor, id, body, ifMatch, 'task.complete');
    if (!TRANSITIONS.complete.from.includes(task.status)) this.transition(actor, task, 'complete');
    const openChildren = this.activeSubtasks(task);
    const warnings: Array<{ code: string; message: string; subtaskIds: string[] }> = [];
    if (openChildren.length > 0 && task.subtaskCompletionPolicy === 'REQUIRE_ALL') {
      throw new AppError('TASK_SUBTASKS_INCOMPLETE', 'All subtasks must be completed first.', 409, { subtaskIds: openChildren.map((row) => row.id) });
    }
    if (openChildren.length > 0 && task.subtaskCompletionPolicy === 'WARN') {
      warnings.push({ code: 'TASK_SUBTASKS_INCOMPLETE', message: 'The Task was completed while subtasks are still open.', subtaskIds: openChildren.map((row) => row.id) });
    }
    if (task.requiresResult && !this.state.taskResults.some((row) => row.taskId === task.id)) {
      throw new AppError('TASK_RESULT_REQUIRED', 'Submit at least one result before completing this Task.', 409);
    }
    if (task.completionControl) {
      const previous = task.status;
      task.status = 'REVIEW';
      this.support.touch(task);
      this.history(task, actor.user.id, 'STATUS_CHANGED', 'status', previous, 'REVIEW');
      this.state.taskCompletionReviews.push({
        id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, submittedByUserId: actor.user.id, submittedAt: this.support.now(),
        reviewerUserId: null, decision: 'PENDING', comment: typeof body.raw.comment === 'string' ? body.raw.comment.slice(0, 5000) : null, decidedAt: null,
      });
      this.event(actor.user.id, task, 'TASK_COMPLETION_SUBMITTED', { previousStatus: previous });
      return new WithMeta(this.view(actor, task), { warnings });
    }
    const previous = this.transition(actor, task, 'complete');
    this.markCompleted(task, actor.user.id);
    this.event(actor.user.id, task, 'TASK_COMPLETED', { previousStatus: previous });
    return new WithMeta(this.view(actor, task), { warnings });
  }

  private markCompleted(task: Task, userId: string) {
    task.completedAt = this.support.now();
    task.completedByUserId = userId;
    task.progressPercent = 100;
  }

  private pendingReview(task: Task) {
    return this.state.taskCompletionReviews.filter((row) => row.taskId === task.id && row.decision === 'PENDING').at(-1) ?? null;
  }

  private closePendingReview(task: Task, actorUserId: string | null) {
    const review = this.pendingReview(task);
    if (review) {
      review.decision = 'RETURNED';
      review.reviewerUserId = actorUserId;
      review.decidedAt = this.support.now();
      review.comment = review.comment ?? 'Closed because the Task was cancelled.';
    }
  }

  /** The reviewer is the Task creator (controller), a managing Project role or a workspace-wide task.review grant. */
  review(actor: ActorContext, id: string, body: Body, decision: 'APPROVED' | 'RETURNED', ifMatch?: number) {
    const task = this.loadForAction(actor, id, body, ifMatch, 'task.review', 'creator');
    body.only(['comment', 'version']);
    const comment = body.str('comment', { max: 5000 }) ?? null;
    if (task.status !== 'REVIEW') throw new AppError('TASK_INVALID_STATUS_TRANSITION', 'The Task is not waiting for completion review.', 409, { from: task.status });
    const review = this.pendingReview(task);
    if (review) {
      review.decision = decision;
      review.reviewerUserId = actor.user.id;
      review.decidedAt = this.support.now();
      review.comment = comment ?? review.comment;
    }
    task.status = decision === 'APPROVED' ? 'COMPLETED' : 'IN_PROGRESS';
    if (decision === 'APPROVED') this.markCompleted(task, review?.submittedByUserId ?? actor.user.id);
    this.support.touch(task);
    this.history(task, actor.user.id, 'STATUS_CHANGED', 'status', 'REVIEW', task.status);
    this.event(actor.user.id, task, decision === 'APPROVED' ? 'TASK_COMPLETED' : 'TASK_RETURNED', { reviewId: review?.id ?? null });
    this.support.audit(actor, task.workspaceId, 'TASK.COMPLETION_REVIEWED', 'TASK', task.id, { status: 'REVIEW' }, { status: task.status, decision }, { comment });
    return this.view(actor, task);
  }

  reopen(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const task = this.loadForAction(actor, id, body, ifMatch, 'task.reopen');
    const previous = this.transition(actor, task, 'reopen');
    task.completedAt = null;
    task.completedByUserId = null;
    this.event(actor.user.id, task, 'TASK_REOPENED', { previousStatus: previous });
    return this.view(actor, task);
  }

  // ---- deletion -----------------------------------------------------------------------------------------------------

  /** Removes the dependency edges of a deleted Task so no active dependency points at it. */
  private dropDependencies(task: Task, actorUserId: string) {
    const edges = this.state.taskDependencies.filter((row) => row.predecessorTaskId === task.id || row.successorTaskId === task.id);
    if (edges.length === 0) return;
    this.state.taskDependencies = this.state.taskDependencies.filter((row) => !edges.includes(row));
    for (const edge of edges) {
      for (const id of [edge.predecessorTaskId, edge.successorTaskId]) {
        const other = this.state.tasks.find((row) => row.id === id);
        if (other && other.id !== task.id) this.history(other, actorUserId, 'DEPENDENCY_REMOVED', 'dependency', edge.id, null);
      }
      this.support.event({ workspaceId: task.workspaceId, type: 'TASK_DEPENDENCY_REMOVED', entityType: 'TASK', entityId: edge.successorTaskId, actorUserId, changes: { dependencyId: edge.id, reason: 'TASK_DELETED' } });
    }
  }

  private stopTimers(task: Task) {
    const now = this.support.now();
    for (const entry of this.state.taskTimeEntries.filter((row) => row.taskId === task.id && row.status === 'ACTIVE')) {
      entry.status = 'COMPLETED';
      entry.endedAt = now > entry.startedAt ? now : new Date(entry.startedAt.getTime() + 1000);
      entry.durationSeconds = Math.max(1, Math.round((entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000));
      this.support.touch(entry);
    }
  }

  softDelete(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.delete', 'creator');
    this.policy.assertTaskWritable(task);
    task.isDeleted = true;
    task.deletedAt = this.support.now();
    task.deletedByUserId = actor.user.id;
    this.support.touch(task);
    this.history(task, actor.user.id, 'DELETED');
    this.dropDependencies(task, actor.user.id);
    this.stopTimers(task);
    this.chatPort?.onTaskLifecycle(task, 'DELETED');
    this.event(actor.user.id, task, 'TASK_DELETED', { hard: false });
    this.support.audit(actor, task.workspaceId, 'TASK.SOFT_DELETED', 'TASK', task.id, null, { title: task.title });
    return this.view(actor, task);
  }

  restore(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id, { includeDeleted: true });
    this.policy.requireTaskAction(actor, task, 'task.delete', 'creator');
    if (!task.isDeleted) throw new AppError('TASK_NOT_DELETED', 'The Task is not deleted.', 409);
    if (task.parentTaskId && this.state.tasks.find((row) => row.id === task.parentTaskId)?.isDeleted) {
      throw new AppError('TASK_PARENT_DELETED', 'Restore the parent Task first.', 409);
    }
    task.isDeleted = false;
    task.deletedAt = null;
    task.deletedByUserId = null;
    this.support.touch(task);
    this.history(task, actor.user.id, 'RESTORED');
    this.chatPort?.onTaskLifecycle(task, 'RESTORED');
    this.event(actor.user.id, task, 'TASK_RESTORED');
    this.support.audit(actor, task.workspaceId, 'TASK.RESTORED', 'TASK', task.id, null, { title: task.title });
    return this.view(actor, task);
  }

  /** Permanent purge of a soft-deleted Task and its Task-owned rows. Central Audit keeps the evidence. */
  hardDelete(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id, { includeDeleted: true });
    this.support.require(actor, 'task.hard_delete');
    if (!this.policy.canActOnTask(actor, task, 'task.hard_delete', 'creator')) throw forbidden('task.hard_delete is not granted for this Task.');
    if (!task.isDeleted) throw new AppError('TASK_NOT_DELETED', 'Soft delete the Task before deleting it permanently.', 409);
    if (this.state.tasks.some((row) => row.parentTaskId === task.id)) throw new AppError('TASK_HAS_SUBTASKS', 'Delete or detach the subtasks first.', 409);
    const s = this.state;
    const keep = <T extends { taskId: string | null }>(rows: T[]) => rows.filter((row) => row.taskId !== task.id);
    this.dropDependencies(task, actor.user.id);
    this.chatPort?.onTaskLifecycle(task, 'HARD_DELETED');
    for (const instance of s.taskRecurrenceInstances.filter((row) => row.taskId === task.id)) {
      instance.taskId = null;
      instance.updatedAt = this.support.now();
    }
    s.taskMembers = keep(s.taskMembers);
    s.taskCompletionReviews = keep(s.taskCompletionReviews);
    s.taskResults = keep(s.taskResults);
    s.taskDeadlineHistory = keep(s.taskDeadlineHistory);
    s.taskHistory = keep(s.taskHistory);
    s.taskCrmBindings = keep(s.taskCrmBindings);
    s.taskPlannerPositions = keep(s.taskPlannerPositions);
    s.taskChecklistItems = keep(s.taskChecklistItems);
    s.taskChecklists = keep(s.taskChecklists);
    s.taskTimeEntries = keep(s.taskTimeEntries);
    s.projectStageHistory = keep(s.projectStageHistory);
    s.tasks = s.tasks.filter((row) => row.id !== task.id);
    this.support.event({ workspaceId: task.workspaceId, type: 'TASK_DELETED', entityType: 'TASK', entityId: task.id, actorUserId: actor.user.id, changes: { hard: true } });
    this.support.audit(actor, task.workspaceId, 'TASK.HARD_DELETED', 'TASK', task.id, { title: task.title, projectId: task.projectId }, null);
    return { id: task.id, deleted: true };
  }

  // ---- members ------------------------------------------------------------------------------------------------------

  private addMemberRow(task: Task, userId: string, role: TaskMemberRole, addedBy: string) {
    if (this.state.taskMembers.some((row) => row.taskId === task.id && row.userId === userId && row.role === role)) return false;
    this.state.taskMembers.push({ id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, userId, role, addedByUserId: addedBy, createdAt: this.support.now() });
    return true;
  }

  members(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id);
    const user = (userId: string) => {
      const row = this.state.users.find((item) => item.id === userId);
      return row ? { id: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email } : { id: userId };
    };
    const rows = this.state.taskMembers.filter((row) => row.taskId === task.id);
    return {
      creator: user(task.createdByUserId),
      responsible: user(task.responsibleUserId),
      participants: rows.filter((row) => row.role === 'PARTICIPANT').map((row) => ({ ...user(row.userId), addedByUserId: row.addedByUserId, addedAt: row.createdAt })),
      observers: rows.filter((row) => row.role === 'OBSERVER').map((row) => ({ ...user(row.userId), addedByUserId: row.addedByUserId, addedAt: row.createdAt })),
    };
  }

  addMember(actor: ActorContext, id: string, body: Body, role: TaskMemberRole) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, role === 'PARTICIPANT' ? 'task.add_participant' : 'task.add_observer', 'member');
    this.policy.assertTaskWritable(task);
    body.only(['userId']);
    const userId = body.uuid('userId', { required: true });
    this.assertEligible(task.workspaceId, userId, 'TASK_MEMBER_INVALID', 'userId');
    if (this.addMemberRow(task, userId, role, actor.user.id)) {
      this.history(task, actor.user.id, 'MEMBER_ADDED', role.toLowerCase(), null, userId);
      this.event(actor.user.id, task, 'TASK_UPDATED', { memberAdded: { userId, role } });
      this.syncChat(task);
    }
    return this.members(actor, id);
  }

  removeMember(actor: ActorContext, id: string, userId: string, role: TaskMemberRole) {
    const task = this.policy.task(actor, id);
    if (userId !== actor.user.id) this.policy.requireTaskAction(actor, task, role === 'PARTICIPANT' ? 'task.add_participant' : 'task.add_observer', 'member');
    this.policy.assertTaskWritable(task);
    const row = this.state.taskMembers.find((item) => item.taskId === task.id && item.userId === userId && item.role === role);
    if (!row) throw notFoundError('TASK_MEMBER_NOT_FOUND', 'Task member');
    this.state.taskMembers = this.state.taskMembers.filter((item) => item !== row);
    this.history(task, actor.user.id, 'MEMBER_REMOVED', role.toLowerCase(), userId, null);
    this.event(actor.user.id, task, 'TASK_UPDATED', { memberRemoved: { userId, role } });
    this.syncChat(task);
    return this.policy.canViewTask(actor, task) ? this.members(actor, id) : { removed: true };
  }

  // ---- results ------------------------------------------------------------------------------------------------------

  results(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id);
    return this.state.taskResults.filter((row) => row.taskId === task.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  addResult(actor: ActorContext, id: string, body: Body) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.result_submit');
    this.policy.assertTaskWritable(task);
    body.only(['resultType', 'textValue', 'fileId', 'url']);
    const resultType = body.enumOf('resultType', TASK_RESULT_TYPES, { required: true });
    const result: TaskResult = {
      id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, resultType, textValue: null, fileId: null, url: null,
      submittedByUserId: actor.user.id, createdAt: this.support.now(),
    };
    if (resultType === 'TEXT') result.textValue = body.str('textValue', { required: true, max: 50_000 });
    if (resultType === 'LINK') {
      const url = body.str('url', { required: true, max: 2000 });
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw validationError('url', 'url must be an http(s) URL.');
      result.url = url;
    }
    if (resultType === 'FILE') {
      const fileId = body.uuid('fileId', { required: true });
      const check = this.files().check(task.workspaceId, actor, fileId);
      if (check === 'UNAVAILABLE') throw new AppError('FILE_SERVICE_UNAVAILABLE', 'File references are not available.', 503);
      if (check !== 'OK') throw notFoundError('FILE_NOT_FOUND', 'File');
      result.fileId = fileId;
    }
    this.state.taskResults.push(result);
    this.history(task, actor.user.id, 'RESULT_ADDED', 'result', null, { resultId: result.id, resultType });
    this.event(actor.user.id, task, 'TASK_UPDATED', { resultAdded: result.id });
    return result;
  }

  // ---- history ------------------------------------------------------------------------------------------------------

  historyList(actor: ActorContext, id: string, query: URLSearchParams) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.history_view', 'member');
    return pageOf(this.state.taskHistory.filter((row) => row.taskId === task.id), query, {
      searchable: [], filterable: ['action', 'field', 'actorUserId'], sortable: ['occurredAt'], defaultSort: 'occurredAt', defaultOrder: 'asc',
    });
  }

  deadlineHistory(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.history_view', 'member');
    return this.state.taskDeadlineHistory.filter((row) => row.taskId === task.id).sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  }

  // ---- subtasks -----------------------------------------------------------------------------------------------------

  subtasks(actor: ActorContext, id: string, query: URLSearchParams) {
    const task = this.policy.task(actor, id);
    const rows = this.state.tasks.filter((row) => row.parentTaskId === task.id && !row.isDeleted && this.policy.canViewTask(actor, row));
    const page = pageOf(rows, query, { searchable: ['title'], filterable: ['status', 'responsibleUserId'], sortable: ['createdAt', 'deadlineAt', 'status', 'title'], defaultSort: 'createdAt' });
    return { data: page.data.map((row) => this.view(actor, row)), meta: page.meta };
  }

  createSubtask(actor: ActorContext, id: string, body: Body, idempotencyKey?: string) {
    const parent = this.policy.task(actor, id);
    this.policy.assertTaskWritable(parent);
    const input = this.readCreateInput(body);
    if (input.parentTaskId && input.parentTaskId !== parent.id) throw validationError('parentTaskId', 'parentTaskId is taken from the URL.');
    if (input.projectId !== undefined && (input.projectId ?? null) !== (parent.projectId ?? null)) throw new AppError('TASK_PROJECT_MISMATCH', 'A subtask must belong to the same Project as its parent.', 409);
    const key = this.support.idempotencyKey(idempotencyKey);
    const replay = this.support.recall(actor, `task.subtask:${parent.id}`, key, body.raw);
    if (replay) {
      const existing = this.state.tasks.find((row) => row.id === replay.taskId);
      if (existing) return this.view(actor, existing);
    }
    const task = this.create(actor, { ...input, parentTaskId: parent.id, projectId: parent.projectId }, key ?? null);
    this.history(parent, actor.user.id, 'SUBTASK_ADDED', 'subtask', null, task.id);
    this.support.remember(actor, `task.subtask:${parent.id}`, key, body.raw, { taskId: task.id });
    return this.view(actor, task);
  }

  // ---- bindings -----------------------------------------------------------------------------------------------------

  private addBindingRow(task: Task, entityType: string, entityId: string, userId: string) {
    const existing = this.state.taskCrmBindings.find((row) => row.taskId === task.id && row.entityType === entityType && row.entityId === entityId);
    if (existing) return existing;
    const row = { id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, entityType, entityId, createdByUserId: userId, createdAt: this.support.now() };
    this.state.taskCrmBindings.push(row);
    return row;
  }

  bindings(actor: ActorContext, id: string) {
    const task = this.policy.task(actor, id);
    return this.state.taskCrmBindings.filter((row) => row.taskId === task.id && (CRM_BINDING_TYPES.includes(row.entityType)
      ? this.support.access.canAccessCrmRecord(actor, row.entityType, row.entityId, 'read')
      : (this.bindingResolvers.get(row.entityType)?.canRead ?? this.bindingResolvers.get(row.entityType)?.canBind)?.(actor, row.entityId)));
  }

  addBinding(actor: ActorContext, id: string, body: Body) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.update', 'member');
    this.policy.assertTaskWritable(task);
    body.only(['entityType', 'entityId']);
    const entityType = body.str('entityType', { required: true, max: 50 }).toUpperCase();
    const entityId = body.uuid('entityId', { required: true });
    this.assertBindable(actor, entityType, entityId);
    const before = this.state.taskCrmBindings.length;
    const row = this.addBindingRow(task, entityType, entityId, actor.user.id);
    if (this.state.taskCrmBindings.length !== before) {
      this.history(task, actor.user.id, 'BINDING_ADDED', 'binding', null, { entityType, entityId });
      this.event(actor.user.id, task, 'TASK_UPDATED', { bindingAdded: { entityType, entityId } });
    }
    return row;
  }

  removeBinding(actor: ActorContext, id: string, bindingId: string) {
    const task = this.policy.task(actor, id);
    this.policy.requireTaskAction(actor, task, 'task.update', 'member');
    this.policy.assertTaskWritable(task);
    const row = this.state.taskCrmBindings.find((item) => item.id === bindingId && item.taskId === task.id);
    if (!row) throw notFoundError('TASK_BINDING_NOT_FOUND', 'Task binding');
    this.state.taskCrmBindings = this.state.taskCrmBindings.filter((item) => item !== row);
    this.history(task, actor.user.id, 'BINDING_REMOVED', 'binding', { entityType: row.entityType, entityId: row.entityId }, null);
    this.event(actor.user.id, task, 'TASK_UPDATED', { bindingRemoved: { entityType: row.entityType, entityId: row.entityId } });
    return { id: row.id, deleted: true };
  }

  // ---- overdue sweep (scheduler) ------------------------------------------------------------------------------------

  /** Emits TASK_OVERDUE once per deadline (a deadline change re-arms it). Idempotent under retried/duplicated runs. */
  runOverdueSweep(now = this.support.now()) {
    let flagged = 0;
    for (const task of this.state.tasks) {
      if (task.isDeleted || !task.deadlineAt || task.overdueNotifiedAt || !OPEN_STATUSES.includes(task.status) || task.deadlineAt > now) continue;
      task.overdueNotifiedAt = now;
      this.support.touch(task);
      this.event(null, task, 'TASK_OVERDUE', { deadlineAt: task.deadlineAt.toISOString() }, `task-overdue:${task.id}:${task.deadlineAt.toISOString()}`);
      flagged += 1;
    }
    return { flagged };
  }
}

function serialize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
