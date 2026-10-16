# Remaining testing work

Code in the modules below was written **without running any tests** (user instruction). A testing agent must
run, fix and verify each module one at a time, in the order given, once the user enables testing.
Latest user instruction (2026-10-16): do not commit or push; the user will commit.
Nothing here is verified until its command has been run and passed. Do not mark items done without real output.

## How to work through this file

1. `npm run db:start` (local PostgreSQL). Tests create their own disposable databases; never reset shared ones.
2. Pick the first unchecked module, run its command, fix the **application** (not the test) where the test reflects
   the spec; fix the test only when it is wrong about the spec. Never skip, delete or weaken assertions.
3. Re-run until green, then `npm run typecheck` and `npm run build`, tick the box with the date and the pass count,
   record the actual result before moving on. Do not commit or push.

Common run command (replace the path):

```bash
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand tests/modules/<PACK>/<MODULE>
```

## Pack 1 — TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack (code complete, tests never run)

Suites: `tests/modules/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack/`; adapter `tests/support/truecrm-contract-adapter.ts`;
fixtures/cases in `tests/support/truecrm/` (owned DB `truecrm_suite_contract_test`).

- [ ] **OnlineStore-Commerce** — 13 spec files (AC + S01–S04 each) + `OnlineStore-Commerce.e2e-spec.ts`. Cases: `tests/support/truecrm/cases-commerce.ts`.
- [ ] **Marketing-Campaigns** — 10 spec files + e2e. Cases: `cases-marketing.ts`.
- [ ] **HR-TimeTracking** — 11 spec files + e2e. Cases: `cases-hr.ts`.
- [ ] **Sites-LandingPages** — 11 spec files + e2e. Cases: `cases-sites.ts`.
- [ ] **CrossModule** — `CrossModule/cross-module.e2e-spec.ts`.
- [ ] Apply migration `prisma/migrations/202610160001_business_suite_commerce_marketing_hr_sites` to a disposable DB and confirm `prisma migrate diff` is empty afterwards.
- [ ] Frontend smoke: open `/commerce`, `/marketing`, `/hr`, `/sites`, `/store/<slug>`, `/s/` and exercise one action each (no automated UI tests exist yet).

Known weak spots to fix while testing (written but unverified):
- Commerce `13-…::AC03` simulates a refund by writing `paymentStatus` directly; replace with the real refund flow.
- Commerce `05-…::AC01` renames a catalog product directly in the DB; prefer the Catalog service.
- Sites `07-…::AC01` covers "broken form" through an unknown form id + a broken product binding, not a real unpublished form.
- `tests/api-endpoints.spec.ts` was already failing before this pack (Commerce/SPA/storefront routes never covered). The new public
  routes are allow-listed, but coverage calls for the new route files are still missing.

## Pack 2 — TrueCRM_Final_Modules_Codex_Pack (implemented, NOT tested)

Specs: `docs/Logic/TrueCRM_Final_Modules_Codex_Pack/`. Contract suites were moved (unchanged) to
`tests/modules/TrueCRM_Final_Modules_Codex_Pack/`. `_harness/repository-adapter.ts` throws `CONTRACT_NOT_WIRED`
for every case, so every suite there currently fails by design. Bind it the same way as Pack 1:
an owned disposable DB, real route dispatch through the Next route handlers, and persisted-state observation.
Each case must return real evidence: at least 2 assertions, at least 2 observations and at least 1 implementation ref.
`_harness/test-globals.d.ts` is excluded from the root `tsconfig.json` because it clashes with the Jest types.
Order required by the pack:

- [ ] **30-Platform-Services** — 10 specs + e2e. Code: `src/server/platform/*`. Needs a platform-role fixture (`platformRoleAssignment`) and `PLATFORM_MFA_VERIFIER_SECRET` set in tests to exercise step-up actions.
- [ ] **31-Subscription-Billing** — 10 specs + e2e. Code: `src/server/billing/*`. Use the SANDBOX payment provider (`BILLING_SANDBOX_SECRET`) for signed webhook cases; internal routes need `INTERNAL_JOB_TOKEN`.
- [ ] **32-Partner-Program** — 10 specs + e2e. Code: `src/server/partners/*`. Provisioning goes through the legacy store (`runStateUnit`).
- [ ] **28-Knowledge-Base** — 8 specs + e2e. Code: `src/server/knowledge/*`. Guest cases need `KNOWLEDGE_GUEST_SECRET`.
- [ ] **29-AI-CoPilot** — 10 specs + e2e. Code: `src/server/ai/*`. Use `AI_SANDBOX_ENABLED=true` with a SANDBOX connection and route; credit cases need a Billing credit grant on the test Workspace. Domain/media cases (10) need a scanned audio file and the Files scanner fixture.
- [ ] **CrossModule** — `tests/modules/TrueCRM_Final_Modules_Codex_Pack/CrossModule/cross-module.e2e-spec.ts`
- [ ] Apply migrations `202610170001_platform_services` through `202610210001_ai_copilot` plus `202610220001_final_module_integrations` to a disposable DB (`prisma migrate deploy` against an owned test database only), then rerun the Pack 1 suites as regression.
- [x] `npm run build` passed on the updated integration tree (2026-10-16, exit 0, 88/88 static pages, 8 GiB Node heap; source commit `f8d9468`; typecheck and Prisma validation also exited 0 on that tree); runtime tests remain unrun. Rerun after test wiring.

