# Provider connections, model catalog and secure routing

**Specification ID:** `29-AI-CoPilot/01-provider-connections-and-model-routing`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Operate a provider-agnostic AI gateway with workspace-specific data and cost policies. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_providers: id, code OPENAI|AZURE_OPENAI|ANTHROPIC|GOOGLE_GEMINI|OPENROUTER|CUSTOM, adapter_version, active.
- ai_provider_connections: id, workspace_id nullable for platform, owner_scope PLATFORM|WORKSPACE, vault_secret_ref, region, status CONNECTED|UNVERIFIED|SUSPENDED, allowed_classifications, verified_at.
- ai_models: id, provider_id, model_key, capabilities JSON, context_limit, input_rate, output_rate, rate_currency, catalog_version.
- ai_routes: id, workspace_id, scenario_id, priority, provider_connection_id, model_id, max_cost, allowed_region, fallback_rules, enabled.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /ai/providers and GET /ai/models?capability=... -> capability catalogs.
- POST /ai/provider-connections {provider,mode,region,secretSubmission} -> secret ref; never echo raw key.
- POST /ai/provider-connections/:id/verify -> 202/200 status.
- PATCH /ai/routes/:id {scenarioId,primaryModelId,fallbackIds,regionPolicy,classifications,maxCost}.
- POST /internal/ai/route {scenarioId,workspaceId,classification,costLimit} internal only.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Supported initial providers: OpenAI, Azure OpenAI, Anthropic, Google Gemini, OpenRouter via adapters; never create second Python/LangChain backend.
2. Platform-managed and BYOK accounts are separate billable sources and usage tracked for both.
3. Routing intersection of scenario capability, workspace plan, permission, allowed data classification, region and cost cap.
4. Fallback only among explicitly approved models/regions; fallback does not silently lower privacy policies.
5. Server validates external provider outputs as untrusted.
6. Provider-specific rate/pricing configuration versioned for historical cost reporting.

## State transitions, orchestration and transactions

- Connection UNVERIFIED -> CONNECTED|SUSPENDED; disable revokes routing immediately.
- Run QUEUED -> ROUTED -> RUNNING -> SUCCEEDED|FAILED|CANCELLED, usage settlement through Billing owner.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- No raw API key in responses/logs/search; rotate using vault; test connection with sanitized failure.
- Model IDs and provider IDs selected from allowlisted available catalog, never user arbitrary destination URL.
- Classification and regional policy evaluated on every run.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.providers.manage, ai.routes.manage separate from ai.run; platform owners cannot inspect tenant prompts by default.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Secrets vault, Billing entitlement/usage, Platform Jobs/Telemetry, Workspace Settings and AI policy evaluator.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_PROVIDER_CONNECTED, AI_PROVIDER_DISABLED, AI_ROUTE_CHANGED, AI_PROVIDER_FALLBACK_USED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Fallback to disallowed regional model fails closed.
- **AC02** — BYOK key never appears in logs/GET.
- **AC03** — Suspending connection prevents new runs.
- **AC04** — Capability mismatch rejects route before charging.
- **AC05** — Model price change does not rewrite historical usage costs.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
