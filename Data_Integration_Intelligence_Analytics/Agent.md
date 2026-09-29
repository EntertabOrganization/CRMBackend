# TrueCRM Data, Integration, Intelligence & Analytics — Agent Execution Contract

## Purpose

This file is the master execution contract for any coding agent implementing these TrueCRM modules:

1. Duplicates, Merge & Data Quality
2. Import, Export, API & Integrations
3. Sales Intelligence & Attribution
4. Analytics, Reports & Dashboards

The human partner should be able to provide a goal such as:

```text
Complete Data Quality
Complete Import and Export
Complete API and Integrations
Complete Sales Intelligence
Complete Analytics
Complete Modules 13-16
```

The agent must inspect the repository, read this file and every specification/test contract relevant to the requested goal, implement the goal completely, wire the executable test contracts to the repository, run targeted tests, fix failures, run the complete regression suite, and only then report the goal as finished.

Do not stop after writing a plan. Continue execution automatically unless a genuine blocker requires a human product decision, unavailable external credential, unavailable provider account, or destructive production action that requires explicit approval.


---

## 1. Source authority and conflict rules

When implementing this pack, resolve requirements in this order:

1. The human partner's latest explicit instruction.
2. The confirmed decisions captured by this pack.
3. These module specifications and cross-module contracts.
4. TrueCRM PRD/BRD/System Architecture.
5. Existing repository behavior where it does not contradict locked business/security behavior.
6. Bitrix24 as a behavioral reference.
7. Agent recommendation only for implementation details that remain genuinely unspecified.

Bitrix24 is a reference for product behavior, not a requirement to copy its internal architecture.

If repository naming or ORM conventions differ from suggested names in these specifications:
- preserve behavior, boundaries, security, data integrity, and acceptance criteria;
- adapt table/class/file names to established repository conventions where safe;
- never create duplicate concepts solely because a source document used a different label.

If a conflict would change a confirmed product decision, stop and ask the human partner.

---

## 2. Non-negotiable TrueCRM architecture

- Frontend: Next.js + TypeScript.
- Backend: NestJS modular monolith + TypeScript.
- Transactional source of truth: PostgreSQL.
- Cache and ephemeral shared state: Redis where needed.
- Long-running work: queues/workers/background jobs.
- Files/artifacts: existing S3-compatible object-storage abstraction plus PostgreSQL metadata.
- Realtime: existing WebSocket/SSE mechanism where needed; realtime is never business truth.
- Important domain mutations: domain state + transactional outbox event in the same commit.
- Every business row is workspace-scoped directly or through a strongly validated parent.
- Backend authorization is authoritative.
- Search, analytics, counters, dashboards, caches and attribution projections are derived/rebuildable.
- External providers are isolated behind adapters.
- Do not introduce a second Python backend, LangChain backend, separate analytics mutation service, or microservice split for these modules unless the repository already has an approved equivalent or the human partner explicitly requests an architecture change.

Cross-module writes must use owning module application/domain services, not direct table manipulation.

---

## 3. Repository-first execution

Before changing code:

1. Read this `Agent.md` completely.
2. Read every specification file listed for the requested goal in `manifest.json`.
3. Read the matching files under `Testing/`.
4. Inspect `package.json`, workspace/package layout and scripts.
5. Inspect NestJS module/controller/service conventions.
6. Inspect the ORM/data-access approach and current schema/migrations.
7. Inspect authentication, workspace context and authorization guards.
8. Inspect the existing permission/scope model.
9. Inspect outbox/event, queue/job, audit, file/object-storage, notification, rate-limit and entitlement services.
10. Inspect API response/error conventions and pagination already used.
11. Inspect the existing testing framework and factories.
12. Inspect directly related CRM, Forms, Communication, Marketing, Products/Payments and Custom Field modules before wiring relationships.

Do not invent repository state.

Prefer reuse over parallel infrastructure. These four modules should consume shared platform primitives rather than creating private alternatives.

---

## 4. Naming and data conventions

Unless the repository has an established alternative:

