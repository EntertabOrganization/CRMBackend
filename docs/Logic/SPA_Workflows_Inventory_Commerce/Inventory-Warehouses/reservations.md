# Stock Reservations, Backorders, Expiry and Allocation — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryReservationsController`  
**Source of truth / domain entities:** `inventory_reservations; inventory_reservation_allocations; inventory_reservation_history`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- inventory_reservations: id,workspace_id,source_type DEAL|ORDER|INVOICE|MANUAL|SPA_ITEM,source_id,warehouse_id,product_id,variant_id?,quantity NUMERIC(24,6),fulfilled_quantity,released_quantity,status ACTIVE|PARTIALLY_FULFILLED|FULFILLED|RELEASED|EXPIRED|CANCELLED,reserved_at,expires_at,version.
- inventory_reservation_allocations: reservation_id,warehouse_id,location_id?,quantity; unique per reservation/warehouse/location.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/inventory/reservations` | `InventoryReservationsController` | `INVENTORY.RESERVATION_CREATE` | sourceType,sourceId,productId,variantId?,quantity,warehouseId?,expiresAt?,Idempotency-Key | Lock stock, choose warehouse policy, reserve once. |
| `GET` | `/api/v1/inventory/reservations` | `InventoryReservationsController` | `INVENTORY.RESERVATION_READ` | page,limit,sourceType,status,warehouseId | Scoped list. |
| `GET` | `/api/v1/inventory/reservations/:reservationId` | `InventoryReservationsController` | `INVENTORY.RESERVATION_READ` | reservationId | Quantity state and audit. |
| `PATCH` | `/api/v1/inventory/reservations/:reservationId` | `InventoryReservationsController` | `INVENTORY.RESERVATION_MANAGE` | expectedVersion,quantity?,expiresAt? | Revalidate planned quantity and availability. |
| `POST` | `/api/v1/inventory/reservations/:reservationId/release` | `InventoryReservationsController` | `INVENTORY.RESERVATION_MANAGE` | quantity?,reason,Idempotency-Key | Reduce reserved quantity idempotently. |
| `POST` | `/api/v1/inventory/reservations/:reservationId/fulfill` | `InventoryReservationsController` | `INVENTORY.RESERVATION_FULFILL` | quantity,inventoryDocumentLineId,Idempotency-Key | Consume reserved alongside processed sale movement. |
| `POST` | `/api/v1/inventory/reservations/:reservationId/extend` | `InventoryReservationsController` | `INVENTORY.RESERVATION_MANAGE` | expiresAt,expectedVersion | Extend before expiry by policy. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Default reservation expires after 3 days unless workspace/store/source policy overrides; scheduler expires once under row locks and releases outstanding reserved quantity.
2. Quantity positive, at most source planned-sale quantity where applicable; default forbid reservation above available when allowBackorderReservations=false.
3. allowNegativeStock and allowBackorderReservations are distinct; a backorder policy never silently authorizes negative physical issue.
4. Reservation reduces available not on-hand. Fulfillment must be bound to processed inventory sale; a second fulfillment command cannot deduct physical stock twice.
5. Allocate DEFAULT_WAREHOUSE,MOST_AVAILABLE,PRIORITY_LIST or MANUAL V1; NEAREST is Phase2; both source owner and warehouse authorized.
6. Active reservation one or more allocation legs, all quantities sum to remaining reserved and cannot exceed original minus released/fulfilled.

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

- `RESERVATION_NOT_FOUND`
- `RESERVATION_QUANTITY_INVALID`
- `RESERVATION_EXPIRED`
- `RESERVATION_INSUFFICIENT_STOCK`
- `RESERVATION_SOURCE_INVALID`
- `RESERVATION_ALREADY_FULFILLED`

## Durable domain events and global audit

- **Outbox events:** `RESERVATION_CREATED`, `RESERVATION_CHANGED`, `RESERVATION_EXPIRED`, `RESERVATION_FULFILLED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Commerce/CRM source permissions, Stock locks, Jobs, Outbox.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/reservations.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/reservations.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** reserve last item from two concurrent requests permits at most available quantity
- **2.** backorder enabled allows reserved greater than onHand but physical issue stays blocked
- **3.** reservation cannot exceed planned sale quantity
- **4.** release reduces reserved but not onHand
- **5.** expiry runs once despite duplicate timer dispatch
- **6.** partial fulfill reduces reserved and associates sale document
- **7.** same fulfill retry does not reduce stock twice
- **8.** unauthorized source/warehouse cross-tenant reservation denied

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
