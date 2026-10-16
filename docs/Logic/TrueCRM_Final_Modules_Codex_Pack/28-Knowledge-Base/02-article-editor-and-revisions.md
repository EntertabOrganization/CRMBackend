# Article editor, structured content and revisions

**Specification ID:** `28-Knowledge-Base/02-article-editor-and-revisions`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Author rich knowledge content with durable autosave and immutable revision history. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- article_revisions: id, workspace_id, article_id, version_number, content_json, content_hash, state DRAFT|PUBLISHED, author_user_id, occurred_at timestamptz.
- article_sections: id, revision_id, stable_anchor, heading_level, order; anchors unique within revision.
- article_edit_sessions: article_id, user_id, last_seen_at, baseline_revision_id, edit_token_hash, conflict_state nullable.
- article_file_bindings: article_id, revision_id, file_id, usage_kind EMBED|ATTACHMENT.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /knowledge/articles {spaceId,parentArticleId?,title} -> 201 DRAFT.
- PUT /knowledge/articles/:id/draft {content,baseRevisionId,expectedVersion} -> new revision and version; idempotency key for autosave.
- GET /knowledge/articles/:id/revisions?page&limit -> scoped historical list.
- GET /knowledge/articles/:id/revisions/:revisionId -> allowed revision content.
- POST /knowledge/articles/:id/revert {sourceRevisionId,expectedVersion} -> NEW draft revision (not mutation).
- POST /knowledge/articles/:id/sections/:anchor/link -> signed or access-preserving deep link.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Core V1: optimistic concurrency plus autosave and explicit conflict UI; advanced phase: collaborative editing with durable merged revisions.
2. Never silently overwrite another editor's changes: stale baseRevisionId => 409 REVISION_CONFLICT with safe metadata and merge option.
3. Content supports heading, paragraph, list, checklist, quote, table, code, image/video/file, links, callout; schema whitelist, sanitize HTML, prohibit executable scripts.
4. Section direct links use stable anchor; moving or reverting preserves anchor when unchanged; link still checks current viewer authorization.
5. Restore source revision by writing new draft revision; immutable historical revision remains untouched.

## State transitions, orchestration and transactions

- Revision DRAFT saved by version increment; one publishedRevisionId remains unchanged until authorized publish.
- All edits are transactional Article version + Revision + outbox; do not emit one audit event per keystroke (batch autosave).

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Content size and attachment limits obtained via plan entitlements, validated server-side; never blindly paste untrusted HTML.
- File binding validates file scan state plus space/article permission; quarantine not publicly accessible.
- Revision IDs must belong to given article and workspace; title length 1–200.
- Idempotent autosave retries return the same new revision.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.article.create/edit/readRevision/revert, separate knowledge.article.publish; draft readers require edit or explicit review permission.
- Article ACL and File ACL both constrain embedded file access.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Files/Drive version owner, object storage, shared sanitizer, notifications only for material edits, Platform audit/outbox.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_ARTICLE_CREATED, KNOWLEDGE_DRAFT_SAVED, KNOWLEDGE_REVISION_RESTORED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Two concurrent editors update same baseline: one succeeds, other receives 409 without losing changes.
- **AC02** — Draft update does not mutate published content.
- **AC03** — Unsafe script/embedded arbitrary HTML is rejected or sanitized and cannot execute in preview.
- **AC04** — File attachment inaccessible despite article grant when File ACL denies access.
- **AC05** — Reverting a revision creates a new latest revision retaining audit chain.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
