# Controller and Endpoint Inventory

**Controller count:** 52  
**Distinct REST operations:** 261  
**Module specification files:** 32

| # | Controller | Module specification |
|---:|---|---|
| 1 | `SpaTypesController` | `Smart-Process-Automation/spa-types-capabilities.md` |
| 2 | `SpaCapabilitiesController` | `Smart-Process-Automation/spa-types-capabilities.md` |
| 3 | `SpaFieldsController` | `Smart-Process-Automation/spa-fields-schema-versions.md` |
| 4 | `SpaSchemasController` | `Smart-Process-Automation/spa-fields-schema-versions.md` |
| 5 | `SpaItemsController` | `Smart-Process-Automation/spa-items.md` |
| 6 | `SpaPipelinesController` | `Smart-Process-Automation/spa-pipelines-stages.md` |
| 7 | `SpaStagesController` | `Smart-Process-Automation/spa-pipelines-stages.md` |
| 8 | `SpaRelationsController` | `Smart-Process-Automation/spa-relations.md` |
| 9 | `SpaLayoutsController` | `Smart-Process-Automation/spa-relations.md` |
| 10 | `SpaPermissionsController` | `Smart-Process-Automation/spa-permissions.md` |
| 11 | `SpaNumberingController` | `Smart-Process-Automation/spa-numbering-recurrence.md` |
| 12 | `SpaRecurrenceController` | `Smart-Process-Automation/spa-numbering-recurrence.md` |
| 13 | `SpaTransfersController` | `Smart-Process-Automation/spa-import-export-lifecycle.md` |
| 14 | `SpaRecycleController` | `Smart-Process-Automation/spa-import-export-lifecycle.md` |
| 15 | `WorkflowDefinitionsController` | `Workflows-Business-Processes/workflow-definitions-versions.md` |
| 16 | `WorkflowVersionsController` | `Workflows-Business-Processes/workflow-definitions-versions.md` |
| 17 | `WorkflowGraphController` | `Workflows-Business-Processes/workflow-designer-nodes.md` |
| 18 | `WorkflowExecutionsController` | `Workflows-Business-Processes/workflow-executions.md` |
| 19 | `WorkflowAssignmentsController` | `Workflows-Business-Processes/human-approvals.md` |
| 20 | `WorkflowTriggersController` | `Workflows-Business-Processes/timers-events-loops.md` |
| 21 | `WorkflowRuntimePolicyController` | `Workflows-Business-Processes/timers-events-loops.md` |
| 22 | `WorkflowCompensationController` | `Workflows-Business-Processes/subworkflows-compensation.md` |
| 23 | `WorkflowActionsController` | `Workflows-Business-Processes/workflow-integrations.md` |
| 24 | `WorkflowAdminController` | `Workflows-Business-Processes/workflow-security-runtime.md` |
| 25 | `WorkflowTemplatesController` | `Workflows-Business-Processes/workflow-security-runtime.md` |
| 26 | `WarehousesController` | `Inventory-Warehouses/warehouses-locations.md` |
| 27 | `WarehouseLocationsController` | `Inventory-Warehouses/warehouses-locations.md` |
| 28 | `InventoryStockController` | `Inventory-Warehouses/stock-balances-movements.md` |
| 29 | `InventoryMovementsController` | `Inventory-Warehouses/stock-balances-movements.md` |
| 30 | `InventoryDocumentsController` | `Inventory-Warehouses/inventory-documents.md` |
| 31 | `InventoryDocumentLinesController` | `Inventory-Warehouses/inventory-documents.md` |
| 32 | `InventoryReservationsController` | `Inventory-Warehouses/reservations.md` |
| 33 | `InventoryStocktakesController` | `Inventory-Warehouses/stocktakes.md` |
| 34 | `InventoryCostingController` | `Inventory-Warehouses/costing.md` |
| 35 | `InventoryTrackingController` | `Inventory-Warehouses/serial-batch-barcode.md` |
| 36 | `InventoryPoliciesController` | `Inventory-Warehouses/inventory-policies-automation.md` |
| 37 | `InventoryReorderController` | `Inventory-Warehouses/inventory-policies-automation.md` |
| 38 | `CommerceStoresController` | `Online-Store-Commerce/stores-storefronts.md` |
| 39 | `CommerceStorefrontsController` | `Online-Store-Commerce/stores-storefronts.md` |
| 40 | `CommerceCartsController` | `Online-Store-Commerce/carts-checkout.md` |
| 41 | `CommerceCheckoutController` | `Online-Store-Commerce/carts-checkout.md` |
| 42 | `CommerceCustomersController` | `Online-Store-Commerce/customers-orders.md` |
| 43 | `CommerceOrdersController` | `Online-Store-Commerce/customers-orders.md` |
| 44 | `CommercePromotionsController` | `Online-Store-Commerce/pricing-discounts-taxes.md` |
| 45 | `CommerceTaxRulesController` | `Online-Store-Commerce/pricing-discounts-taxes.md` |
| 46 | `CommercePaymentsController` | `Online-Store-Commerce/payments.md` |
| 47 | `CommerceDisputesController` | `Online-Store-Commerce/payments.md` |
| 48 | `CommerceDeliveryController` | `Online-Store-Commerce/delivery-shipments.md` |
| 49 | `CommerceShipmentsController` | `Online-Store-Commerce/delivery-shipments.md` |
| 50 | `CommerceReturnsController` | `Online-Store-Commerce/returns-refunds.md` |
| 51 | `CommerceRefundsController` | `Online-Store-Commerce/returns-refunds.md` |
| 52 | `CommerceIntegrationsController` | `Online-Store-Commerce/crm-inventory-automation.md` |

## Exact endpoints grouped by specification

### `Smart-Process-Automation/spa-types-capabilities.md`

- `POST /api/v1/spa/types` — **SpaTypesController** — `SPA.TYPE.MANAGE` — Create DRAFT type with immutable code and configured capability defaults.
- `GET /api/v1/spa/types` — **SpaTypesController** — `SPA.TYPE.READ` — Permission-filtered collection.
- `GET /api/v1/spa/types/:typeId` — **SpaTypesController** — `SPA.TYPE.READ` — Return metadata, effective permissions and capabilities.
- `PATCH /api/v1/spa/types/:typeId` — **SpaTypesController** — `SPA.TYPE.MANAGE` — Update non-destructive metadata only.
- `POST /api/v1/spa/types/:typeId/activate` — **SpaTypesController** — `SPA.TYPE.MANAGE` — Activate only after valid published schema.
- `POST /api/v1/spa/types/:typeId/archive` — **SpaTypesController** — `SPA.TYPE.MANAGE` — Block new items/triggers, retain items/history.
- `POST /api/v1/spa/types/:typeId/restore` — **SpaTypesController** — `SPA.TYPE.MANAGE` — Reactivate after checking schema and entitlements.
- `GET /api/v1/spa/types/:typeId/capabilities` — **SpaCapabilitiesController** — `SPA.TYPE.READ` — Return flags/configuration.
- `PUT /api/v1/spa/types/:typeId/capabilities/:key` — **SpaCapabilitiesController** — `SPA.TYPE.MANAGE` — Impact preview required before disabling with live bindings; publish schema change.

