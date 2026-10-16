# Partner default discounts, overrides and effective pricing

**Specification ID:** `32-Partner-Program/03-partner-discounts-and-price-rules`  
**Owner:** `32-Partner-Program`  
**Delivery:** Core V1  
**Scope:** This module owns only the entities below; shared domains remain owners of their records.

## Purpose, boundaries and responsibilities

Own the authoritative discount policy consumed by Billing quotes while retaining rate isolation. This specification requires backend service/API, Next.js administration and end-user screens where applicable, migrations, domain events, permission checks, background execution, and observable error/recovery paths. Do not bypass another module's owning service or create a second business ledger.

## Entity and database contracts

- partner_discount_rules: id, partner_id, target_type DEFAULT|CATEGORY|PRODUCT, target_id nullable, basis_points SMALLINT 0..10000, priority_version, valid_from, valid_until nullable, active, approved_by.
- partner_discount_versions: id, partner_id, version, immutable_rules_snapshot, effective_from.
- partner_price_audit: id, partner_id, action, old_rule_hash, new_rule_hash, actor_id.

Database constraints: UUID immutable IDs; normalized workspace/Partner scope; `NUMERIC` for money/units; `timestamptz` for instants and IANA timezone for local schedules. Reference existing repository ORM and naming. Foreign resources must be checked in their owning domain; use uniqueness/partial indexes for invariants. Add new migrations, never modify applied production migrations. Domain state is authoritative; search/counters/analytics are derived.

## API operations, DTO expectations and responses

All endpoints below are **logical NestJS domain routes**: prefix `/api/v1` except explicitly public host routes. Adapt controller placement to the existing repository without changing behavior. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors are `{ "success": false, "error": { "code": "...", "message": "...", "details": ... }, "requestId": "<correlation-uuid>" }`. Client-supplied `workspaceId`, actor, paid status, generated key and audit fields are never authoritative.

Standard HTTP mapping: `400 VALIDATION_FAILED` malformed/unknown field; `401 UNAUTHENTICATED`; `403 PERMISSION_DENIED`; `404 NOT_FOUND` for absent/hidden resource; `409 INVALID_STATE_TRANSITION|VERSION_CONFLICT|IDEMPOTENCY_CONFLICT`; `422 BUSINESS_RULE_VIOLATION|INSUFFICIENT_QUOTA`; `429 RATE_LIMITED`; `502 PROVIDER_UNAVAILABLE` only for nonaccepted, safely retryable work; `503 DEPENDENCY_UNAVAILABLE` when required production dependency is missing. Never claim side effects that have not committed.

- GET /partners/:id/discounts -> scoped read.
- POST /platform/partners/:id/discount-rules {targetType,targetId,basisPoints,validFrom,validUntil} restricted.
- PATCH /platform/partners/:id/discount-rules/:ruleId {basisPoints?,active?,expectedVersion}.
- POST /internal/partners/resolve-discount {partnerId,productId,categoryIds,pricingTime} -> {basisPoints,ruleVersion,ruleId}.

All mutating requests reject unknown privilege-bearing fields, validate types/enum membership and require `expectedVersion` where state/concurrency is relevant. Side-effecting POSTs use `Idempotency-Key` or an explicit durable command key; a repeated key with changed canonical payload returns `409 IDEMPOTENCY_CONFLICT`. Lists default to `page=1`, `limit=20`, `max=100`; only declared searchable/filterable/sortable fields are accepted, with safe `eq`, `in`, `gte`, `lte`, `contains` and null operators as applicable. Scope filtering applies **before** pagination/counts.

## Business rules

1. Default and per-product/category discounts supported; precedence exact product > most-specific category > default; conflicting same specificity uses fixed priority version then stable ID.
2. Integer basis points 0–10000 (10000=100%), not JS floats.
3. Only Platform Admin changes platform-controlled discounts; audit each change.
4. Billing snapshots resolved rule/version and currency-rounded amount on quote/invoice; never mutate past transaction.
5. Cross-Partner isolation: only relation-bound partner may discount customer purchase; client cannot select arbitrary rate.

