# Commerce CRM/Inventory Integration, Cart Abandonment and Events — Implementation Specification

**Scope:** Online Store & Commerce  
**Phase:** CORE (Phase 2 boundaries described in rules where relevant)  
**Controllers:** `CommerceIntegrationsController`  
**Source of truth / domain entities:** `commerce_crm_bindings; commerce_order_reservation_bindings; commerce_abandoned_cart_jobs; commerce_provider_sync_states`

## Goal and responsibilities

Implement this domain boundary as a complete, transactionally reliable NestJS vertical slice. The controllers listed here own these REST operations; application services own business rules, while shared platform services own Auth, Audit, Search, Jobs, and Webhook delivery. Do not create a second domain record in another module merely to display a relation/projection.

## Entity, fields, relationships and enums

- commerce_crm_bindings: workspace_id,order_id,crm_contact_id?,crm_company_id?,crm_deal_id?,link_policy,link_status PENDING|LINKED|FAILED,last_error_code; unique(order_id,linked_type).
- commerce_order_reservation_bindings: workspace_id,order_id,order_line_id,reservation_id,status; unique(order_line_id,reservation_id).
- commerce_abandoned_cart_jobs: workspace_id,cart_id,eligible_at,emitted_at?,status; unique(cart_id,inactivity_epoch).

All business rows carry `workspace_id` directly (or validated through strong parent FK). FK pairs must enforce the same Workspace even if IDs are valid. IDs UUID. Use timezone-aware instants, `NUMERIC` quantities/money and explicit unique indexes. Entity names below are logical contracts: use the repository ORM naming mapping without changing required behavior.

## REST endpoint inventory and request/effect contracts

| Method | Path | Controller | Permission | Request / Query | Outcome / Effects |
|---|---|---|---|---|---|
| `GET` | `/api/v1/commerce/orders/:orderId/integrations` | `CommerceIntegrationsController` | `COMMERCE.ORDER_VIEW` | orderId | CRM bindings/Reservation/automation status. |
| `POST` | `/api/v1/commerce/orders/:orderId/crm-sync` | `CommerceIntegrationsController` | `COMMERCE.ORDER_MANAGE` | Idempotency-Key | Reconcile Contact/Company/Deal binding using safe resolver. |
| `GET` | `/api/v1/commerce/stores/:storeId/automation-settings` | `CommerceIntegrationsController` | `COMMERCE.STORE_MANAGE` | storeId | Abandoned period/default Deal policy. |
| `PATCH` | `/api/v1/commerce/stores/:storeId/automation-settings` | `CommerceIntegrationsController` | `COMMERCE.STORE_MANAGE` | expectedVersion,abandonedAfterMinutes?,dealCreationPolicy? | Update future events without rewriting prior orders. |
| `POST` | `/api/v1/commerce/orders/:orderId/reconcile` | `CommerceIntegrationsController` | `COMMERCE.ORDER_MANAGE` | Idempotency-Key | Queue cross-domain consistency check; return 202 jobId. |
| `GET` | `/api/v1/commerce/reconciliation-jobs/:jobId` | `CommerceIntegrationsController` | `COMMERCE.ORDER_MANAGE` | jobId | Observable stock/payment/deal mismatches. |

For a creation payload, the listed business fields are the accepted fields; server-populated `workspaceId`, actor, timestamps and sequence numbers are never accepted from callers. See `API-Contracts.md` for validation, response envelopes, pagination, error mapping, idempotency keys and concurrency. Every endpoint must have an OpenAPI operation and verified controller mapping.

## Workflows, state transitions and business rules

1. CRM linking uses shared duplicate resolver, not customer name; default Store dealCreationPolicy ALWAYS but configurable to NEVER/ONLY_NEW_CUSTOMER/MANUAL_REVIEW.
2. Order remains source of commercial purchase facts; Deal supports sales lifecycle; CRM sync failure visible/retryable, does not erase Order.
3. Inventory reservations source ORDER with stable Order Line correlation. Payment, Fulfillment and stock balances reconciled through owning services, no direct cross-domain table rewrites.
4. Cart abandonment default inactivity 120 minutes, Store-configurable; emit CART_ABANDONED once for each distinct inactivity epoch. Marketing reminders require explicit consent/suppression checks by Marketing module.
5. Commerce emits durable outbox domain events for Workflow/Automation/Notifications/Analytics; each consumer idempotent on event ID.

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

- `COMMERCE_CRM_SYNC_FAILED`
- `COMMERCE_RESERVATION_BINDING_INVALID`
- `COMMERCE_RECONCILIATION_FAILED`
- `COMMERCE_AUTOMATION_POLICY_INVALID`

## Durable domain events and global audit

- **Outbox events:** `ORDER_CRM_LINKED`, `ORDER_RESERVATION_CHANGED`, `CART_ABANDONED`, `ORDER_RECONCILIATION_COMPLETED` .
- Outbox data uses common event envelope, generated after domain validation but within same DB commit. Integration webhook, Search, Notifications, Analytics and Workflow consumers handle events idempotently.
- **Central Audit:** record security/configuration/ownership/public access/critical financial/ledger changes; immutable domain histories store routine high-volume row/node/movement evidence. Preserve causation actor and initiating principal.

## Dependencies and integrations

CRM Resolver/Deals, Inventory Reservations, Marketing Consent, Automation/Workflow, Jobs.

## Testing contract — executable and E2E

Matching files: `Testing/Online-Store-Commerce/crm-inventory-automation.spec.ts` and `Testing/Online-Store-Commerce/crm-inventory-automation.e2e-spec.ts`. Start by replacing fail-closed `contract()` calls with real fixture setup/API/service calls; do not skip tests. The following cases are required, along with common auth, tenant and idempotency tests for every operation:

- **1.** Deal policy ALWAYS creates exactly one Deal binding per Order
- **2.** NEVER policy does not create Deals
- **3.** retriable CRM error leaves Order committed and sync status FAILED
- **4.** reconciliation reports mismatch without rewriting ledgers
- **5.** CART_ABANDONED emitted once after 2h default inactivity
- **6.** cart becomes active again creates new inactivity epoch without duplicate old event
- **7.** marketing notification suppressed when no consent
- **8.** cross-workspace source binding rejected

## Acceptance criteria / definition of done

1. Every operation in this specification is implemented with its exact authorization, DTO validation, domain semantics, errors and response shape.
2. Required database constraints/indexes/migrations run on a clean test database and against representative prior version migration; no destructive silent schema rewrite.
3. All listed unit scenarios and real HTTP E2E tests pass with meaningful assertions; no hidden skips/placeholders. Negative tenant/permission tests and race/retry tests are mandatory.
4. Immutable history, permitted repairs, audit and outbox effects match specified transitions, including rollback and worker/provider failure scenarios.
5. Relevant frontend state/actions use shared components and API contracts without inventing permission shortcuts; Phase 2 is explicitly not claimed complete.
