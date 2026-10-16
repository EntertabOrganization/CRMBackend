import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { registerConsumer } from '../platform/events-service';
import { PlatformConfigService } from '../platform/config-service';
import { audit, emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, type PlatformPrincipal, type UserPrincipal } from '../platform/kernel';
import { assertServiceIdentity } from '../billing/support';
import { applyBps, D, money, ZERO } from '../billing/support';
import { partnerActor, sha, type DbClient, type Tx } from './support';

const CATEGORY: Record<string, string> = { PURCHASE: 'SUBSCRIPTION', RENEWAL: 'SUBSCRIPTION', CHANGE: 'SUBSCRIPTION', TOPUP: 'CREDITS' };
const payable = (c: { commissionAmount: Prisma.Decimal; reversedAmount: Prisma.Decimal; paidAmount: Prisma.Decimal }) => c.commissionAmount.sub(c.reversedAmount).sub(c.paidAmount);
const holdDays = (db: DbClient) => PlatformConfigService.platformSetting<number>(db, 'partnerCommissionHoldDays', 30);
const commissionEvent = (tx: Tx, c: { id: string; partnerId: string; workspaceId: string }, eventType: string, payload: Record<string, unknown>) =>
  emitEvent(tx, { workspaceId: c.workspaceId, eventType, aggregateType: 'PartnerCommission', aggregateId: c.id, actorType: 'SERVICE', payload: { partnerId: c.partnerId, ...payload } });

/**
 * Accrues exactly one commission per (settled Billing transaction, policy, Partner); duplicate provider events and
 * replays hit the unique key / event key (07 AC02). Only paid invoices create Partner transactions, so unpaid quotes
 * never accrue (07 AC01). The eligible base is the net invoice total after the customer discount (07 AC04).
 */