### `Smart-Process-Automation/spa-fields-schema-versions.md`

- `GET /api/v1/spa/types/:typeId/fields` — **SpaFieldsController** — `SPA.SCHEMA.READ` — List active/inactive field definitions with access filtering.
- `POST /api/v1/spa/types/:typeId/fields` — **SpaFieldsController** — `SPA.SCHEMA.MANAGE` — Add field to draft schema only.
- `PATCH /api/v1/spa/types/:typeId/fields/:fieldId` — **SpaFieldsController** — `SPA.SCHEMA.MANAGE` — Draft edit; type changes require migration plan.
- `POST /api/v1/spa/types/:typeId/fields/:fieldId/deactivate` — **SpaFieldsController** — `SPA.SCHEMA.MANAGE` — Keep historical values, block new entry.
- `GET /api/v1/spa/types/:typeId/schema/draft` — **SpaSchemasController** — `SPA.SCHEMA.READ` — Return mutable draft and its version.
- `PATCH /api/v1/spa/types/:typeId/schema/draft` — **SpaSchemasController** — `SPA.SCHEMA.MANAGE` — Stage structural field/layout/requirement/constraint changes.
- `POST /api/v1/spa/types/:typeId/schema/validate` — **SpaSchemasController** — `SPA.SCHEMA.MANAGE` — Return impact report (invalid values, affected items, dependencies).
- `POST /api/v1/spa/types/:typeId/schema/publish` — **SpaSchemasController** — `SPA.SCHEMA.PUBLISH` — Atomic publish; migration must be complete for destructive edits.
- `GET /api/v1/spa/types/:typeId/schema/versions` — **SpaSchemasController** — `SPA.SCHEMA.READ` — Immutable publication history.
- `POST /api/v1/spa/types/:typeId/schema/migrations` — **SpaSchemasController** — `SPA.SCHEMA.MANAGE` — Queue preview/convert job, never silently modify production data.
- `POST /api/v1/spa/types/:typeId/unique-constraints` — **SpaSchemasController** — `SPA.SCHEMA.MANAGE` — Preview duplicates and publish safe uniqueness constraint.

### `Smart-Process-Automation/spa-items.md`

- `POST /api/v1/spa/types/:typeId/items` — **SpaItemsController** — `SPA.ITEM.CREATE` — Validate then transactionally allocate number/create values, outbox/history.
- `GET /api/v1/spa/types/:typeId/items` — **SpaItemsController** — `SPA.ITEM.READ` — Scoped list using permitted fields only.
- `GET /api/v1/spa/types/:typeId/items/:itemId` — **SpaItemsController** — `SPA.ITEM.READ` — Redact unauthorized fields before response.
- `PUT /api/v1/spa/types/:typeId/items/:itemId` — **SpaItemsController** — `SPA.ITEM.UPDATE` — Complete replacement; preserve server-owned/system fields.
- `PATCH /api/v1/spa/types/:typeId/items/:itemId` — **SpaItemsController** — `SPA.ITEM.UPDATE` — Partial update and typed metadata validation.
- `PATCH /api/v1/spa/types/:typeId/items/:itemId/assign` — **SpaItemsController** — `SPA.ITEM.ASSIGN` — Reassign and notify.
- `POST /api/v1/spa/types/:typeId/items/:itemId/observers` — **SpaItemsController** — `SPA.ITEM.MANAGE_OBSERVERS` — Idempotently add observer.
- `DELETE /api/v1/spa/types/:typeId/items/:itemId/observers/:userId` — **SpaItemsController** — `SPA.ITEM.MANAGE_OBSERVERS` — Remove observer-derived access only.
- `GET /api/v1/spa/types/:typeId/items/:itemId/history` — **SpaItemsController** — `SPA.ITEM.READ` — Authorized immutable item history.
- `DELETE /api/v1/spa/types/:typeId/items/:itemId` — **SpaItemsController** — `SPA.ITEM.DELETE` — Trash when recycle enabled; otherwise controlled soft-delete lifecycle.
- `POST /api/v1/spa/types/:typeId/items/:itemId/restore` — **SpaItemsController** — `SPA.ITEM.RESTORE` — Restore only if type/schema/pipeline valid.

### `Smart-Process-Automation/spa-pipelines-stages.md`

- `GET /api/v1/spa/types/:typeId/pipelines` — **SpaPipelinesController** — `SPA.PIPELINE.READ` — List permitted pipelines.
- `POST /api/v1/spa/types/:typeId/pipelines` — **SpaPipelinesController** — `SPA.PIPELINE.MANAGE` — Create pipeline with default stage plan.
- `PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId` — **SpaPipelinesController** — `SPA.PIPELINE.MANAGE` — Update without breaking item bindings.
- `POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/archive` — **SpaPipelinesController** — `SPA.PIPELINE.MANAGE` — Block if live items not migrated.
- `GET /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages` — **SpaStagesController** — `SPA.PIPELINE.READ` — Ordered stage list.
- `POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages` — **SpaStagesController** — `SPA.STAGE.MANAGE` — Create stage.
- `PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId` — **SpaStagesController** — `SPA.STAGE.MANAGE` — Validate terminal semantics/live impacts.
- `POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive` — **SpaStagesController** — `SPA.STAGE.MANAGE` — Reject when live items exist without valid migration.
- `POST /api/v1/spa/types/:typeId/items/:itemId/transition` — **SpaPipelinesController** — `SPA.ITEM.STAGE_CHANGE` — Check source/target rules and required fields, append history/outbox.
- `GET /api/v1/spa/types/:typeId/kanban` — **SpaPipelinesController** — `SPA.ITEM.READ` — Authorized grouped stage projection; does not duplicate Item data.

### `Smart-Process-Automation/spa-relations.md`

