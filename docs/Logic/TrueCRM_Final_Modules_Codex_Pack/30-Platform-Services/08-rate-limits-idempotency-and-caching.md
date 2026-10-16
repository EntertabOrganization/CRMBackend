# Rate limits, idempotency records and safe caching

**Specification ID:** `30-Platform-Services/08-rate-limits-idempotency-and-caching`  
**Owner:** `30-Platform-Services`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Prevent abuse and protect exactly-once-effective commands across retried requests. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- idempotency_keys: workspace_id nullable, actor_scope, operation_code, key_hash, request_hash, state IN_PROGRESS|SUCCEEDED|FAILED_RETRYABLE, response_ref, expires_at.
- rate_limit_policies: operation_code, principal_scope, requests, window_seconds, burst, risk_class.
- cache_versions: namespace, scope_id, version, invalidated_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /internal/idempotency/claim {operationCode,key,requestHash} service-only.
- GET /platform/admin/rate-limits and PATCH policy.
- GET /platform/admin/idempotency/:id -> metadata only.
- POST /platform/admin/cache/invalidate {namespace,scopeId,reason}.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Same key + same request hash returns original successful outcome; same key different request hash => 409 IDEMPOTENCY_CONFLICT.
2. Key scope includes operation and actor/workspace context; collisions across tenants impossible.
3. Concurrently claimed key serializes winning operation; stale IN_PROGRESS recovery requires completed-effect reconciliation.
4. Rate limits keyed by threat-suitable principal/IP/workspace/provider, enforce before expensive DB/provider actions.
5. Caches only derived; permission changes bump version and invalidate; stale cache never authorizes privileged action.

## State transitions, orchestration and transactions

- Idempotency IN_PROGRESS -> SUCCEEDED|FAILED_RETRYABLE; recovery retries only if no effect already committed.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Key high entropy/length bounded, requestHash canonicalized; response cache references sanitized.
- 429 includes safe retry-after; no PII in cache key.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- platform.rateLimit.manage and platform.cache.invalidate; internal idempotency service cannot be called from public endpoints.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Redis rate-limit, PostgreSQL idempotency durable rows, Auth, Billing usage, AI/tool idempotency.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- IDEMPOTENCY_CONFLICT_DETECTED, RATE_LIMIT_TRIGGERED, CACHE_VERSION_INVALIDATED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Five same-key retries have one effect.
- **AC02** — Different payload same key returns 409.
- **AC03** — Two tenants reuse same key without collision.
- **AC04** — Redis flush does not bypass durable financial idempotency.
- **AC05** — Concurrent permission revocation causes cached allow to be rejected.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
