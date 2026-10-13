# Storages & Folders Specification

## Goal / Scope

Implement Personal, Company, Project and System storage roots plus a safe folder hierarchy and lifecycle.

## Ownership / Boundary

`FileStoragesController` owns storage containers/config. `FoldersController` owns folder tree operations. Project storage is canonical one-per-enabled Project Drive.

## Entities / Fields / Enums

```text
file_storages:
 id, workspaceId, type PERSONAL|COMPANY|PROJECT|SYSTEM,
 ownerUserId nullable, projectId nullable,
 name, isActive, version

file_folders:
 id, workspaceId, storageId, parentFolderId nullable,
 name, status ACTIVE|TRASHED,
 originalParentFolderId nullable,
 trashedAt nullable, purgeAfter nullable,
 version
```
Active sibling folder names should be unique under the same parent/storage according to normalized name rules.

## API Endpoints

```text
GET    /api/v1/file-storages
POST   /api/v1/file-storages
GET    /api/v1/file-storages/:id
PATCH  /api/v1/file-storages/:id
GET    /api/v1/file-storages/:id/root
POST   /api/v1/folders
GET    /api/v1/folders/:id
GET    /api/v1/folders/:id/children
GET    /api/v1/folders/:id/tree
PATCH  /api/v1/folders/:id
PATCH  /api/v1/folders/:id/move
POST   /api/v1/folders/:id/copy
DELETE /api/v1/folders/:id
PATCH  /api/v1/folders/:id/restore
DELETE /api/v1/folders/:id/hard
```

## Business Rules / Validation

- Personal storage canonical per user; Company storage canonical per Workspace; Project storage canonical per enabled Project.
- Folder parent/storage must be same Workspace and storage.
- Folder move rejects self/descendant cycle.
- Trash records original parent and purgeAfter using workspace retention policy (default 30 days).
- Trashing folder disables public sharing under that subtree and makes normal content unavailable.
- Restore returns to original active parent when possible; if conflict/missing parent, require explicit restore destination/rename rather than silent data loss.
- Hard purge requires dedicated permission and no active retention/legal hold.

## Permissions

- `STORAGE.READ`
- `STORAGE.MANAGE`
- `FOLDER.CREATE`
- `FOLDER.READ`
- `FOLDER.UPDATE`
- `FOLDER.MOVE`
- `FOLDER.DELETE`
- `FOLDER.RESTORE`
- `FOLDER.PURGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `STORAGE_NOT_FOUND`
- `FOLDER_NOT_FOUND`
- `FOLDER_HIERARCHY_CYCLE`
- `FOLDER_NAME_CONFLICT`
- `FOLDER_RESTORE_CONFLICT`
- `FILE_RETENTION_HOLD`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `FOLDER_CREATED`
- `FOLDER_MOVED`
- `FOLDER_TRASHED`
- `FOLDER_RESTORED`
- `FOLDER_DELETED`

## Audit Events / Evidence

- `Folder purge and significant storage configuration changes are audited.`

## Dependencies / Integrations

- Project provisioning
- File ACL service
- Retention jobs

## Testing Requirements

- Hierarchy cycle.
- Trash/restore with missing original parent.
- Project storage provisioning retry.

## Acceptance Criteria

- Folder hierarchy cannot escape its Workspace/storage.
- Recycle behavior is recoverable until purge.
