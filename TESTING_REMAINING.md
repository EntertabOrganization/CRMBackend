# Remaining testing work

Code in the modules below was written **without running any tests** (user instruction). A testing agent must
run, fix and verify each module one at a time, in the order given, committing after every fix.
Nothing here is verified until its command has been run and passed. Do not mark items done without real output.

## How to work through this file

1. `npm run db:start` (local PostgreSQL). Tests create their own disposable databases; never reset shared ones.
2. Pick the first unchecked module, run its command, fix the **application** (not the test) where the test reflects
   the spec; fix the test only when it is wrong about the spec. Never skip, delete or weaken assertions.
3. Re-run until green, then `npm run typecheck` and `npm run build`, tick the box with the date and the pass count,
   commit (`git commit`) and push before moving on.

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

## Pack 2 — TrueCRM_Final_Modules_Codex_Pack (being implemented without tests)

Specs: `docs/Logic/TrueCRM_Final_Modules_Codex_Pack/`. Its `Testing/` folder must be moved to
`tests/modules/TrueCRM_Final_Modules_Codex_Pack/` and bound to a repository adapter (same approach as Pack 1:
owned DB, real route dispatch, persisted-state observation). Order required by the pack:

- [ ] **30-Platform-Services** — 10 specs + e2e
- [ ] **31-Subscription-Billing** — 10 specs + e2e
- [ ] **32-Partner-Program** — 10 specs + e2e
- [ ] **28-Knowledge-Base** — 8 specs + e2e
- [ ] **29-AI-CoPilot** — 10 specs + e2e
- [ ] **CrossModule** — `Testing/CrossModule/cross-module.e2e-spec.ts`
- [ ] Migrations for Pack 2 applied to a disposable DB; regression of Pack 1 suites after Pack 2.

See `IMPLEMENTATION_PROGRESS.md` for which Pack 2 features exist in code.

## External prerequisites (cannot be verified in tests; need staging credentials)

Stripe/XPay and SaaS billing payment providers, SES/SMTP/Twilio/WhatsApp/Meta, Google Ads developer token,
TLS issuer (`SITES_TLS_PROVIDER`), AI providers (OpenAI/Azure/Anthropic/Gemini/OpenRouter keys or `AI_GATEWAY_URL`),
customer mail provider. Only deterministic sandbox adapters are exercised by tests.
