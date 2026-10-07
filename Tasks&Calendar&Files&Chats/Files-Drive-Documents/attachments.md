# Generic File Attachments Specification

## Goal / Scope

Implement reusable bindings between one File and authorized business objects without copying the binary.

## Ownership / Boundary

`AttachmentsController` owns generic attachment relationships. Owning business module must authorize the target object; File service authorizes the File.

## Entities / Fields / Enums

```text
file_attachments:
 id, workspaceId,
 fileId,
 entityType,
 entityId,
 role ATTACHMENT|RESULT|COVER|DOCUMENT|MEDIA|OTHER,
 attachedByUserId,
 createdAt
```
Use a unique/dedupe constraint appropriate to `(fileId, entityType, entityId, role)` where duplicates add no meaning.

## API Endpoints

```text
GET    /api/v1/attachments
POST   /api/v1/attachments
GET    /api/v1/attachments/:id
DELETE /api/v1/attachments/:id
GET    /api/v1/entities/:entityType/:entityId/attachments
```

## Business Rules / Validation

- Attach requires File readable/attachable by caller and target entity readable/mutable according to target module.
- File and entity must belong to same Workspace.
- Attachment never copies object-storage bytes.
- Opening an attachment checks current File permission AND target business-record permission/context when the access path requires both.
- Detaching does not delete File.
- Deleting one business object does not automatically purge shared File used elsewhere.

## Permissions

- `FILE.ATTACH`
- `FILE.DETACH`
- `FILE.READ`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `ATTACHMENT_NOT_FOUND`
- `ATTACHMENT_FILE_ACCESS_DENIED`
- `ATTACHMENT_ENTITY_ACCESS_DENIED`
- `ATTACHMENT_CROSS_WORKSPACE`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `FILE_ATTACHED`
- `FILE_DETACHED`

## Audit Events / Evidence

- `Sensitive attach/detach may appear in owning domain history; central Audit only when policy requires.`

## Dependencies / Integrations

- Every business module that uses Files
- FileAccessService

## Testing Requirements

- Cross-workspace bind.
- File allowed but target denied.
- Target allowed but File denied.
- Shared File detached from one of several entities.

## Acceptance Criteria

- One logical File is safely reusable.
- Attachment does not become an authorization bypass.
