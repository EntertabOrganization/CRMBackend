# Product, Service & Variant Model

## Product types

### SIMPLE_PRODUCT
Concrete sellable Product with its own SKU and commercial values.

### PRODUCT_WITH_VARIANTS
Parent/container that groups common content and variation axes. It is not the concrete Variant identity used for inventory/fulfillment when Variants exist.

### VARIANT
Concrete sellable child belonging to exactly one parent `PRODUCT_WITH_VARIANTS`.

### SERVICE
Concrete sellable non-stock service. Inventory must not require stock for it.

## Common fields

Adapt exact model to repository, but support:

- `id`
- `workspaceId`
- `catalogId`
- `type`
- `name`
- `sku?` according to type rules
- `description/shortDescription?`
- `active/archive state`
- unit reference
- tax default reference/config
- dimensions/weight where relevant
- media bindings
- search/display metadata
- optimistic version

Variants additionally carry `parentProductId` and override metadata.

## SKU

Sellable Product/Variant SKU must be unique across Workspace after normalization rules. Define normalization explicitly; recommended trim and case policy consistent with current business expectations. Do not silently case-fold if existing repository/business treats SKU as case-sensitive.

Parent Product code may exist separately but must not collide with sellable SKU semantics if used as SKU.

## Inheritance

Variant effective data resolves:

```text
explicit Variant override
else applicable parent value
```

Do not physically duplicate every parent field merely to simulate inheritance unless repository architecture proves that is necessary for query/read performance and synchronization is deterministic.

Fields that commonly require Variant override:

- SKU;
- axis property values;
- price;
- images;
- dimensions/weight;
- barcode/external code where later supported;
- unit when business allows;
- tax default only if variant-level tax override is supported.

## Variant matrix generation

Admin selects property definitions marked `variantAxis` and allowed option values.

Generate Cartesian combinations but:

- preview before commit;
- enforce configurable maximum combination count;
- reuse existing Variant identity for matching combination;
- create only missing combinations;
- never silently hard-delete existing Variants because an axis/value was removed;
- unwanted Variants are explicitly archived/deactivated/deleted only when safe.

Persist a deterministic normalized axis combination key to prevent duplicate variants with the same option combination under one parent.

## Changing parent type

Do not freely convert a used Simple Product into parent/Variant architecture or vice versa without compatibility checks. If no data/dependencies exist, controlled conversion may be allowed; otherwise require migration workflow or block.

## Service behavior

Service may have prices/properties/categories/media and Product Rows but must not require Inventory reservation/on-hand fields.

## Acceptance criteria

- Variant cannot belong to another Workspace/Catalog parent.
- Duplicate SKU is rejected.
- Duplicate Variant axis combination under one parent is rejected.
- Matrix generation is idempotent for existing combinations.
- Parent edits change effective inherited display for non-overridden values without rewriting historical commercial rows.
