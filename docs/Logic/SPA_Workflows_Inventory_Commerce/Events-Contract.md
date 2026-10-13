# Events, Outbox and Cross-module Ownership Contract

Transactional outbox event envelope:

```json
{"eventId":"uuid","eventType":"ORDER_CREATED","workspaceId":"uuid","aggregateType":"COMMERCE_ORDER","aggregateId":"uuid","schemaVersion":1,"occurredAt":"2026-10-12T09:00:00Z","actorType":"USER|SERVICE|PUBLIC_CUSTOMER","actorId":"uuid|null","correlationId":"uuid","payload":{"id":"uuid","status":"CREATED"}}
```

- Emit only after successful domain transaction and in the same transaction. Consumers dedupe by `eventId` or domain effect idempotency key. Outgoing webhooks are provided by shared Integrations; signed retry/backoff/dead-letter and endpoint secrets never implemented separately here.
- Payload contains minimal stable IDs and safe materialized details; avoid PII/secrets unless authorized subscribed integration contract requires and filters it. Schema versions explicitly advance on breaking event changes.
- Every event lists owning producer and possible consumers. This is not an instruction to call all consumers synchronously.

| Owner | Event examples | Consumers / effects |
|---|---|---|
| SPA | `SPA_TYPE_CREATED`, `SPA_SCHEMA_PUBLISHED`, `SPA_ITEM_CREATED`, `SPA_ITEM_UPDATED`, `SPA_ITEM_STAGE_CHANGED`, `SPA_RECURRING_ITEM_CREATED` | Automation/Workflow starts, Search schema/index, CRM Timeline, Notifications, Analytics |
| Workflow | `WORKFLOW_VERSION_PUBLISHED`, `WORKFLOW_STARTED`, `WORKFLOW_ASSIGNMENT_CREATED`, `WORKFLOW_COMPLETED`, `WORKFLOW_FAILED`, `WORKFLOW_COMPENSATION_FAILED` | Notification, Timeline, Alerts, Analytics, Integrations |
| Inventory | `INVENTORY_DOCUMENT_PROCESSED`, `STOCK_CHANGED`, `RESERVATION_CREATED`, `RESERVATION_EXPIRED`, `INVENTORY_LOW_STOCK`, `STOCKTAKE_POSTED` | Commerce availability, CRM, Procurement SPA/Workflows, Analytics, Notifications |
| Commerce | `CART_ABANDONED`, `ORDER_CREATED`, `ORDER_PAID`, `ORDER_CANCELLED`, `SHIPMENT_SHIPPED`, `RETURN_RECEIVED`, `REFUND_COMPLETED`, `PAYMENT_DISPUTE_OPENED` | CRM Deal binding, Workflow, Marketing consent, Notification, Analytics, Integrations |

**No circular synchronous calls:** Use clear service ownership and outbox events for downstream projections. Workflow domain adapters call the official SPA/Inventory/Commerce service, but not their repositories. Cart never directly modifies Product master or Inventory balance. Shipment never directly writes Inventory movement rows. SPA relation to Task/File/Calendar stores binding, not a cloned Task/File/Event.

**Failure contracts:** repeated events must not duplicate business outcome; provider 429/5xx job retry uses bounded exponential backoff; permission change invalidates search/cache authorizations; dead-letter visible in admin health. Do not deliver confidential tenant data across Workspace by mistakenly replaying event without workspace context.
