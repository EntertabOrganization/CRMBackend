# Remaining implementation work

Status: IN_PROGRESS. Updated 15/10/2026 (Africa/Cairo).

This checklist contains only unfinished implementation and outstanding verification. Scope remains the full four-module contract in `docs/Logic/SPA_Workflows_Inventory_Commerce/Agent.md`, all 32 specifications, Q1-Q66 and the operation inventory.

Latest verified work in this run: SPA transfer artifact authorization/expiry (72 tests across 11 focused suites) and Automation diagnostic retention (14 real database/HTTP checks plus 45 affected engine/extension regression checks). Final typecheck, Prisma validation and production build exited 0. Both additive migrations were applied only on owned disposable databases; application migrations and production jobs were not run. Earlier verified work: Refund lifecycle (15 checks), SPA schema safeguards (16 domain + 22 real Next/Nest route checks), private import reports/export artifact storage, shared Inventory Address authority and database guards, confirmed Project/Workgroup TEAM scope, current SPA entitlements and Workflow stage DTO translation. Two older all-completed phase progress records were verified and removed previously. This does not mark the full four-module pack or its remaining frontend/contract work complete. Scope remains fixed to existing obligations; no progress files have been created or recreated.

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

- [x] Complete schema impact/uniqueness safeguards and safe publication of field changes (16 domain checks and 22 real Next/Nest route checks passed).
- [x] Publish scanned private import report artifacts through the owning Files service, atomically with row totals and terminal job evidence (4 focused transfer checks passed, including durable export artifacts and expiry projection).
- [x] Finish review of download authorization/expiry against all specified paths. Implementation PASSED; tests PASSED; build PASSED. Immutable Files object-to-job provenance survives copies and eventual removal of the original File. Cached grants, bounded processing reads and status access enforce current Workspace membership/SPA entitlement, job scope, exported Item and field/filter permissions and expiry; byte delivery rechecks after storage I/O. Public File/folder delivery, editor access and template repurposing reject private job artifacts. `tests/spa-transfers.spec.ts`: 16 persistence/security/migration checks; `tests/spa-artifact-delivery.e2e-spec.ts`: real Next issuance/redemption/revocation. Final affected regression passed 72/72 tests across 11 suites (exit 0), including both transfer contract suites and owning Files/delivery/editor/document/Call checks. Clean migration and representative prior-schema backfill passed on owned disposable databases. Initial attempts exposed fixture status/time/purge mistakes and test database initialization issues; those were corrected without weakening database guards. Broader SPA/module obligations below remain unfinished.
- [x] Implement and verify TEAM scopes at Type and Stage levels using user-confirmed linked project/workgroup membership, plus current Workspace SPA entitlement checks.
- [x] Complete remaining shared resource registrations and cross-module entitlement/integration audit. Implementation PASSED; tests PASSED; build PASSED. Assignment notification in the reassignment transaction (idempotent per Item version, membership/preference aware, no field values copied), `SPA_ITEM_ASSIGNED` history/outbox on PUT/PATCH, plan-disabled SPA denying only SPA-bound shared resources and per-Type capability intersection. `tests/spa-shared-integrations.spec.ts` passed in the focused SPA run below.
- [x] Verify the implementation's Types/Capabilities, schemas, stages, field grants, Items, relations, numbering/recurrence, import/export and retention/purge paths using focused real assertions. Implementation PASSED; tests PASSED; build PASSED. Focused SPA run (16 contract suites under `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/` + 5 `tests/spa-*` suites): first attempt 196/197 passed, 1 failed because `tests/spa-transfers.spec.ts` hard-coded a Windows `psql.exe` path; made it platform-aware (no assertion changed) and the rerun passed 16/16, giving 197/197 across 21 suites. `npm run typecheck`, `prisma validate` and `npm run build` exited 0.
- [x] Resolve remaining scalability and authorization gaps identified by those checks. Relation-unlink request fields, personal-view event evidence, entitlement quotas and external API credential scope intersection passed in the focused SPA run above; the per-request active-Type lookup is covered by the same run.

