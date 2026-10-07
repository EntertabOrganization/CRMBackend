import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import type { Body, CollabSupport } from '../support';
import { notFoundError, validationError } from '../support';
import type { TasksPolicy } from './policy';
import type { TaskService } from './task-service';
import type { Task, TaskChecklist, TaskChecklistItem } from './types';

/**
 * Lightweight, possibly nested checklists of a Task. A checklist item is NOT a Task: no lifecycle, Chat, time tracking
 * or history of its own, and completing every item never completes the Task.
 */
export class ChecklistService {
  constructor(private readonly support: CollabSupport, private readonly policy: TasksPolicy, private readonly tasks: TaskService) {}

  private get state() {
    return this.support.state;
  }

  /** Checklist rows carry their own versions; the Task row is not rewritten, so Task edits never conflict with ticks. */
  private changed(actor: ActorContext, task: Task, change: string, data: Record<string, unknown>) {
    this.tasks.history(task, actor.user.id, 'CHECKLIST_CHANGED', 'checklist', null, { change, ...data });
    this.tasks.event(actor.user.id, task, 'TASK_CHECKLIST_CHANGED', { change, ...data });
  }

  private requireManage(actor: ActorContext, task: Task) {
    this.policy.requireTaskAction(actor, task, 'task.checklist_manage');
    this.policy.assertTaskWritable(task);
  }

