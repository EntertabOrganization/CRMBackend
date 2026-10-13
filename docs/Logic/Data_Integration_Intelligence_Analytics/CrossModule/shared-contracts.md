# Cross-Module Shared Contracts

## Goal

Define the required interaction boundaries among Data Quality, Integrations, Sales Intelligence, Analytics and shared TrueCRM platform services.

## Ownership rule

A module may read another module through:
- public application service,
- approved query service/read model,
- durable domain event,
- documented internal interface.

It must not directly mutate another module's tables.

## Key interaction map

### CRM → Data Quality
CRM create/update emits identity changes.
Data Quality recalculates duplicate keys/candidates/findings.

### Forms/Import/API → Data Quality
Before/create/update may request duplicate resolution according to policy.
They do not implement independent fuzzy/duplicate logic.

### Data Quality Merge → CRM
Merge calls CRM owning services/transaction policy.
After commit, emits `CRM_RECORD_MERGED`.

### Merge → Sales Intelligence
Customer identity links/touches rebind to survivor.
Current attribution may recalculate; historical evidence remains interpretable.

### Import/Sync → CRM/domains
Every row/object maps to a domain command.
Integration code never writes CRM/Payment/etc tables directly.

### Domain Events → Analytics
Analytics consumers project idempotent facts/dimensions.

### Sales Intelligence → Analytics
Touches, marketing costs and attribution results feed marketing/ROI facts.

### Analytics Export → Export service
Analytics defines query/result; Module 14 handles secure artifact generation/storage.

### Scheduled Report → Notifications/Email
Use shared notification/email provider; do not embed provider-specific mail implementation.

## Shared job contract

Long operations use common job state:

```text
QUEUED
RUNNING
SUCCEEDED
FAILED
CANCELLED
DEAD_LETTER
```

A domain job may expose richer substate but must map to shared operational state.

Required metadata:
- job ID,
- workspace,
- type,
- actor/service,
- idempotency key if applicable,
- progress,
- checkpoint,
- retries,
- correlation ID,
- timestamps,
- sanitized error.

## Shared idempotency contract

Idempotency records must be unique by appropriate tuple:

```text
workspace + principal + operation + idempotencyKey
```

Store request fingerprint.

Do not use an idempotency key supplied by one tenant to affect another tenant.

## Event contract

Recommended envelope:

```json
{
  "id": "uuid",
  "type": "EVENT_TYPE",
  "version": 1,
  "workspaceId": "trusted-workspace",
  "occurredAt": "timestamp",
  "resource": {
    "type": "CONTACT",
    "id": "uuid"
  },
  "actor": {
    "type": "USER",
    "id": "uuid"
  },
  "correlationId": "request-or-job-id",
  "data": {}
}
```

Consumers validate event version and dedupe `id`.

## Merge redirect resolution

Domain lookups that support merged-record redirects should use a shared resolver rather than each module implementing chains differently.

Rules:
- same workspace/type only,
- flatten redirect chain,
- cycle impossible/validated,
- retain original merge evidence.

## Permission projection into Analytics

Analytics query must derive source scope from authorization service.

Do not copy a stale "can see all" flag into dashboard definition.

Permission changes take effect even if analytical projection/cache has not refreshed by filtering at query/access layer.

## Cache keys

Any cached report/duplicate/list result must include or be safely independent from:
- workspace,
- permission version/scope,
- actor/service where needed,
- filter/query version,
- metric/model version.

Permission change invalidates/bypasses stale cache.

## Notifications

Operational notification examples:
- import completed with errors → initiator,
- export ready → requester,
- integration credential expired → integration admins,
- webhook dead-letter → integration admins,
- sync conflict → integration owner/admin,
- duplicate/quality scan completion → optional data steward,
- scheduled report failure → owner,
- BI credential/security failure → analytics admins.

Deduplicate repeated identical alerts.

Respect notification preferences unless security policy requires mandatory notification.

## Timezones

Store real instants as `timestamptz`.
Schedules use IANA timezone.
Analytics date grouping must explicitly choose workspace/user/report timezone according to metric/report policy.

## Concurrency

Use locks/version checks for:
- overlapping merges,
- sync conflict resolution,
- checkpoint claims,
- job claims,
- attribution current-result replacement,
- materialized refresh coordination where needed.

Avoid global workspace locks for long operations.

## Failure handling

A provider/analytics/data-quality failure must not roll back an already committed unrelated domain transaction after outbox publication.

Downstream retries converge derived state.

## Backfill/rebuild

Rebuilds operate from authoritative source:
- duplicate full scan,
- quality recalculation,
- attribution recalculation,
- analytics fact rebuild/materialization.

They must be restartable and observable.

## Acceptance criteria

- Import and sync create exactly the same domain validation outcome as equivalent normal API action.
- Analytics cannot mutate CRM truth.
- Permission reduction immediately prevents protected analytics/report data disclosure.
- CRM merge does not orphan tracking/analytics links.
- Replaying outbox event does not duplicate webhook/fact/attribution side effects.
- Failed analytics projection can rebuild without losing source data.
