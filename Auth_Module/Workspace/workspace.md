# Workspace Module Specification

## Goal

Implement Workspace as the TrueAgent tenant boundary.

A User may belong to multiple Workspaces. Each Workspace has exactly one owner. Every WorkspaceMembership has exactly one Role.

## Workspace model

Suggested fields:

```text
id UUID
name
slug
description nullable
settings JSON nullable
meta JSON nullable
ownerUserId
isDeleted
```

Rules:
- Workspace display names do not need to be globally unique.
- `slug` must be globally unique.
- UUID is the real authorization identifier; slug is human-friendly only.
- one owner exactly
- owner must have active WorkspaceMembership
- owner membership must use protected Owner/Admin role

## WorkspaceMembership model

Suggested fields:

```text
id UUID
workspaceId
userId
roleId
status ACTIVE | SUSPENDED
isDeleted
```

Rules:
- one active membership per `(workspaceId, userId)`
- one Role exactly
- Role must belong to the same Workspace
- membership status is separate from User status
- User may have different Roles in different Workspaces

## Workspace bootstrap

Manual signup after verification and new Google signup automatically create a first Workspace:

```text
<FirstName>'s Workspace
```

Bootstrap must be coordinated atomically:
1. create Workspace
2. create protected Owner/Admin Role
3. create WorkspaceMembership
4. link ownerUserId
5. write required AuditLog rows
6. commit

No half-created Workspace may be exposed.

## Endpoints

### Create

```text
POST /api/v1/workspaces
```

A verified/active User may create additional Workspaces subject to product entitlement rules.

Creator becomes the Workspace owner through the protected Owner/Admin membership.

### Get all

```text
GET /api/v1/workspaces
```

Return only Workspaces where the authenticated User has eligible membership, unless Platform Admin scope explicitly supports otherwise.

Dynamic query required.

Recommended:
- searchable: name, description, slug
- filterable: isDeleted, membership status where relevant
- sortable: name, slug

### Get one

```text
GET /api/v1/workspaces/:id
```

Must validate membership unless caller has explicit platform-level authority.

### PUT / PATCH

```text
PUT /api/v1/workspaces/:id
PATCH /api/v1/workspaces/:id
```

Use strict PUT vs PATCH semantics.

### Soft delete

```text
DELETE /api/v1/workspaces/:id
```

or repository-consistent soft-delete route.

Rules:
- set `isDeleted = true`
- protect owner/business invariants
- normal APIs stop exposing it
- AuditLog written atomically

### Restore

```text
PATCH /api/v1/workspaces/:id/restore
```

Set `isDeleted = false` after invariant checks.

### Hard delete

```text
DELETE /api/v1/workspaces/:id/hard
```

Rules:
- requires soft deletion first
- protected permission/platform policy
- may cascade normal Workspace-owned domain rows
- AuditLog history must survive
- do not use cascading FKs that erase AuditLog records

## Workspace switcher

```text
POST /api/v1/workspaces/:workspaceId/switch
```

Flow:
1. authenticate User
2. find active/non-deleted membership
3. reject if missing/suspended
4. update `users.settings.lastActiveWorkspaceId`
5. return Workspace + WorkspaceMembership + Role + effective permissions

Workspace-scoped requests send:

```text
X-Workspace-Id: <uuid>
```

Backend pipeline:
1. authenticate
2. resolve header
3. validate Workspace active
4. validate WorkspaceMembership
5. load Role
6. authorize required permission/scope
7. execute controller/service

Do not embed active Workspace as trusted authorization state in the access token.

## Ownership transfer

Provide explicit ownership-transfer service/endpoint.

Transaction must:
1. verify current owner
2. verify target User has eligible Workspace membership
3. move protected Owner/Admin role to target
4. update `ownerUserId`
5. assign former owner a valid non-owner Role if product rule requires it
6. write AuditLog
7. commit atomically

Do not allow manual assignment of Owner/Admin role outside this flow.

## Owner/Admin role

Protected system role:
- `isSystem = true`
- `isOwnerRole = true`
- effective super-role for all current and future Workspace permissions

Forbidden:
- rename
- soft delete
- hard delete
- edit permission set to remove owner powers
- manually assign to arbitrary member

## Invitations

Workspace invitation requires roleId before send.

See User specification for full invitation lifecycle.

## Audit events

At minimum:
- WORKSPACE.CREATED
- WORKSPACE.UPDATED
- WORKSPACE.SOFT_DELETED
- WORKSPACE.RESTORED
- WORKSPACE.HARD_DELETED
- WORKSPACE.SWITCHED
- WORKSPACE.OWNER_TRANSFERRED
- WORKSPACE.MEMBER_SUSPENDED
- WORKSPACE.MEMBER_REACTIVATED
- WORKSPACE.MEMBER_REMOVED

## Acceptance criteria

- Cross-Workspace reads/writes are rejected.
- Changing `X-Workspace-Id` cannot bypass membership.
- One owner exactly.
- Owner/Admin is protected.
- Membership has exactly one Role.
- Workspace switch updates last active Workspace only after membership validation.
- Get-All supports full dynamic query behavior.
- Soft delete/restore/hard delete work as specified.
- Audit history survives hard deletion.
