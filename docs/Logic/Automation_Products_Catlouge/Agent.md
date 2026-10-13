# TrueCRM Automation + Products — Agent Execution Contract

## Purpose

This pack is the implementation contract for the **Automation Rules & Triggers** and **Products & Catalog** capabilities of TrueCRM.

A coding agent may be given a goal such as:

```text
Complete Automation Rules & Triggers
Complete Products & Catalog
Complete both modules
Review an existing implementation against this pack
```

The agent must read this file first, inspect the real repository, read every specification relevant to the goal, implement or review the requested scope, adapt the executable contract tests to the repository, run targeted and regression checks, fix defects, and report exact results.

Do not stop after scaffolding or a plan unless a genuine human decision or unavailable external credential blocks progress.

---

## 1. Authority and requirement priority

Use this priority when sources conflict:

1. Latest explicit human decision recorded in `Decision-Register.md`.
2. This pack's module specifications and shared contracts.
3. TrueCRM PRD / BRD / System Architecture.
4. Existing repository behavior and conventions, when they do not change locked business behavior.
5. Bitrix REST documentation as reference behavior only.
6. Engineering judgment.

Bitrix is a design reference, **not** a compatibility target. Do not copy Bitrix-specific identifiers, storage models, UI terminology, or unrelated business behavior unless this pack explicitly adopts the behavior.

---

## 2. Non-negotiable platform architecture

- Frontend: Next.js + TypeScript.
- Backend: NestJS + TypeScript.
- Transactional source of truth: PostgreSQL.
- Architecture: modular monolith with clear domain boundaries.
- Cache/ephemeral state: Redis where already used.
- Long-running work: shared job/queue infrastructure.
- Important domain changes: transactional state change + outbox record in one commit.
- Realtime is delivery/UI freshness, not business truth.
- Every business record is scoped to one Workspace.
- Backend authorization is authoritative.
- Do not trust a client-supplied Workspace ID for access.
- Cross-module writes go through the owning module's application/domain service, never by direct table manipulation.
- Reuse existing repository conventions, libraries, guards, interceptors, DTO patterns, API wrappers, testing tools, and migration style.
- Persistence is repository-first. If the repository has no established ORM/data-access standard, Prisma is the fallback recommendation.

---

## 3. Domain ownership boundaries

### Automation Rules & Triggers owns

- automation rule definitions;
- immutable published revisions;
- trigger definitions and trigger bindings;
- declarative conditions;
- ordered action configuration;
- automation schedules/delays;
- jobs and action executions;
- execution logs and retry/cancel state;
- loop/depth protection;
- custom registered action/trigger definitions;
- dry-run evaluation.

### Automation does NOT own

- CRM entity persistence;
- pipeline/stage truth;
- Task truth;
- Activity truth;
- Communication delivery truth;
- Files/Documents truth;
- long-running human/parallel business workflows.

Complex durable orchestration with waits, approvals, parallel branches, compensation, or long-lived instances belongs to the **Workflows** module. Automation is lightweight event/stage-driven process behavior.

### Products & Catalog owns

- catalogs;
- category hierarchy and product-category membership;
- Product/Service master records;
- parent Products and Variants;
- SKU identity;
- catalog-specific properties;
- units and unit ratios;
- price types and current prices;
- default tax configuration;
- media/file bindings;
- reusable product-row construction/snapshot rules.

### Products & Catalog does NOT own

- stock movement or reservations — Inventory owns them;
- shopping carts/orders/shipments — Commerce owns them;
- Deal lifecycle — CRM Core owns it;
- Estimate/Invoice lifecycle — Commercial Documents owns it;
- file bytes — Files/Documents owns them.

---

## 4. Repository-first workflow

Before editing code:

1. Read this entire file.
2. Read `README.md` and `Decision-Register.md`.
3. Read the applicable module and Shared specs.
4. Inspect repository `package.json` files and scripts.
5. Inspect NestJS module structure and dependency conventions.
6. Inspect current database schema and applied migrations.
7. Inspect Workspace context and tenant guards.
8. Inspect authorization, role/scope, stage/field permission patterns.
9. Inspect outbox, event bus, queues, schedulers and idempotency helpers.
10. Inspect API response/error/pagination conventions.
11. Inspect frontend data fetching, forms, dialogs, tables, drag/drop and permission patterns.
12. Inspect tests and factories.
13. Identify reusable capabilities and only then implement missing behavior.

Do not invent repository state. If a dependency module is not implemented, introduce a narrow adapter/interface rather than creating a duplicate substitute domain.

---

## 5. Workspace isolation and relationship validation

Every Workspace-scoped table must include `workspace_id` or inherit the scope through a parent that is validated in every mutation/query path.

The implementation must reject:

