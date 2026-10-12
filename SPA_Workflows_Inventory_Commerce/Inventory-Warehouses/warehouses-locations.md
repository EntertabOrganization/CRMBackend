# Warehouses, Locations and Scoped Access — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WarehousesController`, `WarehouseLocationsController`  
**Source of truth / domain entities:** `inventory_warehouses; inventory_locations; inventory_warehouse_permissions; inventory_warehouse_priorities`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- inventory_warehouses: id,workspace_id,code,name,warehouse_type PHYSICAL|STORE|FULFILLMENT|RETURNS|DAMAGED|TRANSIT|VIRTUAL,status ACTIVE|INACTIVE|ARCHIVED,is_default,timezone,address_id?,phone?,version,created_at.
- inventory_locations: workspace_id,id,warehouse_id,parent_location_id?,code,name,type AISLE|RACK|BIN|ZONE,status; unique(warehouse_id,parent_location_id,code).
- inventory_warehouse_permissions: workspace_id,warehouse_id,role_id,action,scope; inventory_warehouse_priorities: warehouse_id,priority,region_code.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/inventory/warehouses` | `WarehousesController` | `INVENTORY.WAREHOUSE_MANAGE` | name,code,type,timezone,location? | Create active warehouse. |
| `GET` | `/api/v1/inventory/warehouses` | `WarehousesController` | `INVENTORY.WAREHOUSE_READ` | page,limit,search,status,type | Scope to accessible warehouses. |
| `GET` | `/api/v1/inventory/warehouses/:warehouseId` | `WarehousesController` | `INVENTORY.WAREHOUSE_READ` | warehouseId | Include permissions-derived actions. |
| `PATCH` | `/api/v1/inventory/warehouses/:warehouseId` | `WarehousesController` | `INVENTORY.WAREHOUSE_MANAGE` | expectedVersion,name?,timezone?,priority?,status? | Reject unsafe disable with dependent stock. |
| `POST` | `/api/v1/inventory/warehouses/:warehouseId/archive` | `WarehousesController` | `INVENTORY.WAREHOUSE_MANAGE` | expectedVersion | Reject if nonzero on-hand, active reservations, live docs. |
| `GET` | `/api/v1/inventory/warehouses/:warehouseId/locations` | `WarehouseLocationsController` | `INVENTORY.WAREHOUSE_READ` | page,limit | Hierarchical locations. |
| `POST` | `/api/v1/inventory/warehouses/:warehouseId/locations` | `WarehouseLocationsController` | `INVENTORY.LOCATION_MANAGE` | parentLocationId?,code,name,type | Create same-warehouse location. |
| `PATCH` | `/api/v1/inventory/warehouses/:warehouseId/locations/:locationId` | `WarehouseLocationsController` | `INVENTORY.LOCATION_MANAGE` | expectedVersion,name?,parentLocationId? | Reject cycles and orphaned stock. |
| `GET` | `/api/v1/inventory/warehouses/:warehouseId/permissions` | `WarehousesController` | `INVENTORY.PERMISSION_MANAGE` | warehouseId | Access matrix. |
| `PUT` | `/api/v1/inventory/warehouses/:warehouseId/permissions` | `WarehousesController` | `INVENTORY.PERMISSION_MANAGE` | expectedVersion,grants[] | Audit and invalidate security caches. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Warehouse code unique per Workspace, address as shared Address binding; location parent shares warehouse and cannot form cycles.
2. Warehouse access intersects role/document-type permission; possessing INVENTORY.DOCUMENT_PROCESS alone is insufficient to move stock from inaccessible warehouse.
3. Access must be verified for both source and destination on transfer, and every warehouse in multi-warehouse report.
4. Archive/disabling warehouse forbidden with on-hand/reserved quantities, unprocessed/active stock documents or stocktake, unless explicit migration/reallocation resolves each.
5. Warehouse location bin hierarchy is V1 optional; advanced routing/picking Phase 2.

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

- `WAREHOUSE_NOT_FOUND`
- `WAREHOUSE_CODE_EXISTS`
- `WAREHOUSE_IN_USE`
- `LOCATION_CYCLE`
- `WAREHOUSE_ACCESS_DENIED`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `WAREHOUSE_CREATED`, `WAREHOUSE_UPDATED`, `WAREHOUSE_ARCHIVED`, `WAREHOUSE_PERMISSION_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Workspace Org, Product Catalog, Inventory Stock, Shared Addresses, Audit.

## Testing contract — executable and E2E

Matching files: `Testing/Inventory-Warehouses/warehouses-locations.spec.ts` and `Testing/Inventory-Warehouses/warehouses-locations.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** warehouse code uniqueness and stable external business ID
- **2.** warehouse archive blocked when nonzero stock or reservations
- **3.** location parent cycle rejected
- **4.** transfer permission requires access to BOTH warehouses
- **5.** cross-workspace location/warehouse ID rejected
- **6.** warehouse read list hides unauthorized warehouse balances
- **7.** permission changes invalidate cache and write Audit

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
