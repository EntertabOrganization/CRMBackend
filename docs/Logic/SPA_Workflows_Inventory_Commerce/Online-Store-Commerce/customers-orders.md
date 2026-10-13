# Commerce Customers, Orders, Snapshots and History — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommerceCustomersController`, `CommerceOrdersController`  
**Source of truth / domain entities:** `commerce_customer_accounts; commerce_customer_addresses; commerce_customer_bindings; commerce_orders; commerce_order_lines; commerce_order_addresses; commerce_order_status_history; commerce_order_consents`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_customer_accounts: workspace_id,store_id,id,email_normalized,identity_auth_id?,status ACTIVE|DISABLED; identity separate from Workspace employee membership.
- commerce_orders: id,workspace_id,store_id,order_number,customer_account_id?,crm_contact_id?,crm_company_id?,crm_deal_id?,currency,subtotal,discount_total,tax_total,delivery_total,grand_total NUMERIC(18,2),payment_status,fulfillment_status,order_status,source_checkout_session_id unique,version,created_at,cancelled_at.
- commerce_order_lines: workspace_id,order_id,product_id,variant_id?,sku_snapshot,title_snapshot,quantity,unit_price,tax_rate_snapshot,discount_snapshot,line_total,currency; immutable once Order placed.
- commerce_order_addresses/customer_snapshots hold historical values independent of live CRM records; status history append-only.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/commerce/orders` | `CommerceOrdersController` | `COMMERCE.ORDER_VIEW` | page,limit,status,paymentStatus,storeId,search | Scope to Store/permissions. |
| `GET` | `/api/v1/commerce/orders/:orderId` | `CommerceOrdersController` | `COMMERCE.ORDER_VIEW` | orderId | Immutable snapshot, payment/fulfillment projections, status history. |
| `PATCH` | `/api/v1/commerce/orders/:orderId` | `CommerceOrdersController` | `COMMERCE.ORDER_UPDATE` | expectedVersion,allowedFulfillmentNote?,customerBinding? | Controlled editable business metadata, no line-price rewrite. |
| `POST` | `/api/v1/commerce/orders/:orderId/cancel` | `CommerceOrdersController` | `COMMERCE.ORDER_CANCEL` | expectedVersion,reason,Idempotency-Key | Check shipment/payment/reservation policy, start cancellation saga. |
| `POST` | `/api/v1/commerce/orders/:orderId/archive` | `CommerceOrdersController` | `COMMERCE.ORDER_MANAGE` | expectedVersion | Historical archive not physical delete. |
| `GET` | `/api/v1/commerce/orders/:orderId/history` | `CommerceOrdersController` | `COMMERCE.ORDER_VIEW` | page,limit | Chronological history and audit refs. |
| `GET` | `/api/v1/commerce/customers` | `CommerceCustomersController` | `COMMERCE.CUSTOMER_VIEW` | page,limit,search | Customer Account list scoped, PII controls. |
| `GET` | `/api/v1/commerce/customers/:customerId/orders` | `CommerceOrdersController` | `COMMERCE.CUSTOMER_VIEW` | page,limit | Authorized customer purchase history. |
| `POST` | `/api/v1/commerce/customers/:customerId/crm-link` | `CommerceCustomersController` | `COMMERCE.CUSTOMER_MANAGE` | contactId?,companyId?,resolutionReason | Shared dedupe resolver and audit. |
| `GET` | `/api/v1/storefront/:storeSlug/account/orders` | `CommerceCustomersController` | `CUSTOMER_SESSION` | page,limit | Customer own Orders only, no Workspace access. |
| `POST` | `/api/v1/storefront/:storeSlug/orders/:orderId/reorder` | `CommerceOrdersController` | `CUSTOMER_SESSION` | orderId | New cart with current sellable products/prices, not cloned amounts. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Order/payment/shipment/inventory lifecycles distinct, order_status not payment_status; immutable order line/customer/address/tax commercial snapshot retained after catalog/customer changes.
2. CRM customer binding uses shared duplicate resolver and Store policy; default new order Deal policy ALWAYS; failed CRM integration is retryable, Order remains valid with linkage status.
3. No normal DELETE for created Orders; cancellation releases reservation and invokes payment refund if required via Saga, shipment already shipped requires Return instead.
4. Order payment_status derived from successful Payments/Refunds, fulfillment_status from shipment/return quantities, order completion requires configured payment+fulfillment criteria.
5. Only permitted customer account sees its own Orders; guest order status uses scoped private token not employee login.

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

- `COMMERCE_ORDER_NOT_FOUND`
- `COMMERCE_ORDER_NOT_CANCELLABLE`
- `COMMERCE_ORDER_IMMUTABLE_PRICE`
- `COMMERCE_CUSTOMER_NOT_FOUND`
- `COMMERCE_CUSTOMER_ACCESS_DENIED`
- `COMMERCE_CRM_BINDING_FAILED`

## Durable domain events and global audit

- **Outbox events:** `ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_CANCELLED`, `ORDER_COMPLETED`, `COMMERCE_CUSTOMER_LINKED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

CRM Contact/Company/Duplicate Resolver, Deals, Payments, Inventory, Notifications.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/customers-orders.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/customers-orders.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** catalog price changed after checkout does not rewrite historical order lines
- **2.** Order paid but unfulfilled remains not COMPLETED
- **3.** Order fulfilled with COD unpaid stays awaiting required payment unless policy fulfilled
- **4.** customer account cannot access another customer's order
- **5.** order cancellation after shipped rejected, Return flow suggested
- **6.** cancelled Order retains historical payment/shipment refs
- **7.** CRM Deal integration failure does not erase placed Order
- **8.** reorder recalculates current prices and stock

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
