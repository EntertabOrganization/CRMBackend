# External Calendar Sync Specification

## Goal / Scope

Implement provider-neutral Google/Microsoft calendar synchronization plus ICS import/export, stable mappings, loop prevention and explicit conflict handling.

## Ownership / Boundary

`CalendarSyncController` owns sync connection references, mappings, manual sync commands and conflict resolution. OAuth secrets live in secure Integration credential storage, not Calendar tables.

## Entities / Fields / Enums

```text
calendar_sync_connections:
 id, workspaceId, userId, provider GOOGLE|MICROSOFT|ICS,
 integrationConnectionId, status, lastSyncedAt, syncCursor nullable

calendar_sync_mappings:
 id, workspaceId, connectionId, localEventId,
 externalCalendarId, externalEventId,
 externalVersion/etag nullable,
 localVersionAtLastSync,
 lastDirection, lastSyncedAt
 UNIQUE(connectionId, externalCalendarId, externalEventId)

calendar_sync_conflicts:
 id, workspaceId, mappingId,
 localSnapshotJson, externalSnapshotJson,
 status OPEN|RESOLVED,
 resolution LOCAL|EXTERNAL|MERGED|IGNORED,
 resolvedByUserId nullable
```


## API Endpoints

```text
GET    /api/v1/calendar-sync/connections
POST   /api/v1/calendar-sync/connections/google
POST   /api/v1/calendar-sync/connections/microsoft
POST   /api/v1/calendar-sync/connections/ics/import
GET    /api/v1/calendar-sync/ics/export
GET    /api/v1/calendar-sync/connections/:id
DELETE /api/v1/calendar-sync/connections/:id
POST   /api/v1/calendar-sync/connections/:id/sync
GET    /api/v1/calendar-sync/connections/:id/mappings
GET    /api/v1/calendar-sync/conflicts
GET    /api/v1/calendar-sync/conflicts/:id
POST   /api/v1/calendar-sync/conflicts/:id/resolve
```

## Business Rules / Validation

- Stable mapping prevents duplicate local Event creation.
- Provider echo/loop is suppressed using mapping/source/version metadata.
- OAuth/raw provider credentials never appear in Calendar API payloads.
- If local and external both changed after last common sync point, create conflict instead of silent overwrite.
- Sync commands/jobs are idempotent and retry-safe.
- ICS import validates untrusted content and preserves timezone/recurrence semantics where supported.

## Permissions

- `CALENDAR_SYNC.CONNECT`
- `CALENDAR_SYNC.READ`
- `CALENDAR_SYNC.RUN`
- `CALENDAR_SYNC.RESOLVE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `CALENDAR_SYNC_CONNECTION_NOT_FOUND`
- `CALENDAR_SYNC_PROVIDER_ERROR`
- `CALENDAR_SYNC_CONFLICT`
- `CALENDAR_SYNC_MAPPING_INVALID`
- `ICS_IMPORT_INVALID`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CALENDAR_SYNC_CONNECTED`
- `CALENDAR_SYNC_COMPLETED`
- `CALENDAR_SYNC_FAILED`
- `CALENDAR_SYNC_CONFLICT`
- `CALENDAR_SYNC_CONFLICT_RESOLVED`

## Audit Events / Evidence

- `Connection create/remove, credential reference changes and conflict resolution are audited.`

## Dependencies / Integrations

- Integration credential store
- Jobs/outbox
- Google/Microsoft adapters
- Events

## Testing Requirements

- Provider retry.
- Echo loop prevention.
- Concurrent conflict.
- Token revoked/provider unavailable.

## Acceptance Criteria

- Repeated sync does not create duplicate Events.
- Conflict remains visible until resolved.
