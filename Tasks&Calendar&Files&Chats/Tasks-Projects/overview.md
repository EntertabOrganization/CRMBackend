# Tasks & Projects — Domain Overview

## Goal / Scope

Define the complete TrueCRM work-management domain for Projects/Workgroups, Tasks, membership, checklists, dependencies, time tracking, templates/recurrence and Project Kanban/planning. A Task may exist without a Project.

## Ownership / Boundary

This domain owns work units and project collaboration metadata. It integrates with Communication for Task/Project Chat, Calendar for Event/project calendar behavior, Files for attachments/Project Drive, CRM for record bindings, Notifications, Search, Audit, Automation and Analytics. It must call owning application services rather than writing foreign module tables.

## Entities / Fields / Enums

Core tables/aggregates:

```text
projects
project_members
project_tools
project_stages
project_stage_history
tasks
task_members
task_checklists
task_checklist_items
task_dependencies
task_time_entries
task_templates
task_template_members
task_template_checklist_items
task_recurrence_rules
task_recurrence_instances
task_completion_reviews
task_results
task_deadline_history
task_history
task_crm_bindings
```

Key enum contracts:

```text
ProjectType = PROJECT | WORKGROUP
ProjectStatus = PLANNED | ACTIVE | ON_HOLD | COMPLETED | CANCELLED | ARCHIVED
ProjectVisibility = PRIVATE | WORKSPACE_VISIBLE | OPEN | INVITE_ONLY
ProjectRole = OWNER | MODERATOR | MEMBER
TaskStatus = PENDING | IN_PROGRESS | REVIEW | COMPLETED | DEFERRED | CANCELLED
TaskPriority = LOW | NORMAL | HIGH | URGENT
TaskMemberRole = PARTICIPANT | OBSERVER
SubtaskCompletionPolicy = IGNORE | WARN | REQUIRE_ALL
```

`TASK STATUS != PROJECT KANBAN STAGE != PERSONAL PLANNER POSITION`.

## Business Rules / Validation

- Project/Workgroup is a common container differentiated by type/mode.
- Task may have null projectId.
- One Project owner; optional moderators; many members.
- External participants are not ordinary Project members; use Collab.
- Task creator and responsible user are explicit fields; participants/observers are contextual members.
- Task Chat is system-managed Communication content and derives access from Task access.
- Advanced Scrum/Flows are extension points/Phase 2 and must not pollute core Task lifecycle.

## Permissions

- `PROJECT.*`
- `TASK.*`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Domain / Outbox Events

- `TASK_CREATED`
- `TASK_ASSIGNED`
- `TASK_UPDATED`
- `TASK_COMPLETED`
- `TASK_OVERDUE`
- `PROJECT_MEMBER_CHANGED`
- `PROJECT_ARCHIVED`

## Audit Events / Evidence

- `Project/Task critical mutations use central Audit where security/business-critical.`

## Dependencies / Integrations

- Communication
- Calendar
- Files
- CRM bindings
- Notifications
- Search
- Audit
- Automation
- Analytics

## Testing Requirements

- Cross-workspace access is rejected.
- Task status and Project stage stay independent.
- Project tool provisioning is idempotent.
- Task Chat cannot be used to bypass Task access.

## Acceptance Criteria

- A standalone Task can be created and completed.
- A Project can coordinate Tasks without changing Task status when Kanban stage changes.
- Project archive preserves history and makes project-owned resources operationally read-only.
