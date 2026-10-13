# Repository agent execution contract

## Purpose and scope

This is the root instruction file for every agent working in this repository. Read it at the beginning of every new task, resumed session, or module switch. The user supplies one module, several modules, or an explicit request to complete all modules. Carry that scope through implementation, tests, and builds; do not stop after producing a plan. Do not add work outside the user's requested scope.

Reading the whole project provides context. It does not authorize implementing unrelated modules. If no implementation scope has been supplied, finish repository discovery and ask which module(s) to work on before changing application behavior. For a request to complete all modules, build a dependency-ordered plan covering every module below and continue through it.

## Repository layout

- Application/domain modules: `src/`.
- Next.js route handlers: `app/` (framework-required).
- Operational scripts: `Script/` (existing repository convention).
- Executable tests and fixtures: `tests/`; module-pack suites: `tests/modules/<module-pack>/`.
- Module specifications and execution contracts: `docs/Logic/<module-pack>/`.
- Prisma schema/migrations: `prisma/`; tool configuration remains at the repository root.

Do not create executable modules or tests inside documentation folders.

## 1. Read the project before implementing

At each task start or resume:

1. Read this `AGENTS.md`, any applicable nested `AGENTS.md`, root `README.md`, `package.json`, `jest.config.ts`, `tsconfig.json`, and existing implementation progress files.
2. Check `git status --short` and inventory the entire maintained repository using `rg --files --hidden` with exclusions for generated/local directories. Preserve existing changes, including untracked work.
3. Read the maintained text files across the whole project in manageable batches: module documentation, source code, routes, database schema and migrations, scripts, configuration, and tests. Include **all Markdown files**, including module `Agent.md`, decision registers, API/database/event contracts, inventories, traceability, coverage matrices, and testing instructions. Use a file checklist so unread or truncated files are not silently treated as read.
4. Exclude `.git`, `node_modules`, `.next*`, `dist`, coverage output, caches, `.local-postgres`, `.local-file-objects`, generated build artifacts, and binary files. Do not print secrets or read private `.env` values for discovery; use `.env.example` for configuration requirements. These exclusions do not exclude maintained source, specifications, migrations, or tests.
5. Map the actual architecture: application entry points, route handlers, services, persistence, authentication, Workspace authorization, shared domain ownership, audit/outbox, jobs, provider adapters, and test infrastructure. Understand implemented behavior and unfinished scaffolds before editing.
6. Before starting each selected module, reread its complete folder, including every nested Markdown file, its `Agent.md` and any `AGENTS.md`, `tests/modules/<module-pack>/` contracts, and related implementation/tests elsewhere in the repository. Read owning-module contracts for cross-module dependencies too.

Do not rely only on a previous session's summary. Recheck current files against the current working tree. After context loss within the same task, recover scope and verification state from the conversation and existing records, and reread affected files.

## 2. Module contracts lead implementation

Use the selected folder's `Agent.md` as the module execution contract and its specifications as the business requirements. This root file coordinates discovery, scope, tracking, and verification; it does not replace module business rules.

| Module pack | Contract |
| --- | --- |
| Auth and identity | `docs/Logic/Auth_Module/Agent.md` |
| CRM core and pipelines | `docs/Logic/CRM_Core_Pipelines/Agent.md` |
| Custom fields, activities, timeline | `docs/Logic/Custom_Fields_Activities_Timeline/Agent.md` |
| Automation and products/catalog | `docs/Logic/Automation_Products_Catlouge/Agent.md` |
| Commercial, capture, contact center | `docs/Logic/Commercial_Capture_ContactCenter/Agent.md` |
| Data, integration, intelligence, analytics | `docs/Logic/Data_Integration_Intelligence_Analytics/Agent.md` |
| Tasks, calendar, files, chats | `docs/Logic/Tasks&Calendar&Files&Chats/Agent.md` |
| SPA, workflows, inventory, commerce | `docs/Logic/SPA_Workflows_Inventory_Commerce/Agent.md` |

The user's latest explicit instructions control scope and execution constraints. Respect applicable instruction hierarchy and each module's documented requirement priority. Resolve documentation conflicts explicitly in the relevant decision/progress record; ask only when an unresolved business decision prevents correct implementation. Continue independent work while a genuine blocker is pending.

For multiple modules, identify dependencies and implement shared prerequisites first. Track each module independently, then verify their integrations. Use owning services for cross-module writes; do not bypass a module's invariants with direct table updates. Reuse current architecture and conventions rather than rewriting the project to match a specification's example framework.

The executing agent leads the work: derive the implementation sequence, implement it, fix failures, and maintain evidence. Do not spawn additional agents unless the user or applicable instructions explicitly authorize delegation.

## 3. Fixed scope and no new progress files

The user's latest instruction supersedes all earlier progress-file requirements, including nested module contracts. Do not create, recreate, or replace `IMPLEMENTATION_PROGRESS.md`, similarly named progress Markdown files, or alternative tracking documents. Do not add new obligations to the existing checklist. Finish its existing obligations, verify them, and remove an existing progress file only when every obligation it tracks is complete. Preserve unfinished obligations until then; deleting a checklist does not complete its work.

Do not recreate the removed `Repository layout consolidation`, `Layout consolidation completion`, or `Complete all tracked implementation work` sections, or replace them with equivalent historical tracking sections. Keep the repository layout rules above as the continuing file-placement instructions.

