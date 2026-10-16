# AI conversations, messages, privacy and retention

**Specification ID:** `29-AI-CoPilot/03-conversations-messages-and-retention`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Create optional durable assistant conversations while supporting private/no-history usage. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_conversations: id, workspace_id, owner_user_id, assistant_id, classification, retention_policy_id, status ACTIVE|ARCHIVED|DELETED, no_history, last_message_at.
- ai_messages: id, conversation_id, sender USER|ASSISTANT|TOOL, body_encrypted_or_ref, role, model_run_id, occurred_at, redaction_state.
- ai_context_snapshots: run_id, authorized_source_hashes, model_request_hash, expires_at; never raw credential capture.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /ai/conversations {assistantId,classification,noHistory?}.
- POST /ai/conversations/:id/messages {content,idempotencyKey}.
- GET /ai/conversations?ownerId=me and GET /ai/conversations/:id/messages.
- DELETE /ai/conversations/:id -> lifecycle deletion request.
- POST /ai/conversations/:id/export -> authorized export job.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Only owner or specifically authorized scoped roles can access conversation; sharing is opt-in.
2. No-history conversations do not durably store prompts/replies after completion except minimal security, credit and permitted operational audit evidence.
3. Conversation retention class policy enforced; user deletion obeys legal holds and current policy.
4. Business data pulled into AI context rechecked against live ACL each message.
5. Tool output not blindly echoed into persistent history if containing secrets.

## State transitions, orchestration and transactions

- Conversation ACTIVE -> ARCHIVED|DELETED; deleted data purged asynchronously after policy checks.
- Message append commits with unique client message key; duplicate retries never repeat paid runs.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Per-message size, attachment scan and classification limit via entitlements.
- Never log raw prompt/body or provider key in observability; redacted trace IDs.
- History pagination cursor ordered occurredAt,id; cross-workspace ID 404.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.conversation.readOwn/readScoped/deleteOwn/export plus optional explicit admin investigation approval; no implicit Platform Admin access.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- User/Workspace, Retention/LegalHold, Files, Billing usage, Data Portability, Jobs.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_CONVERSATION_CREATED, AI_MESSAGE_ACCEPTED, AI_CONVERSATION_DELETION_REQUESTED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — No-history run produces usage audit but no readable conversation transcript.
- **AC02** — Unauthorized colleague cannot fetch thread by UUID.
- **AC03** — Deleting thread under legal hold is held with explainable status.
- **AC04** — Duplicate message idempotency prevents duplicate provider requests.
- **AC05** — Workspace switch cannot display other tenant conversations.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
