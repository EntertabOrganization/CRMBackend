# Provider adapters, credentials, verification and fallback

Secrets reside in credential vault, not provider normal business rows. Adapter receives connection reference and trust policy; never raw client-provided backend URL. Outbound HTTP destination restrictions mitigate SSRF and credential leakage. Provider events verified and recorded before business transitions.

## Interfaces (logical, adapt language signature to repository)

```ts
interface AiModelAdapter {
  validateConnection(connectionRef:string): Promise<ProviderHealth>;
  infer(req:{runId:string;modelKey:string;promptRef:string;classification:string;maxTokens:number;idempotencyKey:string}):Promise<{requestId:string;artifactRef:string;usage:{inputTokens:number;outputTokens:number;cachedTokens:number}}>;
  reconcile(requestId:string):Promise<'ACCEPTED'|'COMPLETED'|'NOT_FOUND'|'UNKNOWN'>;
}
interface SubscriptionPaymentAdapter {
  createCheckout(quoteId:string,payerAccountId:string,commandKey:string):Promise<{checkoutRef:string;redirectUrl:string}>;
  verifyWebhook(rawBody:Uint8Array,headers:Record<string,string>):Promise<{providerEventId:string;transactionRef:string;kind:string;status:string}>;
  fetchPayment(transactionRef:string):Promise<{trustedStatus:string;amount:string;currency:string}>;
  refund(paymentRef:string,amount:string,key:string):Promise<{refundRef:string;trustedStatus:string}>;
}
interface PartnerDiscountResolver {
  resolve(input:{partnerId:string;productId:string;categoryIds:string[];at:string}):Promise<{basisPoints:number;ruleVersion:number;ruleId:string}>;
}
interface KnowledgeRetrieval {
  retrieve(input:{workspaceId:string;principalId:string;query:string;classification:string;limit:number}):Promise<Array<{articleId:string;revisionId:string;anchor:string;snippet:string}>>;
}
```

## Provider matrix

- AI initial adapters: OpenAI, Azure OpenAI, Anthropic, Google Gemini, OpenRouter. Model catalog/rates/version updates are configured, not magically evergreen.
- SaaS billing: Stripe and XPay; where webhook signatures aren't available, independently validate transaction with authenticated provider lookup before trusting result. Use provider external event/transaction IDs for replay safety.
- BYOK connections record token/cost estimates but do not charge platform credit under BYOK policy; platform-managed requests use appropriate credit ledger.
- External MCP/OAuth clients: register redirect allowlist, rotate/revoke credentials, require user consent, no raw API access beyond scoped tool registry.

Provider sandbox adapters must expose deterministic transient/permanent failure and duplicate callback scenarios for integration tests. Never mark production webhook processing complete using an unsigned assumed callback or test fakes only.
