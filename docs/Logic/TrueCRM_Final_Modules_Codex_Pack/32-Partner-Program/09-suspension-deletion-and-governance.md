# Partner suspension, deletion, restore and retention

**Specification ID:** `32-Partner-Program/09-suspension-deletion-and-governance`  
**Owner:** `32-Partner-Program`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Safely suspend Partner privileges while preserving customer ownership and required commercial history. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- partner_lifecycle_cases: id, partner_id, operation SUSPEND|REACTIVATE|SOFT_DELETE|RESTORE|PURGE, reason, status, actor_id, occurred_at.
- partner_access_invalidations: id, partner_id, scope, version, invalidated_at.
- partner_retention_refs: partner_id, legal_hold_id nullable, policy_id.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /platform/partners/:id/suspend {reason,expectedVersion}.
- POST /platform/partners/:id/reactivate {reason}.
- DELETE /platform/partners/:id -> soft deleted.
- POST /platform/partners/:id/restore.
- POST /platform/partners/:id/purge {legalBasis,approvalRef} -> restricted irreversible.
- GET /platform/partners/:id/lifecycle -> audit history.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Suspension disables new provisioning, discounts on future quotes when configured, referral privileges and delegated Workspace access.
2. Never suspend/end customer Workspace itself or erase subscriptions merely because Partner suspended.
3. Existing paid orders/subscriptions, financial history and payout reconciliation remain correctly actionable by authorized customer/finance roles.
4. Soft delete normally hides Partner from active lists, preserves audit and historical Billing links; hard purge gated by retention/legal hold and anonymization rules.
5. Reactivation does not silently restore previously revoked delegated access.

## State transitions, orchestration and transactions

- Partner ACTIVE -> SUSPENDED -> ACTIVE; ACTIVE|SUSPENDED -> SOFT_DELETED -> RESTORED, optional PURGED after policy gates.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Platform-admin-only and reason 1–1000; purge impossible under legal hold/outstanding payable obligations unless policy permits specific redaction path.
- Role grants and cache invalidation committed with status change.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- platform.partner.lifecycle.manage; Partner Owner cannot reactivate own suspended organization.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Workspace Auth, Billing, Referrals, Payout ledger, Retention, Audit/Outbox, Notifications.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- PARTNER.SUSPENDED, PARTNER.REACTIVATED, PARTNER.SOFT_DELETED, PARTNER.RESTORED, PARTNER.HARD_DELETED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Suspension blocks delegated access immediately.
- **AC02** — Customer can still view own paid subscription.
- **AC03** — Soft delete retains invoice relation snapshot.
- **AC04** — Reactivation does not regrant revoked customer access.
- **AC05** — Legal hold blocks hard purge.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
