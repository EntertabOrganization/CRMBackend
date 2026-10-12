# SPA Relations, Shared Business Bindings and Views — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaRelationsController`, `SpaLayoutsController`  
**Source of truth / domain entities:** `spa_relation_definitions; spa_item_relations; spa_form_layouts; spa_form_sections; spa_form_section_fields; spa_user_view_preferences`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_relation_definitions: workspace_id,type_id,name,code,target_type,target_subtype_id?,cardinality ONE|MANY,is_required,configuration_json.
- spa_item_relations: workspace_id,source_item_id,target_type,target_id,relation_definition_id,relation_type,is_primary; unique(source_item_id,relation_definition_id,target_type,target_id).
- spa_form_layouts: workspace_id,type_id,id,name,context CREATE|DETAIL|EDIT,version; sections and ordered field references; user preferences for List/Kanban views.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/spa/types/:typeId/relation-definitions` | `SpaRelationsController` | `SPA.SCHEMA.READ` | typeId | Return relation contracts. |
| `POST` | `/api/v1/spa/types/:typeId/relation-definitions` | `SpaRelationsController` | `SPA.SCHEMA.MANAGE` | code,targetType,cardinality,isRequired? | Publish through draft schema safety. |
| `GET` | `/api/v1/spa/types/:typeId/items/:itemId/relations` | `SpaRelationsController` | `SPA.ITEM.READ` | page,limit,targetType? | Return only accessible targets. |
| `POST` | `/api/v1/spa/types/:typeId/items/:itemId/relations` | `SpaRelationsController` | `SPA.ITEM.UPDATE` | definitionId,targetType,targetId,isPrimary? | Check both ends, cardinality and scope. |
| `DELETE` | `/api/v1/spa/types/:typeId/items/:itemId/relations/:relationId` | `SpaRelationsController` | `SPA.ITEM.UPDATE` | relationId | Unlink only, never delete target. |
| `GET` | `/api/v1/spa/types/:typeId/layouts` | `SpaLayoutsController` | `SPA.SCHEMA.READ` | context? | Return versioned metadata-based forms. |
| `PUT` | `/api/v1/spa/types/:typeId/layouts/:layoutId` | `SpaLayoutsController` | `SPA.SCHEMA.MANAGE` | expectedVersion,sections[] | Validate references to active fields. |
| `GET` | `/api/v1/spa/types/:typeId/views` | `SpaLayoutsController` | `SPA.ITEM.READ` | typeId | List viewer's saved preferences. |
| `PUT` | `/api/v1/spa/types/:typeId/views/me` | `SpaLayoutsController` | `SPA.ITEM.READ` | viewType,columns,filters,sort | Store user preferences only, no business mutation. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Relations must not cross Workspace; both source and target authorization checked before creating or exposing relation.
2. ONE cardinality allows at most one live target per definition; MANY can have multiple; deleting required relation rejects until replacement.
3. No duplicate reverse relationship rows: inverse view is query/projection with current permissions.
4. Shared CRM Activities, Timeline, Products, Documents, Files, Task and Calendar retain ownership of their data; SPA stores typed bindings, never cloned entity records.
5. Layout configuration cannot include nonexistent, inactive or forbidden system fields; UI shows effective visible fields only.

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

- `SPA_RELATION_TARGET_INVALID`
- `SPA_RELATION_CARDINALITY`
- `SPA_RELATION_REQUIRED`
- `SPA_LAYOUT_FIELD_INVALID`
- `PERMISSION_DENIED`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `SPA_RELATION_CREATED`, `SPA_RELATION_REMOVED`, `SPA_LAYOUT_UPDATED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

CRM, Tasks/Projects, Calendar, Files/Documents, Timeline, Auth.

## Testing contract — executable and E2E

Matching files: `Testing/Smart-Process-Automation/spa-relations.spec.ts` and `Testing/Smart-Process-Automation/spa-relations.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** ONE relation enforces cardinality under concurrent writes
- **2.** cross-workspace target cannot be linked
- **3.** item list hides relation to inaccessible target
- **4.** relation unlink does not delete target entity
- **5.** inverse relation is query view not duplicate row
- **6.** layout rejects missing fields and preserves versions
- **7.** user view preferences cannot affect coworkers

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