- `GET /api/v1/spa/types/:typeId/relation-definitions` — **SpaRelationsController** — `SPA.SCHEMA.READ` — Return relation contracts.
- `POST /api/v1/spa/types/:typeId/relation-definitions` — **SpaRelationsController** — `SPA.SCHEMA.MANAGE` — Publish through draft schema safety.
- `GET /api/v1/spa/types/:typeId/items/:itemId/relations` — **SpaRelationsController** — `SPA.ITEM.READ` — Return only accessible targets.
- `POST /api/v1/spa/types/:typeId/items/:itemId/relations` — **SpaRelationsController** — `SPA.ITEM.UPDATE` — Check both ends, cardinality and scope.
- `DELETE /api/v1/spa/types/:typeId/items/:itemId/relations/:relationId` — **SpaRelationsController** — `SPA.ITEM.UPDATE` — Unlink only, never delete target.
- `GET /api/v1/spa/types/:typeId/layouts` — **SpaLayoutsController** — `SPA.SCHEMA.READ` — Return versioned metadata-based forms.
- `PUT /api/v1/spa/types/:typeId/layouts/:layoutId` — **SpaLayoutsController** — `SPA.SCHEMA.MANAGE` — Validate references to active fields.
- `GET /api/v1/spa/types/:typeId/views` — **SpaLayoutsController** — `SPA.ITEM.READ` — List viewer's saved preferences.
- `PUT /api/v1/spa/types/:typeId/views/me` — **SpaLayoutsController** — `SPA.ITEM.READ` — Store user preferences only, no business mutation.

### `Smart-Process-Automation/spa-permissions.md`

- `GET /api/v1/spa/types/:typeId/permissions` — **SpaPermissionsController** — `SPA.PERMISSION.MANAGE` — View effective policy matrix.
- `PUT /api/v1/spa/types/:typeId/permissions` — **SpaPermissionsController** — `SPA.PERMISSION.MANAGE` — Validate known permissions, subjects and scoped role grants.
- `GET /api/v1/spa/types/:typeId/items/:itemId/permissions/me` — **SpaPermissionsController** — `SPA.ITEM.READ` — Return effective actions and visible/editable field codes for actor.
- `GET /api/v1/spa/types/:typeId/permissions/history` — **SpaPermissionsController** — `SPA.PERMISSION.MANAGE` — Security-sensitive changes, actor and diff.

### `Smart-Process-Automation/spa-numbering-recurrence.md`

- `GET /api/v1/spa/types/:typeId/numbering` — **SpaNumberingController** — `SPA.TYPE.READ` — View effective numbering scheme.
- `PUT /api/v1/spa/types/:typeId/numbering` — **SpaNumberingController** — `SPA.TYPE.MANAGE` — Validate template and preserve allocated historical numbers.
- `GET /api/v1/spa/types/:typeId/recurrence` — **SpaRecurrenceController** — `SPA.RECURRENCE.READ` — List recurrence templates.
- `POST /api/v1/spa/types/:typeId/recurrence` — **SpaRecurrenceController** — `SPA.RECURRENCE.MANAGE` — Create generation plan.
- `PATCH /api/v1/spa/types/:typeId/recurrence/:ruleId` — **SpaRecurrenceController** — `SPA.RECURRENCE.MANAGE` — Future instances only.
- `POST /api/v1/spa/types/:typeId/recurrence/:ruleId/pause` — **SpaRecurrenceController** — `SPA.RECURRENCE.MANAGE` — Stop future scheduled generation.
- `POST /api/v1/spa/types/:typeId/recurrence/:ruleId/resume` — **SpaRecurrenceController** — `SPA.RECURRENCE.MANAGE` — Resume without duplicates.
- `GET /api/v1/spa/types/:typeId/recurrence/:ruleId/instances` — **SpaRecurrenceController** — `SPA.RECURRENCE.READ` — Historical generated items.

### `Smart-Process-Automation/spa-import-export-lifecycle.md`

- `POST /api/v1/spa/types/:typeId/imports` — **SpaTransfersController** — `SPA.ITEM.IMPORT` — Queue import; return 202 and jobId.
- `GET /api/v1/spa/types/:typeId/imports/:jobId` — **SpaTransfersController** — `SPA.ITEM.IMPORT` — Status, per-row error counts and report file.
- `POST /api/v1/spa/types/:typeId/imports/:jobId/cancel` — **SpaTransfersController** — `SPA.ITEM.IMPORT` — Cancel safely between rows, preserve committed rows/results.
- `POST /api/v1/spa/types/:typeId/exports` — **SpaTransfersController** — `SPA.ITEM.EXPORT` — Snapshot viewer-authorized scope; return 202 jobId.
- `GET /api/v1/spa/types/:typeId/exports/:jobId` — **SpaTransfersController** — `SPA.ITEM.EXPORT` — Status and temporary authorized file link.
- `GET /api/v1/spa/types/:typeId/trash` — **SpaRecycleController** — `SPA.ITEM.RESTORE` — List authorized trashed items.
- `POST /api/v1/spa/types/:typeId/items/:itemId/purge` — **SpaRecycleController** — `SPA.ITEM.HARD_DELETE` — Queue checked purge, block holds/retention.

### `Workflows-Business-Processes/workflow-definitions-versions.md`

- `POST /api/v1/workflows` — **WorkflowDefinitionsController** — `WORKFLOW.DESIGN` — Create draft definition.
- `GET /api/v1/workflows` — **WorkflowDefinitionsController** — `WORKFLOW.VIEW` — Authorized collection.
- `GET /api/v1/workflows/:workflowId` — **WorkflowDefinitionsController** — `WORKFLOW.VIEW` — Definition summary, current published version.
- `PATCH /api/v1/workflows/:workflowId` — **WorkflowDefinitionsController** — `WORKFLOW.DESIGN` — Edit configuration; never mutate published versions.
- `POST /api/v1/workflows/:workflowId/versions` — **WorkflowVersionsController** — `WORKFLOW.DESIGN` — New draft cloned from selected version.
- `GET /api/v1/workflows/:workflowId/versions` — **WorkflowVersionsController** — `WORKFLOW.VIEW` — Version history.
- `GET /api/v1/workflows/:workflowId/versions/:versionId` — **WorkflowVersionsController** — `WORKFLOW.VIEW` — Immutable graph/definitions snapshot.
- `POST /api/v1/workflows/:workflowId/versions/:versionId/validate` — **WorkflowVersionsController** — `WORKFLOW.DESIGN` — Structural/security/recursion/permissions validation.
- `POST /api/v1/workflows/:workflowId/versions/:versionId/publish` — **WorkflowVersionsController** — `WORKFLOW.PUBLISH` — Atomically publish immutable version and set currentVersionId.
- `POST /api/v1/workflows/:workflowId/pause` — **WorkflowDefinitionsController** — `WORKFLOW.PUBLISH` — Stop future starts; no retroactive cancellation.
- `POST /api/v1/workflows/:workflowId/archive` — **WorkflowDefinitionsController** — `WORKFLOW.PUBLISH` — Stop starts, preserve executions/versions/history.

