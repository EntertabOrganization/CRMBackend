# Commercial Product Rows

## Purpose

Represent what was commercially selected for a specific owner (Deal initially; future Lead/Estimate/Invoice/etc. when registered) without making the owner depend on mutable Product master data.

## Owner registration

Use a registered ProductRowOwner adapter rather than hard-coding every future owner type.

Adapter exposes:

- owner type;
- load/authorize owner;
- allowed row operations;
- currency context/defaults;
- event integration;
- optional recalculation hook.

## Catalog-backed row

Snapshot applicable values at row creation/update:

- Product/Variant reference;
- Product name/display snapshot;
- SKU snapshot;
- unit/unit ratio snapshot;
- quantity;
- source Price Type;
- unit price;
- currency;
- discount type/rate/amount;
- taxable/tax rate/tax mode;
- calculated subtotal/tax/total;
- sort order;
- manual override flags where useful.

Retain the Product reference for navigation/reporting but never use current master values to rewrite history.

## Manual row

Allow row without Product master ID.

Require enough snapshot data:

- product/service name;
- quantity;
- unit;
- unit price;
- currency;
- allowed discount/tax values.

Manual row is not automatically inserted into Catalog.

## Permissions

Normal row permission may allow:

- add Product;
- remove row;
- change quantity;
- reorder.

Separate privileges:

```text
PRODUCT_ROW.EDIT_PRICE
PRODUCT_ROW.EDIT_DISCOUNT
PRODUCT_ROW.EDIT_TAX
```

Server compares requested changes against resolved defaults/current row to identify privileged overrides; frontend flags are not trusted.

## Totals

All totals are calculated server-side using one CommercialValueService/shared calculation module.

Use precise decimal arithmetic and explicit rounding policy.

## Atomic replace/update

If UI saves multiple rows as one operation, validate and update them transactionally so owner totals and rows cannot partially diverge.

Use optimistic concurrency/version on owner/row set if the repository has concurrent commercial editing risk.

## Bitrix reference

Bitrix CRM Product Row APIs expose product reference/name, price, quantity, discount, tax, measure and sort. TrueCRM uses these concepts but adds explicit snapshot/history and permission rules from its own architecture.

## Acceptance criteria

- Current Product price change does not mutate existing row.
- Manual row works without Product ID.
- Price/discount/tax overrides require dedicated permission.
- Cross-Workspace Product reference is rejected.
- Server totals reproduce consistently.
