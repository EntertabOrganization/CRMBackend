# TrueCRM Automation Rules & Triggers + Products & Catalog Codex Pack

## What this pack is

This pack is an implementation-ready specification for two TrueCRM modules:

1. **Automation Rules & Triggers**
2. **Products & Catalog**

It is designed for Codex, Claude Code, Claude Sonnet or another coding agent working inside the existing TrueCRM repository.

## Where the coding agent starts

Read in this order:

1. `Agent.md`
2. `Decision-Register.md`
3. `Automation-Rules-Triggers/overview.md` and/or `Products-Catalog/overview.md`
4. all files in that module folder
5. all relevant files under `Shared/`
6. `tests/modules/Automation_Products_Catlouge/README.md` and the corresponding contract tests

`Agent.md` is the master execution contract.

## Source basis

The pack is based on:

- TrueCRM Product Requirements Document (PRD)
- TrueCRM Business Requirements Document (BRD)
- TrueCRM System Architecture Document
- the confirmed product-design interview decisions in `Decision-Register.md`
- the structural/testing philosophy of the supplied TrueAgent Auth Codex Pack
- official Bitrix REST documentation as behavioral reference where TrueCRM sources intentionally left a choice open

Bitrix is reference material only. TrueCRM's confirmed requirements and architecture take precedence.

## Module organization

### `Automation-Rules-Triggers/`

Covers Rule definitions, immutable revisions, triggers/events, condition evaluation, action registry, scheduling, execution/retry semantics, custom extensions, authorization, APIs, frontend and observability.

### `Products-Catalog/`

Covers Catalogs, category trees, product/service/parent/Variant models, properties, units/ratios, price types/prices, taxes, CRM product rows, lifecycle, permissions, APIs and frontend.

### `Shared/`

Contains cross-cutting data model, security, domain event, idempotency/concurrency, migration, integration-boundary and traceability contracts.

### `tests/modules/Automation_Products_Catlouge/`

Contains executable Jest-style contracts intended to be wired to the real repository. They describe required behavior and must not be deleted simply to obtain passing tests.

## How to implement one module

For Automation:

1. inspect the existing Event/Outbox/Jobs/Permissions infrastructure;
2. implement schema/configuration and revision model;
3. implement condition/action registries;
4. implement event matching and job scheduling;
5. implement execution, retries, loop protection and logs;
6. wire domain adapters;
7. add APIs/frontend;
8. adapt/run Automation contracts and regressions.

For Products:

1. inspect existing Custom Fields, Files, CRM product-row and commercial-value conventions;
2. implement Catalog/category/product/Variant master data;
3. implement properties, units/ratios, Price Types/current prices and tax defaults;
4. implement product-row snapshot rules and permissions;
5. add APIs/frontend;
6. adapt/run Product/Catalog contracts and regressions.

## How to implement the whole pack

Implement shared primitives once. Do not create a second authorization engine, event bus, job queue, typed-field engine, file store, or money-calculation convention.

Complete backend foundations before frontend consumers. Run targeted tests continuously, then the full repository test suite.

## Testing expectations

At minimum, test:

- Workspace isolation;
- permissions and execution identity;
- Rule revision pinning;
- condition matching and deterministic ordering;
- delayed stale-state checks;
- idempotent retries and loop protection;
- custom trigger/action schema enforcement;
- Catalog defaults and uniqueness constraints;
- Product/Variant/SKU/category invariants;
- unit ratios;
- multiple Price Types/current prices;
- tax/product-row snapshots;
- archive/dependency behavior;
- commercial override permissions;
- frontend validation and interaction.

## Important boundary reminder

Automation is **not** the Workflows engine.

Catalog is **not** Inventory or Commerce.

Implementation that duplicates those domains is not compliant with this pack.
