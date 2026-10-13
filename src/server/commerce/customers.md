# Customer accounts and purchase history

Customer accounts are scoped to a Store and use the shared Auth identity. They
do not require or confer Workspace employee membership. Customer requests use
the existing Auth Bearer token, and require a currently active, verified identity
and an active account in the published Store. Token expiry and signature checks
stay with Auth. Account disablement, identity deletion/unverification and Store
suspension revoke subsequent customer access.

Checkout accepts optional customer authentication through the Authorization
header. The verified identity email must match the checkout email. The account
and checkout association commit together; Order placement copies that immutable
account ID. Guest checkout remains available. Guest Orders and existing historical
Orders are deliberately not claimed by matching an email address.

`COMMERCE.CUSTOMER_VIEW` permits the administrative account email projection
and purchase summaries under current Store scope. Responses exclude Auth IDs,
addresses, private Order snapshots and CRM bindings. Search covers only the
permitted account email field. Customer purchase history filters by the exact
Store account, never by email or a supplied Workspace/customer ID.

CRM linking requires `COMMERCE.CUSTOMER_MANAGE` and current owning CRM read
permissions. Without an explicit selection it requires one normalized shared
Contact match. Manual selections require a resolution reason. Shared merge
redirects resolve to the current survivor. Contact/Company links commit atomically
with audit and outbox; repeating an existing link does not emit duplicate evidence.
No CRM or historical Order row is rewritten by linking.

Reorder verifies ownership before creating any Cart. It preserves product IDs,
quantities and options, validates current publication/unit policy/stock, and
calculates current prices through the Cart owner. It never copies historical
prices, tax or discounts. Unavailable products roll back the entire Cart and
event. Checkout applies current taxes, promotions and reservations again.

Migrations 014/015 add tenant/Store foreign keys and immutable Order customer
identity. They make no historical email backfill. Focused evidence is in
`tests/commerce-customers.spec.ts`: 12 passing real database/HTTP cases, plus
the changed checkout regression suite (`tests/commerce-carts.spec.ts`).
