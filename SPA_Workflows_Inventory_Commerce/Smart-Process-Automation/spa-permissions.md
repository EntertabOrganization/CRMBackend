# SPA Scoped Roles, Stage/Field Access and Schema Security — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaPermissionsController`  
**Source of truth / domain entities:** `spa_type_role_policies; spa_stage_permissions; spa_field_permissions; spa_permission_change_history`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_type_role_policies: workspace_id,type_id,role_id,action,scope NONE|OWN|DEPARTMENT|DEPARTMENT_TREE|TEAM|ALL; unique(type_id,role_id,action).
- spa_stage_permissions: workspace_id,type_id,pipeline_id,stage_id,role_id,action,scope; spa_field_permissions: workspace_id,field_id,subject_type,subject_id,can_view,can_edit.
- All policy changes append immutable configuration history and increment auth permission version/cache epoch.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/spa/types/:typeId/permissions` | `SpaPermissionsController` | `SPA.PERMISSION.MANAGE` | typeId | View effective policy matrix. |
| `PUT` | `/api/v1/spa/types/:typeId/permissions` | `SpaPermissionsController` | `SPA.PERMISSION.MANAGE` | expectedVersion,rolePolicies[],stagePolicies[],fieldPolicies[] | Validate known permissions, subjects and scoped role grants. |
| `GET` | `/api/v1/spa/types/:typeId/items/:itemId/permissions/me` | `SpaPermissionsController` | `SPA.ITEM.READ` | itemId | Return effective actions and visible/editable field codes for actor. |
| `GET` | `/api/v1/spa/types/:typeId/permissions/history` | `SpaPermissionsController` | `SPA.PERMISSION.MANAGE` | page,limit | Security-sensitive changes, actor and diff. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Effective access = active Workspace membership + SPA Type permission + Item scope + Stage permission + Field rule + current Item state + feature entitlement.
2. Observer membership gives read access to visible fields only; cannot override explicitly forbidden field visibility or tenant isolation.
3. Field-level restriction must apply to GET/list/search/export, not only frontend display. Forbidden fields are excluded from sort/filter/search to prevent inference.
4. Changing permission invalidates search/realtime authorization caches and must take effect on subsequent business reads.
5. Only authorized SPA.PERMISSION.MANAGE may change role/stage/field policies; actor cannot grant broader rights than organization policy permits.

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

- `SPA_PERMISSION_INVALID_SCOPE`
- `SPA_FIELD_PERMISSION_DENIED`
- `SPA_STAGE_PERMISSION_DENIED`
- `SPA_POLICY_CONFLICT`
- `PERMISSION_DENIED`

## Durable domain events and global audit

- **Outbox events:** `SPA_PERMISSION_CHANGED`, `SPA_FIELD_POLICY_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Auth/Permissions, Search, Audit, Realtime.

## Testing contract — executable and E2E

Matching files: `Testing/Smart-Process-Automation/spa-permissions.spec.ts` and `Testing/Smart-Process-Automation/spa-permissions.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** role with OWN scope sees only eligible Items
- **2.** stage edit policy can deny update despite Type update grant
- **3.** field hidden from viewer absent from GET/list/export
- **4.** field invisible cannot be used to infer value through filters
- **5.** observer read does not enable edit
- **6.** permission update audited and cache invalidated
- **7.** forged other Workspace role ID denied

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
