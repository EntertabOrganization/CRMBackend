# Pipeline Specification

## Goal

Implement configurable Workspace-scoped pipelines for both Leads and Deals through one reusable engine.

## Entity types

```text
LEAD
DEAL
```

A pipeline can serve exactly one entity type.

## Suggested fields

- id UUID
- workspaceId
- entityType
- name
- normalizedName / case-insensitive uniqueness strategy
- isDefault
- isActive
- transitionRulesEnabled or equivalent explicit mode where useful
- createdAt
- updatedAt
- version

## Uniqueness

Active pipeline names are case-insensitively unique within:

```text
workspaceId + entityType
```

`LEAD -> Sales` and `DEAL -> Sales` may coexist.

## Default pipelines

Exactly one active default pipeline per Workspace for LEAD and one for DEAL.

Workspace bootstrap creates:

```text
Default Lead Pipeline
Default Deal Pipeline
```

with the default stage sets defined in Agent.md.

If creating a Lead/Deal without `pipelineId`, use the default pipeline for the corresponding entity type.

## Structure validity

Every active pipeline must have:

- >= 1 PROGRESS stage
- exactly 1 SUCCESS stage
- >= 1 FAILURE stage
- exactly 1 default stage
- default stage semantic = PROGRESS

Do not leave an active pipeline in an invalid structural state after an admin mutation.

## Administration

Use `crm.pipeline.read` and `crm.pipeline.manage` rather than hard-coding all operations to Workspace Owner.

Protected/default constraints still apply.

## Deactivation/deletion

Normal removal is deactivation.

A pipeline with current records requires explicit migration mapping before deactivation.

The last/default pipeline for an entity type cannot disappear until another valid default exists.

Historical references retain old pipeline IDs.

## Acceptance criteria

- multiple LEAD pipelines work
- multiple DEAL pipelines work
- exactly one default per type
- case-insensitive name uniqueness works
- invalid stage structure cannot become active
- entity type mismatch is rejected
- deactivation with current records requires migration
