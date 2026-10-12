# Workflow Security, Templates and Execution Governance — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowAdminController`, `WorkflowTemplatesController`  
**Source of truth / domain entities:** `workflow_templates; workflow_runtime_policies; workflow_log_retention_policies; workflow_comments_bindings`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_templates: workspace_id,id,name,category,definition_snapshot_json,status,owner_user_id,version,created_at.
- workflow_runtime_policies: workspace_id,concurrency_limits,loop_limits,retention_days default365,redaction_config,version.
- workflow_comments_bindings: workspace_id,execution_id,shared_discussion_id (Communication/Timeline owns comments).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflow-templates` | `WorkflowTemplatesController` | `WORKFLOW.TEMPLATE_MANAGE` | page,limit,category? | Authorized templates. |
| `POST` | `/api/v1/workflow-templates` | `WorkflowTemplatesController` | `WORKFLOW.TEMPLATE_MANAGE` | name,category,sourceVersionId | Snapshot safe template, strip secrets and sensitive IDs. |
| `POST` | `/api/v1/workflow-templates/:templateId/instantiate` | `WorkflowTemplatesController` | `WORKFLOW.DESIGN` | name,code,bindings | Create new draft definition. |
| `GET` | `/api/v1/workflow-executions/:executionId/discussion` | `WorkflowAdminController` | `WORKFLOW.EXECUTION_VIEW` | executionId | Resolve scoped Communication/Timeline discussion reference. |
| `GET` | `/api/v1/workflows/admin/health` | `WorkflowAdminController` | `WORKFLOW.EXECUTION_ADMIN` | status? | Stuck leases/waits/failures and queue lag (no secrets). |
| `POST` | `/api/v1/workflows/admin/reconcile` | `WorkflowAdminController` | `WORKFLOW.EXECUTION_ADMIN` | executionIds?,Idempotency-Key | Queue safe reconciliation, return jobId. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Access split DESIGN,PUBLISH,START,CANCEL_OWN,CANCEL_ALL,EXECUTION_VIEW,EXECUTION_ADMIN,LOG_VIEW,ASSIGNMENT_DELEGATE,SECURE_RUNAS_MANAGE.
2. Logs classify fields PUBLIC|BUSINESS|SENSITIVE|SECRET; SECRET redacted irreversibly, BUSINESS/SENSITIVE filtered by current domain permissions.
3. Completed execution details/logs retained default 365 days, configurable; legal hold overrides; business outcome and global audit follow own retention independent of debug log purge.
4. Templates must not copy live user identity tokens, provider secrets, cross-workspace IDs or tenant-bound addresses without safe remapping.
5. Operational stuck-work recovery uses leases/timeouts and diagnostic commands, no direct DB row manipulation.

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

- `WORKFLOW_LOG_FORBIDDEN`
- `WORKFLOW_TEMPLATE_INVALID`
- `WORKFLOW_RETENTION_HOLD`
- `WORKFLOW_RECONCILE_NOT_ALLOWED`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_TEMPLATE_CREATED`, `WORKFLOW_RETENTION_CHANGED`, `WORKFLOW_RECONCILIATION_COMPLETED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Platform Audit/Retention, Communication/Timeline, Jobs/Observability.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/workflow-security-runtime.spec.ts` and `Testing/Workflows-Business-Processes/workflow-security-runtime.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** nonadmin cannot inspect other workflow sensitive logs
- **2.** SECRET tokens never persist to logs
- **3.** completed log retention respects legal hold
- **4.** archiving template does not affect instantiated definitions
- **5.** template copied to another Workspace removes hardcoded target IDs/secrets
- **6.** reconcile command does not double-run completed node

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
