# Domain assistants, extraction and media generation

**Specification ID:** `29-AI-CoPilot/10-domain-assistance-and-media`  
**Owner:** `29-AI-CoPilot`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Provide controlled reusable AI scenarios that assist other TrueCRM modules without owning their records. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- ai_scenario_inputs: typed validated scenario request metadata; persisted only per data policy.
- ai_transcripts: id, workspace_id, source_file_id, scenario_id, language, diarization_meta, review_status, created_by.
- ai_extractions: id, run_id, target_type, proposed_fields_json, validation_status, applied_at nullable.
- ai_generated_artifacts: id, run_id, file_id, media_type, review_state.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /ai/scenarios/transcribe {fileId,language?,diarization?} -> 202.
- POST /ai/scenarios/extract-fields {sourceId,targetType,schemaVersion} -> proposed structured result.
- POST /ai/scenarios/generate-content {targetModule,type,prompt,sourceIds?} -> draft.
- POST /ai/extractions/:id/apply {expectedTargetVersion,approvedFields} -> owning domain service.
- POST /ai/scenarios/generate-image {brief,providerRouteId?} -> scanned file artifact.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Support CRM call/chat summaries, meeting notes, structured fields, Task/email/calendar content, document/site/marketing assistance, image generation and workflow AI steps as registered scenarios.
2. AI suggestions are drafts; published site page, campaign sends, HR record edits and financial actions require domain-specific approval.
3. Generated binary is scanned and stored by Files owner; provider-generated URLs not direct permanent assets.
4. Transcription/source content is untrusted and subject to data classification/provider retention.
5. Derived content can always be re-generated and does not overwrite source records without explicit action.

## State transitions, orchestration and transactions

- Extraction PROPOSED -> REVIEWED|REJECTED -> APPLIED if target version still valid.
- Artifact GENERATED -> SCANNED -> APPROVED or QUARANTINED.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Source file must be accessible and scanned; output field definitions validated against domain schema; new fields not silently invented.
- Apply optimistic version expectedTargetVersion; 409 on stale target.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- ai.scenario.execute plus source File read and target domain update.
- No direct SQL or record write from raw model result.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Files, CRM, Activities, Calendar, Marketing, Sites, Documents, Workflow, Audit, Billing.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- AI_ARTIFACT_GENERATED, AI_EXTRACTION_PROPOSED, AI_EXTRACTION_APPLIED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Invalid extraction never updates CRM.
- **AC02** — Unauthorized File cannot be transcribed.
- **AC03** — Editing target after extraction causes version conflict on apply.
- **AC04** — Generated campaign cannot send without Marketing approval.
- **AC05** — Unsafe generated image quarantined and cannot be shared.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
