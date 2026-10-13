# Task Dependencies Specification

## Goal / Scope

Implement scheduling dependencies and a dependency graph that cannot contain cycles.

## Ownership / Boundary

`TaskDependenciesController` owns dependency edges; Tasks remain owning aggregates for execution state.

## Entities / Fields / Enums

```text
task_dependencies:
 id, workspaceId, predecessorTaskId, successorTaskId,
 type, lagSeconds, createdByUserId, createdAt

DependencyType = FINISH_START | START_START | FINISH_FINISH | START_FINISH
```

Default UI may favor FINISH_START, but the data/API supports all four scheduling relationships.

## API Endpoints

```text
GET    /api/v1/tasks/:taskId/dependencies
POST   /api/v1/tasks/:taskId/dependencies
DELETE /api/v1/tasks/:taskId/dependencies/:dependencyId
GET    /api/v1/tasks/:taskId/dependency-graph
```

## Business Rules / Validation

- Predecessor and successor must differ.
- Both Tasks must be same Workspace and mutually accessible for dependency management.
- Adding edge performs graph cycle detection transactionally against current graph.
- Duplicate semantic edge is rejected/idempotently returned according to repository convention.
- Lag may be positive/zero; negative lead time is allowed only if repository/business calendar supports it explicitly—default reject negative lag.
- Deleting a Task must not leave dangling active dependency rows.

## Permissions

- `TASK.READ`
- `TASK.DEPENDENCY_MANAGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `TASK_DEPENDENCY_CYCLE`
- `TASK_DEPENDENCY_SELF`
- `TASK_DEPENDENCY_DUPLICATE`
- `TASK_DEPENDENCY_INVALID_LAG`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `TASK_DEPENDENCY_ADDED`
- `TASK_DEPENDENCY_REMOVED`

## Audit Events / Evidence

- `Dependency add/remove is included in Task history.`

## Dependencies / Integrations

- Tasks
- Business Calendar/Gantt projection

## Testing Requirements

- Direct cycle.
- Indirect multi-hop cycle.
- Race on concurrent edge creation.
- Cross-workspace edge rejection.

## Acceptance Criteria

- Dependency cycles are impossible even under concurrent writes.
- Gantt/read models can rebuild from durable edges.
