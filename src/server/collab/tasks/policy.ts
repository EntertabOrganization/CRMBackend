import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import type { CollabSupport } from '../support';
import { notFoundError } from '../support';
import type { Project, ProjectMember, ProjectRole, ProjectToolType, Task } from './types';

/**
 * Contextual authorization for Projects and Tasks. Global permission keys (project.* / task.*) say WHAT an actor may do;
 * the scope (OWN / DEPARTMENT / DEPARTMENT_TREE / WORKSPACE) plus Project role and Task membership say ON WHICH records.
 * Records that exist but are outside the caller's reach are reported exactly like missing ones (no existence leak).
 */
/** Shared owning membership rule; visibility and unrelated Workspace roles never make someone a team member. */
export function projectRoleFor(project: Pick<Project, 'id' | 'workspaceId' | 'ownerUserId'>,
  members: ReadonlyArray<Pick<ProjectMember, 'projectId' | 'workspaceId' | 'userId' | 'status' | 'memberRole'>>, userId: string): ProjectRole | null {
  if (project.ownerUserId === userId) return 'OWNER';
  return members.find(row => row.projectId === project.id && row.workspaceId === project.workspaceId &&
    row.userId === userId && row.status === 'ACTIVE')?.memberRole ?? null;
}

export class TasksPolicy {
  constructor(private readonly support: CollabSupport) {}

  private get state() {
    return this.support.state;
  }

  // ---- Projects -----------------------------------------------------------------------------------------------------

  projectRole(project: Project, userId: string): ProjectRole | null {
    return projectRoleFor(project, this.state.projectMembers, userId);
  }

  isProjectManager(project: Project, userId: string) {
    const role = this.projectRole(project, userId);
    return role === 'OWNER' || role === 'MODERATOR';
  }

  /** Visibility controls discovery only; it never grants mutation rights. */
  canViewProject(actor: ActorContext, project: Project) {
    if (project.workspaceId !== actor.workspaceId) return false;
    if (!this.support.scope(actor, 'project.read')) return false;
    if (this.projectRole(project, actor.user.id)) return true;
    if (actor.role.isOwnerRole) return true;
    return project.visibility !== 'PRIVATE';
  }

  /** Loads a Project visible to the actor (404 PROJECT_NOT_FOUND otherwise). Requires project.read. */
  project(actor: ActorContext, projectId: string, options: { includeDeleted?: boolean } = {}): Project {
    this.support.require(actor, 'project.read');
    const project = this.state.projects.find((row) => row.id === projectId && row.workspaceId === actor.workspaceId);
    if (!project || (project.isDeleted && !options.includeDeleted) || !this.canViewProject(actor, project)) throw notFoundError('PROJECT_NOT_FOUND', 'Project');
    return project;
  }

  /**
   * Project-level management: the permission key plus either a managing Project role (owner/moderator) or a
   * workspace-wide grant of that key. Workspace owners always qualify.
   */
  canManageProject(actor: ActorContext, project: Project, permission: string) {
    const scope = this.support.scope(actor, permission);
    if (!scope) return false;
    if (actor.role.isOwnerRole || scope === 'WORKSPACE') return true;
    return this.isProjectManager(project, actor.user.id);
  }

  requireManageProject(actor: ActorContext, project: Project, permission: string) {
    this.support.require(actor, permission);
    if (!this.canManageProject(actor, project, permission)) throw forbidden(`${permission} requires a managing role in this Project.`);
  }

  assertNotArchived(project: Project) {
    if (project.status === 'ARCHIVED') throw new AppError('PROJECT_ARCHIVED', 'The Project is archived and read-only.', 409);
  }

  isToolEnabled(project: Project, toolType: ProjectToolType) {
    return this.state.projectTools.some((row) => row.projectId === project.id && row.toolType === toolType && row.isEnabled);
  }

  // ---- Tasks --------------------------------------------------------------------------------------------------------

  memberRoles(task: Task, userId: string) {
    return this.state.taskMembers.filter((row) => row.taskId === task.id && row.userId === userId).map((row) => row.role);
  }

