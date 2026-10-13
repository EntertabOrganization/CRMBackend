# Inventory FIFO and Average Cost Valuation — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryCostingController`  
**Source of truth / domain entities:** `inventory_cost_layers; inventory_cost_allocations; inventory_average_costs; inventory_valuation_snapshots; inventory_costing_migrations`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- inventory_cost_layers: workspace_id,warehouse_id,inventory_key,source_document_line_id,original_qty,remaining_qty,unit_cost,currency,received_at; FIFO ordered by received_at,id.
- inventory_cost_allocations: movement_id,layer_id,quantity,unit_cost,total_cost; unique(movement_id,layer_id).
- inventory_average_costs: unique(workspace_id,warehouse_id,inventory_key,currency),qty,total_value,average_cost.
- inventory_costing_migrations: workspace_id,from_method,to_method,status,preview_report_file_id,approved_by,applied_at,opening_snapshot_ref.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/inventory/costing/policy` | `InventoryCostingController` | `INVENTORY.COSTING_VIEW` | workspace | Effective FIFO\|AVERAGE setting and lock state. |
| `POST` | `/api/v1/inventory/costing/initialize` | `InventoryCostingController` | `INVENTORY.COSTING_MANAGE` | method FIFO\|AVERAGE | Choose policy before first processed document (FIFO preselected). |
| `GET` | `/api/v1/inventory/valuation` | `InventoryCostingController` | `INVENTORY.VALUATION_VIEW` | warehouseId?,productId?,asOf? | Authorized ledger-derived valuation and COGS. |
| `POST` | `/api/v1/inventory/costing/migration-preview` | `InventoryCostingController` | `INVENTORY.COSTING_MANAGE` | targetMethod | 202 report; no changes. |
| `POST` | `/api/v1/inventory/costing/migrate` | `InventoryCostingController` | `INVENTORY.COSTING_MIGRATE` | previewJobId,approvalReference,Idempotency-Key | Controlled revaluation migration job, retain history. |
| `GET` | `/api/v1/inventory/costing/migrations/:jobId` | `InventoryCostingController` | `INVENTORY.COSTING_VIEW` | jobId | Audited migration status and reconciliation. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Workspace-level costing method FIFO or AVERAGE. After first processed stock transaction method locked except privileged, approved valuation migration.
2. FIFO consumes oldest nonzero cost layers by warehouse/product key; each sale movement gets exact layer allocation quantities and costs.
3. AVERAGE recalculates per product per warehouse upon receipts; sales consume current weighted average; transfers preserve source cost into destination without profit.
4. Cost NUMERIC precision/rounding consistent with money service; no floats; historical order price and COGS stay independent of current catalog prices.
5. Migration preview validates stock/ledger/value coherence; migration stores closing/opening valuation adjustment history and is reversible only through audited controlled procedure.
6. Currency conversions use explicit historical FX references when needed, not ad hoc latest-rate valuation.

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

- `COSTING_NOT_INITIALIZED`
- `COSTING_METHOD_LOCKED`
- `COSTING_MIGRATION_REQUIRED`
- `COSTING_LAYER_SHORTAGE`
- `COSTING_CURRENCY_INVALID`
- `COSTING_RECONCILIATION_FAILED`

## Durable domain events and global audit

- **Outbox events:** `INVENTORY_COSTING_INITIALIZED`, `INVENTORY_COSTING_MIGRATED`, `INVENTORY_VALUATION_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Currency/FX service, Inventory Documents/Movements, Finance/Audit, Workers.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/costing.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/costing.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** FIFO 10 at 100 and 5 at 60, issue 12 allocates 10 at100 plus 2 at60
- **2.** AVERAGE receipt 10 at100 then10 at120 gives average110
- **3.** warehouse transfer preserves total valuation without recognizing profit
- **4.** costing method cannot toggle after first posting with plain PATCH
- **5.** migration preview does not mutate stock/valuation
- **6.** multi-currency valuation requires explicit policy/rate reference
- **7.** valuation read excludes inaccessible warehouse

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
