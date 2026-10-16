# Notifications, preferences, mandatory notices

**Specification ID:** `30-Platform-Services/03-notifications-preferences-and-delivery`  
**Owner:** `30-Platform-Services`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Deliver in-app, email and push notifications reliably without conflating them with audit records. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- notifications: id, workspace_id, recipient_user_id, type, subject_ref, template_version, status UNREAD|READ|ARCHIVED, occurred_at.
- notification_preferences: user_id, workspace_id, topic, channel IN_APP|EMAIL|PUSH, enabled, quiet_hours.
- notification_deliveries: id, notification_id, channel, attempt, provider_message_id, status QUEUED|SENT|DELIVERED|FAILED, dedupe_key.
- device_registrations: id, user_id, push_token_hash, last_verified_at, revoked_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /notifications?status=&page=&limit -> scoped inbox.
- POST /notifications/:id/read or /unread; POST /notifications/read-all.
- GET/PATCH /notifications/preferences {topic,channels,quietHours}.
- POST /internal/notifications/emit {type,recipientIds,entityRef,idempotencyKey} internal only.
- POST /notifications/devices and DELETE device.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. In-app notification persists before websocket/push fanout; missed realtime can be recovered by GET.
2. Preferences govern optional topics; security, access-revocation and billing-critical notices are mandatory under policy (with lawful delivery channel).
3. Deduplicate by recipient+event+topic, never duplicate on worker retry.
4. Email/push provider statuses are separate from in-app read state.
5. Avoid including private record details in notification preview if recipient loses access.

## State transitions, orchestration and transactions

- UNREAD -> READ|ARCHIVED, READ -> UNREAD|ARCHIVED.
- Delivery QUEUED -> SENT -> DELIVERED|FAILED; provider event idempotent.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Recipient principal required; no notification to unrelated Workspace; never expose raw mobile device token.
- Quiet hours validated against IANA timezone, exceptions only for mandatory security notices as policy.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- notification.readOwn/managePreferences; platform.notification.admin for templates/system operations; URL targets reauthorize at click.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Outbox, Email/Push Provider adapters, Realtime, Workspace permission cache, Retention.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- NOTIFICATION_CREATED, NOTIFICATION_READ, NOTIFICATION_DELIVERY_FAILED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Critical security notice delivered even if optional preferences off.
- **AC02** — Missing live socket recovered on inbox refresh.
- **AC03** — Revoked record does not reveal private title through notification body.
- **AC04** — Duplicate provider callback does not change delivery twice.
- **AC05** — Two workspaces with same user keep independent notifications.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
