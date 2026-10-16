# Test environment, CI, deployment and observability

## Test categories

- Unit: domain arithmetic, predicate/ACL, state graph, schema validation.
- Repository integration: real PostgreSQL constraints/locking, outbox+audit transaction, idempotency, query scopes, provider receipt, debit ledger.
- Worker integration: BullMQ retry/DLQ/restart, scheduled occurrence, cancellation, exactly-once effect.
- HTTP E2E: valid/invalid/unauthorized/other tenant; production controller/middleware and database.
- Provider contract: Stripe/XPay sandbox verified events and redelivery; AI provider route/fallback/timeout; no network in unit tests.
- Security: prompt injection, stale ACL, signed links, Partner delegation revocation, export data leakage, support bypass, signature/SSRF.

## Required test trace

Every `Testing/<Module>/<slug>.spec.ts` references at least AC01..AC05 in matching specification. Shared S01..S04 cover tenant isolation, denied side effects, idempotency and audit/outbox. `Testing/<Module>/<Module>.e2e-spec.ts` tests full actor journey; `Testing/CrossModule/cross-module.e2e-spec.ts` covers the five module seams.

The fail-closed harness must be connected to **actual repository** fixtures. `CONTRACT_NOT_WIRED` is an expected failure until then. Do not add mocks that assert their own hard-coded return value. Report unit/integration/E2E separately. CI must run real Postgres + Redis services (test-only or ephemeral), migration up/down verified where repository supports, and provider sandbox tests in separately gated job.

## Operations

Structured logs with requestId and correlationId; alert on queue/outbox lag, dead letters, provider failure, reconciliation discrepancy, unauthorized AI tool proposals, credit exhaustion and suspicious Partner relation transfers. No secrets or prompts in logs. Encrypted backups and isolated restore drills. Release with staged flags and rollback procedure; production migrations require human-controlled deployment step.
