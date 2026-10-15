# Provider adapter interfaces and capability contracts

Implement production integrations through NestJS injectable provider registries; choose repositories' existing interfaces when equivalent. The following are TypeScript pseudointerfaces to adapt, not a directive to introduce another backend.

```ts
type ProviderContext = { workspaceId: string; connectionId: string; correlationId: string; idempotencyKey: string };
interface PaymentProvider { key: 'stripe'|'xpay'; createOrFetchIntent(ctx: ProviderContext, order: { orderId: string; amountMinor: string; currency: string }): Promise<{ providerRef: string; state: string; redirectUrl?: string }>; verifyCallback(headers: Record<string,string>, rawBody: Buffer, connectionId: string): Promise<{ eventId: string; providerRef: string; verified: boolean }>; fetchTransaction(ctx: ProviderContext, providerRef: string): Promise<{ amountMinor: string; currency: string; state: string }>; refund(ctx: ProviderContext, transactionRef: string, amountMinor: string): Promise<{ refundRef: string; state: string }> }
interface MarketingSender { channel: 'EMAIL'|'SMS'|'WHATSAPP'|'VOICE'; capabilities: ReadonlySet<string>; send(ctx: ProviderContext, message: { deliveryId: string; destination: string; senderId: string; contentVersion: string }): Promise<{ externalMessageId?: string; accepted: boolean; retryable: boolean }>; lookupDelivery(ctx: ProviderContext, deliveryId: string): Promise<{ state: string; externalMessageId?: string }> }
interface AdAudienceAdapter { platform: 'META'|'GOOGLE'; upsertAudience(ctx: ProviderContext, audience: { externalId?: string; hashedMembers: string[] }): Promise<{ externalId: string; rejectedCount: number }>; pullMetrics(ctx: ProviderContext, window: { from: string; to: string }): Promise<ReadonlyArray<{ campaignId: string; spend: string; currency: string; clicks: number; impressions: number }>> }
interface ShippingAdapter { quote(ctx: ProviderContext, request: unknown): Promise<{ amount: string; currency: string; validUntil: string }>; createShipment(ctx: ProviderContext, request: unknown): Promise<{ externalRef: string; tracking?: string }>; getStatus(ctx: ProviderContext, externalRef: string): Promise<string> }
```

### Initial implementations

1. Stripe: Checkout/Payment Intents and verified webhooks with idempotency; refund via owner payment service.
2. XPay: merchant workspace configuration; use provider-supported trusted confirmation/retrieval method, never assume same signature requirements as Stripe. Fail closed when callback cannot be verified.
3. SMTP and Amazon SES: verified email domain/sender, bounce/complaint handling where available, sender rate policy.
4. Twilio SMS and voice: phone sender, E.164 destinations, provider IDs/status callbacks; voice messaging only within provider-supported/legally approved use.
5. Meta WhatsApp Cloud API: approved business sender/templates and message status webhooks; do not assume arbitrary free-form bulk messaging is allowed.
6. Meta/Google ad connectors: audience sync and period-specific metric imports, not direct in-CRM campaign campaign editing.
7. Delivery adapter registry: built-in pickup/fixed/zone/weight initially; third-party carrier adapter contracts available without falsely claiming a specific carrier integration shipped.

### Credentials and failure

Connection credential saved only through dedicated secret manager; API reads return masked metadata. Rotate/revoke without deleting dependent history. Provider-specific regional capability/quota approval must be checked before enabling that provider. Every adapter has deterministic fake for contract tests; live staging smoke uses real test accounts when supplied. Production activation depends on configuration and provider account approval; unconfigured adapter cannot silently report success.
