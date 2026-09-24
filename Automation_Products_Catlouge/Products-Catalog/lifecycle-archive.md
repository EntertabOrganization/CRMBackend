# Product Lifecycle, Archive & Deletion

## Product lifecycle

Recommended operational states:

```text
ACTIVE
INACTIVE
ARCHIVED
```

Adapt exact enum to repository conventions.

`INACTIVE` may mean temporarily unavailable for new selection. `ARCHIVED` means retired but retained for history/dependencies.

## Used Product/Variant

If referenced by any durable business record (Product Row, Inventory, Order, etc.), destructive delete is blocked.

Archive instead:

- hide from default new-item picker;
- keep direct authorized historical lookup;
- preserve IDs/references;
- preserve commercial snapshots;
- emit lifecycle event.

## Unused deletion

Hard delete may be allowed only after dependency checks prove there are no:

- commercial rows;
- Variants/parent dependency inconsistent with deletion;
- category/property/media dependencies that require preservation;
- Inventory/Commerce references;
- external mapping/integration references that policy says block deletion.

Return stable dependency error with safe details.

## Parent Product archive

Archiving a `PRODUCT_WITH_VARIANTS` must not leave unexpectedly selectable children.

Recommended behavior: archive/deactivate family selection atomically, preserving Variant history. If individual Variant reactivation under archived parent is not supported, reject it until parent is active.

## Variant archive

An individual Variant may be archived while parent and sibling Variants remain active.

## Reactivation

Reactivation validates:

- SKU uniqueness still holds;
- parent active where required;
- Unit/Price Type/property references are valid;
- permissions.

## Category and option dependency

Do not delete category/property option records in ways that make archived Product history unreadable.

## Acceptance criteria

- Used Product cannot be hard-deleted.
- Archived Product is excluded from normal picker/search by default.
- Historical Product Row remains readable.
- Recreating another Product cannot steal a still-preserved SKU if uniqueness policy reserves archived SKUs; the implementation must define and consistently enforce this. Recommended: archived Product still owns SKU until hard-deleted or explicitly changed.
