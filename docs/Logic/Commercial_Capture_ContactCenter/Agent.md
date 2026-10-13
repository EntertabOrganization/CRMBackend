# TrueCRM Commercial, Capture & Contact Center — Agent Execution Contract

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Purpose

This is the master execution contract for an AI coding agent implementing the confirmed TrueCRM capability pack covering:

1. Estimates, Invoices & Payments
2. CRM Forms & Capture
3. Contact Center & Channels
4. Company Details, Requisites & Bank Data

Read this file **first**, then read every specification and executable contract test relevant to the requested goal.

The human partner must be able to give a goal such as:

```text
Complete Estimates
Complete Invoices
Complete Payments
Complete CRM Forms & Capture
Complete Contact Center
Complete Company Details, Requisites & Bank Data
Complete the whole TrueCRM Commercial/Capture/Contact Center pack
```

The agent must inspect the real repository, understand existing conventions, implement the requested scope completely, wire the contract tests to the repository, run tests, review failures and the diff, fix defects, rerun tests, run the full regression suite, and only then report the goal as FINISHED.

Do not stop after producing a plan. Continue autonomously unless there is a genuine product decision not settled by this pack, an unavailable external credential required for a real-provider smoke test, or a destructive production action requiring human authorization.

---

## 1. Source priority and locked decisions

If sources conflict, use this priority:

1. latest explicit human decision
2. confirmed interview decisions in `DECISIONS.md`
3. this `Agent.md`
4. module specifications in this pack
5. TrueCRM PRD / BRD / System Architecture
6. existing repository behavior where it does not contradict locked business behavior
7. reference-pack conventions
8. implementation recommendation

The reference Bitrix24 API documentation is a behavioral/reference source only. TrueCRM is **not** a Bitrix clone and must not inherit legacy API shapes, deprecated methods, IDs, or internal implementation constraints merely because Bitrix uses them.

---

## 2. Architecture contract

### Platform direction

- HTTP/runtime conventions: follow the repository's existing server-side TypeScript and `/api/v1` route-handler architecture.
- Backend implementation only; the repository's frontend stack is explicitly outside this pack's scope.
- Initial architecture: modular monolith with strict domain-module boundaries.
- PostgreSQL is the transactional business source of truth.
- Redis is for cache, temporary/shared ephemeral state, rate limits and appropriate realtime coordination; Redis is not the source of business truth.
- Files use S3-compatible object storage with PostgreSQL metadata.
- Long-running or retryable work runs through background workers/queues.
- Realtime delivery may use WebSocket/SSE, but durable state must already be committed before fanout.
- Search, analytics, counters, timeline projections and AI-derived data are rebuildable views.
- Use the repository's established ORM/data-access layer. Do not introduce a new ORM merely because a reference pack used one.

### Module ownership

A module may read another module through an approved query/application service but must not perform cross-module writes by directly mutating foreign tables.

Examples:
- CRM Forms calls CRM domain services to create/update Contacts, Companies, Leads, Deals and Estimates.
- Payments calls Invoice application services to apply allocations/status changes.
- Commercial documents call Requisite/Snapshot services for legal identity snapshots.
- Contact Center calls CRM matching/binding services; it does not write CRM records directly.

### Tenant boundary

- Workspace is the tenant boundary.
- CRM Company is not a Workspace.
- Every business row is directly workspace-scoped or inherits workspace through a strongly validated parent.
- Resolve Workspace from authenticated/server context.
- Never trust a public form, webhook, browser field, provider callback or AI output to choose an authoritative `workspaceId`.
- All cross-workspace relationships are rejected.
- UUID knowledge never bypasses authorization.

---

## 3. Repository-first execution

Before editing code:

1. Read this file completely.
2. Read `README.md`, `DECISIONS.md`, and the matching module specification(s).
3. Read the matching files under `tests/modules/Commercial_Capture_ContactCenter/`.
4. Inspect `package.json` and workspace/package layout.
5. Inspect NestJS modules, controllers, services, DTOs, guards, interceptors and naming conventions.
6. Inspect database schema and every relevant existing migration.
7. Inspect the repository's ORM/query layer.
8. Inspect existing Workspace resolution and permission/scope implementation.
9. Inspect existing transactional/outbox/job patterns.
10. Inspect existing Audit, Files, CRM, Products, Automation, Notifications and Integration abstractions.
11. Inspect test runner, factories, database-test setup and E2E bootstrap.
12. Identify directly necessary cross-module changes before editing.

Do not invent repository state.

If repository implementation details differ from a suggestion in this pack but preserve the specified behavior, follow the repository convention. If the repository conflicts with a locked business rule, do not silently compromise the business rule; surface the conflict as a blocker after implementing everything that is not blocked.

---

## 4. API conventions

Base prefix:

```text
/api/v1
```

Use the repository's established response envelope. If no envelope exists, use:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Error fallback:

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

### List/query behavior

Unless an existing repository convention is already established:

- use cursor pagination for externally exposed V1 list endpoints;
- default limit 50, maximum 100;
- explicitly whitelist searchable fields;
- explicitly whitelist sortable fields;
- explicitly whitelist filters/operators;
- never expose arbitrary database/ORM field names;
- preserve stable deterministic ordering by adding an ID tie-breaker;
- all list queries must enforce Workspace + permission scope before pagination.

