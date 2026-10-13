# Remaining implementation work

Status: IN_PROGRESS. Updated 2026-10-13 18:03 UTC (21:03 Africa/Cairo).

This checklist contains only unfinished implementation and outstanding verification. Scope remains the full four-module contract in `docs/Logic/SPA_Workflows_Inventory_Commerce/Agent.md`, all 32 specifications, Q1-Q66 and the operation inventory.

Latest verified batch: five Customer/account/CRM-link/reorder routes and six Return routes completed individually. Final `commerce-returns`, `commerce-customers` and `commerce-carts` suites passed 41/41 real database/HTTP checks. Earlier Return/Shipment regression passed 22/22. TypeScript and Prisma validation passed. Migrations 014-019 were deployed only to owned disposable databases. Owning details/evidence are in `src/server/commerce/customers.md`, `src/server/commerce/returns.md` and the matching focused tests. This does not mark the full pack or the remaining fail-closed specification scaffolds complete.

Work in five-minute batches: implement a small remaining task, run checks only for changed paths, and remove it from this checklist after verification passes. Keep unfinished parts visible when a larger task spans batches.

## Commerce: verified Refund operations

Verified all four Refund create/read/approve/process routes with current authorization, cumulative holds, permanent request dedupe, approval separation, durable provider commands, signed confirmations and independent Order payment/fulfillment projections. `tests/commerce-refunds.spec.ts`: 15/15 passed on the owned disposable database; backend build passed. A valid SKU/unit fixture was required for the physical-Return scenario. This completes this slice, not the broader Commerce module.

## Commerce: remaining lifecycle and integrations

- [x] Complete independent Refund approval/provider-confirmation lifecycle, including cumulative refundable-fund guards and Order payment/fulfillment projections after returns/refunds (15 focused checks passed).
- [ ] Implement administrative payment reconciliation/recovery for uncertain commands, unmapped receipts, exhausted inbox failures and excess unallocated funds.
- [ ] Implement customer-facing hosted/tokenized provider checkout and checkout handoff.
- [ ] Complete shipping-rate selection and required vendor-specific logistics adapters.
- [ ] Complete configured reservation timings beyond Order placement and their payment/fulfillment integration, including safe recovery for ambiguous legacy Order-line mappings.
- [ ] Complete public media/category publication behavior and shared resource registrations where required by the specifications.
- [ ] Verify the remaining Commerce configuration/publication/pricing/customer/integration paths with focused tests for this implementation.

## Smart Process Automation

- [ ] Complete schema impact/uniqueness safeguards and safe publication of field changes.
- [ ] Complete import report artifacts and expiring export downloads through the owning Files service.
- [ ] Complete TEAM scope, entitlement coverage and shared resource registrations.
- [ ] Verify the implementation's Types/Capabilities, schemas, stages, field grants, Items, relations, numbering/recurrence, import/export and retention/purge paths using focused real assertions.
- [ ] Resolve remaining scalability and authorization gaps identified by those checks.

## Workflows and Business Processes

- [ ] Install remaining owning-domain action adapters.
- [ ] Complete provider compensation and recovery without replaying completed business effects.
- [ ] Complete graph/runtime recovery and governance details.
- [ ] Verify this implementation's definitions/versions, typed graph validation, expressions, execution scopes, durable leases/checkpoints, loops/joins, approvals/delegation, waits/timers, triggers, callbacks, subworkflows, compensation and reconciliation.
- [ ] Resolve remaining race, recursion, lease-expiry and timeout defects identified by targeted checks.

## Inventory and Warehouses

- [ ] Complete negative-stock costing and financial integration safeguards.
- [ ] Complete serial/batch selection during posting and Catalog tracking-policy integration.
- [ ] Complete source unit conversions and remaining reversal eligibility rules.
- [ ] Install the shared Address authority adapter.
- [ ] Complete report Files artifacts and durable balance snapshots.
- [ ] Verify this implementation's Warehouse/location/ACL, document approval/post/reverse, costing, stocktake, reservation, tracking, reorder and controlled-job paths with focused persistence/concurrency/rollback checks.

## Frontend and API documentation

