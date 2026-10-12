# Pricing, Promotions, Coupons and Tax Snapshot — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommercePromotionsController`, `CommerceTaxRulesController`  
**Source of truth / domain entities:** `commerce_discount_rules; commerce_coupons; commerce_coupon_redemptions; commerce_order_discounts; commerce_tax_rules`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_discount_rules: workspace_id,store_id,id,code,name,kind PERCENT|FIXED|FREE_SHIPPING,priority,stack_group,combinable,eligibility_json,usage_limit?,per_customer_limit?,start_at?,end_at?,active,version.
- commerce_coupons: workspace_id,store_id,id,code_hash_or_normalized,rule_id,usage_limit,per_customer_limit,expires_at,active; redemption unique(order_id,coupon_id).
- commerce_tax_rules: workspace_id,store_id,id,region,category,tax_rate NUMERIC(10,6),price_basis INCLUSIVE|EXCLUSIVE,effective_from,effective_to?; historical snapshot on order line.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/commerce/stores/:storeId/promotions` | `CommercePromotionsController` | `COMMERCE.PROMOTION_VIEW` | page,limit | Store promotions list. |
| `POST` | `/api/v1/commerce/stores/:storeId/promotions` | `CommercePromotionsController` | `COMMERCE.PROMOTION_MANAGE` | code,kind,value,eligibility,combinable,priority,limits | Create rule. |
| `PATCH` | `/api/v1/commerce/promotions/:promotionId` | `CommercePromotionsController` | `COMMERCE.PROMOTION_MANAGE` | expectedVersion,config changes | Versioned adjustment, no historical Order rewrite. |
| `POST` | `/api/v1/commerce/promotions/:promotionId/coupons` | `CommercePromotionsController` | `COMMERCE.PROMOTION_MANAGE` | code,usageLimit,expiresAt | Create coupon. |
| `POST` | `/api/v1/storefront/:storeSlug/coupons/validate` | `CommercePromotionsController` | `PUBLIC_SCOPED` | checkoutSessionToken,code | Rate-limited eligibility response, no private rules. |
| `GET` | `/api/v1/commerce/stores/:storeId/tax-rules` | `CommerceTaxRulesController` | `COMMERCE.TAX_VIEW` | page,limit | Admin tax config. |
| `POST` | `/api/v1/commerce/stores/:storeId/tax-rules` | `CommerceTaxRulesController` | `COMMERCE.TAX_MANAGE` | region,rate,priceBasis,effectiveFrom | Add effective-dated rule. |
| `PATCH` | `/api/v1/commerce/tax-rules/:taxRuleId` | `CommerceTaxRulesController` | `COMMERCE.TAX_MANAGE` | expectedVersion,effectiveTo? | Future-dated edits, preserve history. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Backend pricing pipeline: resolve active catalog/variant price -> eligible item promotions -> order promotions -> shipping promotions -> tax (inclusive/exclusive per rule) -> currency-safe rounded totals.
2. Do not trust browser discount/tax/price; coupon must belong to same Store and be valid by time, per-customer/per-store usage, product/category, cart quantity and combinability.
3. Promotion conflicts resolved by documented priority, stable tie-break ID and stack groups; discounts never exceed eligible line or create negative cart totals.
4. Coupon redemption committed atomically with Order conversion; failed checkout does not consume usage count permanently.
5. Tax rate/version, base, amount and inclusive/exclusive mode snapshotted on Order, no recalc after historical rate changes.
6. Manual price override is a separate privileged audited action only if repository/product allows, never hidden in checkout JSON.

## Authorization, ownership and tenant isolation

- **Scope of policy:** declared `Permission` for each operation, plus type/document/warehouse/order/actor context as specified above. Public tokens grant only explicitly scoped access.
- **Workspace filter:** all reads, joins, writes, relationship IDs and background jobs use the resolved Workspace; invalid cross-Workspace IDs behave as inaccessible and cannot infer foreign private resource metadata.
- **Field-level safety:** private schema/financial/secret fields may not leak through read, sorting, search, export, logs, errors or public endpoints.
- **Cross-module effects:** call the owning domain service, never directly insert/update another module's table. Service-account actions require least-privilege explicit grants.

## Concurrency, retry, rollback and external failures

- For all `expectedVersion` operations, stale writes return 409 `RESOURCE_VERSION_CONFLICT`, with zero partial mutation/outbox.
- All `Idempotency-Key` commands and external callbacks use a durable dedupe record plus operation-specific unique indexes. Retrying exact payload returns prior outcome; changed payload rejects 409.
- Critical mutation + history + outbox + audited evidence commit once. Simulate failure before commit and assert rollback. Cross-provider effects are asynchronous with visible state, bounded retries and replay-safe compensation.
- Jobs expose QUEUED/RUNNING/SUCCEEDED/FAILED and correlation ID; do not claim provider success on a browser redirect or client request alone.

## Stable domain error codes

- `COMMERCE_COUPON_INVALID`
- `COMMERCE_COUPON_EXPIRED`
- `COMMERCE_COUPON_EXHAUSTED`
- `COMMERCE_PROMOTION_CONFLICT`
- `COMMERCE_TAX_RULE_INVALID`
- `COMMERCE_PRICE_INVALID`

## Durable domain events and global audit

- **Outbox events:** `COMMERCE_PROMOTION_CHANGED`, `COMMERCE_COUPON_REDEEMED`, `COMMERCE_TAX_RULE_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Product Catalog pricing, Currency, Order snapshot, Public Checkout, Audit.

## Testing contract — executable and E2E

Matching files: `Testing/Online-Store-Commerce/pricing-discounts-taxes.spec.ts` and `Testing/Online-Store-Commerce/pricing-discounts-taxes.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** exclusive and inclusive taxes produce deterministic totals
- **2.** coupon expired/redeemed beyond limit rejected
- **3.** concurrent last-use coupon applies at most once
- **4.** noncombinable rule blocks conflicting discount stack
- **5.** free shipping reduces delivery total and records promotion
- **6.** promotion change never alters historical paid Order
- **7.** public coupon probing rate-limited and does not disclose other customer info

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
