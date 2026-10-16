import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { allocateNumber } from '../platform/config-service';
import { emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, securityEvent, type PlatformPrincipal } from '../platform/kernel';
import { PlatformConfigService } from '../platform/config-service';
import { quoteTax } from './tax-policy';
import { partnerDiscount, recordPartnerTransaction, recordRefundAdjustment, snapshotPartnerPrice } from './partner-billing';
import { billingAudit, billingProviders, currency, D, money, provider, QUOTE_TTL_MINUTES, ZERO, type Tx } from './support';

const PLATFORM_SCOPE = '00000000-0000-0000-0000-000000000000';
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// ------------------------------------------------------------------ effect registry (subscription/credit owners react to paid invoices)
export type InvoiceRow = Prisma.BillingInvoiceGetPayload<object>;
type Effect = { paid?: (tx: Tx, invoice: InvoiceRow) => Promise<void>; failed?: (tx: Tx, invoice: InvoiceRow, reason: string) => Promise<void>; refunded?: (tx: Tx, invoice: InvoiceRow, refundAmount: Prisma.Decimal, refundId: string) => Promise<void> };
const effects = new Map<string, Effect>();
export function registerInvoiceEffect(kind: string, effect: Effect) { effects.set(kind, effect); }

// ------------------------------------------------------------------ approvals (separation of duties, 31/10)
export async function consumeApproval(tx: Tx, input: { approvalId: string | undefined; action: string; payload: unknown; requesterId: string; workspaceId?: string | null }) {
  if (!input.approvalId) throw new AppError('BUSINESS_RULE_VIOLATION', `${input.action} requires an approved change request.`, 422, { approvalRequired: true });
  const approval = await tx.billingChangeApproval.findUnique({ where: { id: input.approvalId } });
  if (!approval || approval.action !== input.action || approval.status !== 'APPROVED' || approval.consumedAt || approval.expiresAt <= new Date() || (input.workspaceId !== undefined && approval.workspaceId !== input.workspaceId))
    throw new AppError('BUSINESS_RULE_VIOLATION', 'Approval is missing, expired, already used or for another action.', 422);
  if (approval.payloadHash !== sha(input.payload)) throw new AppError('BUSINESS_RULE_VIOLATION', 'Approval does not match this exact request.', 422);
  if (approval.approverId === input.requesterId) throw new AppError('PERMISSION_DENIED', 'Approver and executor must differ.', 403);
  await tx.billingChangeApproval.update({ where: { id: approval.id }, data: { consumedAt: new Date() } });
  return approval;
}
export const approvalHash = sha;

