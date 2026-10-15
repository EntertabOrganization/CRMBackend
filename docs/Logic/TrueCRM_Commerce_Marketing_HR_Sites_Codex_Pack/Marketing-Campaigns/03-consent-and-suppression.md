# Consent, opt-out and suppression policy

**Owner:** Marketing domain  
**Specification ID:** `Marketing-Campaigns/03-consent-and-suppression`  
**Delivery:** Core V1 or Advanced per `Shared-Contracts/11-release-phases-and-dependencies.md`  
**Scope:** Owned records, workflows and contracts below; existing shared domains remain external dependencies.

## Goal / user value

Record verifiable communication permission by recipient, channel, purpose and jurisdiction.

## Entities, fields and keys

Each `id` is a UUID unless it explicitly describes an external provider reference. Entities are authoritative inside this module only; fields refer to concrete logical columns or schema-validated JSON snapshots, not a suggestion to store every object in JSON.

- ConsentRecord(id,workspaceId,subjectRef?,destinationHash,channel,purpose,lawfulBasis,source,evidenceFileId?,jurisdiction,state GRANTED|WITHDRAWN|UNKNOWN,effectiveAt).
- SuppressionEntry(id,workspaceId,destinationHash,channel,reason UNSUBSCRIBE|COMPLAINT|HARD_BOUNCE|MANUAL|POLICY|PROVIDER,createdAt,expiresAt?).
- ConsentPolicy(id,workspaceId,jurisdiction,channel,purpose,rulesVersion).
- OptoutToken(id,recipientKey,tokenHash,expiresAt).

**Required relational rules:** FK relations are workspace-consistent; indexes cover `(workspace_id, id)`, common parent+status/date queries and listed unique keys. Foreign references to other modules are validated through domain services. Existing database naming and ORM conventions take precedence over newly invented implementation technology.

## API contracts

Routes below are logical paths; authenticated/public API controller routes normally use `/api/v1`, while public-host rendering and explicit redirects are served by the Sites routing layer. Define exact DTOs in the repository using the required fields in the entity and rules sections. `POST`/`PATCH` validate request body, unknown privileged fields are rejected, and list GETs have scoped pagination/filtering. Operations that create financial/provider/dispatch/send/approval side effects require an `Idempotency-Key` or durable command key. API responses use the shared envelope/error shape.

- POST /marketing/consents record evidence.
- GET /marketing/consents/history.
- POST /marketing/consents/withdraw.
- POST /public/marketing/unsubscribe secure optout.
- POST /marketing/suppressions.
- GET /marketing/suppressions.
- POST /marketing/eligibility/preview.

**Sample envelope (successful resource command):**
```json
{"success":true,"data":{"id":"<uuid>","version":1,"status":"<valid-state>"},"meta":null}
```
**Sample envelope (validation failure):**
```json
{"success":false,"error":{"code":"VALIDATION_FAILED","message":"Request validation failed","details":{"fields":[{"field":"<field-path>","reason":"<stable-reason>"}]}},"requestId":"<correlation-id>"}
```

## Business rules and validation

- Unknown consent in consent-required marketing is INELIGIBLE.
- Transactional notices are not silently relabeled marketing and use distinct purpose/policy.
- Suppression overrides positive segment membership and prior consent.
- Resolve jurisdiction from trusted evidence/policy with conservative fallback.
- Eligibility check at QUEUE AND IMMEDIATELY BEFORE SEND, including optout changes.
- One-click unsubscribe only affects appropriate scope and suppresses future sends.
- Consent history append-only and revocation cannot erase previous evidence.
- Provider complaint and hard bounce automatically suppress.
- Never let employee override legal suppression without a separately authorized evidenced compliance action.

## State transitions and command sequencing

- Eligibility ELIGIBLE|SUPPRESSED|UNKNOWN_CONSENT|FREQUENCY_BLOCKED|QUIET_HOURS|INVALID_DESTINATION.

State updates are server-authoritative, compare expected version/state where concurrency is possible, persist state and audit/outbox atomically and reject forbidden transitions with `409 INVALID_STATE_TRANSITION`. A repeated safe command with the same idempotency key returns its original result and never repeats external side effects.

