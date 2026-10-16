# Partner pricing integration and payer/beneficiary separation

**Specification ID:** `31-Subscription-Billing/08-referrals-discounts-and-partner-billing`  
**Owner:** `31-Subscription-Billing`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Safely apply Partner discount configuration without giving Partners billing or tenant superpowers. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- billing_partner_price_snapshots: id, quote_id, partner_id, partner_relation_id, rule_version, base_price, discount_basis_points, discount_amount, final_amount, currency, calculated_at.
- billing_partner_transactions: id, workspace_id beneficiary, payer_account_id, partner_id nullable, invoice_id, commercial_relation_snapshot.
- billing_partner_credit_adjustments: id, transaction_id, related_refund_id, adjustment_type.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /internal/billing/partner-pricing/quote {workspaceId,productId,priceVersion,payerAccountId} -> snapshot.
- GET /billing/partner-transactions?partnerId=&workspaceId= scoped.
- POST /billing/accounts/transition-payer {subscriptionId,newPayerAccountId,customerOwnerConsentRef,approvalRef}.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Partner owns authoritative default/override basis-point rate; Billing resolves active customer-Partner relation, applies discount and snapshots exact rule/amount to immutable quote.
2. Only one active Partner relation per customer Workspace; historical attribution remains on older transactions after transfer.
3. Direct-customer and Partner-paid billing supported; payer, beneficiary Workspace, invoice legal owner and commercial Partner all distinct.
4. Refund/chargeback adjustments reconcile corresponding commissions; discount changes never rewrite historical invoice.
5. Discount product/category override priority exact product > category > default, tie-break by most specific active rule; percentage 0..10000 basis points.
6. Currency amounts round HALF_UP at stated currency minor-unit boundary after deterministic line calculation; use NUMERIC, never float.

## State transitions, orchestration and transactions

- Quote SNAPSHOTTED -> INVOICED or EXPIRED; future partner relation change does not alter existing quote unless quote expiration policy requires regeneration.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Same effective product price version across quote and payment or refresh required.
- Unknown/expired Partner relation cannot apply discount; spoofed partnerId in client request ignored.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- billing.partnerPricing.read calculated for authorized payer; platform finance may audit; Partner commercial role alone cannot see customer invoices or business data.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- PartnerDiscountService, PartnerWorkspaceRelation, Billing Invoice/Provider, Platform Audit.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- BILLING_PARTNER_DISCOUNT_APPLIED, BILLING_PAYER_CHANGED, BILLING_PARTNER_TRANSACTION_RECONCILED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Changing Partner from A to B does not change invoice from A.
- **AC02** — Same customer Workspace never has two active Partner rate candidates.
- **AC03** — Client-supplied partnerId cannot force discount.
- **AC04** — Payer switch requires customer owner consent and audited approval.
- **AC05** — Discount and invoice totals reconcile exactly using NUMERIC rounding policy.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
