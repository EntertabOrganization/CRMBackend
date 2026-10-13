# Task Time Tracking Specification

## Goal / Scope

Implement manual time entries and timer-style work sessions for Tasks.

## Ownership / Boundary

`TaskTimeEntriesController` owns actual effort records. Planned duration belongs to Task; actual entries are appendable/editable under permission and policy.

## Entities / Fields / Enums

```text
task_time_entries:
 id, workspaceId, taskId, userId,
 startedAt, endedAt nullable, durationSeconds,
 source MANUAL|TIMER, note nullable,
 status ACTIVE|COMPLETED,
 version, createdAt, updatedAt
```
Only one active timer per user per Task; repository may enforce one active task timer globally if existing policy already does so.

## API Endpoints

```text
GET    /api/v1/tasks/:taskId/time-entries
POST   /api/v1/tasks/:taskId/time-entries
GET    /api/v1/task-time-entries/:id
PATCH  /api/v1/task-time-entries/:id
DELETE /api/v1/task-time-entries/:id
POST   /api/v1/tasks/:taskId/timer/start
POST   /api/v1/tasks/:taskId/timer/stop
GET    /api/v1/tasks/:taskId/time-summary
```

## Business Rules / Validation

- Time tracking must be enabled on Task.
- Ended time must be after started time.
- Manual duration must be positive and consistent with timestamps where both supplied.
- User cannot edit another user entry without elevated permission.
- Timer stop calculates durable duration and is idempotent against repeated client retry.
- Completed/archived Task time edits follow permission policy; default allow authorized correction but audit material corrections.

## Permissions

- `TASK.READ`
- `TASK.TIME_ADD`
- `TASK.TIME_EDIT_OWN`
- `TASK.TIME_EDIT_ALL`
- `TASK.TIME_DELETE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `TASK_TIME_TRACKING_DISABLED`
- `TIME_ENTRY_INVALID_RANGE`
- `TIME_ENTRY_ACTIVE_TIMER_EXISTS`
- `TIME_ENTRY_NOT_FOUND`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `TIME_ENTRY_RECORDED`
- `TIME_ENTRY_UPDATED`
- `TIME_TIMER_STARTED`
- `TIME_TIMER_STOPPED`

## Audit Events / Evidence

- `Administrative edits/deletes of another user time entry are audited.`

## Dependencies / Integrations

- Tasks
- Analytics
- Notifications optional

## Testing Requirements

- Timer double-start.
- Retry stop.
- Invalid time range.
- Own vs all edit permission.

## Acceptance Criteria

- Actual effort is queryable per Task/user.
- Retries do not duplicate timer entries.
