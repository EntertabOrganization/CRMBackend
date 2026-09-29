# Executable Test Contracts

The `.spec.ts` and `.e2e-spec.ts` files in this directory are intentionally failing Jest-style contract tests.

They are **not** disposable placeholders.

The coding agent must:

1. Read `Agent.md`.
2. Read the corresponding module specification.
3. Inspect the repository's existing test framework, test utilities, database harness and factories.
4. Move/adapt/wire these contracts into the repository's normal test layout.
5. Replace each `contract()` failure with real setup/actions/assertions against the implementation.
6. Do not skip, delete, weaken or convert required scenarios to `todo` simply to obtain a green suite.
7. Use deterministic provider mocks/fakes for external services.
8. Run the targeted tests until green.
9. Run the complete regression suite.
10. Report exact test results and any real-provider smoke tests still required.

If the repository uses Vitest or another established runner, translate the contracts to that framework rather than adding an unnecessary second test runner.

Cross-module tests are mandatory because workspace isolation, permissions, audit, idempotency, jobs and entitlements cannot be proven by isolated unit tests alone.
