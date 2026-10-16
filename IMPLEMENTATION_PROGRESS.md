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

Completed code-written entries were removed on 2026-10-16 at the user's request; deferred tests have not been run. Outstanding verification remains in `TESTING_REMAINING.md`.

Status legend: `[ ]` unfinished; `[~]` in progress; `[!]` blocked or unsupported (reason given).

## Order (required by pack): 30 -> 31 -> 32 -> 28 -> 29

All previously listed implementation gaps now have code. The code-written entries have been removed as requested; their behavior is **IMPLEMENTED_UNVERIFIED**, not test-passed. Runtime, migration, UI and provider verification remains in `TESTING_REMAINING.md`.

Current checks: typecheck PASSED (exit 0); Prisma schema validation PASSED (exit 0); final production build PASSED (exit 0, 88 static pages); runtime tests DEFERRED by user; migration NOT_APPLIED.

### 30-Platform-Services
- [!] External setup: configure the MFA assertion issuer and `PLATFORM_MFA_VERIFIER_SECRET`. Protected console actions now send per-action assertions without persistent browser storage.

### 31-Subscription-Billing
- [!] External setup: Stripe/XPay merchant credentials and approved country tax policies (`BILLING_TAX_POLICY_JSON`). Hosted setup, server-side confirmation and tax calculation are written; automatic charging remains disabled. Migration `202610220001_final_module_integrations` is written but unapplied/unverified.

### 28-Knowledge-Base
- [!] External setup: SES/SMTP sender credentials, secret reference, `APP_URL`, encryption/signing keys and approved embedding routes/model prices/region/classification policy. Guest delivery, public guest reader, block collaboration and optional semantic retrieval are written. FTS remains available. Integration limits and operation contracts are documented in README.

### 29-AI-CoPilot
- [!] External setup: approved provider connections, model catalog/rates, routes and Billing credit grants. Plain-text SSE streaming, encrypted speaker diarization and Billing-backed embeddings are written. Tools/JSON/retrieval/no-history runs remain completion-only. Live provider calls are not verified.

## Decisions / conflicts log
- D1 No Redis/BullMQ in repo: durable jobs/outbox dispatch run on PostgreSQL leases (`FOR UPDATE SKIP LOCKED`), matching existing workers. Redis transport is a deployment add-on, not required for correctness (spec 30/02 AC05).
- D2 `outbox_events.workspace_id` is NOT NULL in the existing schema; global Partner/Plan events go to new `platform_global_events` with the same envelope and dispatcher.
- D3 Platform Admin was an email-domain check (`@entertabcrm.local`) in the Auth pack; replaced by `platform_role_assignments` (explicit platform.* grants). Platform roles never grant Workspace data access.
- D4 Audit append-only enforced by DB trigger; only FK `SET NULL` from owner hard-deletes may touch rows.
- D5 No MFA provider exists in the repo: high-risk platform actions (break-glass, restore tests) require dual approval and fail closed with DEPENDENCY_UNAVAILABLE until `PLATFORM_MFA_VERIFIER_SECRET` and the external assertion issuer are configured.
- D6 Existing `suite_retention_policies`/`suite_legal_holds` (Pack 1) stay module-scoped; platform-wide jurisdiction policies live in `platform_retention_policies`; legal holds are reused (added authority/release columns).
- D7 Billing renewals remain invoice-based and dunning reminder-only. Stripe-hosted setup now saves payment methods through provider Checkout; browser returns never mark invoices paid or authorize automatic charging. XPay setup uses the documented Checkout setup mode; both providers confirm setup through authenticated lookups.
- D8 Public Partner applications may precede signup (creating a User here would block the Auth signup flow): `partner_applications.user_id` is nullable; the applicant is linked by verified normalized email at approval, which requires an ACTIVE verified account.
- D9 Partner delegated access is resolved inside `resolvePrincipal` only when no Workspace membership exists (`delegatedPrincipal`), so no `workspace_memberships` row is ever created for Partner staff.

## Verification log (non-test checks only; no runtime tests run)
- Historical verification evidence (2026-10-16, implementation tree before this cleanup): `npm run typecheck` exit 0; `prisma validate` (placeholder DATABASE_URL) exit 0 "schema is valid"; `npm run build` exit 0, 87 pages, routes `/ai`, `/api/v1/{ai,platform/ai,internal/ai,mcp}/[[...path]]` built; one pre-existing warning (`@nestjs/common` file-type validator import, unrelated to this pack). **No tests run** (by user instruction) — see `TESTING_REMAINING.md`.
- 2026-10-16 `prisma validate` OK; `tsc --noEmit` exit 0 after Platform schema
- 2026-10-16 `tsc --noEmit` exit 0 after access/notifications/realtime/search/governance services
- 2026-10-16 `tsc --noEmit` exit 0 after Platform routes/permissions/workers/console

- 2026-10-16 continuation checks: initial typecheck failed due to stale generated Prisma client; local generation succeeded without DB writes. Initial build failed on conflicting generated route types from `.next-dev`/`.next-live`; production/typecheck now use `tsconfig.build.json`. Default Node heap was exhausted on a subsequent typecheck; direct `node --max-old-space-size=8192 .../tsc --noEmit --project tsconfig.build.json` then exited 0 before the collaboration/diarization changes. Final typecheck and Prisma validation exited 0; production build pending. No tests run.

- 2026-10-16 current continuation: `npm run typecheck` exit 0 after integration work; `npm run prisma:validate` exit 0. Production build is running. A final SSE malformed-ID validation correction is written and will be included in the final rerun. Tests, migration execution and UI/provider smoke checks remain deferred.

- 2026-10-16 intermediate failure evidence: initial stale-client typecheck exit 1; default-heap typecheck exit 134 (Node out of memory); initial build exit 1 (conflicting generated route types); embedding optional-entitlements check exit 2. Prisma regeneration, isolated production TypeScript config, 8 GiB heap and the optional-property correction resolved these failures. The first complete integration build and the final exact-source rerun both exited 0.
- Git checkpoint: implementation commit `f8d9468` is local. Initial push was interrupted while the credential helper waited. Non-interactive retry exited 128: GitHub credentials are unavailable (`could not read Username`). Push is BLOCKED until local GitHub authentication is restored; pending command: `git push origin main`.

- Final 2026-10-16 verification for source commit `f8d9468`: `npm run typecheck` exit 0; `npm run prisma:validate` exit 0 (schema valid); `npm run build` with `NODE_OPTIONS=--max-old-space-size=8192` exit 0, 88/88 static pages generated. New editor, guest reader, run viewer and authenticated SSE endpoint are in the production route manifest. Existing Nest/file-type and dynamic load-esm warnings remain; the inherited Next TypeScript-plugin configuration emits an advisory warning. Runtime tests run: 0 (user-deferred). No database migrations, provider calls, deployment or UI smoke checks were performed. Required runtime verification remains in `TESTING_REMAINING.md`.
