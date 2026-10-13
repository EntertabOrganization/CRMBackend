# Workflow Executions, Tokens, Dispatch and Recovery — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowExecutionsController`  
**Source of truth / domain entities:** `workflow_executions; workflow_node_executions; workflow_execution_tokens; workflow_start_requests; workflow_execution_variables; workflow_execution_logs`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_executions: workspace_id,id,definition_id,version_id,entity_type,entity_id,run_as,started_by_type,started_by_id,status QUEUED|RUNNING|WAITING|SUSPENDED|COMPLETED|FAILED|CANCELLED|TERMINATED|TIMED_OUT,result_code,result_json,started_at,completed_at,version bigint.
- workflow_node_executions: workspace_id,execution_id,node_id,iteration_number,attempt_count,status,input_json,output_json,error_code,lease_owner,lease_until; unique(execution_id,node_id,iteration_number,activation_key).
- workflow_execution_tokens: execution_id,branch_key,node_key,status,join_group_id,version; workflow_start_requests: unique(workspace_id,definition_id,idempotency_key).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/workflows/:workflowId/start` | `WorkflowExecutionsController` | `WORKFLOW.START` | entityType,entityId,parameters,Idempotency-Key | Start pinned published version after concurrency & binding checks; return 202 execution ID. |
| `GET` | `/api/v1/workflow-executions` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_VIEW` | page,limit,workflowId?,entityId?,status? | Scoped executions. |
| `GET` | `/api/v1/workflow-executions/:executionId` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_VIEW` | executionId | State, progress, authorized redacted variables. |
| `GET` | `/api/v1/workflow-executions/:executionId/nodes` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_VIEW` | page,limit | Node execution timeline/attempts. |
| `GET` | `/api/v1/workflow-executions/:executionId/logs` | `WorkflowExecutionsController` | `WORKFLOW.LOG_VIEW` | cursor?,limit?,level? | Redacted structured logs. |
| `POST` | `/api/v1/workflow-executions/:executionId/cancel` | `WorkflowExecutionsController` | `WORKFLOW.CANCEL_OWN\|WORKFLOW.CANCEL_ALL` | reason,expectedVersion | Request cancellation, stop future dispatch and run configured compensation. |
| `POST` | `/api/v1/workflow-executions/:executionId/suspend` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_ADMIN` | reason,expectedVersion | Pause execution and internal timers durably. |
| `POST` | `/api/v1/workflow-executions/:executionId/resume` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_ADMIN` | expectedVersion | Resume paused tokens and remaining-duration timers. |
| `POST` | `/api/v1/workflow-executions/:executionId/retry` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_ADMIN` | failedNodeRunId,expectedVersion | Retry safe persisted pre-node state only. |
| `POST` | `/api/v1/workflow-executions/:executionId/terminate` | `WorkflowExecutionsController` | `WORKFLOW.EXECUTION_ADMIN` | reason,expectedVersion | Irrevocable stop of future actions; preserve audit/history. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Start uses durable dedupe key and concurrency lock for entity+definition; default one active execution for same definition+entity.
2. Every node state/token/result checkpoint committed before acknowledging queue work; worker recovery reclaims expired leases and never assumes at-most-once delivery.
3. External effects use per node-run idempotency or explicit provider dedupe key; retry cannot double-charge/create stock/order.
4. Terminal statuses only after joins/active tokens and required outcomes resolve; cannot complete while required approval remains.
5. SUSPENDED freezes internal relative timers; external absolute deadline handling must remain explicit.
6. Retry of business 4xx requires operator correction, not automatic infinite retry; all recovery commands preserve node history.
7. Execution logs use redaction labels and scope checks; secret values never persisted in cleartext.

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

- `WORKFLOW_NO_PUBLISHED_VERSION`
- `WORKFLOW_ALREADY_RUNNING`
- `WORKFLOW_EXECUTION_NOT_FOUND`
- `WORKFLOW_INVALID_STATE`
- `WORKFLOW_RETRY_UNSAFE`
- `WORKFLOW_NODE_FAILED`
- `WORKFLOW_IDEMPOTENCY_CONFLICT`
- `RESOURCE_VERSION_CONFLICT`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_STARTED`, `WORKFLOW_WAITING`, `WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`, `WORKFLOW_CANCELLED`, `WORKFLOW_TERMINATED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Queue/Workers, Audit, Domain service actions, Event Bus/Outbox, Authorization.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Workflows-Business-Processes/workflow-executions.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Workflows-Business-Processes/workflow-executions.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** same Idempotency-Key returns one execution across retries
- **2.** second default concurrent execution same entity+definition rejected
- **3.** run remains pinned to initial published version across later publish
- **4.** worker crash after checkpoint resumes without duplicate node side effects
- **5.** parallel join completes only after configured branch condition
- **6.** stale execution expectedVersion returns conflict
- **7.** suspended execution has no node dispatch and resumes correctly
- **8.** unauthorized user cannot inspect sensitive variables or logs

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
