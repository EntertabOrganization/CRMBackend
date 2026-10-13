# Commerce Payments, Authorization, Capture and Disputes — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommercePaymentsController`, `CommerceDisputesController`  
**Source of truth / domain entities:** `payments; payment_attempts; commerce_order_payments; payment_provider_events; commerce_payment_disputes`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- payments: workspace_id,id,order_id,provider,provider_transaction_id?,amount,currency,status CREATED|PENDING|AUTHORIZED|PARTIALLY_CAPTURED|PAID|FAILED|VOIDED|PARTIALLY_REFUNDED|REFUNDED,authorized_amount,captured_amount,refunded_amount,version.
- commerce_order_payments: order_id,payment_id,allocated_amount; payment_attempts: provider_attempt_id,kind AUTHORIZE|CAPTURE|SALE|VOID,status.
- payment_provider_events: unique(provider,provider_event_id),signature_verified,payload_hash,processed_at,status.
- commerce_payment_disputes: workspace_id,payment_id,provider_dispute_id,status OPEN|EVIDENCE_REQUIRED|SUBMITTED|WON|LOST,opened_at,resolved_at.

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/commerce/orders/:orderId/payments` | `CommercePaymentsController` | `COMMERCE.PAYMENT_VIEW` | orderId | Allocated Payment ledger. |
| `POST` | `/api/v1/commerce/orders/:orderId/payments` | `CommercePaymentsController` | `COMMERCE.PAYMENT_MANAGE` | methodId,amount,mode SALE\|AUTHORIZE,Idempotency-Key | Payment attempt via shared provider adapter. |
| `POST` | `/api/v1/commerce/payments/:paymentId/capture` | `CommercePaymentsController` | `COMMERCE.PAYMENT_CAPTURE` | amount,Idempotency-Key | Capture up to remaining authorized amount. |
| `POST` | `/api/v1/commerce/payments/:paymentId/void` | `CommercePaymentsController` | `COMMERCE.PAYMENT_MANAGE` | reason,Idempotency-Key | Void uncaptured authorization. |
| `GET` | `/api/v1/commerce/payments/:paymentId` | `CommercePaymentsController` | `COMMERCE.PAYMENT_VIEW` | paymentId | State/attempts sanitized. |
| `POST` | `/api/v1/commerce/payment-providers/:providerCode/webhook` | `CommercePaymentsController` | `PROVIDER_SIGNED` | provider headers,raw verified body | Verify signature & dedupe, process asynchronously. |
| `GET` | `/api/v1/commerce/payment-disputes` | `CommerceDisputesController` | `COMMERCE.DISPUTE_VIEW` | page,limit,status | Authorized disputes. |
| `GET` | `/api/v1/commerce/payment-disputes/:disputeId` | `CommerceDisputesController` | `COMMERCE.DISPUTE_VIEW` | disputeId | State and evidence status, no card secrets. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. Reuse shared CRM/Commercial Payment service where possible. Payments, Refunds and Order separate; Order payment status derived from successful captured less refunded amounts.
2. Never treat browser redirect or return URL as confirmation. Provider webhook verified, persisted, deduped, state transitions monotonic/validated and reconciled with provider on uncertainty.
3. Store provider credentials only secure Integration Credential references. Never persist raw PAN/CVV; provider-hosted/tokenized checkout preferred.
4. Authorization and capture methods configurable by Store/method/provider; COD/cash may ship while UNPAID under explicit policy.
5. Multiple Payments per Order allowed. Captured/payment allocations cannot exceed actual settled amounts; duplicate capture/retry cannot capture twice.
6. Chargeback is separate financial dispute and does not imply physical Return; dispute webhook updates financial state with evidence history.

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

- `PAYMENT_NOT_FOUND`
- `PAYMENT_INVALID_STATE`
- `PAYMENT_CAPTURE_EXCEEDS_AUTHORIZATION`
- `PAYMENT_PROVIDER_SIGNATURE_INVALID`
- `PAYMENT_DUPLICATE_EVENT`
- `PAYMENT_PROVIDER_UNAVAILABLE`
- `PAYMENT_DISPUTE_INVALID`

## Durable domain events and global audit

- **Outbox events:** `PAYMENT_CREATED`, `PAYMENT_AUTHORIZED`, `ORDER_PAYMENT_UPDATED`, `ORDER_PAID`, `PAYMENT_FAILED`, `PAYMENT_DISPUTE_OPENED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

Shared Payment/Provider adapter, Credential store, CRM invoices/payments, Commerce Orders, Audit.

## Testing contract — executable and E2E

Matching files: `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/payments.spec.ts` and `tests/modules/SPA_Workflows_Inventory_Commerce/Online-Store-Commerce/payments.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** browser success redirect alone does not mark Payment PAID
- **2.** same provider event ID processed once despite retries
- **3.** same capture key captures once and cannot exceed authorized amount
- **4.** split 2000+8000 payments can satisfy 10000 Order
- **5.** failure in provider leaves visible recoverable pending/failed state
- **6.** raw card number/CVV never stored
- **7.** chargeback creates separate dispute not Return inventory movement
- **8.** cross-workspace Payment ID inaccessible

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
