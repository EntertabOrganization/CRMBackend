# Autonomous Codex Implementation Prompt

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

**Build the entire TrueCRM Commercial, Capture & Contact Center specification pack in the current repository.**

You are the implementation agent. Work autonomously through implementation, review, testing, repair and retesting. Do not stop after planning.

## Mandatory starting sequence

1. Read `Agent.md` completely.
2. Read `README.md` and `DECISIONS.md`.
3. Read **all module specifications** in:
   - `Estimates-Invoices-Payments/`
   - `CRM-Forms-Capture/`
   - `Contact-Center/`
   - `Company-Details-Requisites-Bank/`
4. Read `REQUIREMENT_TRACEABILITY.md`.
5. Read all executable contract tests under `tests/modules/Commercial_Capture_ContactCenter/`.
6. Inspect the real repository before changing anything: architecture, existing modules, database schema/migrations, authorization, Workspace resolution, outbox/events, queues/jobs, files, CRM, products, audit, integrations, tests and package scripts.

## Execution requirement

Implement the complete requested pack according to the specifications and the repository's established conventions. Do not invent a parallel architecture when a compatible repository pattern already exists.

Implement directly necessary cross-module changes when required to satisfy the contract. Do not perform unrelated refactors.

For every module:

1. implement database/schema changes with new versioned migrations;
2. implement entities/domain/application services;
3. implement controllers/API contracts where specified;
4. implement validation and stable errors;
5. implement Workspace tenant isolation and permissions/scopes;
6. implement transactions and concurrency protection;
7. implement audit/history;
8. implement outbox/events/jobs/retries/idempotency where specified;
9. implement provider/channel adapters using secure abstractions;
10. preserve immutable historical snapshots;
11. wire the relevant `tests/modules/Commercial_Capture_ContactCenter/` contract tests to real code and assertions.

## Test-and-fix loop

After implementing a logical module:

1. run typecheck/build;
2. run its unit/service tests;
3. run database/integration tests;
4. run API E2E tests;
5. run permission-negative and cross-Workspace tests;
6. run concurrency/idempotency tests where applicable;
7. inspect every failure;
8. fix the underlying implementation or test wiring problem;
9. rerun until the targeted suite is green.

Do **not** delete, skip, weaken, comment out or convert required contract scenarios to `todo` merely to make tests pass.

## Mandatory second review

When the initial implementation is green, review the code against every relevant specification and acceptance criterion again.

Specifically look for:

- missing or incorrect Workspace scoping / IDOR exposure;
- wrong permission or scope checks;
- financial calculations using unsafe floating point;
- invoice/payment/refund race conditions;
- duplicate provider events creating duplicate effects;
- provider callbacks trusted without verification;
- form retry creating duplicate CRM entities;
- form/public payload choosing privileged Workspace/entity IDs;
- issued Estimate/Invoice values changing after Product/Requisite edits;
- missing audit/outbox events;
- missing transaction boundaries;
- Contact Center duplicate inbound/outbound messages;
- transfer history loss;
- routing to unavailable/over-capacity agents;
- SLA calculation ignoring work hours;
- sensitive bank information leaking through APIs/logs/search/events;
- migrations without required constraints/indexes/backfills;
- tests that pass without actually asserting the required behavior.

If you find **anything wrong or incomplete**, fix it immediately and rerun the affected tests.

## Final regression loop

After the review fixes:

1. run the full repository test suite;
2. run lint/format/typecheck/build commands configured by the repository;
3. fix every regression caused by this work;
4. rerun the complete suite;
5. repeat until everything relevant is green or a genuine external blocker remains.

Do not claim FINISHED while a known implementation/test regression remains.

## Provider smoke tests

Use deterministic mocks/fakes for automated Stripe, XPay, messaging, email, telephony and other external-provider tests.

If real staging credentials or provider environments are unavailable, do not block automated completion. Report the exact manual/provider smoke tests that remain. Never claim those real-provider tests were executed when they were not.

## Final response

Only after the implementation/review/test/fix loop is complete, report:

```text
TrueCRM Commercial, Capture & Contact Center — FINISHED
```

Then provide:

1. modules implemented;
2. major files changed;
3. database migrations/schema changes;
4. permissions/scopes added or reused;
5. events, audit actions and jobs added;
6. provider/channel adapters implemented;
7. tests executed and exact results;
8. defects found during review and how each was fixed;
9. remaining manual smoke tests;
10. known limitations/blockers;
11. directly necessary cross-module changes.

Do not commit, push or open a PR unless I explicitly ask you to do so.
