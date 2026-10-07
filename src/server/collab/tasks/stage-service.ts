import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { Body, CollabSupport } from '../support';
import { notFoundError, pageOf, validationError } from '../support';
import type { TasksPolicy } from './policy';
import type { TaskService } from './task-service';
import type { Project, ProjectStage } from './types';

/**
 * Project Kanban stages are per-Project visual columns. Moving a Task between stages records stage history and NEVER
 * changes Task status; the Personal Planner is per-user metadata that changes nothing for anyone else.
 */
export class StageService {
  constructor(
    private readonly support: CollabSupport,
    private readonly policy: TasksPolicy,
    private readonly tasks: TaskService,
  ) {}

  private get state() {
    return this.support.state;
  }

  private liveStages(projectId: string) {
    return this.state.projectStages.filter((row) => row.projectId === projectId && !row.isDeleted).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  }

  private stage(actor: ActorContext, id: string): { stage: ProjectStage; project: Project } {
    const stage = this.state.projectStages.find((row) => row.id === id && row.workspaceId === actor.workspaceId && !row.isDeleted);
    if (!stage) throw notFoundError('PROJECT_STAGE_NOT_FOUND', 'Project stage');
    const project = this.state.projects.find((row) => row.id === stage.projectId && !row.isDeleted);
    if (!project || !this.policy.canViewProject(actor, project)) throw notFoundError('PROJECT_STAGE_NOT_FOUND', 'Project stage');
    return { stage, project };
  }

  private requireManage(actor: ActorContext, project: Project) {
    this.policy.requireManageProject(actor, project, 'project.stage_manage');
    this.policy.assertNotArchived(project);
    if (!this.policy.isToolEnabled(project, 'KANBAN')) throw new AppError('PROJECT_TOOL_DISABLED', 'The Kanban tool is disabled for this Project.', 409);
  }

  private stageChanged(actor: ActorContext, project: Project, stage: ProjectStage, change: string) {
    this.support.event({ workspaceId: project.workspaceId, type: 'PROJECT_STAGE_CHANGED', entityType: 'PROJECT', entityId: project.id, actorUserId: actor.user.id, changes: { stageId: stage.id, change } });
    this.support.audit(actor, project.workspaceId, `PROJECT.STAGE_${change}`, 'PROJECT_STAGE', stage.id, null, { name: stage.name, code: stage.code, sortOrder: stage.sortOrder, isDefault: stage.isDefault });
  }

  private uniqueCode(projectId: string, raw: string, exceptId?: string) {
    const base = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'STAGE';
    const taken = new Set(this.liveStages(projectId).filter((row) => row.id !== exceptId).map((row) => row.code));
    if (!taken.has(base)) return base;
    for (let index = 2; ; index += 1) if (!taken.has(`${base}_${index}`)) return `${base}_${index}`;
  }

  private setDefault(project: Project, stage: ProjectStage) {
    for (const other of this.liveStages(project.id)) {
      if (other.id !== stage.id && other.isDefault) {
        other.isDefault = false;
        this.support.touch(other);
      }
    }
    stage.isDefault = true;
  }

  list(actor: ActorContext, projectId: string) {
    const project = this.policy.project(actor, projectId);
    return this.liveStages(project.id);
  }

  create(actor: ActorContext, projectId: string, body: Body) {
    const project = this.policy.project(actor, projectId);
    this.requireManage(actor, project);
    body.only(['name', 'code', 'sortOrder', 'isDefault', 'isTerminalVisualStage']);
    const name = body.str('name', { required: true, max: 100 });
    const requestedCode = body.str('code', { max: 40 });
    if (requestedCode && this.liveStages(project.id).some((row) => row.code === requestedCode.toUpperCase())) throw new AppError('PROJECT_STAGE_CODE_CONFLICT', 'Another stage already uses this code.', 409);
    const stages = this.liveStages(project.id);
    const now = this.support.now();
    const stage: ProjectStage = {
      id: this.support.id(), workspaceId: project.workspaceId, projectId: project.id, name,
      code: requestedCode ? this.uniqueCode(project.id, requestedCode) : this.uniqueCode(project.id, name),
      sortOrder: body.int('sortOrder', { min: 0, max: 1_000_000_000 }) ?? ((stages.at(-1)?.sortOrder ?? 0) + 100),
      isDefault: false, isTerminalVisualStage: body.bool('isTerminalVisualStage') ?? false, version: 1, isDeleted: false, createdAt: now, updatedAt: now,
    };
    this.state.projectStages.push(stage);
    if (body.bool('isDefault') || stages.length === 0) this.setDefault(project, stage);
    this.stageChanged(actor, project, stage, 'CREATED');
    return stage;
  }

