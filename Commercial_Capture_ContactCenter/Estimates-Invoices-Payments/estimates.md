# Estimates Module Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal / Boundary

Implement `Estimate` as the canonical TrueCRM proposal/quotation object. An Estimate is a commercial proposal linked to CRM customer context and optionally a Deal. It is **not** an Invoice, Payment or Deal.

UI may display an alias such as "Quote", but API/domain naming remains `Estimate`.

## Responsibilities

- create/search/read/update Estimates;
- maintain configurable Estimate stages mapped to stable semantic states;
- maintain product/manual line rows and server-calculated totals;
- select customer and seller legal identity;
- preserve sent versions through immutable revisions;
- send/generate a document through the shared Documents service;
- record acceptance/decline/expiry;
- convert an accepted Estimate into one or more Invoices;
- emit timeline/automation/analytics events.

## Core entities

### `crm_estimates`

Required logical fields (adapt to repository naming):

```text
id UUID
workspaceId UUID
number nullable string
subject string
semanticStatus DRAFT | ACTIVE | ACCEPTED | DECLINED | EXPIRED | CONVERTED
stageId UUID
customerContactId nullable UUID
customerCompanyId nullable UUID
dealId nullable UUID
sellerCompanyId UUID
currencyCode string
currentRevisionNumber integer
acceptedRevisionNumber nullable integer
validUntil nullable DATE
responsibleUserId nullable UUID
sourceFormSubmissionId nullable UUID
archived boolean / repository lifecycle metadata
version integer for optimistic concurrency where repository supports it
```

### `crm_estimate_revisions`

Each externally sent/accepted commercial version must be reconstructable.

```text
id UUID
workspaceId UUID
estimateId UUID
revisionNumber integer
status DRAFT | SENT | SUPERSEDED | ACCEPTED | DECLINED | EXPIRED
buyerSnapshotId UUID
sellerSnapshotId UUID
currencyCode string
subtotal NUMERIC
discountTotal NUMERIC
taxTotal NUMERIC
grandTotal NUMERIC
sentAt nullable timestamptz
acceptedAt nullable timestamptz
declinedAt nullable timestamptz
expiresOn nullable DATE
generatedDocumentId nullable UUID
```

Unique: `(estimateId, revisionNumber)`.

### `crm_estimate_lines`

A line belongs to a revision or to a draft-revision model that becomes immutable when sent.

```text
id UUID
workspaceId UUID
estimateRevisionId UUID
sortOrder integer
productId nullable UUID
variantId nullable UUID
lineType PRODUCT | MANUAL
description string
quantity NUMERIC
unitCode nullable string
unitPrice NUMERIC
discountType NONE | PERCENT | FIXED
discountValue NUMERIC
taxCode nullable string
taxRate NUMERIC
netAmount NUMERIC
taxAmount NUMERIC
totalAmount NUMERIC
```

Product master changes must never rewrite saved lines.

## Stage model

Workspace administrators may configure presentation stages. Every stage must map to one semantic state:

```text
DRAFT
ACTIVE
ACCEPTED
DECLINED
EXPIRED
CONVERTED
```

Custom stage names do not remove semantic behavior.

Rules:
- new Estimate begins in a configured DRAFT/ACTIVE stage;
- only server-authorized transitions are accepted;
- accepted/declined/converted semantics update business status consistently;
- an Estimate may not be marked CONVERTED unless at least one Invoice conversion exists;
- expiry may be calculated/transitioned by scheduled job when `validUntil` passes and no terminal outcome supersedes it.

## Revision workflow

### Editing before send

The mutable draft may be edited by authorized users. Server recalculates totals from validated lines.

### Send

```text
POST /api/v1/estimates/:id/send
```

Transaction/business flow:
1. authorize `estimate.send`;
2. validate state/stage allows sending;
3. validate customer, seller and required legal details;
4. server-recalculate totals;
5. create/finalize immutable revision and commercial snapshots;
6. generate/bind document if configured;
7. mark revision SENT and update Estimate current revision;
8. write audit + outbox event;
9. enqueue delivery when requested.

If a transaction-critical step fails, do not expose a half-sent Estimate.

### Change after send

Financial/legal/line changes must not mutate a sent revision. Create a new draft revision copied from the latest allowed revision, increment `revisionNumber`, then edit and resend.

