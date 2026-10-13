# Merchandise Returns

Return intake accepts only physical Order lines with recorded delivery evidence
within the Store return window (30 days by default). Store policy is pinned at
request time. Concurrent pending/approved/received/completed claims count against
the same delivered quantities. Rejected/cancelled claims release their quantity.
The service locks the Order, and PostgreSQL independently fences cumulative
quantities and parent tenant/Store references.

Create and receive commands retain permanent request identities and results.
Identical replay returns the original outcome; changed payloads fail. Approval
requires its own action permission and current version. Receipt permits partial
quantities after approval, adds immutable history/audit/outbox, and makes no
Inventory or Payment mutation. Physical receipt alone never makes stock sellable.

Inspection requires receipt of every approved quantity and one disposition per
line. SELLABLE requires an active PHYSICAL/STORE/FULFILLMENT warehouse.
DAMAGED/REPAIR requires an active DAMAGED/RETURNS warehouse, which the public
sellability projection excludes. REJECT posts no stock. Warehouse ACLs and
Inventory document-type permissions apply to the currently configured Inventory
principal; Commerce does not borrow the Store creator's authority.

Inventory owns original issue valuation, Customer Return documents, posting and
cost layers. Inspection pins the original stock issue identities, target Warehouse,
quantity and historical issue cost. It does not use the product's sale price.
All local effects commit with the Return, history, audit and outbox.

If Inventory approval is required, the document is submitted and the Return stays
INSPECTING. Approve through the owning Inventory API, then repeat inspection with
the same dispositions and a **new Idempotency-Key**. An old key always replays its
original response. Completed Inventory documents are validated without posting
again; edited plans cannot post through either the Commerce or Inventory API.
Bound Return stock cannot be reversed through the ordinary Inventory reversal API.

Return completion does not create or confirm a financial Refund. Refund approval,
remaining captured-fund guards and provider confirmation are separate obligations.

Focused real PostgreSQL and HTTP verification: `tests/commerce-returns.spec.ts`;
changed Inventory/Shipment regression: `tests/commerce-shipments.spec.ts`.
Migrations are applied only to the suites' explicitly owned disposable databases.
