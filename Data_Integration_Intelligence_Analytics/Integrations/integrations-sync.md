# Integration Connections, Mapping & Synchronization Specification

## Goal

Provide a generic adapter-driven framework for connecting TrueCRM to external systems, mapping entities/fields, synchronizing incrementally, preserving internal↔external identity and surfacing conflicts/health.

## Boundary

Generic framework owns:
- connection metadata,
- credential reference,
- provider adapter selection,
- entity/field mappings,
- external entity links,
- sync checkpoints,
- runs,
- conflicts,
- provider health.

Provider adapter owns:
- authentication protocol,
- provider API calls,
- provider rate/backoff semantics,
- provider object mapping to generic adapter DTOs,
- provider capability declaration.

Owning TrueCRM domain service owns:
- business validation,
- authorization/service policy,
- actual entity mutation.

## Connection model

Suggested:

```text
id
workspaceId
providerKey
name
status CONNECTING|ACTIVE|DEGRADED|PAUSED|DISABLED|AUTH_REQUIRED
credentialRef
serviceIdentityId
capabilities
settingsJson sanitized
lastHealthCheckAt
lastSuccessfulSyncAt
createdBy
```

Secrets are not stored in settings JSON.

## Adapter contract

A provider adapter should declare:
- supported directions: PUSH/PULL/BIDIRECTIONAL,
- entity types,
- incremental cursor capability,
- webhook capability,
- rate-limit behavior,
- idempotency/external request support,
- health check,
- mapping schema,
- delete/archive semantics.

Do not make Sales Intelligence or CRM services depend on a specific Google/Meta/Odoo/etc SDK type.

## External entity links

Canonical mapping:

```text
workspaceId
connectionId
internalEntityType
internalEntityId
externalEntityType
externalEntityId
externalVersion/etag nullable
lastSyncedAt
```

Unique external mapping per configured relationship where business policy requires.

Never allow an external ID alone to imply workspace.

## Mapping

Entity mapping:
- external object type → internal entity type,
- enabled direction.

Field mapping:
- external field → internal field,
- transform/normalizer,
- ownership direction,
- null/delete policy.

Mapping changes are versioned/audited if they affect live sync interpretation.

## Sync modes

Supported per adapter/mapping:

```text
PUSH
PULL
BIDIRECTIONAL
```

Incremental sync is preferred using:
- cursor,
- changed-since token,
- webhook-assisted checkpoint,
- provider delta token.

Full reconciliation exists as repair/verification operation, not the default every-run strategy.

## Sync run

Suggested fields:

```text
id
workspaceId
connectionId
direction
scope/entityType
status
mappingVersion
checkpointBefore
checkpointAfter
processed
created
updated
skipped
conflicts
errors
startedAt
completedAt
correlationId
```

Run updates checkpoint only after the corresponding data range is safely processed.

## Conflict policies

Per connection/entity/field as supported:

```text
TRUECRM_WINS
EXTERNAL_WINS
LAST_MODIFIED_WINS
FIELD_OWNERSHIP
MANUAL
```

`LAST_MODIFIED_WINS` may only be used if timestamps/version semantics are trustworthy and normalized.

Field ownership is preferred for systems with clear masters.

## Conflict record

```text
id
workspaceId
connectionId
internalEntityType/id
externalEntityType/id
mappingVersion
fieldOrObject
internalValueSnapshot
externalValueSnapshot
internalVersion
externalVersion
status OPEN|RESOLVED|OBSOLETE
resolution
resolvedBy
resolvedAt
```

Sensitive values must be redacted/protected.

Manual resolution:
- re-check current versions,
- choose internal/external/custom permitted value,
- write through owning domain/provider adapter,
- update link/checkpoint,
- audit.

Do not silently overwrite unresolved MANUAL conflicts.

## Loop prevention

Bidirectional sync must prevent update loops using:
- mapping/version metadata,
- external change IDs/etags,
- origin/correlation markers where provider supports,
- no-op equality checks,
- idempotency.

A TrueCRM change produced by provider sync must not immediately push back as a new logically identical change.

## Delete/archive policy

External deletion never automatically hard-deletes critical TrueCRM business data unless explicit mapping policy and owning domain allow it.

Prefer:
- archive/disable,
- mark missing,
- create conflict/review.

TrueCRM deletions pushed outward require explicit adapter capability/policy.

## Operational health

Expose:
- auth status,
- last successful call,
- provider rate-limit/throttle state,
- last sync,
- open conflict count,
- recent failures,
- webhook health.

Status transition to AUTH_REQUIRED/DEGRADED should notify configured integration admins.

## APIs

```text
GET    /api/v1/integrations/connections
POST   /api/v1/integrations/connections
GET    /api/v1/integrations/connections/:id
PATCH  /api/v1/integrations/connections/:id
POST   /api/v1/integrations/connections/:id/pause
POST   /api/v1/integrations/connections/:id/resume
POST   /api/v1/integrations/connections/:id/reconnect

GET    /api/v1/integrations/connections/:id/mappings
PUT    /api/v1/integrations/connections/:id/mappings

POST   /api/v1/integrations/connections/:id/sync
GET    /api/v1/integrations/sync-runs
GET    /api/v1/integrations/sync-runs/:id

GET    /api/v1/integrations/sync-conflicts
GET    /api/v1/integrations/sync-conflicts/:id
POST   /api/v1/integrations/sync-conflicts/:id/resolve
```

Sync trigger requires idempotency key.

## Jobs/retries

Sync work uses shared jobs.

Provider 429/throttle should honor `Retry-After`/provider signals where available.

Retries must not move checkpoint past unprocessed changes.

## Audit

Audit:
- connection create/update/pause/disable/reconnect,
- mapping changes,
- manual sync when meaningful,
- conflict resolution,
- credential rotate/revoke through credential module.

## Acceptance criteria

- Connection cannot access another workspace.
- External ID collisions are scoped by connection/provider.
- Incremental retry resumes from safe checkpoint.
- Bidirectional no-op changes do not loop.
- Manual conflict remains visible until resolved/obsolete.
- Conflict resolution rechecks current versions.
- Credential failure produces AUTH_REQUIRED without deleting data.
- Provider retries do not duplicate domain records.
- Disabling connection stops future sync/webhook processing while retaining history.
