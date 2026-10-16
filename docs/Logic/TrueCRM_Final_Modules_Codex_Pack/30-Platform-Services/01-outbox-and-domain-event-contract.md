# Transactional outbox and shared event transport

**Specification ID:** `30-Platform-Services/01-outbox-and-domain-event-contract`  
**Owner:** `30-Platform-Services`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Guarantee reliable ordered delivery of committed business changes to downstream consumers. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- outbox_events: id UUID, workspace_id UUID nullable only for global events, event_type, version, aggregate_type, aggregate_id, aggregate_version, payload_json_sanitized, correlation_id, causation_id, created_at, published_at nullable.
- event_consumer_receipts: consumer_id, event_id, handler_version, processed_at, result_hash; unique (consumer_id,event_id).
- event_dead_letters: id, consumer_id, event_id, failure_code, attempts, status.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /internal/events/publish is NOT public; domain owner writes outbox row via transaction helper.
- GET /platform/admin/outbox?status= -> operational metadata (no raw sensitive payload).
- POST /platform/admin/outbox/:id/replay {reason} -> authorized idempotent replay.
- GET /platform/admin/events/:id/deliveries -> receipt trace.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Business mutation, redacted audit and domain event outbox row commit in same PostgreSQL transaction.
2. Publisher emits after commit; repeated publisher attempts cannot duplicate consumer business effects.
3. Per-aggregate ordering by aggregate_version; consumers handle out-of-order delivery or request fresh authoritative state.
4. Event payload is versioned, minimalevent metadata; sensitive data referenced by ID, not copied.
5. Internal consumer source must recheck current tenant scope when reading related data.

## State transitions, orchestration and transactions

- PENDING -> PUBLISHED|RETRYING|DEAD_LETTER; replay DEAD_LETTER -> PENDING with attempt record, preserves original eventId.
- Consumer state NEVER becomes truth for original aggregate.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- eventId/correlationId UUID; eventVersion positive integer; workspaceId present on tenant events, absent only for explicit global events.
- Outbox poll claim SKIP LOCKED (or equivalent); no double ownership of same uncommitted batch.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- platform.events.inspect/replay platform operations only; business consumers use explicit service identities and appropriate scopes.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- PostgreSQL transactions, BullMQ queue, Tracing/Audit, Notifications/Search/Analytics/Workflow/Webhooks.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- OUTBOX_PUBLISH_FAILED, OUTBOX_REPLAY_REQUESTED, OUTBOX_DLQ_CREATED (internal security events; avoid recursive event loops).

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Rollback of domain mutation leaves zero outbox event.
- **AC02** — Two publishers race and exactly one consumer effect survives.
- **AC03** — Consumer error moves to retry then DLQ; later replay does not duplicate prior effects.
- **AC04** — Cross-tenant event reference cannot trigger update in wrong workspace.
- **AC05** — Events preserve aggregate version ordering or safe stale rejection.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
