import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { emitEvent, notFound, pageQuery, paged, requirePlatform, type PlatformPrincipal } from '../platform/kernel';
import { applyBps, assertServiceIdentity, billingAudit, D, liveSubscription, type DbClient, type Tx } from './support';

/**
 * PartnerDiscountResolver seam (shared contract 05/06). The Partner module owns the rule set and registers the
 * authoritative resolver; until then the Partner's default discount is used. Billing only snapshots the result.
 */
export type DiscountResolution = { basisPoints: number; ruleVersion: number; ruleId: string | null };
export type PartnerDiscountResolver = (db: DbClient, input: { partnerId: string; productId: string; categoryIds: string[]; at: Date }) => Promise<DiscountResolution>;
let resolver: PartnerDiscountResolver = async (db, input) => {
  const partner = await db.partner.findUnique({ where: { id: input.partnerId } });
  return { basisPoints: Math.min(10000, Math.max(0, (partner?.defaultDiscount ?? 0) * 100)), ruleVersion: 0, ruleId: null };
};
export function registerPartnerDiscountResolver(next: PartnerDiscountResolver) { resolver = next; }

/** Exactly one ACTIVE relation per customer Workspace (enforced by Partner); spoofed client partnerIds are never read. */
export type PartnerRelationLookup = (db: DbClient, workspaceId: string) => Promise<{ relationId: string; partnerId: string } | null>;
let relationLookup: PartnerRelationLookup = async (db, workspaceId) => {
  const rows = await db.partnerWorkspaceRelation.findMany({ where: { workspaceId, isDeleted: false, partner: { isDeleted: false, status: 'ACTIVE' } }, take: 2 });
  if (rows.length > 1) throw new AppError('BUSINESS_RULE_VIOLATION', 'Workspace has more than one active Partner relation.', 422);
  return rows[0] ? { relationId: rows[0].id, partnerId: rows[0].partnerId } : null;
};
export function registerPartnerRelationLookup(next: PartnerRelationLookup) { relationLookup = next; }
export const activePartnerRelation = (db: DbClient, workspaceId: string) => relationLookup(db, workspaceId);

/** Computes the Partner discount for a base amount (no persistence). */
export async function partnerDiscount(db: DbClient, input: { workspaceId: string; productId: string; categoryIds?: string[]; base: Prisma.Decimal; currency: string }) {
  const relation = await activePartnerRelation(db, input.workspaceId);
  if (!relation || input.base.lte(0)) return null;
  const rule = await resolver(db, { partnerId: relation.partnerId, productId: input.productId, categoryIds: input.categoryIds ?? [], at: new Date() });
  const { discount, net } = applyBps(input.base, rule.basisPoints, input.currency);
  return { ...relation, ...rule, basePrice: input.base, discountAmount: discount, finalAmount: net, currency: input.currency };
}
export async function snapshotPartnerPrice(tx: Tx, quoteId: string, d: NonNullable<Awaited<ReturnType<typeof partnerDiscount>>>) {
  await tx.billingPartnerPriceSnapshot.create({ data: { quoteId, partnerId: d.partnerId, partnerRelationId: d.relationId, ruleId: d.ruleId, ruleVersion: d.ruleVersion, basePrice: d.basePrice,
    discountBasisPoints: d.basisPoints, discountAmount: d.discountAmount, finalAmount: d.finalAmount, currency: d.currency } });
  await emitEvent(tx, { workspaceId: null, eventType: 'BILLING_PARTNER_DISCOUNT_APPLIED', aggregateType: 'BillingQuote', aggregateId: quoteId, actorType: 'SERVICE', payload: { partnerId: d.partnerId, basisPoints: d.basisPoints, ruleVersion: d.ruleVersion } });
}
/** Called when a SaaS invoice is paid: historical attribution keeps the Partner at quote time (AC01). */
export async function recordPartnerTransaction(tx: Tx, invoice: { id: string; workspaceId: string; billingAccountId: string; quoteId: string | null; total: Prisma.Decimal; currency: string }) {
  const snapshot = invoice.quoteId ? await tx.billingPartnerPriceSnapshot.findUnique({ where: { quoteId: invoice.quoteId } }) : null;
  const account = await tx.billingAccount.findUnique({ where: { id: invoice.billingAccountId } });
  const partnerId = snapshot?.partnerId ?? account?.partnerId ?? null;
  if (!partnerId) return null;
  return tx.billingPartnerTransaction.upsert({ where: { invoiceId: invoice.id }, update: {},
    create: { workspaceId: invoice.workspaceId, payerAccountId: invoice.billingAccountId, partnerId, invoiceId: invoice.id, amount: invoice.total, currency: invoice.currency,
      relationSnapshot: { relationId: snapshot?.partnerRelationId ?? null, ruleId: snapshot?.ruleId ?? null, ruleVersion: snapshot?.ruleVersion ?? null, basisPoints: snapshot?.discountBasisPoints ?? 0, payerType: account?.payerType ?? null } } });
}
export async function recordRefundAdjustment(tx: Tx, invoiceId: string, refundId: string, amount: Prisma.Decimal) {
  const txn = await tx.billingPartnerTransaction.findUnique({ where: { invoiceId } });
  if (!txn) return;
  await tx.billingPartnerCreditAdjustment.upsert({ where: { relatedRefundId: refundId }, update: {}, create: { transactionId: txn.id, relatedRefundId: refundId, adjustmentType: 'REFUND', amount: amount.neg() } });
  await emitEvent(tx, { workspaceId: txn.workspaceId, eventType: 'BILLING_PARTNER_TRANSACTION_RECONCILED', aggregateType: 'BillingPartnerTransaction', aggregateId: txn.id, actorType: 'SERVICE', payload: { partnerId: txn.partnerId, refundId, amount: amount.neg().toFixed() } });
}

