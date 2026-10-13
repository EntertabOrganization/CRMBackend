# Project Members & Contextual Permissions Specification

## Goal / Scope

Implement owner/moderator/member roles, membership lifecycle and Project-context authorization.

## Ownership / Boundary

`ProjectMembersController` owns membership rows and role changes. Global roles/scopes remain owned by platform Authorization.

## Entities / Fields / Enums

```text
project_members:
 id, workspaceId, projectId, userId,
 memberRole OWNER|MODERATOR|MEMBER,
 status ACTIVE|INVITED|REMOVED,
 joinedAt, leftAt nullable, invitedByUserId
```
Owner may also have a membership row but `projects.ownerUserId` remains the canonical single owner reference.

## API Endpoints

```text
GET    /api/v1/projects/:projectId/members
POST   /api/v1/projects/:projectId/members
GET    /api/v1/projects/:projectId/members/:userId
PATCH  /api/v1/projects/:projectId/members/:userId
DELETE /api/v1/projects/:projectId/members/:userId
POST   /api/v1/projects/:projectId/transfer-ownership
GET    /api/v1/projects/:projectId/permissions/effective
```

## Business Rules / Validation

- Only active internal Workspace members may be Project members.
- Exactly one owner. Ownership transfer is transactional.
- Cannot remove the sole owner; transfer first.
- Removing a Project member removes only Project-derived access sources in linked Chat/Calendar/Drive; manually/directly granted access sources remain according to owning modules.
- Project membership/visibility never grants cross-Workspace access.

## Permissions

- `PROJECT.MEMBER_VIEW`
- `PROJECT.MEMBER_MANAGE`
- `PROJECT.OWNER_TRANSFER`
- `PROJECT.PERMISSION_VIEW`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `PROJECT_MEMBER_NOT_FOUND`
- `PROJECT_OWNER_REQUIRED`
- `PROJECT_OWNER_TRANSFER_INVALID`
- `PROJECT_EXTERNAL_MEMBER_NOT_ALLOWED`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `PROJECT_MEMBER_CHANGED`
- `PROJECT_OWNER_CHANGED`

## Audit Events / Evidence

- `All membership and ownership mutations are centrally audited.`

## Dependencies / Integrations

- Workspace membership
- Communication membership-source sync
- Calendar/Drive project access

## Testing Requirements

- Sole-owner protection.
- Membership source removal without over-revoking.
- External-user rejection.

## Acceptance Criteria

- Ownership is never ambiguous.
- Removing one access source cannot remove another valid source.
