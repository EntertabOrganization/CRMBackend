# Products & Catalog Frontend Specification

## Catalog administration

### Catalog list/settings

- list Catalogs;
- create/edit;
- show default badge;
- set default with confirmation;
- active/inactive state;
- permission-aware controls.

### Category tree

- nested tree;
- create child/root;
- rename/edit;
- drag/move/reorder with server validation;
- delete blocked with dependency summary and reassignment guidance.

## Product list

Columns/filters appropriate to permission:

- Product name;
- type;
- SKU;
- Catalog;
- primary category;
- active/archive status;
- base price/currency where allowed;
- Variant count for parent Products.

Search/filter must use backend metadata/whitelists, including filterable Product properties.

## Product editor

Suggested tabs/sections:

```text
General
Categories
Properties
Variants
Media
Units
Prices
Tax
History (if platform exposes Audit)
```

Show only sections applicable to Product type and permission.

## Variant matrix

- select variant-axis properties;
- select allowed option values;
- preview Cartesian combination count;
- warn/enforce maximum;
- show existing vs new combinations;
- generate missing Variants;
- allow explicit archive/remove of unwanted combinations subject to dependencies.

Do not silently delete established Variants when axis configuration changes.

## Pricing UI

- base Price Type visually clear;
- additional Price Types rows;
- precise decimal input and currency selector;
- permission-aware editing;
- current master price only, not misleading historical transaction value.

## Unit/ratio UI

- select primary Unit;
- list alternate Unit ratios;
- show unambiguous sentence: `1 Box = 12 Pieces`;
- reject zero/negative ratio client-side and server-side.

## CRM Product Row UI

Product picker:

- default Catalog initially;
- allow other Catalog selection where user/owner supports it;
- search Product/Variant;
- hide archived/inactive by default;
- display Product family/Variant attributes clearly;
- select Price Type if authorized/allowed.

Row editor:

- quantity;
- unit;
- price;
- discount;
- tax;
- totals;
- manual row capability.

Price/discount/tax inputs become read-only/hidden according to effective permission. Server still revalidates.

## Error states

Handle:

- SKU conflict;
- stale optimistic version;
- parent/Variant constraint;
- category dependency block;
- archived Product selected from stale UI;
- price permission loss;
- cross-module owner update conflict.

## Acceptance criteria

- Admin can configure a Product family with Variants without raw JSON.
- Sales user can select a Variant and quantity while privileged commercial overrides remain protected.
- Archived Products are not offered for new normal selection.
- Existing row displays stored snapshot even if Product master changed.