export async function accrueForTransaction(tx: Tx, billingTransactionId: string, eventKey: string) {
  const txn = await tx.billingPartnerTransaction.findUnique({ where: { id: billingTransactionId } });
  if (!txn?.partnerId) return null;
  const invoice = await tx.billingInvoice.findUnique({ where: { id: txn.invoiceId } });
  if (!invoice || !['PAID', 'REFUNDED'].includes(invoice.status)) return null;
  const category = CATEGORY[invoice.kind] ?? 'OTHER';
  const policy = await tx.partnerCommissionPolicy.findFirst({ where: { productCategory: category, currency: txn.currency, effectiveFrom: { lte: txn.createdAt }, OR: [{ partnerId: txn.partnerId }, { partnerId: null }] },
    orderBy: [{ partnerId: { sort: 'asc', nulls: 'last' } }, { effectiveFrom: 'desc' }, { version: 'desc' }] });
  if (!policy) return null;
  const existing = await tx.partnerCommission.findUnique({ where: { billingTransactionId_policyId_partnerId: { billingTransactionId: txn.id, policyId: policy.id, partnerId: txn.partnerId } } });
  if (existing) return existing;
  const base = money(txn.amount, txn.currency);
  const amount = policy.method === 'PERCENT' ? applyBps(base, policy.basisPoints ?? 0, txn.currency).discount : money(policy.fixedAmount ?? ZERO, txn.currency);
  if (amount.lte(0)) return null;
  const commission = await tx.partnerCommission.create({ data: { partnerId: txn.partnerId, workspaceId: txn.workspaceId, billingTransactionId: txn.id, policyId: policy.id, policyVersion: policy.version,
    policySnapshot: { method: policy.method, basisPoints: policy.basisPoints, fixedAmount: policy.fixedAmount?.toFixed() ?? null, category, effectiveFrom: policy.effectiveFrom } as Prisma.InputJsonValue, eligibleBase: base, commissionAmount: amount, currency: txn.currency } });
  await tx.partnerCommissionLedger.create({ data: { commissionId: commission.id, eventKey: 'accrue:' + eventKey, type: 'ACCRUE', amount } });
  await commissionEvent(tx, commission, 'PARTNER.COMMISSION_ACCRUED', { amount: amount.toFixed(), currency: txn.currency });
  return commission;
}
/** Proportional, policy-governed reversal via a new ledger row; after payout the excess becomes a negative liability (07 AC03). */
export async function reverseForRefund(tx: Tx, billingTransactionId: string, refundId: string, refundAmount: Prisma.Decimal) {
  const txn = await tx.billingPartnerTransaction.findUnique({ where: { id: billingTransactionId } }); if (!txn) return [];
  const commissions = await tx.partnerCommission.findMany({ where: { billingTransactionId: txn.id } });
  const out = [];
  for (const c of commissions) {
    const key = `reverse:${refundId}:${c.id}`;
    if (await tx.partnerCommissionLedger.findUnique({ where: { eventKey: key } })) continue;
    const share = txn.amount.gt(0) ? money(c.commissionAmount.mul(refundAmount.abs()).div(txn.amount), c.currency) : ZERO;
    const reverse = Prisma.Decimal.min(share, c.commissionAmount.sub(c.reversedAmount));
    if (reverse.lte(0)) continue;
    await tx.partnerCommissionLedger.create({ data: { commissionId: c.id, eventKey: key, type: c.paidAmount.gt(0) ? 'ADJUST' : 'REVERSE', amount: reverse.neg() } });
    const reversed = c.reversedAmount.add(reverse);
    const updated = await tx.partnerCommission.update({ where: { id: c.id }, data: { reversedAmount: reversed, status: reversed.gte(c.commissionAmount) && c.paidAmount.eq(0) ? 'REVERSED' : c.status } });
    await commissionEvent(tx, c, 'PARTNER.COMMISSION_REVERSED', { amount: reverse.toFixed(), refundId, afterPayout: c.paidAmount.gt(0) });
    out.push(updated);
  }
  return out;
}
registerConsumer({ id: 'partner.commissions', handlerVersion: 1, eventTypes: ['BILLING_INVOICE_PAID', 'BILLING_PARTNER_TRANSACTION_RECONCILED'], async handle(tx, event) {
  if (event.eventType === 'BILLING_INVOICE_PAID') {
    const txn = await tx.billingPartnerTransaction.findUnique({ where: { invoiceId: event.aggregateId } });
    return txn ? accrueForTransaction(tx, txn.id, 'invoice:' + event.aggregateId) : null;
  }
  const payload = event.payload as { refundId?: string; amount?: string };
  if (!payload.refundId || !payload.amount) return null;
  return reverseForRefund(tx, event.aggregateId, payload.refundId, D(payload.amount));
} });

/** Commission accrual ledger (32/07) and payouts with finance approval/reconciliation (32/08). */
export class PartnerFinanceService {
  constructor(private readonly db: PrismaClient) {}