- [ ] Implement the required permission-aware SPA screens and actions.
- [ ] Implement the required Workflow designer, execution, approval and recovery screens.
- [ ] Implement the required Inventory management, document, stocktake and costing screens.
- [ ] Implement the required Commerce administration, customer checkout/account, fulfillment, return/refund and reconciliation screens.
- [ ] Complete OpenAPI request/response/error/permission documentation for the full specified operation inventory.
- [ ] Check each new or changed UI/API flow against its owning backend contract.

## Remaining verification and completion audit

- [ ] Replace outstanding fail-closed pack contract scaffolds with real assertions for this implementation.
- [ ] Verify untested implementation migrations and owning-domain invariants on isolated disposable databases as changes are completed.
- [ ] Audit every explicit requirement, operation and deliverable against actual code and focused runtime evidence before marking the goal complete.

Execution constraints: test only this implementation's changed paths; do not run the whole-application suite. Preserve unrelated work. Use owning services for cross-domain mutations, current explicit permissions and durable transactions. Use sandbox providers and owned disposable test databases. Do not apply application-database migrations, commit, push or open a PR without authorization.


## Repository layout consolidation

Updated 13/10/2026, 23:18:30 Africa/Cairo. Scope: relocate all module-pack tests and helpers from docs/Logic into tests/modules, preserve assertions, update configuration/imports/documentation and global agent guidance. Application modules already reside in src; Next.js app routes, Prisma assets and root configuration retain their required framework locations.

- Discovery: PASSED; read global AGENTS.md, inspected all eight module contracts and test/import inventories. Eight Testing folders contain 301 TypeScript test/helper files.
- Relocation and references: IN_PROGRESS.
- Verification: NOT_STARTED; planned Jest discovery, TypeScript check, focused relocated domain tests, and production build. Existing fail-closed contracts remain unimplemented and must not be reported as passing.

- Relocation: IMPLEMENTED_UNVERIFIED; moved all eight Testing folders into tests/modules, retaining all 301 TypeScript files and testing documentation. Relative imports remain unchanged. Updated Jest to discover tests/ only, removed obsolete TypeScript include paths, and updated module/global documentation references. No executable application modules were found outside the existing src/app directories.
- Jest discovery: IN_PROGRESS.
- Static relocation audit: PASSED; 301 TypeScript test/helper files retained, no executable code remains in docs, no stale module Testing paths remain in executable/configuration files, and all relative imports in moved files resolve.
- TypeScript check: IN_PROGRESS (`npm run typecheck`).
- Initial Jest discovery: PASSED (exit 0); identified an existing pattern gap: `.e2e-spec.ts` requires an explicit pattern. Added it so every relocated E2E contract is discoverable. Final discovery verification IN_PROGRESS.
- Final Jest discovery: PASSED (exit 0); discovered 347/347 suites, missing 0. Includes both unit/integration and E2E files under tests/.
- Focused relocated tests: IN_PROGRESS; checking representative Commercial, Analytics, and Calendar domain suites.
- TypeScript check: FAILED (exit 1); newly included contract files declare the same global `contract` name, and previously excluded Calendar/Chat tests expose outdated call signatures/nullability. Fixing module isolation and test typing without changing assertions.
- Focused relocated tests: PASSED (exit 0), 3 suites / 21 tests: Commercial requisites, Analytics model, Calendar recurrence engine.
- TypeScript rerun after file-local contract fix: FAILED (exit 1); 10 errors in five previously excluded Calendar/Chat test files. Updated calls to current APIs and added explicit fixture non-null assertions; all original scenario assertions retained. Next TypeScript rerun IN_PROGRESS.
- TypeScript rerun: FAILED (exit 1); one remaining query-fixture inference error. Added an explicit fixture array type; rerun IN_PROGRESS.
- TypeScript final rerun: PASSED (exit 0), `node node_modules/typescript/bin/tsc --noEmit`. Added `export {}` to 121 contract stubs to keep declarations file-local; no assertions removed or weakened.
- Affected-test invocation via `npm test -- --runTestsByPath ...`: FAILED before tests ran (exit 1); installed npm rejected argument forwarding with EUNKNOWNCONFIG. Running the existing database-start script followed by Jest directly.
- Database start: IN_PROGRESS (`npm run db:start`).
- Production build: IN_PROGRESS (`npm run build`).
- Affected relocated domain tests: PASSED (exit 0), 4 suites / 31 tests: booking page configuration, public booking reads, recurring resource reservations, and chat messages. Direct Jest invocation used the selected paths only.
- Production build: PASSED (exit 0), `npm run build`; compilation, type validation, static page generation, and build traces completed.
- Markdown relocation audit: PASSED; no broken relocated-test links detected, and no executable code remains under docs/Logic.
- Repository alias import audit: PASSED; every @/ import in all 301 moved TypeScript files resolves to an existing repository file.
- Database start: PASSED (exit 0); existing LocalPostgres.ps1 preserved the local cluster, removed a verified stale lock, and started PostgreSQL on localhost:5432. No application migrations were applied by this startup action.
- Focused relocated E2E: IN_PROGRESS; `node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath "tests/modules/Tasks&Calendar&Files&Chats/Calendar-Meetings/resource-booking.e2e-spec.ts"`. Uses the existing disposable entertabcrm_test database fixture.
- Focused relocated E2E: PASSED (exit 0), 1 suite / 8 tests; Calendar resource HTTP/PostgreSQL contracts, including the updated hydrateState call. Migrations/fixtures ran only against the owned disposable test database.