### `Workflows-Business-Processes/workflow-designer-nodes.md`

- `GET /api/v1/workflows/:workflowId/versions/:versionId/graph` — **WorkflowGraphController** — `WORKFLOW.VIEW` — Nodes, edges, parameter schema.
- `PUT /api/v1/workflows/:workflowId/versions/:versionId/graph` — **WorkflowGraphController** — `WORKFLOW.DESIGN` — Replace complete DRAFT graph.
- `POST /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes` — **WorkflowGraphController** — `WORKFLOW.DESIGN` — Add allowed typed node.
- `PATCH /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId` — **WorkflowGraphController** — `WORKFLOW.DESIGN` — Change draft node.
- `DELETE /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId` — **WorkflowGraphController** — `WORKFLOW.DESIGN` — Delete draft node and affected edges safely.
- `POST /api/v1/workflows/:workflowId/versions/:versionId/graph/edges` — **WorkflowGraphController** — `WORKFLOW.DESIGN` — Add valid edge within version.
- `POST /api/v1/workflows/:workflowId/versions/:versionId/graph/preview` — **WorkflowGraphController** — `WORKFLOW.DESIGN` — Dry-run deterministic expressions only; no side effects.

### `Workflows-Business-Processes/workflow-executions.md`

- `POST /api/v1/workflows/:workflowId/start` — **WorkflowExecutionsController** — `WORKFLOW.START` — Start pinned published version after concurrency & binding checks; return 202 execution ID.
- `GET /api/v1/workflow-executions` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_VIEW` — Scoped executions.
- `GET /api/v1/workflow-executions/:executionId` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_VIEW` — State, progress, authorized redacted variables.
- `GET /api/v1/workflow-executions/:executionId/nodes` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_VIEW` — Node execution timeline/attempts.
- `GET /api/v1/workflow-executions/:executionId/logs` — **WorkflowExecutionsController** — `WORKFLOW.LOG_VIEW` — Redacted structured logs.
- `POST /api/v1/workflow-executions/:executionId/cancel` — **WorkflowExecutionsController** — `WORKFLOW.CANCEL_OWN|WORKFLOW.CANCEL_ALL` — Request cancellation, stop future dispatch and run configured compensation.
- `POST /api/v1/workflow-executions/:executionId/suspend` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_ADMIN` — Pause execution and internal timers durably.
- `POST /api/v1/workflow-executions/:executionId/resume` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_ADMIN` — Resume paused tokens and remaining-duration timers.
- `POST /api/v1/workflow-executions/:executionId/retry` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_ADMIN` — Retry safe persisted pre-node state only.
- `POST /api/v1/workflow-executions/:executionId/terminate` — **WorkflowExecutionsController** — `WORKFLOW.EXECUTION_ADMIN` — Irrevocable stop of future actions; preserve audit/history.

### `Workflows-Business-Processes/human-approvals.md`

- `GET /api/v1/workflow-assignments/my` — **WorkflowAssignmentsController** — `WORKFLOW.ASSIGNMENT_VIEW` — Assignment inbox scoped to effective participants.
- `GET /api/v1/workflow-assignments/:assignmentId` — **WorkflowAssignmentsController** — `WORKFLOW.ASSIGNMENT_VIEW` — Details redacted by bound-entity permissions.
- `POST /api/v1/workflow-assignments/:assignmentId/decide` — **WorkflowAssignmentsController** — `WORKFLOW.ASSIGNMENT_DECIDE` — Persist decision once; advance node when policy satisfied.
- `POST /api/v1/workflow-assignments/:assignmentId/delegate` — **WorkflowAssignmentsController** — `WORKFLOW.ASSIGNMENT_DELEGATE` — Audit delegation; old assignee cannot decide unless also explicitly authorized.
- `POST /api/v1/workflow-assignments/:assignmentId/submit-information` — **WorkflowAssignmentsController** — `WORKFLOW.ASSIGNMENT_DECIDE` — Validate requested typed input and unblock node.
- `GET /api/v1/workflow-assignments/:assignmentId/history` — **WorkflowAssignmentsController** — `WORKFLOW.ASSIGNMENT_VIEW` — Decisions, delegation and escalation audit.

### `Workflows-Business-Processes/timers-events-loops.md`

- `GET /api/v1/workflows/:workflowId/triggers` — **WorkflowTriggersController** — `WORKFLOW.VIEW` — Configured manual/event/schedule triggers.
- `PUT /api/v1/workflows/:workflowId/triggers` — **WorkflowTriggersController** — `WORKFLOW.DESIGN` — Draft/activate with validation; live changes versioned.
- `GET /api/v1/workflow-executions/:executionId/waits` — **WorkflowTriggersController** — `WORKFLOW.EXECUTION_VIEW` — Pending timers/events and due dates.
- `GET /api/v1/workflows/runtime-limits` — **WorkflowRuntimePolicyController** — `WORKFLOW.RUNTIME_MANAGE` — Effective limits and feature entitlement.
- `PUT /api/v1/workflows/runtime-limits` — **WorkflowRuntimePolicyController** — `WORKFLOW.RUNTIME_MANAGE` — Can lower but never exceed platform-safe ceiling.

### `Workflows-Business-Processes/subworkflows-compensation.md`

- `GET /api/v1/workflow-executions/:executionId/children` — **WorkflowCompensationController** — `WORKFLOW.EXECUTION_VIEW` — Child Workflow instances, result status.
- `GET /api/v1/workflow-executions/:executionId/compensations` — **WorkflowCompensationController** — `WORKFLOW.EXECUTION_VIEW` — Planned/completed compensation history.
- `POST /api/v1/workflow-executions/:executionId/compensate` — **WorkflowCompensationController** — `WORKFLOW.EXECUTION_ADMIN` — Execute only declared compensation stack with safety checks.
- `POST /api/v1/workflow-executions/:executionId/compensations/:actionId/retry` — **WorkflowCompensationController** — `WORKFLOW.EXECUTION_ADMIN` — Retry safe failed compensation idempotently.

### `Workflows-Business-Processes/workflow-integrations.md`

- `GET /api/v1/workflows/actions` — **WorkflowActionsController** — `WORKFLOW.DESIGN` — Safe supported action descriptors and input schemas.
- `POST /api/v1/workflows/:workflowId/actions/:actionCode/validate` — **WorkflowActionsController** — `WORKFLOW.DESIGN` — Validate configured action against registry/permissions, no execution.
- `POST /api/v1/workflows/callbacks/:token` — **WorkflowActionsController** — `PUBLIC_SCOPED` — Verify signature/nonce/expiry/correlation and resume matching wait once.
- `GET /api/v1/workflow-executions/:executionId/actions` — **WorkflowActionsController** — `WORKFLOW.EXECUTION_VIEW` — Redacted integration action records.

