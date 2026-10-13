# Shared provider lifecycle capabilities

`PaymentProviderAdapter` now exposes optional `retrieveLifecycle`, `capture`
and `void` operations. Its capability flags identify installed support.
`createPaymentAttempt` accepts `mode: SALE | AUTHORIZE`; omitting it preserves
the existing invoice sale behavior. XPay rejects AUTHORIZE before any request
because that adapter does not install an authorization implementation.

The Stripe adapter sends `capture_method=manual` for authorization. Captures use
an exact currency-minor-unit amount and the caller's stable provider idempotency
key. Captures are final by default. Installing the adapter with its fourth
`multicapture` argument enabled sends `final_capture=false`; this requires the
merchant's Stripe multicapture support. An unsupported request returns a failure rather
than locally claiming captured funds. Void first reads the authoritative
PaymentIntent and rejects any captured funds. A previously canceled Intent
returns the same voided state, allowing recovery after a lost response.

Lifecycle lookup validates transaction identity, supported status, currency and
nonnegative exact amounts. It returns requested amount, current authorization
and captured amount separately; pending authentication never becomes PAID.
Captured plus capturable funds cannot exceed the requested amount. Provider
calls have a 15-second timeout and response-read/network failures use stable
errors. No authorization/capture response writes a local financial record.

`DeterministicLifecyclePaymentAdapter` is a test sandbox with stable create and
command identities, payload-conflict detection, partial-capture bounds and
void/settlement guards. It has no live financial effects.

The changed adapter behavior is covered by `tests/payment-lifecycle-adapters.spec.ts`.
Stripe wire requests use mocked responses; no live processor credentials or
merchant account are used. These tests establish adapter behavior, not durable
Commerce command processing or verified callback settlement. The new durable
owning command layer and verified Stripe callbacks are documented in
[`../commerce/payment-commands.md`](../commerce/payment-commands.md).
Administrative reconciliation and checkout handoff remain open.

Primary API references: [create PaymentIntent](https://docs.stripe.com/api/payment_intents/create),
[capture PaymentIntent](https://docs.stripe.com/api/payment_intents/capture),
[cancel PaymentIntent](https://docs.stripe.com/api/payment_intents/cancel).
