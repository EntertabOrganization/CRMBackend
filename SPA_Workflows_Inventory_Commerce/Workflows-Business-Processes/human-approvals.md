# Human Approvals, Information Requests and Delegation — Implementation Specification

**Scope:** Workflows & Business Processes  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `WorkflowAssignmentsController`  
**Source of truth / domain entities:** `workflow_human_assignments; workflow_approval_votes; workflow_delegations; workflow_escalation_rules`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- workflow_human_assignments: workspace_id,id,execution_id,node_run_id,assignment_type APPROVAL|REQUEST_INFO,status PENDING|COMPLETED|CANCELLED|EXPIRED,policy ANY|ALL|QUORUM,quorum_count?,due_at?,result_json.
- workflow_approval_votes: unique(assignment_id,assignee_user_id),decision APPROVE|REJECT|REQUEST_CHANGES,decided_at,comment,acted_by_user_id.
- workflow_delegations: assignment_id,from_user_id,to_user_id,actor_user_id,reason,created_at; escalation rules per node and time offset.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/workflow-assignments/my` | `WorkflowAssignmentsController` | `WORKFLOW.ASSIGNMENT_VIEW` | page,limit,status,dueBefore? | Assignment inbox scoped to effective participants. |
| `GET` | `/api/v1/workflow-assignments/:assignmentId` | `WorkflowAssignmentsController` | `WORKFLOW.ASSIGNMENT_VIEW` | assignmentId | Details redacted by bound-entity permissions. |
| `POST` | `/api/v1/workflow-assignments/:assignmentId/decide` | `WorkflowAssignmentsController` | `WORKFLOW.ASSIGNMENT_DECIDE` | decision,comment?,fields?,Idempotency-Key | Persist decision once; advance node when policy satisfied. |
| `POST` | `/api/v1/workflow-assignments/:assignmentId/delegate` | `WorkflowAssignmentsController` | `WORKFLOW.ASSIGNMENT_DELEGATE` | toUserId,reason | Audit delegation; old assignee cannot decide unless also explicitly authorized. |
| `POST` | `/api/v1/workflow-assignments/:assignmentId/submit-information` | `WorkflowAssignmentsController` | `WORKFLOW.ASSIGNMENT_DECIDE` | values,Idempotency-Key | Validate requested typed input and unblock node. |
| `GET` | `/api/v1/workflow-assignments/:assignmentId/history` | `WorkflowAssignmentsController` | `WORKFLOW.ASSIGNMENT_VIEW` | page,limit | Decisions, delegation and escalation audit. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. ANY satisfies on first valid approval, ALL requires every required approval, QUORUM requires specified distinct valid approvals. Reject-vote behavior is configured explicitly per node (default any reject sends reject edge).
2. One participant one final vote; duplicate request returns prior result with idempotency key; concurrent votes use locks.
3. Only active original/delegated assignee or authorized assignment admin can decide; entity visibility and Workspace rules still apply.
4. Default timeout escalates/timeout branch rather than silently approves; configurable REMIND,ESCALATE,DELEGATE,AUTO_REJECT,AUTO_APPROVE,TIMEOUT_BRANCH if expressly published.
5. Cancelled/expired assignment cannot receive decisions; reassign and escalation logged with original and actual actor.
6. Approvals are durable DB records, not ephemeral notifications; resume exactly once via outbox/worker.

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

- `WORKFLOW_ASSIGNMENT_NOT_FOUND`
- `WORKFLOW_ASSIGNMENT_CLOSED`
- `WORKFLOW_APPROVAL_DUPLICATE`
- `WORKFLOW_APPROVAL_POLICY_INVALID`
- `WORKFLOW_DELEGATE_INVALID`
- `PERMISSION_DENIED`

## Durable domain events and global audit

- **Outbox events:** `WORKFLOW_ASSIGNMENT_CREATED`, `WORKFLOW_ASSIGNMENT_DECIDED`, `WORKFLOW_ASSIGNMENT_DELEGATED`, `WORKFLOW_ASSIGNMENT_ESCALATED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Users/Departments, Calendar/business time, Notifications, Outbox.

## Testing contract — executable and E2E

Matching files: `Testing/Workflows-Business-Processes/human-approvals.spec.ts` and `Testing/Workflows-Business-Processes/human-approvals.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** ALL approval waits for last approver before advancing
- **2.** ANY accepts first authorized distinct approval only
- **3.** QUORUM 2-of-3 advances once after second vote
- **4.** reject route follows declared rejection edge
- **5.** concurrent duplicate vote does not double advance workflow
- **6.** delegated old actor denied if no remaining authorization
- **7.** default timeout escalates without auto-approval
- **8.** suspended execution does not allow accidental completion

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
