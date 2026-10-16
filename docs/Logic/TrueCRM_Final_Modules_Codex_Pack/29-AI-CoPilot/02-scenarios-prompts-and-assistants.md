# AI scenario registry, prompt versions and assistants

**Specification ID:** `29-AI-CoPilot/02-scenarios-prompts-and-assistants`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Define safe AI behavior per module and scenario with versioned prompts and capabilities. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_scenarios: id, code, workspace_id nullable, module_code, enabled, input_schema, output_schema, classification, tool_policy_id.
- ai_prompt_templates: id, scenario_id, version, immutable_content, status DRAFT|PUBLISHED|RETIRED, published_by.
- ai_assistants: id, workspace_id, name, prompt_version_id, allowed_scenarios, allowed_tools, retrieval_profile_id, status ACTIVE|DISABLED.
- ai_roles: id, workspace_id, behavior_instructions, guardrails; not an authorization role.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /ai/scenarios/:code/runs {input,assistantId?} -> run.
- POST /ai/prompts {scenarioId,content} -> draft version.
- POST /ai/prompts/:id/publish {expectedVersion}.
- POST /ai/assistants {name,scenarioIds,promptVersionId,retrievalProfileId?}.
- PATCH /ai/workspace-settings {moduleEnabled,scenarioSettings,classificationRules}.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. AI behavior role never grants Workspace module permission.
2. Prompt definitions versioned; runs pin immutable prompt/scenario version for reproducibility.
3. Workspace administrators enable scenarios per module and role; HR/Billing scenarios opt-in separately.
4. Include CRM summary, transcription, extraction, Task/Chat/Feed/Mail/Calendar/Site/Marketing/Document assistance as registry capabilities without implementing owning domain mutations inside AI.
5. Untrusted source text is data, not system prompt; defend against prompt injection.

## State transitions, orchestration and transactions

- Prompt DRAFT -> PUBLISHED -> RETIRED; assistant ACTIVE -> DISABLED.
- Runs pin scenario/template versions even if later edited.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Output schema validation returns 422 INVALID_AI_OUTPUT; no invalid result persisted as business field.
- Scenario IDs from server registry, module permissions checked at start and before any tool execution.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.scenario.manage, ai.prompt.publish, ai.assistant.manage, ai.scenario.execute; module-specific permission and billing entitlement further restrict every run.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Domain-owned services, Authorized Context Builder, Tool Registry, Billing quotas, Prompt Version Service.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_SCENARIO_CHANGED, AI_PROMPT_PUBLISHED, AI_ASSISTANT_DISABLED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Unprivileged user cannot enable HR-sensitive AI.
- **AC02** — Prompt v1 run is unaffected by v2 publication.
- **AC03** — Assistant cannot call tool outside configured policy.
- **AC04** — Invalid structured extraction is rejected without creating CRM fields.
- **AC05** — Prompt injection inside retrieved article cannot override module permissions.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
