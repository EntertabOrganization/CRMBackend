# Refunds and Unapplied Credit Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Support full and partial refunds against successful Payments while retaining original Payment history and exposing unapplied successful-payment value as customer credit available for later allocation or refund.

## Refund entity

`crm_refunds` logical fields:

```text
id UUID
workspaceId UUID
paymentId UUID
providerAttemptId nullable UUID
amount NUMERIC
currencyCode string
status PENDING | SUCCEEDED | FAILED | CANCELLED
providerRefundId nullable string
reasonCode nullable string
reasonText nullable string
requestedByUserId/service identity
requestedAt timestamptz
settledAt nullable timestamptz
idempotencyKey nullable string
```

## Refundable amount

Before every refund transaction, re-evaluate under lock/version protection.

Core invariants:

```text
successfulRefunded = SUM(SUCCEEDED refunds)
unapplied = payment.amount - activeAllocations - successfulRefunded
successfulRefunded <= payment.amount
unapplied >= 0
```

Default rule: refund only currently unapplied amount unless a valid allocation reversal/adjustment is performed first or atomically as part of an approved Finance workflow. Do not refund money still funding an Invoice while leaving that Invoice falsely paid.

If the product flow reverses allocations as part of refund, allocation reversal and refund reservation must be coordinated transactionally.

## Request refund

```text
POST /api/v1/payments/:paymentId/refunds
```

Permission: `payment.refund`.

Rules:
- Payment is SUCCEEDED;
- amount > 0;
- currency equals Payment currency;
- available refundable amount is checked under concurrency protection;
- `Idempotency-Key` prevents duplicate request;
- Manual Payment can record offline/manual refund with reference/evidence;
- Provider Payment uses provider adapter and tracks PENDING/SUCCEEDED/FAILED;
- never delete/rewrite original successful Payment.

## Unapplied customer credit

The confirmed "customer credit" requirement is the unapplied remainder of a successful Payment, not a separate promotional-credit system:

```text
unapplied = payment.amount - activeAllocations - successfulRefunds
```

This may later be allocated to eligible Invoice(s) or refunded.

Expose it in Payment and customer-finance views.

## Events

```text
REFUND_REQUESTED
REFUND_SUCCEEDED
REFUND_FAILED
PAYMENT_UNAPPLIED_BALANCE_CHANGED
```

If refund required allocation reversal, Invoice status is recalculated by Invoice service.

## Errors

```text
REFUND_PAYMENT_NOT_SETTLED
REFUND_AMOUNT_INVALID
REFUND_EXCEEDS_AVAILABLE
REFUND_CURRENCY_MISMATCH
REFUND_PROVIDER_FAILED
REFUND_ALREADY_PROCESSED
REFUND_REQUIRES_ALLOCATION_ADJUSTMENT
CONCURRENCY_CONFLICT
```

## Acceptance criteria

- several partial refunds are allowed until available refundable amount reaches zero;
- concurrent refunds cannot exceed available amount;
- duplicate request/provider callback does not duplicate refund;
- original successful Payment remains visible;
- Invoice cannot remain falsely paid after its allocation is reversed for refund;
- overpayment/unapplied money is visible and reusable.