### Layout consolidation completion

Updated 13/10/2026, 23:31:58 Africa/Cairo. Status: PASSED for the requested relocation and its verification. All eight module test packs (301 TypeScript files plus 11 testing Markdown files) now reside in tests/modules. Documentation remains under docs/Logic; application/domain modules already reside in src. Global AGENTS.md, root README, module references, Jest discovery and TypeScript configuration reflect the new layout.

Verification: 347/347 suites discoverable; 8 focused suites / 60 tests passed; TypeScript and production build passed; relative/alias imports and relocated Markdown links checked. Full application tests were not run. The 121 preserved fail-closed contract suites remain unwired and are not claimed as passing or implemented. No module functionality has been declared complete by this layout task.

Focused commands executed:

```powershell
node node_modules/jest/bin/jest.js --config jest.config.ts --listTests --runInBand --json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath 'tests/modules/Commercial_Capture_ContactCenter/Company-Details-Requisites-Bank/requisites.spec.ts' 'tests/modules/Data_Integration_Intelligence_Analytics/Analytics/analytics-model.spec.ts' 'tests/modules/Tasks&Calendar&Files&Chats/Calendar-Meetings/recurrence-engine.spec.ts'
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath 'tests/modules/Tasks&Calendar&Files&Chats/Calendar-Meetings/booking-page-configuration.spec.ts' 'tests/modules/Tasks&Calendar&Files&Chats/Calendar-Meetings/booking-public-reads.spec.ts' 'tests/modules/Tasks&Calendar&Files&Chats/Calendar-Meetings/resource-recurrence.spec.ts' 'tests/modules/Tasks&Calendar&Files&Chats/Communication/chats-messages.spec.ts'
npm run db:start
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath 'tests/modules/Tasks&Calendar&Files&Chats/Calendar-Meetings/resource-booking.e2e-spec.ts'
npm run build
```


## Complete all tracked implementation work

Started 13/10/2026, 23:47:11 Africa/Cairo. Latest user scope: finish all IMPLEMENTATION_PROGRESS.md obligations; remove each progress file only after all its tracked obligations are implemented and verified. Inventory: root progress plus docs/Logic/Custom_Fields_Activities_Timeline/IMPLEMENTATION_PROGRESS.md and docs/Logic/Automation_Products_Catlouge/IMPLEMENTATION_PROGRESS.md. Preserve unrelated changes. Sequence: verify pending Refund lifecycle, audit completed module claims, then remaining owning-domain dependencies and UI/API obligations.

Reading checklist: global AGENTS.md, all three progress files, package/Jest/TypeScript configuration, SPA pack Agent.md, existing Commerce lifecycle notes and frontend AGENTS.md/package/routes read. Remaining source/spec inventories being inspected by capability; unread files are not considered reviewed.

