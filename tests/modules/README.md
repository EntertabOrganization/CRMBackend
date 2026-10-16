# Module test packs

All module test packs live here (the eight module packs plus `TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack` and `TrueCRM_Final_Modules_Codex_Pack`). Each folder preserves its original test, helper, and testing-documentation structure. Module specifications and `Agent.md` execution contracts live in `docs/Logic/<pack>/`.

Jest discovers both `*.spec.ts` and `*.e2e-spec.ts` beneath the global `tests/` root. Existing root-level tests and shared fixtures remain in place. Relative imports inside the moved packs retain their original relationships; repository aliases continue to resolve from the root.

Some preserved contracts deliberately throw until wired to the implementation. Moving them does not implement their scenarios or make them pass. They remain visible to discovery and must not be skipped, weakened, or treated as completed coverage.

Run selected files explicitly:

```powershell
npm run db:start
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath 'tests/modules/Commercial_Capture_ContactCenter/Company-Details-Requisites-Bank/requisites.spec.ts'
```

Database integration tests use disposable test databases; inspect their fixtures before running. Record test and build results in the root `IMPLEMENTATION_PROGRESS.md` and the owning module's progress record.

`TrueCRM_Final_Modules_Codex_Pack/` (Knowledge Base, AI CoPilot, Platform Services, Subscription Billing, Partner Program) was moved from `docs/Logic/TrueCRM_Final_Modules_Codex_Pack/Testing/`; the pack's own documents still say `Testing/`. Its `_harness/repository-adapter.ts` deliberately throws `CONTRACT_NOT_WIRED` for every case until it is bound to the real application. `_harness/test-globals.d.ts` is excluded from the root `tsconfig.json` because Jest's own type declarations already provide `describe`/`it`/`expect`. See `TESTING_REMAINING.md` for the wiring work.
