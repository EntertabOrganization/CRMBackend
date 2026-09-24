# Requirement Traceability Matrix

This matrix maps every confirmed interview decision and major source requirement to its implementation specification.

| Decision / requirement | Primary specification |
|---|---|
| D01 Generic Automation target registry | `Automation-Rules-Triggers/overview.md`, `Automation-Rules-Triggers/triggers-events.md` |
| D02 Explicit Automation execution identity | `Automation-Rules-Triggers/permissions-security.md`, `Agent.md` |
| D03 Immutable revisions + delayed-job pinning | `Automation-Rules-Triggers/rules-and-revisions.md`, `Automation-Rules-Triggers/scheduling-and-jobs.md` |
| D04 Ordered Actions, stop-on-error, safe resume | `Automation-Rules-Triggers/actions-registry.md`, `Automation-Rules-Triggers/execution-retries-loop-protection.md` |
| D05 Registered custom Actions/Triggers | `Automation-Rules-Triggers/custom-extensions.md` |
| D06 Workspace sellable-SKU uniqueness | `Products-Catalog/product-model-variants.md`, `Shared/data-model.md` |
| D07 Multiple categories + one primary | `Products-Catalog/catalogs-categories.md` |
| D08 Simple/parent/Variant/Service semantics | `Products-Catalog/product-model-variants.md` |
| D09 Shared Custom Fields for Product properties | `Products-Catalog/product-properties.md`, `Shared/integration-boundaries.md` |
| D10 Base + additional Price Types | `Products-Catalog/pricing-price-types.md` |
| D11 Units + ratios | `Products-Catalog/units-ratios.md` |
| D12 Dedicated price/discount/tax override permissions | `Products-Catalog/product-rows.md`, `Products-Catalog/permissions.md` |
| D13 All matching Rules execute deterministically | `Automation-Rules-Triggers/rules-and-revisions.md` |
| D14 Draft/published immutable Rule lifecycle | `Automation-Rules-Triggers/rules-and-revisions.md` |
| D15 Dry run without side effects | `Automation-Rules-Triggers/api.md`, `Automation-Rules-Triggers/frontend.md` |
| D16 Manual run respects conditions/authorization | `Automation-Rules-Triggers/api.md`, `Automation-Rules-Triggers/permissions-security.md` |
| D17 Typed custom Trigger payload | `Automation-Rules-Triggers/triggers-events.md`, `Automation-Rules-Triggers/custom-extensions.md` |
| D18 Multiple Catalogs + one default | `Products-Catalog/catalogs-categories.md` |
| D19 Used Product archives, safe unused delete | `Products-Catalog/lifecycle-archive.md` |
| D20 Parent inheritance + Variant override | `Products-Catalog/product-model-variants.md` |
| D21 Variant matrix generation | `Products-Catalog/product-model-variants.md`, `Products-Catalog/frontend.md` |
| D22 Base price default, authorized alternate type | `Products-Catalog/pricing-price-types.md`, `Products-Catalog/product-rows.md` |
| D23 Current Price + audit, no temporal price engine | `Products-Catalog/pricing-price-types.md` |
| D24 Tax default + historical row snapshot | `Products-Catalog/taxes.md`, `Products-Catalog/product-rows.md` |
| D25 Dependency-safe category deletion | `Products-Catalog/catalogs-categories.md`, `Products-Catalog/frontend.md` |
| Declarative safe condition tree | `Automation-Rules-Triggers/condition-engine.md` |
| Immediate/delayed/scheduled execution | `Automation-Rules-Triggers/scheduling-and-jobs.md` |
| Delayed stale-state validation | `Automation-Rules-Triggers/scheduling-and-jobs.md` |
| Retry/idempotency/loop protection | `Automation-Rules-Triggers/execution-retries-loop-protection.md`, `Shared/errors-idempotency-concurrency.md` |
| Execution logs/observability | `Automation-Rules-Triggers/observability.md` |
| Automation API/front-end | `Automation-Rules-Triggers/api.md`, `Automation-Rules-Triggers/frontend.md` |
| Product Rows/manual rows/history snapshots | `Products-Catalog/product-rows.md` |
| Product/Catalog API/front-end | `Products-Catalog/api.md`, `Products-Catalog/frontend.md` |
| Workspace isolation/security | `Shared/authorization-security.md` |
| Transactional outbox/events | `Shared/domain-events.md` |
| Migration/backfill safety | `Shared/migrations.md` |
| Domain ownership boundaries | `Shared/integration-boundaries.md`, `Agent.md` |
| Bitrix reference provenance | `Shared/bitrix-reference-notes.md` |
| Executable behavior contracts | `Testing/README.md`, `Testing/coverage-matrix.md` |

## Source coverage

TrueCRM source areas represented:

- PRD 07 Automation Rules & Triggers
- PRD 08 Products & Catalog
- BRD 07 Automation Rules & Triggers
- BRD 08 Products & Catalog
- System Architecture 07 Automation Rules & Triggers
- System Architecture 08 Products & Catalog
- global Workspace/Permissions, Events/Jobs, Files, Search/Analytics and module-boundary rules

The official Bitrix REST API was used as a behavioral reference for extension codes/triggers, Product Variations, Price Types, units/ratios and CRM Product Row concepts. It does not override TrueCRM decisions.

Confirmed decisions covered: D01–D25.
Unresolved important decisions: 0.
