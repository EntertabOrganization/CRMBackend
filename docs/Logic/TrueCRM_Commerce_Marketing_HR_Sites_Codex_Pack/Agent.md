# TrueCRM Four-Module Pack — MASTER AGENT EXECUTION CONTRACT

> **READ THIS FILE FIRST, COMPLETELY, BEFORE ANY CODE CHANGES.** This pack is an approved implementation specification, not a replacement application. It covers Commerce, Marketing Campaigns, HR/Time Tracking and Sites/Landing Pages, with shared platform contracts.

## Mission and completion mandate

For an instruction such as `Implement OnlineStore-Commerce` or `Implement the whole pack`, inspect the target repository, read all relevant specs under the module directory and `Shared-Contracts`, wire the fail-closed tests from `Testing`, implement backend and Next.js frontend, run migrations/tests and fix regressions. Do not stop after describing a plan if implementation is possible. Do not claim completion where credentials, dependent platform modules or deployment access are genuinely missing.

## Precedence / architecture

1. Latest approved user decisions Q1–Q76 in `Decision-Traceability.md` and the Shared Understanding report.
2. Existing confirmed TrueCRM BRD/PRD/System Architecture definitions.
3. Real repository code and conventions where business rules aren't changed.
4. Reference ZIP structural quality only; **do not** copy TrueAgent/Auth-only business rules.
5. Shared specs in this pack and conservative implementation defaults. New conflict affecting approved behavior => document and ask rather than assume.

Fixed architecture: **Next.js+TypeScript frontend**, **NestJS+TypeScript modular monolith backend**, **PostgreSQL truth**, **Redis cache/ephemeral state**, **background queues/workers**, **S3-compatible file storage**, **WebSocket/SSE only where needed**, **provider adapters**. Start with PostgreSQL full-text search. No extra Python/LangChain backend, independent microservice or second inventory/payment truth by default. Reuse existing repo ORM, migrations, guards, DTO and test framework; don't assume Prisma simply because the structural reference used it.

## Mandatory repository-first sequence

1. Check root workspace and relevant `package.json`, lockfile, Next.js and NestJS bootstraps, scripts, tsconfigs, CI and env patterns.
2. Map current modules and real provider integrations: Auth, Workspace/Org/Permissions, CRM, Catalog, Inventory, Payments/Invoices, Files, Calendar, Workflow, Analytics, Sales Intelligence, Contact Center, AI, Subscription, Jobs/Audit.
3. Inspect relational schema/ORM, deployed migrations and existing tests; avoid duplicate tables or incompatible redefinitions.
4. Read `Shared-Contracts/12-compatibility-and-decisions.md`, module specs, dependency map and matching contract tests. Produce a brief gap map inside the repo implementation report, not a substitute for execution.
5. Implement in controlled slices with migrations and tests; avoid unrequested unrelated refactors. When dependency not implemented, add documented typed seam and deterministic fake used only in tests, keep real feature blocked until integrated.

## Naming, API and persistence

- Business records workspace-scoped; `workspace_id` SQL, UUID IDs, `camelCase` TypeScript and `snake_case` database as fallback if repository has no better established convention. Cross-resource relations same workspace.
- `/api/v1` prefix; uniform success/error envelope and correlation ID. See `Shared-Contracts/01-api-and-query-conventions.md`.
- `GET` list default `page=1`, `limit=20`, max `100`, allowlisted search/sort/operators; status and temporal event feeds may use cursor pagination. No client-supplied SQL/ORM field paths.
- `NUMERIC` money/quantities; `timestamptz` real instants; `DATE` local day with IANA zone. Audit and commercial snapshots immutable; HR raw work events versioned/corrected via new records.
- DB schema changes by **new** versioned migration; never rewrite applied migrations; run validation/regeneration and test migration on clean/staging-like database. Do not execute production migration automatically.
- Write authoritative business changes, append-only audit and transactional outbox in the same transaction. Async consumers idempotent, retryable and recoverable; never treat Redis/realtime/search as durable truth.

## Identity, authorization, tenant isolation

