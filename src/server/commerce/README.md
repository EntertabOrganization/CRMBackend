# Commerce cart and checkout implementation

Order integration projections and durable read-only consistency jobs are documented
in [`reconciliation.md`](reconciliation.md). CRM sync and administrative provider
recovery remain unfinished.

Stores must configure `settings.paymentMethods` (`OFFLINE` and/or `COD`) and `settings.deliveryPolicy` (`PICKUP`) before activation. Stockable products also require a default fulfillment warehouse and `settings.inventoryPrincipalUserId`, an active member with explicit Commerce Order read and Inventory reservation privileges and warehouse ACLs. Store activation and WEB/HEADLESS storefront publication are separate commands.

Cart creation returns a random `cartToken` once. Only its SHA-256 hash is stored. Cart routes scope the token to the published Store, enforce expiry, reject client prices and recalculate current Catalog prices. Item updates require `expectedVersion`; concurrent additions merge under a database lock. The Commerce cart worker publishes abandonment or expiry events without sending marketing messages, and holders can resume unexpired abandoned carts.

Checkout creation accepts `cartToken`, `customerInfo`, `shippingInfo` and `payerType`. It returns a separate `checkoutSessionToken`. Pass that token in the `x-checkout-token` header to quote, place-order and status routes; tokens never grant employee access. Quotes last at most five minutes and are invalidated by cart, Catalog price, promotion, tax or Store changes.

Quote calculation uses the owning Catalog's exact money arithmetic, promotion eligibility and priority, stack groups, coupon limits and effective tax rules. Fixed order discounts are allocated across eligible lines in stable item-ID order; line-scoped fixed discounts apply per eligible line. Pickup has zero shipping charge and does not consume free-shipping promotions. Coupon validation returns only `eligible` and rate limits probing.

Place-order requires `Idempotency-Key`, the current `quoteHash`, and explicit versioned TERMS and PRIVACY consents. MARKETING is optional and never inferred. An Order is initially NEW and UNPAID. Cart conversion, immutable Order snapshot/history, stock reservation, coupon redemption, command replay, public-actor audit and outbox commit together. Inventory effects use the configured member's current explicit grants and owning services. Reservation failure rolls back every Order effect. No provider payment is created or confirmed by checkout.

Order APIs allow scoped reads, business metadata updates, pre-fulfillment cancellation with reservation release, and terminal archival. They preserve immutable prices, customer/address/tax/consent snapshots and reject hard deletion. Active shipment allocations must be cancelled and shared financial allocations reconciled before cancelling an Order.

Delivery configuration and manual Shipment routes support partial allocations across warehouses. Each physical Shipment binds current Order reservations in its selected warehouse and location. Stockable shipping creates an owning Inventory Sales document, retains PROCESSING while Inventory approval is pending, and marks SHIPPED only after that exact plan is posted. Use a new ship command key with the current Shipment version after approval; retries of the original key preserve its original checkpoint. Inventory posting, reservation consumption, Shipment state, audit and outbox commit atomically. Pre-dispatch cancellation releases only the Shipment's bound leg; posted shipment stock cannot bypass Returns through ordinary Inventory reversal.

Default shipping requires full settled shared Payment coverage. COD permits dispatch before payment, but delivery alone does not falsely mark an unpaid Order COMPLETED. Payment bindings reference existing shared Payment records, account for settled refunds and detect overallocated shared funds. Commerce does not copy or manufacture settlement. All Order quantities must be delivered and financially covered before completion. Provider checkout handoff, administrative payment reconciliation, customer accounts, checkout shipping-rate selection, returns/refunds and CRM integration remain unfinished; the current routes do not constitute a complete Commerce module.

