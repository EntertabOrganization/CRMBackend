# Asynchronous AI runs, retries and cancellation

**Specification ID:** `29-AI-CoPilot/06-async-runs-and-fallback`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Make long AI operations recoverable, observable and reliably billed. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_runs: id, workspace_id, requester_id, scenario_id, model_route_version, status QUEUED|RUNNING|WAITING_APPROVAL|SUCCEEDED|FAILED|CANCEL_REQUESTED|CANCELLED, input_hash, idempotency_key, error_code, started_at, finished_at.
- ai_run_steps: id, run_id, step_kind, attempt_no, state, provider_request_id, usage_reservation_id, occurred_at.
- ai_artifacts: id, run_id, file_id, artifact_type, safety_state.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /ai/runs {scenarioId,input,contextRefs?,idempotencyKey} -> 202 runId.
- GET /ai/runs/:id -> status, safe result, usage.
- POST /ai/runs/:id/cancel {expectedVersion?} -> 202.
- POST /ai/runs/:id/retry -> limited to failed safe step; authorization checked.
- GET /ai/runs?scenarioId=&status= -> scoped list.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Reserve estimated usage before dispatch, settle exact validated provider usage after terminal status, release unused reservation.
2. Retry only transient failures with exponential backoff and provider-request idempotency where available.
3. Timeout after provider accepts request requires provider reconciliation before new request to prevent double charge/work.
4. Cancellation best-effort after dispatch; never claim cancel eliminated work that provider already completed.
5. Fallback obeys approved route and classification, and usage ledger records actual provider/model per attempt.

## State transitions, orchestration and transactions

- QUEUED -> RUNNING -> WAITING_APPROVAL|SUCCEEDED|FAILED|CANCEL_REQUESTED; CANCEL_REQUESTED -> CANCELLED|SUCCEEDED|FAILED.
- Terminal replay does not create duplicate results or credit debits.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Idempotency key scoped workspace+principal+scenario, same key different payload => 409.
- Max steps/runtime/token/credits from entitlements; fail gracefully on quota exhaustion.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.run.create/readOwn/cancelOwn; retry elevated role or original owner with same original access; asynchronous worker uses scoped identity.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- BullMQ, transactional Outbox, provider adapters, Billing usage reserve/settle, Notifications, Observability.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_RUN_QUEUED, AI_RUN_SUCCEEDED, AI_RUN_FAILED, AI_RUN_CANCELLED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Repeated submit key creates one run.
- **AC02** — Cancellation releases unused reserved credits but retains consumed usage.
- **AC03** — Provider timeout never silently double-debits.
- **AC04** — Fallback respects residency and spend cap.
- **AC05** — Worker restart resumes durable state and terminal run remains terminal.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