  async createPolicy(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.commissions.manage');
    const input = z.strictObject({ partnerId: z.uuid().nullable().default(null), productCategory: z.enum(['SUBSCRIPTION', 'CREDITS', 'OTHER']), method: z.enum(['FIXED', 'PERCENT']),
      rate: z.union([z.number().int().min(0).max(10000), z.string().regex(/^\d+(\.\d{1,4})?$/)]), currency: z.string().regex(/^[A-Z]{3}$/), effectiveAt: z.iso.datetime({ offset: true }), eligibilityRule: z.record(z.string(), z.unknown()).default({}) }).parse(raw);
    if (input.method === 'PERCENT' && typeof input.rate !== 'number') throw new AppError('VALIDATION_FAILED', 'Percent commissions use integer basis points (0..10000).', 400);
    return this.db.$transaction(async tx => {
      if (input.partnerId && !await tx.partner.findUnique({ where: { id: input.partnerId } })) throw notFound('Partner');
      const last = await tx.partnerCommissionPolicy.findFirst({ where: { partnerId: input.partnerId, productCategory: input.productCategory, currency: input.currency }, orderBy: { version: 'desc' } });
      const policy = await tx.partnerCommissionPolicy.create({ data: { partnerId: input.partnerId, productCategory: input.productCategory, method: input.method, currency: input.currency, effectiveFrom: new Date(input.effectiveAt),
        basisPoints: input.method === 'PERCENT' ? input.rate as number : null, fixedAmount: input.method === 'FIXED' ? money(String(input.rate), input.currency) : null, eligibilityRule: input.eligibilityRule as Prisma.InputJsonValue, version: (last?.version ?? 0) + 1, createdBy: actor.userId } });
      await audit(tx, { workspaceId: null, partnerId: input.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.COMMISSION_POLICY_CHANGED', resourceType: 'PartnerCommissionPolicy', resourceId: policy.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.COMMISSION_POLICY_CHANGED', aggregateType: 'PartnerCommissionPolicy', aggregateId: policy.id, aggregateVersion: policy.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { partnerId: input.partnerId } });
      return policy;
    });
  }
  async internalSettled(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ billingTransactionId: z.uuid(), eventKey: z.string().min(4).max(200) }).parse(raw);
    return this.db.$transaction(tx => accrueForTransaction(tx, input.billingTransactionId, input.eventKey));
  }
  async internalRefund(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ billingTransactionId: z.uuid(), refundId: z.uuid(), eventKey: z.string().min(4).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const refund = await tx.billingRefund.findUnique({ where: { id: input.refundId } }); if (!refund) throw notFound('Refund');
      return reverseForRefund(tx, input.billingTransactionId, refund.id, refund.amount);
    });
  }
  /** Partner sees only its own amounts (07 AC05, 08 AC05). */
  async commissions(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.finance.readOwn', { allowSuspended: true });
    const q = pageQuery.extend({ status: z.enum(['ELIGIBLE', 'HELD', 'APPROVED', 'REVERSED', 'PAID']).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(raw);
    const range = q.period ? { gte: new Date(q.period + '-01T00:00:00Z'), lt: new Date(new Date(q.period + '-01T00:00:00Z').setUTCMonth(new Date(q.period + '-01T00:00:00Z').getUTCMonth() + 1)) } : undefined;
    const where: Prisma.PartnerCommissionWhereInput = { partnerId: actor.partnerId, ...(q.status ? { status: q.status } : {}), ...(range ? { createdAt: range } : {}) };
    const [rows, total] = await Promise.all([this.db.partnerCommission.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.partnerCommission.count({ where })]);
    return paged(rows.map(r => ({ ...r, payable: payable(r).toFixed() })), total, q.page, q.limit);
  }
  async setCommissionStatus(actor: PlatformPrincipal, id: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.commissions.manage');
    const input = z.strictObject({ status: z.enum(['HELD', 'APPROVED', 'ELIGIBLE']), reason: z.string().trim().min(3).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      const c = await tx.partnerCommission.findUnique({ where: { id: z.uuid().parse(id) } }); if (!c) throw notFound('Commission');
      if (!['ELIGIBLE', 'HELD', 'APPROVED'].includes(c.status)) throw new AppError('INVALID_STATE_TRANSITION', `Commission is ${c.status}.`, 409);
      const updated = await tx.partnerCommission.update({ where: { id: c.id }, data: { status: input.status } });
      await audit(tx, { workspaceId: c.workspaceId, partnerId: c.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.COMMISSION_' + input.status, resourceType: 'PartnerCommission', resourceId: c.id, before: { status: c.status }, after: input, requestId });
      return updated;
    });
  }

  // ------------------------------------------------------------------ payouts
  /** Claims commissions with row locks + the one-active-claim partial index, so racing requests can't double-claim (08 AC01). */
  async requestPayout(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.payout.request', { allowSuspended: true });
    const input = z.strictObject({ commissionIds: z.array(z.uuid()).min(1).max(500), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const requestHash = sha(JSON.stringify([...input.commissionIds].sort()));
    return this.db.$transaction(async tx => {
      const prior = await tx.partnerPayoutBatch.findUnique({ where: { partnerId_idempotencyKey: { partnerId: actor.partnerId, idempotencyKey: input.idempotencyKey } } });
      if (prior) { if (prior.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409); return prior; }
      const ids = [...new Set(input.commissionIds)].sort();
      await tx.$queryRaw`SELECT id FROM partner_commissions WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
      const rows = await tx.partnerCommission.findMany({ where: { id: { in: ids }, partnerId: actor.partnerId } });
      if (rows.length !== ids.length) throw notFound('Commission');
      const hold = await holdDays(tx), cutoff = new Date(Date.now() - hold * 86400000);
      const currencies = new Set(rows.map(r => r.currency));
      if (currencies.size !== 1) throw new AppError('BUSINESS_RULE_VIOLATION', 'A payout batch uses a single currency.', 422);
      for (const r of rows) {
        if (!(r.status === 'APPROVED' || r.status === 'ELIGIBLE' && r.createdAt <= cutoff)) throw new AppError('BUSINESS_RULE_VIOLATION', `Commission ${r.id} is not payable yet (status ${r.status}, hold ${hold} days).`, 422);
        if (payable(r).lte(0)) throw new AppError('BUSINESS_RULE_VIOLATION', `Commission ${r.id} has nothing left to pay.`, 422);
      }
      const amount = rows.reduce((s, r) => s.add(payable(r)), ZERO);
      const batch = await tx.partnerPayoutBatch.create({ data: { partnerId: actor.partnerId, period: new Date().toISOString().slice(0, 7), amount, currency: rows[0].currency, requestedBy: user.userId, idempotencyKey: input.idempotencyKey, requestHash } });
      for (const r of rows) await tx.partnerPayoutItem.create({ data: { payoutBatchId: batch.id, commissionId: r.id, settledAmount: payable(r) } });
      await tx.partnerPayoutEvent.create({ data: { payoutId: batch.id, action: 'SUBMITTED', actorId: user.userId } });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.PAYOUT_REQUESTED', resourceType: 'PartnerPayoutBatch', resourceId: batch.id, after: { amount: amount.toFixed(), currency: batch.currency, items: rows.length }, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.PAYOUT_REQUESTED', aggregateType: 'PartnerPayoutBatch', aggregateId: batch.id, aggregateVersion: 1, actorId: user.userId, payload: { partnerId: actor.partnerId, amount: amount.toFixed() } });
      return batch;
    });
  }
  async payouts(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.payout.readOwn', { allowSuspended: true });
    const q = pageQuery.extend({ status: z.string().max(20).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(raw);
    const where = { partnerId: actor.partnerId, ...(q.status ? { status: q.status } : {}), ...(q.period ? { period: q.period } : {}) };
    const [rows, total] = await Promise.all([this.db.partnerPayoutBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, omit: { requestHash: true } }), this.db.partnerPayoutBatch.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async cancelPayout(user: UserPrincipal, partnerId: string, payoutId: string, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.payout.request', { allowSuspended: true });
    return this.db.$transaction(async tx => {
      const batch = await tx.partnerPayoutBatch.findFirst({ where: { id: z.uuid().parse(payoutId), partnerId: actor.partnerId } }); if (!batch) throw notFound('Payout');
      if (batch.status !== 'SUBMITTED') throw new AppError('INVALID_STATE_TRANSITION', `Payout is ${batch.status}.`, 409);
      await tx.partnerPayoutBatch.update({ where: { id: batch.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await tx.partnerPayoutItem.updateMany({ where: { payoutBatchId: batch.id }, data: { active: false } });
      await tx.partnerPayoutEvent.create({ data: { payoutId: batch.id, action: 'CANCELLED', actorId: user.userId } });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.PAYOUT_CANCELLED', resourceType: 'PartnerPayoutBatch', resourceId: batch.id, requestId });
      return { id: batch.id, status: 'CANCELLED' };
    });
  }
  /** Current payable total after reversals; a partially reversed commission can't pay its original gross (08 AC04). */
  private async currentAmount(tx: Tx, batchId: string) {
    const items = await tx.partnerPayoutItem.findMany({ where: { payoutBatchId: batchId, active: true } });
    const commissions = await tx.partnerCommission.findMany({ where: { id: { in: items.map(i => i.commissionId) } } });
    return { items, commissions, amount: commissions.reduce((s, c) => s.add(Prisma.Decimal.max(ZERO, payable(c))), ZERO) };
  }
  async approvePayout(actor: PlatformPrincipal, payoutId: string, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.partner.payout.approve'); requireStepUp(actor, mfa);
    const input = z.strictObject({ expectedAmount: z.string().regex(/^\d+(\.\d{1,4})?$/), reason: z.string().trim().min(3).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-payout:' + payoutId}))`;
      const batch = await tx.partnerPayoutBatch.findUnique({ where: { id: z.uuid().parse(payoutId) } }); if (!batch) throw notFound('Payout');
      if (batch.status !== 'SUBMITTED') throw new AppError('INVALID_STATE_TRANSITION', `Payout is ${batch.status}.`, 409);
      if (batch.requestedBy === actor.userId) throw new AppError('PERMISSION_DENIED', 'Requester cannot approve their own payout.', 403);
      const { amount } = await this.currentAmount(tx, batch.id);
      if (!amount.eq(D(input.expectedAmount)) || !amount.eq(batch.amount)) throw new AppError('VERSION_CONFLICT', 'Payable amount changed (reversals); re-request the payout.', 409, { current: amount.toFixed(), batch: batch.amount.toFixed() });
      const updated = await tx.partnerPayoutBatch.update({ where: { id: batch.id }, data: { status: 'APPROVED', approvedBy: actor.userId, version: { increment: 1 } } });
      await tx.partnerPayoutEvent.create({ data: { payoutId: batch.id, action: 'APPROVED', actorId: actor.userId } });
      await audit(tx, { workspaceId: null, partnerId: batch.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.PAYOUT_APPROVED', resourceType: 'PartnerPayoutBatch', resourceId: batch.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.PAYOUT_APPROVED', aggregateType: 'PartnerPayoutBatch', aggregateId: batch.id, aggregateVersion: updated.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { partnerId: batch.partnerId } });
      return updated;
    });
  }
  /** Manual paid status only for an approved batch with matching amount/currency and a unique external reference (08 AC03). */
  async recordPayment(actor: PlatformPrincipal, payoutId: string, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.partner.payout.record'); requireStepUp(actor, mfa);
    const input = z.strictObject({ externalReference: z.string().trim().min(3).max(200), paidAt: z.iso.datetime({ offset: true }), amount: z.string().regex(/^\d+(\.\d{1,4})?$/), currency: z.string().regex(/^[A-Z]{3}$/), provider: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/).default('manual') }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-payout:' + payoutId}))`;
      const batch = await tx.partnerPayoutBatch.findUnique({ where: { id: z.uuid().parse(payoutId) } }); if (!batch) throw notFound('Payout');
      if (!['APPROVED', 'PROCESSING'].includes(batch.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Only approved payouts can be marked paid.', 409);
      if (!D(input.amount).eq(batch.amount) || input.currency !== batch.currency) throw new AppError('BUSINESS_RULE_VIOLATION', 'Paid amount/currency must equal the approved payout.', 422);
      const { items, commissions, amount } = await this.currentAmount(tx, batch.id);
      if (!amount.eq(batch.amount)) throw new AppError('VERSION_CONFLICT', 'A reversal changed the payable amount after approval; record a failure and re-request.', 409);
      const updated = await tx.partnerPayoutBatch.update({ where: { id: batch.id }, data: { status: 'PAID', paymentProvider: input.provider, paymentReference: input.externalReference, paidAt: new Date(input.paidAt), version: { increment: 1 } } });
      for (const item of items) {
        const c = commissions.find(x => x.id === item.commissionId)!; const settle = payable(c);
        await tx.partnerCommissionLedger.create({ data: { commissionId: c.id, eventKey: `settle:${batch.id}:${c.id}`, type: 'SETTLE', amount: settle.neg() } });
        const paid = c.paidAmount.add(settle);
        await tx.partnerCommission.update({ where: { id: c.id }, data: { paidAmount: paid, status: 'PAID' } });
        await tx.partnerPayoutItem.update({ where: { id: item.id }, data: { settledAmount: settle } });
      }
      await tx.partnerPayoutEvent.create({ data: { payoutId: batch.id, action: 'PAID', actorId: actor.userId, externalRef: input.externalReference } });
      await audit(tx, { workspaceId: null, partnerId: batch.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.PAYOUT_PAID', resourceType: 'PartnerPayoutBatch', resourceId: batch.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.PAYOUT_PAID', aggregateType: 'PartnerPayoutBatch', aggregateId: batch.id, aggregateVersion: updated.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { partnerId: batch.partnerId, amount: batch.amount.toFixed() } });
      return updated;
    });
  }
  /** A failed payout releases its claims; the commission liability stays payable (08 AC02). */
  async failPayout(actor: PlatformPrincipal, payoutId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.payout.record');
    const input = z.strictObject({ reason: z.string().trim().min(3).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      const batch = await tx.partnerPayoutBatch.findUnique({ where: { id: z.uuid().parse(payoutId) } }); if (!batch) throw notFound('Payout');
      if (!['APPROVED', 'PROCESSING'].includes(batch.status)) throw new AppError('INVALID_STATE_TRANSITION', `Payout is ${batch.status}.`, 409);
      const updated = await tx.partnerPayoutBatch.update({ where: { id: batch.id }, data: { status: 'FAILED', failureReason: input.reason, version: { increment: 1 } } });
      await tx.partnerPayoutItem.updateMany({ where: { payoutBatchId: batch.id }, data: { active: false } });
      await tx.partnerPayoutEvent.create({ data: { payoutId: batch.id, action: 'FAILED', actorId: actor.userId } });
      await audit(tx, { workspaceId: null, partnerId: batch.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.PAYOUT_FAILED', resourceType: 'PartnerPayoutBatch', resourceId: batch.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.PAYOUT_FAILED', aggregateType: 'PartnerPayoutBatch', aggregateId: batch.id, aggregateVersion: updated.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { partnerId: batch.partnerId } });
      return updated;
    });
  }
  async reconcilePayout(actor: PlatformPrincipal, payoutId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.payout.reconcile');
    const input = z.strictObject({ evidenceRef: z.string().trim().min(3).max(300), observedAmount: z.string().regex(/^\d+(\.\d{1,4})?$/) }).parse(raw);
    return this.db.$transaction(async tx => {
      const batch = await tx.partnerPayoutBatch.findUnique({ where: { id: z.uuid().parse(payoutId) } }); if (!batch) throw notFound('Payout');
      if (batch.status !== 'PAID') throw new AppError('INVALID_STATE_TRANSITION', 'Only paid payouts are reconciled.', 409);
      const settled = (await tx.partnerPayoutItem.aggregate({ where: { payoutBatchId: batch.id }, _sum: { settledAmount: true } }))._sum.settledAmount ?? ZERO;
      const difference = D(input.observedAmount).sub(settled);
      const row = await tx.partnerPayoutReconciliation.upsert({ where: { payoutId: batch.id }, create: { payoutId: batch.id, evidenceRef: input.evidenceRef, status: difference.eq(0) ? 'MATCHED' : 'MISMATCH', difference, checkedBy: actor.userId },
        update: { evidenceRef: input.evidenceRef, status: difference.eq(0) ? 'MATCHED' : 'MISMATCH', difference, checkedBy: actor.userId, checkedAt: new Date() } });
      await audit(tx, { workspaceId: null, partnerId: batch.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.PAYOUT_RECONCILED', resourceType: 'PartnerPayoutBatch', resourceId: batch.id, after: { status: row.status, difference: difference.toFixed() }, requestId });
      return row;
    });
  }
  async platformPayouts(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.partner.payout.approve');
    const q = pageQuery.extend({ status: z.string().max(20).optional(), partnerId: z.uuid().optional() }).parse(raw);
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.partnerId ? { partnerId: q.partnerId } : {}) };
    const [rows, total] = await Promise.all([this.db.partnerPayoutBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.partnerPayoutBatch.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
}