// ------------------------------------------------------------------ quotes & invoices
export type QuoteLine = { kind: string; description: string; quantity: string; unitPrice: string; subtotal: string };
/** Builds an immutable quote: lines -> optional Partner discount on the net -> total (ROUND_HALF_UP at currency minor unit). */
export async function createQuote(tx: Tx, input: { workspaceId: string; kind: 'PURCHASE' | 'CHANGE' | 'TOPUP' | 'RENEWAL'; subscriptionId?: string | null; fromPlanVersionId?: string | null; toPlanVersionId?: string | null;
  priceId?: string | null; topupProductId?: string | null; payerAccountId: string; requestedTiming?: string; effectiveAt: Date; currency: string; lines: QuoteLine[]; credits?: Prisma.Decimal; productId: string;
  fingerprint: unknown; idempotencyKey?: string | null; createdBy?: string | null; ttlMinutes?: number }) {
  const subtotal = money(input.lines.reduce((s, l) => s.add(l.subtotal), ZERO), input.currency);
  const credits = money(input.credits ?? ZERO, input.currency);
  const net = Prisma.Decimal.max(ZERO, subtotal.sub(credits));
  const partner = await partnerDiscount(tx, { workspaceId: input.workspaceId, productId: input.productId, base: net, currency: input.currency });
  const discount = partner?.discountAmount ?? ZERO;
  const tax = await quoteTax(tx, input.payerAccountId, input.workspaceId, net.sub(discount), input.currency);
  const total = money(net.sub(discount).add(tax.amount), input.currency);
  const quote = await tx.billingQuote.create({ data: { workspaceId: input.workspaceId, kind: input.kind, subscriptionId: input.subscriptionId ?? null, fromPlanVersionId: input.fromPlanVersionId ?? null, toPlanVersionId: input.toPlanVersionId ?? null,
    priceId: input.priceId ?? null, topupProductId: input.topupProductId ?? null, payerAccountId: input.payerAccountId, requestedTiming: input.requestedTiming ?? 'IMMEDIATE', effectiveAt: input.effectiveAt,
    subtotal, credits, discount, tax: tax.amount, total, currency: input.currency, lines: input.lines.map(line => ({ ...line, taxPolicy: tax.snapshot })), priceFingerprint: sha({ ...input.fingerprint as object, tax: tax.snapshot, partner: partner ? [partner.partnerId, partner.ruleId, partner.ruleVersion, partner.basisPoints] : null }),
    idempotencyKey: input.idempotencyKey ?? null, createdBy: input.createdBy ?? null, expiresAt: new Date(Date.now() + (input.ttlMinutes ?? QUOTE_TTL_MINUTES) * 60000) } });
  if (partner && discount.gt(0)) await snapshotPartnerPrice(tx, quote.id, partner);
  return quote;
}
/** Re-derives the fingerprint and rejects stale/expired quotes (03 AC03). */
export async function assertQuoteFresh(tx: Tx, quote: { id: string; workspaceId: string; payerAccountId: string; expiresAt: Date; priceFingerprint: string; status: string }, fingerprint: unknown, productId: string, base: Prisma.Decimal, cur: string) {
  if (quote.expiresAt <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Quote expired; request a new quote.', 409, { reason: 'QUOTE_EXPIRED' });
  const partner = await partnerDiscount(tx, { workspaceId: quote.workspaceId, productId, base, currency: cur });
  const tax = await quoteTax(tx, quote.payerAccountId, quote.workspaceId, base.sub(partner?.discountAmount ?? ZERO), cur);
  const current = sha({ ...fingerprint as object, tax: tax.snapshot, partner: partner ? [partner.partnerId, partner.ruleId, partner.ruleVersion, partner.basisPoints] : null });
  if (current !== quote.priceFingerprint) throw new AppError('INVALID_STATE_TRANSITION', 'Prices or plan changed since this quote; request a new quote.', 409, { reason: 'QUOTE_STALE' });
}
export async function issueInvoiceForQuote(tx: Tx, quoteId: string, extra: { periodStart?: Date | null; periodEnd?: Date | null; subscriptionId?: string | null } = {}) {
  const existing = await tx.billingInvoice.findUnique({ where: { quoteId } });
  if (existing) return existing;
  const quote = await tx.billingQuote.findUniqueOrThrow({ where: { id: quoteId } });
  const account = await tx.billingAccount.findUniqueOrThrow({ where: { id: quote.payerAccountId } });
  const number = await allocateNumber(tx, { workspaceId: PLATFORM_SCOPE, entityType: 'billing.invoice', sequenceName: new Date().getUTCFullYear().toString(), idempotencyKey: 'invoice:' + quote.id, prefix: 'TCRM-' + new Date().getUTCFullYear() + '-', padWidth: 7 });
  const snapshot = await tx.billingPartnerPriceSnapshot.findUnique({ where: { quoteId } });
  const invoice = await tx.billingInvoice.create({ data: { workspaceId: quote.workspaceId, billingAccountId: account.id, subscriptionId: extra.subscriptionId ?? quote.subscriptionId, quoteId: quote.id, number: number.formatted, kind: quote.kind,
    issuedAt: new Date(), dueAt: new Date(Date.now() + 7 * 86400000), periodStart: extra.periodStart ?? null, periodEnd: extra.periodEnd ?? null, currency: quote.currency, subtotal: quote.subtotal.sub(quote.credits), discount: quote.discount, tax: quote.tax, total: quote.total,
    status: quote.total.lte(0) ? 'PAID' : 'ISSUED', legalOwner: { payerType: account.payerType, payerAccountId: account.id, partnerId: account.partnerId, beneficiaryWorkspaceId: quote.workspaceId, legalIdentity: account.legalIdentity } as Prisma.InputJsonValue } });
  for (const line of quote.lines as QuoteLine[]) await tx.billingInvoiceLine.create({ data: { invoiceId: invoice.id, kind: line.kind, description: line.description, quantity: D(line.quantity), unitPrice: D(line.unitPrice), subtotal: D(line.subtotal),
    discountBasisPoints: snapshot?.discountBasisPoints ?? 0, discountAmount: ZERO } });
  if (quote.credits.gt(0)) await tx.billingInvoiceLine.create({ data: { invoiceId: invoice.id, kind: 'CREDIT', description: 'Unused time credit', quantity: D(1), unitPrice: quote.credits.neg(), subtotal: quote.credits.neg() } });
  if (quote.discount.gt(0)) await tx.billingInvoiceLine.create({ data: { invoiceId: invoice.id, kind: 'PARTNER_DISCOUNT', description: 'Partner discount', quantity: D(1), unitPrice: quote.discount.neg(), subtotal: quote.discount.neg(), discountBasisPoints: snapshot?.discountBasisPoints ?? 0, discountAmount: quote.discount } });
  if (quote.tax.gt(0)) await tx.billingInvoiceLine.create({ data: { invoiceId: invoice.id, kind: 'TAX', description: 'Tax per issued quote policy', quantity: D(1), unitPrice: quote.tax, subtotal: quote.tax } });
  await tx.billingQuote.update({ where: { id: quote.id }, data: { status: 'INVOICED' } });
  await emitEvent(tx, { workspaceId: quote.workspaceId, eventType: 'BILLING_INVOICE_ISSUED', aggregateType: 'BillingInvoice', aggregateId: invoice.id, aggregateVersion: 1, actorType: 'SERVICE', payload: { kind: invoice.kind, total: invoice.total.toFixed(), currency: invoice.currency } });
  if (invoice.status === 'PAID') await onInvoicePaid(tx, invoice); // zero-total (e.g. fully credited) needs no payment
  return invoice;
}
async function onInvoicePaid(tx: Tx, invoice: InvoiceRow) {
  await recordPartnerTransaction(tx, invoice);
  await emitEvent(tx, { workspaceId: invoice.workspaceId, eventType: 'BILLING_INVOICE_PAID', aggregateType: 'BillingInvoice', aggregateId: invoice.id, aggregateVersion: invoice.version, actorType: 'SERVICE', payload: { kind: invoice.kind } });
  await effects.get(invoice.kind)?.paid?.(tx, invoice);
}

/**
 * Applies a provider-verified payment outcome exactly once (unique provider+transaction). Unmatched transactions are recorded
 * for reconciliation, never turned into a fabricated payment (09 AC04).
 */
export async function applyVerifiedPayment(tx: Tx, providerKey: string, state: { transactionId: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; amount: string; currencyCode: string }) {
  const attempt = await tx.billingPaymentAttempt.findFirst({ where: { provider: providerKey, transactionRef: state.transactionId } });
  if (!attempt) return 'UNMATCHED';
  if (state.status === 'PENDING') { await tx.billingPaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'PENDING' } }); return 'PENDING'; }
  const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: attempt.invoiceId } });
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-invoice:' + invoice.id}))`;
  if (state.status === 'FAILED') {
    if (attempt.status === 'SUCCEEDED') return 'IGNORED_REGRESSION';
    await tx.billingPaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
    await emitEvent(tx, { workspaceId: invoice.workspaceId, eventType: 'BILLING_PAYMENT_FAILED', aggregateType: 'BillingInvoice', aggregateId: invoice.id, actorType: 'SERVICE', payload: { attemptId: attempt.id } });
    await effects.get(invoice.kind)?.failed?.(tx, invoice, 'PAYMENT_FAILED');
    return 'FAILED';
  }
  if (state.currencyCode.toUpperCase() !== invoice.currency) return 'CURRENCY_MISMATCH';
  const existing = await tx.billingPayment.findUnique({ where: { provider_providerTransactionId: { provider: providerKey, providerTransactionId: state.transactionId } } });
  if (existing) return 'DUPLICATE';
  const amount = money(state.amount, invoice.currency);
  if (amount.lte(0)) return 'INVALID_AMOUNT';
  const payment = await tx.billingPayment.create({ data: { workspaceId: invoice.workspaceId, invoiceId: invoice.id, attemptId: attempt.id, provider: providerKey, providerTransactionId: state.transactionId, amount, currency: invoice.currency, status: 'SUCCEEDED' } });
  await tx.billingPaymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED' } });
  const paid = invoice.paid.add(amount), fully = paid.gte(invoice.total);
  const updated = await tx.billingInvoice.update({ where: { id: invoice.id }, data: { paid, status: fully ? 'PAID' : 'PARTIALLY_PAID', version: { increment: 1 } } });
  await billingAudit(tx, { workspaceId: invoice.workspaceId, actorId: null, actorType: 'SERVICE', action: 'BILLING_PAYMENT_CONFIRMED', resourceType: 'BillingPayment', resourceId: payment.id, after: { invoiceId: invoice.id, amount: amount.toFixed(), provider: providerKey } });
  await emitEvent(tx, { workspaceId: invoice.workspaceId, eventType: 'BILLING_PAYMENT_CONFIRMED', aggregateType: 'BillingPayment', aggregateId: payment.id, aggregateVersion: 1, actorType: 'SERVICE', payload: { invoiceId: invoice.id, amount: amount.toFixed(), currency: invoice.currency } });
  if (fully && invoice.status !== 'PAID') await onInvoicePaid(tx, updated);
  return fully ? 'PAID' : 'PARTIALLY_PAID';
}

