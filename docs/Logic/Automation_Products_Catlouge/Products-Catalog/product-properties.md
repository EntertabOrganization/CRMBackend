# Product Properties

## Architecture

Reuse the typed Custom Fields infrastructure from the Custom & Required Fields module where that infrastructure is available and compatible.

Do not build another generic metadata/value engine solely for Products.

Catalog adds a Product-property profile/metadata layer to shared field definitions.

## Catalog-specific metadata

Support applicable flags such as:

- `variantAxis`
- `filterable`
- `searchable`
- `displayOnCard`
- `displayInList`
- `storefrontVisible`
- category applicability/restrictions
- allowed Product types
- sort order

The exact shared field flags remain owned by the Custom Fields engine; avoid duplicate source-of-truth flags.

## Property types

Use supported shared typed field types appropriate for Products. Variant axes should normally use stable finite option/reference values rather than free text to support deterministic combination keys.

Examples:

- Color: LIST, `variantAxis=true`
- Size: LIST, `variantAxis=true`
- Material: LIST/TEXT, filterable
- License term: LIST
- Manufacturer: TEXT/REFERENCE depending future model

## Parent vs Variant values

A property definition states whether it applies to:

- parent only;
- sellable item only;
- both with inheritance/override;
- Variant axis.

Do not let the frontend invent inheritance behavior.

## Option lifecycle

Stable option IDs/codes. Used options are deactivated rather than destructively removed if historical/current Product values depend on them.

Removing an option used by active Variants must produce dependency impact and require migration/archive resolution.

## Category applicability

If a property is applicable only under certain categories, define whether applicability derives from primary category or any category membership. Recommended default: explicit configuration uses any matching category membership, while variant axes should be configured at Product family/catalog level to avoid ambiguous category-driven schema.

## Search/filter indexing

Only fields marked and technically supported for search/filter should create search projections/indexes. Avoid one DB index per arbitrary property without workload justification.

## Acceptance criteria

- Shared field permissions/validation remain effective.
- Variant-axis values have stable identity.
- Used options cannot be destructively removed.
- Product property storage remains Workspace scoped.