- Authenticate internal employee as global User; authorize with active workspace membership + role grant(s) + scope + resource state + field/stage policy + entitlement + feature rollout. Do not assume 'one role' globally: follow actual Org/Permissions policy.
- Storefront customer identity and guest order link remain separate public/customer realms; they **do not** grant TrueCRM workspace membership.
- Restrict sensitive operations: refund, merchant config, campaign bulk send/export, HR confidential fields/corrections/override, domain publish, script approval, retention purge.
- Integrations/workflows/AI run under explicit service authority and call narrow typed owning module operations; NEVER direct other module table mutation or superuser bypass.
- Same-tenant and cross-tenant malicious references are tested even when UUID looks valid; any cross-workspace relation attempt must fail safely.

## Business rules by domain

- **Commerce:** Store/Order/Cart/Shipment/Return owned here; Catalog product truth, Inventory movement/reservation truth and commercial Payment/Refund truth in their original services. Browser return URL is never payment confirmation. No overselling without explicit backorder; reserve TTL and expiry; order history immutable commercial snapshots; partial fulfillments/returns and late paid/no-stock exceptions.
- **Marketing:** static/dynamic segments; frozen audiences; send-time consent and suppression; provider sender verification and channel-specific retry; versioned approved content; open-tracking imprecision acknowledged. Workflow owns durable marketing journeys; Sales Intelligence owns attribution.
- **HR:** EmployeeProfile != Auth User; effective-dated schedules, employee timezone, immutable clock events, correction approval, timesheet locks, leave ledger/holds, confidentiality. Task hours do NOT equal attendance. No payroll by scope.
- **Sites:** managed hosting/verified domains, block editor, drafts vs immutable live release, approval/rollback, page localization/RTL, connected Forms/Commerce widgets, scripts/consent controls. An AI-generated draft never publishes automatically.

## Security, provider and operations

- Never log/output secrets, tokens, private financial account/card data, raw marketing destinations, employee sensitive reasons or unrestricted customer data. Encrypt sensitive values and use centralized secret manager.
- Validate/sanitize provider callbacks and imports, sign and deduplicate webhooks, protect SSRF/XSS/CSRF/open redirects, scan uploads and enforce file ACL intersections, domain ownership verification, CSP/script allowlists and rate limits.
- Stripe, XPay, SMTP/SES, Twilio SMS/voice, Meta WhatsApp and Meta/Google audience/metrics adapters are target integrations; feature availability depends on actual credentials/provider approval. Mocks alone are not production completion.
- No globally invented statutory tax rates, HR accrual thresholds, legal retention days or consent jurisdiction conclusions. Policy must be configured/validated before enabling applicable features. Default subscription grace = configurable 15 days.
- Correlation IDs, structured redacted logs, tracing, health probes, audit, outbox lag, worker DLQ/retries and recovery are required for each module.

## Testing execution contract

- `Testing/` contains TypeScript/Jest-compatible **fail-closed contract tests**. They are deliberately not pre-wired to any repository. Wire them to real NestJS requests/DB state in the repo and retain all intended assertions. See `Testing/README.md` and `_harness`.
- Do not skip/delete/weaken tests or replace them with tautological mocks to make them green. Unit + integration + E2E + negative auth + cross tenant + concurrency + provider failures + state/audit + frontend smoke/accessibility.
- Mock providers only for deterministic automated behavior; separately record live staging smoke for Stripe/XPay, SES/SMTP, Twilio, WhatsApp and advertising APIs if configured.
- For any substantial issue: reproduce red test -> implement -> run targeted tests -> regenerate/build -> run regression suite -> review diff. Running tests must be reported with exact command and outcome.

## Definition of DONE and handoff

A named module is **FINISHED** only if backend domain+API, frontend UI, DTO/schema/permissions, migrations, typed integrations, audit/events, job handling, README/env changes, error/edge behavior and all applicable real automated tests are complete; dependency contracts integrated or explicitly blocked. Full-pack FINISHED only when all target features, including advanced phase, have working code or a clearly marked incomplete blocker in the report (not a misleading all-green claim).

Report: implemented files/features; migrations; new permissions; events; test commands/pass counts; staging provider status; performance/security checks; unresolved dependency/credential blockers; unrelated changes avoided; remaining external manual verification. **No Git commit, push or PR by default**. Only commit/push if explicitly requested. Do not import irrelevant PR instructions from the unrelated reference pack.
