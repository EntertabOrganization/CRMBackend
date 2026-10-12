# SPA Types and Capabilities — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaTypesController`, `SpaCapabilitiesController`  
**Source of truth / domain entities:** `spa_entity_types; spa_capabilities`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_entity_types: id UUID, workspace_id UUID, code uppercase 2..64, name 1..160, plural_name 1..160, placement CRM|AUTOMATION, status DRAFT|ACTIVE|ARCHIVED|DELETION_PENDING, schema_version integer, created_by_user_id, created_at, updated_at, deleted_at, version bigint.
- spa_capabilities: (workspace_id, type_id, capability_key) unique; capability_key PIPELINES|KANBAN|AUTOMATION|CLIENT|PRODUCTS|DOCUMENTS|OBSERVERS|TASKS|CALENDAR|RECURRENCE|RECYCLE_BIN|NUMBERING|ACTIVITIES; enabled boolean; configuration_json validated per key.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/spa/types` | `SpaTypesController` | `SPA.TYPE.MANAGE` | name,pluralName,code,placement,capabilities? | Create DRAFT type with immutable code and configured capability defaults. |
| `GET` | `/api/v1/spa/types` | `SpaTypesController` | `SPA.TYPE.READ` | page,limit,search,placement,status | Permission-filtered collection. |
| `GET` | `/api/v1/spa/types/:typeId` | `SpaTypesController` | `SPA.TYPE.READ` | typeId | Return metadata, effective permissions and capabilities. |
| `PATCH` | `/api/v1/spa/types/:typeId` | `SpaTypesController` | `SPA.TYPE.MANAGE` | expectedVersion,name?,pluralName?,placement?,description? | Update non-destructive metadata only. |
| `POST` | `/api/v1/spa/types/:typeId/activate` | `SpaTypesController` | `SPA.TYPE.MANAGE` | expectedVersion | Activate only after valid published schema. |
| `POST` | `/api/v1/spa/types/:typeId/archive` | `SpaTypesController` | `SPA.TYPE.MANAGE` | expectedVersion | Block new items/triggers, retain items/history. |
| `POST` | `/api/v1/spa/types/:typeId/restore` | `SpaTypesController` | `SPA.TYPE.MANAGE` | expectedVersion | Reactivate after checking schema and entitlements. |
| `GET` | `/api/v1/spa/types/:typeId/capabilities` | `SpaCapabilitiesController` | `SPA.TYPE.READ` | typeId | Return flags/configuration. |
| `PUT` | `/api/v1/spa/types/:typeId/capabilities/:key` | `SpaCapabilitiesController` | `SPA.TYPE.MANAGE` | expectedVersion,enabled,configuration | Impact preview required before disabling with live bindings; publish schema change. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Type code uniqueness is (workspace_id,code), case-insensitive; code cannot change after first Item; no cross-tenant duplicated metadata from input workspaceId.
2. One draft type may activate only after valid field schema and, if PIPELINES enabled, one default pipeline and start stage; enabling KANBAN requires PIPELINES.
3. Capability disable cannot silently discard existing item product rows, documents, relations, automation or recurrence; show impact and refuse until migration/disable plan acknowledged.
4. Type archive makes schema read-only and stops new item creation and new automation starts; existing historical records can be read with permission.
5. Only dedicated purge job, after retention/hold and dependency validation, can transition DELETION_PENDING to PURGED; never drop physical tables.
6. Enforce SaaS entitlement counts for types/fields/capabilities at creation/activation, never hardcode plan name.

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

- `SPA_TYPE_NOT_FOUND`
- `SPA_TYPE_CODE_EXISTS`
- `SPA_TYPE_INVALID_STATUS`
- `SPA_CAPABILITY_DEPENDENCY`
- `SPA_CAPABILITY_IN_USE`
- `SPA_SCHEMA_NOT_PUBLISHED`
- `SPA_PLAN_LIMIT`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `SPA_TYPE_CREATED`, `SPA_TYPE_ACTIVATED`, `SPA_TYPE_ARCHIVED`, `SPA_TYPE_RESTORED`, `SPA_CAPABILITY_CHANGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Existing Workspace/Auth/Permissions, Shared Custom Fields, CRM Pipelines, Entitlements, Audit, Outbox.

## Testing contract — executable and E2E

Matching files: `Testing/Smart-Process-Automation/spa-types-capabilities.spec.ts` and `Testing/Smart-Process-Automation/spa-types-capabilities.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** create type with unique code, draft state and capability defaults
- **2.** activate type with valid published schema and default pipeline
- **3.** reject duplicate code and invalid code format
- **4.** reject KANBAN when pipelines disabled
- **5.** reject disable capabilities while live dependent data remain
- **6.** archived type rejects item creation but permits authorized historical read
- **7.** cross-workspace type ID not accessible
- **8.** type management denied without SPA.TYPE.MANAGE
- **9.** stale expectedVersion returns 409 and produces no outbox event

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
