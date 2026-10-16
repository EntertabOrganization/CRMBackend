# Knowledge spaces, hierarchy and organization

**Specification ID:** `28-Knowledge-Base/01-spaces-and-hierarchy`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Create and organize private, department/project and explicitly shared knowledge spaces without changing workspace tenancy. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- knowledge_spaces: id UUID, workspace_id UUID, name (1–160), description (0–2000), owner_user_id, visibility PRIVATE|SCOPED, status ACTIVE|ARCHIVED|RECYCLED, version INT.
- knowledge_space_bindings: id, workspace_id, space_id, target_type COMPANY|DEPARTMENT|PROJECT, target_id, active BOOLEAN.
- knowledge_articles: id, workspace_id, space_id, parent_article_id nullable, title (1–200), slug (1–120), owner_user_id, current_draft_revision_id nullable, published_revision_id nullable, status DRAFT|PUBLISHED|ARCHIVED|RECYCLED, version.
- article_structure_paths: ancestor_id, descendant_id, depth; optional index projection; canonical parent relation is source of truth.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /knowledge/spaces {name, description?, visibility, bindings?} -> 201 space.
- GET /knowledge/spaces?search&page&limit&sortBy -> authorized list.
- PATCH /knowledge/spaces/:id {name?,description?,expectedVersion} -> 200.
- POST /knowledge/spaces/:id/archive|restore|recycle -> 200.
- POST /knowledge/articles/:id/move {targetSpaceId, parentArticleId?,expectedVersion} -> 200.
- GET /knowledge/spaces/:id/tree -> accessible nested article tree.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Workspace is a tenant; Knowledge Space is only a content container, never an authorization tenant.
2. Acyclic article parent graph, including when moving entire subtrees; nested hierarchy must remain stable and deterministic.
3. Moving an article across spaces recomputes access for every descendant, shared link, index projection and referenced file; never widen rights merely because the old parent was shared.
4. Moving preserves logical article ID and permitted deep links, but directs unauthorized readers to not-found/denied without leaking title.
5. A department/project relationship must belong to the resolved workspace; remove binding only by authorized change.

## State transitions, orchestration and transactions

- Space ACTIVE -> ARCHIVED -> ACTIVE; ACTIVE/ARCHIVED -> RECYCLED -> prior state on restore.
- Article DRAFT -> PUBLISHED; either may be ARCHIVED/RECYCLED; see lifecycle spec.
- Move applies in one transaction with optimistic version check, graph lock and audit/outbox; reject parent-cycle with 409 HIERARCHY_CYCLE.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Name trimmed and nonblank, unique workspace+space slug strategy; article slug uniqueness per sibling scope, case-normalized.
- Parent and destination must share same workspace.
- No children can be orphaned by parent removal; soft-delete subtree or explicitly reparent.
- List/query fields allowlisted; unknown filter fields return 400.
- No direct SQL string input for hierarchy filters.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.space.create/read/update/archive; knowledge.article.move; permission may be OWN, DEPARTMENT_TREE, TEAM, ALL narrowed by space/article ACL.
- Never reveal inaccessible article names via breadcrumbs, counts, tree nodes or index.
- Workspace admin is not automatic cross-tenant reader.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Workspace authorization, Department and Project read policy, shared search, Files access check, Notifications, Audit, Subscription entitlement.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_SPACE_CREATED, KNOWLEDGE_SPACE_ARCHIVED, KNOWLEDGE_ARTICLE_MOVED, KNOWLEDGE_PERMISSIONS_REEVALUATED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — An authorized user creates a space and nested hierarchy; GET tree preserves sibling ordering.
- **AC02** — Attempt to move parent under its descendant returns 409 and leaves tree unchanged.
- **AC03** — Cross-workspace parent/space IDs are rejected without information leakage.
- **AC04** — Moving shared article into private space revokes old discovery access and invalidates AI/search ACL caches.
- **AC05** — Concurrent moves use expectedVersion and only one succeeds.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
