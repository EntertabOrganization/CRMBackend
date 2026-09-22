# Stage Specification

## Goal

Implement stable ordered stages with semantic meaning independent from display name.

## Suggested fields

- id UUID
- workspaceId
- pipelineId
- name
- position/order
- semanticType = PROGRESS | SUCCESS | FAILURE
- isDefault
- isActive
- createdAt
- updatedAt
- version

## Stable identity

Rename/reorder never changes stage ID.

Historical stage rows continue referencing the same stage ID.

## Name/order

Active stage names should be unique inside a pipeline unless the existing repository has a stronger equivalent identifier model.

Stage order is configurable, but semantic validity remains required.

Recommended visual/processing ordering groups PROGRESS before SUCCESS/FAILURE where UI policy needs it; the authoritative rule is semantic type, not name.

## Default stage

Every active pipeline has exactly one default stage.

Default stage must be PROGRESS.

Creating a record in a specified pipeline without stage uses that default.

## Semantic counts

Active pipeline:

- one or more PROGRESS
- exactly one SUCCESS
- one or more FAILURE

## Deactivation

Stage with live current records cannot be deactivated without replacement migration.

Historical references are preserved.

## Acceptance criteria

- rename/reorder preserve stable ID
- default stage invariant enforced
- exactly one SUCCESS enforced transactionally
- deletion/migration does not rewrite history
- stage cannot move between pipelines by mutating its parent ID if that would corrupt history; use explicit admin workflow if such feature is ever added
