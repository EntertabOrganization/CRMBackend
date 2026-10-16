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
- [ ] 01 Outbox & domain event contract (event envelope/versioning, dispatcher, consumer inbox dedupe)
- [ ] 02 Jobs, schedules, retries, dead letter (durable job table, leasing, backoff, operator retry)
- [ ] 03 Notifications, preferences, mandatory notices, delivery
- [ ] 04 Realtime hints & presence (SSE invalidation hints, ACL re-check)
- [ ] 05 Global search, recents, favorites (ACL-filtered, rebuildable index)
- [ ] 06 Audit query, security events, support access grants
- [ ] 07 Platform settings, feature flags, locale, numbering sequences
- [ ] 08 Rate limits, idempotency records, safe caching
- [ ] 09 Retention policies, portability exports, privacy requests, legal holds
- [ ] 10 Health/readiness, observability, backup & restore records
- [~] Migration `202610170001_platform_services` + Prisma models written (schema valid, typecheck OK); services/routes/screen next

### 31-Subscription-Billing
- [ ] 01 Plan catalog, immutable versions, entitlement resolution
- [ ] 02 Trials & subscription lifecycle, renewals
- [ ] 03 Upgrades/downgrades, proration, compatibility checks
- [ ] 04 Billing accounts, invoices, provider payments, webhook reconciliation
- [ ] 05 Usage reservations, quotas, overages
- [ ] 06 Credit ledger, top-ups, expiration
- [ ] 07 Dunning, 15-day grace, service continuity
- [ ] 08 Partner pricing integration, payer vs beneficiary
- [ ] 09 Finance reconciliation, MRR/ARR reporting
- [ ] 10 Billing admin, finance permissions, operational safety
- [ ] Migration, permissions, routes, billing console screen

### 32-Partner-Program
- [ ] 01 Public applications, verification, atomic approval
- [ ] 02 Partner memberships, fixed roles, scoped permissions
- [ ] 03 Discounts & price rules (basis points)
- [ ] 04 Customer workspace provisioning, single active relationship
- [ ] 05 Delegated workspace access & revocation
- [ ] 06 Referral codes, attribution, transfer
- [ ] 07 Commission accrual ledger & reversals
- [ ] 08 Payouts, finance approval, reconciliation
- [ ] 09 Suspension, deletion, restore, retention
- [ ] 10 Partner portal dashboard, admin search, reports
- [ ] Migration, permissions, routes, partner portal screen

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
