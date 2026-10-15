# Draft revisions, previews, approval, scheduling and rollback

**Owner:** Sites domain  
**Specification ID:** `Sites-LandingPages/04-drafts-preview-and-publication`  
**Delivery:** Core V1 or Advanced per `Shared-Contracts/11-release-phases-and-dependencies.md`  
**Scope:** Owned records, workflows and contracts below; existing shared domains remain external dependencies.

## Goal / user value

Ensure only authorized immutable revisions reach public visitors, with controlled multi-page publishing.

## Entities, fields and keys

Each `id` is a UUID unless it explicitly describes an external provider reference. Entities are authoritative inside this module only; fields refer to concrete logical columns or schema-validated JSON snapshots, not a suggestion to store every object in JSON.

- PageRevision(id,pageId,locale,revision,blockTreeJson,contentHash,createdBy,createdAt,status DRAFT|APPROVED|ACTIVE|SUPERSEDED).
- SiteRelease(id,siteId,releaseNumber,routeRevisionMapJson,createdBy,scheduledAt?,activatedAt?,status DRAFT|SCHEDULED|ACTIVE|ROLLED_BACK).
- PreviewToken(id,siteId,releaseCandidateId,tokenHash,expiresAt,revokedAt?,audienceScope).
- PublicationApproval(id,siteId,releaseId,workflowInstanceId,status).

**Required relational rules:** FK relations are workspace-consistent; indexes cover `(workspace_id, id)`, common parent+status/date queries and listed unique keys. Foreign references to other modules are validated through domain services. Existing database naming and ORM conventions take precedence over newly invented implementation technology.

## API contracts

Routes below are logical paths; authenticated/public API controller routes normally use `/api/v1`, while public-host rendering and explicit redirects are served by the Sites routing layer. Define exact DTOs in the repository using the required fields in the entity and rules sections. `POST`/`PATCH` validate request body, unknown privileged fields are rejected, and list GETs have scoped pagination/filtering. Operations that create financial/provider/dispatch/send/approval side effects require an `Idempotency-Key` or durable command key. API responses use the shared envelope/error shape.

- POST /sites/pages/:id/revisions.
- POST /sites/:id/preview-links.
- POST /sites/:id/releases/preview.
- POST /sites/:id/releases/submit-approval.
- POST /sites/:id/releases/publish.
- POST /sites/:id/releases/schedule.
- POST /sites/:id/releases/:releaseId/rollback.

**Sample envelope (successful resource command):**
```json
{"success":true,"data":{"id":"<uuid>","version":1,"status":"<valid-state>"},"meta":null}
```
**Sample envelope (validation failure):**
```json
{"success":false,"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","details":{"fields":[{"field":"<field-path>","reason":"<stable-reason>"}]}},"requestId":"<correlation-id>"}
```

## Business rules and validation

- Edit/publish/admin are distinct permissions and optionally Workflow approval required per site.
- Publishing compiles selected page revisions + navigation/shared block versions into an immutable release.
- Swap active release atomically so visitors never see mixed partially activated version.
- Scheduled release uses UTC due instant with IANA schedule context and idempotent job.
- Preview links scoped, cryptographic, expiring/revocable, noindex and excluded from analytics.
- If compilation/dependency validation fails keep last known-good live release active.
- Rollback selects prior immutable release and records new activation audit, never rewrites original.

## State transitions and command sequencing

- Page revision DRAFT -> APPROVED -> ACTIVE -> SUPERSEDED.
- Release DRAFT -> SCHEDULED -> ACTIVE -> ROLLED_BACK.
- revocation invalidates preview immediately.

State updates are server-authoritative, compare expected version/state where concurrency is possible, persist state and audit/outbox atomically and reject forbidden transitions with `409 INVALID_STATE_TRANSITION`. A repeated safe command with the same idempotency key returns its original result and never repeats external side effects.

## Authorization, tenant scope and privacy

- sites.page.edit vs sites.site.publish.
- approval cannot be bypassed via API token.
- preview token never authorizes editor writes.

