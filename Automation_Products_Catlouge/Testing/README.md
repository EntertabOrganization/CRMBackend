# Executable Test Contracts

The `.spec.ts` / `.e2e-spec.ts` files in this folder are intentionally executable Jest-style behavioral contracts. They fail until a coding agent adapts them to the actual TrueCRM repository and replaces each `contract()` marker with a real assertion.

They are **not** disposable placeholders.

The coding agent must:

1. read the corresponding module specification;
2. inspect the repository's test framework, factories and setup;
3. adapt imports/setup to real services/controllers/UI;
4. replace each contract failure with real assertions;
5. never skip/delete/weaken a required case merely to get green;
6. run targeted tests;
7. run full regression tests;
8. report exact results/counts when tools provide them.

If the repository uses Vitest, Playwright, Cypress or another established tool, translate to that tool rather than introducing duplicate infrastructure.

Security and tenant-isolation cases are mandatory.
