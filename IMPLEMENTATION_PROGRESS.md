# Remaining implementation work

Status: IN_PROGRESS. Updated 14/10/2026, 00:28:15 Africa/Cairo.

This checklist contains only unfinished implementation and outstanding verification. Scope remains the full four-module contract in `docs/Logic/SPA_Workflows_Inventory_Commerce/Agent.md`, all 32 specifications, Q1-Q66 and the operation inventory.

Latest verified work: Refund lifecycle (15 checks), SPA schema safeguards (16 domain + 22 real Next/Nest route checks), private import reports/export artifact storage, shared Inventory Address authority and database guards, confirmed Project/Workgroup TEAM scope, current SPA entitlements and Workflow stage DTO translation. The combined affected regression passed 73 tests; subsequent TEAM/Stage/entitlement/Address and owning Projects checks passed. Two older all-completed phase progress records were verified and removed at the user's request. This does not mark the full four-module pack or its remaining frontend/contract work complete. Latest instruction fixes scope to existing obligations and prohibits creating or recreating progress files; global and module Agent instructions updated accordingly.

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
- [ ] Finish review of download authorization/expiry against all specified paths. The eight original import/export/recycle domain scenarios and all seven route scenarios (14 Nest/Next HTTP checks) now pass; cached Files download paths still require the remaining authorization/expiry audit.
- [x] Implement and verify TEAM scopes at Type and Stage levels using user-confirmed linked project/workgroup membership, plus current Workspace SPA entitlement checks.
- [ ] Complete remaining shared resource registrations and cross-module entitlement/integration audit.
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

- [ ] Implement/verify platform retention or archival for high-volume Automation execution diagnostics before production scale, retaining critical Audit and immutable configuration history. The previously recorded Deal delete-permission gap is fixed and tested.

## Remaining verification and completion audit

- [ ] Replace outstanding fail-closed pack contract scaffolds with real assertions for this implementation.
- [ ] Verify untested implementation migrations and owning-domain invariants on isolated disposable databases as changes are completed.
- [ ] Audit every explicit requirement, operation and deliverable against actual code and focused runtime evidence before marking the goal complete.

Execution constraints: test only this implementation's changed paths; do not run the whole-application suite. Preserve unrelated work. Use owning services for cross-domain mutations, current explicit permissions and durable transactions. Use sandbox providers and owned disposable test databases. Do not apply application-database migrations, commit, push or open a PR without authorization.
