# Promotions, taxes, shipping quotations

**Owner:** Commerce domain  
**Specification ID:** `OnlineStore-Commerce/10-promotions-taxes-and-delivery`  
**Delivery:** Core V1 or Advanced per `Shared-Contracts/11-release-phases-and-dependencies.md`  
**Scope:** Owned records, workflows and contracts below; existing shared domains remain external dependencies.

## Goal / user value

Provide deterministic pricing rules, promo eligibility, international tax configuration and delivery estimates.

## Entities, fields and keys

Each `id` is a UUID unless it explicitly describes an external provider reference. Entities are authoritative inside this module only; fields refer to concrete logical columns or schema-validated JSON snapshots, not a suggestion to store every object in JSON.

- Promotion(id,storeId,code?,type PERCENT|FIXED|FREE_SHIPPING,scope,rulesJson,priority,startsAt,endsAt,usageLimit?,perCustomerLimit?,stackingGroup,active).
- PromotionRedemption(id,promotionId,orderId,customerKey,amount).
- TaxRule(id,storeId,jurisdiction,productTaxCategory,customerCategory,rate,priceIncludesTax,effectiveFrom,effectiveTo).
- DeliveryRate(id,storeId,zone,weightBand?,amount,currency,validFrom,validTo).

**Required relational rules:** FK relations are workspace-consistent; indexes cover `(workspace_id, id)`, common parent+status/date queries and listed unique keys. Foreign references to other modules are validated through domain services. Existing database naming and ORM conventions take precedence over newly invented implementation technology.

## API contracts

Routes below are logical paths; authenticated/public API controller routes normally use `/api/v1`, while public-host rendering and explicit redirects are served by the Sites routing layer. Define exact DTOs in the repository using the required fields in the entity and rules sections. `POST`/`PATCH` validate request body, unknown privileged fields are rejected, and list GETs have scoped pagination/filtering. Operations that create financial/provider/dispatch/send/approval side effects require an `Idempotency-Key` or durable command key. API responses use the shared envelope/error shape.

- POST /commerce/stores/:id/promotions create.
- PATCH /commerce/promotions/:id update.
- POST /public/carts/:id/coupons validate/apply.
- GET /commerce/stores/:id/tax-rules.
- PUT /commerce/stores/:id/tax-rules configure.
- POST /public/carts/:id/delivery-quote quote options.

**Sample envelope (successful resource command):**
```json
{"success":true,"data":{"id":"<uuid>","version":1,"status":"<valid-state>"},"meta":null}
```
**Sample envelope (validation failure):**
```json
{"success":false,"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","details":{"fields":[{"field":"<field-path>","reason":"<stable-reason>"}]}},"requestId":"<correlation-id>"}
```

## Business rules and validation

- Price calculation order: resolve unit prices -> line subtotal -> applicable discount rules with deterministic priority/stacking -> taxable base -> tax by rules and inclusive/exclusive mode -> delivery charge -> order grand total.
- Use decimals and one documented rounding stage per currency.
- No coupon claim trusted from client without recomputation.
- Promotion caps enforced transactionally at checkout.
- Rules have effective dates and cannot rewrite order snapshots.
- Reject missing required jurisdiction tax policy before store sale activation.
- No claim of statutory tax filing.
- Delivery method eligibility revalidated with checkout address/products/payment method.

## State transitions and command sequencing

- Promotion DRAFT|ACTIVE|INACTIVE|EXPIRED.
- redemption CLAIMED only on order creation and released/handled per cancellation policy.

State updates are server-authoritative, compare expected version/state where concurrency is possible, persist state and audit/outbox atomically and reject forbidden transitions with `409 INVALID_STATE_TRANSITION`. A repeated safe command with the same idempotency key returns its original result and never repeats external side effects.

## Authorization, tenant scope and privacy

- commerce.promotion.manage and commerce.tax.manage finance/admin scopes.
- Public coupon error must not reveal unrelated customer history.