/** Billing accounts, invoices, provider payments and refunds (31/04). */
export class BillingPaymentService {
  constructor(private readonly db: PrismaClient) {}

  async accounts(actor: Principal) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const rows = await this.db.billingAccount.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(r => this.redactAccount(r, actor.grants.has('billing.account.manage')));
  }
  async account(actor: Principal, id: string) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const row = await this.db.billingAccount.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } });
    if (!row) throw notFound('Billing account');
    return this.redactAccount(row, actor.grants.has('billing.account.manage'));
  }
  private redactAccount(row: Prisma.BillingAccountGetPayload<object>, full: boolean) {
    const identity = row.legalIdentity as Record<string, unknown>;
    return { id: row.id, payerType: row.payerType, partnerId: row.partnerId, billingCurrency: row.billingCurrency, billingTimezone: row.billingTimezone, status: row.status, version: row.version,
      legalIdentity: full ? identity : { legalName: identity.legalName ?? null }, taxProfile: full ? row.taxProfile : { configured: Object.keys(row.taxProfile as object).length > 0 } };
  }
  /** Customer payer by default; a Partner payer account requires the Workspace's active Partner relation and Partner membership. */
  async createAccount(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.account.manage');
    const input = z.strictObject({ payerType: z.enum(['CUSTOMER', 'PARTNER']).default('CUSTOMER'), partnerId: z.uuid().optional(), billingCurrency: currency, billingTimezone: z.string().max(64).default('UTC'),
      legalIdentity: z.strictObject({ legalName: z.string().trim().min(2).max(200), country: z.string().regex(/^[A-Z]{2}$/), taxId: z.string().max(60).optional(), address: z.string().max(500).optional(), email: z.email().optional() }),
      taxProfile: z.record(z.string(), z.union([z.string().max(100), z.number(), z.boolean()])).default({}) }).parse(raw);
    return this.db.$transaction(async tx => {
      if (input.payerType === 'PARTNER') {
        if (!input.partnerId) throw new AppError('VALIDATION_FAILED', 'partnerId is required for a Partner payer.', 400);
        const relation = await tx.partnerWorkspaceRelation.findFirst({ where: { workspaceId: actor.workspaceId, partnerId: input.partnerId, isDeleted: false } });
        const member = await tx.partnerMembership.findFirst({ where: { partnerId: input.partnerId, userId: actor.userId, status: 'ACTIVE', isDeleted: false } });
        if (!relation || !member) throw new AppError('PERMISSION_DENIED', 'Partner payer accounts need the active Partner relation and Partner membership.', 403);
      }
      const row = await tx.billingAccount.create({ data: { workspaceId: actor.workspaceId, payerType: input.payerType, partnerId: input.payerType === 'PARTNER' ? input.partnerId! : null, payerCustomerRef: input.payerType === 'CUSTOMER' ? actor.workspaceId : null,
        legalIdentity: input.legalIdentity, billingCurrency: input.billingCurrency, billingTimezone: input.billingTimezone, taxProfile: input.taxProfile, createdBy: actor.userId } });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_ACCOUNT_CREATED', resourceType: 'BillingAccount', resourceId: row.id, after: { payerType: row.payerType, partnerId: row.partnerId, currency: row.billingCurrency }, requestId });
      return this.redactAccount(row, true);
    });
  }
  async invoices(actor: Principal, raw: unknown) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const q = pageQuery.extend({ status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'REFUNDED']).optional() }).parse(raw);
    const where = { workspaceId: actor.workspaceId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([this.db.billingInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, omit: { legalOwner: true } }), this.db.billingInvoice.count({ where })]);
    return paged(rows.map(r => ({ ...r, balance: r.total.sub(r.paid).toFixed() })), total, q.page, q.limit);
  }
  async invoice(actor: Principal, id: string) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const invoice = await this.db.billingInvoice.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } });
    if (!invoice) throw notFound('Invoice');
    const [lines, payments, refunds] = await Promise.all([this.db.billingInvoiceLine.findMany({ where: { invoiceId: invoice.id } }), this.db.billingPayment.findMany({ where: { invoiceId: invoice.id }, orderBy: { occurredAt: 'asc' } }),
      this.db.billingRefund.findMany({ where: { paymentId: { in: (await this.db.billingPayment.findMany({ where: { invoiceId: invoice.id }, select: { id: true } })).map(p => p.id) } } })]);
    return { ...invoice, balance: invoice.total.sub(invoice.paid).toFixed(), lines, payments, refunds };
  }
  /** Generic checkout quote for a purchase, plan change or top-up already prepared by the owning service. */
  async checkoutQuote(actor: Principal, quoteId: string) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const quote = await this.db.billingQuote.findFirst({ where: { id: z.uuid().parse(quoteId), workspaceId: actor.workspaceId } });
    if (!quote) throw notFound('Quote');
    return { ...quote, partnerSnapshot: await this.db.billingPartnerPriceSnapshot.findUnique({ where: { quoteId: quote.id } }) };
  }
  /**
   * Starts a provider payment for a quote's invoice. Same key + same payload returns the original attempt; a pending/unknown
   * earlier attempt is reconciled with the provider before any new charge (04 rule 5).
   */
  async paymentAttempt(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.payment.manage');
    const input = z.strictObject({ quoteId: z.uuid(), providerId: z.enum(['stripe', 'xpay', 'sandbox']), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const requestHash = sha({ quoteId: input.quoteId, providerId: input.providerId });
    const prior = await this.db.billingPaymentAttempt.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: actor.workspaceId, idempotencyKey: input.idempotencyKey } } });
    if (prior) { if (prior.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409); return this.attemptView(prior); }
    const adapter = provider(input.providerId);
    const prepared = await this.db.$transaction(async tx => {
      const quote = await tx.billingQuote.findFirst({ where: { id: input.quoteId, workspaceId: actor.workspaceId } }); if (!quote) throw notFound('Quote');
      const invoice = await tx.billingInvoice.findUnique({ where: { quoteId: quote.id } });
      if (!invoice) throw new AppError('INVALID_STATE_TRANSITION', 'Quote has not been accepted yet.', 409);
      if (!['ISSUED', 'PARTIALLY_PAID'].includes(invoice.status)) throw new AppError('INVALID_STATE_TRANSITION', `Invoice is ${invoice.status}.`, 409);
      const open = await tx.billingPaymentAttempt.findFirst({ where: { invoiceId: invoice.id, status: { in: ['CREATED', 'PENDING', 'UNKNOWN'] } }, orderBy: { createdAt: 'desc' } });
      return { invoice, open };
    });
    if (prepared.open?.transactionRef) {
      // Reconcile the earlier attempt first; never stack a second charge on an unknown outcome.
      const state = await provider(prepared.open.provider).retrievePayment(prepared.open.transactionRef).catch(() => null);
      if (!state) throw new AppError('PROVIDER_UNAVAILABLE', 'Previous payment outcome is unknown; retry shortly.', 502);
      const result = await this.db.$transaction(tx => applyVerifiedPayment(tx, prepared.open!.provider, state));
      if (['PENDING', 'PAID', 'DUPLICATE'].includes(result)) return { ...this.attemptView(prepared.open), reconciled: result };
    }
    const invoice = await this.db.billingInvoice.findUniqueOrThrow({ where: { id: prepared.invoice.id } });
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(invoice.status)) throw new AppError('INVALID_STATE_TRANSITION', `Invoice is ${invoice.status}.`, 409);
    const amount = invoice.total.sub(invoice.paid);
    const attempt = await this.db.billingPaymentAttempt.create({ data: { workspaceId: actor.workspaceId, invoiceId: prepared.invoice.id, provider: input.providerId, idempotencyKey: input.idempotencyKey, requestHash, amount, currency: prepared.invoice.currency, createdBy: actor.userId } });
    try {
      const created = await adapter.createPaymentAttempt({ amount: amount.toFixed(), currencyCode: prepared.invoice.currency, idempotencyKey: 'billing:' + attempt.id });
      const updated = await this.db.billingPaymentAttempt.update({ where: { id: attempt.id }, data: { transactionRef: created.transactionId, checkoutUrl: created.checkoutUrl ?? null, status: 'PENDING' } });
      await this.db.$transaction(tx => billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_PAYMENT_ATTEMPT_CREATED', resourceType: 'BillingPaymentAttempt', resourceId: attempt.id, after: { invoiceId: prepared.invoice.id, provider: input.providerId, amount: amount.toFixed() }, requestId }));
      return this.attemptView(updated);
    } catch (error) {
      await this.db.billingPaymentAttempt.update({ where: { id: attempt.id }, data: { status: error instanceof AppError && error.status < 500 ? 'FAILED' : 'UNKNOWN' } });
      throw error instanceof AppError ? error : new AppError('PROVIDER_UNAVAILABLE', 'Payment provider did not accept the request; retry with a new key.', 502);
    }
  }
  private attemptView(a: Prisma.BillingPaymentAttemptGetPayload<object>) { return { id: a.id, invoiceId: a.invoiceId, provider: a.provider, status: a.status, amount: a.amount.toFixed(), currency: a.currency, checkoutUrl: a.checkoutUrl }; }
  /** Browser return never activates anything: this re-reads the provider's authoritative state. */
  async refreshAttempt(actor: Principal, id: string) {
    requirePermission(actor, 'billing.payment.manage');
    const attempt = await this.db.billingPaymentAttempt.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } });
    if (!attempt) throw notFound('Payment attempt');
    if (!attempt.transactionRef || attempt.status === 'SUCCEEDED') return this.attemptView(attempt);
    const state = await provider(attempt.provider).retrievePayment(attempt.transactionRef);
    const result = await this.db.$transaction(tx => applyVerifiedPayment(tx, attempt.provider, state));
    return { ...this.attemptView(await this.db.billingPaymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })), result };
  }
  /** POST /webhooks/billing/:provider — verified + persisted idempotently before any transition; duplicates return 2xx. */
  async webhook(providerKey: string, headers: Headers, rawBody: string) {
    if (!['stripe', 'xpay', 'sandbox'].includes(providerKey)) throw notFound('Provider');
    const adapter = billingProviders().get(providerKey);
    let event;
    try { event = await adapter.verifyAndParseWebhook(Object.fromEntries(headers.entries()), rawBody); }
    catch (error) {
      await securityEvent(this.db, { eventType: 'BILLING_WEBHOOK_REJECTED', risk: 'HIGH', details: { provider: providerKey, code: error instanceof AppError ? error.code : 'ERROR' } }).catch(() => null);
      throw error instanceof AppError ? error : new AppError('UNAUTHENTICATED', 'Webhook could not be verified.', 401);
    }
    const digest = createHash('sha256').update(rawBody).digest('hex');
    return this.db.$transaction(async tx => {
      try { await tx.billingProviderEvent.create({ data: { provider: providerKey, providerEventId: event.eventId, payloadDigest: digest, signatureState: 'VERIFIED', kind: event.eventType, transactionRef: event.transactionId } }); }
      catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true }; throw e; }
      if (!event.eventType.startsWith('PAYMENT_')) { await tx.billingProviderEvent.update({ where: { provider_providerEventId: { provider: providerKey, providerEventId: event.eventId } }, data: { result: 'IGNORED', processedAt: new Date() } }); return { received: true }; }
      const result = await applyVerifiedPayment(tx, providerKey, event);
      await tx.billingProviderEvent.update({ where: { provider_providerEventId: { provider: providerKey, providerEventId: event.eventId } }, data: { result, processedAt: new Date() } });
      return { received: true, result };
    }, { timeout: 60000 });
  }

  // ------------------------------------------------------------------ refunds (platform finance, separation of duties)
  async refund(actor: PlatformPrincipal, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'billing.refund.approve'); requireStepUp(actor, mfa);
    const input = z.strictObject({ paymentId: z.uuid(), amount: z.string().regex(/^\d+(\.\d{1,4})?$/), reason: z.string().trim().min(5).max(500), idempotencyKey: z.string().min(8).max(200), approvalId: z.uuid().optional() }).parse(raw);
    const requestHash = sha({ paymentId: input.paymentId, amount: input.amount });
    const prior = await this.db.billingRefund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (prior) { if (prior.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409); return prior; }
    const dualControl = await PlatformConfigService.platformSetting<boolean>(this.db, 'billingRefundDualControl', true);
    const refund = await this.db.$transaction(async tx => {
      const payment = await tx.billingPayment.findUnique({ where: { id: input.paymentId } }); if (!payment) throw notFound('Payment');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-invoice:' + payment.invoiceId}))`;
      const amount = money(input.amount, payment.currency);
      const prior = await tx.billingRefund.aggregate({ where: { paymentId: payment.id, status: { not: 'FAILED' } }, _sum: { amount: true } });
      if (amount.lte(0) || amount.add(prior._sum.amount ?? ZERO).gt(payment.amount)) throw new AppError('BUSINESS_RULE_VIOLATION', 'Refund exceeds the refundable amount.', 422);
      const approval = dualControl ? await consumeApproval(tx, { approvalId: input.approvalId, action: 'REFUND', payload: { paymentId: payment.id, amount: amount.toFixed() }, requesterId: actor.userId }) : null;
      const row = await tx.billingRefund.create({ data: { workspaceId: payment.workspaceId, paymentId: payment.id, amount, currency: payment.currency, reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash, approvalId: approval?.id ?? null, requestedBy: actor.userId } });
      const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
      const refunded = invoice.refunded.add(amount);
      const updatedInvoice = await tx.billingInvoice.update({ where: { id: invoice.id }, data: { refunded, status: refunded.gte(invoice.paid) ? 'REFUNDED' : invoice.status, version: { increment: 1 } } });
      await recordRefundAdjustment(tx, invoice.id, row.id, amount);
      await effects.get(invoice.kind)?.refunded?.(tx, updatedInvoice, amount, row.id);
      await billingAudit(tx, { workspaceId: payment.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_REFUND_CREATED', resourceType: 'BillingRefund', resourceId: row.id, after: { paymentId: payment.id, amount: amount.toFixed(), reason: input.reason }, requestId });
      await emitEvent(tx, { workspaceId: payment.workspaceId, eventType: 'BILLING_REFUND_CREATED', aggregateType: 'BillingRefund', aggregateId: row.id, aggregateVersion: 1, actorId: actor.userId, actorType: 'PLATFORM', payload: { paymentId: payment.id, amount: amount.toFixed(), currency: payment.currency } });
      return { row, payment };
    });
    // Provider call after the refund intent commits; the original successful payment row is never edited (AC05).
    try {
      const result = await provider(refund.payment.provider).refund({ transactionId: refund.payment.providerTransactionId, amount: refund.row.amount.toFixed(), currencyCode: refund.row.currency, idempotencyKey: 'billing-refund:' + refund.row.id });
      return this.db.billingRefund.update({ where: { id: refund.row.id }, data: { providerRefundRef: result.refundId, status: result.status, ...(result.status === 'SUCCEEDED' ? { completedAt: new Date() } : {}) } });
    } catch {
      return this.db.billingRefund.update({ where: { id: refund.row.id }, data: { status: 'UNKNOWN' } }); // reconciled by the finance run
    }
  }
  /** Platform finance view across workspaces (never exposes card data: none is stored). */
  async platformPayments(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.billing.manage');
    const q = pageQuery.extend({ workspaceId: z.uuid().optional() }).parse(raw);
    const where = q.workspaceId ? { workspaceId: q.workspaceId } : {};
    const [rows, total] = await Promise.all([this.db.billingPayment.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.billingPayment.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
}
