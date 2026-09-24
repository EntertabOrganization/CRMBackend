# Units & Ratios

## Unit master data

A Workspace can maintain units such as:

```text
Piece
Box
Kilogram
Meter
Hour
License
```

Suggested fields:

- `id`
- `workspaceId`
- `code`
- `name`
- `symbol?`
- precision/decimal policy where needed
- `isActive`
- sort order

System/default units may be seeded but remain explicit records/configuration according to platform policy.

## Product unit

Each sellable Product/Variant/Service has a primary commercial unit.

Service examples: Hour, Session, License.

Product examples: Piece, Kg, Meter.

## Ratios

Support positive conversion/packaging ratios associated with a sellable item and unit relationship.

Example:

```text
Product: Widget
base unit: Piece
Box ratio: 12
```

A ratio of zero or negative is invalid.

Clarify direction in API/model and never infer ambiguously. Recommended semantic:

```text
1 <alternate unit> = ratio * <base unit>
```

## Commercial row snapshot

A Product Row snapshots the unit and ratio/conversion data actually used where relevant so later unit configuration does not change history.

## Inventory boundary

Catalog owns definitions/ratios. Inventory owns stock balances/movements and may reuse Catalog conversion helpers. Catalog must not maintain on-hand quantity.

## Changes/deletion

Used Unit records should be deactivated rather than hard-deleted. Existing Product/row history remains readable.

Changing a Product's default Unit does not rewrite existing commercial rows.

## Bitrix reference

Official Bitrix Catalog documentation treats measurement units and product measure ratios as first-class catalog data. TrueCRM adopts the capability while using its own Workspace/data model.

## Acceptance criteria

- Ratio validation rejects zero/negative values.
- Cross-Workspace Unit references fail.
- Historical Product Row unit snapshot remains unchanged after Unit rename/default change.
