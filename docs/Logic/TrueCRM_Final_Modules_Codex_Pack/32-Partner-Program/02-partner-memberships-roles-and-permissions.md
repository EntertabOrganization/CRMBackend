# Partner memberships, fixed roles and scoped permissions

**Specification ID:** `32-Partner-Program/02-partner-memberships-roles-and-permissions`  
**Owner:** `32-Partner-Program`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Provide Partner staff administration while keeping PartnerMembership separate from WorkspaceMembership. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- partner_roles: id, partner_id, code OWNER|SALES|FINANCE|SUPPORT|CUSTOM, name, permissions_set, protected BOOLEAN, version.
- partner_memberships: id, partner_id, user_id, partner_role_id, status INVITED|ACTIVE|SUSPENDED|REMOVED, is_deleted, joined_at; unique active(partner_id,user_id).
- partner_invitations: id, partner_id, email_hash, role_id, token_hash, expires_at, status PENDING|ACCEPTED|EXPIRED|REVOKED.
- partner_role_permissions: partner_role_id, permission_code, scope PARTNER_ALL|OWN_RELATIONSHIPS|ASSIGNED_WORKSPACES, effect.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /partners/:id/members/invitations {email,roleId} -> 202.
- POST /partners/invitations/accept {token}.
- GET /partners/:id/members?search=&roleId=&status=.
- PATCH /partners/:id/members/:memberId {roleId?,status?,expectedVersion}.
- POST /partners/:id/roles {name,permissionCodes} where CUSTOM allowed.
- GET/PATCH /partners/:id/roles/:roleId and DELETE custom role if unassigned.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. One PartnerRole per active User per Partner; same User can be a member of multiple Partners and Workspaces independently.
2. Protected Partner Owner cannot be removed, suspended or demoted as last active owner without controlled ownership transfer and audit.
3. Partner permission catalog uses shared role infrastructure, but Partner grant never means Workspace resource access; extra delegated Workspace policy evaluated separately.
4. Initial roles OWNER (manage own Partner staff), SALES (provision/referrals), FINANCE (billing summary/payout requests), SUPPORT (delegated support only), CUSTOM later.
5. Deny cross-Partner member listing even if user UUID known.

## State transitions, orchestration and transactions

- Invitation PENDING -> ACCEPTED|EXPIRED|REVOKED; Membership INVITED -> ACTIVE -> SUSPENDED|REMOVED; role changes versioned.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Invitation hashed token expires, email normalizes, no duplicate active partner membership.
- Permission code allowlist and scope enum validated; cannot assign platform.partner.application.approve to Partner role.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- partner.members.invite/read/manage, partner.roles.manage with effective Partner scope; Platform Admin authority separate from workspace admin.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Auth, Shared Permission/Query framework, Partner delegated access, Notifications, Audit.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- PARTNER.MEMBER_ADDED, PARTNER.MEMBER_ROLE_CHANGED, PARTNER.MEMBER_REMOVED, PARTNER.ROLE_CHANGED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Partner A owner cannot list Partner B members.
- **AC02** — Partner membership does not grant any workspace route.
- **AC03** — Cannot remove last Partner Owner.
- **AC04** — Expired invitation rejected without User creation side effect.
- **AC05** — Custom Partner role cannot include Platform Admin privileges.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
