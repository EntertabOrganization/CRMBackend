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

Completed code-written entries were removed on 2026-10-16 at the user's request; deferred tests have not passed. Outstanding verification remains in `TESTING_REMAINING.md`.

Status legend: `[ ]` unfinished; `[~]` in progress; `[!]` blocked or unsupported (reason given).

## Order (required by pack): 30 → 31 → 32 → 28 → 29

### 30-Platform-Services
- [ ] Platform console MFA: `src/client/suite/final-consoles.tsx` and `kit.tsx` cannot send `x-mfa-assertion`; emergency access and restore-test actions currently require direct API calls.

### 31-Subscription-Billing
- [!] Stripe/XPay SaaS credentials remain external prerequisites (`BILLING_STRIPE_*`, `BILLING_XPAY_*`). Hosted payment-method setup also needs adapter implementation (endpoint currently fails closed with 503); tax calculation needs policy/provider integration (quote tax is currently always 0). Credentials alone do not complete these code gaps.

### 32-Partner-Program
- [ ] Referral signup integration: no signup hook calls `PartnerCommercialService.attributeWorkspace` in `src/server/partners/commercial-service.ts`; Sites/signup visitor-token wiring remains unfinished.

### 28-Knowledge-Base
- [!] Not implemented by design/blocked: real-time collaborative co-editing (spec marks it advanced phase; Core V1 optimistic concurrency done); vector embeddings provider (FTS only, `embeddingRef` reserved); guest invitation email delivery uses the returned one-time token (no mail provider wired to Knowledge)

### 29-AI-CoPilot
- [!] Not implemented by design/blocked: streaming token output (runs are async + polled); speaker diarization (flag recorded as unsupported); vector embeddings (Knowledge FTS retrieval only); real provider calls need credentials (only the non-production SANDBOX adapter works without them); image/transcription require a provider adapter that implements those capabilities

## Decisions / conflicts log
- D1 No Redis/BullMQ in repo: durable jobs/outbox dispatch run on PostgreSQL leases (`FOR UPDATE SKIP LOCKED`), matching existing workers. Redis transport is a deployment add-on, not required for correctness (spec 30/02 AC05).
- D2 `outbox_events.workspace_id` is NOT NULL in the existing schema; global Partner/Plan events go to new `platform_global_events` with the same envelope and dispatcher.
- D3 Platform Admin was an email-domain check (`@entertabcrm.local`) in the Auth pack; replaced by `platform_role_assignments` (explicit platform.* grants). Platform roles never grant Workspace data access.
- D4 Audit append-only enforced by DB trigger; only FK `SET NULL` from owner hard-deletes may touch rows.
- D5 No MFA provider exists in the repo: high-risk platform actions (break-glass, restore tests) require dual approval and fail closed with DEPENDENCY_UNAVAILABLE until `PLATFORM_MFA_VERIFIER` is configured.
- D6 Existing `suite_retention_policies`/`suite_legal_holds` (Pack 1) stay module-scoped; platform-wide jurisdiction policies live in `platform_retention_policies`; legal holds are reused (added authority/release columns).
- D7 Billing never auto-charges stored cards: no hosted payment-method setup capability exists in the repo adapters, so renewals issue invoices paid through hosted checkout; dunning is reminder-only (no duplicate charge risk). `/billing/payment-method/change` fails closed (503).
- D8 Public Partner applications may precede signup (creating a User here would block the Auth signup flow): `partner_applications.user_id` is nullable; the applicant is linked by verified normalized email at approval, which requires an ACTIVE verified account.
- D9 Partner delegated access is resolved inside `resolvePrincipal` only when no Workspace membership exists (`delegatedPrincipal`), so no `workspace_memberships` row is ever created for Partner staff.

## Verification log (non-test checks only; historical, not rerun during cleanup)
- Historical verification evidence (2026-10-16, implementation tree before this cleanup): `npm run typecheck` exit 0; `prisma validate` (placeholder DATABASE_URL) exit 0 "schema is valid"; `npm run build` exit 0, 87 pages, routes `/ai`, `/api/v1/{ai,platform/ai,internal/ai,mcp}/[[...path]]` built; one pre-existing warning (`@nestjs/common` file-type validator import, unrelated to this pack). **No tests run** (by user instruction) — see `TESTING_REMAINING.md`.
- 2026-10-16 `prisma validate` OK; `tsc --noEmit` exit 0 after Platform schema
- 2026-10-16 `tsc --noEmit` exit 0 after access/notifications/realtime/search/governance services
- 2026-10-16 `tsc --noEmit` exit 0 after Platform routes/permissions/workers/console
