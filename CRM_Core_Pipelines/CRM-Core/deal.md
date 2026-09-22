# Deal Specification

## Goal

Implement Deal as a Workspace-scoped commercial opportunity with customer identity, responsibility, amount/currency, source, observers, pipeline/stage lifecycle and closure semantics.

## Customer requirement

A Deal must have at least one customer identity:

```text
companyId != null
OR
linkedContacts.length > 0
```

A Deal may simultaneously have:

- one CRM Company
- multiple Contacts

If Contacts exist, exactly one Deal Contact is primary.

Do not require Company and Contact to be mutually exclusive.

## Suggested persistent fields

- id UUID
- workspaceId
- title
- companyId nullable
- responsibleUserId
- pipelineId
- stageId
- amount nullable/required according to repository/product validation
- currencyCode
- sourceId nullable
- sourceDescription nullable
- acquisition/source fields copied from Lead when created through conversion
- current closure fields
- lostReasonId nullable
- lostReasonComment nullable
- isArchived / archivedAt / archivedByUserId
- isDeleted / deletedAt / deletedByUserId
- createdAt
- updatedAt
- version

## Contacts

Use explicit Deal Contact relation rows.

Rules:

- same Contact cannot be linked twice to same Deal
- if Contacts exist, one and only one is primary
- relation may carry a role/label
- removing primary while others remain requires explicit replacement primary

## Pipeline and status

Deal belongs to one DEAL pipeline and stage.

Stage semantic determines current opportunity outcome:

```text
PROGRESS -> OPEN
SUCCESS  -> WON
FAILURE  -> LOST
```

Do not maintain an independently editable status that can contradict stage semantics.

## Sensitive operations

Ordinary PATCH must not directly change:

- responsibleUserId
- pipelineId
- stageId

Use assign/transition commands.

## Observers

Deal may have observers. Observer grants record read access only; no automatic write/transition permission.

## Limited customer visibility

If a user may read the Deal but not linked Contact/Company independently, return only the limited summary described in Agent.md.

## Acceptance criteria

- at least Company or Contact is required
- Company + Contacts together are allowed
- exactly one primary Deal Contact when Contacts exist
- multiple Deal pipelines and cross-pipeline moves work
- semantic stages drive OPEN/WON/LOST
- lost reason is required for FAILURE transition
- amount/currency/source are supported
- assignment, observers, archive/delete, concurrency and idempotency behave correctly
