# CRM Capture and Duplicate Resolution Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Process a submitted CRM_CAPTURE Form through a deterministic, idempotent recipe that matches/creates/updates/links CRM entities through their owning domain services.

Forms never write CRM tables directly.

## Capture recipe

A recipe is an ordered/graph-safe set of steps such as:

```text
Resolve Contact
Resolve Company
Link Contact <-> Company
Create Deal
Optional Create Estimate
```

Supported target types for this scope:

```text
LEAD
CONTACT
COMPANY
DEAL
ESTIMATE
```

Each step defines:
- target entity type;
- field mappings from Submission/config/constants;
- duplicate strategy;
- prerequisite bindings from prior steps;
- assignment policy;
- pipeline/stage where applicable;
- safe failure policy.

No arbitrary tenant code.

## Duplicate strategies

Per Form + target step:

```text
ALWAYS_CREATE_NEW
MATCH_OR_CREATE
USE_EXISTING
UPDATE_MATCHED
```

`MERGE_MATCHED` is allowed only if shared Data Quality service exposes a safe audited merge and Workspace configuration explicitly permits automatic merge. Forms must not implement destructive merge themselves.

Example:

```text
Contact -> MATCH_OR_CREATE / UPDATE_MATCHED
Company -> MATCH_OR_CREATE
Deal -> ALWAYS_CREATE_NEW
```

Thus a returning customer can reuse Contact/Company while creating a fresh opportunity.

## Matching

Use shared normalization/duplicate services for phone/email/company identity. Do not implement ad-hoc Form-only matching.

If multiple eligible matches remain ambiguous:
- never choose an arbitrary candidate;
- record review-needed/failure outcome;
- preserve Submission and already completed bindings.

## Entity binding

`crm_form_entity_bindings` logical fields:

```text
id UUID
workspaceId UUID
submissionId UUID
recipeStepKey string
entityType string
entityId UUID
action CREATED | MATCHED | UPDATED | MERGED
createdAt timestamptz
```

Unique step identity prevents duplicate result on retry unless step explicitly supports multiple outputs.

Every CRM outcome is traceable to Submission.

## Assignment policies

Support:
- fixed user;
- department/team queue;
- round-robin;
- source-based rules;
- existing customer owner;
- Automation resolver.

Public payload cannot authoritatively choose responsible user. Assignment resolver returns server-authorized destination.

Round-robin is concurrency-safe.

## Pipeline/stage

Pipeline/stage comes from Form recipe server configuration.

Validate:
- same Workspace;
- stage belongs to pipeline;
- target type supports pipeline;
- required fields satisfied;
- execution identity allowed to create/move there.

## Processing transaction strategy

A multi-entity recipe may cross domain services, so do not assume a single giant foreign-table transaction.

Use durable step state + deterministic idempotency:

1. lock Submission processing lease;
2. load completed bindings;
3. execute next unresolved step through owning service with key `submissionId:stepKey`;
4. persist binding/outcome;
5. continue;
6. finalize processing status.

If later step fails, retry resumes from recorded results.

## Events

Each binding emits `FORM_ENTITY_BOUND` with Submission, step, entity type/id, action and correlation ID. Normal CRM events come from CRM services.

## Errors/outcomes

```text
FORM_CAPTURE_RECIPE_INVALID
FORM_CAPTURE_MAPPING_INVALID
FORM_DUPLICATE_AMBIGUOUS
FORM_TARGET_FIELD_INVALID
FORM_ASSIGNMENT_UNRESOLVED
FORM_PIPELINE_STAGE_INVALID
FORM_CAPTURE_STEP_FAILED
```

A processing error does not delete the accepted Submission.

## Acceptance criteria

- retry after Contact creation but before Deal creation reuses Contact binding and creates at most one Deal for that step;
- duplicate strategies differ by entity in same Form;
- ambiguous match never silently links wrong customer;
- public payload cannot inject owner/pipeline/Workspace config;
- every result is traceable to Submission;
- cross-Workspace binding impossible/rejected;
- assignment and pipeline decisions are deterministic/auditable.
