# TrueCRM — Commerce, Marketing, HR & Sites — Codex / Claude Code Specification Pack

**Status:** Approved Shared Understanding Report; 76/76 decisions confirmed in six rounds. **This ZIP is a specification/test contract, not the implemented application.**

## First command to a coding agent

> Read the complete `Agent.md`, `Decision-Traceability.md`, `Shared-Contracts/*`, all relevant module specs, and `Testing/README.md`; inspect the existing TrueCRM repository; implement the requested modules with backend, frontend, integrations and real tests. Follow module boundaries and report genuine dependency/provider blockers. Do not merely generate scaffolds or skip tests.

## Structure

- `Agent.md`: **required first read**, architecture, conventions, security, implementation sequence and definition of done.
- `Agents/`: role-specific instructions for Orchestrator, Backend, Frontend, Integrations, QA, Security, Release.
- `OnlineStore-Commerce/`: standalone store, catalog publication, accounts, carts, order/payment/inventory/fulfillment, returns, promotions, digital delivery, CRM links and analytics.
- `Marketing-Campaigns/`: segments/imports, consent, providers, content, approvals, delivery, engagement, experiments, journeys and ad sync.
- `HR-TimeTracking/`: employee profiles, scheduling, attendance, timesheets, overtime, leave, work reports, docs/lifecycle, privacy/reporting.
- `Sites-LandingPages/`: sites/domains, pages/CMS, blocks, publication, localization, SEO, Forms/Commerce, scripts/consent, experiments, AI, recovery.
- `Shared-Contracts/`: common APIs, security, source-of-truth, states/events, providers, observability, frontend, tests, phases and compatibility.
- `Testing/`: a fail-closed contract test for **every** module specification, four module E2E suites, a cross-module E2E suite, and portable integration harness.
- `Decision-Traceability.md`: Q1–Q76 -> requirement -> owned module file.
- `Sources/README.md`: which attached documents and Bitrix24 pages informed the pack.
- `manifest.json`: generated inventory with exact paths/hashes. Confirmed only real files, no dangling references.

## Implement one module

1. Read Agent.md, then Shared-Contracts, then that module's relevant specs and matching Testing files.
2. Inspect the existing repository's Auth, Workspace, CRM, Catalog, Inventory, Payments, Workflow, Billing and Files implementations and record adapters that exist/miss.
3. Start with database/DTO/domain service, policy enforcement, immutable histories/outbox, API and producer/consumer adapters; connect Next.js workflows with permission-aware UI.
4. Wire contract tests to the real app and migrated isolated DB and use provider fakes for deterministic failure tests. Run compilation, lint, targeted unit/integration/E2E, cross-tenant tests and full regression.
5. Report what is implemented vs blocked, provider staging verification, migrations and audit/permission keys. Do not mark an external live provider as complete if only mocks were exercised.

## Implement all four modules

Follow dependency build order in `Shared-Contracts/11-release-phases-and-dependencies.md`, integrating each Core V1 slice before advanced features; run full cross-module regression at each milestone. Domain ownership does not change when underlying foundational module is missing; code against typed contracts and explicitly mark the blocker. Do not auto-deploy or commit/push without user request.

## Expected outputs from the coding agent

Implemented features, schema migrations, typed APIs, Next.js screens, provider integrations, permission keys, audit/outbox events, deployment/environment notes, passing actual tests (with commands and totals), and honest manual staging/provider checks and blockers.

## Important boundaries

Commerce Orders are separate from CRM Deals and Payments; HR Employees separate from User auth; Marketing delivery separate from Sales Intelligence attribution; Sites drafts separate from public releases. Additional market-specific taxes, leave entitlements, consent and legal retention values are **explicit required configuration**, not universal hard-coded guesses. Site managed-hosting support does not promise a portable standalone runtime export.

## Repository location of the Testing pack

Per the repository `AGENTS.md`, executable tests do not live in documentation folders. The `Testing/` pack now lives in `tests/modules/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack/` with its structure and assertions preserved. `_harness/adapter.ts` defaults to the repository binding `tests/support/truecrm-contract-adapter.ts` (owned disposable PostgreSQL database `truecrm_suite_contract_test`, real route handlers, deterministic provider fakes).