### `Workflows-Business-Processes/workflow-security-runtime.md`

- `GET /api/v1/workflow-templates` — **WorkflowTemplatesController** — `WORKFLOW.TEMPLATE_MANAGE` — Authorized templates.
- `POST /api/v1/workflow-templates` — **WorkflowTemplatesController** — `WORKFLOW.TEMPLATE_MANAGE` — Snapshot safe template, strip secrets and sensitive IDs.
- `POST /api/v1/workflow-templates/:templateId/instantiate` — **WorkflowTemplatesController** — `WORKFLOW.DESIGN` — Create new draft definition.
- `GET /api/v1/workflow-executions/:executionId/discussion` — **WorkflowAdminController** — `WORKFLOW.EXECUTION_VIEW` — Resolve scoped Communication/Timeline discussion reference.
- `GET /api/v1/workflows/admin/health` — **WorkflowAdminController** — `WORKFLOW.EXECUTION_ADMIN` — Stuck leases/waits/failures and queue lag (no secrets).
- `POST /api/v1/workflows/admin/reconcile` — **WorkflowAdminController** — `WORKFLOW.EXECUTION_ADMIN` — Queue safe reconciliation, return jobId.

### `Inventory-Warehouses/warehouses-locations.md`

- `POST /api/v1/inventory/warehouses` — **WarehousesController** — `INVENTORY.WAREHOUSE_MANAGE` — Create active warehouse.
- `GET /api/v1/inventory/warehouses` — **WarehousesController** — `INVENTORY.WAREHOUSE_READ` — Scope to accessible warehouses.
- `GET /api/v1/inventory/warehouses/:warehouseId` — **WarehousesController** — `INVENTORY.WAREHOUSE_READ` — Include permissions-derived actions.
- `PATCH /api/v1/inventory/warehouses/:warehouseId` — **WarehousesController** — `INVENTORY.WAREHOUSE_MANAGE` — Reject unsafe disable with dependent stock.
- `POST /api/v1/inventory/warehouses/:warehouseId/archive` — **WarehousesController** — `INVENTORY.WAREHOUSE_MANAGE` — Reject if nonzero on-hand, active reservations, live docs.
- `GET /api/v1/inventory/warehouses/:warehouseId/locations` — **WarehouseLocationsController** — `INVENTORY.WAREHOUSE_READ` — Hierarchical locations.
- `POST /api/v1/inventory/warehouses/:warehouseId/locations` — **WarehouseLocationsController** — `INVENTORY.LOCATION_MANAGE` — Create same-warehouse location.
- `PATCH /api/v1/inventory/warehouses/:warehouseId/locations/:locationId` — **WarehouseLocationsController** — `INVENTORY.LOCATION_MANAGE` — Reject cycles and orphaned stock.
- `GET /api/v1/inventory/warehouses/:warehouseId/permissions` — **WarehousesController** — `INVENTORY.PERMISSION_MANAGE` — Access matrix.
- `PUT /api/v1/inventory/warehouses/:warehouseId/permissions` — **WarehousesController** — `INVENTORY.PERMISSION_MANAGE` — Audit and invalidate security caches.

### `Inventory-Warehouses/stock-balances-movements.md`

- `GET /api/v1/inventory/stock` — **InventoryStockController** — `INVENTORY.STOCK_READ` — Authorized current balance projection.
- `GET /api/v1/inventory/availability` — **InventoryStockController** — `INVENTORY.STOCK_READ` — Current onHand,reserved,available,backorderAllowed; protect private stock from public users.
- `GET /api/v1/inventory/movements` — **InventoryMovementsController** — `INVENTORY.MOVEMENT_READ` — Immutable movement chronological history.
- `GET /api/v1/inventory/movements/:movementId` — **InventoryMovementsController** — `INVENTORY.MOVEMENT_READ` — Movement and originating document/line.
- `POST /api/v1/inventory/stock/reconciliation-jobs` — **InventoryStockController** — `INVENTORY.STOCK_RECONCILE` — Queue rebuild/verification (202 jobId); never silently overwrite ledger.
- `GET /api/v1/inventory/stock/reconciliation-jobs/:jobId` — **InventoryStockController** — `INVENTORY.STOCK_RECONCILE` — Drift, resolved and blocked counts.

### `Inventory-Warehouses/inventory-documents.md`

- `POST /api/v1/inventory/documents` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_CREATE` — DRAFT, no stock effect.
- `GET /api/v1/inventory/documents` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_READ` — Permission-filtered list.
- `GET /api/v1/inventory/documents/:documentId` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_READ` — Document with ordered lines and history.
- `PATCH /api/v1/inventory/documents/:documentId` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_EDIT` — Draft-only changes; approved revision invalidates approval.
- `POST /api/v1/inventory/documents/:documentId/lines` — **InventoryDocumentLinesController** — `INVENTORY.DOCUMENT_EDIT` — Add stockable line on draft.
- `PATCH /api/v1/inventory/documents/:documentId/lines/:lineId` — **InventoryDocumentLinesController** — `INVENTORY.DOCUMENT_EDIT` — Draft-only.
- `DELETE /api/v1/inventory/documents/:documentId/lines/:lineId` — **InventoryDocumentLinesController** — `INVENTORY.DOCUMENT_EDIT` — Draft-only removal.
- `POST /api/v1/inventory/documents/:documentId/request-approval` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_SUBMIT` — PENDING_APPROVAL where policy requires; else allow process.
- `POST /api/v1/inventory/documents/:documentId/approve` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_APPROVE` — Approval record, state APPROVED/return to draft.
- `POST /api/v1/inventory/documents/:documentId/process` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_PROCESS` — Atomic locks, valuation, ledger movements, state PROCESSED, outbox.
- `POST /api/v1/inventory/documents/:documentId/reverse` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_REVERSE` — Compensation movements, not deleting originals.
- `GET /api/v1/inventory/documents/:documentId/history` — **InventoryDocumentsController** — `INVENTORY.DOCUMENT_READ` — State/approval/posting/reversal evidence.

### `Inventory-Warehouses/reservations.md`

