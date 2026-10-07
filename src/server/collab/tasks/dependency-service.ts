import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import type { Body, CollabSupport } from '../support';
import { notFoundError, validationError } from '../support';
import type { TasksPolicy } from './policy';
import type { TaskService } from './task-service';
import type { Task, TaskDependency } from './types';
import { DEPENDENCY_TYPES } from './types';

/**
 * Scheduling dependencies between Tasks. The graph is kept acyclic by a transactional reachability check here and,
 * across application instances, by the database trigger that serializes edge writes per Workspace.
 */
export class DependencyService {
  constructor(private readonly support: CollabSupport, private readonly policy: TasksPolicy, private readonly tasks: TaskService) {}

  private get state() {
    return this.support.state;
  }

  /** Is `to` reachable from `from` following predecessor -> successor edges? */
  private reachable(from: string, to: string) {
    const outgoing = new Map<string, string[]>();
    for (const edge of this.state.taskDependencies) {
      const list = outgoing.get(edge.predecessorTaskId) ?? [];
      list.push(edge.successorTaskId);
      outgoing.set(edge.predecessorTaskId, list);
    }
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const current = queue.shift()!;
      if (current === to) return true;
      for (const next of outgoing.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  private view(actor: ActorContext, edge: TaskDependency) {
    const summary = (id: string) => {
      const task = this.state.tasks.find((row) => row.id === id);
      return task && this.policy.canViewTask(actor, task) ? { id: task.id, title: task.title, status: task.status, startAt: task.startAt, deadlineAt: task.deadlineAt } : { id, hidden: true };
    };
    return { ...edge, predecessor: summary(edge.predecessorTaskId), successor: summary(edge.successorTaskId) };
  }

  list(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    const edges = this.state.taskDependencies.filter((row) => row.predecessorTaskId === task.id || row.successorTaskId === task.id);
    return {
      predecessors: edges.filter((row) => row.successorTaskId === task.id).map((row) => this.view(actor, row)),
      successors: edges.filter((row) => row.predecessorTaskId === task.id).map((row) => this.view(actor, row)),
    };
  }

  private requireManage(actor: ActorContext, task: Task) {
    this.policy.requireTaskAction(actor, task, 'task.dependency_manage');
    this.policy.assertTaskWritable(task);
  }

  /**
   * Body names the OTHER task: `predecessorTaskId` (the path Task becomes its successor) or `successorTaskId`
   * (the path Task becomes its predecessor). Both Tasks must be visible and manageable by the caller.
   */
  add(actor: ActorContext, taskId: string, body: Body) {
    const task = this.policy.task(actor, taskId);
    body.only(['predecessorTaskId', 'successorTaskId', 'type', 'lagSeconds']);
    const predecessorId = body.uuid('predecessorTaskId');
    const successorId = body.uuid('successorTaskId');
    if (Boolean(predecessorId) === Boolean(successorId)) throw validationError('predecessorTaskId', 'Provide exactly one of predecessorTaskId or successorTaskId.');
    const type = body.enumOf('type', DEPENDENCY_TYPES) ?? 'FINISH_START';
    const lag = body.raw.lagSeconds;
    if (lag !== undefined && lag !== null && (typeof lag !== 'number' || !Number.isInteger(lag))) throw validationError('lagSeconds', 'lagSeconds must be an integer.');
    if (typeof lag === 'number' && lag < 0) throw new AppError('TASK_DEPENDENCY_INVALID_LAG', 'Negative lag (lead time) is not supported.', 400);
    if (typeof lag === 'number' && lag > 31_536_000 * 10) throw new AppError('TASK_DEPENDENCY_INVALID_LAG', 'lagSeconds is too large.', 400);
    const otherId = (predecessorId ?? successorId)!;
    if (otherId === task.id) throw new AppError('TASK_DEPENDENCY_SELF', 'A Task cannot depend on itself.', 400);
    const other = this.policy.task(actor, otherId);
    this.requireManage(actor, task);
    this.requireManage(actor, other);
    const predecessor = predecessorId ? other : task;
    const successor = predecessorId ? task : other;
    const duplicate = this.state.taskDependencies.find(
      (row) => (row.predecessorTaskId === predecessor.id && row.successorTaskId === successor.id),
    );
    if (duplicate) throw new AppError('TASK_DEPENDENCY_DUPLICATE', 'This dependency already exists.', 409, { dependencyId: duplicate.id });
    if (this.reachable(successor.id, predecessor.id)) throw new AppError('TASK_DEPENDENCY_CYCLE', 'The dependency would create a cycle.', 409);
    const edge: TaskDependency = {
      id: this.support.id(), workspaceId: task.workspaceId, predecessorTaskId: predecessor.id, successorTaskId: successor.id,
      type, lagSeconds: typeof lag === 'number' ? lag : 0, createdByUserId: actor.user.id, createdAt: this.support.now(),
    };
    this.state.taskDependencies.push(edge);
    for (const row of [predecessor, successor]) this.tasks.history(row, actor.user.id, 'DEPENDENCY_ADDED', 'dependency', null, { dependencyId: edge.id, predecessorTaskId: predecessor.id, successorTaskId: successor.id, type });
    this.tasks.event(actor.user.id, successor, 'TASK_DEPENDENCY_ADDED', { dependencyId: edge.id, predecessorTaskId: predecessor.id, successorTaskId: successor.id, type, lagSeconds: edge.lagSeconds });
    return this.view(actor, edge);
  }

  remove(actor: ActorContext, taskId: string, dependencyId: string) {
    const task = this.policy.task(actor, taskId);
    const edge = this.state.taskDependencies.find((row) => row.id === dependencyId && (row.predecessorTaskId === task.id || row.successorTaskId === task.id));
    if (!edge) throw notFoundError('TASK_DEPENDENCY_NOT_FOUND', 'Task dependency');
    const otherId = edge.predecessorTaskId === task.id ? edge.successorTaskId : edge.predecessorTaskId;
    const other = this.state.tasks.find((row) => row.id === otherId);
    this.requireManage(actor, task);
    this.state.taskDependencies = this.state.taskDependencies.filter((row) => row.id !== edge.id);
    for (const row of [task, other]) if (row) this.tasks.history(row, actor.user.id, 'DEPENDENCY_REMOVED', 'dependency', { dependencyId: edge.id }, null);
    const successor = this.state.tasks.find((row) => row.id === edge.successorTaskId) ?? task;
    this.tasks.event(actor.user.id, successor, 'TASK_DEPENDENCY_REMOVED', { dependencyId: edge.id, predecessorTaskId: edge.predecessorTaskId, successorTaskId: edge.successorTaskId });
    return { id: edge.id, deleted: true };
  }

  /**
   * Connected dependency component around the Task, for Gantt-style read models. Tasks the caller cannot see are
   * returned as opaque `hidden` nodes so the graph shape stays truthful without disclosing content.
   */
  graph(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    const component = new Set<string>([task.id]);
    const queue = [task.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of this.state.taskDependencies) {
        for (const [from, to] of [[edge.predecessorTaskId, edge.successorTaskId], [edge.successorTaskId, edge.predecessorTaskId]]) {
          if (from === current && !component.has(to)) {
            component.add(to);
            queue.push(to);
          }
        }
        if (component.size > 2000) break;
      }
    }
    const nodes = [...component].map((id) => {
      const row = this.state.tasks.find((item) => item.id === id);
      return row && !row.isDeleted && this.policy.canViewTask(actor, row)
        ? { id: row.id, title: row.title, status: row.status, startAt: row.startAt, deadlineAt: row.deadlineAt, plannedDurationSeconds: row.plannedDurationSeconds, hidden: false }
        : { id, hidden: true };
    });
    const edges = this.state.taskDependencies
      .filter((edge) => component.has(edge.predecessorTaskId) && component.has(edge.successorTaskId))
      .map((edge) => ({ id: edge.id, predecessorTaskId: edge.predecessorTaskId, successorTaskId: edge.successorTaskId, type: edge.type, lagSeconds: edge.lagSeconds }));
    return { rootTaskId: task.id, nodes, edges };
  }
}
