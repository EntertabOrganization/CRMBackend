# Department Members Submodule Specification

## Goal

Manage many-to-many membership between Users and Departments.

A User may belong to unlimited Departments inside the same Workspace.

There is no primary Department in this phase and no Department-specific Role.

## DepartmentMember model

Suggested fields:

```text
id UUID
workspaceId UUID
departmentId UUID
userId UUID
isDeleted boolean
```

Rules:
- Department belongs to active Workspace.
- User must have active/non-deleted WorkspaceMembership in same Workspace.
- one active membership per `(departmentId, userId)`.
- same User may belong to multiple Departments.
- no primary Department.
- no Department-specific role.
- manager identity remains on `departments.managerId`.

## Bulk create

```text
POST /api/v1/department-members
```

Input:

```json
{
  "departmentId": "uuid",
  "userIds": ["uuid-1", "uuid-2"]
}
```

Atomic rule:
- validate all Users first
- validate Workspace membership for all
- validate Department
- validate duplicates
- if any item invalid, roll back entire operation
- do not partially add valid Users

Idempotency/duplicate policy may safely return existing active membership as already present if repository convention supports it, but must not create duplicates.

## Get all

```text
GET /api/v1/department-members
```

Dynamic query required.

Recommended:
- search may join safe User fields where repository query layer supports it
- filterable: departmentId, userId, isDeleted
- sortable: user name/email only if implemented safely through explicit whitelisting

Always tenant-scope by active Workspace.

## Remove membership

Soft-delete DepartmentMember by default.

Special manager rule:
- if User is current `departments.managerId`, block removal
- caller must first assign another manager or clear managerId explicitly

## Restore

Restore only when:
- User still has active WorkspaceMembership
- Department active
- duplicate active membership does not already exist

## Hard delete

Requires soft delete first.
May physically remove DepartmentMember row.
AuditLog history remains.

## Audit events

At minimum:
- DEPARTMENT.MEMBER_ADDED
- DEPARTMENT.MEMBER_REMOVED
- DEPARTMENT.MEMBER_RESTORED
- DEPARTMENT.MEMBER_HARD_DELETED

Bulk operations should include sanitized metadata such as affected user IDs/counts where appropriate.

## Acceptance criteria

- bulk create is fully transactional
- User from another Workspace is rejected
- one invalid User causes full rollback
- multi-Department membership works
- duplicate membership not created
- manager cannot be removed while still manager
- dynamic query remains Workspace-isolated