Payment reads are available at `GET /api/v1/commerce/orders/:orderId/payments`
and `GET /api/v1/commerce/payments/:paymentId`. They require current explicit
`COMMERCE.PAYMENT_VIEW` and shared `payment.read` grants, with Store and shared
Payment ownership scopes intersected. The detail endpoint exposes only visible
Order allocations; an unbound Payment is inaccessible through Commerce.
Responses derive settlement and successful refund totals from the existing
shared records and include only allowlisted attempt/refund fields. Provider
payloads, card fields, merchant credentials, invoice IDs and checkout client
secrets are excluded. GET does not mutate records, audit or outbox. Currency
drift and refund totals beyond captured funds require reconciliation rather
than returning a misleading balance. Signed Stripe payment confirmation and dispute updates are implemented through the durable receipt inbox. Authorized dispute reads and evidence-status history are documented in [`payment-disputes.md`](payment-disputes.md). Administrative reconciliation remains unfinished.

Operator-managed provider creation/capture/void now queue durable shared payment
commands. See [`payment-commands.md`](payment-commands.md) for exact DTOs,
permissions, credential references and retry/confirmation semantics. Signed callback confirmation is implemented; provider checkout handoff remains unfinished.

The shared provider adapter now has authorization, capture, void and lifecycle
lookup capabilities needed by those command routes. See
[`../commercial/payment-lifecycle.md`](../commercial/payment-lifecycle.md) for
supported Stripe behavior, explicit multicapture configuration and focused test
limits. Durable commands and signed Stripe callbacks are implemented. See the command guide for required current permissions and Store payment principal configuration; the complete financial lifecycle remains unfinished.

Signed delivery callbacks use `POST /api/v1/commerce/delivery-providers/generic-hmac/webhook`. Configure an active shared Integration connection with a signing `secretReference`, bind the Delivery service to that connection, and set the Store's `settings.deliveryPrincipalUserId` to a current member with Shipment management and warehouse-read privileges. Financially allocated Orders also require the shared `payment.read` privilege. Raw secrets remain in the platform SecretPort. Other provider wire formats can install a `DeliveryCallbackAdapter`; they are not silently decoded as generic events.

The generic payload is `{eventId, externalShipmentId, status, providerStatus, occurredAt}`. Status is IN_TRANSIT, DELIVERED, FAILED or RETURNED. Headers are `x-delivery-connection-id`, `x-delivery-timestamp` (Unix seconds, five-minute window), and `x-delivery-signature` (lowercase hex HMAC-SHA256 over `timestamp + '.' + original UTF-8 body`). The request limit is 262144 bytes and compressed bodies are rejected. Nest and Next preserve signed body bytes. The signature is checked before parsing the payload, and the connection determines the Workspace.

A 202 response acknowledges the durable inbox, not delivery success. Event IDs are unique per Workspace/connection/provider, semantic replays dedupe even if JSON whitespace changes, and a changed payload with the same ID returns 409. The callback worker rechecks active connection/binding/current grants and commits Shipment state, audit and outbox atomically. Five failed processing attempts become an observable FAILED inbox record with a sanitized error code. Late/regressive status events are recorded and ignored; ties use IN_TRANSIT < FAILED < DELIVERED < RETURNED precedence. Returned logistics never add stock or refund money automatically. Any Shipment with a dispatch timestamp continues to require the Return flow for stock reversal, including a carrier FAILED status.

The new migrations are additive. The focused suite rebuilds only `truecrm_implementation_test`, applies migrations there and tests this implementation:

Checkout persists immutable Order-line/reservation bindings in the same transaction as the Order and stock reservation. Shipment allocation uses those reservation IDs through the Inventory owner, so equal-SKU lines cannot borrow each other's warehouse stock. Historical Orders without bindings retain SKU allocation only when the source has one unambiguous stockable line for that SKU; ambiguous sources return `SHIPMENT_RESERVATION_BINDING_REQUIRED`. Cancellation releases the owning reservation and retains the historical binding. Bound reservation quantities and source identity cannot be rewritten; changes must use release and a newly validated reservation binding.

```powershell
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath tests/commerce-carts.spec.ts
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath tests/commerce-shipments.spec.ts
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath tests/commerce-delivery-callbacks.spec.ts
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath tests/commerce-payment-queries.spec.ts
```

It does not execute the application-wide endpoint audit or any existing regression suites. The worker host runs the new cart worker through the existing Process Platform scheduler; the focused suite invokes only the cart worker.
