# Public REST API, Applications & Credentials Specification

## Goal

Expose stable versioned TrueCRM APIs for trusted applications/integrations while preserving workspace context, application scope, user/service permission, idempotency and rate limits.

## API version

Public base:

```text
/api/v1
```

Backward-compatible additive changes stay in V1.
Breaking contract changes require a new major API version.

Deprecation must be documented and observable before removal according to platform release policy.

## Authentication mechanisms

Supported initial mechanisms:

1. Normal authenticated user session/token used by TrueCRM UI/API.
2. Scoped API/integration credential for server-to-server/local integrations.
3. OAuth 2.0 application installation for delegated third-party access.

Standalone personal access tokens are not required by this pack.

## Authorization equation

A request is allowed only if all applicable layers permit it:

```text
feature entitlement
∩ application/credential scope
∩ active user/service identity permission
∩ workspace policy
∩ record/department/team scope
∩ field/resource state rules
```

The API credential does not create permissions the principal does not have.

## API applications

Suggested metadata:

```text
id
workspaceId or platform owner depending app type
name
description
appType
clientId/public identifier
allowedScopes
redirectUris
status ACTIVE|DISABLED|REVOKED
createdBy
```

For OAuth:
- secret stored in credential layer,
- redirect URI exact-match policy,
- access/refresh token handling follows auth platform,
- installation binds app + workspace + delegated identity/scopes.

## Scoped API credentials

Suggested metadata:

```text
id
workspaceId
name
credentialPrefix
secretRef
principalType SERVICE_IDENTITY
principalId
scopes
status
lastUsedAt
expiresAt nullable
createdBy
revokedAt nullable
```

Secret shown only at creation/rotation.

Store a secure hash/reference, never recoverable plaintext in business rows.

## Service/integration identity

A server integration should use an explicit scoped service identity rather than impersonating the Workspace Owner.

The identity:
- belongs to one workspace or approved platform scope,
- receives role/permissions using normal authorization primitives,
- appears in audit/history as a service identity,
- can be disabled/revoked independently,
- does not log in interactively unless the identity framework explicitly supports it.

## Scopes

Use coarse application scopes plus normal permissions.

Example application scopes:

```text
crm.read
crm.write
data_quality.read
data_quality.write
imports.manage
exports.manage
analytics.read
webhooks.manage
integrations.manage
```

Do not replace fine-grained TrueCRM authorization with API scopes.

## Cursor listing

Public list methods use cursor pagination.

Request example:

```text
GET /api/v1/contacts?limit=50&cursor=opaque&sort=id
```

Rules:
- cursor opaque/signed or tamper-safe,
- stable deterministic sort,
- max limit enforced,
- filters/sorts whitelisted,
- no raw SQL/filter expression from client.

## Field selection

Where public API supports `fields`, only allow a whitelist of fields the principal is authorized to view.

Hidden/restricted fields are omitted or explicitly denied according to API contract.

## Idempotency

Mutation endpoints that can create duplicated side effects support/require:

```text
Idempotency-Key: client-generated-key
```

Store:
- principal/workspace,
- route/action,
- key,
- request fingerprint,
- response/business result reference,
- expiry according to platform policy.

Same key + different material payload → `IDEMPOTENCY_KEY_REUSED`.

## Batch API

Provide:

```text
POST /api/v1/batch
```

Maximum: 50 sub-operations.

Each operation includes method/path/body/optional correlation key and is independently:
- authenticated under same principal,
- scoped,
- authorized,
- validated,
- rate accounted.

Batch is **not** one distributed database transaction.

Response returns per-operation result/error.

The server may stop/continue based on documented batch option, but default should return independent outcomes.

## Rate limiting

Layer by:
- workspace,
- application/credential,
- endpoint/resource class,
- possibly user/service principal,
- subscription entitlement.

Return HTTP `429` with stable error and retry metadata.

Use Redis/approved distributed limit store; never use per-process memory for authoritative multi-instance limits.

Expensive endpoints may have lower quotas.

## Stable errors

Do not expose stack traces/provider secrets.

Include request/correlation ID.

Cross-tenant lookup should return safe not-found/denied semantics without confirming resource existence.

## API documentation

The coding agent should integrate endpoint schemas with the repository's existing OpenAPI/Swagger mechanism where available.

Document:
- auth mechanism,
- required scopes/permissions,
- cursor/filter fields,
- idempotency requirement,
- rate class,
- stable errors,
- example request/response.

## Credential APIs

Administrative capabilities:

```text
GET    /api/v1/integrations/api-applications
POST   /api/v1/integrations/api-applications
GET    /api/v1/integrations/api-applications/:id
PATCH  /api/v1/integrations/api-applications/:id
POST   /api/v1/integrations/api-applications/:id/disable

GET    /api/v1/integrations/api-credentials
POST   /api/v1/integrations/api-credentials
POST   /api/v1/integrations/api-credentials/:id/rotate
POST   /api/v1/integrations/api-credentials/:id/revoke
```

Credential creation/rotation response may contain raw secret exactly once.

## Audit

Audit:
- app create/update/disable,
- credential create/rotate/revoke,
- service identity permission change through owning auth module,
- security-relevant scope changes.

Routine API calls go to access/security logs/usage metering, not one immutable audit row each unless policy requires.

## Acceptance criteria

- Revoked credential cannot authenticate.
- API scope cannot exceed service/user permission.
- Changing workspace body/header value cannot escape credential workspace.
- Cursor pagination is deterministic and does not duplicate/skip under stable data.
- Unsupported filter/sort fields fail validation.
- Same idempotency key cannot create duplicate business effect.
- Batch enforces maximum 50 and per-operation authorization.
- Rate limit works across application instances.
- Secrets never appear in ordinary list/get responses, logs or audit.