Authorization evaluates module action and the previously approved shared scope model (`OWN`, `DEPARTMENT`, `DEPARTMENT_TREE`, `TEAM`, `ALL`, plus explicitly public/customer contexts). Filter fields and related entities according to their own permissions; do not rely on Next.js UI guards for security.

## Integrations and required dependencies

- Catalog price source.
- Geo/address validation.
- Provider delivery quoting.
- Payments provider restrictions.

Every dependency is accessed through the owning application service or a typed adapter. Missing production dependencies are surfaced as integration blockers; automated tests may use deterministic fakes but may not claim end-to-end production readiness from mocks.

## Events, audit and asynchronous effects

- PROMOTION_REDEEMED.
- PROMOTION_EXHAUSTED.
- TAX_POLICY_CHANGED.

Each event carries `eventId`, `eventType`, `eventVersion`, `workspaceId`, `resourceId`, `occurredAt`, `correlationId`, `causationId`, `actorType`, `actorId` (when applicable), plus a minimal redacted payload. Deliver after commit from durable outbox and deduplicate every consumer by event ID/business key. Include before/after for audited mutable business fields without secrets or excess PII.

## Failure and edge-case handling

- Invalid field/value or absent required configuration: `400 VALIDATION_FAILED` or `409 POLICY_NOT_CONFIGURED`; do not fall back to a guessed business policy.
- Unauthenticated internal request: `401 UNAUTHENTICATED`; authenticated without permission: `403 PERMISSION_DENIED`; invalid cross-tenant references: non-disclosing `404 NOT_FOUND` or `403 PERMISSION_DENIED` consistently with repository policy.
- Version mismatch or conflicting operation: `409 VERSION_CONFLICT` / `409 INVALID_STATE_TRANSITION`; idempotency-key reused with different payload: `409 IDEMPOTENCY_KEY_REUSED`.
- Expired public resource/token: `410 RESOURCE_EXPIRED`; upstream transient failure: `503 DEPENDENCY_UNAVAILABLE` or durable `PENDING_RETRY` where accepting an asynchronous command is safe.
- Provider timeout may have occurred after provider accepted the side effect; reconcile before retrying; never interpret timeout as proven failure or blindly issue a new financial/send/dispatch operation.
- All list/filter/export operations must be scoped by permission and privacy classifications; retries never erase the original audit or immutable history.

## Acceptance criteria and testing

- **AC-01:** Coupon limit 1 with 2 concurrent checkouts succeeds once.
- **AC-02:** Multi-tax inclusive/exclusive total reproducible.
- **AC-03:** Changing rate never edits historic order.
- **AC-S01:** An actor from another workspace cannot read, change, enumerate or reference any of this module's resources, even with a valid foreign UUID.
- **AC-S02:** Unauthorized action/field/scope returns a stable error and leaves authoritative data, outbox and audit unchanged except permitted security-denial logging.
- **AC-S03:** Retry of the same business action returns the original effective result; failed downstream notifications and analytics never roll back an already committed business fact.
- **AC-S04:** Important mutations emit a single durable outbox event and sanitized audit record, recoverable after worker restart.

**Executable test contract:** `Testing/OnlineStore-Commerce/10-promotions-taxes-and-delivery.spec.ts` and applicable `Testing/OnlineStore-Commerce/OnlineStore-Commerce.e2e-spec.ts`. The tests are intentionally fail-closed until integrated with a real repository (see `Testing/README.md`).

## Cross references

- `Agent.md` — global implementation contract
- `Shared-Contracts/01-api-and-query-conventions.md`
- `Shared-Contracts/02-authz-and-tenancy.md`
- `Shared-Contracts/03-data-model-and-retention.md`
- `Shared-Contracts/05-transactions-and-events.md`
- `Shared-Contracts/08-errors-and-observability.md`
- `Shared-Contracts/11-release-phases-and-dependencies.md`
- `Shared-Contracts/14-operation-dtos-and-transaction-assertions.md`
