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
- [~] Platform console MFA implemented: per-action assertions for protected Platform/Billing/Partner actions, no persistent assertion storage. Implementation is IMPLEMENTED_UNVERIFIED: typecheck exit 0 and Prisma validation exit 0; production build pending; runtime tests deferred. MFA issuer configuration remains external.

### 31-Subscription-Billing
- [~] Stripe/XPay hosted setup implemented with tenant-scoped customer references, durable command keys, provider idempotency and audit/outbox; no automatic charges. Explicit versioned country tax policies now feed quote totals/fingerprints and invoice tax lines; missing production policy fails closed. Implementation is IMPLEMENTED_UNVERIFIED: typecheck exit 0 and Prisma validation exit 0; production build pending; runtime tests deferred. Stripe/XPay credentials and approved tax rates remain external prerequisites. Provider setup confirmation uses authenticated server lookups. Migration `202610220001_final_module_integrations` is written, not applied.

### 32-Partner-Program
- [~] Referral integration implemented: Sites marketing consent records a hashed touch through the Partner owner; signup retains a hashed visitor reference; verified Workspace creation invokes Partner attribution inside the persistence transaction with audit/outbox, replay/self-referral/suspension checks. Implementation is IMPLEMENTED_UNVERIFIED: typecheck exit 0 and Prisma validation exit 0; production build pending; runtime tests deferred.

### 28-Knowledge-Base
- [~] Knowledge guest delivery implemented: encrypted transactional delivery record, reference-only durable job, SES/SMTP adapters, no raw token response, public guest acceptance/read page; uncertain sends are not automatically repeated. Block collaboration endpoint merges independent edits into immutable revisions and rejects same-block conflicts. Implementation is IMPLEMENTED_UNVERIFIED: typecheck exit 0 and Prisma validation exit 0; production build pending; runtime tests deferred. Optional embedding routing, Billing-backed usage, asynchronous chunk indexing and live-ACL semantic retrieval are implemented; FTS fallback remains available. Live email and embedding routes require credentials/configuration.

### 29-AI-CoPilot
- [~] Speaker diarization adapter implemented for an approved OpenAI diarization model route, with encrypted speaker segments and source-authorized reads; typecheck exit 0 and Prisma validation exit 0; production build pending and runtime tests deferred. SSE plain-text output with live authorization, encrypted transient buffers, no-history/tool/JSON/retrieval gating and a viewer is implemented; optional Knowledge embeddings use AI routing and Billing reservations. Final checks pending; no runtime tests run. Live AI/media calls require approved routes and provider credentials.

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
