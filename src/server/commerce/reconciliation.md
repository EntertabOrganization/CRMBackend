# Commerce integration inspection and consistency jobs

`GET /api/v1/commerce/orders/:orderId/integrations` requires current explicit
COMMERCE.ORDER_VIEW and Store ownership scope. It projects existing typed CRM
bindings and owning Inventory reservations plus current Store automation policy.
Private references require current CRM or Inventory permissions and owner/warehouse
scope; unavailable private sections return REDACTED with no IDs or quantities.
CRM names, customer communications, credentials and configured employee principals
are omitted. This read does not create CRM records or repair a binding.

`POST /api/v1/commerce/orders/:orderId/reconcile` accepts an empty strict JSON
object and requires COMMERCE.ORDER_MANAGE, current Store scope and Idempotency-Key
(8–128 characters). It returns 202 with jobId, QUEUED and correlationId. Request
identity is durable per Workspace/principal/key and includes the Order ID. Exact
replays return the original queue acknowledgement even after completion or HTTP
dedupe expiry; another Order with the same key returns 409. Use the job GET for its
current state.

`GET /api/v1/commerce/reconciliation-jobs/:jobId` checks current membership,
COMMERCE.ORDER_MANAGE, Store scope, requester ownership scope and every saved
owning reference. Completed reports become inaccessible if their financial, CRM,
reservation, document or warehouse access is revoked. Internal claims, lease
tokens and authorization-reference collections are never returned.

The owning Commerce worker claims jobs with a fenced 60-second lease, recovers
expired claims and retains bounded five-attempt failures with sanitized codes.
It re-resolves the requesting employee's current permissions at execution. There
is no elevated service identity. A bounded database snapshot compares:

- Shared captured/refunded funds, allocations, uncertainty and bound callback status.
- Order payment projections and completion versus real delivered quantities.
- Owning reservation quantities/expiry, including terminal Order history.
- Posted owning Inventory Sales documents for dispatched Shipments.
- Stock balances against immutable movements and live reservation allocations.
- Typed CRM binding status and current owning CRM reference visibility/lifecycle.

A completed job means the check ran, not that the Order is consistent. `result`
contains the observed Order version/time, a consistency flag, typed mismatch codes,
safe amounts/IDs and counts. No repair, capture, refund, stock movement, CRM sync or
marketing message is performed. Current Store policy is observed for missing
bindings; the job does not rewrite historical Order snapshots or apply a new policy
to prior business effects. Unknown/unbound provider receipts and exhausted inbox
repair remain separate administrative work.

Typed CRM bindings are available for existing integration state; the CRM-sync
producer, shared duplicate resolution and Deal creation policy execution remain
unfinished. These three routes do not complete the Commerce Integrations module.

Migration `202610130010_commerce_reconciliation` adds source/tenant guards,
indexed foreign-key references, durable request identities, claims and immutable
terminal result evidence. Deployment is confined to owned disposable databases.
`tests/commerce-reconciliation.spec.ts` exercises real PostgreSQL fixtures and
only these changed Next/Nest routes; no ordinary listener, complete worker host or
whole-application suite is needed.
