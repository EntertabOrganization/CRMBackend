# Implementation progress — TrueCRM_Final_Modules_Codex_Pack

> User-authorized tracking file (latest user instruction supersedes the AGENTS.md "no progress files" rule).
> Every agent (Claude or Codex) continuing this work: read this file first, continue at the first unchecked item,
> update it after **each** change and commit + push to `main` immediately so work survives credit limits.
> Testing is deliberately deferred: see `TESTING_REMAINING.md`. Do not run/claim tests here.

Specs: `docs/Logic/TrueCRM_Final_Modules_Codex_Pack/` (read `Agent.md`, `Shared-Contracts/`, then module specs).
Branch: `main`. Conventions to reuse: PackRouter + Next catch-all routes (`src/server/process-platform/http.ts`),
`inTx/evidence/command/lock/requirePermission` (`src/server/process-platform/context.ts`, `src/server/suite/kernel.ts`),
permission catalog `src/server/suite/permission-catalog.json`, Prisma schema + new versioned migration per module,
client kit `src/client/suite/kit.tsx` for consoles.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` code written (UNTESTED) · `[!]` blocked (reason given).

## Order (required by pack): 30 → 31 → 32 → 28 → 29

### 0. Setup
- [x] Pull latest `main` (contains Pack 1 + new pack `081eaa4`)
- [x] `TESTING_REMAINING.md` written for Pack 1 and Pack 2
- [x] Read all Shared-Contracts and record conflicts/decisions below
- [x] Inventory existing platform pieces to reuse (outbox, audit, idempotency, rate limit, jobs, notifications, search, Partner from Auth pack)

### 30-Platform-Services
- [x] 01 Outbox & domain event contract — `src/server/platform/events-service.ts` (dispatcher, receipts, DLQ, replay); kernel `src/server/platform/kernel.ts`; router `src/server/platform/http.ts`
- [x] 02 Jobs, schedules, retries, dead letter — `PlatformJobService` in `events-service.ts`
- [x] 03 Notifications, preferences, mandatory notices, delivery — `src/server/platform/notifications-service.ts` + live-access registry `access.ts`
- [x] 04 Realtime hints & presence — `realtime-service.ts` (signed token, SSE hints w/ live ACL + auth cache version, in-process presence)
- [x] 05 Global search, recents, favorites — `search-service.ts` + `search-sources.ts` (PostgreSQL FTS, projector consumer, reindex job)
- [x] 06 Audit query, security events, support access grants — `governance-service.ts` (customer-approved read-only grants, dual-approved break-glass w/ step-up + review)
- [x] 07 Platform settings, feature flags, locale, numbering sequences — `config-service.ts` (schema-validated settings docs, guarded flags + `requireFeature`, IANA/BCP47 validation, atomic `allocateNumber`)
- [x] 08 Rate limits, idempotency records, safe caching — `governance-service.ts` (`enforceRateLimit`, policy admin, idempotency metadata, cache invalidation)
- [x] 09 Retention policies, portability exports, privacy requests, legal holds — `privacy-service.ts` + module hooks `privacy-hooks.ts` (checkpointed resumable job, sealed 7-day export, holds via `suite_legal_holds`, `assertProductionReady`)
- [x] 10 Health/readiness, observability, backup & restore records — `ops-service.ts` (redacting structured logger, metrics snapshot schedule + alert rules, recovery plans, step-up restore tests via external runner)
- [x] Migration `202610170001_platform_services` + Prisma models (schema valid, typecheck OK)
- [x] Routes `src/server/platform/routes.ts` → `app/api/v1/{platform,me,search}/[[...path]]`, `platform/realtime/stream` (SSE), `internal/numbering/next`, `health/live`, `workspaces/current/settings`, `workspaces/[id]/{support-access,privacy-requests,legal-holds,activation-readiness}`
- [x] Permissions: workspace catalog `src/server/platform/permission-catalog.json` (in `permissions.ts` + seed); platform grants `platform-permissions.json` + `Script/Seeding/GrantPlatformRole.js`
- [x] Workers: `src/server/platform/workers.ts` (schedules, outbox dispatch, jobs, notification delivery) ticked from `SuiteWorkers`
- [x] Console `app/platform/page.tsx` (`src/client/suite/final-consoles.tsx`). Limitation: console cannot send `x-mfa-assertion`, so step-up actions (break-glass, restore test) only work via API.

### 31-Subscription-Billing
- [x] 01 Plan catalog, immutable versions, entitlement resolution — `src/server/billing/catalog-service.ts`, `support.ts` (projection `billing_effective_entitlements` merged in `resolvePrincipal`; DB triggers keep published versions immutable)
- [x] 02 Trials & subscription lifecycle, renewals — `subscription-service.ts` (fingerprinted 14-day trial, purchase→verified payment activation, renewal invoices, cancel at period end, lifecycle job)
- [x] 03 Upgrades/downgrades, proration, compatibility checks — `subscription-service.ts` (immutable change quotes w/ fingerprint staleness check, compatibility findings, scheduled downgrades)
- [x] 04 Billing accounts, invoices, provider payments, webhook reconciliation — `payment-service.ts` (Stripe/XPay/sandbox adapters reused from commercial, verified+deduped webhooks, partial payments, dual-control refunds)
- [x] 05 Usage reservations, quotas, overages — `usage-service.ts` (`UsageService.reserve/settle/release`, row-locked meters, accepted overage caps, expired-reservation reconciliation)
- [x] 06 Credit ledger, top-ups, expiration — `usage-service.ts` (plan-first earliest-expiry allocation FOR UPDATE, append-only ledger, top-up invoices, expiry, reversals)
- [x] 07 Dunning, 15-day grace, service continuity — `lifecycleTick` (PAST_DUE→GRACE, reminder-only dunning, non-destructive expiry + continuity rows, late payment restores)
- [x] 08 Partner pricing integration, payer vs beneficiary — `partner-billing.ts` (resolver seam for Partner module, quote snapshots, partner transactions + refund adjustments, owner-approved payer transition)
- [x] 09 Finance reconciliation, MRR/ARR reporting — `finance-service.ts` (cursor-resumable reconciliation job, findings + verified repair, period MRR facts w/ FX snapshots, scoped revenue/usage reports)
- [x] 10 Billing admin, finance permissions, operational safety — `finance-service.ts` (payload-hash approvals w/ separation of duties, step-up overrides, scoped billing audit, preferences; payment-method change fails closed: no hosted setup adapter)
- [x] Migration `202610180001_subscription_billing` (partial unique live-subscription index, append-only ledger + published-plan immutability triggers)
- [x] Routes `src/server/billing/routes.ts` → `app/api/v1/billing/[[...path]]`, `platform/billing/[[...path]]`, `internal/billing/[[...path]]` (service token), `webhooks/billing/[provider]` (signed)
- [x] Permissions `src/server/billing/permission-catalog.json` (+ seed); platform grants in `platform-permissions.json` (bundle `BILLING_FINANCE`)
- [x] Jobs: `billing.lifecycle` (5 min), `billing.usage.maintenance` (5 min), `billing.mrr.daily`, `billing.reconciliation` (registered via `platform/register.ts`)
- [x] Integration: `resolvePrincipal` merges `billing_effective_entitlements`; quota aliases `sitesLimit`/`commerceStoreLimit`/`hrEmployeeLimit` feed Pack 1 checks
- [x] Console `app/billing/page.tsx`
- [!] Blocked on external setup (not code): Stripe/XPay SaaS credentials (`BILLING_STRIPE_*`, `BILLING_XPAY_*`); hosted payment-method setup flow (no adapter capability, endpoint fails closed 503); tax engine (tax is 0 on quotes until a tax policy provider exists)

### 32-Partner-Program
- [x] 01 Public applications, verification, atomic approval — `src/server/partners/program-service.ts` (non-enumerating 202 submit, duplicate-org flags, idempotent locked approval creating Partner+roles+owner membership; applicant linked by verified email)
- [x] 02 Partner memberships, fixed roles, scoped permissions — `program-service.ts`, `support.ts` (hashed invitations, last-owner guard, allowlisted custom roles, `partnerActor` 404 for non-members)
- [x] 03 Discounts & price rules (basis points) — `commercial-service.ts` (`resolveDiscount` registered as Billing's resolver; product>category>default precedence, versioned snapshots + price audit)
- [x] 04 Customer workspace provisioning, single active relationship — `commercial-service.ts` (idempotent provisioning through legacy `createOwnedWorkspace` via `runStateUnit`, customer is owner; owner-consented link; non-destructive end)
- [x] 05 Delegated workspace access & revocation — `access-service.ts` (`delegatedPrincipal` fallback in `resolvePrincipal`: Partner membership ∩ active unexpired customer grant; read-only default, no self-grant/broadening, instant revoke + cache bump, expiry sweeper)
- [x] 06 Referral codes, attribution, transfer — `commercial-service.ts` (hashed codes, consent-gated hashed touches, `attributeWorkspace` w/ self-referral + dispute checks, owner-consented transfer applied atomically on platform approval). Note: no signup hook calls `attributeWorkspace` yet (needs Sites/signup visitor token wiring)
- [ ] 07 Commission accrual ledger & reversals
- [ ] 08 Payouts, finance approval, reconciliation
- [ ] 09 Suspension, deletion, restore, retention
- [ ] 10 Partner portal dashboard, admin search, reports
- [~] Migration `202610190001_partner_program` (extends legacy partner tables, backfills, one-active-relation partial index, append-only triggers) written; services next

### 28-Knowledge-Base
- [ ] 01 Spaces & hierarchy
- [ ] 02 Article editor & revisions
- [ ] 03 ACL, sharing, external guests
- [ ] 04 Review, publish, acknowledgement
- [ ] 05 Search, AI indexing, citations
- [ ] 06 Import/export, templates
- [ ] 07 Archive, trash (30-day), retention, moves
- [ ] 08 Knowledge UI & analytics
- [ ] Migration, permissions, routes, knowledge screen

### 29-AI-CoPilot
- [ ] 01 Provider connections, model catalog, routing
- [ ] 02 Scenarios, prompt versions, assistants
- [ ] 03 Conversations, messages, retention
- [ ] 04 Context builder, permission-filtered retrieval, citations
- [ ] 05 Tool registry, approvals, business actions
- [ ] 06 Async runs, retries, fallback, cancellation
- [ ] 07 Usage, costs, BYOK, credit consumption (via Billing)
- [ ] 08 External MCP & OAuth (advanced)
- [ ] 09 Governance, evaluation, feedback
- [ ] 10 Domain assistance & media
- [ ] Migration, permissions, routes, CoPilot screen

### Final
- [ ] Move `docs/.../Testing` to `tests/modules/TrueCRM_Final_Modules_Codex_Pack/` with fail-closed adapter stub (no test runs)
- [ ] README/.env.example updates, typecheck + build evidence, update `TESTING_REMAINING.md`

## Decisions / conflicts log
- D1 No Redis/BullMQ in repo: durable jobs/outbox dispatch run on PostgreSQL leases (`FOR UPDATE SKIP LOCKED`), matching existing workers. Redis transport is a deployment add-on, not required for correctness (spec 30/02 AC05).
- D2 `outbox_events.workspace_id` is NOT NULL in the existing schema; global Partner/Plan events go to new `platform_global_events` with the same envelope and dispatcher.
- D3 Platform Admin was an email-domain check (`@entertabcrm.local`) in the Auth pack; replaced by `platform_role_assignments` (explicit platform.* grants). Platform roles never grant Workspace data access.
- D4 Audit append-only enforced by DB trigger; only FK `SET NULL` from owner hard-deletes may touch rows.
- D5 No MFA provider exists in the repo: high-risk platform actions (break-glass, restore tests) require dual approval and fail closed with DEPENDENCY_UNAVAILABLE until `PLATFORM_MFA_VERIFIER` is configured.
- D6 Existing `suite_retention_policies`/`suite_legal_holds` (Pack 1) stay module-scoped; platform-wide jurisdiction policies live in `platform_retention_policies`; legal holds are reused (added authority/release columns).

## Verification log (non-test checks only)
- 2026-10-16 `prisma validate` OK; `tsc --noEmit` exit 0 after Platform schema
- 2026-10-16 `tsc --noEmit` exit 0 after access/notifications/realtime/search/governance services
- 2026-10-16 `tsc --noEmit` exit 0 after Platform routes/permissions/workers/console
