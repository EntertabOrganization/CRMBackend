# Returns, Disposition, Refunds and Financial Approval — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommerceReturnsController`, `CommerceRefundsController`  
**Source of truth / domain entities:** `commerce_returns; commerce_return_lines; commerce_return_events; refunds; commerce_refund_approvals`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_returns: workspace_id,id,order_id,status REQUESTED|APPROVED|REJECTED|IN_TRANSIT|RECEIVED|INSPECTING|COMPLETED|CANCELLED,reason,requested_at,approved_by?,received_at?,version.
- commerce_return_lines: workspace_id,return_id,order_line_id,quantity,disposition SELLABLE|DAMAGED|REPAIR|REJECT?,received_qty,inventory_return_document_line_id?; sum returns <= delivered/unreturned qty.
- refunds: workspace_id,id,order_id,payment_id?,return_id?,amount,currency,status REQUESTED|PENDING_APPROVAL|APPROVED|PROCESSING|SUCCEEDED|FAILED|CANCELLED,provider_refund_id?,version.
- commerce_refund_approvals: refund_id,threshold_policy_snapshot,requested_by,approved_by,decision,reason,decided_at.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `POST` | `/api/v1/commerce/orders/:orderId/returns` | `CommerceReturnsController` | `COMMERCE.RETURN_CREATE` | items[{orderLineId,quantity}],reason,Idempotency-Key | Validate delivered quantities and policy. |
| `GET` | `/api/v1/commerce/returns` | `CommerceReturnsController` | `COMMERCE.RETURN_VIEW` | page,limit,status,storeId | Authorized return queue. |
| `GET` | `/api/v1/commerce/returns/:returnId` | `CommerceReturnsController` | `COMMERCE.RETURN_VIEW` | returnId | Return lines/disposition/history. |
| `POST` | `/api/v1/commerce/returns/:returnId/approve` | `CommerceReturnsController` | `COMMERCE.RETURN_APPROVE` | expectedVersion,decision,reason? | Approve/reject per policy. |
| `POST` | `/api/v1/commerce/returns/:returnId/receive` | `CommerceReturnsController` | `COMMERCE.RETURN_RECEIVE` | receivedLines,Idempotency-Key | Record physical receipt pending inspection. |
| `POST` | `/api/v1/commerce/returns/:returnId/inspect` | `CommerceReturnsController` | `COMMERCE.RETURN_INSPECT` | dispositions[],Idempotency-Key | Process correct Inventory return/segregation document. |
| `POST` | `/api/v1/commerce/orders/:orderId/refunds` | `CommerceRefundsController` | `COMMERCE.REFUND_CREATE` | paymentId,amount,reason,returnId?,Idempotency-Key | Create financial refund request, independent of Return. |
| `POST` | `/api/v1/commerce/refunds/:refundId/approve` | `CommerceRefundsController` | `COMMERCE.REFUND_APPROVE` | expectedVersion,decision,reason | Financial approval based on threshold. |
| `POST` | `/api/v1/commerce/refunds/:refundId/process` | `CommerceRefundsController` | `COMMERCE.REFUND_PROCESS` | expectedVersion,Idempotency-Key | Provider refund with idempotency and reconciled state. |
| `GET` | `/api/v1/commerce/refunds/:refundId` | `CommerceRefundsController` | `COMMERCE.REFUND_VIEW` | refundId | Approved amount/provider transaction, sanitized. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Return means physical merchandise state, Refund means money state; neither automatically proves the other.
2. Only shipped/delivered eligible quantities returnable; cumulative returns per line <= fulfilled quantity minus already returned, with transactional guard.
3. Receive/inspect disposition controls Inventory return movement; SELLABLE returns to sellable location, DAMAGED/REPAIR to quarantine/appropriate non-sellable state, REJECT does not add sellable stock.
4. Refund can be partial, and may occur with or without physical Return under permitted policy; total successful+pending refund <= net refundable captured Payment amount.
5. REFUND_CREATE and REFUND_APPROVE distinct permissions with configurable threshold; default requires explicit financial authorization according to policy.
6. Provider refund ID/idempotency prevents duplicate money transfer; callback may be delayed, never mark success solely from browser/manual request.
7. After shipment, order cancellation is disallowed; Return/Refund workflows are used instead.

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

- `RETURN_NOT_FOUND`
- `RETURN_NOT_ELIGIBLE`
- `RETURN_QUANTITY_EXCEEDED`
- `RETURN_INVALID_TRANSITION`
- `REFUND_NOT_FOUND`
- `REFUND_AMOUNT_EXCEEDED`
- `REFUND_APPROVAL_REQUIRED`
- `REFUND_PROVIDER_FAILURE`

## Durable domain events and global audit

- **Outbox events:** `RETURN_REQUESTED`, `RETURN_APPROVED`, `RETURN_RECEIVED`, `RETURN_COMPLETED`, `REFUND_REQUESTED`, `REFUND_APPROVED`, `REFUND_COMPLETED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Inventory Returns, Payment/Provider, Shared Approval Workflow, Audit/Outbox.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/returns-refunds.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/returns-refunds.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** return requested quantity cannot exceed delivered minus already returned
- **2.** received damaged unit not added to sellable stock
- **3.** returned units create correct Inventory return document exactly once
- **4.** partial refund does not modify original Payment amount
- **5.** refund above captured available amount rejected
- **6.** same provider refund webhook/retry does not duplicate money refund
- **7.** creator without REFUND_APPROVE cannot self-approve above threshold
- **8.** refund success can exist without physical Return only under allowed policy

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
