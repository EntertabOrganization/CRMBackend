# Audit Log Module Specification

## Goal

Provide one centralized, immutable, append-only audit trail for security-relevant, administrative and business mutations across the Auth/Identity capability.

Audit Logs replace the need for generic `createdBy`, `updatedBy` and `deletedBy` columns on normal entities in this phase.

They do not replace functional timestamps required by authentication and expiry logic.

## AuditLog model

Recommended:

```text
id UUID
workspaceId UUID nullable
partnerId UUID nullable
actorUserId UUID nullable
action string
entityType string
entityId UUID/string nullable
beforeData JSON nullable
afterData JSON nullable
metadata JSON nullable
ipAddress nullable
userAgent nullable
requestId/correlationId nullable
occurredAt timestamp
```

Do not use destructive cascading foreign keys that could erase AuditLog rows when referenced entities are hard-deleted.

Historical identifiers may remain even after the referenced entity no longer exists.

## Immutability

Allowed:
- internal CREATE
- GET
- GET ALL

Forbidden:
- public POST
- PUT
- PATCH
- soft delete
- hard delete

Retention/purge may be introduced later only as a controlled platform process.

## Transactional rule

For critical mutation:

```text
BEGIN
  domain mutation
  audit_log insert
COMMIT
```

If AuditLog insert fails, roll back the critical domain mutation.

Domain events may still be emitted after commit for future asynchronous consumers.

## Sensitive data sanitization

Never write:
- passwords
- password hashes
- raw verification tokens
- raw password reset tokens
- raw refresh tokens
- OAuth access/refresh tokens
- API keys
- secret values
- full credential objects

Sanitize `beforeData`, `afterData` and `metadata`.

## Access control

Use permission:

```text
audit.read
```

Recommended scope behavior:
- DEPARTMENT: logs relevant to direct Departments where meaningful and safely resolvable
- DEPARTMENT_TREE: direct Departments + descendants
- WORKSPACE: all Workspace logs
- Owner/Admin: all Workspace audit logs
- Platform Admin: platform-level logs where product administration requires
- Partner User: Partner logs only according to Partner authorization; no automatic customer Workspace audit access

## Endpoints

```text
GET /api/v1/audit-logs
GET /api/v1/audit-logs/:id
```

No mutation endpoints.

## Get-All dynamic query

Required.

Examples:

```text
GET /api/v1/audit-logs
?search=department
&page=1
&limit=20
&sortBy=occurredAt
&sortOrder=desc
&filter[action][eq]=DEPARTMENT.MOVED
&filter[actorUserId][eq]=...
&filter[entityType][eq]=DEPARTMENT
```

Recommended searchable:
- action
- entityType
- safe metadata text only if explicitly supported

Recommended filterable:
- workspaceId through authorization scope
- partnerId
- actorUserId
- action
- entityType
- entityId
- occurredAt

Recommended sortable:
- occurredAt
- action
- entityType

## Required events

Authentication:
- AUTH.USER_SIGNED_UP
- AUTH.EMAIL_VERIFIED
- AUTH.SIGN_IN_SUCCEEDED
- AUTH.REFRESH_ROTATED
- AUTH.LOGGED_OUT
- AUTH.LOGGED_OUT_ALL
- AUTH.PASSWORD_RESET_COMPLETED
- AUTH.GOOGLE_IDENTITY_LINKED

Workspace/User:
- WORKSPACE.CREATED
- WORKSPACE.UPDATED
- WORKSPACE.SOFT_DELETED
- WORKSPACE.RESTORED
- WORKSPACE.HARD_DELETED
- WORKSPACE.OWNER_TRANSFERRED
- USER.INVITED
- USER.INVITATION_ACCEPTED
- USER.ROLE_CHANGED
- USER.REMOVED_FROM_WORKSPACE

Department:
- DEPARTMENT.CREATED
- DEPARTMENT.UPDATED
- DEPARTMENT.MOVED
- DEPARTMENT.MANAGER_ASSIGNED
- DEPARTMENT.MEMBER_ADDED
- DEPARTMENT.MEMBER_REMOVED
- DEPARTMENT.SOFT_DELETED
- DEPARTMENT.RESTORED
- DEPARTMENT.HARD_DELETED

Authorization:
- ROLE.CREATED
- ROLE.UPDATED
- ROLE.PERMISSIONS_UPDATED
- ROLE.SOFT_DELETED
- ROLE.RESTORED
- ROLE.HARD_DELETED

Partner:
- PARTNER.APPLICATION_SUBMITTED
- PARTNER.APPLICATION_APPROVED
- PARTNER.APPLICATION_REJECTED
- PARTNER.CREATED
- PARTNER.DISCOUNT_UPDATED
- PARTNER.WORKSPACE_ACCESS_GRANTED
- PARTNER.WORKSPACE_ACCESS_REVOKED

## Hard-delete retention

Hard deletion of User/Workspace/Department/Role/Partner may cascade normal dependent rows.

AuditLog rows must remain.

This is a hard invariant.

## Acceptance criteria

- no audit mutation API exists
- critical mutations roll back if required audit insert fails
- secrets are never logged
- hard deletion of referenced entity does not delete AuditLog
- `audit.read` authorization enforced
- Get-All supports dynamic filtering and pagination
- cross-Workspace audit leakage is impossible
