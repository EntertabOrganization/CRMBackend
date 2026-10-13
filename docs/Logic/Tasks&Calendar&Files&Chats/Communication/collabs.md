# Collabs Specification

## Goal / Scope

Implement restricted collaboration spaces combining Chat, Files, Tasks, Calendar and Calls for internal users plus invited external guests.

## Ownership / Boundary

`CollabsController` owns Collab metadata, restricted membership and invitation lifecycle. It orchestrates access to child tools but does not own Task/File/Event records themselves.

## Entities / Fields / Enums

```text
collabs:
 id, workspaceId, name, description,
 ownerUserId, status ACTIVE|ARCHIVED,
 version

collab_members:
 id, workspaceId, collabId, userId,
 memberType INTERNAL|EXTERNAL,
 role OWNER|ADMIN|MEMBER|GUEST,
 status INVITED|ACTIVE|REMOVED,
 joinedAt nullable, leftAt nullable

collab_invitations:
 id, workspaceId, collabId, email,
 tokenHash, expiresAt, acceptedAt nullable,
 revokedAt nullable, invitedByUserId
```
External guest may be a global `users` identity with no normal `workspace_members` row.

## API Endpoints

```text
POST   /api/v1/collabs
GET    /api/v1/collabs
GET    /api/v1/collabs/:id
PUT    /api/v1/collabs/:id
PATCH  /api/v1/collabs/:id
POST   /api/v1/collabs/:id/archive
POST   /api/v1/collabs/:id/restore
GET    /api/v1/collabs/:id/members
POST   /api/v1/collabs/:id/members
DELETE /api/v1/collabs/:id/members/:userId
POST   /api/v1/collabs/:id/invitations
POST   /api/v1/collabs/:id/invitations/:invitationId/resend
DELETE /api/v1/collabs/:id/invitations/:invitationId
POST   /api/v1/public/collab-invitations/:token/accept
GET    /api/v1/collabs/:id/resources
```

## Business Rules / Validation

- External person enters collaboration through Collab only, not ordinary Project/Chat/Channel membership.
- Invitation default expiry 7 days, workspace-configurable.
- Token is high entropy, stored hashed, revocable and single-use on acceptance.
- Resend invalidates previous token and creates/reissues a new secret.
- Existing global User identity can accept invitation without duplicating identity.
- Collab membership scopes guest to Collab-authorized Chat/Files/Tasks/Calendar/Calls only.
- Archive makes Collab operationally read-only; historical content remains governed by respective retention policies.

## Permissions

- `COLLAB.CREATE`
- `COLLAB.READ`
- `COLLAB.UPDATE`
- `COLLAB.MEMBER_MANAGE`
- `COLLAB.INVITE_EXTERNAL`
- `COLLAB.ARCHIVE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `COLLAB_NOT_FOUND`
- `COLLAB_INVITATION_INVALID`
- `COLLAB_INVITATION_EXPIRED`
- `COLLAB_INVITATION_REVOKED`
- `COLLAB_EXTERNAL_SCOPE_DENIED`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `COLLAB_CREATED`
- `COLLAB_MEMBER_CHANGED`
- `COLLAB_INVITATION_SENT`
- `COLLAB_INVITATION_ACCEPTED`
- `COLLAB_ARCHIVED`

## Audit Events / Evidence

- `External guest invitations/membership and owner/admin changes are centrally audited.`

## Dependencies / Integrations

- Global identity/Auth
- Files
- Tasks
- Calendar
- Calls
- Chat

## Testing Requirements

- Expired/replayed invite.
- Existing account acceptance.
- Guest attempts non-Collab Workspace access.

## Acceptance Criteria

- External guest can use only explicitly Collab-authorized resources.
- Invitation replay cannot create duplicate membership.
