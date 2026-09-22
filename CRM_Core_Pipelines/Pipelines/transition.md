# Stage Transition Specification

## Goal

Implement safe stage transitions for Leads and Deals, including cross-pipeline movement, permissions, optional transition graphs, required fields, lost reasons, optimistic concurrency, history, audit and outbox.

## Commands

```text
POST /api/v1/crm/leads/:id/transition
POST /api/v1/crm/deals/:id/transition
```

## Cross-pipeline moves

Allowed for both Leads and Deals within their own entity type.

Cross-pipeline request must explicitly include:

```text
targetPipelineId
targetStageId
```

Do not guess target default stage for an existing record move.

## Validation

Validate in this order or an equivalent transaction-safe order:

1. resolve record in active Workspace context
2. expected version
3. transition permission and scope
4. source-stage leave permission
5. target pipeline exists, same Workspace, correct entity type
6. target stage belongs to target pipeline and is active
7. target-stage view/enter permission
8. configured transition graph or authorized override
9. required fields for target stage
10. lost reason if target semantic is FAILURE
11. Lead conversion-state restrictions
12. domain constraints

## Transition graph

If disabled/unconfigured, any otherwise-valid authorized move is allowed.

If enabled, only configured edges are allowed unless caller has `crm.pipeline.transition.override`.

Override bypasses the graph only; it never bypasses tenant isolation, entity permission, stage permission, required fields or type validity.

## Required fields

Resolve target-stage system/custom requirements through Module 05 boundary.

Values sent in the same transition request may satisfy missing requirements before commit.

Failure returns `CRM_STAGE_REQUIRED_FIELDS_MISSING` with stable field details.

## Semantic effects

Deal:

- PROGRESS opens
- SUCCESS wins/closes
- FAILURE loses/closes

Lead:

- PROGRESS active
- SUCCESS qualified/successfully closed
- FAILURE disqualified
- SUCCESS does not convert

## Failure transition

Requires active lostReasonId.

Optional comment allowed.

## Transaction

Update record + append stage history + audit + outbox consistently.

Automation executes after commit from event processing.

## Acceptance criteria

- valid intra-pipeline move works
- valid cross-pipeline move works
- entity-type mismatch fails
- wrong-pipeline stage fails
- graph restriction works
- override behavior is limited correctly
- required fields block move
- failure stage requires lost reason
- stale version fails
- history/outbox/audit created exactly once under idempotent retry
