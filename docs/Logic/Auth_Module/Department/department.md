# Department Module Specification

## Goal

Implement an unlimited Workspace-scoped organizational hierarchy using one self-referencing `departments` table.

There is no separate database table for SubDepartments.

Example:

```text
Sales
└── Egypt
    └── Cairo
        └── Enterprise Sales
```

## Department model

Suggested fields:

```text
id UUID
workspaceId UUID
parentDepartmentId UUID nullable
name
description nullable
managerId UUID nullable
isDeleted boolean
```

Rules:
- Department always belongs to one Workspace.
- parent Department must belong to the same Workspace.
- `parentDepartmentId = null` means root Department.
- unlimited nesting.
- no hierarchy cycles.
- no self-parent.
- manager optional.
- manager must have active WorkspaceMembership and active membership in this Department.
- Department names are unique among active siblings only.
- same name is allowed under different parents.

## Endpoints

```text
POST   /api/v1/departments
GET    /api/v1/departments
GET    /api/v1/departments/:id
PUT    /api/v1/departments/:id
PATCH  /api/v1/departments/:id
PATCH  /api/v1/departments/:id/move
DELETE /api/v1/departments/:id
PATCH  /api/v1/departments/:id/restore
DELETE /api/v1/departments/:id/hard
```

Tree endpoints:

```text
GET /api/v1/departments/tree
GET /api/v1/departments/:id/children
GET /api/v1/departments/:id/descendants
GET /api/v1/departments/:id/ancestors
```

## Create

Validate:
- active Workspace
- caller permission
- parent exists if supplied
- parent belongs to active Workspace
- sibling name uniqueness
- manager eligibility if supplied

## Move

Changing `parentDepartmentId` moves the whole branch.

Reject:
- parent = itself
- parent is any descendant of the node
- parent belongs to another Workspace
- target parent soft-deleted/inactive
- sibling name conflict after move

Movement should preserve child relationships.

## Soft delete

If Department has active child Departments:
- block with stable error such as `DEPARTMENT_HAS_CHILDREN`.

Require children to be moved or deleted explicitly.

Also validate manager/member/resource invariants according to repository/product rules.

Set `isDeleted = true`.
Write AuditLog atomically.

## Restore

Set `isDeleted = false` only when:
- parent still exists and is active, or root restore is valid
- sibling name uniqueness still holds
- Workspace active
- caller authorized

## Hard delete

Requires soft delete first.

May cascade normal dependent Department rows such as DepartmentMembership records when product invariants permit.

Must not delete AuditLog history.

## Get-All dynamic query

Mandatory shared query framework.

Recommended:
- searchable: name, description
- filterable: workspaceId (internally scoped), parentDepartmentId, managerId, isDeleted
- sortable: name

Never permit query filters to cross the active Workspace boundary.

## Permission interaction

Department itself is not a tenant boundary.

Permission scope semantics:
- DEPARTMENT = user's directly assigned Departments
- DEPARTMENT_TREE = user's directly assigned Departments + all descendants

## Audit events

At minimum:
- DEPARTMENT.CREATED
- DEPARTMENT.UPDATED
- DEPARTMENT.MOVED
- DEPARTMENT.MANAGER_ASSIGNED
- DEPARTMENT.MANAGER_CLEARED
- DEPARTMENT.SOFT_DELETED
- DEPARTMENT.RESTORED
- DEPARTMENT.HARD_DELETED

## Acceptance criteria

- unlimited nesting works
- cycles impossible
- cross-Workspace parent impossible
- sibling name uniqueness enforced
- manager eligibility enforced
- tree/children/descendants/ancestors endpoints are correct
- move operation preserves tree and blocks cycles
- soft delete blocks when active children exist
- dynamic search never leaks another Workspace
- hard delete preserves AuditLog history
