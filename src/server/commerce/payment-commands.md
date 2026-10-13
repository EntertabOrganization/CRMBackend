# Commerce payment command checkpoint

Three authenticated endpoints queue durable shared Payments effects:

- `POST /api/v1/commerce/orders/:orderId/payments`: `{methodId, amount, mode}`,
  where mode is SALE or AUTHORIZE.
- `POST /api/v1/commerce/payments/:paymentId/capture`: `{amount}`.
- `POST /api/v1/commerce/payments/:paymentId/void`: `{reason}`.

All require an 8–128 character `Idempotency-Key` and return 202 with
`{paymentId, commandId, status: 'QUEUED'}`. This is an acceptance receipt; it is
preserved on exact retries even when command processing has advanced. Changed
payloads with the same actor/resource/key return an idempotency conflict.
The durable identity lives on the shared command, independently of expiring HTTP
idempotency records. Current permissions still apply to retries.

Store settings configure `providerPaymentMethods` as an array of
`{id, provider: 'stripe', connectionId, modes, multicapture?}`. The connection
must be active, tenant scoped, idempotent and bound to `https://api.stripe.com`
with that hostname allowed. Its `secretReference` resolves a credential bundle
containing `apiKey`, `webhookSecret` and `merchantId` through the existing
SecretPort. No credential bundle is accepted from a Commerce request or copied
into payment/command/audit records. Existing OFFLINE/COD checkout policy remains
separate from these operator-managed provider methods.

Permissions intersect current Commerce Store scope, shared payment ownership
and Integration connection scope. Creation requires COMMERCE.PAYMENT_MANAGE
and `payment.create_attempt`; capture requires COMMERCE.PAYMENT_CAPTURE and the
new explicit `payment.capture` grant; void requires COMMERCE.PAYMENT_MANAGE and
the new explicit `payment.void` grant. Connections require
INTEGRATION.CONNECTION_USE. Owner roles do not bypass these explicit grants.
The repository permission seed catalog includes both new shared grants.

Shared Payments owns the payment, attempt and durable command records.
Commerce owns the Order relation. New allocations start at zero settled funds
and retain a separate requested amount. Pending requests hold Order capacity;
captured funds and remaining authorization hold capacity after a final partial
capture. Shared payment/attempt/binding/audit/outbox creation commits together.
Managed payment identities, captured-fund monotonicity, tenant relationships,
command identities and source bindings have database guards. Raw card and
credential fields are denied by strict DTOs and managed-record guards.

The owning worker claims a fenced 60-second lease, resolves current membership,
grants, source Order, Store/method/merchant/connection binding and credentials,
then calls the shared adapter outside the database transaction with a stable
command-derived provider key. Lost responses retain uncertainty and retry that
same effect key. Five failed attempts leave a visible FAILED command. Uncertain
failed captures/creations retain financial capacity until reconciliation; they
do not permit another charge. Same-payment processing is serialized, and a
capture/void awaiting confirmation blocks later effects.

Creation acknowledgement leaves Payment PENDING and allocation zero. Capture
and void acknowledgements leave WAITING_CONFIRMATION and do not change settled
funds. Payment detail GET exposes sanitized command status/error/uncertainty.
The legacy full-invoice webhook processor excludes lifecycle-controlled
attempts, so it cannot manufacture full settlement from a partial payment.

The additive migration `202610130006_shared_payment_commands` has been deployed
only to owned disposable test databases. `tests/commerce-payment-commands.spec.ts`
uses PostgreSQL, a provider sandbox and a temporary Nest listener hosting only
these routes. Payment read tests and the changed adapter tests are selected
separately. No whole-application suite or live financial effects are used.

Signed Stripe callbacks now confirm shared financial state, pending commands and
Order allocation/payment projections through a durable owning inbox. Configure
Store `paymentPrincipalUserId` with explicit `payment.provider_confirm`,
`payment.read`, COMMERCE.PAYMENT_MANAGE and INTEGRATION.CONNECTION_USE grants.
The callback URL is `/api/v1/commerce/payment-providers/stripe/webhook`; send the
connection UUID in `x-payment-connection-id` and the original Stripe proof in
`stripe-signature`. A 202 response acknowledges receipt only. See the focused
`tests/commerce-payment-callbacks.spec.ts` suite for signature, retry, financial
rollback and real HTTP coverage. Late captures retain financial truth while
Order allocations stay within the Order total; unallocated funds emit a visible
reconciliation event. Confirmation never manufactures stock or refunds.

Signed dispute updates and authorized dispute/history reads are documented in
[`payment-disputes.md`](payment-disputes.md).

Administrative reconciliation, provider checkout handoff,
customer-facing provider checkout and
frontend screens remain unfinished. This checkpoint does not complete the
Commerce Payments controller or the Commerce module.
