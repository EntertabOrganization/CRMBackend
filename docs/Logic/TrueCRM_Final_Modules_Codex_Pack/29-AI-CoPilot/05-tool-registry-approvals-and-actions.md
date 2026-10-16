# AI tool registry, approvals and business actions

**Specification ID:** `29-AI-CoPilot/05-tool-registry-approvals-and-actions`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Allow tightly scoped AI business actions with explicit authorization and human confirmation. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_tools: id, code, input_schema, output_schema, owner_domain, risk READ|LOW_WRITE|HIGH_WRITE, enabled.
- ai_tool_policies: id, workspace_id, scenario_id, role_scope, action, consent_mode NO_CONFIRM|ALLOW_ONCE|ALLOW_ALWAYS|EVERY_TIME, max_scope.
- ai_tool_grants: id, workspace_id, user_id, tool_id, scope_hash, expires_at, revoked_at, version.
- ai_tool_calls: id, run_id, tool_id, validated_args_hash, status PROPOSED|WAITING_APPROVAL|EXECUTING|SUCCEEDED|DENIED|FAILED, decision_actor, correlation_id.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /ai/tools?scenarioId=... -> allowed tools only.
- POST /ai/runs/:id/tool-calls/:callId/approve {mode:ONCE|ALWAYS,expectedArgumentsHash}.
- POST /ai/runs/:id/tool-calls/:callId/deny {reason?}.
- DELETE /ai/tool-grants/:grantId -> revoke.
- POST /internal/ai/tools/:toolId/execute with validated bound identity (service-only).

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Tool input/output validated against versioned schema; never arbitrary SQL/shell or direct domain-table writes.
2. Read-only tool actions may run without confirmation; low-risk writes ALLOW_ONCE or ALLOW_ALWAYS only when policy permits; high-risk writes always explicit confirmation for each invocation.
3. Re-check original user's permission, scope, entity state, entitlement and grant at execution time, not only at proposal time.
4. Approval binds exact tool arguments hash, version and target resource; changing args invalidates approval.
5. Domain service owns mutations, audit and outbox; tool runner adds AI provenance without duplicating financial effects.

## State transitions, orchestration and transactions

- PROPOSED -> WAITING_APPROVAL|EXECUTING; WAITING_APPROVAL -> EXECUTING|DENIED|EXPIRED; EXECUTING -> SUCCEEDED|FAILED.
- Revocation prevents new calls and any pending call not yet committed.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Approval expires according to policy, no long-lived blanket high-risk grant; actor user signed session required.
- Idempotency key per tool call target/action prevents repeated writes on job retry.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.tool.register/manage, ai.tool.approve, plus exact domain permission; approvals are never substitute for domain authorization.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- CRM, Tasks, Calendar, Sites, Marketing, Billing, Partner command services, Workflow approvals, Audit, Job workers.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_TOOL_PROPOSED, AI_TOOL_APPROVED, AI_TOOL_DENIED, AI_TOOL_EXECUTED, AI_TOOL_GRANT_REVOKED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — High-risk refund tool cannot execute with Allow Always.
- **AC02** — Changing args after approval returns 409 APPROVAL_STALE.
- **AC03** — Missing domain permission denies action even if user approved.
- **AC04** — Duplicated worker delivery creates exactly one business mutation.
- **AC05** — Revoked approval blocks pending call.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
