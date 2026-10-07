# Task Checklists Specification

## Goal / Scope

Implement one or more named Task checklists with hierarchical lightweight checklist items, assignment and ordering.

## Ownership / Boundary

`TaskChecklistsController` owns checklist structure and completion state. A checklist item is not a Task and does not get independent Task lifecycle/history/Chat/time tracking.

## Entities / Fields / Enums

```text
task_checklists:
 id, workspaceId, taskId, name, sortOrder, version

task_checklist_items:
 id, workspaceId, checklistId, taskId, parentItemId nullable,
 title, assignedUserId nullable, isCompleted, completedByUserId nullable,
 completedAt nullable, sortOrder, version
```

Hierarchy may be nested. Cycles/self-parent are invalid.

## API Endpoints

```text
GET    /api/v1/tasks/:taskId/checklists
POST   /api/v1/tasks/:taskId/checklists
GET    /api/v1/task-checklists/:id
PATCH  /api/v1/task-checklists/:id
DELETE /api/v1/task-checklists/:id
POST   /api/v1/task-checklists/:id/items
PATCH  /api/v1/task-checklist-items/:id
DELETE /api/v1/task-checklist-items/:id
PATCH  /api/v1/task-checklist-items/:id/move
POST   /api/v1/task-checklist-items/:id/complete
POST   /api/v1/task-checklist-items/:id/reopen
```

## Business Rules / Validation

- Checklist parent Task must be active and accessible.
- Assigned checklist user must be an eligible same-Workspace user with Task visibility.
- Moving an item cannot make itself/descendant its parent.
- Deleting a parent item requires explicit cascade/reparent behavior; default reject if active children unless caller explicitly requests supported cascade.
- Completing checklist item records actor/time.
- Checklist completion does not itself complete Task.

## Permissions

- `TASK.READ`
- `TASK.UPDATE`
- `TASK.CHECKLIST_MANAGE`
- `TASK.CHECKLIST_COMPLETE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `CHECKLIST_NOT_FOUND`
- `CHECKLIST_ITEM_NOT_FOUND`
- `CHECKLIST_HIERARCHY_CYCLE`
- `CHECKLIST_HAS_CHILDREN`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `TASK_CHECKLIST_CHANGED`
- `TASK_CHECKLIST_ITEM_COMPLETED`

## Audit Events / Evidence

- `Checklist structural changes may be reflected in Task history; central Audit only where policy classifies it as material.`

## Dependencies / Integrations

- Tasks
- Notifications optional

## Testing Requirements

- Nested item cycle rejection.
- Ordering/move behavior.
- Assignment eligibility.
- Completion/reopen.
- Cross-workspace isolation.

## Acceptance Criteria

- Checklist remains lightweight and distinct from Subtask.
- Hierarchy is cycle-safe.
- Unauthorized users cannot infer checklist content.