Non-commercial metadata may be editable only when it does not alter the historical customer-facing document.

## Acceptance / decline

```text
POST /api/v1/estimates/:id/accept
POST /api/v1/estimates/:id/decline
```

Rules:
- command targets a specific sent revision;
- stale/superseded revision acceptance returns `ESTIMATE_REVISION_NOT_CURRENT` unless a later explicit product rule permits it;
- record actor/source and timestamp;
- accepted revision is historically immutable;
- acceptance emits `ESTIMATE_ACCEPTED`;
- decline emits `ESTIMATE_DECLINED`.

Public/customer acceptance, if later exposed, must use a signed/expiring Estimate-specific token and must not grant Workspace permissions.

## Convert to Invoice

```text
POST /api/v1/estimates/:id/invoices
```

Permission: `estimate.convert` + `invoice.create`.

Rules:
- source revision must be accepted unless an explicitly configured privileged rule allows another state;
- one Estimate may produce multiple Invoices;
- request may invoice all or a subset of remaining billable lines/amounts if repository commercial-line model supports partial invoicing;
- Invoice receives independent snapshot values; it must not live-reference mutable Estimate fields;
- command is idempotent where client retry is possible;
- link Invoice to Estimate revision, Deal/customer and seller context;
- emit `ESTIMATE_INVOICE_CREATED` plus normal Invoice events.

## API

Minimum endpoints:

```text
POST   /api/v1/estimates
GET    /api/v1/estimates
GET    /api/v1/estimates/:id
PATCH  /api/v1/estimates/:id
POST   /api/v1/estimates/:id/revisions
POST   /api/v1/estimates/:id/send
POST   /api/v1/estimates/:id/accept
POST   /api/v1/estimates/:id/decline
POST   /api/v1/estimates/:id/invoices
POST   /api/v1/estimates/:id/archive
POST   /api/v1/estimates/:id/restore
```

List search/filter must at least support subject/number, semantic status/stage, responsible user, customer, Deal, seller, currency, validity date and useful amount ranges when efficient.

## Validation

- all relationships same Workspace;
- valid customer identity according to commercial policy;
- seller company configured and active;
- currency supported;
- quantity > 0 unless a separately specified adjustment line exists;
- price, tax and discount use precise numeric validation;
- PERCENT discount bounded by policy;
- manual line requires description and unit price;
- product/variant relationship valid when supplied;
- stage belongs to Estimate stage configuration;
- state transition follows semantic rules;
- no hidden required field may make a transition impossible for authorized actor.

## Permissions

```text
estimate.create
estimate.read
estimate.update
estimate.send
estimate.accept
estimate.decline
estimate.convert
estimate.archive
estimate.restore
```

Read/update actions use applicable scope.

## Events / audit

Domain events at minimum:

```text
ESTIMATE_CREATED
ESTIMATE_UPDATED
ESTIMATE_REVISION_CREATED
ESTIMATE_SENT
ESTIMATE_ACCEPTED
ESTIMATE_DECLINED
ESTIMATE_EXPIRED
ESTIMATE_INVOICE_CREATED
ESTIMATE_ARCHIVED
ESTIMATE_RESTORED
```

Audit send/revision/accept/decline/conversion with revision identity and totals, without leaking secrets.

## Error cases

```text
ESTIMATE_NOT_FOUND
ESTIMATE_STAGE_INVALID
ESTIMATE_STATE_INVALID
ESTIMATE_REVISION_NOT_CURRENT
ESTIMATE_REQUIRED_DATA_MISSING
ESTIMATE_TOTAL_INVALID
ESTIMATE_ALREADY_CONVERTED_AS_REQUESTED
CROSS_WORKSPACE_REFERENCE
PERMISSION_DENIED
CONCURRENCY_CONFLICT
```

## Acceptance criteria

- custom presentation stages map to stable semantic behavior;
- sent revision never changes after later edits;
- Product master edits never change historical Estimate lines;
- acceptance refers to an exact sent revision;
- accepted Estimate can create multiple Invoices;
- retrying same conversion key does not create duplicate Invoice;
- cross-Workspace customer/product/seller references fail;
- audit/outbox event is committed consistently with important business change.
