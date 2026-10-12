# Inventory Policies, Reorder Alerts and Controlled Reset — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryPoliciesController`, `InventoryReorderController`  
**Source of truth / domain entities:** `inventory_settings; inventory_reorder_settings; inventory_low_stock_alerts; inventory_reset_operations; inventory_numbering_schemes`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- inventory_settings: workspace_id primary,is_enabled,costing_method,allow_negative_stock default false,allow_backorder_reservations default false,default_reservation_days default 3,default_warehouse_id,default_allocation_strategy,version.
- inventory_reorder_settings: unique(workspace_id,warehouse_id,inventory_key),reorder_point,reorder_quantity,safety_stock,preferred_vendor_id?.
- inventory_low_stock_alerts: workspace_id,warehouse_id,inventory_key,threshold_at,open_since,resolved_at; dedupe active alerts.
- inventory_numbering_schemes: workspace_id,document_type,prefix_template,padding,reset_policy,period_key,next_value.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/inventory/settings` | `InventoryPoliciesController` | `INVENTORY.SETTINGS_VIEW` | workspace | Effective policy. |
| `PATCH` | `/api/v1/inventory/settings` | `InventoryPoliciesController` | `INVENTORY.SETTINGS_MANAGE` | expectedVersion,allowNegativeStock?,allowBackorderReservations?,defaultReservationDays?,allocationStrategy? | Validate effects and audit. |
| `GET` | `/api/v1/inventory/reorder-rules` | `InventoryReorderController` | `INVENTORY.REORDER_READ` | warehouseId?,page,limit | Scoped rules. |
| `PUT` | `/api/v1/inventory/reorder-rules/:ruleId` | `InventoryReorderController` | `INVENTORY.REORDER_MANAGE` | warehouseId,productId,variantId?,reorderPoint,reorderQuantity,safetyStock | Upsert matching scoped rule. |
| `GET` | `/api/v1/inventory/low-stock-alerts` | `InventoryReorderController` | `INVENTORY.REORDER_READ` | page,limit,status? | Deduplicated open alerts. |
| `PUT` | `/api/v1/inventory/numbering/:documentType` | `InventoryReorderController` | `INVENTORY.SETTINGS_MANAGE` | prefixTemplate,padding,resetPolicy,expectedVersion | Concurrency-safe scheme. |
| `POST` | `/api/v1/inventory/reset/preview` | `InventoryPoliciesController` | `INVENTORY.RESET` | warehouseId?,reason | 202 audit-safe impact preview. |
| `POST` | `/api/v1/inventory/reset/apply` | `InventoryPoliciesController` | `INVENTORY.RESET` | previewId,approvalId,Idempotency-Key | Privileged explicit adjustment job; never direct balance rewrite. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Reorder event emitted on crossing available<=reorder_point threshold and deduped until recovery/hysteresis; Inventory detects, Automation/Workflow chooses Procurement action.
2. Default no negative physical stock and no backorder reservations; administrators may configure separately. Disabling negative stock while actual negative balances exist requires remediation.
3. Default 3-day reservation expiry and default warehouse/strategy respected when source/store policy does not override.
4. Numbering schemes per document type with uniqueness and transaction-safe sequence allocation; business numbers never silently reused.
5. Reset operation never executes UPDATE balance=0; uses explicit movement-producing adjustment documents, dual approval policy and immutable audit.
6. Sensitive Inventory settings, costing/reset/permissions changes centrally audited with before/after and actor.

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

- `INVENTORY_SETTINGS_INVALID`
- `INVENTORY_REORDER_RULE_INVALID`
- `INVENTORY_NUMBERING_CONFLICT`
- `INVENTORY_RESET_NOT_APPROVED`
- `INVENTORY_RESET_BLOCKED`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `INVENTORY_SETTINGS_CHANGED`, `INVENTORY_LOW_STOCK`, `INVENTORY_RESET_APPLIED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Automation/Workflows, Products, Audit, Jobs, Numbering.

## Testing contract — executable and E2E

Matching files: `Testing/Inventory-Warehouses/inventory-policies-automation.spec.ts` and `Testing/Inventory-Warehouses/inventory-policies-automation.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** low stock crossing emits one event, not every polling cycle
- **2.** stock restored above threshold closes alert and allows future crossing event
- **3.** negative-stock option does not imply backorder allowed
- **4.** unsafe policy change with negative current stock requires remediation
- **5.** numbering concurrency yields distinct GRN numbers
- **6.** reset preview has no mutation
- **7.** reset apply creates auditable adjustments and is idempotent
- **8.** nonprivileged reset is forbidden

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
