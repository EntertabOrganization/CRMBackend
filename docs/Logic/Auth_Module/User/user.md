# User Module Specification

## Goal

Manage the global User profile safely while keeping Workspace membership management separate from global identity ownership.

A Workspace Owner/Admin may manage Workspace memberships and allowed member profile information, but must not gain authority to hard-delete another person's global account.

## Endpoints

### Get current/specific user

```text
GET /api/v1/users/:id
```

Authorization:
- Workspace-scoped access must validate Workspace membership and `user.read`.
- A User may always read their own safe profile subject to product rules.
- Never expose secret auth fields.

### Get all users

```text
GET /api/v1/users
```

Mandatory dynamic query contract:
- search
- page / limit
- sortBy / sortOrder
- advanced filters

Recommended searchable fields:
- firstName
- lastName
- email

Recommended filterable fields:
- status
- isDeleted
- roleId through WorkspaceMembership context where supported

Recommended sortable fields:
- firstName
- lastName
- email

Normal response excludes soft-deleted users unless explicitly requested and authorized.

### Create user / invite to Workspace

The product-facing "Create User" action is invitation-based, not admin-created permanent credentials.

```text
POST /api/v1/users
```

or repository-consistent Workspace invitation endpoint.

Required input:
- email
- roleId
- optional firstName/lastName if product needs prefill

Role is mandatory.

Behavior:
- If normalized email already belongs to a User:
  - do not create another User
  - create Workspace invitation for that User/email
- If no User exists:
  - create the invitation
  - invitee completes profile/password during acceptance
- Admin never chooses the invitee's permanent password.

### PUT user

```text
PUT /api/v1/users/:id
```

Full replacement of editable profile state.

### PATCH user

```text
PATCH /api/v1/users/:id
```

Partial update only.

Profile ownership:
- User-owned: firstName, lastName, avatar/profile fields, settings
- Authentication-owned: email, password, auth identities
- Workspace admin-owned membership state: role, membership status, Department memberships

Email change must use a dedicated verification flow, not direct arbitrary profile update.

### Soft delete global user

Global User soft deletion is a platform/account-level capability, not normal Workspace-member removal.

Set:
```text
isDeleted = true
```

### Restore global user

Set:
```text
isDeleted = false
```

subject to authorization and invariant checks.

### Hard delete global user

Allowed only:
- Platform Admin/system administration; or
- dedicated user account-deletion flow.

Rules:
- requires soft deletion first
- may cascade normal dependent domain rows
- must preserve immutable AuditLog history
- must not let a Workspace Owner delete a User globally merely because they share a Workspace

## Workspace-member removal is not User deletion

Removing a member from Workspace A must affect only WorkspaceMembership A.

Example:

```text
User
├── Workspace A membership <- remove/soft-delete
├── Workspace B membership <- preserve
└── Workspace C membership <- preserve
```

## User statuses

```text
PENDING_VERIFICATION
ACTIVE
SUSPENDED
```

`status` and `isDeleted` are separate concepts.

Examples:
- ACTIVE + not deleted => normal eligible account
- SUSPENDED + not deleted => account exists but cannot authenticate
- isDeleted = true => soft-deleted account

## Settings

User settings may include:

```json
{
  "lastActiveWorkspaceId": "uuid",
  "language": "en",
  "timezone": "Africa/Cairo"
}
```

Never trust `lastActiveWorkspaceId`; validate active membership before using it.

## Invitations

Invitation status:
- PENDING
- ACCEPTED
- REJECTED
- REVOKED
- EXPIRED

Rules:
- roleId required before invite is sent
- expires after 7 days
- store token hash only
- resend invalidates previous token
- only matching normalized verified email may accept
- invitation proves email ownership for a new account; no second verification email required
- acceptance creates WorkspaceMembership with selected Role
- accepting invitation for existing User does not create duplicate User

## Audit events

At minimum:
- USER.PROFILE_UPDATED
- USER.INVITED
- USER.INVITATION_RESENT
- USER.INVITATION_REVOKED
- USER.INVITATION_REJECTED
- USER.INVITATION_ACCEPTED
- USER.SUSPENDED
- USER.REACTIVATED
- USER.SOFT_DELETED
- USER.RESTORED
- USER.HARD_DELETED
- USER.REMOVED_FROM_WORKSPACE
- USER.ROLE_CHANGED

## Acceptance criteria

- One normalized email maps to one global User.
- Workspace member removal never deletes memberships in other Workspaces.
- Workspace Owner cannot globally hard-delete another User.
- Role is required for invitation.
- Invitation acceptance is secure, expiring and one-time.
- User Get-All implements the shared dynamic query contract.
- PUT and PATCH semantics are distinct.
- Secret auth fields never appear in User DTOs.
- Critical mutations create AuditLog rows atomically.
