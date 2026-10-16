# Plan catalog, immutable versions and entitlement resolution

**Specification ID:** `31-Subscription-Billing/01-plan-catalog-and-entitlements`  
**Owner:** `31-Subscription-Billing`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Offer platform-configurable SaaS plans without hard-coded plan names or implicit data deletion. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- billing_plans: id, code, name, status ACTIVE|RETIRED.
- billing_plan_versions: id, plan_id, version, status DRAFT|PUBLISHED|RETIRED, immutable published entitlements.
- billing_prices: id, plan_version_id, currency, amount NUMERIC, period MONTHLY|YEARLY, effective_at, provider_price_ref.
- billing_entitlement_definitions: code, value_type BOOLEAN|INTEGER|DECIMAL|SET, default_value, quota_kind.
- billing_plan_entitlements: version_id, definition_id, value_json; billing_entitlement_overrides: workspace_id, definition_id, value_json, reason, expires_at.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- POST /platform/billing/plans {code,name} platform admin.
- POST /platform/billing/plans/:id/versions {entitlements,prices} -> draft.
- POST /platform/billing/plan-versions/:id/publish -> immutable.
- GET /billing/plans?currency=&period= -> sellable catalog.
- GET /billing/workspaces/current/entitlements -> effective capability+limits.
- POST /internal/billing/entitlements/check {workspaceId,feature,requestedUnits?} -> allow/deny metadata.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Published plan versions and historical price rows cannot be rewritten; changes create new version.
2. Effective access = rollout flag AND subscription entitlement AND user permission AND resource state.
3. Domain module asks entitlement service by capability code; never compare plan name.
4. Downgrade runs compatibility scan before restricting operations; excess existing records preserved.
5. Feature quotas include stores/sites/employee seats/storage/email/AI/API and appropriate platform categories.

## State transitions, orchestration and transactions

- Plan version DRAFT -> PUBLISHED -> RETIRED; subscription pinned to activated version until defined migration/change.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- Entitlement keys globally unique, values conform to declared type/range; published plan cannot contain negative quotas.
- Prices fixed currency decimal per currency minor unit, no JS float arithmetic.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- billing.plan.manage platform only; workspace billing owner sees effective values but not hidden global override details.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Workspace, Permissions, FeatureFlags, Billing subscriptions, Platform Audit, all domain modules.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- BILLING_PLAN_VERSION_PUBLISHED, BILLING_ENTITLEMENT_CHANGED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — Published plan version not mutated by price edits.
- **AC02** — Feature false rejects new module operation even if role permits.
- **AC03** — Plan downgrade over count limit preserves existing business data.
- **AC04** — Concurrent cache invalidate immediately changes effective access.
- **AC05** — Cross-workspace entitlement check denied for unscoped client.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
