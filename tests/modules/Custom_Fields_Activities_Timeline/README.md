<!-- Module specifications and execution contract: docs/Logic/Custom_Fields_Activities_Timeline/; executable tests: tests/modules/Custom_Fields_Activities_Timeline/ -->

# Executable Test Contracts

The `.spec.ts` / `.e2e-spec.ts` files in this directory are intentionally executable contract tests that fail until the coding agent wires them to the real TrueCRM repository.

They follow the structural philosophy of the supplied reference Codex Pack.

## Rules

The coding agent must:

1. read `Agent.md` and the matching module specifications;
2. inspect the repository's current testing frameworks and factories;
3. adapt imports/setup to the real implementation;
4. replace each `contract()` failure with real assertions;
5. never delete, skip, weaken, or convert required scenarios to `todo` merely to obtain green output;
6. add additional repository-specific cases when implementation introduces extra risk;
7. run targeted tests until green;
8. run the full regression suite;
9. report exact results and any unavailable specialist integration smoke tests.

If the repo uses Vitest instead of Jest, translate the tests. If frontend uses Playwright/Cypress/Testing Library, adapt the frontend contracts to the established framework rather than introducing a second redundant framework.

## Required test layers

- pure/domain unit tests;
- service/repository integration tests;
- PostgreSQL constraints/migration tests where supported;
- API E2E;
- permission-negative tests;
- cross-workspace isolation tests;
- idempotency/retry tests;
- concurrency/version-conflict tests;
- frontend component/interaction tests;
- key end-to-end user flows;
- adapter contract tests with deterministic fakes when specialist modules are unavailable.

See `coverage-matrix.md` for coverage expectations.