- using a Rule from Workspace A against a record from Workspace B;
- cross-workspace trigger targets;
- custom extension definitions from another workspace/app installation;
- products, categories, price types, units, tax references or variants from another workspace;
- adding a Product from Workspace A to a CRM row in Workspace B;
- cross-workspace category membership;
- cross-workspace parent/Variant relationships.

Knowing a valid UUID must never grant access.

---

## 6. Authorization principles

Authentication is separate from authorization.

Automation administration must use explicit permissions such as the repository's equivalent of:

```text
AUTOMATION.READ
AUTOMATION.MANAGE
AUTOMATION.PUBLISH
AUTOMATION.EXECUTE
AUTOMATION.RETRY
AUTOMATION.VIEW_LOGS
AUTOMATION.MANAGE_EXTENSIONS
```

Product/catalog operations must support the repository's equivalent of:

```text
CATALOG.READ
CATALOG.MANAGE
PRODUCT.READ
PRODUCT.CREATE
PRODUCT.UPDATE
PRODUCT.ARCHIVE
PRODUCT.DELETE
PRICE_TYPE.MANAGE
PRODUCT_PRICE.MANAGE
PRODUCT_ROW.MANAGE
PRODUCT_ROW.EDIT_PRICE
PRODUCT_ROW.EDIT_DISCOUNT
PRODUCT_ROW.EDIT_TAX
```

Scopes must reuse the established TrueCRM authorization model where applicable. Backend services perform final decisions; frontend visibility never substitutes for enforcement.

Automation execution identity is explicit. It is never an unrestricted platform superuser.

---

## 7. API conventions

Base prefix:

```text
/api/v1
```

Reuse repository response wrappers if they already exist. Otherwise use the standard TrueCRM shapes:

