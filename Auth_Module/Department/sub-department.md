# SubDepartment Logical Submodule Specification

## Purpose

`SubDepartment` is a logical/API concept only.

Do NOT create a `sub_departments` database table.

Every SubDepartment is a normal Department row whose `parentDepartmentId` points to another Department.

## Core operation

```text
POST /api/v1/departments/:parentId/sub-departments
```

Equivalent domain behavior:

```text
create Department {
  workspaceId = active workspace
  parentDepartmentId = :parentId
  ...
}
```

## Required operations

Support:
- create child Department
- list direct children
- list descendants recursively
- list ancestors
- move branch to another parent
- turn a root Department into a child
- move a child back to root
- prevent hierarchy cycles
- preserve Workspace isolation

Suggested endpoints:

```text
POST  /api/v1/departments/:parentId/sub-departments
GET   /api/v1/departments/:id/children
GET   /api/v1/departments/:id/descendants
GET   /api/v1/departments/:id/ancestors
PATCH /api/v1/departments/:id/move
```

## Validation

For every child operation:
- child and parent must be in active Workspace
- parent must be active/non-deleted
- child may not parent itself
- child may not be moved under its own descendant
- resulting sibling name must be unique among active siblings
- authorization must run server-side

## Delete behavior

A parent with active children cannot be soft-deleted.

This module must not implement implicit reparenting.

Example: deleting Egypt must NOT silently move Cairo to Sales.

The caller must explicitly move or delete children.

## Testing requirements

Include tests for:
- 4+ levels of nesting
- direct children vs descendants
- ancestor order
- root to child move
- child to root move
- cycle attempt
- self-parent attempt
- cross-Workspace parent attempt
- sibling duplicate conflict
- parent soft-delete blocked with children
