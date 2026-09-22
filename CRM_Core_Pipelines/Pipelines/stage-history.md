# Stage History Specification

## Goal

Preserve immutable business movement history for Leads and Deals while retaining strong foreign keys.

## Tables

Use separate tables:

```text
crm_lead_stage_history
crm_deal_stage_history
```

Do not collapse to a single `(entityType, entityId)` table unless the real repository provides an equally strong integrity mechanism and the human approves changing this locked decision.

## Suggested fields

- id UUID
- workspaceId
- leadId OR dealId
- fromPipelineId nullable
- fromStageId nullable
- toPipelineId
- toStageId
- movedByUserId / actor identity
- movedAt
- correlationId nullable
- transition metadata needed for deterministic reporting without copying entire record

## Creation/history behavior

Initial record creation may create the first history entry with null `from*` fields if that matches repository history convention.

Every successful stage or cross-pipeline transition appends one history row.

Failed/rolled-back transitions append none.

Idempotent retry appends no duplicate history.

## Historical integrity

- stage rename does not rewrite history
- stage reorder does not rewrite history
- stage/pipeline deactivation does not rewrite history
- pipeline migration appends new movement history but keeps old history IDs intact

## API

A unified read service may expose Lead/Deal history through a common DTO.

Authorization must be based on current/appropriate record access policy without leaking other Workspace history.

## Acceptance criteria

- complete movement sequence can be reconstructed
- cross-pipeline move records both pipeline/stage sides
- actor/time are preserved
- deactivated configuration remains resolvable for reporting
