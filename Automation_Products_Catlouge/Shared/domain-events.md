# Domain Events, Outbox & Realtime

## Envelope

Use existing platform event envelope. Required semantics include:

- unique `eventId`;
- `eventType`;
- `workspaceId`;
- source/entity type + ID;
- `occurredAt`;
- actor/origin;
- correlation ID;
- causation ID where available;
- Automation depth where applicable;
- safe minimal payload/change summary.

Do not place whole ORM rows or secrets in events.

## Automation events

Expected events include repository-equivalent:

```text
AUTOMATION_RULE_PUBLISHED
AUTOMATION_RULE_STATE_CHANGED
AUTOMATION_EXECUTION_STARTED
AUTOMATION_EXECUTION_SUCCEEDED
AUTOMATION_EXECUTION_FAILED
AUTOMATION_EXECUTION_SKIPPED
AUTOMATION_ACTION_FAILED
AUTOMATION_LOOP_BLOCKED
```

Operational execution events may be internal-only if high volume; publish only what consumers need while keeping logs durable.

## Catalog events

Expected:

```text
CATALOG_CREATED/UPDATED/DEFAULT_CHANGED
CATEGORY_CHANGED
PRODUCT_CREATED/UPDATED/ARCHIVED/REACTIVATED
VARIANT_CREATED/UPDATED/ARCHIVED
PRODUCT_PRICE_CHANGED
PRICE_TYPE_CHANGED
PRODUCT_ROW_CHANGED
```

Search/Analytics consume these projections.

## Event -> Automation flow

Source domain commits business state + outbox event.

Automation consumer receives event idempotently and creates matching execution/job records.

Automation action calls owner service. Owner service commits its own domain event.

That new event may trigger more Automation Rules, carrying correlation/depth metadata.

Do not execute Automation Rules inside the original domain transaction.

## Realtime

Use shared realtime to refresh:

- Rule status/configuration revisions;
- Automation execution/job status;
- Product/Catalog changes where UI benefits;
- Product Row changes on open CRM records.

Realtime is non-authoritative. Page reload/API read recovers all durable state.

## Idempotent consumers

Consumers record/process each event once according to shared platform mechanism. Duplicate outbox delivery cannot create duplicate Automation executions or search rows.