/** Referrals/discounts/payer separation (31/08). */
export class BillingPartnerService {
  constructor(private readonly db: PrismaClient) {}
  /** POST /internal/billing/partner-pricing/quote — preview only; persisted snapshots are created with quotes. */
  async internalQuote(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ workspaceId: z.uuid(), productId: z.string().min(1).max(120), priceVersion: z.uuid(), payerAccountId: z.uuid() }).parse(raw);
    const price = await this.db.billingPrice.findUnique({ where: { id: input.priceVersion } }); if (!price) throw notFound('Price');
    const account = await this.db.billingAccount.findFirst({ where: { id: input.payerAccountId } }); if (!account) throw notFound('Billing account');
    const d = await partnerDiscount(this.db, { workspaceId: input.workspaceId, productId: input.productId, base: price.amount, currency: price.currency });
    return { basePrice: price.amount.toFixed(), currency: price.currency, discountBasisPoints: d?.basisPoints ?? 0, discountAmount: (d?.discountAmount ?? D(0)).toFixed(), finalAmount: (d?.finalAmount ?? price.amount).toFixed(), partnerId: d?.partnerId ?? null, ruleVersion: d?.ruleVersion ?? null };
  }
  async workspaceTransactions(actor: Principal, raw: unknown) {
    requirePermission(actor, 'billing.finance.read');
    const q = pageQuery.parse(raw);
    const where = { workspaceId: actor.workspaceId };
    const [rows, total] = await Promise.all([this.db.billingPartnerTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.billingPartnerTransaction.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async platformTransactions(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.billing.manage');
    const q = pageQuery.extend({ partnerId: z.uuid().optional(), workspaceId: z.uuid().optional() }).parse(raw);
    const where = { ...(q.partnerId ? { partnerId: q.partnerId } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) };
    const [rows, total] = await Promise.all([this.db.billingPartnerTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.billingPartnerTransaction.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  /**
   * Payer switch (e.g. Partner payment failure -> direct customer payer). Needs the customer owner's consent reference and an
   * approval granted by the Workspace owner for this exact intent; never transfers Workspace ownership (07 AC02, 08 AC04).
   */
  async transitionPayer(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.account.manage');
    const input = z.strictObject({ subscriptionId: z.uuid(), newPayerAccountId: z.uuid(), customerOwnerConsentRef: z.string().trim().min(3).max(200), approvalRef: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const sub = await tx.billingSubscription.findFirst({ where: { id: input.subscriptionId, workspaceId: actor.workspaceId } }); if (!sub) throw notFound('Subscription');
      const account = await tx.billingAccount.findFirst({ where: { id: input.newPayerAccountId, workspaceId: actor.workspaceId, status: 'ACTIVE' } }); if (!account) throw notFound('Billing account');
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
      const payloadHash = createHash('sha256').update(JSON.stringify({ subscriptionId: sub.id, newPayerAccountId: account.id })).digest('hex');
      const approval = await tx.billingChangeApproval.findFirst({ where: { id: input.approvalRef, workspaceId: actor.workspaceId, action: 'PAYER_TRANSITION', status: 'APPROVED', consumedAt: null, expiresAt: { gt: new Date() } } });
      if (!approval || approval.payloadHash !== payloadHash || approval.approverId !== workspace.ownerUserId) throw new AppError('BUSINESS_RULE_VIOLATION', 'An unexpired approval by the Workspace owner for this exact payer change is required.', 422);
      await tx.billingChangeApproval.update({ where: { id: approval.id }, data: { consumedAt: new Date() } });
      const updated = await tx.billingSubscription.update({ where: { id: sub.id }, data: { billingAccountId: account.id, version: { increment: 1 } } });
      await tx.billingPayerTransition.create({ data: { subscriptionId: sub.id, fromAccountId: sub.billingAccountId, toAccountId: account.id, consentRef: input.customerOwnerConsentRef, approvalId: approval.id, requestedBy: actor.userId } });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_PAYER_CHANGED', resourceType: 'BillingSubscription', resourceId: sub.id, before: { billingAccountId: sub.billingAccountId }, after: { billingAccountId: account.id, consentRef: input.customerOwnerConsentRef }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'BILLING_PAYER_CHANGED', aggregateType: 'BillingSubscription', aggregateId: sub.id, aggregateVersion: updated.version, actorId: actor.userId, payload: { payerType: account.payerType } });
      return { subscriptionId: sub.id, billingAccountId: account.id, workspaceOwnerUnchanged: workspace.ownerUserId };
    });
  }
  static async currentPartnerFor(db: DbClient, workspaceId: string) { const sub = await liveSubscription(db, workspaceId); return { relation: await activePartnerRelation(db, workspaceId), subscriptionId: sub?.id ?? null }; }
}
