# Price Types & Current Prices

## Price Type

One Workspace has one base/default Price Type and may define additional Price Types.

Examples:

```text
Base
Retail
Wholesale
Partner
Distributor
```

Suggested fields:

- `id`
- `workspaceId`
- stable `code`
- `name`
- `isBase`
- `isActive`
- sort order
- optional permission/visibility metadata if repository needs it

Changing the base type atomically clears the prior base flag.

## Product Price

A price belongs to one sellable Product/Variant and one Price Type.

Store:

- `workspaceId`
- `productId` or sellable item ID
- `priceTypeId`
- `amount` precise decimal
- `currency`
- optional minimum quantity if explicitly added later; not required by current scope
- active/current state as required
- optimistic version/audit metadata

For V1, prevent duplicate current price for the same sellable item + Price Type + currency (or enforce one currency per Price Type if the broader platform makes that a rule; do not assume without repository evidence).

## Base price resolution

Default CRM selection uses base Price Type current price.

Authorized user/process may select another Price Type.

V1 does not automatically choose a Price Type from customer segment/group. That is future pricing policy functionality.

## Currency

Reuse shared currency registry/policy if present. Do not create ad hoc currency strings without validation.

No automatic FX conversion is defined by this module unless an existing shared service already supplies explicitly requested behavior.

## Price changes

Catalog stores current prices and normal Audit/history.

Changing current price:

- affects future row creation/default resolution;
- does not change prior Product Rows;
- emits `PRODUCT_PRICE_CHANGED` or repository-equivalent event.

No effective-from/effective-to temporal pricing engine in V1.

## Permissions

Separate:

- viewing Product master;
- managing Price Types;
- managing current Product prices;
- overriding price on a specific Product Row.

A user may be allowed to sell/select a Product without permission to edit Catalog pricing.

## Bitrix reference

Official Bitrix REST Catalog APIs expose Product Prices separately from Price Types and support a base Price Type concept. TrueCRM adopts that broad separation but not Bitrix-specific IDs/fields.

## Acceptance criteria

- Exactly one base Price Type.
- Current price uses precise decimal and explicit currency.
- Unauthorized user cannot edit Product price.
- Changing master price leaves existing commercial rows unchanged.
