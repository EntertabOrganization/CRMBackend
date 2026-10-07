# Task Templates & Recurrence Specification

## Goal / Scope

Implement reusable Task templates and recurrence rules that create independent Task instances exactly once per scheduled occurrence.

## Ownership / Boundary

`TaskTemplatesController` owns template CRUD, instantiate-now behavior and recurrence configuration. A recurrence run creates an ordinary Task through TaskService; generated Tasks are not special mutable template proxies.

## Entities / Fields / Enums

```text
task_templates:
 id, workspaceId, scopeType, scopeId nullable, name,
 titleTemplate, descriptionTemplate, projectId nullable,
 defaultResponsibleUserId, priority, deadlineOffsetSeconds,
 plannedDurationSeconds, isTimeTrackingEnabled, completionControl,
 subtaskCompletionPolicy, isActive, version

task_recurrence_rules:
 id, workspaceId, templateId, frequency, intervalValue,
 daysOfWeek, dayOfMonth, startDate, endDate nullable,
 maxOccurrences nullable, creationLocalTime, timezone,
 nextRunAt, isActive, version

task_recurrence_instances:
 id, workspaceId, recurrenceRuleId, templateId, taskId,
 scheduledFor
 UNIQUE(recurrenceRuleId, scheduledFor)
```
Frequency: DAILY | WEEKLY | MONTHLY | YEARLY.

## API Endpoints

```text
POST   /api/v1/task-templates
GET    /api/v1/task-templates
GET    /api/v1/task-templates/:id
PUT    /api/v1/task-templates/:id
PATCH  /api/v1/task-templates/:id
DELETE /api/v1/task-templates/:id
POST   /api/v1/task-templates/:id/instantiate
GET    /api/v1/task-templates/:id/recurrence
PUT    /api/v1/task-templates/:id/recurrence
PATCH  /api/v1/task-templates/:id/recurrence
DELETE /api/v1/task-templates/:id/recurrence
POST   /api/v1/task-templates/:id/recurrence/run-due-preview
```

## Business Rules / Validation

- Templates can include participants, observers, checklist structure, files by reference where authorized and subtask templates.
- Recurrence stores an IANA timezone and preserves local schedule semantics across DST.
- Scheduler retries are deduped by unique scheduled occurrence.
- Each generated Task has independent members, results, Chat, time entries, history and state.
- Editing template does not retroactively rewrite existing Task instances.
- If responsible/project becomes ineligible, recurrence run fails visibly and retries according to job policy; it must not create partial duplicate Tasks.

## Permissions

- `TASK_TEMPLATE.CREATE`
- `TASK_TEMPLATE.READ`
- `TASK_TEMPLATE.UPDATE`
- `TASK_TEMPLATE.DELETE`
- `TASK_TEMPLATE.RECURRENCE_MANAGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `TASK_TEMPLATE_NOT_FOUND`
- `RECURRENCE_INVALID_RULE`
- `RECURRENCE_TARGET_INVALID`
- `RECURRENCE_DUPLICATE_INSTANCE`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `TASK_TEMPLATE_CREATED`
- `TASK_RECURRENCE_CHANGED`
- `TASK_RECURRING_INSTANCE_CREATED`
- `TASK_RECURRENCE_FAILED`

## Audit Events / Evidence

- `Template/recurrence configuration changes are audited when material.`

## Dependencies / Integrations

- TaskService
- Scheduler/jobs
- Files references
- Project access

## Testing Requirements

- Duplicate scheduler delivery.
- DST/local-time recurrence.
- Template update vs existing instances.
- Failed run retry.

## Acceptance Criteria

- Exactly one Task per scheduled occurrence.
- Generated Task behaves exactly like a normal Task thereafter.
