# Payment Providers Specification

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


## Goal

Provide provider-independent payment attempt, verification, webhook and reconciliation behavior with initial adapters for Manual, Stripe and XPay plus a generic extension contract.

Provider-specific DTOs/SDKs must not leak into Invoice/Payment domain logic.

## Adapter contract

Adapt naming to repository conventions, but every online provider must support applicable equivalents of:

```text
key(): string
createPaymentAttempt(input): ProviderAttemptResult
retrievePayment(externalTransactionId): ProviderPaymentState
verifyAndParseWebhook(headers, rawBody): VerifiedProviderEvent
refund(input): ProviderRefundResult
retrieveRefund?(externalRefundId): ProviderRefundState
capabilities(): ProviderCapabilities
```

If XPay staging/legacy configuration requires authoritative transaction lookup when a callback signature is absent, implement that only through the XPay adapter and only when deployment configuration explicitly enables the verified-lookup fallback. Never treat unsigned payload fields alone as authoritative.

## Provider configuration

Store non-secret connection metadata in the integration/configuration model and secrets in secure secret storage/environment integration.

Never return secret keys after storage. Never log secrets or raw signatures unnecessarily.

## Create attempt

```text
POST /api/v1/payments/provider-attempts
```

Request identifies eligible Invoice(s)/customer, amount, currency, provider and optional return URLs.

Server:
1. authorize;
2. derive expected Workspace/customer/amount/currency server-side;
3. create internal Payment/Attempt in CREATED/PENDING state;
4. call adapter;
5. store provider transaction reference;
6. return client-safe checkout/public payment information.

Client cannot override authoritative amount/currency after internal attempt creation.

## Webhook endpoint

Recommended normalized route:

```text
POST /api/v1/payments/providers/:providerKey/webhook
```

If provider/repository constraints require separate routes, preserve the same handler contract.

Processing:
1. capture raw body only where verification requires it;
2. resolve configured provider connection without trusting payload Workspace ID;
3. verify signature/authentication or configured authoritative lookup flow;
4. normalize event;
5. persist provider event identity with a unique key;
6. locate internal attempt/payment using trusted mapping;
7. validate transaction ID, expected amount, expected currency and merchant/community/account identity where available;
8. in a transaction, apply settlement/failure exactly once and write outbox/audit;
9. acknowledge duplicates without duplicating side effects.

## Stripe adapter

Use the repository's approved/current Stripe SDK if installed. Verify webhook signatures using raw body + configured webhook secret. Map only supported event types. Checkout/browser redirect is not proof of settlement.

## XPay adapter

Use configured XPay credentials/community/payment identifiers. When signature headers are configured, validate them.

If deployment explicitly supports legacy unsigned callbacks, fetch the transaction from XPay and verify authoritative transaction state/identity before mutating internal state.

Verify applicable:
- callback transaction UUID equals fetched UUID;
- configured merchant/community identity;
- expected amount;
- expected currency;
- configured payment/variable identifiers where available;
- normalized provider status.

A lookup failure/mismatch must not settle Payment.

## Reconciliation

Provide a job/admin service to compare pending/recent internal attempts with provider state where retrieval is supported.

Reconciliation:
- is retryable/idempotent;
- cannot rewrite a different settled provider transaction;
- records visible operational result;
- uses the same settlement domain command as webhook processing.

## Refund provider integration

Provider refunds are requested through `refund()` and persisted as internal Refund records. Provider completion/failure callbacks/retrieval must dedupe against internal Refund.

## Errors

```text
PAYMENT_PROVIDER_NOT_CONFIGURED
PAYMENT_PROVIDER_UNAVAILABLE
PAYMENT_PROVIDER_SIGNATURE_INVALID
PAYMENT_PROVIDER_EVENT_DUPLICATE
PAYMENT_PROVIDER_TRANSACTION_MISMATCH
PAYMENT_PROVIDER_AMOUNT_MISMATCH
PAYMENT_PROVIDER_CURRENCY_MISMATCH
PAYMENT_PROVIDER_MERCHANT_MISMATCH
PAYMENT_PROVIDER_STATE_UNSUPPORTED
```

Duplicate event is normally acknowledged safely rather than returned as a retry-inducing server error.

## Security

- apply provider-appropriate rate limiting;
- webhook route does not rely on normal user session;
- verify provider independently;
- preserve raw payload only if necessary and according to retention/security policy;
- redact secrets and sensitive payment identifiers in logs;
- never store full card PAN/CVV.

## Acceptance criteria

- same provider event processed twice creates one business effect;
- mismatched amount/currency/merchant cannot settle Payment;
- browser redirect alone cannot settle Payment;
- transient provider failures retry without duplicate effects;
- provider adapters can be swapped without Invoice domain changes;
- automated tests use deterministic fakes and cover verification failure.