- `POST /api/v1/inventory/reservations` — **InventoryReservationsController** — `INVENTORY.RESERVATION_CREATE` — Lock stock, choose warehouse policy, reserve once.
- `GET /api/v1/inventory/reservations` — **InventoryReservationsController** — `INVENTORY.RESERVATION_READ` — Scoped list.
- `GET /api/v1/inventory/reservations/:reservationId` — **InventoryReservationsController** — `INVENTORY.RESERVATION_READ` — Quantity state and audit.
- `PATCH /api/v1/inventory/reservations/:reservationId` — **InventoryReservationsController** — `INVENTORY.RESERVATION_MANAGE` — Revalidate planned quantity and availability.
- `POST /api/v1/inventory/reservations/:reservationId/release` — **InventoryReservationsController** — `INVENTORY.RESERVATION_MANAGE` — Reduce reserved quantity idempotently.
- `POST /api/v1/inventory/reservations/:reservationId/fulfill` — **InventoryReservationsController** — `INVENTORY.RESERVATION_FULFILL` — Consume reserved alongside processed sale movement.
- `POST /api/v1/inventory/reservations/:reservationId/extend` — **InventoryReservationsController** — `INVENTORY.RESERVATION_MANAGE` — Extend before expiry by policy.

### `Inventory-Warehouses/stocktakes.md`