### `tests/api-endpoints.spec.ts` changes made for Pack 2 (verify)
- The admin fixture now also receives a `platformRoleAssignment` (Prisma) because Partner approval moved to platform roles. The legacy approve expectation is now an idempotent replay instead of a 404.
- PUBLIC_ENDPOINTS additions: the health/live route, `POST /api/v1/webhooks/billing/[provider]`, `POST /api/v1/public/partners/applications`, and `GET`/`POST /api/v1/public/knowledge/[[...path]]`.
- Not allow-listed on purpose: `ai/[[...path]]`, `mcp/[[...path]]` and `internal/{billing,knowledge,ai}/[[...path]]`. Their root path is unmatched and returns 401 without credentials. The public `POST /api/v1/ai/oauth/token`, the MCP bearer routes and the internal service-token routes live inside these catch-alls.
- **Still missing**: the "exercises every route handler" test requires every new route file to be called with real credentials. That covers the platform, billing, partner, knowledge, ai, mcp and internal catch-alls, and the `/platform/ai`, `/platform/billing` and `/platform/partner-*` files. The coverage calls have not been written, so that test will fail until they are added. Include the new `/api/v1/ai/runs/[id]/stream` route and new subpaths for billing setup confirmation, Knowledge collaboration and guest delivery metadata.

### Known gaps (implemented behaviour that is limited by design or blocked — tests must not assert otherwise)
- Billing: Stripe/XPay hosted setup and explicit country tax policy are written, untested; verify replay, cross-Workspace access, trusted redirects, missing/changed tax policy, quote staleness and invoice totals. No stored-card auto-charge (D7); Verify server-side setup confirmation for both providers; redirects must not mark invoices paid. Migration `202610220001_final_module_integrations` is not applied or tested.
- Partner: verified signup now invokes attribution in the Workspace persistence transaction; verify marketing-consent gating, expiry, duplicate/self-referral, suspended Partner, rollback and no delegated access grant. Nullable application `user_id` (D8); delegated principal (D9).
- Knowledge: block collaboration and queued encrypted guest email are written, untested. Verify independent edits merge, conflicting blocks return 409, duplicate command keys, live ACLs, file scans, unchanged publication approvals, email token secrecy, expiry/revoke before send, unknown delivery and guest page acceptance. Optional embeddings are written, untested: verify live ACL, stale publication, classification/region routing, model mismatch, credit reservation/settlement, budget exhaustion, reindex/restart and FTS fallback.
- AI: SSE streaming and OpenAI diarization are written, untested. Verify per-snapshot reauthorization, no-history/tool/JSON/retrieval gating, stream interruption/UNKNOWN accounting, cancellation, reconnect and encrypted buffer cleanup. Verify approved model routing, speaker segment validation/encryption and live source access. Image/transcription need supported provider routes and credentials.
- Platform/Billing/Partner consoles now send per-action `x-mfa-assertion`; verify the assertion is cleared, excluded from the request body/storage/results, and missing/expired assertions fail. UI and API tests remain deferred.

See `IMPLEMENTATION_PROGRESS.md` for remaining operator setup and environment blockers. Completed code entries have been removed at the user's request.

## External prerequisites (cannot be verified in tests; need staging credentials)

Local `.env` and `.env.example` now provide credential/configuration slots. The user will fill credentials later; no provider calls or runtime checks were performed while preparing these slots. Setup instructions are in README under "Filling the local integration configuration".

Stripe/XPay and SaaS billing payment providers, SES/SMTP/Twilio/WhatsApp/Meta, Google Ads developer token,
TLS issuer (`SITES_TLS_PROVIDER`), AI providers (OpenAI/Azure/Anthropic/Gemini/OpenRouter keys or `AI_GATEWAY_URL`),
customer mail provider. Only deterministic sandbox adapters are exercised by tests.