- TypeScript properties: `camelCase`.
- PostgreSQL names: `snake_case`.
- Primary identifiers: UUID.
- All real instants: `timestamptz`.
- Date-only business concepts: `DATE`.
- Money and precise quantities: `NUMERIC`, never binary floating point.
- Currency: explicit ISO currency code.
- External-provider identifiers: strings, not assumed numeric.
- Historical attribution/metric/configuration results must retain the version that produced them.
- Large payloads/provider callbacks must not be copied indefinitely into unrelated business rows.
- Secrets never belong in ordinary business-table plaintext columns.

Use optimistic versioning/row locking for concurrency-sensitive operations such as merge execution, job claims and conflict resolution.

---

## 5. Workspace and authorization contract

Every request must execute in one resolved workspace context.

Never trust a workspace ID supplied by:
- public forms,
- provider callbacks,
- import files,
- REST body/query values,
- tracking requests,
- webhook payloads,
- BI requests,
- AI output.

Resolve tenant context from authenticated session/membership, scoped integration credential, signed public configuration/token, provider connection mapping, or another server-controlled source.

Authorization may combine:
- feature entitlement,
- active workspace membership/service identity,
- action permission,
- record scope,
- department/team relationship,
- source-module field restrictions,
- resource state.

For these modules use the repository's existing scope vocabulary. The expected TrueCRM concepts include OWN, DEPARTMENT, DEPARTMENT_TREE, TEAM and ALL/WORKSPACE where available.

A shared dashboard/report never widens source-data access.

---

## 6. Standard API contract

Public/versioned API base:

```text
/api/v1
```

Use the repository's established envelope if one already exists. If none exists, use:

Successful single resource:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Successful cursor list:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Human-readable explanation.",
    "details": null
  },
  "requestId": "correlation-id"
}
```

### Cursor pagination
Public list endpoints should use cursor pagination where practical:
- default page size: 50 unless repository convention defines another default;
- maximum page size: 200 unless the endpoint has a stricter documented limit;
- deterministic sort with stable tie-breaker;
- cursor treated as opaque;
- filters/sort fields explicitly whitelisted.

Do not expose arbitrary ORM column names or arbitrary SQL fragments.

### Idempotency
Operations that can create duplicate business effects support or require `Idempotency-Key`, including:
- record-creation operations exposed by integration APIs where applicable,
- import/export start,
- webhook replay,
- synchronization trigger,
- report export generation,
- attribution/backfill trigger where repeat execution would be costly or ambiguous.

Same key + same principal/workspace + equivalent request returns the prior result.
Same key reused with materially different input returns a stable conflict error.

---

## 7. Stable error-code rules

Reuse existing platform codes when equivalent. Add module codes only where needed.

Expected families include:

```text
PERMISSION_DENIED
WORKSPACE_CONTEXT_INVALID
FEATURE_NOT_ENTITLED
RATE_LIMITED
VALIDATION_FAILED
RESOURCE_NOT_FOUND
RESOURCE_CONFLICT
IDEMPOTENCY_KEY_REUSED

DUPLICATE_RULE_INVALID
DUPLICATE_GROUP_STALE
MERGE_TYPE_MISMATCH
MERGE_CONCURRENT_MODIFICATION
MERGE_PERMISSION_DENIED
MERGE_NOT_REVERSIBLE
QUALITY_FINDING_STALE

IMPORT_MAPPING_INVALID
IMPORT_PREVIEW_REQUIRED
IMPORT_ALREADY_STARTED
IMPORT_UNDO_NOT_SAFE
EXPORT_TOO_LARGE
EXPORT_ARTIFACT_EXPIRED

API_SCOPE_DENIED
CREDENTIAL_REVOKED
WEBHOOK_SIGNATURE_INVALID
WEBHOOK_REPLAY_DETECTED
WEBHOOK_DELIVERY_NOT_REPLAYABLE
SYNC_CONFLICT
SYNC_CHECKPOINT_INVALID

TRACKING_SOURCE_NOT_RESOLVED
ATTRIBUTION_MODEL_INVALID
ATTRIBUTION_RECALCULATION_IN_PROGRESS

