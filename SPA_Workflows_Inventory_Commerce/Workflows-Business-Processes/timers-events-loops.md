# Durable Timers, Events, Parallelism and Bounded Loops — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowTriggersController`, `WorkflowRuntimePolicyController`  
**Source of truth / domain entities:** `workflow_timers; workflow_event_subscriptions; workflow_schedules; workflow_runtime_limits; workflow_parallel_joins`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_timers: workspace_id,execution_id,node_run_id,type ABSOLUTE|RELATIVE|WORKDAY_AWARE,scheduled_for,status PENDING|FIRED|CANCELLED|PAUSED,remaining_seconds,unique_resume_key.
- workflow_event_subscriptions: workspace_id,execution_id,node_run_id,event_type,correlation_key,status PENDING|FULFILLED|CANCELLED,expires_at; unique(execution_id,node_run_id,event_type,correlation_key).
- workflow_parallel_joins: workspace_id,execution_id,join_node_key,join_mode ALL|ANY|QUORUM|required_count,completed_branch_tokens; constraints protect duplicate token accounting.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflows/:workflowId/triggers` | `WorkflowTriggersController` | `WORKFLOW.VIEW` | workflowId | Configured manual/event/schedule triggers. |
| `PUT` | `/api/v1/workflows/:workflowId/triggers` | `WorkflowTriggersController` | `WORKFLOW.DESIGN` | expectedVersion,triggers[] | Draft/activate with validation; live changes versioned. |
| `GET` | `/api/v1/workflow-executions/:executionId/waits` | `WorkflowTriggersController` | `WORKFLOW.EXECUTION_VIEW` | executionId | Pending timers/events and due dates. |
| `GET` | `/api/v1/workflows/runtime-limits` | `WorkflowRuntimePolicyController` | `WORKFLOW.RUNTIME_MANAGE` | workspace | Effective limits and feature entitlement. |
| `PUT` | `/api/v1/workflows/runtime-limits` | `WorkflowRuntimePolicyController` | `WORKFLOW.RUNTIME_MANAGE` | maxLoopIterations,maxNodeRuns,maxDepth,maxLifetimeDays | Can lower but never exceed platform-safe ceiling. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Default maxLoopIterations=1000,maxNodeRuns=10000,maxSubworkflowDepth=10,maxExecutionLifetimeDays=365; workspace/plan can lower; platform global ceiling remains absolute.
2. Absolute timestamps stored as timestamptz; workday-aware timers resolve Calendar business days using IANA timezone.
3. Timer firing and event correlation use deterministic persisted idempotency keys; two queue workers must not resume same wait twice.
4. Parallel joins ALL/ANY/QUORUM must have explicit required branches; EVENT_RACE cancels losing wait subscriptions after winner commits.
5. Loop body creates persisted iteration index and rejects maxIterations exhausted; detect repeated recursion and runaway rapid loops.
6. Suspension freezes internal relative/workday timers, resume preserves remaining duration; absolute wall-clock deadline policy explicit.

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

- `WORKFLOW_TIMER_NOT_FOUND`
- `WORKFLOW_EVENT_CORRELATION_MISMATCH`
- `WORKFLOW_LOOP_LIMIT_EXCEEDED`
- `WORKFLOW_RUNTIME_LIMIT_EXCEEDED`
- `WORKFLOW_JOIN_INVALID`
- `WORKFLOW_SCHEDULE_INVALID`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_TIMER_FIRED`, `WORKFLOW_WAIT_RESUMED`, `WORKFLOW_EXECUTION_TIMED_OUT` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Jobs/Queues, Calendar business time, Event Bus, Entitlements.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/timers-events-loops.spec.ts` and `Testing/Workflows-Business-Processes/timers-events-loops.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** same timer tick delivered twice unblocks node once
- **2.** unrelated event correlation key does not resume workflow
- **3.** parallel ALL join does not proceed early
- **4.** EVENT_RACE winner cancels losing branches
- **5.** nested FOR_EACH/WHILE stop at safety limit
- **6.** runtime configuration refuses exceeding platform ceilings
- **7.** suspend relative timer preserves remaining duration across restart
- **8.** DST and business-day waits do not depend on server timezone

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
