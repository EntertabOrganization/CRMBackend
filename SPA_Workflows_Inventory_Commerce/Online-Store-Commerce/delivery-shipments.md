# Delivery Methods, Shipment Lifecycle and Fulfillment — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommerceDeliveryController`, `CommerceShipmentsController`  
**Source of truth / domain entities:** `commerce_delivery_services; commerce_delivery_rates; commerce_pickup_locations; commerce_shipments; commerce_shipment_items; commerce_shipment_events`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_delivery_services: workspace_id,store_id,id,type COURIER|PICKUP|POSTAL|SAME_DAY|THIRD_PARTY|DIGITAL|CUSTOM,provider_code?,active.
- commerce_delivery_rates: store_id,service_id,conditions_json,price NUMERIC(18,2),currency,estimated_days_min/max,active.
- commerce_shipments: workspace_id,id,order_id,warehouse_id,delivery_service_id,status NEW|PROCESSING|READY|SHIPPED|IN_TRANSIT|DELIVERED|FAILED|RETURNED|CANCELLED,tracking_number?,external_shipment_id?,shipped_at?,delivered_at?,version.
- commerce_shipment_items: unique(shipment_id,order_line_id),quantity,inventory_document_line_id?; sum shipment qty <= order line ordered qty minus returns.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/commerce/stores/:storeId/delivery-services` | `CommerceDeliveryController` | `COMMERCE.DELIVERY_MANAGE` | storeId | Config and rates. |
| `POST` | `/api/v1/commerce/stores/:storeId/delivery-services` | `CommerceDeliveryController` | `COMMERCE.DELIVERY_MANAGE` | type,conditions,rates,providerConnectionId? | Add adapter config. |
| `GET` | `/api/v1/commerce/orders/:orderId/shipments` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_VIEW` | orderId | Linked fulfillment legs. |
| `POST` | `/api/v1/commerce/orders/:orderId/shipments` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_MANAGE` | warehouseId,deliveryServiceId,items[{orderLineId,quantity}],Idempotency-Key | Create partial shipment allocation. |
| `GET` | `/api/v1/commerce/shipments/:shipmentId` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_VIEW` | shipmentId | Tracking/historical events. |
| `PATCH` | `/api/v1/commerce/shipments/:shipmentId` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_MANAGE` | expectedVersion,trackingInfo?,deliveryChoice? | Before irreversible dispatch only. |
| `POST` | `/api/v1/commerce/shipments/:shipmentId/ship` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_SHIP` | expectedVersion,Idempotency-Key | Process linked Inventory sale then mark SHIPPED atomically/or saga. |
| `POST` | `/api/v1/commerce/shipments/:shipmentId/deliver` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_MANAGE` | trackingEvidence,Idempotency-Key | Authorized delivery state transition. |
| `POST` | `/api/v1/commerce/shipments/:shipmentId/cancel` | `CommerceShipmentsController` | `COMMERCE.SHIPMENT_MANAGE` | reason,Idempotency-Key | Only pre-dispatch; release allocation appropriately. |
| `POST` | `/api/v1/commerce/delivery-providers/:providerCode/webhook` | `CommerceDeliveryController` | `PROVIDER_SIGNED` | provider headers,raw verified body | Normalize statuses idempotently. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Shipment is logistics record; Inventory Sales document owns physical stock movement. Shipping must not mark SHIPPED before Inventory confirms posting (or saga commit checkpoint).
2. Multiple shipment legs from different Warehouses allowed. Sum active shipped/allocated quantities must not exceed ordered quantity; duplicate fulfillment attempts rejected.
3. Payment-before-shipment policy configurable; default paid except COD/approved terms. Payment and Shipment state independent.
4. Delivery provider event uses verified signature/external ID dedupe; normalize events while preserving raw provider status and authoritative timestamp.
5. Shipping failure due to insufficient Inventory preserves retryable Shipment state and does not deduct stock partially; cross-module saga stores compensation state when not single DB transaction.
6. No cancel after shipped; use Return flow. Partial fulfillment updates Order derived quantities/status.

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

- `SHIPMENT_NOT_FOUND`
- `SHIPMENT_INVALID_STATE`
- `SHIPMENT_QUANTITY_EXCEEDED`
- `SHIPMENT_PAYMENT_BLOCKED`
- `SHIPMENT_INVENTORY_POST_FAILED`
- `DELIVERY_PROVIDER_SIGNATURE_INVALID`

## Durable domain events and global audit

- **Outbox events:** `SHIPMENT_CREATED`, `SHIPMENT_SHIPPED`, `SHIPMENT_DELIVERED`, `SHIPMENT_FAILED`, `ORDER_FULFILLMENT_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Inventory Sales Documents, Reservations, Payments, Delivery Provider Adapters, Orders.

## Testing contract — executable and E2E

Matching files: `Testing/Online-Store-Commerce/delivery-shipments.spec.ts` and `Testing/Online-Store-Commerce/delivery-shipments.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** 10 units shipped 6+4 from two warehouses completes fulfillment only when both delivered/qualify
- **2.** shipment quantity greater than unfulfilled order quantity rejected
- **3.** ship before payment blocked except configured COD/credit policy
- **4.** stock deduction failure leaves shipment not SHIPPED
- **5.** same ship idempotency key does not duplicate stock movement
- **6.** invalid delivery provider signature ignored without state mutation
- **7.** shipment event outside Store workspace denied
- **8.** pre-ship cancel releases reservations, post-ship requires Return

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
