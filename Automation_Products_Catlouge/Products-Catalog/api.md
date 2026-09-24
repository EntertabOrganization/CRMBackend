# Products & Catalog API Contract

Use repository response conventions while preserving these resource semantics.

## Catalogs/categories

```text
GET/POST  /api/v1/catalogs
GET/PATCH /api/v1/catalogs/:catalogId
POST      /api/v1/catalogs/:catalogId/set-default

GET/POST  /api/v1/catalogs/:catalogId/categories
GET/PATCH /api/v1/catalogs/:catalogId/categories/:categoryId
DELETE    /api/v1/catalogs/:catalogId/categories/:categoryId
POST      /api/v1/catalogs/:catalogId/categories/reorder
POST      /api/v1/catalogs/:catalogId/categories/:categoryId/move
```

## Products/Variants

Recommended:

```text
GET/POST  /api/v1/catalog/products
GET/PATCH /api/v1/catalog/products/:productId
POST      /api/v1/catalog/products/:productId/archive
POST      /api/v1/catalog/products/:productId/reactivate
DELETE    /api/v1/catalog/products/:productId

GET/POST  /api/v1/catalog/products/:productId/variants
POST      /api/v1/catalog/products/:productId/variants/generate
GET/PATCH /api/v1/catalog/variants/:variantId
POST      /api/v1/catalog/variants/:variantId/archive
POST      /api/v1/catalog/variants/:variantId/reactivate
DELETE    /api/v1/catalog/variants/:variantId
```

A unified `/products/:id` model is acceptable if repository uses one table/type hierarchy and API semantics remain clear.

## Properties

Where shared Custom Fields API is reused, expose Catalog-specific profiles/bindings rather than duplicate field CRUD. If a dedicated Catalog route is needed:

```text
GET/POST /api/v1/catalog/properties
PATCH    /api/v1/catalog/properties/:propertyId/catalog-settings
POST     /api/v1/catalog/properties/reorder
```

## Units/ratios

```text
GET/POST  /api/v1/catalog/units
GET/PATCH /api/v1/catalog/units/:unitId

GET/POST   /api/v1/catalog/products/:productId/unit-ratios
PATCH/DELETE /api/v1/catalog/products/:productId/unit-ratios/:ratioId
```

## Price Types/prices

```text
GET/POST  /api/v1/catalog/price-types
GET/PATCH /api/v1/catalog/price-types/:priceTypeId
POST      /api/v1/catalog/price-types/:priceTypeId/set-base

GET/PUT   /api/v1/catalog/products/:productId/prices
GET/PUT   /api/v1/catalog/variants/:variantId/prices
```

Exact bulk/upsert shape should follow repository conventions; server validates one current price per defined uniqueness key.

## Product Rows

Use owner-oriented routes or generic registered owner endpoint:

```text
GET /api/v1/crm/:ownerType/:ownerId/product-rows
PUT /api/v1/crm/:ownerType/:ownerId/product-rows
```

or repository-equivalent Deal-specific routes if already established.

The API must support catalog-backed and manual rows and return snapshot values.

## Search/list filters

Products support safe whitelisted filters such as:

- Catalog;
- category;
- type;
- active/archive state;
- SKU;
- name search;
- allowed filterable properties;
- Price Type/range where supported;
- created/updated time if repository stores it.

Use cursor or page pagination based on repository convention/scale; do not expose arbitrary ORM fields.

## Stable errors

Include repository-equivalent codes:

```text
CATALOG_NOT_FOUND
DEFAULT_CATALOG_REQUIRED
CATEGORY_NOT_FOUND
CATEGORY_HAS_DEPENDENCIES
CATEGORY_CYCLE
PRODUCT_NOT_FOUND
PRODUCT_SKU_CONFLICT
PRODUCT_HAS_DEPENDENCIES
PRODUCT_TYPE_INVALID
VARIANT_PARENT_INVALID
VARIANT_COMBINATION_CONFLICT
UNIT_NOT_FOUND
UNIT_RATIO_INVALID
PRICE_TYPE_NOT_FOUND
BASE_PRICE_TYPE_REQUIRED
PRODUCT_PRICE_INVALID
PRODUCT_ROW_OWNER_NOT_FOUND
PRODUCT_ROW_OVERRIDE_FORBIDDEN
WORKSPACE_SCOPE_VIOLATION
PERMISSION_DENIED
```
