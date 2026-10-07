# Files, Versions & Uploads Specification

## Goal / Scope

Implement logical Files, immutable Versions, secure resumable/multipart upload, processing/quarantine, download and search/list behavior.

## Ownership / Boundary

`FilesController` owns logical File/Version read and lifecycle. `UploadSessionsController` owns upload protocol/session completion. Object storage adapter owns raw bytes.

## Entities / Fields / Enums

```text
files:
 id, workspaceId, storageId, folderId,
 name, extension, mimeType,
 currentVersionId nullable,
 status PROCESSING|ACTIVE|QUARANTINED|BLOCKED|TRASHED,
 sizeBytesCurrent, version, trashedAt nullable, purgeAfter nullable

file_versions:
 id, workspaceId, fileId, versionNumber,
 objectKey, sizeBytes, checksum, mimeType,
 createdByUserId, createdAt,
 scanStatus PENDING|CLEAN|BLOCKED|ERROR
 UNIQUE(fileId, versionNumber)

upload_sessions:
 id, workspaceId, targetFolderId,
 desiredFileName, expectedSizeBytes,
 multipartProviderId nullable,
 status CREATED|UPLOADING|COMPLETING|PROCESSING|COMPLETED|ABORTED|FAILED,
 conflictMode CREATE_VERSION|RENAME|CANCEL nullable,
 idempotencyKey, expiresAt
```


## API Endpoints

```text
POST   /api/v1/upload-sessions
GET    /api/v1/upload-sessions/:id
POST   /api/v1/upload-sessions/:id/parts
POST   /api/v1/upload-sessions/:id/complete
POST   /api/v1/upload-sessions/:id/abort
GET    /api/v1/files
GET    /api/v1/files/:id
PATCH  /api/v1/files/:id
GET    /api/v1/files/:id/download
PATCH  /api/v1/files/:id/move
POST   /api/v1/files/:id/copy
DELETE /api/v1/files/:id
PATCH  /api/v1/files/:id/restore
DELETE /api/v1/files/:id/hard
GET    /api/v1/files/:id/versions
POST   /api/v1/files/:id/versions
GET    /api/v1/files/:id/versions/:versionId
POST   /api/v1/files/:id/versions/:versionId/restore
GET    /api/v1/files/:id/processing-status
```

## Business Rules / Validation

- Effective single-file maximum defaults to 100 MB but is resolved from plan/workspace/platform limits.
- Storage quota is checked before accepting growth; quota exceed blocks new bytes/versions but not safe read/delete/recovery.
- Same-name upload requires explicit conflict mode; never silently overwrite.
- Complete upload is idempotent.
- Temporary object is validated/scanned/processed before File becomes ACTIVE.
- Quarantined/blocked File cannot be normally downloaded/previewed.
- Version bytes/checksum are immutable after creation.
- Restore old version creates a new Version with new versionNumber/currentVersionId.
- Download checks ACL + binding restrictions, audits as required, and returns short-lived signed delivery path rather than raw objectKey.
- File trash/restore follows recycle policy.

## Permissions

- `FILE.CREATE`
- `FILE.READ`
- `FILE.DOWNLOAD`
- `FILE.UPDATE`
- `FILE.MOVE`
- `FILE.COPY`
- `FILE.DELETE`
- `FILE.RESTORE`
- `FILE.PURGE`
- `FILE.VERSION_CREATE`
- `FILE.VERSION_RESTORE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `FILE_NOT_FOUND`
- `FILE_TOO_LARGE`
- `STORAGE_QUOTA_EXCEEDED`
- `FILE_NAME_CONFLICT`
- `UPLOAD_SESSION_NOT_FOUND`
- `UPLOAD_SESSION_EXPIRED`
- `UPLOAD_CHECKSUM_MISMATCH`
- `FILE_QUARANTINED`
- `FILE_BLOCKED`
- `FILE_VERSION_NOT_FOUND`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `FILE_CREATED`
- `FILE_VERSION_CREATED`
- `FILE_PROCESSING_COMPLETED`
- `FILE_BLOCKED`
- `FILE_MOVED`
- `FILE_TRASHED`
- `FILE_RESTORED`
- `FILE_DELETED`

## Audit Events / Evidence

- `Purge/security override/download-sensitive events according to audit policy.`

## Dependencies / Integrations

- Object storage
- Malware scanner
- Preview/text extraction jobs
- Quota/entitlement
- Search

## Testing Requirements

- Oversize.
- Quota race.
- Same-name conflict.
- Complete retry.
- Malware blocked.
- Restore immutability.

## Acceptance Criteria

- No unsafe upload becomes ACTIVE.
- Repeated completion cannot create duplicate Versions.
- Old Version content never mutates.