- `POST /api/v1/inventory/stocktakes` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_CREATE` — Draft session, snapshot current quantities/version.
- `GET /api/v1/inventory/stocktakes` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_READ` — List visible sessions.
- `GET /api/v1/inventory/stocktakes/:sessionId` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_READ` — Count lines, history and state.
- `POST /api/v1/inventory/stocktakes/:sessionId/start` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_COUNT` — COUNTING; freeze expected snapshot only, not warehouse operations.
- `PUT /api/v1/inventory/stocktakes/:sessionId/lines/:lineId/count` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_COUNT` — Record count with actor/time.
- `POST /api/v1/inventory/stocktakes/:sessionId/reconcile` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_RECONCILE` — Detect movements since baseline, propose adjusted variance.
- `POST /api/v1/inventory/stocktakes/:sessionId/post` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_POST` — Create/process adjustment document after conflict review/approval.
- `POST /api/v1/inventory/stocktakes/:sessionId/cancel` — **InventoryStocktakesController** — `INVENTORY.STOCKTAKE_MANAGE` — Close with no stock mutation.

### `Inventory-Warehouses/costing.md`

- `GET /api/v1/inventory/costing/policy` — **InventoryCostingController** — `INVENTORY.COSTING_VIEW` — Effective FIFO|AVERAGE setting and lock state.
- `POST /api/v1/inventory/costing/initialize` — **InventoryCostingController** — `INVENTORY.COSTING_MANAGE` — Choose policy before first processed document (FIFO preselected).
- `GET /api/v1/inventory/valuation` — **InventoryCostingController** — `INVENTORY.VALUATION_VIEW` — Authorized ledger-derived valuation and COGS.
- `POST /api/v1/inventory/costing/migration-preview` — **InventoryCostingController** — `INVENTORY.COSTING_MANAGE` — 202 report; no changes.
- `POST /api/v1/inventory/costing/migrate` — **InventoryCostingController** — `INVENTORY.COSTING_MIGRATE` — Controlled revaluation migration job, retain history.
- `GET /api/v1/inventory/costing/migrations/:jobId` — **InventoryCostingController** — `INVENTORY.COSTING_VIEW` — Audited migration status and reconciliation.

### `Inventory-Warehouses/serial-batch-barcode.md`

- `GET /api/v1/inventory/barcodes/resolve` — **InventoryTrackingController** — `INVENTORY.STOCK_READ` — Resolve valid Product/Variant within Workspace.
- `POST /api/v1/inventory/barcodes` — **InventoryTrackingController** — `INVENTORY.TRACKING_MANAGE` — Assign unique barcode to catalog SKU.
- `DELETE /api/v1/inventory/barcodes/:barcodeId` — **InventoryTrackingController** — `INVENTORY.TRACKING_MANAGE` — Revoke lookup identifier; never alter movements.
- `GET /api/v1/inventory/serials` — **InventoryTrackingController** — `INVENTORY.TRACKING_READ` — Scope serial inventory.
- `POST /api/v1/inventory/serials` — **InventoryTrackingController** — `INVENTORY.TRACKING_MANAGE` — Register via validated receipt/opening document context, not free stock increment.
- `GET /api/v1/inventory/batches` — **InventoryTrackingController** — `INVENTORY.TRACKING_READ` — Batch/expiry query.
- `POST /api/v1/inventory/batches` — **InventoryTrackingController** — `INVENTORY.TRACKING_MANAGE` — Register lot metadata, stock via documents only.

### `Inventory-Warehouses/inventory-policies-automation.md`

- `GET /api/v1/inventory/settings` — **InventoryPoliciesController** — `INVENTORY.SETTINGS_VIEW` — Effective policy.
- `PATCH /api/v1/inventory/settings` — **InventoryPoliciesController** — `INVENTORY.SETTINGS_MANAGE` — Validate effects and audit.
- `GET /api/v1/inventory/reorder-rules` — **InventoryReorderController** — `INVENTORY.REORDER_READ` — Scoped rules.
- `PUT /api/v1/inventory/reorder-rules/:ruleId` — **InventoryReorderController** — `INVENTORY.REORDER_MANAGE` — Upsert matching scoped rule.
- `GET /api/v1/inventory/low-stock-alerts` — **InventoryReorderController** — `INVENTORY.REORDER_READ` — Deduplicated open alerts.
- `PUT /api/v1/inventory/numbering/:documentType` — **InventoryReorderController** — `INVENTORY.SETTINGS_MANAGE` — Concurrency-safe scheme.
- `POST /api/v1/inventory/reset/preview` — **InventoryPoliciesController** — `INVENTORY.RESET` — 202 audit-safe impact preview.
- `POST /api/v1/inventory/reset/apply` — **InventoryPoliciesController** — `INVENTORY.RESET` — Privileged explicit adjustment job; never direct balance rewrite.

### `Online-Store-Commerce/stores-storefronts.md`

- `POST /api/v1/commerce/stores` — **CommerceStoresController** — `COMMERCE.STORE_MANAGE` — New DRAFT Store.
- `GET /api/v1/commerce/stores` — **CommerceStoresController** — `COMMERCE.STORE_VIEW` — Workspace-scoped Store list.
- `GET /api/v1/commerce/stores/:storeId` — **CommerceStoresController** — `COMMERCE.STORE_VIEW` — Settings, status, effective permissions.
- `PATCH /api/v1/commerce/stores/:storeId` — **CommerceStoresController** — `COMMERCE.STORE_MANAGE` — Validate currency, warehouse, inventory/payment impacts.
- `POST /api/v1/commerce/stores/:storeId/activate` — **CommerceStoresController** — `COMMERCE.STORE_MANAGE` — Activation requires valid catalog/currency/publication/payment policy.
- `POST /api/v1/commerce/stores/:storeId/suspend` — **CommerceStoresController** — `COMMERCE.STORE_MANAGE` — Stop public checkout, retain existing Order servicing.
- `GET /api/v1/commerce/stores/:storeId/storefronts` — **CommerceStorefrontsController** — `COMMERCE.STORE_VIEW` — List WEB/HEADLESS etc.
- `POST /api/v1/commerce/stores/:storeId/storefronts` — **CommerceStorefrontsController** — `COMMERCE.STORE_MANAGE` — Create draft Storefront.
- `POST /api/v1/commerce/storefronts/:storefrontId/publish` — **CommerceStorefrontsController** — `COMMERCE.STORE_MANAGE` — Publicly activate allowed V1 WEB/HEADLESS context.
- `GET /api/v1/commerce/stores/:storeId/publications` — **CommerceStoresController** — `COMMERCE.CATALOG_PUBLISH` — Publication rules.
- `PUT /api/v1/commerce/stores/:storeId/publications/:productId` — **CommerceStoresController** — `COMMERCE.CATALOG_PUBLISH` — Publish only active Catalog product with valid price.
- `GET /api/v1/storefront/:storeSlug/products` — **CommerceStorefrontsController** — `PUBLIC_SCOPED` — Published products only; no private warehouse detail.
- `GET /api/v1/storefront/:storeSlug/products/:productSlug` — **CommerceStorefrontsController** — `PUBLIC_SCOPED` — Public sellable price/currency/media from published configuration.

### `Online-Store-Commerce/carts-checkout.md`

- `POST /api/v1/storefront/:storeSlug/carts` — **CommerceCartsController** — `PUBLIC_SCOPED` — Create Cart token, rate-limited.
- `GET /api/v1/storefront/:storeSlug/carts/:cartToken` — **CommerceCartsController** — `PUBLIC_TOKEN` — Authorized cart view, recomputed prices.
- `POST /api/v1/storefront/:storeSlug/carts/:cartToken/items` — **CommerceCartsController** — `PUBLIC_TOKEN` — Validate published/sellable product; add.
- `PATCH /api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId` — **CommerceCartsController** — `PUBLIC_TOKEN` — Recalculate no client unit price.
- `DELETE /api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId` — **CommerceCartsController** — `PUBLIC_TOKEN` — Remove only own item.
- `POST /api/v1/storefront/:storeSlug/checkout-sessions` — **CommerceCheckoutController** — `PUBLIC_TOKEN` — Create priced checkout draft.
- `POST /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/quote` — **CommerceCheckoutController** — `PUBLIC_TOKEN` — Recalculate discounts/taxes/delivery and issue short-lived quoteHash.
- `POST /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/place-order` — **CommerceCheckoutController** — `PUBLIC_TOKEN` — Revalidate stock/price/tax/coupon, one Order, inventory reservation/compensation.
- `GET /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/status` — **CommerceCheckoutController** — `PUBLIC_TOKEN` — Safe public status only, never CRM private data.

### `Online-Store-Commerce/customers-orders.md`

- `GET /api/v1/commerce/orders` — **CommerceOrdersController** — `COMMERCE.ORDER_VIEW` — Scope to Store/permissions.
- `GET /api/v1/commerce/orders/:orderId` — **CommerceOrdersController** — `COMMERCE.ORDER_VIEW` — Immutable snapshot, payment/fulfillment projections, status history.
- `PATCH /api/v1/commerce/orders/:orderId` — **CommerceOrdersController** — `COMMERCE.ORDER_UPDATE` — Controlled editable business metadata, no line-price rewrite.
- `POST /api/v1/commerce/orders/:orderId/cancel` — **CommerceOrdersController** — `COMMERCE.ORDER_CANCEL` — Check shipment/payment/reservation policy, start cancellation saga.
- `POST /api/v1/commerce/orders/:orderId/archive` — **CommerceOrdersController** — `COMMERCE.ORDER_MANAGE` — Historical archive not physical delete.
- `GET /api/v1/commerce/orders/:orderId/history` — **CommerceOrdersController** — `COMMERCE.ORDER_VIEW` — Chronological history and audit refs.
- `GET /api/v1/commerce/customers` — **CommerceCustomersController** — `COMMERCE.CUSTOMER_VIEW` — Customer Account list scoped, PII controls.
- `GET /api/v1/commerce/customers/:customerId/orders` — **CommerceOrdersController** — `COMMERCE.CUSTOMER_VIEW` — Authorized customer purchase history.
- `POST /api/v1/commerce/customers/:customerId/crm-link` — **CommerceCustomersController** — `COMMERCE.CUSTOMER_MANAGE` — Shared dedupe resolver and audit.
- `GET /api/v1/storefront/:storeSlug/account/orders` — **CommerceCustomersController** — `CUSTOMER_SESSION` — Customer own Orders only, no Workspace access.
- `POST /api/v1/storefront/:storeSlug/orders/:orderId/reorder` — **CommerceOrdersController** — `CUSTOMER_SESSION` — New cart with current sellable products/prices, not cloned amounts.

### `Online-Store-Commerce/pricing-discounts-taxes.md`

- `GET /api/v1/commerce/stores/:storeId/promotions` — **CommercePromotionsController** — `COMMERCE.PROMOTION_VIEW` — Store promotions list.
- `POST /api/v1/commerce/stores/:storeId/promotions` — **CommercePromotionsController** — `COMMERCE.PROMOTION_MANAGE` — Create rule.
- `PATCH /api/v1/commerce/promotions/:promotionId` — **CommercePromotionsController** — `COMMERCE.PROMOTION_MANAGE` — Versioned adjustment, no historical Order rewrite.
- `POST /api/v1/commerce/promotions/:promotionId/coupons` — **CommercePromotionsController** — `COMMERCE.PROMOTION_MANAGE` — Create coupon.
- `POST /api/v1/storefront/:storeSlug/coupons/validate` — **CommercePromotionsController** — `PUBLIC_SCOPED` — Rate-limited eligibility response, no private rules.
- `GET /api/v1/commerce/stores/:storeId/tax-rules` — **CommerceTaxRulesController** — `COMMERCE.TAX_VIEW` — Admin tax config.
- `POST /api/v1/commerce/stores/:storeId/tax-rules` — **CommerceTaxRulesController** — `COMMERCE.TAX_MANAGE` — Add effective-dated rule.
- `PATCH /api/v1/commerce/tax-rules/:taxRuleId` — **CommerceTaxRulesController** — `COMMERCE.TAX_MANAGE` — Future-dated edits, preserve history.

### `Online-Store-Commerce/payments.md`

- `GET /api/v1/commerce/orders/:orderId/payments` — **CommercePaymentsController** — `COMMERCE.PAYMENT_VIEW` — Allocated Payment ledger.
- `POST /api/v1/commerce/orders/:orderId/payments` — **CommercePaymentsController** — `COMMERCE.PAYMENT_MANAGE` — Payment attempt via shared provider adapter.
- `POST /api/v1/commerce/payments/:paymentId/capture` — **CommercePaymentsController** — `COMMERCE.PAYMENT_CAPTURE` — Capture up to remaining authorized amount.
- `POST /api/v1/commerce/payments/:paymentId/void` — **CommercePaymentsController** — `COMMERCE.PAYMENT_MANAGE` — Void uncaptured authorization.
- `GET /api/v1/commerce/payments/:paymentId` — **CommercePaymentsController** — `COMMERCE.PAYMENT_VIEW` — State/attempts sanitized.
- `POST /api/v1/commerce/payment-providers/:providerCode/webhook` — **CommercePaymentsController** — `PROVIDER_SIGNED` — Verify signature & dedupe, process asynchronously.
- `GET /api/v1/commerce/payment-disputes` — **CommerceDisputesController** — `COMMERCE.DISPUTE_VIEW` — Authorized disputes.
- `GET /api/v1/commerce/payment-disputes/:disputeId` — **CommerceDisputesController** — `COMMERCE.DISPUTE_VIEW` — State and evidence status, no card secrets.

### `Online-Store-Commerce/delivery-shipments.md`

- `GET /api/v1/commerce/stores/:storeId/delivery-services` — **CommerceDeliveryController** — `COMMERCE.DELIVERY_MANAGE` — Config and rates.
- `POST /api/v1/commerce/stores/:storeId/delivery-services` — **CommerceDeliveryController** — `COMMERCE.DELIVERY_MANAGE` — Add adapter config.
- `GET /api/v1/commerce/orders/:orderId/shipments` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_VIEW` — Linked fulfillment legs.
- `POST /api/v1/commerce/orders/:orderId/shipments` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_MANAGE` — Create partial shipment allocation.
- `GET /api/v1/commerce/shipments/:shipmentId` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_VIEW` — Tracking/historical events.
- `PATCH /api/v1/commerce/shipments/:shipmentId` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_MANAGE` — Before irreversible dispatch only.
- `POST /api/v1/commerce/shipments/:shipmentId/ship` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_SHIP` — Process linked Inventory sale then mark SHIPPED atomically/or saga.
- `POST /api/v1/commerce/shipments/:shipmentId/deliver` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_MANAGE` — Authorized delivery state transition.
- `POST /api/v1/commerce/shipments/:shipmentId/cancel` — **CommerceShipmentsController** — `COMMERCE.SHIPMENT_MANAGE` — Only pre-dispatch; release allocation appropriately.
- `POST /api/v1/commerce/delivery-providers/:providerCode/webhook` — **CommerceDeliveryController** — `PROVIDER_SIGNED` — Normalize statuses idempotently.

### `Online-Store-Commerce/returns-refunds.md`

- `POST /api/v1/commerce/orders/:orderId/returns` — **CommerceReturnsController** — `COMMERCE.RETURN_CREATE` — Validate delivered quantities and policy.
- `GET /api/v1/commerce/returns` — **CommerceReturnsController** — `COMMERCE.RETURN_VIEW` — Authorized return queue.
- `GET /api/v1/commerce/returns/:returnId` — **CommerceReturnsController** — `COMMERCE.RETURN_VIEW` — Return lines/disposition/history.
- `POST /api/v1/commerce/returns/:returnId/approve` — **CommerceReturnsController** — `COMMERCE.RETURN_APPROVE` — Approve/reject per policy.
- `POST /api/v1/commerce/returns/:returnId/receive` — **CommerceReturnsController** — `COMMERCE.RETURN_RECEIVE` — Record physical receipt pending inspection.
- `POST /api/v1/commerce/returns/:returnId/inspect` — **CommerceReturnsController** — `COMMERCE.RETURN_INSPECT` — Process correct Inventory return/segregation document.
- `POST /api/v1/commerce/orders/:orderId/refunds` — **CommerceRefundsController** — `COMMERCE.REFUND_CREATE` — Create financial refund request, independent of Return.
- `POST /api/v1/commerce/refunds/:refundId/approve` — **CommerceRefundsController** — `COMMERCE.REFUND_APPROVE` — Financial approval based on threshold.
- `POST /api/v1/commerce/refunds/:refundId/process` — **CommerceRefundsController** — `COMMERCE.REFUND_PROCESS` — Provider refund with idempotency and reconciled state.
- `GET /api/v1/commerce/refunds/:refundId` — **CommerceRefundsController** — `COMMERCE.REFUND_VIEW` — Approved amount/provider transaction, sanitized.

### `Online-Store-Commerce/crm-inventory-automation.md`

- `GET /api/v1/commerce/orders/:orderId/integrations` — **CommerceIntegrationsController** — `COMMERCE.ORDER_VIEW` — CRM bindings/Reservation/automation status.
- `POST /api/v1/commerce/orders/:orderId/crm-sync` — **CommerceIntegrationsController** — `COMMERCE.ORDER_MANAGE` — Reconcile Contact/Company/Deal binding using safe resolver.
- `GET /api/v1/commerce/stores/:storeId/automation-settings` — **CommerceIntegrationsController** — `COMMERCE.STORE_MANAGE` — Abandoned period/default Deal policy.
- `PATCH /api/v1/commerce/stores/:storeId/automation-settings` — **CommerceIntegrationsController** — `COMMERCE.STORE_MANAGE` — Update future events without rewriting prior orders.
- `POST /api/v1/commerce/orders/:orderId/reconcile` — **CommerceIntegrationsController** — `COMMERCE.ORDER_MANAGE` — Queue cross-domain consistency check; return 202 jobId.
- `GET /api/v1/commerce/reconciliation-jobs/:jobId` — **CommerceIntegrationsController** — `COMMERCE.ORDER_MANAGE` — Observable stock/payment/deal mismatches.

## Integration controllers excluded from this pack

Shared Auth, Search, Audit, Notifications, Jobs, Integration Connections, Outbound Webhook delivery, CRM Products/Payments, Site Editor and full Marketing remain their owners' controllers. This pack contains only the domain REST endpoints explicitly listed above. Never duplicate shared controllers to inflate counts.