SPA verification batch: completed. All SPA contract scenarios run against real migrated disposable databases and both real Nest and Next adapters (197/197). SPA UI screens and OpenAPI completeness remain tracked under Frontend and API documentation.

## Workflows and Business Processes

- [ ] Install remaining owning-domain action adapters.
- [ ] Complete provider compensation and recovery without replaying completed business effects.
- [ ] Complete graph/runtime recovery and governance details.
- [ ] Verify this implementation's definitions/versions, typed graph validation, expressions, execution scopes, durable leases/checkpoints, loops/joins, approvals/delegation, waits/timers, triggers, callbacks, subworkflows, compensation and reconciliation.
- [ ] Resolve remaining race, recursion, lease-expiry and timeout defects identified by targeted checks.

## Inventory and Warehouses

- [x] Complete negative-stock costing and financial integration safeguards. (Verified: inventory-policies-automation.spec.ts 8/8, costing.spec.ts 7/7.)
- [x] Complete serial/batch selection during posting and Catalog tracking-policy integration. (Verified: serial-batch-barcode.spec.ts 7/7, stocktakes.spec.ts 7/7.)
- [ ] Complete source unit conversions and remaining reversal eligibility rules.
- [x] Install the shared Address authority adapter, including owning permission/lifecycle checks and tenant-safe database binding guards (7 focused checks passed).
- [ ] Complete report Files artifacts and durable balance snapshots.
- [ ] Verify this implementation's Warehouse/location/ACL, document approval/post/reverse, costing, stocktake, reservation, tracking, reorder and controlled-job paths with focused persistence/concurrency/rollback checks.

## Frontend and API documentation

- [ ] Implement the required permission-aware SPA screens and actions.
- [ ] Implement the required Workflow designer, execution, approval and recovery screens.
- [ ] Implement the required Inventory management, document, stocktake and costing screens.
- [ ] Implement the required Commerce administration, customer checkout/account, fulfillment, return/refund and reconciliation screens.
- [ ] Complete OpenAPI request/response/error/permission documentation for the full specified operation inventory.
- [ ] Check each new or changed UI/API flow against its owning backend contract.

## Operational follow-up retained from completed Automation phase

- [x] Implement/verify platform retention or archival for high-volume Automation execution diagnostics before production scale, retaining critical Audit and immutable configuration history. Implementation PASSED; tests PASSED; build PASSED. `src/server/automation/diagnostic-retention.ts` implements bounded oldest-first log pruning with current Workspace policy, shared retention/hold fencing, tenant isolation and atomic Audit/outbox totals. The scheduler-token-protected `POST /api/v1/internal/crm/jobs/automation-diagnostic-retention` has strict input and OpenAPI/operational documentation in `src/server/automation/RETENTION.md`. Pending/running/retryable-failed executions and active recovery Jobs retain diagnostics; checkpoint results, action attempts/idempotency, Jobs, published revisions and existing Audit are preserved. `tests/automation-diagnostic-retention.spec.ts` passed 14/14 persistence/HTTP checks, including rollback, concurrency, holds and malformed configuration; engine/extension regression passed 45/45 checks. The initial nine-check attempt failed because the SQL used generic failure status names; it was corrected to the actual Automation lifecycle without removing scenarios. The indexed migration passed on an owned clean disposable database. Final `npm run typecheck`, `npm run prisma:validate` and `npm run build` exited 0; a concurrent typecheck briefly failed during build regeneration of `.next` types and passed when rerun after the build. Production scheduling/application migration were not performed. The previously recorded Deal delete-permission gap remains fixed and tested.

## Remaining verification and completion audit

- [ ] Replace outstanding fail-closed pack contract scaffolds with real assertions for this implementation.
- [ ] Verify untested implementation migrations and owning-domain invariants on isolated disposable databases as changes are completed.
- [ ] Audit every explicit requirement, operation and deliverable against actual code and focused runtime evidence before marking the goal complete.

Execution constraints: test only this implementation's changed paths; do not run the whole-application suite. Preserve unrelated work. Use owning services for cross-domain mutations, current explicit permissions and durable transactions. Use sandbox providers and owned disposable test databases. Do not apply application-database migrations, commit, push or open a PR without authorization.
