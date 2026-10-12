# TrueCRM Pack 2 — MASTER AGENT EXECUTION CONTRACT

**READ THIS FILE FIRST.** This pack is the complete implementation contract for four connected TrueCRM product domains: Smart Process Automation (SPA), Workflows & Business Processes, Inventory & Warehouses, Online Store & Commerce. The user has confirmed the Shared Understanding Report and all Q1–Q66 decisions. **Unresolved important product decisions: 0.**

## 1. Agent mission

Implement the requested module(s) in the **existing TrueCRM repository**, not a new unrelated app. Repository first: inspect NestJS app, database ORM/migrations, Next.js frontend, authentication, tenant context, permission scopes, API envelopes, shared integrations, notifications, outbox, jobs and existing test patterns before changing code. Reuse existing shared services and domain objects; avoid rewriting other modules. Read `README.md`, `Decision-Register.md`, `API-Contracts.md`, `Database-Contract.md`, `Controller-Inventory.md`, the chosen module spec and its matching `Testing/` contracts. Do not stop after planning when implementation and test execution are feasible.

## 2. Source priority / conflict policy

Latest explicitly confirmed user decision > Q1–Q66 decision register > new TrueCRM PRD/BRD/System Architecture and domain architecture files > repository existing behavior when compatible > reference pack convention > reasonable documented implementation choice. `Agent.md` sets uniform engineering standards; module files set module business behavior. A genuine inconsistency requires a recorded resolution, not a silent choice.

## 3. Non-negotiable stack, boundaries and data ownership

- Frontend Next.js + React + TypeScript; backend NestJS + TypeScript **modular monolith** (not extra Python workflow backend). PostgreSQL is authoritative source of truth. Use repository's selected data layer (Prisma where already established); all schema changes get migrations.
- Redis only for cache, ephemeral coordination, presence/rate-limit state, not financial truth/stock truth/execution truth. Jobs/queues handle long-running work, timed resumes, bulk actions, provider retries and outbox delivery. Object storage holds export/file binaries; PostgreSQL stores metadata/permissions/lifecycle.
- Workspace UUID is tenant boundary, not CRM Company. Derive Workspace from authenticated context/store resolver, never arbitrary supplied `workspaceId`. Scope all records, relationships, indexes, queries, joins and background jobs by Workspace. UUIDs primary keys unless repository mandates alternate stable IDs. Use `timestamptz` for real instants; explicit IANA timezone for scheduling, `DATE` where date-only. Quantities/money use `NUMERIC`/Decimal, never binary float.
- Domain ownership: SPA owns type metadata/items; Workflow owns definitions/versions/instances; Inventory owns warehouse/balances/ledger/reservation; Commerce owns store/cart/order/shipment/return. CRM Catalog owns master Products; shared Payments own provider payment/refund records where already present; shared Auth, Audit, Search, Timeline, Tasks, Files, Notifications, Integrations own their existing data. Cross-module effects via owning application services/outbox/saga, not direct foreign-module SQL writes.

## 4. Naming and API rules

- TypeScript `camelCase`, SQL snake_case through mapper; enums explicit uppercase strings; events UPPER_SNAKE_CASE; route prefix `/api/v1`. No ad hoc route naming outside Controller Inventory and `api-operations.json`.
- Use documented HTTP response envelopes/error envelope/status and pagination from `API-Contracts.md`. `PUT` replaces all editable state, `PATCH` changes supplied fields, state transitions use `POST /.../action`. All requests strict DTO allowlist/type/range validation, Stable error codes. Lists use `page=1 limit=20 max=100`, search/filter/sort with explicit field whitelists; streams use cursor when specified.
- `expectedVersion` on shared aggregates; stale update 409 and no mutation. Retry-sensitive commands require `Idempotency-Key`; same key+hash yields prior result, changed payload 409, durable domain-specific dedupe retains business uniqueness beyond short HTTP keys. No GET side effects.
- Public Storefront APIs resolve published Store by slug and high entropy Cart/Checkout tokens, never expose admin/warehouse/cost/CRM fields. Payment/Delivery callbacks verify signatures, timestamp, replay, stable provider event IDs before mutation. Rate-limit coupon probing and checkout.

## 5. Authorization and zero-trust input

Authentication alone is never authorization. Combine active Workspace membership, action permission, OWN/DEPARTMENT/DEPARTMENT_TREE/TEAM/ALL scope, SPA type/stage/field grants, Warehouse and document-type permission, Workflow runner service account scope, Commerce Store/Order/Payment/Refund permission, feature entitlement and lifecycle state. External API/OAuth/service scope is intersection, not a bypass. Public/customer/store tokens authorize only their exact resource action. Cross-tenant IDs never reveal data (prefer 404 inaccessible resource response). Search/filter/sort/export/log response must not leak hidden/secret fields.

## 6. Invariants (must hold transactionally)