Successful single resource:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Human-readable explanation.",
    "details": null
  },
  "requestId": "correlation-id"
}
```

Never expose raw ORM errors, SQL errors, provider secrets, internal stack traces, or another tenant's identifiers.

List endpoints must whitelist searchable/filterable/sortable fields and never expose arbitrary ORM field names as query expressions.

Use cursor pagination for high-growth operational collections such as Automation execution logs/jobs. Normal page/limit pagination is acceptable for relatively small configuration collections such as rules, catalogs, categories, price types and units unless the repository has a stronger established convention.

---

## 8. Transaction and outbox rules

Use database transactions where multiple records form one business mutation.

Examples:

- publish Rule revision + active revision pointer + outbox event;
- create Automation job + dedupe record;
- action state update + execution log + follow-up outbox event;
- create Product + category links + properties + initial prices where handled as one command;
- create Variant + inherited/override state + categories/properties;
- archive Product family + affected Variant state + event;
- set default Catalog or base Price Type while clearing the prior default atomically;
- replace product rows for an owner while preserving row snapshot rules.

Outbox records must commit in the same transaction as important domain changes. Background consumers may update notifications, analytics, search, webhooks and realtime after commit.

---

## 9. Automation invariants

- Rule configuration is separate from execution state.
- Published revisions are immutable.
- Editing a published Rule creates a new Draft/revision.
- New matching events use the active published revision.
- Existing delayed/scheduled jobs remain pinned to the revision that created them.
- Multiple matching Rules execute independently.
- Ordering is deterministic by explicit priority/order and a stable tie-breaker.
- Delayed actions re-check current state and relevant conditions before execution.
- Side effects are idempotent.
- Action execution records are durable.
- Retry resumes safely from the failed action where the action type supports retry.
- Do not pretend external side effects can be database-rolled back.
- Default multi-action behavior stops on failure; `continueOnError` is explicit per action.
- Automation chains carry correlation/depth metadata and stop at configured depth/loop limits.
- Dry run evaluates without business/external side effects.
- Manual execution still evaluates normal conditions and permissions.
- Custom triggers/actions are schema-validated registered extensions, not arbitrary server-side code.

---

## 10. Products & Catalog invariants

- A Workspace may have multiple Catalogs and exactly one designated default Catalog where Catalog capability is enabled.
- A Workspace has one base/default Price Type and may have additional Price Types.
- Sellable SKU identity is unique within the Workspace.
- Product types are `SIMPLE_PRODUCT`, `PRODUCT_WITH_VARIANTS`, `VARIANT`, and `SERVICE` or repository-equivalent enums preserving these semantics.
- `PRODUCT_WITH_VARIANTS` is a parent/container, not the concrete stock/sale identity.
- A Variant belongs to exactly one parent Product.
- Products may belong to several categories with one primary category where categories are assigned.
- Category deletion cannot orphan Products or children.
- Used Products/Variants are archived rather than destructively removed.
- Service items do not require inventory semantics.
- Product master changes never rewrite historical commercial rows.
- A commercial product row may be catalog-backed or manual/one-off.
- Product rows snapshot commercial display/value data needed for historical reproduction.
- Commercial price, discount and tax overrides are separately permissioned.
- Current Catalog prices plus audit history are sufficient for V1; no temporal price engine is required.
- Tax defaults are master data; resolved row tax values are snapshotted.
- Product property implementation should reuse the shared typed Custom Fields infrastructure where available instead of cloning a second generic field engine.

---

## 11. Pricing and numeric safety

- Use PostgreSQL `NUMERIC`/the repository's precise decimal type for money, prices, quantities where fractional values are allowed, rates and ratios.
- Never use floating-point arithmetic for persisted monetary totals.
- Store currency explicitly.
- Server calculates authoritative row totals.
- Validate discount types and values.
- Validate tax rate and tax-inclusive/exclusive semantics.
- Unit ratios must be positive and non-zero.
- Price Type + Product/Variant uniqueness must prevent accidental duplicate current price records for the same currency/policy combination as defined by the module spec.

---

## 12. Migration rules

- Never rewrite an already-applied production migration.
- Create versioned forward migrations.
- Add constraints and indexes that enforce invariants where practical.
- Never execute production migration commands automatically.
- If existing data violates a new constraint, use an explicit preflight/backfill/compatibility migration plan.
- Preserve historical references on archive or membership change.

---

## 13. Background jobs

Automation scheduling and retries must use the repository's established worker/queue infrastructure.

Jobs must support:

- stable job identity;
- rule/revision identity;
- target identity;
- scheduled timestamp;
- attempt count;
- retry policy;
- status;
- idempotency/dedupe key;
- cancellation where safe;
- correlation/depth metadata;
- visible failure reason.

Workers must be safe to retry after process crashes.

---

## 14. Custom trigger/action extensions

Registered extensions must define a stable code, display metadata, typed configuration or payload schema, supported target types and a controlled handler/adapter.

Rules:

- codes are immutable after registration or changed only through explicit migration/versioning;
- schemas are validated server-side;
- secrets are referenced through secure credential storage rather than persisted in plain Rule JSON;
- inbound custom trigger calls are authenticated/verified according to the integration model;
- payload becomes read-only automation context;
- a trigger payload never bypasses owning-domain validation;
- extension execution receives only scoped context and capabilities;
- timeout and retry policy are explicit;
- extension failures are observable.

---

## 15. Frontend implementation rules

Automation frontend must provide usable management for:

- Rules list and status;
- create/edit Draft;
- target and trigger selection;
- declarative condition builder;
- ordered actions;
- delay/schedule configuration;
- priority/order;
- publish/disable/pause;
- dry run;
- execution logs and retry/cancel where permitted.

Catalog frontend must provide:

- Catalog management and default selection;
- category tree;
- Product/Service list and editor;
- parent + Variant editing;
- variation matrix generation;
- Product properties;
- media/file bindings using Files;
- units/ratios;
- price types/current prices;
- tax defaults;
- archive/restore or reactivation flows where specified;
- CRM product-row picker/editor with override permissions.

Always show field-level validation and permission states. Never rely on frontend hiding to protect a privileged operation.

---

## 16. Testing contract

Files under `tests/modules/Automation_Products_Catlouge/` are executable Jest-style contract tests. They intentionally fail until adapted/wired to the repository.

The agent must not delete, skip, convert to `todo`, weaken, or replace a required scenario with a meaningless mock just to obtain green tests.

If the repository uses Vitest or another runner, translate the contracts to the established runner.

Required verification includes:

- unit/domain tests;
- service/repository tests as appropriate;
- API E2E tests;
- Workspace isolation/security tests;
- idempotency/retry tests;
- migration/constraint tests where practical;
- frontend component/interaction tests;
- full regression suite.

---

## 17. Definition of done

A requested module is complete only when:

1. All applicable specification requirements are implemented.
2. Existing shared infrastructure has been reused instead of duplicated.
3. Workspace isolation is enforced.
4. Permissions are server-enforced.
5. Database migrations and constraints are included.
6. APIs and frontend surfaces are integrated.
7. Domain events/outbox and jobs are wired where required.
8. Retry/idempotency behavior is tested.
9. Contract tests are converted into real repository tests and pass.
10. Existing regression tests pass or unrelated pre-existing failures are explicitly evidenced.
11. A self-review checks security, performance, concurrency and boundary violations.
12. No fundamental requirement remains as an unexplained TODO.

---

## 18. Final report required from coding agent

Report:

- implemented scope;
- architecture reused;
- important files changed;
- migrations/tables/indexes;
- APIs implemented;
- frontend implemented;
- permissions wired;
- domain events/jobs/realtime;
- custom extension behavior;
- test commands and exact results/counts when available;
- final self-review findings and fixes;
- repository-specific adaptations from this pack;
- genuine remaining blockers.

Do not claim completion if critical behavior remains unimplemented.
