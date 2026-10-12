# Stock Availability, Immutable Ledger and Rebuild — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryStockController`, `InventoryMovementsController`  
**Source of truth / domain entities:** `inventory_movements; inventory_balances; inventory_balance_snapshots`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- inventory_movements: id,workspace_id,warehouse_id,location_id?,product_id,variant_id?,document_id,document_line_id,source_type,source_id,quantity_delta NUMERIC(24,6),unit_cost NUMERIC(24,6),total_cost NUMERIC(24,6),movement_type,occurred_at,created_at; append-only.
- inventory_balances: unique(workspace_id,warehouse_id,inventory_key,location_id?),on_hand NUMERIC(24,6),reserved NUMERIC(24,6),version bigint,updated_at; available = on_hand-reserved.
- inventory_balance_snapshots: workspace_id,warehouse_id,inventory_key,as_of_date,on_hand,reserved,valuation_total.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/inventory/stock` | `InventoryStockController` | `INVENTORY.STOCK_READ` | warehouseId?,productId?,variantId?,page,limit | Authorized current balance projection. |
| `GET` | `/api/v1/inventory/availability` | `InventoryStockController` | `INVENTORY.STOCK_READ` | productId,variantId?,quantity?,warehouseId? | Current onHand,reserved,available,backorderAllowed; protect private stock from public users. |
| `GET` | `/api/v1/inventory/movements` | `InventoryMovementsController` | `INVENTORY.MOVEMENT_READ` | warehouseId?,productId?,from?,to?,cursor?,limit? | Immutable movement chronological history. |
| `GET` | `/api/v1/inventory/movements/:movementId` | `InventoryMovementsController` | `INVENTORY.MOVEMENT_READ` | movementId | Movement and originating document/line. |
| `POST` | `/api/v1/inventory/stock/reconciliation-jobs` | `InventoryStockController` | `INVENTORY.STOCK_RECONCILE` | warehouseId?,dryRun=true,Idempotency-Key | Queue rebuild/verification (202 jobId); never silently overwrite ledger. |
| `GET` | `/api/v1/inventory/stock/reconciliation-jobs/:jobId` | `InventoryStockController` | `INVENTORY.STOCK_RECONCILE` | jobId | Drift, resolved and blocked counts. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Physical on-hand derived only by append-only movement deltas; direct PATCH to balances/movements forbidden and no such endpoint exists.
2. Reservation changes affect reserved amount separately, never generate physical movement until fulfillment; available=on_hand-reserved can be negative only with permitted backorders.
3. Every posting locks balance rows in stable warehouse+SKU order; numeric decimal arithmetic only, never floating-point for quantity/cost.
4. Rebuild replays immutable movements and active reservations, reports drift; authorized repair uses controlled transaction/audit not history rewrite.
5. Service catalog product is nonstockable and rejected for inventory operations; variants use unique inventory key per SKU/warehouse.
6. Every stock read/query must include warehouse-level permission; public Storefront sees only sellable boolean/aggregated availability, never private warehouse details.

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

- `STOCK_NOT_FOUND`
- `STOCK_SERVICE_NOT_TRACKABLE`
- `STOCK_INSUFFICIENT`
- `STOCK_LEDGER_IMMUTABLE`
- `STOCK_RECONCILIATION_CONFLICT`
- `WAREHOUSE_ACCESS_DENIED`

## Durable domain events and global audit

- **Outbox events:** `STOCK_CHANGED`, `STOCK_BALANCE_RECONCILED`, `STOCK_OUT_OF_STOCK` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Product Catalog/variants, Warehouse access, Reservations, Costing, Jobs.

## Testing contract — executable and E2E

Matching files: `Testing/Inventory-Warehouses/stock-balances-movements.spec.ts` and `Testing/Inventory-Warehouses/stock-balances-movements.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** receipt +10 yields onHand10,available10
- **2.** reserve 4 keeps onHand10,reserved4,available6
- **3.** movement table rejects update/delete even by normal admin API
- **4.** simultaneous reservations against final unit cannot oversell under default
- **5.** ledger replay matches balance across receipt/transfer/reversal
- **6.** wrong workspace SKU or warehouse not visible
- **7.** service product forbidden for stock movement
- **8.** NUMERIC precision preserved for fractional quantities

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
