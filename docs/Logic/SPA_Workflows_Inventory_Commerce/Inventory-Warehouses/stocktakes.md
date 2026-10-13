# Stocktake Sessions, Snapshots and Reconciliation — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryStocktakesController`  
**Source of truth / domain entities:** `stocktake_sessions; stocktake_lines; stocktake_count_history; stocktake_adjustment_bindings`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- stocktake_sessions: id,workspace_id,warehouse_id,location_id?,status DRAFT|COUNTING|RECONCILING|POSTED|CANCELLED,as_of_at,started_by,completed_by,version.
- stocktake_lines: id,workspace_id,session_id,product_id,variant_id?,expected_qty,expected_balance_version,counted_qty?,counted_by?,counted_at?,variance_qty,adjustment_document_line_id?.
- stocktake_count_history: count attempts,actor,quantity,timestamp; historical counts remain.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/inventory/stocktakes` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_CREATE` | warehouseId,locationId?,scope | Draft session, snapshot current quantities/version. |
| `GET` | `/api/v1/inventory/stocktakes` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_READ` | page,limit,status,warehouseId | List visible sessions. |
| `GET` | `/api/v1/inventory/stocktakes/:sessionId` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_READ` | sessionId | Count lines, history and state. |
| `POST` | `/api/v1/inventory/stocktakes/:sessionId/start` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_COUNT` | expectedVersion | COUNTING; freeze expected snapshot only, not warehouse operations. |
| `PUT` | `/api/v1/inventory/stocktakes/:sessionId/lines/:lineId/count` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_COUNT` | quantity,expectedVersion | Record count with actor/time. |
| `POST` | `/api/v1/inventory/stocktakes/:sessionId/reconcile` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_RECONCILE` | expectedVersion | Detect movements since baseline, propose adjusted variance. |
| `POST` | `/api/v1/inventory/stocktakes/:sessionId/post` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_POST` | expectedVersion,Idempotency-Key | Create/process adjustment document after conflict review/approval. |
| `POST` | `/api/v1/inventory/stocktakes/:sessionId/cancel` | `InventoryStocktakesController` | `INVENTORY.STOCKTAKE_MANAGE` | reason | Close with no stock mutation. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Stocktake expected_qty and expected_balance_version captured when session begins; receiving/sale operations continue. Reconcile sums interim ledger deltas and compares against count timestamp/scope.
2. Cannot post when concurrent movements remain unresolved, missing counts exist (except approved skip policy), or adjustment approval outstanding.
3. Post produces a normal processed Inventory Adjustment document with immutable movements; direct balance overwrite forbidden.
4. One session posted once; retry returns linked document, never creates second adjustment.
5. Warehouse access required to count; Posting authority separate from Count and optional approval authority.

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

- `STOCKTAKE_NOT_FOUND`
- `STOCKTAKE_INVALID_STATUS`
- `STOCKTAKE_UNCOUNTED_LINES`
- `STOCKTAKE_CONCURRENT_MOVEMENTS`
- `STOCKTAKE_APPROVAL_REQUIRED`
- `STOCKTAKE_ALREADY_POSTED`

## Durable domain events and global audit

- **Outbox events:** `STOCKTAKE_STARTED`, `STOCKTAKE_RECONCILED`, `STOCKTAKE_POSTED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Stock Ledger, Document posting, Warehouse permissions, Audit.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/stocktakes.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Inventory-Warehouses/stocktakes.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** counting does not freeze other warehouse stock operations
- **2.** movement after snapshot requires reconciliation before post
- **3.** missing count line blocks post unless explicit approved skip
- **4.** posting makes adjustment document and append-only movement
- **5.** concurrent double post creates one adjustment only
- **6.** counting rights do not grant posting rights
- **7.** post failure rolls back all adjustment lines

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
