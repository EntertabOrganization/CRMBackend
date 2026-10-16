# Knowledge imports, exports and templates

**Specification ID:** `28-Knowledge-Base/06-import-export-and-templates`  
**Owner:** `28-Knowledge-Base`  
**Delivery:** Core V1; asynchronous import/export advanced adapters as dependencies available  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Safely import common knowledge formats and export only authorized records. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- knowledge_import_jobs: id, workspace_id, requested_by, file_id, format MARKDOWN|HTML|DOCX, status UPLOADED|PREVIEWED|RUNNING|COMPLETE|PARTIAL|FAILED|CANCELLED, progress.
- knowledge_import_rows: job_id, source_path, target_article_id nullable, outcome, validation_errors.
- knowledge_templates: id, workspace_id, name, content_schema, visibility, version.
- knowledge_export_jobs: id, requester_id, scope_hash, format, status, file_id nullable, expires_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /knowledge/import-jobs {fileId,format,targetSpaceId,mode:PREVIEW} -> 202.
- POST /knowledge/import-jobs/:id/execute {idempotencyKey}.
- GET /knowledge/import-jobs/:id -> row outcomes.
- POST /knowledge/export-jobs {articleIds?,spaceId?,format} -> 202.
- GET /knowledge/export-jobs/:id/download -> authorized expiring file link.
- POST /knowledge/templates and GET /knowledge/templates.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Import never grants source-system permissions automatically; destination ACL policy applies to every imported article.
2. Untrusted HTML is sanitized; images and attachments reference scanned Files, not embedded arbitrary URLs/scripts.
3. Preview reports collisions, unsupported constructs, size and hierarchy depth before creation.
4. Large jobs async with checkpoints/row outcomes; retry from cursor does not duplicate articles.
5. Export includes only content and attachments the requesting principal may currently view, permission recheck at download.

## State transitions, orchestration and transactions

- Import UPLOADED -> PREVIEWED -> RUNNING -> COMPLETE|PARTIAL|FAILED|CANCELLED.
- Export QUEUED -> RUNNING -> READY|FAILED|EXPIRED.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Reject unsupported MIME/extension mismatch, malware/quarantined files, cross-tenant target, path traversal and oversized nested content.
- Output download token expires; never use public predictable raw storage path.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- knowledge.import, knowledge.export, knowledge.template.manage separate; no implicit bulk export from read permission.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Files upload/scanning, object storage, background Jobs, dynamic query infrastructure and Search reindex.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- KNOWLEDGE_IMPORT_STARTED, KNOWLEDGE_IMPORT_FINISHED, KNOWLEDGE_EXPORT_READY.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Untrusted HTML script imported becomes inert.
- **AC02** — Partial import shows accurate per-row error and no duplicate article after retry.
- **AC03** — Export cannot include private sibling article.
- **AC04** — Download after access revoked fails despite unexpired URL.
- **AC05** — Importing DOCX with corrupted bytes returns field/job error, not partial unsafe content.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