  /** Creator, responsible user, participant or observer. */
  isTaskMember(task: Task, userId: string) {
    return task.createdByUserId === userId || task.responsibleUserId === userId || this.memberRoles(task, userId).length > 0;
  }

  /** Creator, responsible user or participant: the people who do the work (observers only watch). */
  isTaskWorker(task: Task, userId: string) {
    return task.createdByUserId === userId || task.responsibleUserId === userId || this.memberRoles(task, userId).includes('PARTICIPANT');
  }

  private projectOf(task: Task) {
    return task.projectId ? this.state.projects.find((row) => row.id === task.projectId && row.workspaceId === task.workspaceId) ?? null : null;
  }

  /** Project managers act on every Task of their Project; plain Project members can see them. */
  private projectContext(task: Task, userId: string) {
    const project = this.projectOf(task);
    if (!project || project.isDeleted) return { project, role: null as ProjectRole | null };
    return { project, role: this.projectRole(project, userId) };
  }

  canViewTask(actor: ActorContext, task: Task) {
    if (task.workspaceId !== actor.workspaceId) return false;
    const scope = this.support.scope(actor, 'task.read');
    if (!scope) return false;
    if (this.isTaskMember(task, actor.user.id)) return true;
    if (this.support.scopeCovers(actor, scope, [task.responsibleUserId, task.createdByUserId])) return true;
    return this.projectContext(task, actor.user.id).role !== null;
  }

  /** Loads a Task visible to the actor (404 TASK_NOT_FOUND otherwise). Requires task.read. */
  task(actor: ActorContext, taskId: string, options: { includeDeleted?: boolean } = {}): Task {
    this.support.require(actor, 'task.read');
    const task = this.state.tasks.find((row) => row.id === taskId && row.workspaceId === actor.workspaceId);
    if (!task || (task.isDeleted && !options.includeDeleted) || !this.canViewTask(actor, task)) throw notFoundError('TASK_NOT_FOUND', 'Task');
    return task;
  }

  /**
   * Can the actor perform `permission` on this Task? The key is always required; then the actor must be in the right
   * relationship: a worker on the Task (or creator for creator-only actions), a managing Project role, or a permission
   * scope that covers the Task's responsible/creator.
   */
  canActOnTask(actor: ActorContext, task: Task, permission: string, relation: 'worker' | 'creator' | 'member' = 'worker') {
    const scope = this.support.scope(actor, permission);
    if (!scope) return false;
    if (actor.role.isOwnerRole) return true;
    const userId = actor.user.id;
    const related =
      relation === 'creator' ? task.createdByUserId === userId
      : relation === 'member' ? this.isTaskMember(task, userId)
      : this.isTaskWorker(task, userId);
    if (related) return true;
    const { role } = this.projectContext(task, userId);
    if (role === 'OWNER' || role === 'MODERATOR') return true;
    return scope !== 'OWN' && this.support.scopeCovers(actor, scope, [task.responsibleUserId, task.createdByUserId]);
  }

  requireTaskAction(actor: ActorContext, task: Task, permission: string, relation: 'worker' | 'creator' | 'member' = 'worker') {
    this.support.require(actor, permission);
    if (!this.canActOnTask(actor, task, permission, relation)) throw forbidden(`${permission} is not granted for this Task.`);
  }

  /** Mutations of a Task inside an archived Project are refused: archive makes project-owned work read-only. */
  assertTaskWritable(task: Task) {
    const project = this.projectOf(task);
    if (project && project.status === 'ARCHIVED') throw new AppError('PROJECT_ARCHIVED', 'The Task belongs to an archived Project and is read-only.', 409);
  }

  /** Users who currently derive access to a Task (drives Task Chat membership). */
  taskAudience(task: Task) {
    const ids = new Set<string>([task.createdByUserId, task.responsibleUserId]);
    for (const row of this.state.taskMembers) if (row.taskId === task.id) ids.add(row.userId);
    return [...ids];
  }
}
