# Workflow Definitions, Versions and Publication — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowDefinitionsController`, `WorkflowVersionsController`  
**Source of truth / domain entities:** `workflow_definitions; workflow_versions; workflow_start_conditions; workflow_parameter_definitions`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_definitions: workspace_id,id,code,name,type SEQUENTIAL|STATUS_DRIVEN,status DRAFT|ACTIVE|PAUSED|ARCHIVED,bound_entity_type,bound_entity_type_id?,current_version_id?,concurrency_mode,run_as,version,created_by_user_id.
- workflow_versions: workspace_id,id,definition_id,version_number,status DRAFT|PUBLISHED|SUPERSEDED|ARCHIVED,definition_json,checksum,published_at,published_by; unique(definition_id,version_number); PUBLISHED immutable.
- workflow_parameter_definitions: workspace_id,version_id,code,typed_schema_json,required,default_json; workflow_start_conditions: workspace_id,definition_id,event_type,condition_json,enabled,priority.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/workflows` | `WorkflowDefinitionsController` | `WORKFLOW.DESIGN` | name,code,type,boundEntityType,boundEntityTypeId?,concurrencyMode?,runAs? | Create draft definition. |
| `GET` | `/api/v1/workflows` | `WorkflowDefinitionsController` | `WORKFLOW.VIEW` | page,limit,search,status,boundEntityType | Authorized collection. |
| `GET` | `/api/v1/workflows/:workflowId` | `WorkflowDefinitionsController` | `WORKFLOW.VIEW` | workflowId | Definition summary, current published version. |
| `PATCH` | `/api/v1/workflows/:workflowId` | `WorkflowDefinitionsController` | `WORKFLOW.DESIGN` | expectedVersion,name?,concurrencyMode?,startConditions? | Edit configuration; never mutate published versions. |
| `POST` | `/api/v1/workflows/:workflowId/versions` | `WorkflowVersionsController` | `WORKFLOW.DESIGN` | baseVersionId? | New draft cloned from selected version. |
| `GET` | `/api/v1/workflows/:workflowId/versions` | `WorkflowVersionsController` | `WORKFLOW.VIEW` | page,limit | Version history. |
| `GET` | `/api/v1/workflows/:workflowId/versions/:versionId` | `WorkflowVersionsController` | `WORKFLOW.VIEW` | versionId | Immutable graph/definitions snapshot. |
| `POST` | `/api/v1/workflows/:workflowId/versions/:versionId/validate` | `WorkflowVersionsController` | `WORKFLOW.DESIGN` | versionId | Structural/security/recursion/permissions validation. |
| `POST` | `/api/v1/workflows/:workflowId/versions/:versionId/publish` | `WorkflowVersionsController` | `WORKFLOW.PUBLISH` | expectedVersion | Atomically publish immutable version and set currentVersionId. |
| `POST` | `/api/v1/workflows/:workflowId/pause` | `WorkflowDefinitionsController` | `WORKFLOW.PUBLISH` | expectedVersion | Stop future starts; no retroactive cancellation. |
| `POST` | `/api/v1/workflows/:workflowId/archive` | `WorkflowDefinitionsController` | `WORKFLOW.PUBLISH` | expectedVersion | Stop starts, preserve executions/versions/history. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. New execution stores exact workflow_version_id and compiled immutable snapshot; editing/publishing V(n+1) never alters running V(n).
2. Definition code unique in Workspace; entity binding must be an allowed type and refer to the same Workspace where bound subtype exists.
3. Only DRAFT version editable; published versions/checksum immutable; no publish until graph validator passes all reachable/end/loop/permission constraints.
4. Default concurrency ONE_PER_DEFINITION_PER_ENTITY; other modes ALLOW_PARALLEL, ONE_WORKFLOW_PER_ENTITY, CUSTOM_KEY.
5. Manual start defaults RUN_AS STARTER; service actor must be explicitly configured with least privileges and audited.
6. Archive preserves version/run logs, blocks new starts, leaves already running Instances pinned and recoverable.

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

- `WORKFLOW_NOT_FOUND`
- `WORKFLOW_VERSION_NOT_FOUND`
- `WORKFLOW_PUBLISHED_IMMUTABLE`
- `WORKFLOW_GRAPH_INVALID`
- `WORKFLOW_ARCHIVED`
- `WORKFLOW_ENTITY_BINDING_INVALID`
- `WORKFLOW_RUNAS_DENIED`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_CREATED`, `WORKFLOW_VERSION_PUBLISHED`, `WORKFLOW_PAUSED`, `WORKFLOW_ARCHIVED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Permissions, Domain Entity Resolver, Audit, Events, Entitlements.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/workflow-definitions-versions.spec.ts` and `Testing/Workflows-Business-Processes/workflow-definitions-versions.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** publishing V2 leaves running V1 execution graph unchanged
- **2.** cannot modify published graph or parameter schema
- **3.** validator rejects no start/end, dangling edges or unsafe action
- **4.** publishing increments definition version and emits once
- **5.** archived definition rejects new manual/event starts but historical logs remain
- **6.** service-account change requires permission and central audit
- **7.** cross-workspace bound entity denied

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