## Authorization, tenant scope and privacy

- marketing.consent.manage has special audit.
- Public unsubscribe token is scoped/hashed and rate-limited.
- Destination hashes not reversible in API.

Authorization evaluates module action and the previously approved shared scope model (`OWN`, `DEPARTMENT`, `DEPARTMENT_TREE`, `TEAM`, `ALL`, plus explicitly public/customer contexts). Filter fields and related entities according to their own permissions; do not rely on Next.js UI guards for security.

## Integrations and required dependencies

- Campaign sender.
- Files evidence.
- Provider event consumer.
- Retention/legal hold.

Every dependency is accessed through the owning application service or a typed adapter. Missing production dependencies are surfaced as integration blockers; automated tests may use deterministic fakes but may not claim end-to-end production readiness from mocks.

## Events, audit and asynchronous effects

- CONSENT_GRANTED.
- CONSENT_WITHDRAWN.
- RECIPIENT_SUPPRESSED.

Each event carries `eventId`, `eventType`, `eventVersion`, `workspaceId`, `resourceId`, `occurredAt`, `correlationId`, `causationId`, `actorType`, `actorId` (when applicable), plus a minimal redacted payload. Deliver after commit from durable outbox and deduplicate every consumer by event ID/business key. Include before/after for audited mutable business fields without secrets or excess PII.

## Failure and edge-case handling

- Invalid field/value or absent required configuration: `400 VALIDATION_FAILED` or `409 POLICY_NOT_CONFIGURED`; do not fall back to a guessed business policy.
- Unauthenticated internal request: `401 UNAUTHENTICATED`; authenticated without permission: `403 PERMISSION_DENIED`; invalid cross-tenant references: non-disclosing `404 NOT_FOUND` or `403 PERMISSION_DENIED` consistently with repository policy.
- Version mismatch or conflicting operation: `409 VERSION_CONFLICT` / `409 INVALID_STATE_TRANSITION`; idempotency-key reused with different payload: `409 IDEMPOTENCY_KEY_REUSED`.
- Expired public resource/token: `410 RESOURCE_EXPIRED`; upstream transient failure: `503 DEPENDENCY_UNAVAILABLE` or durable `PENDING_RETRY` where accepting an asynchronous command is safe.
- Provider timeout may have occurred after provider accepted the side effect; reconcile before retrying; never interpret timeout as proven failure or blindly issue a new financial/send/dispatch operation.
- All list/filter/export operations must be scoped by permission and privacy classifications; retries never erase the original audit or immutable history.

## Acceptance criteria and testing

- **AC-01:** Unsubscribe after scheduling but before sending excludes recipient.
- **AC-02:** Complaint blocks next campaign.
- **AC-03:** Unknown consent cannot be inferred from import.
- **AC-S01:** An actor from another workspace cannot read, change, enumerate or reference any of this module's resources, even with a valid foreign UUID.
- **AC-S02:** Unauthorized action/field/scope returns a stable error and leaves authoritative data, outbox and audit unchanged except permitted security-denial logging.
- **AC-S03:** Retry of the same business action returns the original effective result; failed downstream notifications and analytics never roll back an already committed business fact.
- **AC-S04:** Important mutations emit a single durable outbox event and sanitized audit record, recoverable after worker restart.

**Executable test contract:** `Testing/Marketing-Campaigns/03-consent-and-suppression.spec.ts` and applicable `Testing/Marketing-Campaigns/Marketing-Campaigns.e2e-spec.ts`. The tests are intentionally fail-closed until integrated with a real repository (see `Testing/README.md`).

## Cross references

- `Agent.md` — global implementation contract
- `Shared-Contracts/01-api-and-query-conventions.md`
- `Shared-Contracts/02-authz-and-tenancy.md`
- `Shared-Contracts/03-data-model-and-retention.md`
- `Shared-Contracts/05-transactions-and-events.md`
- `Shared-Contracts/08-errors-and-observability.md`
- `Shared-Contracts/11-release-phases-and-dependencies.md`
- `Shared-Contracts/14-operation-dtos-and-transaction-assertions.md`
