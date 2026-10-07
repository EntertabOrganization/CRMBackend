# Executable Test Contracts

The `.spec.ts` and `.e2e-spec.ts` files in this directory are executable Jest-style contract tests that intentionally fail until a coding agent wires them to the real TrueCRM repository.

They are not placeholders to delete.

For every requested module the coding agent must:

1. Read `Agent.md`.
2. Read the matching domain `overview.md` and child spec.
3. Inspect the repository's actual testing framework, setup, factories and database strategy.
4. Move/adapt/wire these contracts into that established layout.
5. Replace `contract()` failures with real assertions against real services/APIs.
6. Never skip/delete/weaken/convert required scenarios to `todo` just to get green.
7. Run targeted tests until green.
8. Run the complete repository regression suite.
9. Report exact commands/results and any remaining manual provider smoke tests.

If the repository uses Vitest or another runner, translate these contracts rather than adding a second test framework.

Provider-dependent tests must use deterministic fakes/mocks. Real provider smoke testing is separate and must not be falsely claimed.
