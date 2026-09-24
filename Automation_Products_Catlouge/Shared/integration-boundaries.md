# Cross-Module Integration Boundaries

## Automation -> CRM/Pipelines

Use target adapter/application services for field updates and stage transitions. Required Fields/stage permissions remain enforced.

## Automation -> Activities/Tasks

Create through their owning services. Do not insert `crm_activities` or `tasks` directly.

## Automation -> Communication

Send through configured channel/provider abstraction. Delivery status remains Communication truth.

## Automation -> Files/Documents

Document generation uses Documents service/templates. File attachments use shared Files.

## Automation -> Integrations/Webhooks

Use secure integration/HTTP action infrastructure with credential references, egress policy, retries and logs.

## Automation -> Workflows

Automation may later start a Workflow through a registered Action, but does not implement Workflow runtime features itself.

## Catalog -> Custom Fields

Reuse typed field definition/value infrastructure for Product properties. Catalog-specific metadata must not fork shared validation/storage behavior.

## Catalog -> Files

Images/media are File bindings. Do not duplicate binary data in Product tables.

## Catalog -> CRM

Product Rows attach to Deal/other registered owner through ProductRowOwner adapter/application service. Catalog does not change Deal stage/status.

## Catalog -> Inventory

Catalog exposes stable sellable item ID, Unit/ratio and service/stockable semantics. Inventory owns quantities, reservations and stock movements.

## Catalog -> Commerce

Commerce references Product/Variant and snapshots order-line commercial values. Catalog does not own Cart/Order lifecycle.

## Catalog -> Estimates/Invoices

Commercial document modules reuse Product Row/calculation rules but own document state and historical party/totals snapshots.

## Shared Search/Analytics

Both modules publish domain events/read projections. Search/analytics are derived; they are never mutation APIs for Automation/Catalog source tables.
