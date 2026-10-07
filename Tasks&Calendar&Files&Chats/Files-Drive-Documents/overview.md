# Files, Drive & Documents — Domain Overview

## Goal / Scope

Define TrueCRM logical Drive/storage, folder hierarchy, immutable File Versions, upload/processing, ACLs, public links, attachments, document editing sessions/locks and generated business documents.

## Ownership / Boundary

Files owns binary metadata and access policy but not the business records that reference Files. Binary bytes live in object storage. PostgreSQL owns logical identity, versions, permissions, lifecycle and bindings. Search/AI indexes are derived.

## Entities / Fields / Enums

Core tables/aggregates:

```text
file_storages
file_folders
files
file_versions
upload_sessions
file_derivatives
file_security_scans
file_permission_assignments
file_public_links
file_public_link_access_log
file_locks
document_edit_sessions
file_attachments
document_templates
generated_documents
recycle_records
storage_usage
external_storage_references
```

```text
StorageType = PERSONAL | COMPANY | PROJECT | SYSTEM
FileStatus = PROCESSING | ACTIVE | QUARANTINED | BLOCKED | TRASHED
PermissionLevel = NONE | READ | ADD | EDIT | FULL
InheritanceMode = INHERIT | OVERRIDE
PublicLinkPermission = VIEW | DOWNLOAD
```


## Business Rules / Validation

- Logical File identity is separate from immutable Version content.
- Restoring a Version creates a new latest Version.
- Attachment is a reference, never an automatic byte copy.
- File access and attached business-record access may both restrict access.
- Same-name upload requires explicit conflict action.
- Default recycle retention is 30 days, configurable.
- Default single-file upload limit is 100 MB, configurable by effective plan/workspace limit.

## Permissions

- `FILE.*`
- `FOLDER.*`
- `STORAGE.*`
- `DOCUMENT.*`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Domain / Outbox Events

- `FILE_CREATED`
- `FILE_VERSION_CREATED`
- `FILE_MOVED`
- `FILE_RENAMED`
- `FILE_TRASHED`
- `FILE_RESTORED`
- `FILE_DELETED`
- `FILE_SHARED`
- `FILE_PERMISSION_CHANGED`
- `PUBLIC_LINK_CREATED`
- `PUBLIC_LINK_REVOKED`
- `DOCUMENT_GENERATED`

## Audit Events / Evidence

- `ACL/public link/purge/blocked-file/security-sensitive actions are centrally audited.`

## Dependencies / Integrations

- Object storage
- Malware scanner
- Search/text extraction
- Notifications
- Audit
- Billing/storage quota
- Business modules attaching files

## Testing Requirements

- Version immutability.
- ACL inheritance and business-record intersection.
- Public token expiry/password/revocation.
- Quarantine blocks access.
- Quota and upload-size failures.

## Acceptance Criteria

- Unauthorized File names/content cannot leak.
- Old Versions never mutate.
- A single File can be reused across multiple authorized attachments.
- Public links expire/revoke deterministically.
