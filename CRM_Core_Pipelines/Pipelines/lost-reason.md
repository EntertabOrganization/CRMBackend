# Lost Reason Specification

## Goal

Separate unsuccessful outcome reason from the FAILURE stage itself.

## Model

Workspace-scoped configurable catalog, e.g.:

- id UUID
- workspaceId
- name
- code optional/stable if repository uses codes
- sortOrder
- isActive
- createdAt
- updatedAt

Examples:

- Price too high
- Competitor
- No budget
- No response
- Invalid lead
- Outside market
- Other

## Rules

Entering a FAILURE stage requires active `lostReasonId`.

Optional `lostReasonComment` may capture context.

Stage answers **where** the process ended; lost reason answers **why**.

Moving current record back to PROGRESS clears active lost reason from current state while history/audit remains.

Deactivating a reason does not rewrite historical records.

Hard delete only when never referenced and retention/audit policy allows it.

## Acceptance criteria

- FAILURE transition without reason fails
- active reason works
- deactivated reason cannot be newly selected
- historical records still render deactivated reason
- reopening record clears current reason without erasing history
