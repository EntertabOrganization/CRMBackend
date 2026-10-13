# File Permissions & Sharing Specification

## Goal / Scope

Implement inheritance-aware ACLs and secure public File/Folder links.

## Ownership / Boundary

`FileAccessController` owns ACL evaluation/configuration and public links. It does not bypass business-record restrictions for attached Files.

## Entities / Fields / Enums

```text
file_permission_assignments:
 id, workspaceId,
 resourceType STORAGE|FOLDER|FILE, resourceId,
 subjectType USER|ROLE|DEPARTMENT|DEPARTMENT_TREE|PROJECT_ROLE|WORKSPACE|EXTERNAL_GUEST,
 subjectId nullable,
 permissionLevel NONE|READ|ADD|EDIT|FULL,
 inheritanceMode INHERIT|OVERRIDE

file_public_links:
 id, workspaceId, resourceType FILE|FOLDER, resourceId,
 tokenHash, permissionMode VIEW|DOWNLOAD,
 passwordHash nullable,
 expiresAt, maxDownloads nullable, downloadCount,
 includeChildren boolean, isActive, createdByUserId, revokedAt nullable
```
V1 uses explicit grant levels rather than complex multi-level ALLOW/DENY precedence.

## API Endpoints

```text
GET    /api/v1/files/:id/permissions
PUT    /api/v1/files/:id/permissions
GET    /api/v1/folders/:id/permissions
PUT    /api/v1/folders/:id/permissions
GET    /api/v1/file-storages/:id/permissions
PUT    /api/v1/file-storages/:id/permissions
POST   /api/v1/files/:id/public-links
POST   /api/v1/folders/:id/public-links
GET    /api/v1/public-links
GET    /api/v1/public-links/:id
PATCH  /api/v1/public-links/:id
DELETE /api/v1/public-links/:id
GET    /api/v1/public/files/:token
GET    /api/v1/public/files/:token/download
GET    /api/v1/public/folders/:token
```

## Business Rules / Validation

- ACL resolution evaluates direct resource override then inherited folder/storage grants plus Project/business context.
- Personal Drive owner defaults FULL; others NONE unless shared.
- Project Drive default may derive from Project role but can be restricted by child ACL.
- Public token is high entropy; persist hash where possible.
- Default public-link expiry 30 days; workspace policy controls required/max expiry.
- Optional password is securely hashed.
- Public V1 supports View/Download only, not anonymous edit.
- Expired/revoked link returns non-disclosing disabled/410-like response according to API convention.
- Folder public link `includeChildren` limits access to descendants currently under that tree; moving content out removes public access.
- Search/download must evaluate same effective access.

## Permissions

- `FILE.PERMISSION_MANAGE`
- `FILE.PUBLIC_LINK_MANAGE`
- `FILE.READ`
- `FILE.DOWNLOAD`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `FILE_PERMISSION_INVALID`
- `PUBLIC_LINK_NOT_FOUND`
- `PUBLIC_LINK_EXPIRED`
- `PUBLIC_LINK_REVOKED`
- `PUBLIC_LINK_PASSWORD_INVALID`
- `PUBLIC_LINK_DOWNLOAD_LIMIT`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `FILE_PERMISSION_CHANGED`
- `PUBLIC_LINK_CREATED`
- `PUBLIC_LINK_UPDATED`
- `PUBLIC_LINK_REVOKED`
- `PUBLIC_LINK_ACCESSED`

## Audit Events / Evidence

- `All ACL/public link mutations and security-relevant public access are auditable with privacy-safe request metadata.`

## Dependencies / Integrations

- Authorization
- Project roles
- Business-record permission check
- RateLimit

## Testing Requirements

- Inheritance override.
- Project role vs file override.
- Expired/password/limit public link.
- Folder move out of public tree.

## Acceptance Criteria

- Knowing fileId/token record ID cannot bypass ACL/secret validation.
- Public link never grants Workspace membership.
