# Archive, recycle bin, retention and legal holds

**Specification ID:** `28-Knowledge-Base/07-archive-trash-retention-and-moves`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Preserve knowledge safely through archive, deletion, restoration and final purge policies. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- knowledge_lifecycle_events: id, article_id, prior_status, next_status, actor_id, reason, occurred_at.
- knowledge_tombstones: id, article_id, original_space_id, original_parent_id, deleted_at, recover_until, legal_hold BOOLEAN.
- knowledge_retention_assignments: resource_id, category KNOWLEDGE_CONTENT|KNOWLEDGE_REVISION, policy_id.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /knowledge/articles/:id/archive|unarchive.
- DELETE /knowledge/articles/:id -> RECYCLED (not hard delete).
- POST /knowledge/articles/:id/restore -> restores prior ACTIVE/ARCHIVED state.
- POST /knowledge/articles/:id/purge {reason,confirmation} privileged; retention/legal hold check.
- GET /knowledge/recycle-bin?spaceId=... -> authorized list.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Archive and Recycle Bin are different; archive remains recoverable and not AI-retrievable by default.
2. Recycle Bin default 30 days, configurable jurisdiction policy; legal holds block purge.
3. Restoring an item that was archived before deletion returns it to archived state.
4. Purge removes or anonymizes content by policy, keeps required redacted audit, breaks public/AI indexing promptly.
5. Moving a deleted article is prohibited; parent restoration handles path collisions deterministically.

## State transitions, orchestration and transactions

- PUBLISHED|DRAFT -> ARCHIVED -> previous; ACTIVE|ARCHIVED -> RECYCLED -> restored prior state; RECYCLED -> PURGED after hold/retention gate.
- Lifecycle command idempotent; delete twice no duplicate history.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Purge before recover_until unless explicit override policy allows? reject; legal hold always rejects.
- Restored slug collision requires explicit new path or 409 with collision details visible only to manager.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.article.archive/delete/restore/purge separately granted; purge two-person approval configurable for sensitive knowledge.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Platform Retention, Search deindex, AI chunk removal, File bindings, legal-hold service, Audit.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_ARTICLE_ARCHIVED, KNOWLEDGE_ARTICLE_RECYCLED, KNOWLEDGE_ARTICLE_RESTORED, KNOWLEDGE_ARTICLE_PURGED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — 30-day recycle default retains recoverability; legal hold blocks day-31 purge.
- **AC02** — An archived article removed to bin restores archived, not published.
- **AC03** — AI retrieval stops immediately on recycle despite lagging vector cleanup.
- **AC04** — Audit survives permanent purge with sanitized reference.
- **AC05** — Unauthorized purge returns 403 and changes nothing.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
