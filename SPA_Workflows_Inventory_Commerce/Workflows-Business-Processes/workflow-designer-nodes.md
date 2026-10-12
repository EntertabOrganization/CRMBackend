# Workflow Graph, Designer and Safe Expressions — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowGraphController`  
**Source of truth / domain entities:** `workflow_nodes; workflow_edges; workflow_variable_definitions; workflow_constant_definitions; workflow_global_constants`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_nodes: workspace_id,version_id,id,node_key,type,configuration_json,position_x,position_y; unique(version_id,node_key).
- workflow_edges: workspace_id,version_id,id,from_node_id,to_node_id,edge_type,condition_json,sort_order.
- variables/parameters/constants: code,datatype TEXT|NUMBER|MONEY|BOOLEAN|DATE|DATETIME|USER|ENTITY_REF|JSON_TYPED,typed_validation_json; secrets are connection references only.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflows/:workflowId/versions/:versionId/graph` | `WorkflowGraphController` | `WORKFLOW.VIEW` | versionId | Nodes, edges, parameter schema. |
| `PUT` | `/api/v1/workflows/:workflowId/versions/:versionId/graph` | `WorkflowGraphController` | `WORKFLOW.DESIGN` | expectedVersion,nodes[],edges[],variables[],constants[] | Replace complete DRAFT graph. |
| `POST` | `/api/v1/workflows/:workflowId/versions/:versionId/graph/nodes` | `WorkflowGraphController` | `WORKFLOW.DESIGN` | nodeKey,nodeType,config,position | Add allowed typed node. |
| `PATCH` | `/api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId` | `WorkflowGraphController` | `WORKFLOW.DESIGN` | expectedVersion,config?,position? | Change draft node. |
| `DELETE` | `/api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId` | `WorkflowGraphController` | `WORKFLOW.DESIGN` | nodeId | Delete draft node and affected edges safely. |
| `POST` | `/api/v1/workflows/:workflowId/versions/:versionId/graph/edges` | `WorkflowGraphController` | `WORKFLOW.DESIGN` | fromNodeId,toNodeId,edgeType,condition? | Add valid edge within version. |
| `POST` | `/api/v1/workflows/:workflowId/versions/:versionId/graph/preview` | `WorkflowGraphController` | `WORKFLOW.DESIGN` | testParameters,testContext | Dry-run deterministic expressions only; no side effects. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Supported V1 node kinds: START,END,ACTION,CONDITION,SWITCH,PARALLEL_SPLIT,PARALLEL_JOIN,EVENT_RACE,WAIT_EVENT,TIMER,WHILE,FOR_EACH,SET_VARIABLE,APPROVAL,REQUEST_INFO,CREATE_TASK,CREATE_ENTITY,UPDATE_ENTITY,CHANGE_STAGE,SEND_NOTIFICATION,GENERATE_DOCUMENT,HTTP_REQUEST,OUTBOUND_WEBHOOK,SUB_WORKFLOW,TERMINATE.
2. Nodes and edges of one graph must share Workspace and draft version; START single, END reachable for finite branches; every split/join/race references explicit matching semantics.
3. Cycle allowed only through explicit bounded loop construct with maxIterations; arbitrary back-edge cycles rejected.
4. Expressions use sandboxed parser with arithmetic, booleans, strings, dates, field references and node outputs; no eval/JS/python/shell/SQL/filesystem/network.
5. HTTP configuration references secure Integration connection ID, allowlisted protocols and destination SSRF guards including DNS rebinding, private/link-local/metadata addresses and redirect validation.
6. Publish validator checks graph limits, variable types, branch conditions, approvals, node settings and missing references; graph dry run cannot perform external effects.

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

- `WORKFLOW_NODE_INVALID`
- `WORKFLOW_EDGE_INVALID`
- `WORKFLOW_GRAPH_CYCLE`
- `WORKFLOW_UNSAFE_EXPRESSION`
- `WORKFLOW_HTTP_DESTINATION_BLOCKED`
- `WORKFLOW_PUBLISHED_IMMUTABLE`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_DRAFT_GRAPH_UPDATED`, `WORKFLOW_GRAPH_VALIDATED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Integration credential store, Safe Expression Engine, Permissions, Event registry.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/workflow-designer-nodes.spec.ts` and `Testing/Workflows-Business-Processes/workflow-designer-nodes.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** graph replacement rejects unknown node types and cross-version edges
- **2.** arbitrary cycles without bounded loop rejected
- **3.** expression cannot execute arbitrary code, SQL or filesystem access
- **4.** HTTP_REQUEST rejects loopback/private/metadata address and redirect bypass
- **5.** publish validator rejects no START or dead-end branch
- **6.** preview mode never sends notifications/HTTP or writes business records
- **7.** immutable published version graph cannot change

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
