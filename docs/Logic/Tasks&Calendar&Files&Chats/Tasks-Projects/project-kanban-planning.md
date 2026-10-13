# Project Kanban & Planning Specification

## Goal / Scope

Implement per-Project configurable Kanban stages and personal/planning read metadata without conflating either with Task status.

## Ownership / Boundary

`ProjectStagesController` owns Project stage configuration, ordering and stage movement. TaskService owns Task status.

## Entities / Fields / Enums

```text
project_stages:
 id, workspaceId, projectId, name, code, sortOrder,
 isDefault, isTerminalVisualStage, version, isDeleted

project_stage_history:
 id, workspaceId, taskId, projectId,
 oldStageId nullable, newStageId, movedByUserId, movedAt
```
Personal Planner positions are user-specific metadata/read-model state and must not mutate Task status or Project stage for other users.

## API Endpoints

```text
GET    /api/v1/projects/:projectId/stages
POST   /api/v1/projects/:projectId/stages
GET    /api/v1/project-stages/:id
PATCH  /api/v1/project-stages/:id
DELETE /api/v1/project-stages/:id
PATCH  /api/v1/projects/:projectId/stages/reorder
POST   /api/v1/tasks/:taskId/project-stage
GET    /api/v1/tasks/:taskId/project-stage-history
GET    /api/v1/tasks/planner
PUT    /api/v1/tasks/:taskId/planner-position
```

## Business Rules / Validation

- Each active Project with Kanban enabled has at least one stage/default stage.
- Moving Task stage validates Task belongs to Project and caller Project/Task permissions.
- Stage movement never directly changes TaskStatus.
- Deleting stage with Tasks requires migration target or is rejected.
- Stage order updates atomically.
- Personal Planner changes only caller-specific metadata.

## Permissions

- `PROJECT.STAGE_MANAGE`
- `PROJECT.TASK_MOVE_STAGE`
- `TASK.READ`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `PROJECT_STAGE_NOT_FOUND`
- `PROJECT_STAGE_IN_USE`
- `PROJECT_STAGE_REQUIRED`
- `TASK_PROJECT_MISMATCH`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `PROJECT_STAGE_CHANGED`
- `TASK_PROJECT_STAGE_CHANGED`

## Audit Events / Evidence

- `Project stage configuration changes may be audited; Task stage history is durable domain evidence.`

## Dependencies / Integrations

- Tasks
- Project configuration
- Analytics/Gantt projections

## Testing Requirements

- Delete in-use stage.
- Reorder race/version conflict.
- Ensure stage move does not change Task status.

## Acceptance Criteria

- Kanban can be customized without corrupting core Task lifecycle.
- Personal planner movement affects only that user.
