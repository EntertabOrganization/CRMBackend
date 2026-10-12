# SPA Import, Export, Recycle and Retention — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaTransfersController`, `SpaRecycleController`  
**Source of truth / domain entities:** `spa_import_jobs; spa_import_rows; spa_export_jobs; spa_external_links; spa_purge_jobs`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_import_jobs: workspace_id,type_id,id,mode CREATE_ONLY|UPSERT_BY_EXTERNAL_KEY,mapping_json,status,source_file_id,created_by,totals_json.
- spa_import_rows: workspace_id,job_id,row_number,external_source,external_id,status,error_codes_json,item_id; unique(job_id,row_number).
- spa_export_jobs: workspace_id,type_id,scope_snapshot_json,requested_by,status,download_file_id,expires_at.
- spa_purge_jobs: workspace_id,type_id,item_ids_json,status,legal_hold_checked_at,attempt_count.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/spa/types/:typeId/imports` | `SpaTransfersController` | `SPA.ITEM.IMPORT` | fileId,fieldMapping,mode,sourceSystem?,externalKeyColumn? | Queue import; return 202 and jobId. |
| `GET` | `/api/v1/spa/types/:typeId/imports/:jobId` | `SpaTransfersController` | `SPA.ITEM.IMPORT` | jobId | Status, per-row error counts and report file. |
| `POST` | `/api/v1/spa/types/:typeId/imports/:jobId/cancel` | `SpaTransfersController` | `SPA.ITEM.IMPORT` | jobId | Cancel safely between rows, preserve committed rows/results. |
| `POST` | `/api/v1/spa/types/:typeId/exports` | `SpaTransfersController` | `SPA.ITEM.EXPORT` | filters,fieldCodes[] | Snapshot viewer-authorized scope; return 202 jobId. |
| `GET` | `/api/v1/spa/types/:typeId/exports/:jobId` | `SpaTransfersController` | `SPA.ITEM.EXPORT` | jobId | Status and temporary authorized file link. |
| `GET` | `/api/v1/spa/types/:typeId/trash` | `SpaRecycleController` | `SPA.ITEM.RESTORE` | page,limit | List authorized trashed items. |
| `POST` | `/api/v1/spa/types/:typeId/items/:itemId/purge` | `SpaRecycleController` | `SPA.ITEM.HARD_DELETE` | itemId | Queue checked purge, block holds/retention. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Import never trusts workspaceId; each row calls validated SPA Item domain service; CREATE_ONLY never changes existing Item; UPSERT_BY_EXTERNAL_KEY requires source system + stable external id, not title.
2. Import success and failure counted individually and returned with row number, validation code and sanitized detail; committed prior rows survive later row failures.
3. Export enforces item and field permissions at execution time; no forbidden field can be included in generated file/search.
4. Trash default 30 days (workspace configurable); legal hold prevents purge; shared linked entities are not recursively destroyed; Audit retained.
5. Purge permission separate from ordinary DELETE and cannot bypass legal hold.

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

- `SPA_IMPORT_MAPPING_INVALID`
- `SPA_IMPORT_ROW_INVALID`
- `SPA_UPSERT_KEY_REQUIRED`
- `SPA_EXPORT_FORBIDDEN_FIELD`
- `SPA_RETENTION_HOLD`
- `SPA_PURGE_BLOCKED`

## Durable domain events and global audit

- **Outbox events:** `SPA_IMPORT_COMPLETED`, `SPA_EXPORT_READY`, `SPA_ITEM_PURGED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Shared Import/Export Job system, Files, Permissions, Audit/Retention.

## Testing contract — executable and E2E

Matching files: `Testing/Smart-Process-Automation/spa-import-export-lifecycle.spec.ts` and `Testing/Smart-Process-Automation/spa-import-export-lifecycle.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** CREATE_ONLY import reports duplicate external key without title merge
- **2.** UPSERT keyed retry does not duplicate records
- **3.** unknown mapping target is a per-row validation failure
- **4.** partial import results include each row and avoid false all-or-nothing report
- **5.** export excludes hidden salary and unauthorized items
- **6.** import/export jobs require own or admin authorization
- **7.** purge blocked under legal hold
- **8.** trash expires per workspace policy but keeps audit

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
