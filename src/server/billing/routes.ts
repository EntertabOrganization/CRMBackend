import { prisma } from '../prisma-client';
import '../platform/register';
import { SuiteRouter } from '../platform/http';
import { BillingCatalogService } from './catalog-service';
import { BillingFinanceService } from './finance-service';
import { BillingPartnerService } from './partner-billing';
import { BillingPaymentService } from './payment-service';
import { BillingSubscriptionService } from './subscription-service';
import { BillingUsageService } from './usage-service';
import { refreshHostedSetup } from './hosted-setup';

const catalog = new BillingCatalogService(prisma), subscriptions = new BillingSubscriptionService(prisma), payments = new BillingPaymentService(prisma);
const usage = new BillingUsageService(prisma), partner = new BillingPartnerService(prisma), finance = new BillingFinanceService(prisma);
const mfa = (c: { request: { headers: Headers } }) => c.request.headers.get('x-mfa-assertion');
const auth = (c: { request: { headers: Headers } }) => c.request.headers.get('authorization');
const B = '/api/v1/billing', P = '/api/v1/platform/billing', I = '/api/v1/internal/billing';

/** 31-Subscription-Billing customer surface (Workspace principals) plus platform-finance refunds. */
export const billingRouter = new SuiteRouter()
  // 01 catalog & entitlements
  .workspace('GET', B + '/plans', c => catalog.catalog(c.query))
  .workspace('GET', B + '/workspaces/current/entitlements', c => catalog.workspaceEntitlements(c.actor))
  .workspace('GET', B + '/subscriptions/:id/entitlement-history', c => catalog.entitlementHistory(c.actor, c.query))
  // 02 lifecycle
  .workspace('POST', B + '/subscriptions/trial', c => subscriptions.startTrial(c.actor, c.body, c.request.headers.get('x-device-fingerprint'), c.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null, c.requestId), 201)
  .workspace('POST', B + '/subscriptions', c => subscriptions.purchase(c.actor, c.body, c.requestId), 201)
  .workspace('POST', B + '/checkout-quotes', c => subscriptions.purchase(c.actor, c.body, c.requestId), 201)
  .workspace('GET', B + '/checkout-quotes/:id', c => payments.checkoutQuote(c.actor, c.params.id))
  .workspace('GET', B + '/subscriptions/current', c => subscriptions.current(c.actor))
  .workspace('GET', B + '/subscriptions/history', c => subscriptions.history(c.actor))
  .workspace('POST', B + '/subscriptions/:id/renew', c => subscriptions.renew(c.actor, c.params.id, c.requestId))
  .workspace('POST', B + '/subscriptions/:id/cancel', c => subscriptions.cancel(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', B + '/subscriptions/:id/reactivate', c => subscriptions.reactivate(c.actor, c.params.id, c.requestId))
  // 03 plan changes
  .workspace('POST', B + '/subscriptions/:id/change-quotes', c => subscriptions.changeQuote(c.actor, c.params.id, c.body, c.requestId), 201)
  .workspace('POST', B + '/subscriptions/:id/change', c => subscriptions.change(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', B + '/subscriptions/:id/scheduled-change/cancel', c => subscriptions.cancelScheduledChange(c.actor, c.params.id, c.requestId))
  .workspace('GET', B + '/compatibility-checks/:id', c => subscriptions.compatibilityCheck(c.actor, c.params.id))
  // 04 accounts, invoices, payments
  .workspace('GET', B + '/accounts', c => payments.accounts(c.actor))
  .workspace('POST', B + '/accounts', c => payments.createAccount(c.actor, c.body, c.requestId), 201)
  .workspace('POST', B + '/accounts/transition-payer', c => partner.transitionPayer(c.actor, c.body, c.requestId))
  .workspace('GET', B + '/accounts/:id', c => payments.account(c.actor, c.params.id))
  .workspace('POST', B + '/payment-attempts', c => payments.paymentAttempt(c.actor, c.body, c.requestId), 201)
  .workspace('POST', B + '/payment-attempts/:id/refresh', c => payments.refreshAttempt(c.actor, c.params.id))
  .workspace('GET', B + '/invoices', c => payments.invoices(c.actor, c.query))
  .workspace('GET', B + '/invoices/:id', c => payments.invoice(c.actor, c.params.id))
  .platform('POST', B + '/refunds', c => payments.refund(c.actor, c.body, mfa(c), c.requestId), 201)
  // 05/06 usage and credits
  .workspace('GET', B + '/usage', c => usage.usage(c.actor, c.query))
  .workspace('POST', B + '/overage-policies', c => usage.acceptOverage(c.actor, c.body, c.requestId))
  .workspace('GET', B + '/credits/balance', c => usage.balance(c.actor))
  .workspace('GET', B + '/credits/ledger', c => usage.ledger(c.actor, c.query))
  .workspace('GET', B + '/credits/products', () => usage.topupProducts())
  .workspace('POST', B + '/credits/topup-quote', c => usage.topupQuote(c.actor, c.body), 201)
  .workspace('POST', B + '/credits/topup-purchase', c => usage.topupPurchase(c.actor, c.body, c.requestId), 201)
  // 07 recovery
  .workspace('GET', B + '/subscriptions/:id/recovery-case', c => subscriptions.recoveryCase(c.actor, c.params.id))
  .workspace('POST', B + '/subscriptions/:id/retry-payment', c => subscriptions.retryPayment(c.actor, c.params.id))
  .workspace('POST', B + '/subscriptions/:id/update-payment-method', c => finance.paymentMethodChange(c.actor, c.body, c.requestId, c.params.id))
  .platform('POST', B + '/recovery/:id/resolve', c => subscriptions.resolveRecovery(c.actor, c.params.id, c.requestId))
  // 08 partner
  .workspace('GET', B + '/partner-transactions', c => partner.workspaceTransactions(c.actor, c.query))
  // 09 reports
  .workspace('GET', B + '/reports/revenue', c => finance.workspaceRevenue(c.actor, c.query))
  .workspace('GET', B + '/reports/usage', c => finance.usageReport(c.actor, c.query))
  // 10 admin
  .workspace('GET', B + '/admin/audit', c => finance.workspaceAudit(c.actor, c.query))
  .workspace('GET', B + '/preferences', c => finance.preferences(c.actor))
  .workspace('PATCH', B + '/preferences', c => finance.updatePreferences(c.actor, c.body, c.requestId))
  .workspace('POST', B + '/payment-method/change', c => finance.paymentMethodChange(c.actor, c.body, c.requestId))
  .workspace('POST', B + '/payment-method/setups/:id/refresh', c => refreshHostedSetup(prisma, c.actor, c.params.id, c.requestId))
  .workspace('POST', B + '/approvals', c => finance.requestWorkspaceApproval(c.actor, c.body, c.requestId), 201)
  .workspace('POST', B + '/approvals/:id/decision', c => finance.decideWorkspaceApproval(c.actor, c.params.id, c.body, c.requestId));

/** Platform billing administration (platform.* / billing.* platform grants only). */
export const platformBillingRouter = new SuiteRouter()
  .platform('GET', P + '/definitions', c => catalog.definitions(c.actor))
  .platform('POST', P + '/definitions', c => catalog.createDefinition(c.actor, c.body, c.requestId), 201)
  .platform('GET', P + '/plans', c => catalog.plans(c.actor))
  .platform('POST', P + '/plans', c => catalog.createPlan(c.actor, c.body, c.requestId), 201)
  .platform('POST', P + '/plans/:id/retire', c => catalog.retirePlan(c.actor, c.params.id, c.requestId))
  .platform('POST', P + '/plans/:id/versions', c => catalog.createVersion(c.actor, c.params.id, c.body, c.requestId), 201)
  .platform('POST', P + '/plan-versions/:id/publish', c => catalog.publishVersion(c.actor, c.params.id, c.requestId))
  .platform('POST', P + '/plan-versions/:id/retire', c => catalog.retireVersion(c.actor, c.params.id, c.requestId))
  .platform('POST', P + '/workspaces/:id/entitlements/recompute', c => catalog.recompute(c.actor, c.params.id, c.requestId))
  .platform('POST', P + '/subscriptions/:id/renew', c => subscriptions.renewInternal(c.actor, c.params.id))
  .platform('POST', P + '/topup-products', c => usage.createTopupProduct(c.actor, c.body, c.requestId), 201)
  .platform('POST', P + '/overage-rates', c => usage.setOverageRate(c.actor, c.body, c.requestId), 201)
  .platform('POST', P + '/credits/adjust', c => usage.adjust(c.actor, c.body, mfa(c), c.requestId))
  .platform('GET', P + '/payments', c => payments.platformPayments(c.actor, c.query))
  .platform('GET', P + '/partner-transactions', c => partner.platformTransactions(c.actor, c.query))
  .platform('POST', P + '/reconciliations', c => finance.startReconciliation(c.actor, c.body, c.requestId), 202)
  .platform('GET', P + '/reconciliations/:id', c => finance.reconciliation(c.actor, c.params.id))
  .platform('GET', P + '/reconciliations/:id/findings', c => finance.findings(c.actor, c.params.id, c.query))
  .platform('POST', P + '/reconciliations/findings/:id/resolve', c => finance.resolveFinding(c.actor, c.params.id, c.body, c.requestId))
  .platform('POST', P + '/fx-rates', c => finance.setFxRate(c.actor, c.body, c.requestId), 201)
  .platform('POST', P + '/mrr', c => finance.computeMrr(c.actor, c.body), 202)
  .platform('GET', P + '/revenue', c => finance.platformRevenue(c.actor, c.query))
  .platform('GET', P + '/approvals', c => finance.approvals(c.actor, c.query))
  .platform('POST', P + '/approvals', c => finance.requestPlatformApproval(c.actor, c.body, c.requestId), 201)
  .platform('POST', P + '/approvals/:id/decision', c => finance.decidePlatformApproval(c.actor, c.params.id, c.body, mfa(c), c.requestId))
  .platform('POST', P + '/overrides', c => finance.createOverride(c.actor, c.body, mfa(c), c.requestId), 201)
  .platform('POST', P + '/overrides/:id/revoke', c => finance.revokeOverride(c.actor, c.params.id, c.requestId));

/** Service-identity endpoints for domain modules and signed provider webhooks. */
export const billingInternalRouter = new SuiteRouter()
  .public('POST', I + '/entitlements/check', c => catalog.internalCheck(auth(c), c.body))
  .public('POST', I + '/usage/reserve', c => usage.internalReserve(auth(c), c.body), 201)
  .public('POST', I + '/usage/:reservationId/settle', c => usage.internalSettle(auth(c), c.params.reservationId, c.body))
  .public('POST', I + '/usage/:reservationId/release', c => usage.internalRelease(auth(c), c.params.reservationId, c.body))
  .public('POST', I + '/credits/reserve', c => usage.internalCreditReserve(auth(c), c.body), 201)
  .public('POST', I + '/credits/settle', c => { const { reservationId, ...rest } = c.body as Record<string, unknown>; return usage.internalSettle(auth(c), String(reservationId ?? ''), rest); })
  .public('POST', I + '/credits/release', c => { const { reservationId, ...rest } = c.body as Record<string, unknown>; return usage.internalRelease(auth(c), String(reservationId ?? ''), rest); })
  .public('POST', I + '/partner-pricing/quote', c => partner.internalQuote(auth(c), c.body))
  .signed('/api/v1/webhooks/billing/:provider', c => payments.webhook(c.params.provider, c.request.headers, c.rawBody ?? ''), 200);
