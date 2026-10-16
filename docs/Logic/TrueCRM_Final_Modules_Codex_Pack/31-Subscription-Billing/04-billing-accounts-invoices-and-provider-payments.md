# Billing accounts, invoices, payments and provider reconciliation

**Specification ID:** `31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments`  
**Owner:** `31-Subscription-Billing`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Own TrueCRM SaaS billing records separately from CRM customer invoices and Commerce. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- billing_accounts: id, workspace_id, payer_type CUSTOMER|PARTNER, payer_customer_ref or partner_id, legal_identity_snapshot, billing_currency, tax_profile, status.
- billing_invoices: id, billing_account_id, subscription_id, issued_at, currency, total NUMERIC, paid NUMERIC, status DRAFT|ISSUED|PARTIALLY_PAID|PAID|VOID|REFUNDED.
- billing_invoice_lines: invoice_id, description, quantity, unit_price, tax, discount_basis_points, subtotal snapshot.
- billing_provider_events: provider, provider_event_id, payload_digest, signature_state, processed_at, result; unique(provider,eventId).
- billing_payments: id, invoice_id, provider_transaction_id, amount, status; billing_refunds: id, payment_id, amount, status.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /billing/checkout-quotes {subscriptionChangeOrPurchase,payerAccountId} -> immutable quote.
- POST /billing/payment-attempts {quoteId,providerId,idempotencyKey}.
- POST /webhooks/billing/stripe and /webhooks/billing/xpay -> verified receipt, 2xx on deduped processing.
- GET /billing/invoices?status= and GET /billing/invoices/:id.
- POST /billing/refunds {paymentId,amount,reason,idempotencyKey} privileged.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Subscription SaaS invoices are different from workspace's CRM customer invoices.
2. Provider events signature/identity verification mandatory (XPay status verified by secure provider lookup when provider lacks signature) and persisted idempotently.
3. Payer can be customer or Partner; beneficiary Workspace and legal invoice owner recorded explicitly; no automatic Workspace owner transfer.
4. Payment and refund are separate immutable ledgers; partial payment updates outstanding balance, refund never edits original successful entry.
5. Unknown provider outcome reconciled before retrying new charge.

## State transitions, orchestration and transactions

- Invoice DRAFT -> ISSUED -> PARTIALLY_PAID|PAID|VOID; PAID -> REFUNDED by separate refund records (partial refund preserves evidence).
- Payment PENDING -> SUCCEEDED|FAILED|REVERSED; provider receipt unique.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Amounts nonnegative and <= refundable amount after prior refunds; currency matches invoice or explicit FX allocation.
- Idempotency key plus payload hash for charges/refunds; provider metadata never trusted as tenant authority.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- billing.invoice.readWorkspace, billing.payment.manage, billing.refund.approve; bank/payment details restricted to Finance authorized scopes.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Stripe/XPay adapters, Vault, Partner payer relation, Platform Outbox/Jobs/Audit, Reconciliation.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- BILLING_PAYMENT_CONFIRMED, BILLING_PAYMENT_FAILED, BILLING_REFUND_CREATED, BILLING_INVOICE_PAID.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Duplicate Stripe event creates one payment.
- **AC02** — Unverified XPay callback cannot mark invoice paid.
- **AC03** — Partial payment leaves balance correct.
- **AC04** — Partner paid invoice belongs to Partner payer without granting tenant ownership.
- **AC05** — Partial refund leaves immutable successful payment intact.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
