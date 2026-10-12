# SPA Items, Assignments and Item History — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaItemsController`  
**Source of truth / domain entities:** `spa_items; spa_item_field_values; spa_item_contacts; spa_item_observers; spa_item_history; spa_item_external_keys`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_items: id,workspace_id,type_id,item_number,title,assigned_user_id,company_id?,my_company_id?,pipeline_id?,stage_id?,status ACTIVE|COMPLETED|TRASHED,version bigint,schema_version,created_by_user_id,updated_by_user_id,created_at,updated_at,deleted_at,trashed_at,purge_after.
- spa_item_field_values: workspace_id,item_id,field_id,value_text/value_number/value_date/value_boolean/value_json, schema_version; indexed according to field config.
- spa_item_observers: unique(workspace_id,item_id,user_id); spa_item_external_keys: unique(workspace_id,type_id,source_system,external_id).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/spa/types/:typeId/items` | `SpaItemsController` | `SPA.ITEM.CREATE` | title,assignedUserId,fieldValues?,pipelineId?,stageId?,companyId?,contacts?,expectedSchemaVersion? | Validate then transactionally allocate number/create values, outbox/history. |
| `GET` | `/api/v1/spa/types/:typeId/items` | `SpaItemsController` | `SPA.ITEM.READ` | page,limit,search,sortBy,sortOrder,filters | Scoped list using permitted fields only. |
| `GET` | `/api/v1/spa/types/:typeId/items/:itemId` | `SpaItemsController` | `SPA.ITEM.READ` | itemId | Redact unauthorized fields before response. |
| `PUT` | `/api/v1/spa/types/:typeId/items/:itemId` | `SpaItemsController` | `SPA.ITEM.UPDATE` | expectedVersion,allEditableFields | Complete replacement; preserve server-owned/system fields. |
| `PATCH` | `/api/v1/spa/types/:typeId/items/:itemId` | `SpaItemsController` | `SPA.ITEM.UPDATE` | expectedVersion,changedFields | Partial update and typed metadata validation. |
| `PATCH` | `/api/v1/spa/types/:typeId/items/:itemId/assign` | `SpaItemsController` | `SPA.ITEM.ASSIGN` | expectedVersion,responsibleUserId | Reassign and notify. |
| `POST` | `/api/v1/spa/types/:typeId/items/:itemId/observers` | `SpaItemsController` | `SPA.ITEM.MANAGE_OBSERVERS` | userId | Idempotently add observer. |
| `DELETE` | `/api/v1/spa/types/:typeId/items/:itemId/observers/:userId` | `SpaItemsController` | `SPA.ITEM.MANAGE_OBSERVERS` | userId | Remove observer-derived access only. |
| `GET` | `/api/v1/spa/types/:typeId/items/:itemId/history` | `SpaItemsController` | `SPA.ITEM.READ` | page,limit | Authorized immutable item history. |
| `DELETE` | `/api/v1/spa/types/:typeId/items/:itemId` | `SpaItemsController` | `SPA.ITEM.DELETE` | expectedVersion | Trash when recycle enabled; otherwise controlled soft-delete lifecycle. |
| `POST` | `/api/v1/spa/types/:typeId/items/:itemId/restore` | `SpaItemsController` | `SPA.ITEM.RESTORE` | expectedVersion | Restore only if type/schema/pipeline valid. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Validate item type and all referenced IDs in active Workspace; assigned user must have current Workspace membership; observers get scoped read only.
2. Create uses canonical Type and published schema; dynamic fields must be resolved from server metadata; reject unknown fields and attempts to set hidden/readonly fields.
3. For pipeline-enabled Type require valid pipeline/stage pair; no explicit stage means designated default stage.
4. An Item mutation writes item, typed values, history, outbox in one transaction; do not leave partial item on field validation error.
5. Optimistic item version rejects stale writes with 409, including assignment and deletes.
6. On Item soft delete, link records in Tasks/Files/Calendar/CRM remain source-owned; do not recursively delete other modules' business data.
7. Restore checks that original stage/field references are still valid, otherwise require safe reconciliation strategy.

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

- `SPA_ITEM_NOT_FOUND`
- `SPA_ITEM_VALIDATION_FAILED`
- `SPA_TYPE_ARCHIVED`
- `SPA_ASSIGNMENT_INVALID`
- `SPA_ITEM_TRASHED`
- `SPA_ITEM_RESTORE_BLOCKED`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `SPA_ITEM_CREATED`, `SPA_ITEM_UPDATED`, `SPA_ITEM_ASSIGNED`, `SPA_ITEM_TRASHED`, `SPA_ITEM_RESTORED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

CRM relationships, Users, Shared Files/Timeline, Notification, Outbox.

## Testing contract — executable and E2E

Matching files: `Testing/Smart-Process-Automation/spa-items.spec.ts` and `Testing/Smart-Process-Automation/spa-items.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** create Item persists number, values and history atomically
- **2.** unknown field or wrong metadata type rejects before DB mutation
- **3.** invalid assignment user in different workspace denied
- **4.** SPA Item view redacts restricted fields even with base read access
- **5.** optimistic version conflict returns 409 without partial field writes
- **6.** observer read grant does not confer field edit
- **7.** trash and restore preserve audit and linked shared files
- **8.** creating Item on archived Type fails
- **9.** search filters do not reveal unauthorized field values

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
