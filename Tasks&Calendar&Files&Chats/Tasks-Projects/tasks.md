# Tasks — Core Specification

## Goal / Scope

Implement Task CRUD, lifecycle, assignment/membership, completion control, results, deadline history and CRM/general bindings.

## Ownership / Boundary

`TasksController` owns Task resource operations and Task state transitions. Task Chat messages remain Communication-owned.

## Entities / Fields / Enums

Suggested `tasks` fields:

```text
id UUID
workspaceId UUID
projectId UUID nullable
projectStageId UUID nullable
parentTaskId UUID nullable
title string
description text nullable
status TaskStatus
priority TaskPriority
createdByUserId UUID
responsibleUserId UUID
startAt timestamptz nullable
deadlineAt timestamptz nullable
plannedDurationSeconds bigint nullable
progressPercent int 0..100
requiresResult boolean
completionControl boolean
subtaskCompletionPolicy SubtaskCompletionPolicy
isTimeTrackingEnabled boolean
templateId UUID nullable
recurrenceInstanceId UUID nullable
version int
isDeleted boolean
completedAt timestamptz nullable
completedByUserId UUID nullable
```

`task_members`: PARTICIPANT/OBSERVER only. Creator and responsible are explicit fields.

`task_completion_reviews`: submission, reviewer, decision APPROVED/RETURNED, comment/timestamps.

`task_results`: TEXT | FILE | LINK result with submitter/timestamp.

`task_deadline_history`: old/new deadline, changer, reason.

## API Endpoints

```text
POST   /api/v1/tasks
GET    /api/v1/tasks
GET    /api/v1/tasks/:id
PUT    /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id
DELETE /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id/restore
DELETE /api/v1/tasks/:id/hard
POST   /api/v1/tasks/:id/start
POST   /api/v1/tasks/:id/defer
POST   /api/v1/tasks/:id/cancel
POST   /api/v1/tasks/:id/complete
POST   /api/v1/tasks/:id/reopen
POST   /api/v1/tasks/:id/completion-review/approve
POST   /api/v1/tasks/:id/completion-review/return
GET    /api/v1/tasks/:id/members
POST   /api/v1/tasks/:id/participants
DELETE /api/v1/tasks/:id/participants/:userId
POST   /api/v1/tasks/:id/observers
DELETE /api/v1/tasks/:id/observers/:userId
PATCH  /api/v1/tasks/:id/responsible
GET    /api/v1/tasks/:id/results
POST   /api/v1/tasks/:id/results
GET    /api/v1/tasks/:id/history
GET    /api/v1/tasks/:id/deadline-history
PATCH  /api/v1/tasks/:id/deadline
GET    /api/v1/tasks/:id/subtasks
POST   /api/v1/tasks/:id/subtasks
GET    /api/v1/tasks/:id/bindings
POST   /api/v1/tasks/:id/bindings
DELETE /api/v1/tasks/:id/bindings/:bindingId
```

## Business Rules / Validation

- Task can exist without Project.
- Project Task must reference an active Project in the same Workspace.
- Parent task must be same Workspace; if project-bound, parent/child must follow configured project consistency rule (default same Project unless explicitly moved through service).
- Status lifecycle uses PENDING, IN_PROGRESS, REVIEW, COMPLETED, DEFERRED, CANCELLED.
- `complete` on completion-controlled Task creates/updates review submission and enters REVIEW; direct COMPLETED is not allowed until approval.
- RETURN from REVIEW re-enters IN_PROGRESS.
- Completion enforces subtask policy: IGNORE allows; WARN returns warning/meta but allows; REQUIRE_ALL rejects while active children remain.
- If `requiresResult=true`, completion submission requires at least one valid Task result.
- Deadline change records history and emits event.
- Optimistic version check applies to mutation.
- Soft-deleted Task excluded from normal reads; hard delete requires prior soft delete and dedicated permission.

## Permissions

- `TASK.CREATE`
- `TASK.READ`
- `TASK.UPDATE`
- `TASK.DELETE`
- `TASK.HARD_DELETE`
- `TASK.COMPLETE`
- `TASK.REOPEN`
- `TASK.REVIEW`
- `TASK.CHANGE_DEADLINE`
- `TASK.CHANGE_RESPONSIBLE`
- `TASK.ADD_PARTICIPANT`
- `TASK.ADD_OBSERVER`
- `TASK.RESULT_SUBMIT`
- `TASK.HISTORY_VIEW`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `TASK_NOT_FOUND`
- `TASK_INVALID_STATUS_TRANSITION`
- `TASK_RESULT_REQUIRED`
- `TASK_SUBTASKS_INCOMPLETE`
- `TASK_COMPLETION_REVIEW_REQUIRED`
- `TASK_RESPONSIBLE_INVALID`
- `TASK_PROJECT_ACCESS_DENIED`
- `RESOURCE_VERSION_CONFLICT`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `TASK_CREATED`
- `TASK_UPDATED`
- `TASK_ASSIGNED`
- `TASK_DEADLINE_CHANGED`
- `TASK_COMPLETION_SUBMITTED`
- `TASK_COMPLETED`
- `TASK_RETURNED`
- `TASK_REOPENED`
- `TASK_CANCELLED`
- `TASK_DELETED`
- `TASK_RESTORED`

## Audit Events / Evidence

- `TASK.CREATED`
- `TASK.REASSIGNED`
- `TASK.DEADLINE_CHANGED`
- `TASK.COMPLETION_REVIEWED`
- `TASK.SOFT_DELETED`
- `TASK.HARD_DELETED`
- `TASK.RESTORED`

## Dependencies / Integrations

- Project access policy
- Communication Task Chat provisioning/access
- Files for results/attachments
- CRM/general bindings
- Notifications
- Outbox

## Testing Requirements

- Valid lifecycle including controlled completion.
- Invalid transitions rejected.
- Result-required completion.
- Subtask policy.
- Cross-workspace relation rejection.
- Stale version conflict.
- Soft delete/restore/hard delete permission.
- Task Chat provisioning is idempotent after creation.

## Acceptance Criteria

- Task lifecycle is deterministic and testable.
- Creator/responsible/participants/observers have distinct semantics.
- Project Kanban movement never silently rewrites Task status.
- No Task Chat membership can survive solely from a removed Task-derived access source.
