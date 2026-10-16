# AI credit ledger, grant types, top-ups and expiration

**Specification ID:** `31-Subscription-Billing/06-credit-ledger-topups-and-expiration`  
**Owner:** `31-Subscription-Billing`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Account for plan-granted and purchased credits without losing financial traceability. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- billing_credit_accounts: workspace_id, credit_type AI|OTHER, currency_or_unit, policy_version.
- billing_credit_grants: id, account_id, source PLAN|PURCHASE|ADJUSTMENT, initial_units NUMERIC, remaining_units derived, granted_at, expires_at nullable, eligible_scenarios.
- billing_credit_ledger_entries: id, account_id, grant_id, event_key, entry_type GRANT|RESERVE|CONSUME|RELEASE|EXPIRE|REVERSE|REFUND, quantity NUMERIC, related_run_ref, occurred_at.
- billing_credit_reservations: id, run_id, grants_allocations, reserved_units, status.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /billing/credits/balance -> available/held/expiring groups.
- POST /billing/credits/topup-quote {productId,amount} -> immutable quote.
- POST /billing/credits/topup-purchase {quoteId,payerAccountId,idempotencyKey} -> payment flow.
- POST /internal/billing/credits/reserve {operationKey,units,scenario}.
- POST /internal/billing/credits/settle|release.
- GET /billing/credits/ledger?from=&to= -> scoped.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Consume eligible plan credits first by earliest expiry, then purchased credits by earliest expiry/oldest grant; deterministic tie-break by grant ID.
2. Purchased and plan grants have separate optional expiration policies; no arbitrary monthly wipe unless configured.
3. Append-only ledger entries; reversals and refunds are compensating entries, never edits of consumed rows.
4. Top-up activates only after verified settlement; Partner discounts applied to purchase invoice not to unit count unless product policy explicitly says so.
5. Keep credit hold and financial usage reservation coordinated under single Billing transaction boundary.

## State transitions, orchestration and transactions

- Grant PENDING -> ACTIVE -> EXPIRED|CONSUMED; reservation RESERVED -> CONSUMED|RELEASED.
- Reconcile ledger with source usage events; derived balances can be rebuilt.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- No negative credit except authorized overage configured separately.
- Use NUMERIC units, rounded only at defined billing unit precision; credit split sum equals exact reservation.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- billing.credits.read, billing.credits.purchase, billing.credits.adjust (Platform Finance only); AI cannot mutate ledger directly.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- AI token usage, Partner discount resolver, Stripe/XPay, Platform Auditing, Entitlements.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- BILLING_CREDITS_GRANTED, BILLING_CREDITS_CONSUMED, BILLING_CREDITS_EXPIRED, BILLING_CREDIT_REVERSAL_POSTED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Plan credits spent before purchased eligible credits.
- **AC02** — Partial settle releases remaining reserved amount.
- **AC03** — Credit reversal preserves original entry and net balance.
- **AC04** — Duplicate provider event never grants twice.
- **AC05** — Concurrent requests cannot drive available below zero.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
