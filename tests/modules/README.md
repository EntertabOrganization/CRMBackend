# Module test packs

All eight module test packs live here. Each folder preserves its original test, helper, and testing-documentation structure. Module specifications and `Agent.md` execution contracts live in `docs/Logic/<pack>/`.

Jest discovers both `*.spec.ts` and `*.e2e-spec.ts` beneath the global `tests/` root. Existing root-level tests and shared fixtures remain in place. Relative imports inside the moved packs retain their original relationships; repository aliases continue to resolve from the root.

Some preserved contracts deliberately throw until wired to the implementation. Moving them does not implement their scenarios or make them pass. They remain visible to discovery and must not be skipped, weakened, or treated as completed coverage.

Run selected files explicitly:

```powershell
npm run db:start
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath 'tests/modules/Commercial_Capture_ContactCenter/Company-Details-Requisites-Bank/requisites.spec.ts'
```

Database integration tests use disposable test databases; inspect their fixtures before running. Record test and build results in the root `IMPLEMENTATION_PROGRESS.md` and the owning module's progress record.
