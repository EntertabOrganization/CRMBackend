# Domain Events, Outbox and Realtime Contract

## Event envelope

Important events use a stable envelope. Adapt exact naming to platform event bus while preserving content semantics.

```json
{
  "eventId": "uuid",
  "eventType": "ACTIVITY_COMPLETED",
  "eventVersion": 1,
  "workspaceId": "uuid",
  "aggregateType": "ACTIVITY",
  "aggregateId": "uuid",
  "actor": {
    "type": "USER",
    "userId": "uuid"
  },
  "occurredAt": "2026-09-23T20:00:00Z",
  "correlationId": "uuid",
  "causationId": "uuid-or-null",
  "idempotencyKey": "safe-key-or-null",
  "changes": {}
}
```

Events carry a safe change summary, not an entire business record.

Consumers requiring authoritative current state query the owning service/read API when necessary.

## Transactional outbox

For important mutations:

```text
domain state + outbox row
```

commit in one PostgreSQL transaction.

Workers publish after commit.

Never publish a success event before the business transaction commits.

## Custom-field events

At minimum semantic events:

```text
CUSTOM_FIELD_CHANGED
FIELD_SCHEMA_CHANGED
FIELD_REQUIREMENT_CHANGED
CUSTOM_FIELD_MIGRATION_COMPLETED
```

Recommended payload fields:

```text
workspaceId
entityType
fieldId/ruleId
schemaVersion
changeKind
```

Do not include all field values.

Consumers:

- Realtime schema refresh;
- Search mapping/reindex;
- Forms/Import/Automation metadata cache invalidation;
- Analytics metadata where applicable.

## Activity events

At minimum:

```text
ACTIVITY_CREATED
ACTIVITY_UPDATED
ACTIVITY_REASSIGNED
ACTIVITY_COMPLETED
ACTIVITY_CANCELLED
ACTIVITY_REOPENED
ACTIVITY_DELETED
ACTIVITY_RESTORED
ACTIVITY_OVERDUE
ACTIVITY_BINDING_CHANGED
ACTIVITY_REMINDER_DUE
```

Timeline projects only meaningful events according to its policy.

## Timeline events

```text
TIMELINE_ENTRY_PROJECTED
TIMELINE_COMMENT_CREATED
TIMELINE_COMMENT_UPDATED
TIMELINE_COMMENT_DELETED
TIMELINE_COMMENT_MENTIONED
```

Avoid loops: `TIMELINE_ENTRY_PROJECTED` must not cause the same source domain event to be re-created.

## Correlation and causation

Preserve correlation ID across:

```text
HTTP request
→ domain transaction
→ outbox
→ Timeline projection
→ Notification/realtime/automation
```

Use causation ID to trace event chains where platform supports it.

## Realtime messages

Realtime payloads are small invalidation/update hints, for example:

```json
{
  "type": "ACTIVITY_UPDATED",
  "workspaceId": "uuid",
  "activityId": "uuid",
  "version": 8
}
```

or:

```json
{
  "type": "FIELD_SCHEMA_CHANGED",
  "entityType": "DEAL",
  "schemaVersion": 19
}
```

Do not push full sensitive records blindly over realtime channels.

## Realtime authorization

- subscription/session must be authorized for workspace;
- server must not send restricted entity identifiers/content to unauthorized clients;
- client treats event as a signal to update/refetch;
- page reload/query remains authoritative.

## Client dedupe

Frontend stores/query cache dedupes using resource ID + version/event ID.

Optimistic UI + realtime + refetch must not create duplicate Timeline comments/entries/Activity cards.

## Timeline projector dedupe

Projection handler writes with a unique source identity.

On unique conflict from duplicate event delivery:

- treat as successful idempotent replay if payload/version matches expected source;
- do not create a second entry;
- log inconsistent duplicate source events for investigation.

## Delayed/stale events

Consumers must handle out-of-order updates.

For mutable resource updates, version-aware consumers ignore older versions when appropriate.

Timeline chronological order uses `occurredAt`, not queue delivery time.

## Automation integration

Activity events are valid Automation triggers. Automation writes back through normal domain services and therefore re-run permissions/service policy, validation and idempotency/loop controls owned by Automation.

The Activities module must not execute automation rules inline inside its transaction.