  /** Items in depth-first tree order: each parent is followed by its children, siblings ordered by sortOrder. */
  private items(checklistId: string) {
    const rows = this.state.taskChecklistItems.filter((row) => row.checklistId === checklistId);
    const ordered: TaskChecklistItem[] = [];
    const visit = (parentId: string | null) => {
      for (const row of rows.filter((item) => item.parentItemId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))) {
        ordered.push(row);
        visit(row.id);
      }
    };
    visit(null);
    return ordered;
  }

  /** Checklist + items; the parent Task must be visible to the caller (otherwise indistinguishable from missing). */
  private checklist(actor: ActorContext, id: string) {
    const checklist = this.state.taskChecklists.find((row) => row.id === id && row.workspaceId === actor.workspaceId);
    if (!checklist) throw notFoundError('CHECKLIST_NOT_FOUND', 'Checklist');
    const task = this.state.tasks.find((row) => row.id === checklist.taskId && !row.isDeleted);
    if (!task || !this.support.scope(actor, 'task.read') || !this.policy.canViewTask(actor, task)) throw notFoundError('CHECKLIST_NOT_FOUND', 'Checklist');
    return { checklist, task };
  }

  private item(actor: ActorContext, id: string) {
    const item = this.state.taskChecklistItems.find((row) => row.id === id && row.workspaceId === actor.workspaceId);
    if (!item) throw notFoundError('CHECKLIST_ITEM_NOT_FOUND', 'Checklist item');
    const task = this.state.tasks.find((row) => row.id === item.taskId && !row.isDeleted);
    if (!task || !this.support.scope(actor, 'task.read') || !this.policy.canViewTask(actor, task)) throw notFoundError('CHECKLIST_ITEM_NOT_FOUND', 'Checklist item');
    return { item, task };
  }

  view(checklist: TaskChecklist) {
    const items = this.items(checklist.id);
    return { ...checklist, items, completedCount: items.filter((row) => row.isCompleted).length, totalCount: items.length };
  }

  /** The assignee must be an active internal member who can see the Task. */
  private assertAssignable(task: Task, userId: string) {
    const user = this.state.users.find((row) => row.id === userId && !row.isDeleted);
    if (!user || !this.support.isEligibleUser(task.workspaceId, userId) || !this.policy.canViewTask(this.support.access.actor(user, task.workspaceId), task)) {
      throw new AppError('CHECKLIST_ASSIGNEE_INVALID', 'The assignee must be an active Workspace member who can see the Task.', 400, { userId });
    }
  }

  list(actor: ActorContext, taskId: string) {
    const task = this.policy.task(actor, taskId);
    return this.state.taskChecklists.filter((row) => row.taskId === task.id).sort((a, b) => a.sortOrder - b.sortOrder).map((row) => this.view(row));
  }

  create(actor: ActorContext, taskId: string, body: Body) {
    const task = this.policy.task(actor, taskId);
    this.requireManage(actor, task);
    body.only(['name', 'sortOrder', 'items']);
    const name = body.str('name', { required: true, max: 200 });
    const existing = this.state.taskChecklists.filter((row) => row.taskId === task.id);
    const now = this.support.now();
    const checklist: TaskChecklist = {
      id: this.support.id(), workspaceId: task.workspaceId, taskId: task.id, name,
      sortOrder: body.int('sortOrder', { min: 0, max: 1_000_000_000 }) ?? (Math.max(0, ...existing.map((row) => row.sortOrder)) + 100), version: 1, createdAt: now, updatedAt: now,
    };
    const initial = body.array('items', { max: 500 }) ?? [];
    const parsed = initial.map((raw, index) => {
      const entry = (raw ?? {}) as Record<string, unknown>;
      if (typeof entry.title !== 'string' || !entry.title.trim()) throw validationError(`items[${index}].title`, 'title is required.');
      if (entry.assignedUserId !== undefined && entry.assignedUserId !== null) this.assertAssignable(task, String(entry.assignedUserId));
      return { title: entry.title.trim().slice(0, 1000), assignedUserId: (entry.assignedUserId as string | undefined) ?? null };
    });
    this.state.taskChecklists.push(checklist);
    parsed.forEach((entry, index) => this.state.taskChecklistItems.push(this.newItem(checklist, null, entry.title, entry.assignedUserId, (index + 1) * 100)));
    this.changed(actor, task, 'CHECKLIST_CREATED', { checklistId: checklist.id });
    return this.view(checklist);
  }

  get(actor: ActorContext, id: string) {
    return this.view(this.checklist(actor, id).checklist);
  }

  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const { checklist, task } = this.checklist(actor, id);
    this.requireManage(actor, task);
    body.only(['name', 'sortOrder', 'version']);
    this.support.expectVersion(checklist, body.raw.version ?? ifMatch);
    const name = body.str('name', { max: 200 });
    if (name === '') throw validationError('name', 'name must not be empty.');
    if (name) checklist.name = name;
    const sortOrder = body.int('sortOrder', { min: 0, max: 1_000_000_000 });
    if (sortOrder !== undefined && sortOrder !== null) checklist.sortOrder = sortOrder;
    this.support.touch(checklist);
    this.changed(actor, task, 'CHECKLIST_UPDATED', { checklistId: checklist.id });
    return this.view(checklist);
  }

  remove(actor: ActorContext, id: string) {
    const { checklist, task } = this.checklist(actor, id);
    this.requireManage(actor, task);
    this.state.taskChecklistItems = this.state.taskChecklistItems.filter((row) => row.checklistId !== checklist.id);
    this.state.taskChecklists = this.state.taskChecklists.filter((row) => row.id !== checklist.id);
    this.changed(actor, task, 'CHECKLIST_DELETED', { checklistId: checklist.id, name: checklist.name });
    return { id: checklist.id, deleted: true };
  }

  private newItem(checklist: TaskChecklist, parentItemId: string | null, title: string, assignedUserId: string | null, sortOrder: number): TaskChecklistItem {
    const now = this.support.now();
    return {
      id: this.support.id(), workspaceId: checklist.workspaceId, checklistId: checklist.id, taskId: checklist.taskId, parentItemId, title, assignedUserId,
      isCompleted: false, completedByUserId: null, completedAt: null, sortOrder, version: 1, createdAt: now, updatedAt: now,
    };
  }

  addItem(actor: ActorContext, checklistId: string, body: Body) {
    const { checklist, task } = this.checklist(actor, checklistId);
    this.requireManage(actor, task);
    body.only(['title', 'assignedUserId', 'parentItemId', 'sortOrder']);
    const title = body.str('title', { required: true, max: 1000 });
    const assignedUserId = body.uuid('assignedUserId') ?? null;
    if (assignedUserId) this.assertAssignable(task, assignedUserId);
    const parentItemId = body.uuid('parentItemId') ?? null;
    if (parentItemId && !this.state.taskChecklistItems.some((row) => row.id === parentItemId && row.checklistId === checklist.id)) throw notFoundError('CHECKLIST_ITEM_NOT_FOUND', 'Parent checklist item');
    const siblings = this.items(checklist.id).filter((row) => row.parentItemId === parentItemId);
    const item = this.newItem(checklist, parentItemId, title, assignedUserId, body.int('sortOrder', { min: 0, max: 1_000_000_000 }) ?? (Math.max(0, ...siblings.map((row) => row.sortOrder)) + 100));
    this.state.taskChecklistItems.push(item);
    this.changed(actor, task, 'ITEM_ADDED', { checklistId: checklist.id, itemId: item.id });
    return item;
  }

  updateItem(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const { item, task } = this.item(actor, id);
    this.requireManage(actor, task);
    body.only(['title', 'assignedUserId', 'version']);
    this.support.expectVersion(item, body.raw.version ?? ifMatch);
    const title = body.str('title', { max: 1000 });
    if (title === '') throw validationError('title', 'title must not be empty.');
    if (title) item.title = title;
    if (body.has('assignedUserId') || body.raw.assignedUserId === null) {
      const assignedUserId = body.uuid('assignedUserId') ?? null;
      if (assignedUserId) this.assertAssignable(task, assignedUserId);
      item.assignedUserId = assignedUserId;
    }
    this.support.touch(item);
    this.changed(actor, task, 'ITEM_UPDATED', { itemId: item.id });
    return item;
  }

  private descendants(item: TaskChecklistItem): TaskChecklistItem[] {
    const children = this.state.taskChecklistItems.filter((row) => row.parentItemId === item.id);
    return children.flatMap((child) => [child, ...this.descendants(child)]);
  }

  /** Items with children are kept unless the caller explicitly asks for a cascade delete. */
  removeItem(actor: ActorContext, id: string, query: URLSearchParams) {
    const { item, task } = this.item(actor, id);
    this.requireManage(actor, task);
    const subtree = this.descendants(item);
    if (subtree.length > 0 && query.get('cascade') !== 'true') throw new AppError('CHECKLIST_HAS_CHILDREN', 'The item has child items. Pass cascade=true to delete them too.', 409, { childCount: subtree.length });
    const removed = new Set([item.id, ...subtree.map((row) => row.id)]);
    this.state.taskChecklistItems = this.state.taskChecklistItems.filter((row) => !removed.has(row.id));
    this.changed(actor, task, 'ITEM_DELETED', { itemId: item.id, removedCount: removed.size });
    return { id: item.id, deleted: true, removedCount: removed.size };
  }

  /** Moves an item (with its subtree) under a new parent / checklist of the same Task. Cycles are rejected. */
  moveItem(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const { item, task } = this.item(actor, id);
    this.requireManage(actor, task);
    body.only(['checklistId', 'parentItemId', 'sortOrder', 'version']);
    this.support.expectVersion(item, body.raw.version ?? ifMatch, false);
    const checklistId = body.uuid('checklistId') ?? item.checklistId;
    const target = this.state.taskChecklists.find((row) => row.id === checklistId && row.taskId === task.id);
    if (!target) throw notFoundError('CHECKLIST_NOT_FOUND', 'Checklist');
    const parentItemId = body.has('parentItemId') ? body.uuid('parentItemId') ?? null : body.raw.parentItemId === null ? null : item.parentItemId;
    const subtree = this.descendants(item);
    if (parentItemId) {
      if (parentItemId === item.id || subtree.some((row) => row.id === parentItemId)) throw new AppError('CHECKLIST_HIERARCHY_CYCLE', 'An item cannot be moved under itself or one of its descendants.', 409);
      const parent = this.state.taskChecklistItems.find((row) => row.id === parentItemId);
      if (!parent || parent.checklistId !== target.id) throw notFoundError('CHECKLIST_ITEM_NOT_FOUND', 'Parent checklist item');
    }
    const sortOrder = body.int('sortOrder', { required: true, min: 0, max: 1_000_000_000 });
    item.parentItemId = parentItemId;
    item.sortOrder = sortOrder;
    item.checklistId = target.id;
    this.support.touch(item);
    for (const row of subtree) {
      if (row.checklistId !== target.id) {
        row.checklistId = target.id;
        this.support.touch(row);
      }
    }
    this.changed(actor, task, 'ITEM_MOVED', { itemId: item.id, checklistId: target.id, parentItemId });
    return item;
  }

  /** Completion records actor/time. Workers and the item's assignee may complete it. */
  setCompleted(actor: ActorContext, id: string, completed: boolean, body: Body) {
    const { item, task } = this.item(actor, id);
    this.support.require(actor, 'task.checklist_complete');
    if (item.assignedUserId !== actor.user.id) this.policy.requireTaskAction(actor, task, 'task.checklist_complete');
    this.policy.assertTaskWritable(task);
    this.support.expectVersion(item, body.raw.version, false);
    if (item.isCompleted === completed) return item;
    item.isCompleted = completed;
    item.completedByUserId = completed ? actor.user.id : null;
    item.completedAt = completed ? this.support.now() : null;
    this.support.touch(item);
    this.tasks.history(task, actor.user.id, completed ? 'CHECKLIST_ITEM_COMPLETED' : 'CHECKLIST_ITEM_REOPENED', 'checklistItem', null, item.id);
    if (completed) this.tasks.event(actor.user.id, task, 'TASK_CHECKLIST_ITEM_COMPLETED', { itemId: item.id, checklistId: item.checklistId });
    else this.tasks.event(actor.user.id, task, 'TASK_CHECKLIST_CHANGED', { change: 'ITEM_REOPENED', itemId: item.id });
    return item;
  }
}
