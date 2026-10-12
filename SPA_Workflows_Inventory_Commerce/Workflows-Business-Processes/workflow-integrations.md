# Workflow Domain Actions, HTTP/Webhooks and Secrets — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowActionsController`  
**Source of truth / domain entities:** `workflow_action_registry; workflow_action_connections; workflow_external_callbacks; workflow_action_invocations`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_action_registry: action_code,allowed_input_schema,required_permission,side_effect_class,timeout_policy,retry_policy; immutable platform-defined registry.
- workflow_action_invocations: workspace_id,execution_id,node_run_id,action_code,request_hash,idempotency_key,status,domain_result_ref; unique(node_run_id,action_code,idempotency_key).
- workflow_external_callbacks: workspace_id,execution_id,node_run_id,correlation_token_hash,expires_at,received_at,payload_hash,status.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflows/actions` | `WorkflowActionsController` | `WORKFLOW.DESIGN` | search,domain | Safe supported action descriptors and input schemas. |
| `POST` | `/api/v1/workflows/:workflowId/actions/:actionCode/validate` | `WorkflowActionsController` | `WORKFLOW.DESIGN` | versionId,nodeKey,config | Validate configured action against registry/permissions, no execution. |
| `POST` | `/api/v1/workflows/callbacks/:token` | `WorkflowActionsController` | `PUBLIC_SCOPED` | signed callback payload | Verify signature/nonce/expiry/correlation and resume matching wait once. |
| `GET` | `/api/v1/workflow-executions/:executionId/actions` | `WorkflowActionsController` | `WORKFLOW.EXECUTION_VIEW` | page,limit | Redacted integration action records. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Supported action adapters call owning services: CRM/SPA create/update/stage; Task creation; Calendar event; File/Document generation; Notification/Chat; Inventory reservation; Commerce Order/Payment; HTTP_REQUEST/OUTBOUND_WEBHOOK; no direct cross-module SQL.
2. HTTP nodes use stored Integration connection ID, no raw secrets in config/output; provider retries backoff on 429/5xx/network and not arbitrary 4xx.
3. SSRF protection checks initial and redirect destinations after DNS resolution, rejects loopback/private/link-local/metadata routes, and applies allowlist policy.
4. Callbacks require signed token/correlation bound to exact workspace+execution+node, high entropy, expiry and replay protection; never infer tenant from client payload.
5. Each node uses explicit STARTER or approved scoped SERVICE_ACCOUNT execution identity and rechecks source/target entity authorizations when action fires.

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

- `WORKFLOW_ACTION_NOT_ALLOWED`
- `WORKFLOW_HTTP_DESTINATION_BLOCKED`
- `WORKFLOW_CONNECTION_NOT_FOUND`
- `WORKFLOW_CALLBACK_EXPIRED`
- `WORKFLOW_CALLBACK_REPLAY`
- `WORKFLOW_DOMAIN_PERMISSION_DENIED`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_ACTION_COMPLETED`, `WORKFLOW_EXTERNAL_CALLBACK_RECEIVED`, `WORKFLOW_ACTION_FAILED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Integration Credentials, Domain service APIs, Audit/Outbox, Rate Limit.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/workflow-integrations.spec.ts` and `Testing/Workflows-Business-Processes/workflow-integrations.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** workflow action cannot modify SPA field starter cannot edit
- **2.** HTTP node cannot reach 127.0.0.1 or cloud metadata services
- **3.** workflow configuration never serializes plaintext integration secret
- **4.** unauthorized callback or replay cannot resume node
- **5.** successful callback resumes correct waiting execution once
- **6.** HTTP provider 429 retries according bounded policy and does not double-write
- **7.** same node retry reuses idempotency effect key

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