REPORT_DATASET_DENIED
REPORT_DEFINITION_INVALID
METRIC_VERSION_NOT_FOUND
DASHBOARD_ACCESS_DENIED
SCHEDULED_REPORT_RECIPIENT_DENIED
BI_CREDENTIAL_REVOKED
ANALYTICS_STALE
```

Never leak whether a cross-workspace UUID exists.

---

## 8. Database and migration rules

Before schema changes:
1. Inspect current schema and migration history.
2. Never rewrite an already-applied migration.
3. Add a new versioned migration.
4. Preserve historical/versioned data.
5. Add indexes only for demonstrated access patterns defined by these specs.
6. Add uniqueness constraints for idempotency/external mapping/provider event keys.
7. Validate foreign-key tenant consistency in services and, where practical, database constraints.
8. Run schema validation/generation steps required by the repository.
9. Run targeted tests.
10. Run the full regression suite.

Never automatically run production migrations.

Large analytics schema/backfill changes must be deployable without blocking normal transactional writes for an unbounded period. Use staged migrations/backfills where necessary.

---

## 9. Event and outbox rules

Important domain transactions publish events through the existing transactional outbox.

Event envelope should include at least:
- event ID,
- event type,
- occurredAt,
- workspace ID from trusted context,
- resource type/ID,
- actor/service identity when applicable,
- correlation/request ID,
- schema/version.

Consumers must be idempotent.

These modules may consume existing CRM, Form, Communication, Marketing, Payment and Product events, but they must not mutate owning-domain tables directly.

Analytics and attribution projections may be rebuilt from authoritative state/events according to their specification.

---

## 10. Background jobs

Use one shared job infrastructure.

Every long-running operation records:
- stable job ID,
- workspace,
- job type,
- initiating actor/service,
- queued/running/succeeded/failed/cancelled/dead-letter state,
- progress counts where meaningful,
- retry count,
- checkpoint/cursor where applicable,
- started/completed timestamps,
- correlation ID,
- sanitized failure details.

Rules:
- retries only for retry-safe/transient failures;
- exponential backoff with jitter;
- default maximum automatic attempts: 5 unless a provider/job policy explicitly overrides;
- enforce concurrency limits by workspace/provider/job type;
- cancellation only at safe checkpoints;
- resumable jobs persist checkpoints;
- dead-letter failures are visible to authorized operators;
- retries and restarts must not duplicate domain side effects.

Long work includes duplicate scans, imports, exports, syncs, webhook delivery retries, marketing-cost imports, attribution recalculation, analytics backfills and report generation.

---

## 11. Security and secret handling

- Integration/API/provider secrets use the existing secure credential layer or an encrypted dedicated credential store.
- Never store raw reusable secrets in audit records, normal logs, analytics facts, webhook payload logs or report definitions.
- Raw API secrets are shown only at creation where applicable.
- Support revoke/rotate.
- OAuth refresh tokens are encrypted and refreshed server-side.
- Revocation takes effect immediately or within a documented small cache window.
- Signed callbacks verify signature/timestamp/provider identity before business processing.
- Provider-event IDs and replay protections prevent duplicate callbacks.
- Public tracking endpoints are rate-limited and validate input.
- CSV/XLSX imports are untrusted input.
- Spreadsheet formula injection must be neutralized on export where applicable.
- BI access never exposes production database credentials.
- Fuzzy duplicate matching never becomes an authorization bypass.

---

## 12. Audit rules

Use the platform's centralized append-only Audit service.

Critical mutation and audit evidence should commit atomically where they are part of one database transaction.

At minimum audit:
- duplicate rule/configuration changes,
- duplicate exclusion creation/removal,
- merge preview confirmation and merge execution,
- data-quality rule configuration and manual resolve/ignore actions,
- import start/cancel/undo/correction actions,
- export generation/download-sensitive events according to policy,
- API application/credential create/rotate/revoke,
- integration connection/mapping/conflict-resolution changes,
- webhook replay,
- source/manual-attribution overrides,
- attribution setting/model/version changes,
- report/dashboard sharing changes,
- KPI target changes,
- scheduled report changes,
- BI credential create/revoke.

Audit payloads are sanitized and never contain usable secrets.

Audit is separate from CRM Timeline, notifications and operational logs.

---

## 13. Retention and deletion

Use central retention policy rather than scattered hard-coded purge logic.

Confirmed baseline:
- generated export artifact: default 24-hour availability;
- import/export operational metadata: default 180-day retention;
- detailed webhook/integration payload logs: default 90-day retention;
- merge evidence and critical audit: retain with relevant business history subject to workspace/legal policy;
- analytics facts: retention aligned with authoritative source/business policy;
- retention purge itself is audited.

Configuration records should normally archive/disable rather than hard-delete if historical results depend on them.

Historical model/version references must remain resolvable.

Legal hold/platform policy overrides ordinary purge.

---

## 14. Entitlements and quotas

These modules consume the existing Subscription/Entitlement service.

Never hard-code plan names.

Capabilities/limits may control:
- maximum import rows/file size,
- concurrent imports/exports,
- export size,
- API request quotas/rate tier,
- API applications/credentials,
- integration connection count,
- webhook subscription count,
- synchronization frequency,
- native attribution/provider connections,
- scheduled reports,
- BI access,
- report/export limits.

Entitlement denial must be distinct from permission denial.

Downgrades do not silently delete business data.

---

## 15. Observability and operator support

All jobs/provider calls should use:
- correlation/request IDs,
- structured logs,
- metrics,
- traces where the platform supports them,
- provider/queue/analytics lag health,
- sanitized failure metadata.

Authorized operational views/APIs must expose:
- import/export jobs and row errors,
- webhook deliveries/replay state,
- integration health,
- sync runs/checkpoints/conflicts,
- provider events,
- duplicate scans,
- quality scans,
- analytics freshness,
- failed report jobs,
- background-job status.

Do not expose secrets or unrestricted provider payloads.

---

## 16. Testing execution mode

`Testing/` contains executable Jest-style contract scaffolds intentionally failing until wired to the real repository.

For the requested goal:
1. Read matching specification(s).
2. Read matching test contract(s).
3. Adapt imports/setup/factories to the repository's test framework.
4. Replace each `contract()` failure with real implementation assertions.
5. Do not delete, skip, weaken or convert required tests to `todo`.
6. Run targeted unit/service tests.
7. Run integration/database tests.
8. Run API E2E tests.
9. Run permission-negative tests.
10. Run cross-workspace isolation tests.
11. Run concurrency/idempotency tests.
12. Run worker/job retry tests where applicable.
13. Run security/secret-redaction tests.
14. Run full repository regression.
15. Fix all regressions caused by the implementation.

Provider integrations:
- unit/integration tests use deterministic fakes/mocks;
- provider adapters must be contract-tested;
- do not claim real provider connectivity if only mocks were used;
- if staging credentials exist, document the exact manual/staging smoke checks still needed.

---

## 17. Definition of FINISHED

A requested goal may be reported as:

```text
<Goal> — FINISHED
```

only when all applicable conditions are true:

- requested behaviors implemented,
- repository conventions respected,
- schema/migrations validated when changed,
- compile/typecheck passes,
- lint passes if configured,
- unit/service tests pass,
- integration/database tests pass,
- API E2E tests pass,
- authorization negative tests pass,
- cross-workspace isolation tests pass,
- idempotency/concurrency tests pass,
- job retry/dead-letter tests pass where applicable,
- audit assertions pass,
- security/secret-redaction tests pass,
- analytics/attribution reconciliation tests pass where applicable,
- full existing regression suite passes,
- no known regression remains,
- no unrelated refactor was bundled,
- final diff was reviewed for scope.

Final implementation report must state:
1. What was implemented.
2. Schema/migration changes.
3. Permission keys added/used.
4. Events/outbox messages added.
5. Audit events added.
6. Background jobs/workers added or changed.
7. Tests run and exact results.
8. Provider/staging/manual checks still required.
9. Known limitations/blockers.
10. Directly necessary cross-module changes.

Never claim a behavior was tested if it was not exercised.

---

## 18. Git behavior

By default:
- do not commit,
- do not push,
- do not create a pull request.

Perform Git publishing actions only when explicitly requested by the human partner.

Keep changes scoped to the requested goal and directly necessary cross-module dependencies.
