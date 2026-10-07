# Document Editing & Locking Specification

## Goal / Scope

Implement provider-neutral online edit sessions and exclusive locks while preserving immutable File Version output.

## Ownership / Boundary

Document editing orchestrates external/internal editor sessions but does not store mutable editor state as File content. Completed edits produce new immutable File Versions.

## Entities / Fields / Enums

```text
document_edit_sessions:
 id, workspaceId, fileId,
 provider INTERNAL_DOCS|GOOGLE_DOCS|MICROSOFT_OFFICE|ONLYOFFICE|CUSTOM,
 providerSessionId, userId,
 mode COLLABORATIVE|EXCLUSIVE_LOCK,
 status ACTIVE|COMPLETED|ABORTED|EXPIRED,
 startedAt, lastActivityAt, endedAt nullable

file_locks:
 id, workspaceId, fileId,
 lockType EDIT|SYSTEM_PROCESS|WORKFLOW,
 lockedByUserId nullable, lockTokenHash,
 lockedAt, expiresAt, releasedAt nullable
```


## API Endpoints

```text
POST   /api/v1/files/:id/edit-sessions
GET    /api/v1/files/:id/edit-sessions
GET    /api/v1/edit-sessions/:id
POST   /api/v1/edit-sessions/:id/heartbeat
POST   /api/v1/edit-sessions/:id/complete
POST   /api/v1/edit-sessions/:id/abort
POST   /api/v1/files/:id/locks
DELETE /api/v1/files/:id/locks/:lockId
POST   /api/v1/files/:id/locks/:lockId/force-release
```

## Business Rules / Validation

- Edit starts only for ACTIVE, editable, authorized File.
- EXCLUSIVE_LOCK acquisition is atomic.
- Locks use lease/heartbeat/expiry to avoid permanent browser-crash lock.
- Force unlock requires elevated permission and Audit.
- Provider callback/session completion verifies session and creates one new File Version idempotently.
- Provider secrets/session credentials are not exposed in normal File APIs.
- Anonymous public link cannot start edit session in V1.

## Permissions

- `FILE.EDIT`
- `FILE.LOCK`
- `FILE.FORCE_UNLOCK`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `FILE_NOT_EDITABLE`
- `FILE_LOCKED`
- `FILE_LOCK_NOT_FOUND`
- `EDIT_SESSION_NOT_FOUND`
- `EDIT_SESSION_EXPIRED`
- `EDIT_PROVIDER_ERROR`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `FILE_EDIT_SESSION_STARTED`
- `FILE_EDIT_SESSION_COMPLETED`
- `FILE_LOCK_ACQUIRED`
- `FILE_LOCK_RELEASED`

## Audit Events / Evidence

- `Force unlock and security-sensitive provider/session changes are audited.`

## Dependencies / Integrations

- File versions
- Editing provider adapters
- Object storage

## Testing Requirements

- Atomic lock race.
- Expired lock recovery.
- Complete callback retry creates one version.

## Acceptance Criteria

- Exclusive edit cannot have two active owners.
- Every saved content change becomes a new immutable Version.