Common operators may include `eq`, `neq`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`, `isNull` where meaningful for the field type.

### PUT/PATCH

If both are exposed:
- `PUT` replaces the editable representation and requires all required editable fields.
- `PATCH` changes only supplied fields.

### Idempotency header

For endpoints marked idempotent, accept the repository-standard idempotency mechanism. If none exists, use:

```text
Idempotency-Key: <opaque client-generated key>
```

Scope stored keys by Workspace + operation + caller/client where applicable. Replays with the same key and same normalized request return the same business result; the same key with a materially different request returns `IDEMPOTENCY_KEY_REUSED`.

---

## 5. Money, precision and time

- Never use binary floating point for money.
- Persist precise amounts with PostgreSQL `NUMERIC`/repository decimal type.
- Store currency explicitly using a stable ISO-style code.
- Define rounding per currency/price/tax policy and centralize it; do not round inconsistently in controllers.
- Server recalculates commercial totals from validated line data.
- Real instants use timezone-safe timestamps (`timestamptz` semantics).
- Date-only business values such as an invoice due date may use `DATE` when no time-of-day is intended.
- Recurrence retains the applicable IANA timezone.

---

## 6. Historical immutability and snapshots

Historical commercial/legal facts must not drift when master data changes.

Issued/sent artifacts snapshot applicable:
- buyer legal identity
- seller legal identity
- selected addresses
- selected bank details when displayed/required
- product/manual line description
- unit/quantity
- prices
- discounts
- taxes
- totals
- currency

Do not implement historical documents as live joins that change when current Product, Company, Requisite, Address or Bank records change.

Corrections create revisions, adjustments, void/reissue actions, refunds or credit history as specified. Do not rewrite prior successful history.

---

## 7. Authorization and permissions

Authentication never implies module authorization.

Authorization resolves:

```text
Authenticated User
∩ Active Workspace Membership
∩ Feature/Subscription Entitlement where configured
∩ Action Permission
∩ Scope (OWN / DEPARTMENT / DEPARTMENT_TREE / TEAM / ALL as applicable)
∩ Resource-specific state/rules
∩ Sensitive-field permission
```

Permission keys are defined per module. Use the existing permission registry if present.

Sensitive examples:
- `invoice.issue`
- `invoice.void`
- `payment.record`
- `payment.refund`
- `form.publish`
- `conversation.transfer`
- `bank_data.view`
- `bank_data.manage`

Field masking is not a substitute for authorization. Unauthorized users must not receive sensitive bank data through API response, search index, log, event payload, export or AI context.

---

## 8. Audit and history

Use the platform's centralized append-only audit capability where present.

Audit important/sensitive operations, including applicable:
- Estimate sent/revised/accepted/declined/conversion
- Invoice issue/void/cancel/correction
- manual Payment and allocation
- Refund
- Requisite and Bank Data changes
- sensitive Bank Data access if platform policy enables read-access auditing
- Form publish/unpublish/security/capture configuration changes
- Contact Center assignment/transfer/channel credential or routing configuration changes

Audit entries must contain actor/service identity, Workspace, action, resource type/id, timestamp, correlation/request ID, and sanitized before/after/context where useful.

Never store usable secrets, raw access tokens, provider credentials, full card data or unnecessary bank secrets in audit payloads.

Audit is different from CRM Timeline. A business action may emit both an audit event and a customer-visible/internal timeline projection for different purposes.

---

## 9. Domain events, outbox and async work

For important state changes, commit domain state and transactional outbox event in the same database transaction.

Typical consumers:
- Timeline
- Automation
- Notifications
- Search
- Analytics
- Realtime
- outgoing webhooks

Consumers must be idempotent.

Long work runs as jobs, including applicable:
- Form submission processing
- file scanning/finalization
- recurring Invoice occurrences
- provider retries/reconciliation
- delivery retries
- heavy document generation
- AI transcription/summarization

Classify failures:
- transient -> retry with backoff and bounded attempts;
- permanent/business -> stop without blind retry;
- exhausted retry -> visible failed/dead-letter state.

Operators must be able to inspect failures and safely retry where the operation supports it.

---

## 10. External/provider event safety

All external/provider callbacks are untrusted until verified.

Where supported:
- verify signature/authentication using the provider adapter;
- validate expected Workspace/connection/provider binding server-side;
- persist provider event identity;
- enforce uniqueness/idempotency;
- validate amount/currency/object reference for payment events;
- reject replay/mismatch;
- never treat a browser redirect as proof of payment;
- never trust provider payload to select a different tenant.

Contact Center provider events use provider/connection + external event/message identifiers for dedupe.

---

## 11. Public Forms and upload security

Public form endpoints use server-resolved public form references, not privileged internal IDs from the request body.

Apply layered controls appropriate to the endpoint:
- rate limits
- request/body/file size limits
- CAPTCHA/spam adapter when configured
- field/schema validation
- allowed file type/MIME checks
- temporary/quarantine storage
- malware/security scanning through shared Files service
- signed/expiring upload references
- safe redirect validation
- abuse/security logging

A submitted form is stored durably before asynchronous CRM capture processing begins.

---

## 12. Deletion, archive and retention

Prefer business lifecycle/archive/deactivation over destructive deletion for records with history.

Never hard-delete a record when doing so would destroy required:
- issued commercial history
- payment/refund history
- submission traceability
- conversation/message history under active retention policy
- legal identity snapshot evidence
- audit history

Requisite and Bank records referenced historically are archived/deactivated, not physically removed.

Retention is configurable by data category. Do not invent one global retention duration for all modules.

If existing platform retention rules are stricter, preserve them.

---

## 13. Database and migrations

Before schema changes:
1. inspect schema and relevant migrations;
2. use the repository's migration system;
3. never rewrite already-applied production migrations;
4. create a new versioned migration;
5. add safe constraints/indexes;
6. plan backfills when a new non-null invariant affects existing rows;
7. validate generated schema/client code if applicable;
8. run affected tests;
9. run regression tests.

Never automatically apply production migrations.

Development, staging and production must have isolated data, credentials and provider configuration.

Concurrency-sensitive operations require database-safe handling, particularly:
- invoice numbering
- payment allocation/balance changes
- refund available amount
- provider-event dedupe
- recurring invoice occurrence creation
- queue assignment/capacity decisions where races matter

Use transactions, row/version locking, unique constraints or atomic update patterns as appropriate.

---

## 14. Integration adapters

Provider-specific details remain behind interfaces/registries.

Initial payment adapters:
- Manual
- Stripe
- XPay
- Generic extension contract

Contact Center channels use normalized connector interfaces for inbound events, outbound send, delivery/read events and capability discovery.

Automated tests use deterministic mocks/fakes. Do not claim real Stripe/XPay/WhatsApp/email/telephony behavior was smoke-tested if only mocks were run.

Provider credentials belong in the secure secrets/configuration layer, never ordinary business rows or source control.

---

## 15. Testing execution mode

`tests/modules/Commercial_Capture_ContactCenter/` contains executable Jest-style contract tests that intentionally fail until wired to the real repository.

For the requested scope:
1. read the matching specifications;
2. read all matching contract tests;
3. adapt imports/setup/factories to the real repository and existing runner;
4. replace each `contract()` failure with real assertions;
5. never delete, skip, weaken, comment out or convert a required scenario to `todo` merely to get green;
6. implement the behavior;
7. run targeted unit/service tests;
8. run database/integration tests;
9. run E2E/API tests;
10. run authorization-negative and cross-Workspace isolation tests;
11. run concurrency/idempotency tests where required;
12. run TypeScript/build/lint checks configured by the repo;
13. run the full repository regression suite;
14. review failures and the final diff;
15. fix defects and repeat until green.

If the repository uses Vitest or another established runner, translate the contract tests instead of introducing a second test framework.

---

## 16. Definition of FINISHED

The agent may report:

```text
<Goal> — FINISHED
```

only when every applicable condition is true:

- required functionality is implemented;
- module boundaries are respected;
- database schema/migrations are valid;
- build/typecheck passes;
- lint passes if configured;
- validation is implemented and tested;
- permissions/scopes are implemented and tested;
- cross-Workspace isolation is tested;
- important audit events are implemented and tested;
- outbox/events/jobs are implemented and tested where specified;
- idempotency/concurrency cases are tested where specified;
- provider adapters are mocked deterministically in automated tests;
- target unit/integration/E2E tests pass;
- full existing regression suite passes;
- no required test was skipped/deleted/weakened;
- final diff was reviewed for unintended changes;
- no known regression remains.

Final report must contain:
1. implemented scope;
2. files/modules changed;
3. schema/migrations changed;
4. permissions added/used;
5. events/audit/jobs added;
6. tests executed with exact pass/fail results;
7. failures discovered during review and how they were fixed;
8. manual/provider smoke tests still required;
9. known limitations/blockers;
10. directly necessary cross-module changes.

Never say functionality was tested if it was not actually exercised.

---

## 17. Review-and-repair loop

After the first implementation reaches green targeted tests, the work is **not yet done**.

Perform a second review pass:
- compare the implementation line-by-line against the relevant specifications and acceptance criteria;
- inspect authorization paths for tenant/IDOR leaks;
- inspect mutation paths for missing transactions/outbox/audit;
- inspect retries for duplicate side effects;
- inspect monetary calculations and snapshot stability;
- inspect migrations/constraints/indexes;
- inspect tests for false positives or missing negative cases;
- inspect error handling and provider mismatches.

If any defect is found:
1. fix it;
2. rerun targeted tests;
3. rerun affected integration/E2E tests;
4. rerun full regression suite;
5. repeat review until no known specification mismatch remains.

Do not ask the human merely because a test fails. Investigate, repair and retest autonomously when the expected behavior is already specified.

---

## 18. Git behavior

By default:
- do not commit;
- do not push;
- do not create a PR.

Only perform Git publication actions when explicitly requested.

Do not rewrite unrelated history, force-push, or include unrelated refactors.