  get(actor: ActorContext, id: string) {
    return this.stage(actor, id).stage;
  }

  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const { stage, project } = this.stage(actor, id);
    this.requireManage(actor, project);
    body.only(['name', 'code', 'isDefault', 'isTerminalVisualStage', 'version']);
    this.support.expectVersion(stage, body.raw.version ?? ifMatch);
    const name = body.str('name', { max: 100 });
    if (name === '') throw validationError('name', 'name must not be empty.');
    const code = body.str('code', { max: 40 });
    const isDefault = body.bool('isDefault');
    if (isDefault === false && stage.isDefault) throw new AppError('PROJECT_STAGE_REQUIRED', 'Choose another default stage instead of unsetting the current one.', 409);
    if (code) {
      const normalized = code.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      if (this.liveStages(project.id).some((row) => row.id !== stage.id && row.code === normalized)) throw new AppError('PROJECT_STAGE_CODE_CONFLICT', 'Another stage already uses this code.', 409);
      stage.code = normalized;
    }
    if (name) stage.name = name;
    const terminal = body.bool('isTerminalVisualStage');
    if (terminal !== undefined) stage.isTerminalVisualStage = terminal;
    if (isDefault) this.setDefault(project, stage);
    this.support.touch(stage);
    this.stageChanged(actor, project, stage, 'UPDATED');
    return stage;
  }

  /** In-use stages need an explicit migration target; the last live stage of a Kanban Project cannot be removed. */
  remove(actor: ActorContext, id: string, query: URLSearchParams, body: Body) {
    const { stage, project } = this.stage(actor, id);
    this.requireManage(actor, project);
    const live = this.liveStages(project.id);
    if (live.length <= 1) throw new AppError('PROJECT_STAGE_REQUIRED', 'A Kanban Project needs at least one stage.', 409);
    const targetId = query.get('migrateToStageId') ?? (typeof body.raw.migrateToStageId === 'string' ? body.raw.migrateToStageId : null);
    const tasks = this.state.tasks.filter((row) => row.projectStageId === stage.id && !row.isDeleted);
    let target: ProjectStage | null = null;
    if (targetId) {
      target = live.find((row) => row.id === targetId && row.id !== stage.id) ?? null;
      if (!target) throw notFoundError('PROJECT_STAGE_NOT_FOUND', 'Migration target stage');
    }
    if (tasks.length > 0 && !target) throw new AppError('PROJECT_STAGE_IN_USE', 'Tasks are still on this stage. Provide migrateToStageId.', 409, { taskCount: tasks.length });
    const now = this.support.now();
    // Soft-deleted Tasks also leave the stage so no row keeps pointing at a removed stage.
    for (const task of this.state.tasks.filter((row) => row.projectStageId === stage.id)) {
      const destination = target ?? live.find((row) => row.id !== stage.id && row.isDefault) ?? live.find((row) => row.id !== stage.id)!;
      task.projectStageId = destination.id;
      this.support.touch(task);
      this.state.projectStageHistory.push({ id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, projectId: project.id, oldStageId: stage.id, newStageId: destination.id, movedByUserId: actor.user.id, movedAt: now });
      this.tasks.history(task, actor.user.id, 'PROJECT_STAGE_CHANGED', 'projectStageId', stage.id, destination.id);
    }
    stage.isDeleted = true;
    const wasDefault = stage.isDefault;
    stage.isDefault = false;
    this.support.touch(stage);
    if (wasDefault) {
      const next = target ?? live.find((row) => row.id !== stage.id)!;
      next.isDefault = true;
      this.support.touch(next);
    }
    this.stageChanged(actor, project, stage, 'DELETED');
    return { id: stage.id, deleted: true, migratedTaskCount: tasks.length, migratedToStageId: target?.id ?? null };
  }

  /**
   * Atomic reorder: the caller sends every live stage with the version it saw. Any stale version rejects the whole
   * reorder with RESOURCE_VERSION_CONFLICT, so two concurrent reorders cannot interleave.
   */
  reorder(actor: ActorContext, projectId: string, body: Body) {
    const project = this.policy.project(actor, projectId);
    this.requireManage(actor, project);
    body.only(['stages']);
    const items = body.array('stages', { required: true, max: 500 })!;
    const live = this.liveStages(project.id);
    const parsed = items.map((item, index) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.version !== 'number') throw validationError(`stages[${index}]`, 'Each entry needs id and version.');
      return { id: entry.id, version: entry.version };
    });
    const ids = parsed.map((item) => item.id);
    if (new Set(ids).size !== ids.length || ids.length !== live.length || !live.every((row) => ids.includes(row.id))) {
      throw validationError('stages', 'The reorder must list every live stage of the Project exactly once.');
    }
    for (const item of parsed) this.support.expectVersion(live.find((row) => row.id === item.id)!, item.version);
    parsed.forEach((item, index) => {
      const stage = live.find((row) => row.id === item.id)!;
      const sortOrder = (index + 1) * 100;
      if (stage.sortOrder !== sortOrder) {
        stage.sortOrder = sortOrder;
        this.support.touch(stage);
      }
    });
    this.support.event({ workspaceId: project.workspaceId, type: 'PROJECT_STAGE_CHANGED', entityType: 'PROJECT', entityId: project.id, actorUserId: actor.user.id, changes: { change: 'REORDERED', stageIds: ids } });
    return this.liveStages(project.id);
  }

  /** Moves a Task to another Kanban column of ITS Project. Task status is deliberately left untouched. */
  moveTask(actor: ActorContext, taskId: string, body: Body, ifMatch?: number) {
    const task = this.policy.task(actor, taskId);
    body.only(['stageId', 'version']);
    const stageId = body.uuid('stageId', { required: true });
    this.support.require(actor, 'project.task_move_stage');
    if (!task.projectId) throw new AppError('TASK_PROJECT_MISMATCH', 'The Task does not belong to a Project.', 409);
    const project = this.state.projects.find((row) => row.id === task.projectId && !row.isDeleted);
    if (!project) throw notFoundError('PROJECT_NOT_FOUND', 'Project');
    const stage = this.state.projectStages.find((row) => row.id === stageId && row.workspaceId === actor.workspaceId && !row.isDeleted);
    if (!stage) throw notFoundError('PROJECT_STAGE_NOT_FOUND', 'Project stage');
    if (stage.projectId !== task.projectId) throw new AppError('TASK_PROJECT_MISMATCH', 'The stage belongs to another Project.', 409);
    const role = this.policy.projectRole(project, actor.user.id);
    if (!role && !actor.role.isOwnerRole && this.support.scope(actor, 'project.task_move_stage') !== 'WORKSPACE' && !this.policy.isTaskWorker(task, actor.user.id)) {
      throw forbidden('Only Project members or Task workers can move this Task.');
    }
    this.policy.assertNotArchived(project);
    if (!this.policy.isToolEnabled(project, 'KANBAN')) throw new AppError('PROJECT_TOOL_DISABLED', 'The Kanban tool is disabled for this Project.', 409);
    this.support.expectVersion(task, body.raw.version ?? ifMatch, false);
    if (task.projectStageId === stage.id) return { task: this.tasks.view(actor, task), stage };
    const oldStageId = task.projectStageId;
    task.projectStageId = stage.id;
    this.support.touch(task);
    this.state.projectStageHistory.push({ id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, projectId: project.id, oldStageId, newStageId: stage.id, movedByUserId: actor.user.id, movedAt: this.support.now() });
    this.tasks.history(task, actor.user.id, 'PROJECT_STAGE_CHANGED', 'projectStageId', oldStageId, stage.id);
    this.tasks.event(actor.user.id, task, 'TASK_PROJECT_STAGE_CHANGED', { projectId: project.id, oldStageId, newStageId: stage.id });
    return { task: this.tasks.view(actor, task), stage };
  }

  stageHistory(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    return this.state.projectStageHistory.filter((row) => row.taskId === task.id).sort((a, b) => a.movedAt.getTime() - b.movedAt.getTime());
  }

  // ---- personal planner ---------------------------------------------------------------------------------------------

  planner(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'task.read');
    const positions = this.state.taskPlannerPositions.filter((row) => row.userId === actor.user.id && row.workspaceId === actor.workspaceId);
    const rows = positions.flatMap((position) => {
      const task = this.state.tasks.find((row) => row.id === position.taskId && !row.isDeleted);
      return task && this.policy.canViewTask(actor, task) ? [{ id: position.id, taskId: task.id, plannerColumn: position.plannerColumn, sortOrder: position.sortOrder, updatedAt: position.updatedAt, task: this.tasks.view(actor, task) }] : [];
    });
    return pageOf(rows, query, { searchable: [], filterable: ['plannerColumn'], sortable: ['sortOrder', 'updatedAt'], defaultSort: 'sortOrder' });
  }

  setPlannerPosition(actor: ActorContext, taskId: string, body: Body) {
    const task = this.policy.task(actor, taskId);
    body.only(['plannerColumn', 'sortOrder']);
    const plannerColumn = body.str('plannerColumn', { required: true, max: 100 });
    const sortOrder = body.int('sortOrder', { required: true, min: 0, max: 1_000_000_000 });
    let row = this.state.taskPlannerPositions.find((item) => item.userId === actor.user.id && item.taskId === task.id);
    if (!row) {
      row = { id: this.support.id(), workspaceId: task.workspaceId, userId: actor.user.id, taskId: task.id, plannerColumn, sortOrder, updatedAt: this.support.now() };
      this.state.taskPlannerPositions.push(row);
    } else {
      row.plannerColumn = plannerColumn;
      row.sortOrder = sortOrder;
      row.updatedAt = this.support.now();
    }
    return row;
  }
}
