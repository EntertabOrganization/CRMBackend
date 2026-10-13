# Roles and Permissions Module Specification

## Goal

Provide one Role per WorkspaceMembership, a global code-defined Permission catalog, and explicit permission scope.

Authentication answers "who are you?"
Authorization answers "what can you do in this Workspace and how far does that permission reach?"

## Permission model

Permissions are global/platform-defined and API read-only.

Permission keys use:

```text
resource.action
```

Examples:

```text
workspace.read
workspace.update

user.read
user.create
user.update
user.delete

department.read
department.create
department.update
department.delete

role.read
role.create
role.update
role.delete

audit.read

partner.company.create
partner.billing.manage
```

Do not let Workspace users create arbitrary permission names.

Use a code-controlled registry/constants file and seed/sync to PostgreSQL.

## Permission API

```text
GET /api/v1/permissions
GET /api/v1/permissions/:id
```

No:
- POST
- PUT
- PATCH
- DELETE

Get-All must support dynamic search/filter/sort/pagination.

Recommended:
- searchable: key/name/description
- filterable: module/resource/action if represented
- sortable: key/name

## Role model

Suggested fields:

```text
id UUID
workspaceId UUID
name
description nullable
isSystem boolean
isOwnerRole boolean
isDeleted boolean
```

Rules:
- custom Role belongs to exactly one Workspace
- cannot assign Workspace A Role inside Workspace B
- one WorkspaceMembership has exactly one Role

## Owner/Admin role

Automatically created for each Workspace.

Protected:
- isSystem = true
- isOwnerRole = true
- effective super-role
- receives all current and future Workspace permissions implicitly

Forbidden:
- rename
- delete
- soft delete
- hard delete
- strip permissions
- manually assign to arbitrary member

Ownership transfer is the only valid way to move this role to another User.

## PermissionScope

```text
OWN
DEPARTMENT
DEPARTMENT_TREE
WORKSPACE
```

No `NONE` value is needed.
Absence of RolePermission means denied.

Definitions:
- OWN = records owned/assigned to current User
- DEPARTMENT = union of User's directly assigned active Departments
- DEPARTMENT_TREE = those Departments plus all descendants
- WORKSPACE = all eligible records in active Workspace

## RolePermission model

Suggested:

```text
id UUID
roleId UUID
permissionId UUID
scope PermissionScope
isDeleted boolean
```

Constraint:
- one active `(roleId, permissionId)` assignment
- do not store the same permission multiple times at different scopes

## Role endpoints

```text
POST   /api/v1/roles
GET    /api/v1/roles
GET    /api/v1/roles/:id
PUT    /api/v1/roles/:id
PATCH  /api/v1/roles/:id
DELETE /api/v1/roles/:id
PATCH  /api/v1/roles/:id/restore
DELETE /api/v1/roles/:id/hard
```

Get-All dynamic query:
- searchable: name, description
- filterable: isSystem, isOwnerRole, isDeleted
- sortable: name

## Replace Role permissions

```text
PUT /api/v1/roles/:roleId/permissions
```

Input:

```json
{
  "permissions": [
    {
      "permissionId": "uuid",
      "scope": "WORKSPACE"
    },
    {
      "permissionId": "uuid",
      "scope": "DEPARTMENT"
    }
  ]
}
```

Rules:
- replace full Role permission set atomically
- validate all Permission IDs
- validate Role belongs to active Workspace
- reject updates to protected Owner/Admin role
- write AuditLog atomically

## Role deletion

If active WorkspaceMembership uses Role:
- block deletion with stable code such as `ROLE_IN_USE`

No membership may be left without a Role.

Soft delete before hard delete.

Hard delete may cascade normal RolePermission rows, but AuditLog history remains.

## Authorization evaluation order

For Workspace-scoped resource:

1. authenticate User
2. resolve active Workspace
3. validate Workspace active
4. validate active WorkspaceMembership
5. load exactly one Role
6. if protected Owner/Admin => allow Workspace-level action unless explicitly platform-only
7. otherwise find required Permission key
8. resolve active RolePermission
9. if missing => deny
10. evaluate scope against target resource
11. deny on any tenant mismatch

## Audit events

At minimum:
- ROLE.CREATED
- ROLE.UPDATED
- ROLE.PERMISSIONS_UPDATED
- ROLE.SOFT_DELETED
- ROLE.RESTORED
- ROLE.HARD_DELETED
- USER.ROLE_CHANGED
- PERMISSION.REGISTRY_SYNCED where appropriate

## Acceptance criteria

- exactly one Role per WorkspaceMembership
- custom Role cannot cross Workspaces
- Owner/Admin is protected super-role
- Permission API is read-only
- permission registry is code-defined
- one permission has one effective scope per Role
- Department scope unions all user's direct Departments
- Department Tree includes descendants
- Role deletion blocked while assigned
- authorization cannot be bypassed by changing Workspace ID
