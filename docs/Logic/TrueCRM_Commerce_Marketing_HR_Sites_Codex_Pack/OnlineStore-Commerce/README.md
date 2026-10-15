# OnlineStore-Commerce — module map

Core V1: store setup, catalog publication, guest checkout, Orders, payment adapters, stock reservations, shipping and returns; Advanced: B2B pricing policies, customer portal enhancements, promotions, conversational commerce, advanced reporting.

**Core invariant:** Order, Payment, Shipment and InventoryMovement are separate ledgers/lifecycles. Captured payment never inferred from browser redirect.

## Submodule specifications

- [`01-store-administration.md`](01-store-administration.md) — Support multiple storefronts per workspace, with owned storefront configurations and live shared product/catalog links.
- [`02-product-publication-and-pricing.md`](02-product-publication-and-pricing.md) — Expose selected shared catalog products/variants at store-specific prices and visibility without copying catalog master data.
- [`03-customer-identities-and-portal.md`](03-customer-identities-and-portal.md) — Let customers use guest checkout or customer accounts that are distinct from internal workspace users.
- [`04-carts-and-checkout.md`](04-carts-and-checkout.md) — Provide safe server-authoritative checkout, guest or authenticated, without duplicate orders under retries.
- [`05-orders-and-amendments.md`](05-orders-and-amendments.md) — Own immutable commercial order line snapshots and a configurable intermediate status workflow.
- [`06-payments-and-reconciliation.md`](06-payments-and-reconciliation.md) — Orchestrate payment through existing commercial payment ownership while keeping checkout/Order state synchronized.
- [`07-inventory-reservations.md`](07-inventory-reservations.md) — Delegate stock arithmetic to Inventory using explicit reservation policies and robust concurrency.
- [`08-shipping-and-fulfillment.md`](08-shipping-and-fulfillment.md) — Manage shipping/pickup, partial fulfillment, tracking and delivery adapters separately from Orders and Inventory.
- [`09-returns-and-refunds.md`](09-returns-and-refunds.md) — Maintain independent return and refund lifecycles with controlled inventory disposition.
- [`10-promotions-taxes-and-delivery.md`](10-promotions-taxes-and-delivery.md) — Provide deterministic pricing rules, promo eligibility, international tax configuration and delivery estimates.
- [`11-crm-sales-links.md`](11-crm-sales-links.md) — Integrate customer/order lifecycle into CRM Contacts/Companies/Deals and conversation-based checkout.
- [`12-commerce-reports-and-lifecycle.md`](12-commerce-reports-and-lifecycle.md) — Project commerce KPIs while protecting historical orders and customer obligations during suspension or downgrade.
- [`13-digital-goods-and-service-fulfillment.md`](13-digital-goods-and-service-fulfillment.md) — Fulfill digital products and services without fabricating shipping or inventory movements.

## External owner boundaries

Own only records declared in the above specs. Other domains must be accessed through narrow typed service contracts, not direct table writes.

## Activation readiness / configuration

- Authenticated workspace membership/permissions and active entitlement must be resolved.
- Applicable locale/jurisdiction, tax, HR, consent and retention policies must be configured before enabling their corresponding operations.
- Any external provider needed for production operation must have a verified identity, separate secret and observable health state.
- Missing operational dependency must be surfaced as a blocker, never auto-created as a second source of truth.

## Tests

Every file above maps to `Testing/OnlineStore-Commerce/<same-slug>.spec.ts`; module E2E in `Testing/OnlineStore-Commerce/OnlineStore-Commerce.e2e-spec.ts`. See `Testing/README.md`.
