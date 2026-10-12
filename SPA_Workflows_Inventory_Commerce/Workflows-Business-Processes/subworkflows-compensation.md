# Subworkflows, Error Routing and Saga Compensation — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowCompensationController`  
**Source of truth / domain entities:** `workflow_child_executions; workflow_compensation_actions; workflow_entity_locks; workflow_error_routes`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_compensation_actions: workspace_id,execution_id,node_run_id,action_type,configuration_json,status PENDING|RUNNING|SUCCEEDED|FAILED,attempt_count,idempotency_key,executed_at.
- workflow_entity_locks: unique(workspace_id,entity_type,entity_id,lock_scope),execution_id,expires_at,leased_by.
- workflow_child_executions: parent_execution_id,child_execution_id,wait_for_completion,result_mapping_json; ancestry index detects recursion.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflow-executions/:executionId/children` | `WorkflowCompensationController` | `WORKFLOW.EXECUTION_VIEW` | executionId | Child Workflow instances, result status. |
| `GET` | `/api/v1/workflow-executions/:executionId/compensations` | `WorkflowCompensationController` | `WORKFLOW.EXECUTION_VIEW` | executionId | Planned/completed compensation history. |
| `POST` | `/api/v1/workflow-executions/:executionId/compensate` | `WorkflowCompensationController` | `WORKFLOW.EXECUTION_ADMIN` | reason,Idempotency-Key | Execute only declared compensation stack with safety checks. |
| `POST` | `/api/v1/workflow-executions/:executionId/compensations/:actionId/retry` | `WorkflowCompensationController` | `WORKFLOW.EXECUTION_ADMIN` | Idempotency-Key | Retry safe failed compensation idempotently. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. SUB_WORKFLOW node requires target definition in same Workspace, eligible published version, explicit input/output mapping and recursion-depth check.
2. Parent may wait or continue according to node.waitForCompletion; waiting parent resumes exactly once after child terminal status and mapped output.
3. Compensation is explicit, never inferred from arbitrary HTTP side effects. Side effects across provider/Inventory/Payment domains use Saga, not fictitious distributed transaction.
4. On cancellation, stop unscheduled actions, invalidate waits, then run configured compensation in declared reverse dependency order; partial compensation failure remains visible and retryable.
5. Compensation idempotency keys stable across retry; never double-refund or double-release reservation.
6. Entity lock may restrict concurrent Workflow actions, not silently block human editing unless explicitly configured.

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

- `WORKFLOW_RECURSION_LIMIT`
- `WORKFLOW_CHILD_INVALID`
- `WORKFLOW_COMPENSATION_UNDEFINED`
- `WORKFLOW_COMPENSATION_FAILED`
- `WORKFLOW_ENTITY_LOCKED`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_CHILD_STARTED`, `WORKFLOW_COMPENSATION_STARTED`, `WORKFLOW_COMPENSATION_COMPLETED`, `WORKFLOW_COMPENSATION_FAILED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Inventory, Payments, Integration providers, Jobs, Audit.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/subworkflows-compensation.spec.ts` and `Testing/Workflows-Business-Processes/subworkflows-compensation.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** A->B->A recursion rejected at configured depth/ancestry
- **2.** parent wait child completion maps result correctly
- **3.** nonwaiting parent does not block on child
- **4.** cancellation compensates reserved stock exactly once
- **5.** failed refund compensation retains retryable failure evidence
- **6.** compensation without declared inverse action is rejected
- **7.** simulated provider timeout cannot double-send refund on retry

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
