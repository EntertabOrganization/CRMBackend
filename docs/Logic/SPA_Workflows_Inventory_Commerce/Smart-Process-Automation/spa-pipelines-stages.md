# SPA Pipelines, Stages, Kanban and Transitions — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaPipelinesController`, `SpaStagesController`  
**Source of truth / domain entities:** `spa_pipelines; spa_stages; spa_stage_history; spa_stage_transition_rules; spa_stage_requirements`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_pipelines: workspace_id,type_id,id,code,name,is_default,sort_order,status,version; unique(type_id,code), at most one active default per Type.
- spa_stages: workspace_id,pipeline_id,id,code,name,semantic PROGRESS|SUCCESS|FAILURE,is_default,sort_order,status,version.
- spa_stage_transition_rules: workspace_id,from_stage_id,to_stage_id,allowed_roles_json,conditions_json; spa_stage_history: item_id,old/new pipeline/stage,actor,entered_at,exited_at.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/spa/types/:typeId/pipelines` | `SpaPipelinesController` | `SPA.PIPELINE.READ` | page,limit | List permitted pipelines. |
| `POST` | `/api/v1/spa/types/:typeId/pipelines` | `SpaPipelinesController` | `SPA.PIPELINE.MANAGE` | name,code,isDefault? | Create pipeline with default stage plan. |
| `PATCH` | `/api/v1/spa/types/:typeId/pipelines/:pipelineId` | `SpaPipelinesController` | `SPA.PIPELINE.MANAGE` | expectedVersion,name?,sortOrder?,isDefault? | Update without breaking item bindings. |
| `POST` | `/api/v1/spa/types/:typeId/pipelines/:pipelineId/archive` | `SpaPipelinesController` | `SPA.PIPELINE.MANAGE` | expectedVersion,migrationTarget? | Block if live items not migrated. |
| `GET` | `/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages` | `SpaStagesController` | `SPA.PIPELINE.READ` | pipelineId | Ordered stage list. |
| `POST` | `/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages` | `SpaStagesController` | `SPA.STAGE.MANAGE` | name,code,semantic,sortOrder,isDefault? | Create stage. |
| `PATCH` | `/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId` | `SpaStagesController` | `SPA.STAGE.MANAGE` | expectedVersion,name?,sortOrder?,semantic? | Validate terminal semantics/live impacts. |
| `POST` | `/api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive` | `SpaStagesController` | `SPA.STAGE.MANAGE` | migrationTarget? | Reject when live items exist without valid migration. |
| `POST` | `/api/v1/spa/types/:typeId/items/:itemId/transition` | `SpaPipelinesController` | `SPA.ITEM.STAGE_CHANGE` | expectedVersion,targetPipelineId,targetStageId,reason? | Check source/target rules and required fields, append history/outbox. |
| `GET` | `/api/v1/spa/types/:typeId/kanban` | `SpaPipelinesController` | `SPA.ITEM.READ` | pipelineId,filters | Authorized grouped stage projection; does not duplicate Item data. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Stage must belong to target pipeline and both to SPA Type; unauthorized cross-pipeline IDs invalid.
2. One initial stage per active pipeline, one default pipeline per pipeline-enabled Type; reorder never changes stable IDs.
3. Stage transition evaluates action+scope+current/target stage/field permissions, current required values, allowed transition graph and optimistic expectedVersion.
4. SUCCESS/FAILURE stage semantics update item status/closedAt according to type policy; history records old/new IDs, timestamps, actor, reason.
5. Deleting/archiving stages/pipelines with live Items requires explicit migration/transition of live references; historical stage rows are not physically erased.
6. Pipeline stage is independent from Workflow Execution status, Task status and CRM Deal stage.

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

- `SPA_PIPELINE_NOT_FOUND`
- `SPA_STAGE_NOT_FOUND`
- `SPA_INVALID_TRANSITION`
- `SPA_STAGE_REQUIRED_FIELDS`
- `SPA_PIPELINE_HAS_ITEMS`
- `SPA_STAGE_HAS_ITEMS`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `SPA_PIPELINE_CREATED`, `SPA_STAGE_CREATED`, `SPA_ITEM_STAGE_CHANGED`, `SPA_PIPELINE_ARCHIVED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

SPA schema fields/requirements, CRM Pipelines (reuse engine concept, no duplicate domain ownership).

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-pipelines-stages.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-pipelines-stages.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** create and reorder pipelines/stages preserves existing item references
- **2.** reject moving item to stage belonging to different pipeline
- **3.** reject transition missing target-stage required field
- **4.** reject unauthorized actor/stage permission
- **5.** terminal success state closes Item and emits once
- **6.** optimistic racing drag-and-drop moves only one succeeds
- **7.** cannot archive stage/pipeline with live items without migration
- **8.** kanban respects item and field visibility per viewer

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
