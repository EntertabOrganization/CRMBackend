# Barcodes, Serial and Batch Tracking — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE_WITH_EXTENSION (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryTrackingController`  
**Source of truth / domain entities:** `product_barcodes; inventory_serial_numbers; inventory_batches; inventory_batch_balances`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- product_barcodes: workspace_id,id,product_id,variant_id?,barcode_type EAN13|UPC|CODE128|QR|CUSTOM,value,is_primary; unique(workspace_id,value).
- inventory_serial_numbers: workspace_id,id,product_id,variant_id?,serial_number,warehouse_id?,status IN_STOCK|RESERVED|SOLD|RETURNED|DAMAGED|WRITTEN_OFF; unique(workspace_id,inventory_key,serial_number).
- inventory_batches: workspace_id,id,product_id,variant_id?,batch_number,manufactured_at?,expires_at?,status; unique(workspace_id,inventory_key,batch_number).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/inventory/barcodes/resolve` | `InventoryTrackingController` | `INVENTORY.STOCK_READ` | code | Resolve valid Product/Variant within Workspace. |
| `POST` | `/api/v1/inventory/barcodes` | `InventoryTrackingController` | `INVENTORY.TRACKING_MANAGE` | productId,variantId?,barcodeType,value | Assign unique barcode to catalog SKU. |
| `DELETE` | `/api/v1/inventory/barcodes/:barcodeId` | `InventoryTrackingController` | `INVENTORY.TRACKING_MANAGE` | barcodeId | Revoke lookup identifier; never alter movements. |
| `GET` | `/api/v1/inventory/serials` | `InventoryTrackingController` | `INVENTORY.TRACKING_READ` | productId?,warehouseId?,status?,page,limit | Scope serial inventory. |
| `POST` | `/api/v1/inventory/serials` | `InventoryTrackingController` | `INVENTORY.TRACKING_MANAGE` | variantId,serialNumber,warehouseId | Register via validated receipt/opening document context, not free stock increment. |
| `GET` | `/api/v1/inventory/batches` | `InventoryTrackingController` | `INVENTORY.TRACKING_READ` | productId?,expiresBefore?,page,limit | Batch/expiry query. |
| `POST` | `/api/v1/inventory/batches` | `InventoryTrackingController` | `INVENTORY.TRACKING_MANAGE` | variantId,batchNumber,expiresAt? | Register lot metadata, stock via documents only. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Quantity-only default; serial/batch tracking enabled per SKU through Product Catalog policy. Advanced traceability/FEFO/picking deferred Phase 2.
2. Serial quantity one per unique unit; cannot assign same active serial to two warehouses or issue already sold serial again.
3. Batch expiry dates validated; expired lots prohibited from sellable issue where SKU policy requires expiry enforcement; quarantine/damaged disposition separate.
4. Barcode resolves a Product/Variant but scanning by itself must not change on-hand; all changes go via inventory document processing.
5. Batch/serial identifiers scoped to Workspace, never global cross-tenant collision by default.

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

- `INVENTORY_BARCODE_EXISTS`
- `INVENTORY_SERIAL_EXISTS`
- `INVENTORY_SERIAL_INVALID_STATE`
- `INVENTORY_BATCH_EXPIRED`
- `INVENTORY_TRACKING_NOT_ENABLED`

## Durable domain events and global audit

- **Outbox events:** `BARCODE_REGISTERED`, `INVENTORY_SERIAL_STATE_CHANGED`, `INVENTORY_BATCH_EXPIRING_SOON` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Product Catalog, Inventory Ledger, Reservation/Shipment, Jobs.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/serial-batch-barcode.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/serial-batch-barcode.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** duplicate active barcode in workspace rejected
- **2.** serial cannot be simultaneously in two warehouses
- **3.** issuing sold serial twice rejected
- **4.** expired batch cannot fulfill when expiry enforcement enabled
- **5.** scanner lookup cannot mutate stock
- **6.** cross-workspace serial/batch hidden
- **7.** service product denied stock-tracking

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
