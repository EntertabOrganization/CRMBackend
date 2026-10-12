# SPA Numbering, Recurrence and Idempotent Generation — Implementation Specification

**Scope:** Smart Process Automation  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `SpaNumberingController`, `SpaRecurrenceController`  
**Source of truth / domain entities:** `spa_numbering_schemes; spa_recurrence_templates; spa_recurrence_rules; spa_recurrence_instances`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- spa_numbering_schemes: workspace_id,type_id,prefix_template,padding,reset_policy NEVER|YEARLY|MONTHLY,period_key,next_value bigint,version; sequence locked per type+period.
- spa_recurrence_templates: workspace_id,type_id,template_item_id?,item_payload_json,rule_id,is_active,created_by_user_id.
- spa_recurrence_rules: workspace_id,type_id,frequency DAILY|WEEKLY|MONTHLY|YEARLY|CUSTOM,timezone,starts_at,ends_at?,interval,by_day_json?,max_instances?.
- spa_recurrence_instances: workspace_id,rule_id,scheduled_for,item_id,created_at; unique(workspace_id,rule_id,scheduled_for).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/spa/types/:typeId/numbering` | `SpaNumberingController` | `SPA.TYPE.READ` | typeId | View effective numbering scheme. |
| `PUT` | `/api/v1/spa/types/:typeId/numbering` | `SpaNumberingController` | `SPA.TYPE.MANAGE` | expectedVersion,prefixTemplate,padding,resetPolicy | Validate template and preserve allocated historical numbers. |
| `GET` | `/api/v1/spa/types/:typeId/recurrence` | `SpaRecurrenceController` | `SPA.RECURRENCE.READ` | page,limit | List recurrence templates. |
| `POST` | `/api/v1/spa/types/:typeId/recurrence` | `SpaRecurrenceController` | `SPA.RECURRENCE.MANAGE` | timezone,frequency,interval,templatePayload,startsAt,endsAt? | Create generation plan. |
| `PATCH` | `/api/v1/spa/types/:typeId/recurrence/:ruleId` | `SpaRecurrenceController` | `SPA.RECURRENCE.MANAGE` | expectedVersion,templatePayload?,rule? | Future instances only. |
| `POST` | `/api/v1/spa/types/:typeId/recurrence/:ruleId/pause` | `SpaRecurrenceController` | `SPA.RECURRENCE.MANAGE` | ruleId | Stop future scheduled generation. |
| `POST` | `/api/v1/spa/types/:typeId/recurrence/:ruleId/resume` | `SpaRecurrenceController` | `SPA.RECURRENCE.MANAGE` | ruleId | Resume without duplicates. |
| `GET` | `/api/v1/spa/types/:typeId/recurrence/:ruleId/instances` | `SpaRecurrenceController` | `SPA.RECURRENCE.READ` | page,limit | Historical generated items. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Allocate business numbers transactionally and uniquely for each Type+period; neither rollback nor retry may create duplicate numbers.
2. Template supports tokens documented in shared number service ({YYYY},{MM},{0000}); forbidden arbitrary expression/shell expansion.
3. Scheduler evaluates local IANA timezone, daylight-saving disambiguation and the committed recurrence rule revision.
4. Each occurrence unique by (workspace,rule,scheduled_for), generation is retry-safe through DB uniqueness; created Item independent after creation.
5. Template/rule edits affect future instances only, do not retroactively edit old Items; delete/pause retains history.
6. Generation uses same Item validation, permission/service actor and outbox as ordinary Item creation.

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

- `SPA_NUMBER_FORMAT_INVALID`
- `SPA_RECURRENCE_INVALID`
- `SPA_RECURRENCE_DISABLED`
- `SPA_GENERATION_CONFLICT`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `SPA_RECURRENCE_SCHEDULED`, `SPA_RECURRING_ITEM_CREATED`, `SPA_RECURRENCE_PAUSED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Platform Numbering, Jobs, Idempotency, SPA Item service.

## Testing contract — executable and E2E

Matching files: `Testing/Smart-Process-Automation/spa-numbering-recurrence.spec.ts` and `Testing/Smart-Process-Automation/spa-numbering-recurrence.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** concurrent numbering never produces duplicate business numbers
- **2.** yearly reset changes sequence partition, historical number stable
- **3.** concurrent scheduler workers generate one Item per occurrence
- **4.** recurrence DST/timezone handling stores stable occurrence identity
- **5.** update recurrence does not modify historical created items
- **6.** paused rule does not create new items
- **7.** generated item validates current permitted schema

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