- SPA published schemas immutable; field type changes/unique constraints require impact preview and safe migration; stage changes validate permissions+required fields; deletion cannot recursively destroy linked Tasks/Files/Calendar.
- Workflow published version immutable. Every Instance stores exact version. Timers, waits, human approvals, node attempts and execution tokens durable. Exactly-once **business effect** via idempotent consumer and DB uniqueness, not assumed worker exactly-once. Parallel joins/loop bounds explicit. HTTP expressions no shell/SQL/eval/unsafe destinations. `STARTER` execution default and scoped service accounts audited. Cancellation compensates only explicit Saga actions.
- Inventory movements append-only. Balances derived and rebuildable; reserved != on-hand; no negative physical stock/backorder by default; warehouse access intersects document-type permission. Processing document locks rows in stable order; movements+cost allocations+balances+document status+audit/outbox commit atomically. Correction via reversal/adjustment, not edit/delete history. FIFO/AVERAGE workspace policy locked after first posting without controlled migration.
- Commerce backend recalculates authoritative price/tax/discounts; Order lines/customer/address/tax are immutable snapshots. One Checkout Session converts to only one successful Order. Order, Payment, Shipment, Return, Refund and Inventory Sale are independent lifecycle records. Shipping cannot succeed when required Inventory posting fails; provider callback required to confirm payment, not browser redirect. Partial Payments and partial/multi-warehouse Shipments work. No normal Order hard-delete after creation.

## 7. Shared platform effects and external safety

Durable mutation + outbox + domain history + central Audit where security/financial-critical in one transaction. Domain event schema in `Events-Contract.md`. Shared Integration module delivers outgoing webhooks with signed payload/backoff/DLQ. Integration Credential Store holds secrets; domain config stores only credential/connection ID. HTTP actions enforce DNS+redirect SSRF checks. Jobs carry Workspace principal/permissions and replay safely. Provider timeouts never become unverified success. Global Audit immutable, independent of routine high-volume domain history. Legal Hold blocks retention purge. No full AI agents, new payment processor, custom storefront CMS, custom marketing sender or standalone microservice is included merely by extension reference.

## 8. Endpoint-by-endpoint implementation sequence

Recommended dependency order: SPA Types/Schema/Items/Stages/Permissions/relations/recurrence/imports; Workflow Versions/Graph/Engine/approvals/waits/subflows/actions/runtime; Inventory Warehouses/Ledger/Costing/Documents/Reservations/Stocktakes/Policies/Tracking; Commerce Store/Public Catalog/Prices/Cart/Checkout/Orders/Payments/Shipments/Return/CRM sync. A repository dependency may justify rearrangement without losing coverage.

For each endpoint or atomic dependent pair:
1. Read full matching specification, API operation in `api-operations.json`, referenced models, scenarios and common contract.
2. Inspect existing DTO/controller/service/repository and reuse established platform components.
3. Build complete vertical slice and required schema/migration, guards, validation, state machine, transactions, audit/outbox, idempotency and jobs.
4. Replace matching fail-closed unit/integration and E2E contract scaffolds with **real assertions**, create fixtures for separate workspaces/roles/permissions, and test POST/PATCH persistence and cross-domain effects.
5. Run lint/typecheck/targeted unit, integration, E2E and security tests. Verify DB mutation, rollback, outbox uniqueness, concurrency, provider failure, tenant isolation. Fix before marking endpoint PASSED.
6. Track method+path, spec, implementation/test statuses in `IMPLEMENTATION_PROGRESS.md`; statuses NOT_STARTED/IN_PROGRESS/BLOCKED/PASSED. Never mark Passed based on mocks only or tests you did not run.
7. After each controller run its entire tests; after each module run full regression; after pack run clean DB migrations and full suite. Do not ask approval per endpoint unless genuine blocker; continue independent work and report blockers.

## 9. Tests and completion gate

`Testing/` has intentionally failing Jest-style contract scenarios. They are NOT a runnable green suite until adapted to the repository. Do not delete, skip, `.todo`, replace with static true assertions, or change business outcomes just to get green. Unit tests cover domain invariants; E2E covers actual HTTP and persistence with outbox, authorization and tenant isolation. Add concurrency/barrier tests for double reservations, checkout duplicate orders, double captures/refunds, workflow timer/node recovery. Use sandbox/mock provider adapters with signed simulated callbacks; live keys must never be embedded in tests or repository.

Report a controller/module FINISHED only when every specified route and side effect is implemented, migrations run and all required tests pass with no hidden disabled cases. Full Definition of Done: exact controller inventory route parity, permission/tenant checks, durable effects, audit, outbox, integration failures, frontend if in repository scope, clean migrations, no unresolved spec TODOs or blocked tests. Never claim successes that were not actually run.

## 10. Git safety

Preserve existing uncommitted work. Do not reset/force push, rewrite unrelated files/history, introduce secrets, commit/push/open PR unless explicitly directed. Repository is authoritative for folder/file layout and run scripts. Never silently change a confirmed requirement because code is inconvenient.
