# Invoices Module Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal / Boundary

Implement customer receivable Invoices. These are CRM customer invoices and are completely separate from TrueCRM SaaS subscription billing.

An Invoice may originate from a Deal, accepted Estimate, Contact/Company context, or another explicitly supported source, but it becomes its own historical financial object.

## Semantic lifecycle

```text
DRAFT -> ISSUED -> PARTIALLY_PAID -> PAID
```

Controlled terminal/correction states:

```text
VOID
CANCELLED
```

`OVERDUE` is derived, not a manually authoritative financial status:

```text
isOverdue = issued && outstandingBalance > 0 && dueDate < businessCurrentDate
```

A fully paid Invoice is never overdue.

## Core entities

### `crm_invoices`

```text
id UUID
workspaceId UUID
invoiceNumber nullable string (required after issue)
semanticStatus DRAFT | ISSUED | PARTIALLY_PAID | PAID | VOID | CANCELLED
sourceEstimateId nullable UUID
sourceEstimateRevisionId nullable UUID
dealId nullable UUID
customerContactId nullable UUID
customerCompanyId nullable UUID
sellerCompanyId UUID
buyerSnapshotId nullable UUID before issue / required after issue
sellerSnapshotId nullable UUID before issue / required after issue
currencyCode string
issueDate nullable DATE
dueDate nullable DATE
subtotal NUMERIC
discountTotal NUMERIC
taxTotal NUMERIC
grandTotal NUMERIC
paidAmount NUMERIC derived or transactionally maintained projection
outstandingBalance NUMERIC derived or controlled projection
responsibleUserId nullable UUID
voidReason nullable string
issuedAt nullable timestamptz
voidedAt nullable timestamptz
version integer where repository supports optimistic locking
```

### `crm_invoice_lines`

Commercial line snapshot structure equivalent in principle to Estimate lines and independent from Product master after issue.

## Numbering

Use the shared platform Numbering/Sequence service if present.

Requirements:
- sequence is Workspace-scoped;
- configuration may define separate sequences/prefixes per seller legal entity;
- number allocation is atomic under concurrency;
- issued invoice number is immutable;
- no two issued Invoices in the same configured sequence may share a number;
- gaps are acceptable if required by a safe atomic sequence implementation unless a future explicit business requirement forbids gaps.

Example formatting may be configured such as `INV-EG-2026-000001`; formatting is configuration, not hard-coded behavior.

## Draft behavior

Authorized users may change draft customer/seller, lines, dates and other editable fields. Server recalculates totals.

## Issue

```text
POST /api/v1/invoices/:id/issue
```

Transaction:
1. authorize `invoice.issue`;
2. lock/version-check Invoice;
3. validate DRAFT and complete required data;
4. recalculate lines/taxes/totals;
5. select/validate buyer/seller Requisites, addresses and Bank data as configured;
6. create immutable commercial snapshots;
7. allocate atomic invoice number;
8. set issue/due dates and `ISSUED`;
9. write audit + outbox event;
10. optionally enqueue document generation/delivery.

If any transaction-critical step fails, do not expose a partially issued Invoice.

## Issued immutability

After issue, these cannot be silently changed:
- invoice number;
- commercial lines/prices/discounts/taxes/totals;
- currency;
- snapshotted buyer/seller identity;
- selected snapshotted address/bank values.

Allowed non-financial metadata edits must be explicitly whitelisted.

Correction options:
- void/cancel where policy allows;
- replacement/reissued Invoice with explicit linkage/reason;
- refund/credit history through the correct financial flow.

Never rewrite historical issued values.

## Payment-driven status

Invoice collection state comes from successful Payment allocations:

```text
successfulAllocated = SUM(active allocations from SUCCEEDED payments)
outstanding = max(grandTotal - successfulAllocated, 0)
```

Rules:
- 0 allocated -> `ISSUED`;
- 0 < allocated < grandTotal -> `PARTIALLY_PAID`;
- allocated >= grandTotal -> `PAID`;
- VOID/CANCELLED follow their own state semantics;
- failed/pending Payment attempts do not count;
- duplicate provider callbacks cannot increase paid amount twice.

## API

Minimum:

```text
POST   /api/v1/invoices
GET    /api/v1/invoices
GET    /api/v1/invoices/:id
PATCH  /api/v1/invoices/:id
POST   /api/v1/invoices/:id/issue
POST   /api/v1/invoices/:id/void
POST   /api/v1/invoices/:id/cancel
GET    /api/v1/invoices/:id/payments
GET    /api/v1/invoices/:id/balance
POST   /api/v1/invoices/:id/archive
```

Creating from an Estimate uses the Estimate conversion command so conversion behavior is not duplicated in two controllers.

## Validation

- customer/seller/Requisite relationships same Workspace;
- valid customer identity;
- due date not before issue date unless an explicit business policy supports it;
- currency and all totals valid;
- line totals calculated server-side;
- source Estimate revision, when present, belongs to same Workspace/customer and is eligible;
- void/cancel requires reason where configured;
- paid Invoice cannot be unsafely voided if policy requires refund/credit first.

## Permissions

```text
invoice.create
invoice.read
invoice.update_draft
invoice.issue
invoice.void
invoice.cancel
invoice.read_payments
invoice.archive
```

## Events

```text
INVOICE_CREATED
INVOICE_UPDATED
INVOICE_ISSUED
INVOICE_PARTIALLY_PAID
INVOICE_PAID
INVOICE_VOIDED
INVOICE_CANCELLED
INVOICE_OVERDUE_CHANGED
```

`INVOICE_OVERDUE_CHANGED` is emitted only if the platform needs a durable derived-state event and must dedupe repeated identical evaluations.

## Errors

```text
INVOICE_NOT_FOUND
INVOICE_STATE_INVALID
INVOICE_ALREADY_ISSUED
INVOICE_NUMBER_CONFLICT
INVOICE_REQUIRED_DATA_MISSING
INVOICE_TOTAL_INVALID
INVOICE_HAS_SETTLED_PAYMENT
INVOICE_CANNOT_VOID
CROSS_WORKSPACE_REFERENCE
PERMISSION_DENIED
CONCURRENCY_CONFLICT
```

## Acceptance criteria

- concurrent issuance cannot produce duplicate invoice numbers;
- issued values remain stable after Product/Requisite/Bank edits;
- partial allocations produce `PARTIALLY_PAID` and correct balance;
- only successful allocations count;
- sufficient successful allocation makes Invoice paid;
- overdue is derived correctly from due date + balance;
- invalid state/cross-Workspace operations fail atomically;
- issue/void/payment-driven transitions are auditable and evented.