## State transitions, orchestration and transactions

- Rule DRAFT -> ACTIVE -> EXPIRED|DISABLED; version changes effective only on new quotes.

Concurrent commands use row or optimistic-version locks; the winning transaction produces one state change, an audit record, and an outbox event. Slow external operations are jobs with bounded retries. An external timeout after provider acceptance requires reconciliation before duplicate work; never assume a browser redirect or an LLM statement is confirmation.

## Input validation, error cases and edge constraints

- validUntil > validFrom; basisPoints integer and within range; Product/Category targets from eligible Billing catalog.
- Resolve time trusted by server; no overlapping inconsistent active rules at same exact target without deterministic version precedence.

Use stable machine-readable error codes; zero partial mutation for validation/authorization errors. Return `409` on stale version/invalid state, `422` on policy/quota failure, and `503 DEPENDENCY_UNAVAILABLE` if an essential production module integration is absent. Secrets, raw tokens, HR private content, payment credentials and raw AI prompts are never written to logs/audit/outbox payloads.

## Authorization and scope

- partner.discount.readOwn, platform.partner.discount.manage; Finance role may read effective own discounts but not platform edit.

Authorization is server-side using current principal, Workspace/Partner membership as appropriate, role, scope, resource ACL/status, entitlement and feature flag. Platform Admin and Partner members do not automatically become Workspace members. Background workers use expressly scoped service identity with source validation. Revocation must defeat stale permission/search/realtime caches.

## Dependencies and cross-module ownership

- Subscription Billing Pricing, PartnerWorkspaceRelation, Provider invoices, Platform Audit/Outbox.

Required integration interfaces are specified under `Shared-Contracts/` and are called through owning domain application services. Test fakes are permitted only in tests; a missing production dependency must be reported as an integration blocker.

## Audit records and domain events

- PARTNER.DISCOUNT_UPDATED, PARTNER.DISCOUNT_RULE_EXPIRED.

All events use `eventId`, `eventType`, `eventVersion`, `workspaceId` when tenant-bound, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId`, `actorType`, and minimum safe `payload`. Consumers deduplicate by event ID/consumer. Audit tracks actor, action, resource, redacted before/after delta hashes, timestamp and correlation; audit is append-only.

## Frontend / UX acceptance

Create list/detail/create/edit forms corresponding to these endpoints, role-aware actionable controls, loading/empty/error/success states, confirmation for destructive/high-impact actions, readable audit/history, optimistic-version conflict recovery, timezone/currency localization where applicable, and keyboard/screen-reader usable UI. Client validation mirrors but never substitutes backend checks. Avoid inventing brand or styling constraints absent from repository.

## Test contracts and acceptance criteria

- **AC01** — 10% stores as 1000 bps and resolves accurately.
- **AC02** — Old invoice remains same after rate change.
- **AC03** — Partner B discount never applies to Partner A customer.
- **AC04** — Expired override falls back to valid rule.
- **AC05** — Same quote repeatedly resolves same immutable price snapshot.
- **S01 Tenant isolation:** foreign workspace/Partner resources not disclosed, including via search and IDs.
- **S02 Authorization denial:** forbidden command has no data, audit, job, event or provider side effect.
- **S03 Retry safety:** duplicate command/provider event returns original result or safely rejects conflict without duplicate effect.
- **S04 Atomicity:** successful critical mutation and redacted Audit+Outbox commit together; failed transaction leaves neither mutation nor orphan event.

**Definition of done:** All module-specific and shared acceptance criteria have executable assertions wired to real repository code and databases as appropriate. No `.skip`, `.todo`, unconditional pass, hard-coded mock success or test deletion. Run targeted integration/e2e and full affected regression; report any unresolved external provider/account prerequisite explicitly.
