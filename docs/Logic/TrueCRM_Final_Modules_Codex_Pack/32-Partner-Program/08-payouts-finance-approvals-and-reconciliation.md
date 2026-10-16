# Partner payouts, finance approval and reconciliation

**Specification ID:** `32-Partner-Program/08-payouts-finance-approvals-and-reconciliation`  
**Owner:** `32-Partner-Program`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Pay approved commissions with a robust financial audit trail and explicit payout ownership. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- partner_payout_batches: id, partner_id, period, amount NUMERIC, currency, status DRAFT|SUBMITTED|APPROVED|PROCESSING|PAID|FAILED|CANCELLED, requested_by, approved_by, payment_reference.
- partner_payout_items: payout_batch_id, commission_id, settled_amount, unique(commission_id,payout_batch_id).
- partner_payout_events: id, payout_id, action, actor_id, external_ref, occurred_at.
- partner_payout_reconciliation: payout_id, evidence_ref, status, difference NUMERIC.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /partners/:id/payout-requests {commissionIds,idempotencyKey}.
- POST /platform/partner-payouts/:id/approve {expectedAmount,reason}.
- POST /platform/partner-payouts/:id/record-payment {externalReference,paidAt,amount}.
- GET /partners/:id/payouts?status=&period=.
- POST /platform/partner-payouts/:id/reconcile {evidenceRef} -> check.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Accrue eligible commission; hold through settlement/refund rules; authorized Finance approves; initial payouts can be externally/manual recorded, automation adapter later.
2. Requestor cannot approve own payout where separation-of-duties policy enabled.
3. Items selected once for active payout (row locks/unique claim) to prevent double disbursement.
4. Paid only with verified external evidence and matching amount/currency; failed payout does not erase pending liability.
5. Suspended Partner stops new provisioning/commercial privileges but authorized payout reconciliation and obligations remain.

## State transitions, orchestration and transactions

- DRAFT -> SUBMITTED -> APPROVED|CANCELLED -> PROCESSING -> PAID|FAILED; FAILED -> approved retry with new attempt key.
- Commission APPROVED -> PAID only when matched payout settled.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Amount equals sum of eligible payout items after reversals; mismatch 409.
- Payout reference unique per provider; required evidence for manual paid status.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- partner.payout.request/readOwn, platform.partner.payout.approve/record/reconcile strong Finance roles.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Billing reports, Outbox, Provider adapters future extension, Audit, Notifications.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- PARTNER.PAYOUT_REQUESTED, PARTNER.PAYOUT_APPROVED, PARTNER.PAYOUT_PAID, PARTNER.PAYOUT_FAILED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Two payout requests racing cannot claim same commission twice.
- **AC02** — Failed payout preserves liability.
- **AC03** — Unapproved manual mark-paid rejected.
- **AC04** — Partially reversed commission cannot pay original gross amount.
- **AC05** — Partner sees own payout only.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
