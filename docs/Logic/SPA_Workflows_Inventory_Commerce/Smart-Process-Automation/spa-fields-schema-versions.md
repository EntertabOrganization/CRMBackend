# SPA Fields, Schema Drafts and Publication — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaFieldsController`, `SpaSchemasController`  
**Source of truth / domain entities:** `spa_field_definitions; spa_field_options; spa_schema_versions; spa_schema_drafts; spa_schema_migration_jobs; spa_unique_constraints`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_field_definitions: workspace_id,type_id,code,name,field_type TEXT|TEXTAREA|INTEGER|DECIMAL|BOOLEAN|DATE|DATETIME|LIST|MULTI_LIST|EMAIL|PHONE|URL|MONEY|USER|CRM_REF|FILE|SPA_REF; is_required,is_multiple,is_active,is_searchable,default_json,validation_json,visibility_json,version.
- spa_field_options: workspace_id,field_id,code,label,sort_order,is_active; unique(field_id,code).
- spa_schema_versions: workspace_id,type_id,version_number,published_at,published_by,snapshot_json,checksum; unique(type_id,version_number), immutable after publication.
- spa_schema_migration_jobs: old_version,new_draft_id,field_mapping_json,conversion_failures,processed_count,status; never silently discard values.
- spa_unique_constraints: workspace_id,type_id,name,field_codes_json,active; uniqueness also scoped to type.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/spa/types/:typeId/fields` | `SpaFieldsController` | `SPA.SCHEMA.READ` | typeId | List active/inactive field definitions with access filtering. |
| `POST` | `/api/v1/spa/types/:typeId/fields` | `SpaFieldsController` | `SPA.SCHEMA.MANAGE` | code,name,fieldType,isRequired?,options? | Add field to draft schema only. |
| `PATCH` | `/api/v1/spa/types/:typeId/fields/:fieldId` | `SpaFieldsController` | `SPA.SCHEMA.MANAGE` | name?,validation?,options?,isRequired?,isSearchable? | Draft edit; type changes require migration plan. |
| `POST` | `/api/v1/spa/types/:typeId/fields/:fieldId/deactivate` | `SpaFieldsController` | `SPA.SCHEMA.MANAGE` | expectedVersion | Keep historical values, block new entry. |
| `GET` | `/api/v1/spa/types/:typeId/schema/draft` | `SpaSchemasController` | `SPA.SCHEMA.READ` | typeId | Return mutable draft and its version. |
| `PATCH` | `/api/v1/spa/types/:typeId/schema/draft` | `SpaSchemasController` | `SPA.SCHEMA.MANAGE` | expectedVersion,changes[] | Stage structural field/layout/requirement/constraint changes. |
| `POST` | `/api/v1/spa/types/:typeId/schema/validate` | `SpaSchemasController` | `SPA.SCHEMA.MANAGE` | draftVersion | Return impact report (invalid values, affected items, dependencies). |
| `POST` | `/api/v1/spa/types/:typeId/schema/publish` | `SpaSchemasController` | `SPA.SCHEMA.PUBLISH` | expectedDraftVersion,migrationPlanId? | Atomic publish; migration must be complete for destructive edits. |
| `GET` | `/api/v1/spa/types/:typeId/schema/versions` | `SpaSchemasController` | `SPA.SCHEMA.READ` | page,limit | Immutable publication history. |
| `POST` | `/api/v1/spa/types/:typeId/schema/migrations` | `SpaSchemasController` | `SPA.SCHEMA.MANAGE` | fieldId,targetType,mappingStrategy | Queue preview/convert job, never silently modify production data. |
| `POST` | `/api/v1/spa/types/:typeId/unique-constraints` | `SpaSchemasController` | `SPA.SCHEMA.MANAGE` | name,fieldCodes[] | Preview duplicates and publish safe uniqueness constraint. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Field code unique case-insensitively per Type; protect system codes (id,workspaceId,typeId,createdAt,updatedAt,version).
2. System fields remain real columns; dynamic field values are typed metadata, not arbitrary new SQL columns from user input.
3. On create/update/stage move backend revalidates values, requiredness, option membership, number ranges, permissions and type; hidden required field must not block a user without a defined workflow/default value.
4. Changing field type requires impact preview and a migration with explicit handling for invalid existing values; publish refuses while incompatibilities exist.
5. Deactivating field preserves historical stored values, search mappings and audit; a field type change never silently clears data.
6. Published schema snapshots immutable; running Item updates use current valid schema or explicit compatibility transformation, with historical item.schemaVersion retained.
7. Uniqueness constraints reject null policy according to explicit configuration: default nullable values ignored; canonical normalization for case-insensitive keys, applied atomically.

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

- `SPA_FIELD_CODE_EXISTS`
- `SPA_FIELD_TYPE_INVALID`
- `SPA_SCHEMA_CONFLICT`
- `SPA_SCHEMA_MIGRATION_REQUIRED`
- `SPA_SCHEMA_MIGRATION_FAILED`
- `SPA_SCHEMA_DUPLICATE_VALUES`
- `SPA_REQUIRED_FIELD_MISSING`
- `SPA_FIELD_PERMISSION_DENIED`

## Durable domain events and global audit

- **Outbox events:** `SPA_SCHEMA_DRAFT_UPDATED`, `SPA_SCHEMA_PUBLISHED`, `SPA_FIELD_DEACTIVATED`, `SPA_FIELD_MIGRATION_COMPLETED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Shared Custom Field engine, Workers, Search, Audit, Entitlements.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-fields-schema-versions.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-fields-schema-versions.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** field metadata validates every supported typed value and multi-value option membership
- **2.** system field name rejected and duplicate codes rejected
- **3.** schema draft edited without mutating published schema
- **4.** schema publish increments version and invalidates cache/search projections
- **5.** field type migration previews incompatible existing records
- **6.** publishing migration while conversion errors exist is blocked
- **7.** adding unique constraint to duplicate live data is rejected
- **8.** field deactivation preserves prior item values
- **9.** unauthorized schema write and cross-workspace IDs rejected

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
