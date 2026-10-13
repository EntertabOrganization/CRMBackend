# Payments Module Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal / Boundary

Record money received from CRM customers and allocate it to one or more Invoices. Payment is separate from Invoice, Payment Attempt and Refund.

A successful Payment may remain partly or fully unapplied and can later be allocated or refunded.

## Core entities

### `crm_payments`

```text
id UUID
workspaceId UUID
customerContactId nullable UUID
customerCompanyId nullable UUID
currencyCode string
amount NUMERIC
settlementStatus PENDING | SUCCEEDED | FAILED | CANCELLED
methodType MANUAL | PROVIDER
paymentMethod/providerKey nullable
externalReference nullable string
receivedAt nullable timestamptz
memo nullable string
responsibleUserId nullable UUID
```

Do not mutate a successful historical Payment amount to "fix" reconciliation.

### `crm_payment_allocations`

```text
id UUID
workspaceId UUID
paymentId UUID
invoiceId UUID
amount NUMERIC
status ACTIVE | REVERSED
createdByUserId/service identity
reversedAt nullable timestamptz
reversalReason nullable string
```

### `crm_payment_attempts`

```text
id UUID
workspaceId UUID
paymentId UUID
providerKey string
providerTransactionId nullable string
idempotencyKey nullable string
status CREATED | PENDING | SUCCEEDED | FAILED | CANCELLED
requestedAmount NUMERIC
currencyCode string
failureCode nullable string
failureMessageSanitized nullable string
```

Provider-event uniqueness must prevent one external transaction from settling twice.

## Amount equations

For a successful Payment:

```text
allocatedAmount = SUM(active allocations)
refundedAmount = SUM(successful refunds)
unappliedAmount = amount - allocatedAmount - refundedAmount
```

Invariant:

```text
allocatedAmount >= 0
refundedAmount >= 0
unappliedAmount >= 0
allocatedAmount + refundedAmount <= amount
```

Allocation and refund operations must transactionally recheck these values under concurrency.

For an Invoice:

```text
paidAmount = SUM(active allocations from SUCCEEDED payments)
outstandingBalance = max(invoice.grandTotal - paidAmount, 0)
```

## Manual payment

```text
POST /api/v1/payments/manual
```

Permission: `payment.record`.

Request contains customer, amount, currency, receivedAt, reference/memo, method metadata and optional allocations.

Flow:
1. validate Workspace/customer/currency;
2. create SUCCEEDED manual Payment;
3. apply requested allocations atomically if valid;
4. recalculate affected Invoice states through Invoice service;
5. audit + outbox.

Manual payment reference uniqueness may be configurable; do not globally reject repeated human references unless policy requires it.

## Provider payment

Creation and settlement are defined in `payment-providers.md`.

A browser/client redirect may display pending/completed UI but cannot mark Payment SUCCEEDED without trusted provider verification/lookup/webhook according to the adapter contract.

## Allocate payment

```text
POST /api/v1/payments/:id/allocations
```

Rules:
- Payment must be SUCCEEDED;
- Invoice must be eligible and same Workspace/customer context unless a privileged Finance policy explicitly supports broader customer-account allocation;
- no implicit FX conversion;
- allocation amount > 0;
- cannot exceed available unapplied amount;
- by default cannot exceed Invoice outstanding balance;
- lock/recheck Payment and affected Invoice(s) in deterministic order;
- recalculate Invoice states exactly once.

One Payment can allocate across multiple Invoices.

## Reallocation / reversal

Do not edit a historical allocation amount in place. Reverse the allocation with reason and create a replacement allocation when correction is needed.

A reversal cannot violate downstream refund/settlement invariants.

## API

```text
POST /api/v1/payments/manual
POST /api/v1/payments/provider-attempts
GET  /api/v1/payments
GET  /api/v1/payments/:id
GET  /api/v1/payments/:id/allocations
POST /api/v1/payments/:id/allocations
POST /api/v1/payments/:id/allocations/:allocationId/reverse
GET  /api/v1/payments/:id/refunds
```

## Permissions

```text
payment.create_attempt
payment.record
payment.read
payment.allocate
payment.reverse_allocation
payment.refund
```

## Events

```text
PAYMENT_CREATED
PAYMENT_SUCCEEDED
PAYMENT_FAILED
PAYMENT_ALLOCATION_CREATED
PAYMENT_ALLOCATION_REVERSED
PAYMENT_UNAPPLIED_BALANCE_CHANGED
```

Invoice state events originate from the Invoice domain service.

## Errors

```text
PAYMENT_NOT_FOUND
PAYMENT_NOT_SETTLED
PAYMENT_AMOUNT_INVALID
PAYMENT_CURRENCY_MISMATCH
PAYMENT_INSUFFICIENT_UNAPPLIED_AMOUNT
PAYMENT_ALLOCATION_EXCEEDS_INVOICE_BALANCE
PAYMENT_CUSTOMER_MISMATCH
ALLOCATION_NOT_FOUND
ALLOCATION_CANNOT_REVERSE
CROSS_WORKSPACE_REFERENCE
CONCURRENCY_CONFLICT
```

## Acceptance criteria

- one Payment may allocate to multiple Invoices;
- concurrency cannot spend same unapplied balance twice;
- overpayment remains visible as unapplied amount;
- failed/pending attempt never makes Invoice paid;
- successful allocation updates affected Invoice balance/status exactly once;
- allocation reversal preserves history and recomputes Invoice;
- all financial amounts use precise arithmetic;
- cross-Workspace access/references fail.
