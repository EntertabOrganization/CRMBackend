# Pipeline & Stage Migration Specification

## Goal

Prevent destructive pipeline/stage configuration changes from corrupting current CRM records or history.

## Stage migration

If a stage has current Leads/Deals, removal requires explicit replacement stage.

Validate:

- same Workspace
- compatible entity type
- target configuration valid/active
- permission to manage pipeline
- mapping does not violate required business constraints

Then transaction/job logic:

1. validate full migration request
2. move current records
3. append Lead/Deal stage history
4. update versions/current state
5. deactivate old stage
6. write audit/outbox

Historical rows keep old stage ID.

## Pipeline migration

If a pipeline has current records, admin supplies full mapping:

```text
oldStageA -> targetPipeline/targetStageA
oldStageB -> targetPipeline/targetStageB
...
```

Validate complete mapping before changing any record.

Do not partially migrate then discover an unmapped current stage.

After migration, deactivate old pipeline/stages according to repository lifecycle convention.

## Default protection

- cannot remove default stage until replacement default exists
- cannot remove default pipeline until replacement default pipeline exists
- cannot leave an active Workspace without one valid default LEAD and DEAL pipeline

## Legacy production backfill

For existing Workspaces lacking valid config, bootstrap default Lead/Deal pipelines.

For existing CRM rows:

- if no legacy stage/status information exists, map to New
- if legacy values exist, implement deterministic explicit mapping
- if mapping is not provable, stop and report unmapped values
- never silently map unknown legacy statuses to New

Use expand -> backfill -> validate -> enforce.

## Acceptance criteria

- stage migration preserves history
- pipeline migration is all-or-nothing
- default invariants remain valid
- legacy unmapped values block unsafe enforcement
- migration tests prove rollback on failure
