# Commerce payment disputes

The existing signed Stripe payment webhook also accepts `charge.dispute.created`,
`charge.dispute.updated` and `charge.dispute.closed`. Original-byte signature,
timestamp, connection, merchant, replay and body-size checks run before the shared
receipt inbox accepts an event. A 202 response acknowledges that durable receipt.
The owning callback worker rechecks the current Store payment method, service
principal, Integration connection and explicit shared Payment/Commerce permissions.

Commerce owns the dispute and append-only evidence-status history. Provider
PaymentIntent references must match an existing managed Payment in the same
Workspace and connection; expanded references are accepted, but an absent
PaymentIntent stays rejected rather than guessing from customer details. Duplicate
events produce one history entry and one opening event. Unknown local mappings
remain observable inbox failures with the existing five-attempt retry policy.
Administrative recovery and provider lookups remain separate unfinished work.

Provider `needs_response` and `warning_needs_response` map to EVIDENCE_REQUIRED;
`under_review` and `warning_under_review` map to SUBMITTED. `lost` maps to LOST;
`won`, `warning_closed` and `prevented` map to WON. The retained `providerStatus`
distinguishes an inquiry closed without chargeback or a prevented dispute from
a merchant victory. These local terminal states do not imply a new credit or
change to captured funds. Signed dispute amount/currency are separate financial
facts; the amount need not equal the original captured total. Provider status and
object fields follow the [Stripe dispute object](https://docs.stripe.com/api/disputes/object).

Older events, equal-timestamp state/evidence regressions and attempted terminal
reversals retain immutable IGNORED history. Identical newer snapshots advance the
watermark without publishing a state-change event. Payment, Order and stock
ledgers remain unchanged: a chargeback never creates a physical Return or Refund.
Raw evidence content, card fields, metadata and credential fields are excluded
from stored normalized events, dispute rows, histories and responses. Only evidence
presence, deadline, past-due status and submission count are retained.

`GET /api/v1/commerce/payment-disputes` accepts `page`, `limit` (maximum 100) and
optional `status` (OPEN, EVIDENCE_REQUIRED, SUBMITTED, WON, LOST). Authorization
filters rows before pagination and totals. `GET /api/v1/commerce/payment-disputes/:disputeId`
includes immutable history. Both resolve current membership and require explicit
COMMERCE.DISPUTE_VIEW and shared `payment.read`, intersecting Store and Payment
ownership scopes. Cross-Workspace or hidden IDs return 404. Reads never write.

Migration `202610130008_commerce_payment_disputes` adds typed dispute/history
storage, tenant/source guards, immutable financial identity and history,
terminal/watermark safeguards and strict evidence-field constraints. It is applied
only to disposable implementation test databases at this checkpoint.

Focused coverage lives in `tests/commerce-payment-disputes.spec.ts`. It exercises
signed sandbox receipts, real PostgreSQL transactions/rollback and only the two
changed authenticated Nest routes plus their actual Next registrations. No live
processor, ordinary application listener or whole-application suite is needed.
