<!-- Module specifications and execution contract: docs/Logic/Commercial_Capture_ContactCenter/; executable tests: tests/modules/Commercial_Capture_ContactCenter/ -->

# Executable Contract Tests

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


These `.spec.ts` and `.e2e-spec.ts` files are deliberately executable contract tests that fail until the coding agent wires them to the real TrueCRM repository.

They are not disposable placeholders.

The coding agent must:

1. read `Agent.md` and corresponding module specification;
2. inspect repository's existing test runner/setup;
3. adapt imports, factories, app bootstrap and database setup to real codebase;
4. replace each `contract()` with real actions/assertions;
5. preserve every scenario represented by test names;
6. never skip/delete/weaken tests merely to obtain green;
7. use deterministic provider fakes for Stripe/XPay/channel integrations;
8. run targeted unit/service/integration/E2E tests until green;
9. run authorization, cross-Workspace and concurrency/idempotency cases;
10. run full regression suite;
11. review implementation against specs, fix mismatches and retest.

If repository uses Vitest or another runner, translate while preserving scenario semantics instead of adding a second runner.
