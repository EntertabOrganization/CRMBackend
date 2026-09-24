# Decision Register

This file records the confirmed human decisions for the Automation Rules & Triggers and Products & Catalog design interview. These decisions override recommendations or reference behavior if any later source appears different.

## Automation Rules & Triggers

### D01 — Target architecture
Use a generic registered automation-target architecture. Stage-based automation is initially enabled for Leads and Deals where those modules support it. Event-based rules can work with other registered entities. Future Estimates, Invoices and Smart Processes register without changing Automation core.

### D02 — Execution identity
Use explicit execution policy. Synchronous actions may use initiating-user context where appropriate; delayed/system/external execution uses a scoped Automation service identity. Automation never bypasses normal Workspace/module/action authorization.

### D03 — Revision pinning
Definitions are revisioned. New events use the latest active published revision. Existing delayed/scheduled jobs remain pinned to the revision/configuration that created them.

### D04 — Multi-action failure
Actions run in configured order. Stop on failure by default, persist successful prior actions, and safely retry from the failed action where supported. `continueOnError` is an explicit action option.

### D05 — Custom extensions
Allow registered application/integration Action and Trigger types with stable codes, typed schemas, permissions and controlled handlers. Do not allow arbitrary tenant-supplied server JavaScript.

### D13 — Multiple matching Rules
All matching Rules execute independently. Ordering is deterministic by explicit priority/order and stable tie-breaker.

### D14 — Rule lifecycle
Use Draft and immutable Published revisions. Active published revisions can be paused/disabled without deletion.

### D15 — Dry run
Provide safe dry-run evaluation that resolves context, conditions and action configuration without executing business/external side effects.

### D16 — Manual execution
Authorized users may manually run a Rule against an eligible target, but normal conditions, permissions, logs and idempotency still apply.

### D17 — Custom trigger payload
A registered custom Trigger may define an optional typed/validated payload schema. Payload values become read-only automation context variables and never directly mutate domain records.

## Products & Catalog

### D06 — SKU uniqueness
Sellable Product/Variant SKU is unique across the Workspace.

### D07 — Product categories
Products may belong to multiple categories, with one primary category.

### D08 — Product type model
Use `SIMPLE_PRODUCT`, `PRODUCT_WITH_VARIANTS`, `VARIANT`, and `SERVICE` semantics.

### D09 — Product properties
Reuse shared typed Custom Fields infrastructure where possible; add Catalog-specific property metadata such as variant-axis/filter/storefront applicability rather than creating a duplicate generic field engine.

### D10 — Price types
Each Workspace has one mandatory base/default Price Type plus optional additional Price Types. Prices store currency explicitly.

### D11 — Units and ratios
Support units and conversion/packaging ratios in V1.

### D12 — Commercial override permissions
Use separate permissions for manual price, discount and tax overrides on commercial Product Rows. Normal row editors can change quantity within normal validation.

### D18 — Multiple Catalogs
A Workspace may have several Catalogs with one designated default Catalog for normal CRM product selection unless another is explicitly chosen.

### D19 — Product deletion
Used Products/Variants are archived. Existing commercial snapshots/history remain. Unused records may be hard-deleted only after dependency checks.

### D20 — Parent/Variant inheritance
Variants inherit applicable parent metadata by default and store explicit overrides for Variant-specific values such as SKU, images, property values, price and dimensions.

### D21 — Variant generation
Admins can select variant-axis values and generate a variation matrix, then deactivate/remove unwanted combinations without destroying established Variant identity.

### D22 — Price selection
Base price is the default. Authorized users/processes may select another applicable Price Type. Complex automatic customer/group pricing is not part of V1.

### D23 — Catalog price history
V1 stores current Price state plus audit/history. Historical transaction values are preserved in commercial row snapshots; no effective-dated temporal pricing engine is required.

### D24 — Taxes
Catalog stores default tax references/settings. Commercial Product Rows snapshot resolved taxable state, tax rate and calculated tax values used for that transaction.

### D25 — Category deletion
Block category deletion while child categories or Product memberships exist. Require explicit move/reassignment first; never orphan or cascade-delete Products.

## Interview status

- Confirmed decisions: 25
- Remaining important product decisions: 0
- Remaining important architecture decisions: 0
