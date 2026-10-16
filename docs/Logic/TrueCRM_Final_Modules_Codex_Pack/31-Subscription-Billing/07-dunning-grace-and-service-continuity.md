# Past-due recovery, grace and controlled service continuity

**Specification ID:** `31-Subscription-Billing/07-dunning-grace-and-service-continuity`  
**Owner:** `31-Subscription-Billing`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Preserve customer data and pre-existing obligations through payment failures and plan expiry. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- billing_recovery_cases: id, subscription_id, failure_reason_code, started_at, grace_until, status OPEN|RESOLVED|EXPIRED, attempts.
- billing_dunning_actions: id, case_id, scheduled_at, channel, delivery_state, provider_ref.
- billing_service_continuity: workspace_id, feature, existing_read_policy, new_write_policy, effective_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /billing/subscriptions/:id/recovery-case -> owner-facing status.
- POST /billing/subscriptions/:id/retry-payment {idempotencyKey}.
- POST /billing/subscriptions/:id/update-payment-method -> provider-hosted flow.
- POST /billing/recovery/:id/resolve internal upon verified payment.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Default grace 15 days (configurable); send authorized notices and retry eligible payment methods under customer authorization and provider rules.
2. After grace, preserve records; restrict creation of new premium records, allow lawful access/export and fulfillment of existing paid orders, returns and refunds per shared service policies.
3. Existing published website may remain read-only when resulting plan allows; new ecommerce checkout blocked when Commerce entitlement lost.
4. Partner payment failure not equal customer identity loss: allow approved transfer to direct payer while preserving customer Workspace owner.
5. Restore access promptly after verified settlement and refresh entitlement caches.

## State transitions, orchestration and transactions

- ACTIVE -> PAST_DUE -> GRACE -> ACTIVE|EXPIRED; canceled policy separate.
- Case OPEN -> RESOLVED|EXPIRED; no destructive cleanup on expiry.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Grace dates UTC instants anchored to trusted failed renewal; no arbitrary client expiration time.
- Critical notifications mandatory per platform policy.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- billing.recovery.manage, billing.subscription.retryOwn; Platform Support cannot fake paid status.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Provider reconciliation, Notifications, Entitlements, Commerce/Sites continuity, Partner payer model.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- SUBSCRIPTION_PAST_DUE, SUBSCRIPTION_GRACE_STARTED, SUBSCRIPTION_RECOVERED, SUBSCRIPTION_GRACE_ENDED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Grace expiry never deletes customer CRM records.
- **AC02** — Partner missing payment cannot transfer Workspace ownership.
- **AC03** — Old paid order can be fulfilled despite disabled new checkout.
- **AC04** — Verified late payment restores correct entitlements.
- **AC05** — Duplicate dunning event doesn't create duplicate charge.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
