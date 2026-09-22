# Executable Test Contracts

These `.spec.ts` / `.e2e-spec.ts` files are intentionally executable Jest-style contract tests that fail until the coding agent wires them to the real repository.

They are not placeholders to delete.

The agent must:
1. Read the corresponding module `.md`.
2. Inspect the repository's existing testing framework.
3. Adapt imports, setup and factories to the real codebase.
4. Replace each `contract()` failure with a real assertion against the implementation.
5. Never skip, delete or convert required scenarios to `todo` simply to obtain a passing suite.
6. Run the targeted tests until green.
7. Run the full repository test suite.
8. Only then report the module FINISHED.

If the repo uses Vitest or another established runner, translate the tests to that framework rather than introducing a second runner.

Each file is valid TypeScript/Jest-style source so the agent can immediately discover the required behaviors.