- Refund focused checks: IN_PROGRESS; node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath tests/commerce-refunds.spec.ts.
- Refund focused checks: FAILED (exit 1), 14/15 tests passed. Physical-Return fixture omitted the Catalog-required SKU/unit metadata and failed a real database constraint before reaching Refund behavior. Corrected only the fixture to use a valid stockable Product; rerun IN_PROGRESS.
- Completed-module audit: IN_PROGRESS; running the 10 existing Fields/Activities/Automation/Catalog backend suites and the frontend Vitest suites independently.
- Refund rerun: PASSED (exit 0), 15/15 tests, including all four Next/Nest routes, physical Returns, authorization, cumulative fund holds, signed confirmations, concurrency and replay.
- Existing completed-module backend checks: PASSED (exit 0), 10 suites / 178 tests for Fields/Activities/Timeline/Automation/Catalog.
- Frontend initial check: FAILED (exit 1), 66/70 passed; four auth-shell tests could not access localStorage because Node host web storage shadowed jsdom. Updated Vitest fork arguments to use jsdom storage; focused auth-shell rerun PASSED (exit 0), 4/4.
- SPA schema safeguards: IN_PROGRESS; adding live-value/null/validation impact checks and rechecking uniqueness under the publication lock, using one key-normalization function for previews and Item writes.
- SPA schema contract: IMPLEMENTED_UNVERIFIED; replaced its nine original fail-closed domain scenarios with real database/parser assertions and added five publication regressions (late duplicates, stored nulls/zero, tightened validation, explicit case/null policy and trash/restore). Focused suite IN_PROGRESS.
- SPA schema domain checks: PASSED (exit 0), all 14 tests, including the nine original contract scenarios. TypeScript PASSED (exit 0). SPA schema HTTP contract remains pending.
- Frontend rerun: PASSED (exit 0), 6 suites / 70 tests after the storage-environment correction. Frontend lint/build and backend build IN_PROGRESS.
- Automation recorded follow-up: IMPLEMENTED_UNVERIFIED; Deal soft deletion now requires the explicit delete grant and its ownership scope before mutation/audit. Added negative scope/read-only tests and positive authorized deletion. Focused CRM authorization/lifecycle checks IN_PROGRESS.
- Completed-module HTTP verification: IN_PROGRESS; selected Fields/Activities/Timeline/Catalog/Automation API groups plus their CRM/role/user fixture dependencies from api-endpoints.spec.ts. Whole-application audit groups are not selected.
- Frontend build and lint: PASSED (exit 0 each). Backend build: PASSED (exit 0) for the schema/Refund batch; the subsequently added Deal authorization guard will be included in the next build.
- Deal authorization/lifecycle regression: PASSED (exit 0), 2 suites / 11 tests.
- SPA schema HTTP contract wiring: IN_PROGRESS; implementing all 11 original route obligations with real Next dispatch and temporary Nest HTTP, permission/tenant/DTO negatives and persisted outbox/audit checks. Added the missing SPA_FIELD_DEACTIVATED event alongside the existing draft update.
- Completed-module HTTP checks: PASSED (exit 0), 68 selected tests; 47 unrelated tests were excluded by the name filter and are not claimed as checked.
- SPA schema first HTTP run: FAILED (exit 1), 22 cases; fixture imports instantiated the application Prisma singleton before test DATABASE_URL selection. Deferred fixture imports until after disposable database setup and added an explicit current_database assertion; rerun IN_PROGRESS.
- SPA schema HTTP rerun: PASSED (exit 0), 22/22 tests across real temporary Nest HTTP and Next dispatch; owned database identity asserted. All 11 route obligations now have authentication, current grants, foreign-tenant non-disclosure, invalid DTO/ID, persisted effect, audit/outbox and relevant stale-version checks.
- Completed phase-record cleanup: Custom Fields/Activities/Timeline and Automation/Catalog phase checklists were already all checked; current verification passed 178 backend domain tests, 68 selected HTTP tests, 70 frontend tests, frontend lint/build and backend build. User authorized removal after verification. Evidence retained here. Old production-scale Automation log retention/archival advice is retained as an outstanding operational follow-up rather than silently discarded; no non-test migration deployment is claimed.
