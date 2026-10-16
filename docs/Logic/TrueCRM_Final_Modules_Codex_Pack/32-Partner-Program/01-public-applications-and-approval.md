# Public Partner application, verification and atomic approval

**Specification ID:** `32-Partner-Program/01-public-applications-and-approval`  
**Owner:** `32-Partner-Program`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Enroll verified Partner organizations through Platform Admin approval without granting tenant ownership. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- partner_applications: id, applicant_user_id, partner_name, country, email_normalized, phone, website nullable, business_description, terms_version, privacy_version, status PENDING|APPROVED|REJECTED, decision_by nullable, decision_reason nullable, version.
- partners: id, name, country, website, status ACTIVE|SUSPENDED, default_discount_basis_points, is_deleted, version.
- partner_approval_events: id, application_id, decision, actor_user_id, idempotency_key, occurred_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /public/partners/applications {firstName,lastName,email,phone,partnerName,country,website?,businessDescription,termsAccepted,privacyAccepted} -> 202 pending; never expose account existence.
- GET /platform/partner-applications?status=&country=&search=&page=&limit.
- POST /platform/partner-applications/:id/approve {expectedVersion,idempotencyKey} -> 200 partner ID.
- POST /platform/partner-applications/:id/reject {reason,expectedVersion}.
- GET /partners/applications/me -> own applications.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Reuse global User when email normalized matches; verify email according to Auth policy and never duplicate identity.
2. Only protected Platform Admin approves/rejects; approval transaction creates Partner organization, applicant PartnerMembership, protected Partner Owner role, default discount settings, audit + outbox atomically.
3. Rejected applicant keeps User and complete application history; reapplication allowed after applicable policy.
4. Detect same applicant conflicting PENDING application and probable org duplicates; flag review but do not auto-merge legal organizations.
5. Approval idempotent on same key and same payload; reject simultaneous approvals with version conflict rather than duplicate Partner.

## State transitions, orchestration and transactions

- PENDING -> APPROVED|REJECTED; REJECTED can create a NEW PENDING application, old decision immutable.
- Approval creates Partner ACTIVE initial state.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- First/last 1–100, partner name 2–200, phone E.164 normalization where applicable, country ISO-3166-1, website HTTPS valid URL, terms/privacy version required.
- No client-defined partnerId, owner role or discount percentage accepted on public application.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- Public submit rate limited; platform.partner.application.review/approve requires global Platform Admin + MFA; Partner roles cannot approve own application.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Global Authentication/Users, Platform admin authority, Partner Roles, Discount Service, Audit/Outbox, Notifications.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- PARTNER.APPLICATION_SUBMITTED, PARTNER.APPLICATION_APPROVED, PARTNER.APPLICATION_REJECTED, PARTNER.CREATED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Concurrent admins approving same application produce exactly one Partner.
- **AC02** — Applicant with existing User reuses identity.
- **AC03** — Non-Platform Admin approve returns 403 and does not create Partner.
- **AC04** — Reject then reapply preserves old application.
- **AC05** — Duplicate probable org raises review instead of merging unrelated legal entities.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
