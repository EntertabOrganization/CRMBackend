# External AI clients, OAuth and MCP tool exposure

**Specification ID:** `29-AI-CoPilot/08-external-mcp-and-oauth`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Advanced after core AI tool safety  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Expose selected TrueCRM tools to approved external AI clients without giving blanket API access. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_external_clients: id, workspace_id, name, client_type MCP|OAUTH_APP, allowed_scenarios, status ACTIVE|REVOKED.
- ai_external_grants: id, workspace_id, user_id, client_id, scopes, tool_ids, expires_at, revoked_at, token_fingerprint.
- ai_external_sessions: id, grant_id, capability_hash, last_seen_at, revoked_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /ai/external-clients {name,redirectUris,scopes} admin.
- POST /ai/external-clients/:id/authorize with user interactive consent.
- GET /ai/external-clients?owner=... and DELETE /ai/external-grants/:id.
- POST /mcp/execute-tool {toolName,arguments} through verified scoped auth; protocol-specific transport can follow repository standards.
- GET /ai/external-grants -> user-visible connections.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. OAuth grants are short-lived, revocable and bound to explicit scopes; rotating refresh credentials and PKCE required where appropriate.
2. Every MCP invocation resolves workspace membership, active grant, module permission and entitlement; never accept workspaceId from model output as authority.
3. Tool list is narrowed per user/scenario and never reveals forbidden tool metadata or object names.
4. External provider client cannot read private AI conversations without explicit scope.
5. High-risk actions retain user confirmation even from approved MCP clients.

## State transitions, orchestration and transactions

- Grant ACTIVE -> REVOKED|EXPIRED; revocation invalidates sessions and cache immediately.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Validated redirect URI allowlist, CSRF/state, rate limits, secrets hashed, no broad wildcard scopes or arbitrary external callbacks.
- Request IDs and outbound provider tokens redacted.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.mcp.manage, ai.external.connect, scoped ai.tool.invoke; normal Workspace and resource permissions mandatory.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Auth/OAuth, AI Tool Registry, Platform RateLimits/Audit/Events, Permissions, Billing quotas.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_EXTERNAL_CONNECTION_GRANTED, AI_EXTERNAL_CONNECTION_REVOKED, AI_MCP_TOOL_INVOKED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Revoked MCP grant fails without executing tool.
- **AC02** — Tool inventory filtered by user rights.
- **AC03** — External client cannot switch to another tenant through crafted arguments.
- **AC04** — High-risk action still waits for exact-args approval.
- **AC05** — Expired grant fails even if cache stale.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
