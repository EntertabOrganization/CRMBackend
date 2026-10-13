# Public Cart, Checkout, Server Prices and Idempotency — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommerceCartsController`, `CommerceCheckoutController`  
**Source of truth / domain entities:** `commerce_carts; commerce_cart_items; commerce_checkout_sessions; commerce_checkout_idempotency`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_carts: id,workspace_id,store_id,session_token_hash,status ACTIVE|CHECKOUT|CONVERTED|ABANDONED|EXPIRED,currency,created_at,last_activity_at,expires_at,version; session secret shown once to holder.
- commerce_cart_items: workspace_id,cart_id,product_id,variant_id?,quantity NUMERIC(18,6),selected_options_json,version; unique(cart_id,inventory_key,options_hash).
- commerce_checkout_sessions: id,workspace_id,cart_id,customer_snapshot,address_snapshot,delivery_rate_id?,payment_method_id?,quote_hash,expires_at,status DRAFT|QUOTED|ORDERED|EXPIRED,order_id?,version; unique(cart_id,successful_conversion_key).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/storefront/:storeSlug/carts` | `CommerceCartsController` | `PUBLIC_SCOPED` | session context | Create Cart token, rate-limited. |
| `GET` | `/api/v1/storefront/:storeSlug/carts/:cartToken` | `CommerceCartsController` | `PUBLIC_TOKEN` | cartToken | Authorized cart view, recomputed prices. |
| `POST` | `/api/v1/storefront/:storeSlug/carts/:cartToken/items` | `CommerceCartsController` | `PUBLIC_TOKEN` | productId,variantId?,quantity,options? | Validate published/sellable product; add. |
| `PATCH` | `/api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId` | `CommerceCartsController` | `PUBLIC_TOKEN` | quantity,expectedVersion | Recalculate no client unit price. |
| `DELETE` | `/api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId` | `CommerceCartsController` | `PUBLIC_TOKEN` | itemId | Remove only own item. |
| `POST` | `/api/v1/storefront/:storeSlug/checkout-sessions` | `CommerceCheckoutController` | `PUBLIC_TOKEN` | cartToken,customerInfo,shippingInfo,payerType | Create priced checkout draft. |
| `POST` | `/api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/quote` | `CommerceCheckoutController` | `PUBLIC_TOKEN` | deliveryMethodId?,couponCodes[],paymentMethodId | Recalculate discounts/taxes/delivery and issue short-lived quoteHash. |
| `POST` | `/api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/place-order` | `CommerceCheckoutController` | `PUBLIC_TOKEN` | quoteHash,consents[],Idempotency-Key | Revalidate stock/price/tax/coupon, one Order, inventory reservation/compensation. |
| `GET` | `/api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/status` | `CommerceCheckoutController` | `PUBLIC_TOKEN` | sessionToken | Safe public status only, never CRM private data. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Guest allowed without employee membership. Cart/Checkout bearer token high entropy and hashed at rest, store-specific and expiring; anti-enumeration and rate limits.
2. Backend derives all prices, tax, discount, availability and workspace from published Store, product catalog and policy; ignores/rejects client unitPrice,taxTotal,discountTotal,workspaceId.
3. Quote returns stable computed price breakdown and expires on catalog/discount/delivery changes. place-order checks quoteHash and re-quotes or responds CHECKOUT_REQUOTE_REQUIRED on staleness.
4. Idempotency unique (workspace,store,checkoutSession,Idempotency-Key); a checkout session can become exactly one successful Order despite concurrent requests.
5. Stock final reservation done via Inventory domain service; if reservation fails, no confirmed Order/payment attempt remains incorrectly successful. Distributed external action uses saga status/compensation, not impossible global transaction.
6. Terms/privacy agreement version/time consent captured, marketing consent never implicitly true.

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

- `COMMERCE_CART_NOT_FOUND`
- `COMMERCE_CART_EXPIRED`
- `COMMERCE_ITEM_NOT_AVAILABLE`
- `COMMERCE_CHECKOUT_INVALID`
- `COMMERCE_CHECKOUT_REQUOTE_REQUIRED`
- `COMMERCE_CHECKOUT_DUPLICATE`
- `COMMERCE_STOCK_RESERVATION_FAILED`
- `COMMERCE_PUBLIC_RATE_LIMIT`

## Durable domain events and global audit

- **Outbox events:** `CART_CREATED`, `CART_ABANDONED`, `CHECKOUT_STARTED`, `ORDER_CREATED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Product Catalog, Discounts/Taxes, Inventory Reservation, Payment method availability, Consent service.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/carts-checkout.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/carts-checkout.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** public cart token cannot be used across Stores
- **2.** price tampering browser body rejected/ignored; charged total server computed
- **3.** concurrent same checkout creates exactly one Order
- **4.** retry with same idempotency key returns prior Order result
- **5.** stale quote after price change returns re-quote required
- **6.** final stock race allows only available purchase when no backorders
- **7.** failed reservation leaves no falsely confirmed paid Order
- **8.** unchecked marketing consent not treated as granted
- **9.** coupon brute force rate-limited

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
