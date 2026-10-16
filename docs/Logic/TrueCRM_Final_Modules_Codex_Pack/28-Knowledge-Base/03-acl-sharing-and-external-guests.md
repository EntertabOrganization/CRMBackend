# Knowledge permissions, direct sharing and guests

**Specification ID:** `28-Knowledge-Base/03-acl-sharing-and-external-guests`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Serve strictly permission-filtered knowledge with independently revocable invitations. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- knowledge_acl_entries: id, workspace_id, resource_type SPACE|ARTICLE, resource_id, principal_type USER|DEPARTMENT|PROJECT|GUEST, principal_id, level VIEW|COMMENT|EDIT|MANAGE, effect ALLOW|DENY, issued_by, expires_at nullable.
- knowledge_guest_invitations: id, workspace_id, resource_id, email_hash, token_hash, expires_at, status PENDING|ACCEPTED|REVOKED|EXPIRED.
- knowledge_shares: id, article_id, shared_with_user_id, level, granted_by, revoked_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /knowledge/articles/:id/access -> authorized ACL only.
- PUT /knowledge/articles/:id/access {entries,expectedVersion} -> 200.
- POST /knowledge/articles/:id/shares {recipientUserId,level,expiresAt?}.
- POST /knowledge/articles/:id/guest-invitations {email,scope:VIEW,expiresAt} -> delivery queued.
- POST /public/knowledge/guest-invitations/accept {token} -> restricted guest session.
- DELETE /knowledge/articles/:id/guest-invitations/:invitationId -> revoke immediately.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Resource access = active workspace/context capability AND effective space access AND effective article policy; article ACL may narrow but never bypass parent/resource prohibition.
2. Direct article sharing requires MANAGE rights; no link-only authorization bypass.
3. Guest invitations are restricted to specific article(s); no implicit WorkspaceMembership and no broad search access.
4. Revocations invalidate live sessions and derived ACL caches before the next read.
5. Current source authorization is rechecked for AI, global search, article deep links and files even when index stale.

## State transitions, orchestration and transactions

- Guest PENDING -> ACCEPTED|REVOKED|EXPIRED; ACCEPTED -> REVOKED|EXPIRED.
- Access change commits ACL version + outbox + redacted audit in same transaction.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Guest token random high entropy, hash at rest, single activation; default expiry must be configured and capped by retention policy.
- Only recipient email owner may redeem token; rate limit replay and enumeration.
- Privilege grants may not exceed grantor's effective level; deny beats any inherited allow when strict restriction applies.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.access.manage, knowledge.share, knowledge.guest.invite; admin cannot bypass tenant; guests only have explicitly delegated resource rights.
- Forbidden readers get resource-not-found response on public context; internal 403 where disclosure allowed.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Auth/invitations, Notifications email, Workspace ACL/version, Files ACL, global Search and AI retrieval ACL evaluator.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_ACCESS_CHANGED, KNOWLEDGE_GUEST_INVITED, KNOWLEDGE_GUEST_REVOKED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Direct link does not disclose an article to a different department.
- **AC02** — Guest invitation access is revoked instantly without deleting published article.
- **AC03** — Shared-with-me results contain only currently authorized articles.
- **AC04** — Permission change followed by stale search index still returns no unauthorized data.
- **AC05** — Workspace/Article and embedded File permissions are intersected.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
