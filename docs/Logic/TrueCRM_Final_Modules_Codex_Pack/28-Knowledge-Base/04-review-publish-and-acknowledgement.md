# Publishing, reviews and policy acknowledgements

**Specification ID:** `28-Knowledge-Base/04-review-publish-and-acknowledgement`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Manage approved knowledge publications, review reminders and verifiable employee acknowledgments. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- article_review_policies: id, space_id, required_reviewers, review_interval_days nullable, approval_mode optional, active.
- article_publication_requests: id, article_id, draft_revision_id, status PENDING|APPROVED|REJECTED|CANCELLED, requestor_id, reviewer_id nullable, decision_reason nullable.
- article_acknowledgment_requirements: id, article_id, published_revision_id, audience_scope, due_at nullable, renewal_policy.
- article_acknowledgments: requirement_id, employee_user_id, revision_id, acknowledged_at; unique per requirement+employee+revision.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /knowledge/articles/:id/request-publication {draftRevisionId}.
- POST /knowledge/articles/:id/approve {requestId,expectedRevisionId}.
- POST /knowledge/articles/:id/reject {requestId,reason}.
- POST /knowledge/articles/:id/publish {approvedRequestId?,draftRevisionId}.
- POST /knowledge/articles/:id/acknowledge {publishedRevisionId}.
- GET /knowledge/reviews/overdue and /knowledge/acknowledgements?articleId=... scoped.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Published revision immutable and separately selected from current draft; edit does not publish.
2. Approval applies to exact revision and expires on material content change.
3. Review interval overdue creates reminder/status, not automatic article deletion or republication.
4. Acknowledgment is per user and published revision; updated policy version requires new acknowledgement when configured.
5. Review and publishing are separately granted; a user cannot approve their own request where two-person rule enabled.

## State transitions, orchestration and transactions

- PENDING -> APPROVED|REJECTED|CANCELLED; APPROVED -> PUBLISHED (idempotent by revision).
- Article DRAFT -> PUBLISHED; later draft edits do not move published pointer.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Review deadlines calculated in workspace IANA timezone; prevent impossible past due date where publishing policy forbids.
- Publish requires passed content safety scan, approved files, valid ACL and entitlements.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.article.requestReview, knowledge.article.approve, knowledge.article.publish, knowledge.acknowledgement.read; only targeted employee can acknowledge for self.
- Restricted HR policy acknowledgement lists remain limited to HR/authorized reviewer scope.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Shared Workflow, Scheduler, Notifications, HR employee directory (references only), Files and Audit.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_REVIEW_REQUESTED, KNOWLEDGE_REVIEW_APPROVED, KNOWLEDGE_ARTICLE_PUBLISHED, KNOWLEDGE_ACKNOWLEDGED, KNOWLEDGE_REVIEW_OVERDUE.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Reviewer approves version v3; v4 edit does not inherit that approval.
- **AC02** — Published revision remains readable while draft changes.
- **AC03** — Employee cannot acknowledge another person's required policy.
- **AC04** — Repeat acknowledgement is idempotent; old version remains recorded.
- **AC05** — Overdue review notifies owner but does not erase article.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