Authorization evaluates module action and the previously approved shared scope model (`OWN`, `DEPARTMENT`, `DEPARTMENT_TREE`, `TEAM`, `ALL`, plus explicitly public/customer contexts). Filter fields and related entities according to their own permissions; do not rely on Next.js UI guards for security.

## Integrations and required dependencies

- Workflow approval.
- Queue scheduler.
- CDN cache invalidation.
- SharedBlock snapshots.
- Site analytics.

Every dependency is accessed through the owning application service or a typed adapter. Missing production dependencies are surfaced as integration blockers; automated tests may use deterministic fakes but may not claim end-to-end production readiness from mocks.

## Events, audit and asynchronous effects

- PAGE_REVISION_CREATED.
- SITE_RELEASE_APPROVED.
- SITE_RELEASE_ACTIVATED.
- SITE_RELEASE_ROLLED_BACK.

Each event carries `eventId`, `eventType`, `eventVersion`, `workspaceId`, `resourceId`, `occurredAt`, `correlationId`, `causationId`, `actorType`, `actorId` (when applicable), plus a minimal redacted payload. Deliver after commit from durable outbox and deduplicate every consumer by event ID/business key. Include before/after for audited mutable business fields without secrets or excess PII.

## Failure and edge-case handling

- Invalid field/value or absent required configuration: `400 VALIDATION_FAILED` or `409 POLICY_NOT_CONFIGURED`; do not fall back to a guessed business policy.
- Unauthenticated internal request: `401 UNAUTHENTICATED`; authenticated without permission: `403 PERMISSION_DENIED`; invalid cross-tenant references: non-disclosing `404 NOT_FOUND` or `403 PERMISSION_DENIED` consistently with repository policy.
- Version mismatch or conflicting operation: `409 VERSION_CONFLICT` / `409 INVALID_STATE_TRANSITION`; idempotency-key reused with different payload: `409 IDEMPOTENCY_KEY_REUSED`.
- Expired public resource/token: `410 RESOURCE_EXPIRED`; upstream transient failure: `503 DEPENDENCY_UNAVAILABLE` or durable `PENDING_RETRY` where accepting an asynchronous command is safe.
- Provider timeout may have occurred after provider accepted the side effect; reconcile before retrying; never interpret timeout as proven failure or blindly issue a new financial/send/dispatch operation.
- All list/filter/export operations must be scoped by permission and privacy classifications; retries never erase the original audit or immutable history.

## Acceptance criteria and testing

- **AC-01:** Draft edit does not change live page.
- **AC-02:** two concurrent publish commands activate one version.
- **AC-03:** rollback restores correct navigation and shared blocks.
- **AC-S01:** An actor from another workspace cannot read, change, enumerate or reference any of this module's resources, even with a valid foreign UUID.
- **AC-S02:** Unauthorized action/field/scope returns a stable error and leaves authoritative data, outbox and audit unchanged except permitted security-denial logging.
- **AC-S03:** Retry of the same business action returns the original effective result; failed downstream notifications and analytics never roll back an already committed business fact.
- **AC-S04:** Important mutations emit a single durable outbox event and sanitized audit record, recoverable after worker restart.

**Executable test contract:** `Testing/Sites-LandingPages/04-drafts-preview-and-publication.spec.ts` and applicable `Testing/Sites-LandingPages/Sites-LandingPages.e2e-spec.ts`. The tests are intentionally fail-closed until integrated with a real repository (see `Testing/README.md`).

## Cross references

- `Agent.md` — global implementation contract
- `Shared-Contracts/01-api-and-query-conventions.md`
- `Shared-Contracts/02-authz-and-tenancy.md`
- `Shared-Contracts/03-data-model-and-retention.md`
- `Shared-Contracts/05-transactions-and-events.md`
- `Shared-Contracts/08-errors-and-observability.md`
- `Shared-Contracts/11-release-phases-and-dependencies.md`
- `Shared-Contracts/14-operation-dtos-and-transaction-assertions.md`
