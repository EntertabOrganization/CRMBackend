# Products & Catalog — Overview

## Goal

Provide reusable Product/Service master data and commercial Product Rows for TrueCRM sales, future Inventory and Commerce capabilities while preserving historical commercial values.

## Scope

Included:

- multiple Catalogs and one default Catalog;
- category hierarchy and multi-category membership;
- simple Products, parent Products, Variants and Services;
- SKU identity;
- Product properties using shared typed-field infrastructure;
- variation axes and Variant generation;
- units and ratios;
- base/additional Price Types;
- current Product/Variant prices by Price Type and currency;
- default tax configuration;
- images/media via Files;
- Product archive/dependency-safe deletion;
- search/filtering;
- commercial Product Rows and manual rows;
- price/discount/tax override permissions.

Not included:

- physical inventory ledger/reservations;
- checkout/orders/shipments;
- full promotions/contract pricing/customer-segment pricing engine;
- temporal effective-dated price engine.

## Core components

Suggested logical services:

```text
CatalogService
CategoryService
ProductService
VariantService
ProductPropertyAdapter
VariantMatrixService
UnitService
PriceTypeService
ProductPriceService
TaxDefaultService
ProductRowService
CommercialValueService
CatalogQueryService
```

## Principal entities

See `../Shared/data-model.md`:

- catalogs
- catalog_categories
- product_category_memberships
- products
- product_variants or unified product table with parent relation
- product property definitions/values via shared field infrastructure
- units
- product_unit_ratios
- price_types
- product_prices
- tax references/default bindings
- product_media_bindings
- generalized commercial product rows

## Business invariants

1. Every record is Workspace scoped.
2. Exactly one default Catalog per enabled Workspace.
3. Exactly one base Price Type per enabled Workspace.
4. Sellable SKU is unique per Workspace.
5. Variant belongs to one parent.
6. Historical Product Rows are snapshots and do not rewrite when master data changes.
7. Category deletion cannot orphan Products/children.
8. Used Product/Variant is archived, not destructively deleted.
9. Service ignores stock-specific rules.
10. Commercial override permissions are explicit.

## Acceptance criteria

- Users can create Catalog, categories, Products/Services, Variants and prices.
- Parent/Variant relationships remain valid.
- Product can be in multiple categories with one primary.
- Price Type/base rules are enforced.
- Unit ratios validate.
- Product master edits do not change existing commercial row values.
- Manual Product Rows work without Product ID.
- Cross-Workspace references are rejected.