Before changing code, establish the following in the conversation or temporary working notes:

- Requested scope, module folders, dependency order, and current reading checklist.
- The already authorized features, operations, integrations, migrations, and deliverables from the selected specifications.
- Existing implementation, actual gaps, next batch, and blockers.
- Requirement-to-source-to-test mapping and planned verification commands.

Use separate implementation, test, and build states. Suggested states are `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `PASSED`, `FAILED`, and `BLOCKED`. A feature is complete only when all required implementation and verification obligations pass.

Suggested requirement table:

| Requirement / method + route | Specification | Source files | Implementation | Test files under `tests/` | Tests | Build | Remaining work |
| --- | --- | --- | --- | --- | --- | --- | --- |

Report verification in the conversation: command, selected tests, actual exit code and counts, failures, and remaining work. Existing progress files may be updated for their existing obligations until removed; never recreate them afterward. Never infer a pass from an earlier run.

## 4. Implement and verify in batches

For each module, repeat this loop until the requested scope is complete:

1. Select a bounded batch from the user's scope or an existing checklist. Track its state in the conversation; do not create a record when none exists.
2. Implement the complete specified behavior, including validation, permissions, tenant isolation, persistence, lifecycle rules, and required integration effects. Include migrations, API documentation, and frontend work when required by the selected scope.
3. Report actual changed files, completed behavior, and remaining gaps. Treat implemented behavior as unverified until its required checks pass.
4. Create or adapt meaningful executable module tests in the root `tests/` folder. Run the selected tests and report the result.
5. Fix failures and rerun affected tests. Report failed attempts as well as successful checks.
6. Run the required type/schema checks and production build for the batch. Report actual results, including failures and reruns. A successful test run does not imply a successful build.
7. Mark only verified requirements `PASSED` in any existing checklist and proceed to the next batch/module. Do not create a missing record.

If a check cannot run, record the reason and exact pending command as `BLOCKED` or unverified. Continue work that does not depend on it. Never claim the module is finished while required checks or deliverables remain outstanding.

## 5. Global test location and coverage

All new executable module tests belong under root `tests/`, using existing conventions such as `tests/<module>-<feature>.spec.ts` and reusable fixtures in `tests/support/`. Read the selected module's entire `tests/modules/<module-pack>/` folder as the coverage contract. Adapt its scenarios into executable tests against the real implementation; retain traceability to the original contract.

Module-pack suites and helpers now live in `tests/modules/<module-pack>/`, including preserved contract scaffolds. Jest discovers all suites under `tests/`; intentionally unwired contracts still fail and are not evidence of implementation completion. Preserve every scenario and execute each suite exactly once. Do not silently leave required scenarios behind as unexecuted placeholders. Jest explicitly discovers both `**/*.spec.ts` and `**/*.e2e-spec.ts` under the global test root.

Cover specified success, invalid input, authentication/authorization, cross-Workspace access, persisted effects, lifecycle failures, and relevant rollback, idempotency, concurrency, audit/outbox, and provider failure cases. Use real database/HTTP integration where the contract requires it and sandbox providers at external boundaries. Do not replace real assertions with static success, skip required scenarios, delete failing contract checks, or loosen business outcomes to obtain a pass.

Database checks must use owned disposable test databases and fixtures. Inspect setup before running tests: `tests/api-endpoints.spec.ts` recreates `entertabcrm_test`. Do not reset shared/application databases or apply application migrations merely to make tests pass. Preserve current user restrictions on migration/deployment actions.

## 6. Repository verification commands

Read current `package.json` and Jest configuration before choosing commands; these examples reflect the repository when this file was created.

```powershell
# Exact module files; replace the examples with the selected module's files.
npm run db:start
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath tests/commerce-returns.spec.ts tests/commerce-customers.spec.ts

# Batch/module checks; record each result separately.
npm run typecheck
npm run prisma:validate
npm run build
```

`npm test` invokes `pretest`, which starts the local PostgreSQL cluster. `npm run build` is the shared Next.js production build; the repository currently has no separate build command per module. Attribute its result to the checked batch/working tree and distinguish unrelated existing failures from new failures without concealing either.

After each module, run its entire focused suite and affected dependency/integration regression tests, then verify the build. At completion of the requested modules, run the module-contract-required broader regression and final checks, subject to the user's current constraints. If full application verification is authorized and required, the existing commands are:

```powershell
npm test
npm run test:endpoints
npm run test:endpoints:live
npm run test:all
```

Choose the necessary commands without redundantly repeating already covered checks: `test:all` includes typecheck, Prisma validation, Jest, live endpoints, and a build. Do not run the full application suite when the user has restricted verification to selected modules. Record the resulting verification limit explicitly. If a combined command stops at a failure, later stages remain unrun and must not be marked passed.

## 7. Completion and handoff

A requested module is complete only when its authorized requirements are implemented, required executable tests pass, required migrations are verified in the permitted environment, and applicable integration checks and build pass, with actual evidence and no hidden unfinished obligations.

For an all-modules request, apply that gate to every discovered module and their shared integrations. Do not label the project complete based on a single module or passing scaffolds.

Keep working autonomously through the authorized scope. Preserve unrelated changes; do not commit, push, deploy, or modify external systems without applicable authorization. Remove completed implementation progress files after verification and do not write them again. The final response should state the implemented work, verification results, removed records, and any remaining blockers or unverified work.
