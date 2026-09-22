# Authentication Module Specification

## Goal

Implement the complete TrueAgent authentication lifecycle for local email/password and Google authentication, including email verification, access/refresh sessions, logout, password reset and current-user/session retrieval.

This module authenticates the global User identity. Workspace authorization is a separate step.

## Required behavior

### Manual signup

Public endpoint:

```text
POST /api/v1/auth/signup
```

Suggested input:

```json
{
  "firstName": "Faris",
  "lastName": "Hassan",
  "email": "faris@example.com",
  "password": "********"
}
```

Rules:
- Normalize email with trim + lowercase.
- Reject duplicate normalized email.
- Create User with `status = PENDING_VERIFICATION`.
- Create LOCAL AuthIdentity with secure password hash.
- Generate cryptographically secure one-time verification token.
- Store only the token hash.
- Functional expiry: 24 hours.
- Send verification email through MailService abstraction.
- Do not create the first Workspace yet.

### Email verification

```text
POST /api/v1/auth/verify-email
```

On valid token:
1. Validate token integrity/hash and expiry.
2. Ensure token is unused and user is still eligible.
3. Mark User ACTIVE and record functional verification state.
4. In one coordinated/transactional bootstrap:
   - create first Workspace named `<FirstName>'s Workspace`
   - create protected Owner/Admin Role
   - create WorkspaceMembership linking the User
   - assign the Owner/Admin role
5. Consume/invalidate verification token.
6. Create AuditLog entries for verification and bootstrap actions.
7. Issue access + refresh session tokens.
8. Return authenticated User + active Workspace + role/permissions.

If essential bootstrap fails, do not expose a half-created Workspace.

### Resend verification

```text
POST /api/v1/auth/resend-verification
```

Rules:
- Rate limit.
- Safe response that does not leak whether an email exists where appropriate.
- Invalidate previous active verification token.
- Generate a new hashed one-time token.
- Set new 24-hour functional expiry.
- Send through MailService.

### Sign in

```text
POST /api/v1/auth/signin
```

Rules:
- Validate normalized email + password.
- User must be ACTIVE and not soft-deleted.
- Issue short-lived access token.
- Issue longer-lived rotating refresh token.
- Refresh token stored only as hash.
- Resolve `users.settings.lastActiveWorkspaceId`.
- If still valid and membership active, use it.
- Otherwise select first active Workspace membership.
- Return User + selected Workspace + role + effective permissions.

### Refresh

```text
POST /api/v1/auth/refresh
```

Rules:
- Validate refresh session/token.
- Reject expired, revoked or soft-deleted session.
- Rotate token.
- Revoke/replace old token.
- Store only new token hash.
- Return new access token and refresh token.
- Audit suspicious/important refresh-session events as defined by repository convention.

### Logout

```text
POST /api/v1/auth/logout
```

Revoke the current refresh session.

### Logout all devices

```text
POST /api/v1/auth/logout-all
```

Revoke all active refresh sessions for the current User.

### Forgot password

```text
POST /api/v1/auth/forgot-password
```

Rules:
- Generate one-time reset token.
- Store hash only.
- Functional expiry required.
- Use safe response semantics.
- Send through MailService.
- Rate limit.

### Reset password

```text
POST /api/v1/auth/reset-password
```

Rules:
- Validate reset token/hash/expiry.
- Set new secure password hash.
- Consume reset token.
- Revoke existing refresh sessions.
- Audit the password reset.
- Never log the password or raw token.

### Current user/session

```text
GET /api/v1/auth/me
```

Return:
- safe User profile
- current/last active Workspace if valid
- WorkspaceMembership
- Role
- effective permissions
- no secret fields

## Google authentication

Provide:

```text
POST /api/v1/auth/google/signup
POST /api/v1/auth/google/signin
```

It is acceptable to internally converge both endpoints into one provider flow if external API compatibility remains.

Rules:
- Verify Google credential/token server-side through a GoogleAuthProvider abstraction.
- Require verified Google email.
- Do not send a second TrueAgent email verification.
- If no User exists:
  - create User ACTIVE
  - create GOOGLE AuthIdentity
  - bootstrap first Workspace
  - issue session
- If User exists with same normalized verified email:
  - do not create duplicate User
  - attach GOOGLE identity if safe and not already attached
  - issue session
- Never trust provider profile data without server-side verification.

## Password policy

Unless repository already has an equal or stronger policy:
- minimum 8 characters
- maximum 128
- at least one uppercase
- at least one lowercase
- at least one number
- special character not mandatory
- prefer Argon2id when no secure repository standard exists

## Suggested persistence

### users
- id UUID
- firstName
- lastName
- email normalized/unique
- settings JSON
- meta JSON nullable
- status: PENDING_VERIFICATION | ACTIVE | SUSPENDED
- emailVerifiedAt functional timestamp where needed
- isDeleted

### auth_identities
- id UUID
- userId
- provider: LOCAL | GOOGLE
- providerUserId nullable
- passwordHash nullable
- isDeleted

Constraints:
- provider identity uniqueness must prevent duplicate Google identities
- LOCAL passwordHash required only for LOCAL
- GOOGLE providerUserId required for GOOGLE

### refresh_sessions
- id UUID
- userId
- tokenHash
- expiresAt
- revokedAt nullable
- isDeleted

### email_verification_tokens
- id UUID
- userId
- tokenHash
- expiresAt
- consumed/invalid state using repository-consistent representation
- isDeleted

### password_reset_tokens
- id UUID
- userId
- tokenHash
- expiresAt
- consumed/invalid state
- isDeleted

## Rate limiting

Use a policy separate from normal authenticated APIs for:
- signin
- signup
- verification
- resend verification
- refresh
- forgot/reset password

Reuse repository rate-limit infrastructure if present.

## Audit events

At minimum:
- AUTH.USER_SIGNED_UP
- AUTH.EMAIL_VERIFIED
- AUTH.SIGN_IN_SUCCEEDED
- AUTH.SIGN_IN_FAILED where safe/useful
- AUTH.REFRESH_ROTATED
- AUTH.LOGGED_OUT
- AUTH.LOGGED_OUT_ALL
- AUTH.PASSWORD_RESET_REQUESTED where safe
- AUTH.PASSWORD_RESET_COMPLETED
- AUTH.GOOGLE_IDENTITY_LINKED

Never include raw credentials/tokens.

## Acceptance criteria

- Unverified local user cannot use normal Workspace features.
- Verification creates a usable first Workspace atomically.
- Duplicate email does not create duplicate User.
- Google with same verified email attaches to existing User rather than duplicating it.
- Refresh rotation invalidates the previous refresh token.
- Revoked/expired refresh tokens fail.
- Logout/current-session and logout-all work.
- Password reset revokes active sessions.
- Soft-deleted/suspended User cannot authenticate.
- No API exposes passwordHash, tokenHash, OAuth secret or raw token.
- Automated tests cover success and failure paths.
