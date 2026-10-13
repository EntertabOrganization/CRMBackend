# Products & Catalog Permissions

## Capability separation

Do not equate "can edit Deal" with "can manage Catalog".

Recommended permission concepts:

```text
CATALOG.READ
CATALOG.MANAGE
CATEGORY.MANAGE
PRODUCT.READ
PRODUCT.CREATE
PRODUCT.UPDATE
PRODUCT.ARCHIVE
PRODUCT.DELETE
PRODUCT_PROPERTY.MANAGE
UNIT.MANAGE
PRICE_TYPE.MANAGE
PRODUCT_PRICE.MANAGE
PRODUCT_ROW.MANAGE
PRODUCT_ROW.EDIT_PRICE
PRODUCT_ROW.EDIT_DISCOUNT
PRODUCT_ROW.EDIT_TAX
```

Map to existing permission naming/scope model rather than creating a separate engine.

## Product row access

Access is primarily constrained by access to the owner CRM/commercial record plus Product Row permissions.

A user who cannot read the Deal cannot use the Product Row API to infer its contents.

Catalog Product visibility can additionally restrict which products are selectable if the broader authorization model supports product/catalog scopes.

## Sensitive commercial changes

Manual override checks are server-side. A client setting `customized=false` or omitting an override flag does not bypass permission if submitted values differ from defaults/current policy.

## Administration

Managing Price Types, tax defaults, Units and Product properties should require administrative/catalog-management capability.

## Workspace isolation

Every Product, Catalog, Category, Unit, Price Type and related lookup is Workspace validated even when caller already has owner-record access.

## Audit

Audit at minimum:

- default Catalog change;
- Product create/archive/delete;
- SKU changes;
- Variant generation/material changes;
- Price Type/base changes;
- Product price changes;
- tax default changes;
- privileged Product Row overrides.

## Acceptance criteria

- Sales user can select Product without gaining price-management permission.
- Unauthorized price override returns stable permission error.
- Cross-Workspace Product ID cannot be used on an accessible local Deal.
