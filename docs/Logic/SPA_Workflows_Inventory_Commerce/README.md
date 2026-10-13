# TrueCRM — SPA, Workflow, Inventory & Commerce Codex Pack

This ZIP is the **second TrueCRM implementation-ready specification contract**, scoped to:

1. Smart Process Automation
2. Workflows & Business Processes
3. Inventory & Warehouses
4. Online Store & Commerce

**Start with `Agent.md`**. Do not treat this as application source code: it defines how a coding agent must implement the modules in the TrueCRM repository. All **Q1–Q66** decisions have been confirmed, and there are **0 unresolved important decisions**.

## Contents

- `Agent.md`: master execution rules, architecture, tenant/authorization, migration/security/testing/Git.
- `Decision-Register.md`: exact 66 confirmed decisions.
- `API-Contracts.md`: common envelopes, error/validation/idempotency conventions.
- `Controller-Inventory.md`: controllers + every method/path.
- `api-operations.json`: machine-readable endpoint contract index with request and behavior per route.
- `Database-Contract.md`: domain DB/transaction/constraint model and migration rules.
- `Events-Contract.md`: domain events, outbox and cross-domain service ownership.
- `Permissions-Matrix.md`: effective authorization and public/financial access rules.
- `Source-Coverage.md`: exact source documents and boundary interpretation.
- `Traceability.md`: decision → spec → tests for all Q1–Q66.
- 4 domain directories with **32 detailed Markdown specifications** (8 per domain).
- `tests/modules/SPA_Workflows_Inventory_Commerce/`: matched fail-closed service/integration and HTTP E2E TypeScript/Jest contract files.
- `manifest.json`: generated file/operation inventory and entrypoint, SHA hashes.

## Implement one module

1. Read `Agent.md`, applicable decisions, common contracts, spec and tests.
2. Inspect the existing repository (NestJS/PostgreSQL/ORM, Auth, Notifications, Audit, Outbox, Workers, Payments, CRM, Files, API envelope).
3. Implement one endpoint end-to-end (controller, DTO, guards, service, DB, event/audit, domain transaction, tests).
4. Wire that endpoint's contract test and run service/API/tenant/security tests; fix failures.
5. Mark it PASSED in repository-local `IMPLEMENTATION_PROGRESS.md` only after verified tests.
6. Finish controller, then module, then integration regression.

## Implement whole pack

Suggested sequence: SPA → Workflows → Inventory → Commerce, revisiting cross-module adapters after their owners exist. **Do not duplicate CRM Catalog, Payment, Integration Credentials or shared platform services**; use existing interfaces. Prior TrueCRM collaboration pack's Tasks, Calendar, Files and Communication are dependencies/integration surfaces, not modules rebuilt by this pack.

## Testing expectations

`tests/modules/SPA_Workflows_Inventory_Commerce/<Module>/<spec>.spec.ts` tests business/state/data invariants. `tests/modules/SPA_Workflows_Inventory_Commerce/<Module>/<spec>.e2e-spec.ts` lists each route as a real-HTTP obligation. These are intentionally **failing scaffolds** until wired to the actual repository; they do not falsely assert production success. Each E2E route requires happy/invalid/auth/tenant/effects tests according to permission type. Critical race/idempotency cases are enumerated in module unit contracts. Do not change test semantics to get green.

## Phase model

Full production core V1: SPA metadata, fields, items, permissions, pipelines, recurrence; Workflow versioned designer/runtime/approvals/timers, safe built-in actions, compensation; Inventory ledger/reservations/docs/costing/stocktake/basic tracking; Commerce published WEB/HEADLESS, guest cart/checkout, authoritative pricing, customer account, orders/payments/shipments/return/refund. Phase 2 extensions explicitly marked: exotic storefront channels, advanced WMS picking/serial traceability, custom workflow plugin SDK and other non-core features. They are not silently treated as finished.

## Completion evidence

Require counts of implemented controllers/endpoints, migrations, unit/integration/E2E/security tests executed/passed, cross-workspace negative tests, provider simulations, residual blockers and reasons. Do not claim the pack already contains runnable app or verified endpoint implementation.
