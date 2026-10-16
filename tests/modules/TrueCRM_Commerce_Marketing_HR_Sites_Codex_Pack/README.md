# Executable, fail-closed TypeScript/Jest contract tests

## Purpose

Tests are written for an agent that will implement TrueCRM in an unknown existing repository. They **cannot and do not claim to run green out of the ZIP**, because the real NestJS app, migrations, DB and provider credentials are not bundled. This follows the reference TrueAgent Pack's deliberate fail-closed testing pattern. The test code executes and fails explicitly until wired, instead of silently skipping work.

## Wiring recipe for Codex / Claude

1. Inspect repository Jest/Vitest setup. Copy/adapt `Testing/_harness/adapter.ts` and suite files into its normal test directories. Maintain test names and assertions. If using Jest/NestJS + Supertest, implement `createHarness()` in repo e.g. `test/truecrm-contract-adapter.ts` that boots real NestJS, migrated isolated Postgres, service providers with deterministic fakes and seeded workspaces.
2. Set `TRUECRM_CONTRACT_ADAPTER=test/truecrm-contract-adapter.ts` (actual path depends on runtime loader) when executing package suites. If TypeScript module loader cannot require `.ts`, compile/load via repo Jest/ts-jest or adapt only import resolution. Default **must throw**.
3. `RepositoryHarness.seed(name)` provides well-defined test fixtures from `_harness/fixtures.md`. `request()` calls the real application and returns response status/body; `observe()` directly inspects persisted DB/outbox or provider fake calls. Do not bypass domain logic in action under test.
4. For generated per-spec `*.spec.ts`, implement `runContractCase(id, requirement)` by executing that scenario against real app and asserting real DB/HTTP behavior. Return `ContractEvidence` only after verifying actual HTTP and database assertions, with evidence and failure details. Alternatively replace each case with stronger inlined Jest assertions, preserving scope.
5. Run target service/unit, DB integration, E2E, 2-workspace negative auth, concurrency/provider failure, frontend smoke, then full repository regression. Keep red tests red until implementation. No `it.skip`, `it.todo`, mock-only PASS, or blanket suppression.

## Suggested commands (adapt to repository scripts)

```bash
npm ci
npm run build
npm run test -- --runInBand
npm run test:e2e -- --runInBand
```

Do **not** claim these commands were executed solely because they appear here. Require actual run output in agent's final report. Live Stripe/XPay/SES/Twilio/WhatsApp/Meta/Google integration smoke requires configured staging credentials and is reported separately from deterministic mocks. Always capture migration validation, audit/outbox inspection and side-effect dedupe evidence.
