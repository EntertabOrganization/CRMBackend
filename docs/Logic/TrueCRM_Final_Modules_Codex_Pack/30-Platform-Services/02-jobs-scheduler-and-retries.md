# Durable jobs, schedules, retries and dead-letter handling

**Specification ID:** `30-Platform-Services/02-jobs-scheduler-and-retries`  
**Owner:** `30-Platform-Services`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Execute recoverable asynchronous operations with durable checkpoints and operational controls. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- background_jobs: id, workspace_id nullable, type, payload_ref, idempotency_key, state QUEUED|RUNNING|RETRYING|SUCCEEDED|FAILED|DEAD_LETTER|CANCELLED, attempts, next_run_at, correlation_id.
- scheduled_jobs: id, owner_module, cron_or_due_at, timezone, active, occurrence_key, last_enqueued_at.
- job_attempts: job_id, attempt_number, started_at, completed_at, error_code, redacted_trace_ref.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /internal/jobs/enqueue {type,payloadRef,idempotencyKey} privileged internal.
- GET /platform/admin/jobs?status=&type=&workspaceId= (scoped).
- POST /platform/admin/jobs/:id/retry|cancel {reason}.
- GET /platform/admin/jobs/:id/attempts.
- PATCH /platform/admin/schedules/:id {active,expectedVersion}.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Use Redis/BullMQ for execution, PostgreSQL for durable job metadata/receipts and business truth.
2. Queue delivery is at least once; handlers idempotent by business effect key.
3. Transient failures retry with exponential backoff+bounded jitter, max attempts configured per job class.
4. Permanent validation/auth errors never retried automatically.
5. Schedule occurrence uniqueness prevents duplicate execution after worker restart/timezone transition.
6. Recovery scans reconcile queued database jobs missing from Redis.

## State transitions, orchestration and transactions

- QUEUED -> RUNNING -> SUCCEEDED|RETRYING|FAILED|CANCELLED; RETRYING -> RUNNING|DEAD_LETTER; DEAD_LETTER -> QUEUED only authorized replay.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Max attempts >=1 and <= configured safety cap; `attempts` increments before execution.
- Scheduled local time must preserve IANA timezone; DST nonexistent/duplicate local times follow per-schedule policy.
- Payload never contains usable credentials.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- platform.jobs.inspect/retry/cancel limited operations; ordinary user sees only own module jobs through domain queries.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Redis/BullMQ, Outbox, Audit, Notification, Observability, Domain handlers.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- JOB_QUEUED, JOB_DEAD_LETTERED, JOB_REPLAY_REQUESTED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Worker crash halfway resumes without repeated business effect.
- **AC02** — Permanent error never retries endlessly.
- **AC03** — Manual replay produces documented audit actor.
- **AC04** — Repeated schedule enqueue for same occurrence generates exactly one job.
- **AC05** — Deleting Redis cache does not delete authoritative business job state.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
