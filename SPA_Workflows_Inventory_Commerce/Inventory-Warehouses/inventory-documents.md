# Inventory Documents, Approval, Posting and Reversal — Implementation Specification

**Scope:** Inventory & Warehouses  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `InventoryDocumentsController`, `InventoryDocumentLinesController`  
**Source of truth / domain entities:** `inventory_documents; inventory_document_lines; inventory_document_operations; inventory_document_approvals`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- inventory_documents: id,workspace_id,number,document_type STOCK_RECEIPT|STOCK_ADJUSTMENT|TRANSFER|SALES_ORDER|CUSTOMER_RETURN|SUPPLIER_RETURN|WRITE_OFF,status DRAFT|PENDING_APPROVAL|APPROVED|PROCESSED|CANCELLED,source_warehouse_id?,destination_warehouse_id?,currency,source_entity_type?,source_entity_id?,version,processed_at,processed_by.
- inventory_document_lines: id,workspace_id,document_id,product_id,variant_id?,quantity NUMERIC(24,6),unit_cost NUMERIC(24,6),write_off_reason?,source_location_id?,target_location_id?,line_number.
- inventory_document_operations: unique(workspace_id,document_id,operation_type,idempotency_key),result_json,status; approvals record actor/threshold/version.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/inventory/documents` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_CREATE` | documentType,warehouseIds,currency,sourceRef? | DRAFT, no stock effect. |
| `GET` | `/api/v1/inventory/documents` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_READ` | page,limit,documentType,status,warehouseId | Permission-filtered list. |
| `GET` | `/api/v1/inventory/documents/:documentId` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_READ` | documentId | Document with ordered lines and history. |
| `PATCH` | `/api/v1/inventory/documents/:documentId` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_EDIT` | expectedVersion,editableFields | Draft-only changes; approved revision invalidates approval. |
| `POST` | `/api/v1/inventory/documents/:documentId/lines` | `InventoryDocumentLinesController` | `INVENTORY.DOCUMENT_EDIT` | productId,variantId?,quantity,unitCost,locationId? | Add stockable line on draft. |
| `PATCH` | `/api/v1/inventory/documents/:documentId/lines/:lineId` | `InventoryDocumentLinesController` | `INVENTORY.DOCUMENT_EDIT` | quantity?,unitCost?,expectedVersion | Draft-only. |
| `DELETE` | `/api/v1/inventory/documents/:documentId/lines/:lineId` | `InventoryDocumentLinesController` | `INVENTORY.DOCUMENT_EDIT` | lineId | Draft-only removal. |
| `POST` | `/api/v1/inventory/documents/:documentId/request-approval` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_SUBMIT` | expectedVersion | PENDING_APPROVAL where policy requires; else allow process. |
| `POST` | `/api/v1/inventory/documents/:documentId/approve` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_APPROVE` | expectedVersion,decision,comment? | Approval record, state APPROVED/return to draft. |
| `POST` | `/api/v1/inventory/documents/:documentId/process` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_PROCESS` | expectedVersion,Idempotency-Key | Atomic locks, valuation, ledger movements, state PROCESSED, outbox. |
| `POST` | `/api/v1/inventory/documents/:documentId/reverse` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_REVERSE` | expectedVersion,reason,Idempotency-Key | Compensation movements, not deleting originals. |
| `GET` | `/api/v1/inventory/documents/:documentId/history` | `InventoryDocumentsController` | `INVENTORY.DOCUMENT_READ` | page,limit | State/approval/posting/reversal evidence. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Draft creates zero physical movements. Process requires nonempty valid lines, active stockable variants, all warehouse/locations in Workspace, document-type and each warehouse permission, approval satisfied, and no negative stock under default.
2. Processed stock-affecting document/lines immutable; correction requires reversal/adjustment; never update/delete prior movement rows.
3. Transfer source/destination linked OUT and IN movements plus cost allocations atomically; source and destination quantities net to zero (unless explicit transit documents).
4. Inventory document approval optional by type/amount; if configured, processor cannot skip PENDING_APPROVAL/APPROVED.
5. Posting order locks document then affected SKU+warehouse balances in deterministic sequence and creates audit/outbox in same transaction; failed validation rolls back all quantities.
6. Reversal checks available stock for reverse movement; if insufficient, block with explicit validation instead of forcing negative quantities.

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

- `INVENTORY_DOCUMENT_NOT_FOUND`
- `INVENTORY_DOCUMENT_NOT_DRAFT`
- `INVENTORY_APPROVAL_REQUIRED`
- `INVENTORY_DOCUMENT_ALREADY_PROCESSED`
- `INVENTORY_DOCUMENT_REVERSAL_BLOCKED`
- `INVENTORY_LINE_INVALID`
- `STOCK_INSUFFICIENT`

## Durable domain events and global audit

- **Outbox events:** `INVENTORY_DOCUMENT_CREATED`, `INVENTORY_DOCUMENT_APPROVAL_REQUESTED`, `INVENTORY_DOCUMENT_APPROVED`, `INVENTORY_DOCUMENT_PROCESSED`, `INVENTORY_DOCUMENT_REVERSED`, `STOCK_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Warehouses, Balances/Ledger, Costing, Commerce Order references, Audit/Outbox.

## Testing contract — executable and E2E

Matching files: `Testing/Inventory-Warehouses/inventory-documents.spec.ts` and `Testing/Inventory-Warehouses/inventory-documents.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** draft creation does not change stock
- **2.** post receipt generates one movement per line and adjusts balance
- **3.** cannot post transfer with only source warehouse access
- **4.** simultaneous process same document posts once via idempotency
- **5.** post failure rolls back both transfer legs, history and outbox
- **6.** processed line cannot be updated/deleted
- **7.** approval-required write-off cannot skip approval
- **8.** reverse receipt cannot overdraw source stock and never deletes original movements

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
