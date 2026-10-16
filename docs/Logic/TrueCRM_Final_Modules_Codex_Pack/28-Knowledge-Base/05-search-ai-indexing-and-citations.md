# Knowledge search, indexing and AI citations

**Specification ID:** `28-Knowledge-Base/05-search-ai-indexing-and-citations`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Provide searchable and citeable content without ever exposing inaccessible source records. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- knowledge_search_projection: workspace_id, article_id, published_revision_id, locale, title_tokens, body_tokens, acl_version, index_version.
- knowledge_ai_chunks: id, workspace_id, article_id, revision_id, chunk_number, content_hash, embedding_ref nullable, indexing_status.
- knowledge_retrieval_policies: space_id, allow_ai_indexing, content_classification, approved_at, approved_by.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /knowledge/search?search=&spaceId=&page=&limit= -> filtered results.
- POST /knowledge/spaces/:id/ai-indexing {enabled,contentClassification} restricted.
- POST /knowledge/articles/:id/reindex -> queued idempotent.
- POST /internal/knowledge/retrieve {userContext,query,limit,scenarioId} -> authorized snippets/citations (internal service only).
- GET /knowledge/articles/:id/citation?revisionId=... -> stable access-controlled reference.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Only published, approved, unarchived, unrecycled content is indexed for AI when space policy allows it.
2. Retrieval always rechecks live workspace ACL + space/article ACL + content-classification policy before returning any bytes; never trust derived index ACL alone.
3. Returned citation includes articleId/revisionId/section anchor and viewer-safe title; citation click rechecks access.
4. Content revocation/publish creates projector reindex/deindex job; stale vectors do not override live policy.
5. Search snippets never expose private attachment names or section text.

## State transitions, orchestration and transactions

- Projection Indexed -> STALE|REMOVED; when publication advances mark previous chunks withdrawn.
- Reindex retriable with version checks; older job must not overwrite newer published revision.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Query length 1–500; page default 1, limit default 20/max 100, sort/relevance filter allowlist.
- Reject cross-workspace query context and unsafe embedding/filter injection.
- Search returns empty unauthorized results rather than disclosing hit count.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.search, knowledge.aiIndex.manage; retrieval delegated to user-authorized scenario, never AI superuser role.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Platform Search, AI RetrievalService, Files ACL, Event Outbox, workers; initial PostgreSQL FTS, optional vector provider behind abstraction.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_INDEX_REQUESTED, KNOWLEDGE_INDEX_COMPLETED, KNOWLEDGE_INDEX_REMOVED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — After article access revocation, stale index cannot return title or excerpt.
- **AC02** — Unpublished draft never appears in AI retrieval.
- **AC03** — AI disabled on space prevents all chunks including old indexed chunks.
- **AC04** — Repeated reindex keeps one active projection per published revision.
- **AC05** — Citation references exact revision used for answer.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
