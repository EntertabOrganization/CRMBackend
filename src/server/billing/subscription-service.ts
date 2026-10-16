import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { registerJob, registerSchedule } from '../platform/events-service';
import { emitEvent, notFound, requirePlatform, type PlatformPrincipal } from '../platform/kernel';
import { enforceRateLimit } from '../platform/governance-service';
import { PlatformNotificationService } from '../platform/notifications-service';
import { assertQuoteFresh, createQuote, issueInvoiceForQuote, registerInvoiceEffect, type QuoteLine } from './payment-service';
import { grantCredits } from './usage-service';
import { addPeriod, assertTransition, billingAudit, D, graceDays, liveSubscription, money, recomputeEntitlements, trialDays, usageCounter, ZERO, type DbClient, type Tx } from './support';

const RENEWAL_LEAD_DAYS = 3, PENDING_PAYMENT_DAYS = 7;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Stable identity fingerprint: normalized owner email (+tags and gmail dots removed) plus optional device hint. */
function fingerprint(email: string, device: string | null) {
  const [local, domain] = email.toLowerCase().trim().split('@');
  const base = local.split('+')[0], normalized = ['gmail.com', 'googlemail.com'].includes(domain) ? base.replace(/\./g, '') + '@gmail.com' : base + '@' + domain;
  return { identity: sha('identity:' + normalized), device: device ? sha('device:' + device.slice(0, 200)) : null };
}

async function ownersOf(db: DbClient, workspaceId: string) {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  const admins = await db.workspaceMembership.findMany({ where: { workspaceId, status: 'ACTIVE', isDeleted: false, role: { rolePermissions: { some: { isDeleted: false, permission: { key: 'billing.subscription.change' } } } } }, select: { userId: true } });
  return [...new Set([ws?.ownerUserId, ...admins.map(a => a.userId)].filter(Boolean) as string[])];
}
async function notifyBilling(tx: Tx, workspaceId: string, eventId: string, title: string, message: string) {
  await PlatformNotificationService.emitInTx(tx, { workspaceId, recipientIds: await ownersOf(tx, workspaceId), topic: 'BILLING_CRITICAL', title, message, eventId, link: '/billing' });
}
async function planCredits(tx: Tx, planVersionId: string) {
  const def = await tx.billingEntitlementDefinition.findUnique({ where: { code: 'ai.credits' } });
  const row = def ? await tx.billingPlanEntitlement.findUnique({ where: { versionId_definitionId: { versionId: planVersionId, definitionId: def.id } } }) : null;
  const value = row?.value;
  return typeof value === 'number' || typeof value === 'string' ? D(value) : ZERO;
}
async function grantPlanCredits(tx: Tx, sub: { id: string; workspaceId: string; planVersionId: string }, periodStart: Date, periodEnd: Date) {
  const credits = await planCredits(tx, sub.planVersionId);
  if (credits.gt(0)) await grantCredits(tx, { workspaceId: sub.workspaceId, source: 'PLAN', sourceRef: `plan:${sub.id}:${periodStart.toISOString()}`, units: credits, expiresAt: periodEnd, reason: 'Plan credits' });
}
async function sellableVersion(tx: Tx, versionId: string) {
  const v = await tx.billingPlanVersion.findUnique({ where: { id: versionId } });
  if (!v || v.status !== 'PUBLISHED' || !v.sellable) throw new AppError('BUSINESS_RULE_VIOLATION', 'Plan version is not published for sale.', 422);
  const plan = await tx.billingPlan.findUniqueOrThrow({ where: { id: v.planId } });
  if (plan.status !== 'ACTIVE') throw new AppError('BUSINESS_RULE_VIOLATION', 'Plan is retired.', 422);
  return { version: v, plan };
}
async function effectivePrice(tx: Tx, priceId: string, versionId: string) {
  const price = await tx.billingPrice.findFirst({ where: { id: priceId, planVersionId: versionId, effectiveAt: { lte: new Date() } } });
  if (!price) throw new AppError('BUSINESS_RULE_VIOLATION', 'Price is not effective for this plan version.', 422);
  return price;
}
async function transitionSub(tx: Tx, sub: Prisma.BillingSubscriptionGetPayload<object>, to: string, data: Prisma.BillingSubscriptionUpdateInput, event: string | null, cause: string) {
  assertTransition(sub.status, to);
  const updated = await tx.billingSubscription.update({ where: { id: sub.id }, data: { ...data, status: to, version: { increment: 1 } } });
  await billingAudit(tx, { workspaceId: sub.workspaceId, actorId: null, actorType: 'SERVICE', action: event ?? 'SUBSCRIPTION_' + to, resourceType: 'BillingSubscription', resourceId: sub.id, before: { status: sub.status }, after: { status: to, cause } });
  if (event) await emitEvent(tx, { workspaceId: sub.workspaceId, eventType: event, aggregateType: 'BillingSubscription', aggregateId: sub.id, aggregateVersion: updated.version, actorType: 'SERVICE', payload: { status: to, cause } });
  await recomputeEntitlements(tx, sub.workspaceId, cause);
  return updated;
}

// ------------------------------------------------------------------ invoice effects
registerInvoiceEffect('PURCHASE', {
  async paid(tx, invoice) {
    const quote = await tx.billingQuote.findUniqueOrThrow({ where: { id: invoice.quoteId! } });
    const price = await tx.billingPrice.findUniqueOrThrow({ where: { id: quote.priceId! } });
    const now = new Date(), end = addPeriod(now, price.period);
    let sub = quote.subscriptionId ? await tx.billingSubscription.findUnique({ where: { id: quote.subscriptionId } }) : null;
    if (sub && ['CANCELLED', 'EXPIRED'].includes(sub.status)) sub = null;
    const live = await liveSubscription(tx, invoice.workspaceId);
    if (live && sub?.id !== live.id && ['ACTIVE', 'CANCEL_PENDING', 'PAST_DUE', 'GRACE'].includes(live.status)) {
      // A paid subscription already exists: keep the money traceable for refund/review rather than doubling subscriptions.
      await emitEvent(tx, { workspaceId: invoice.workspaceId, eventType: 'BILLING_DISCREPANCY_FOUND', aggregateType: 'BillingInvoice', aggregateId: invoice.id, actorType: 'SERVICE', payload: { reason: 'DUPLICATE_PURCHASE' } });
      return;
    }
    sub ??= live;
    const data = { planVersionId: quote.toPlanVersionId!, priceId: price.id, billingAccountId: invoice.billingAccountId, currentPeriodStart: now, currentPeriodEnd: end, cancelAtPeriodEnd: false, graceUntil: null };
    const activated = sub ? await transitionSub(tx, sub, 'ACTIVE', data, 'SUBSCRIPTION_ACTIVATED', 'PAYMENT_CONFIRMED')
      : await (async () => { const created = await tx.billingSubscription.create({ data: { workspaceId: invoice.workspaceId, status: 'ACTIVE', ...data } });
          await emitEvent(tx, { workspaceId: invoice.workspaceId, eventType: 'SUBSCRIPTION_ACTIVATED', aggregateType: 'BillingSubscription', aggregateId: created.id, aggregateVersion: 1, actorType: 'SERVICE', payload: {} });
          await recomputeEntitlements(tx, invoice.workspaceId, 'PAYMENT_CONFIRMED'); return created; })();
    await tx.billingTrial.updateMany({ where: { workspaceId: invoice.workspaceId, consumedAt: null }, data: { consumedAt: now, status: 'CONVERTED' } });
    await tx.billingInvoice.update({ where: { id: invoice.id }, data: { subscriptionId: activated.id, periodStart: now, periodEnd: end } });
    await grantPlanCredits(tx, activated, now, end);
  },
});
registerInvoiceEffect('CHANGE', {
  async paid(tx, invoice) {
    const change = await tx.billingSubscriptionChange.findUnique({ where: { quoteId: invoice.quoteId! } });
    if (!change || change.status !== 'PAYMENT_PENDING') return;
    await applyChange(tx, change.id, 'PAYMENT_CONFIRMED');
  },
  async failed(tx, invoice) {
    const change = await tx.billingSubscriptionChange.findUnique({ where: { quoteId: invoice.quoteId! } });
    if (change?.status === 'PAYMENT_PENDING') await tx.billingSubscriptionChange.update({ where: { id: change.id }, data: { status: 'FAILED' } });
  },
});
/** Renewal: exactly one extension per period invoice (02 AC03); a late verified payment restores service (07 AC04). */
registerInvoiceEffect('RENEWAL', {
  async paid(tx, invoice) {
    const sub = await tx.billingSubscription.findUnique({ where: { id: invoice.subscriptionId! } });
    if (!sub || !invoice.periodStart || !invoice.periodEnd) return;
    if (sub.currentPeriodEnd && sub.currentPeriodEnd >= invoice.periodEnd) return; // already extended
    const scheduled = await tx.billingSubscriptionChange.findFirst({ where: { subscriptionId: sub.id, status: 'SCHEDULED', effectiveAt: { lte: invoice.periodStart } } });
    const quote = invoice.quoteId ? await tx.billingQuote.findUnique({ where: { id: invoice.quoteId } }) : null;
    const data: Prisma.BillingSubscriptionUpdateInput = { currentPeriodEnd: invoice.periodEnd, renewalCount: { increment: 1 }, graceUntil: null,
      ...(new Date() >= invoice.periodStart ? { currentPeriodStart: invoice.periodStart } : {}),
      ...(quote?.toPlanVersionId ? { planVersionId: quote.toPlanVersionId, priceId: quote.priceId } : {}) };
    let updated;
    if (sub.status === 'ACTIVE') {
      updated = await tx.billingSubscription.update({ where: { id: sub.id }, data: { ...data, version: { increment: 1 } } });
      await emitEvent(tx, { workspaceId: sub.workspaceId, eventType: 'SUBSCRIPTION_RENEWED', aggregateType: 'BillingSubscription', aggregateId: sub.id, aggregateVersion: updated.version, actorType: 'SERVICE', payload: { periodEnd: invoice.periodEnd } });
      await recomputeEntitlements(tx, sub.workspaceId, 'RENEWED');
    } else if (['PAST_DUE', 'GRACE'].includes(sub.status) || sub.status === 'EXPIRED' && !await liveSubscription(tx, sub.workspaceId)) {
      updated = await transitionSub(tx, sub, 'ACTIVE', { ...data, currentPeriodStart: invoice.periodStart }, 'SUBSCRIPTION_RECOVERED', 'LATE_PAYMENT_CONFIRMED');
      await tx.billingRecoveryCase.updateMany({ where: { subscriptionId: sub.id, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      await tx.billingServiceContinuity.deleteMany({ where: { workspaceId: sub.workspaceId } });
    } else return;
    if (scheduled) await tx.billingSubscriptionChange.update({ where: { id: scheduled.id }, data: { status: 'APPLIED', appliedAt: new Date() } });
    if (scheduled) await emitEvent(tx, { workspaceId: sub.workspaceId, eventType: 'SUBSCRIPTION_CHANGE_APPLIED', aggregateType: 'BillingSubscriptionChange', aggregateId: scheduled.id, actorType: 'SERVICE', payload: { toPlanVersionId: scheduled.toPlanVersionId } });
    await grantPlanCredits(tx, updated, invoice.periodStart, invoice.periodEnd);
  },
  async failed(tx, invoice) { await tx.billingRecoveryCase.updateMany({ where: { invoiceId: invoice.id, status: 'OPEN' }, data: { attempts: { increment: 1 } } }); },
});

async function applyChange(tx: Tx, changeId: string, cause: string) {
  const change = await tx.billingSubscriptionChange.findUniqueOrThrow({ where: { id: changeId } });
  const sub = await tx.billingSubscription.findUniqueOrThrow({ where: { id: change.subscriptionId } });
  const updated = await tx.billingSubscription.update({ where: { id: sub.id }, data: { planVersionId: change.toPlanVersionId, priceId: change.toPriceId ?? sub.priceId, version: { increment: 1 } } });
  await tx.billingSubscriptionChange.update({ where: { id: change.id }, data: { status: 'APPLIED', appliedAt: new Date() } });
  await billingAudit(tx, { workspaceId: sub.workspaceId, actorId: null, actorType: 'SERVICE', action: 'SUBSCRIPTION_CHANGE_APPLIED', resourceType: 'BillingSubscription', resourceId: sub.id, before: { planVersionId: sub.planVersionId }, after: { planVersionId: change.toPlanVersionId, cause } });
  await emitEvent(tx, { workspaceId: sub.workspaceId, eventType: 'SUBSCRIPTION_CHANGE_APPLIED', aggregateType: 'BillingSubscription', aggregateId: sub.id, aggregateVersion: updated.version, actorType: 'SERVICE', payload: { changeId: change.id, toPlanVersionId: change.toPlanVersionId } });
  await recomputeEntitlements(tx, sub.workspaceId, 'PLAN_CHANGED');
}

/** Issues (idempotently) the renewal invoice for the period after `currentPeriodEnd`, honoring a scheduled downgrade. */
async function issueRenewal(tx: Tx, sub: Prisma.BillingSubscriptionGetPayload<object>) {
  if (!sub.currentPeriodEnd || !sub.priceId || !sub.billingAccountId) return null;
  const periodStart = sub.currentPeriodEnd;
  const existing = await tx.billingInvoice.findFirst({ where: { subscriptionId: sub.id, kind: 'RENEWAL', periodStart } });
  if (existing) return existing;
  const scheduled = await tx.billingSubscriptionChange.findFirst({ where: { subscriptionId: sub.id, status: 'SCHEDULED', effectiveAt: { lte: periodStart } } });
  const versionId = scheduled?.toPlanVersionId ?? sub.planVersionId, priceId = scheduled?.toPriceId ?? sub.priceId;
  const price = await tx.billingPrice.findUniqueOrThrow({ where: { id: priceId } });
  const periodEnd = addPeriod(periodStart, price.period);
  const plan = await tx.billingPlanVersion.findUniqueOrThrow({ where: { id: versionId } });
  const quote = await createQuote(tx, { workspaceId: sub.workspaceId, kind: 'RENEWAL', subscriptionId: sub.id, fromPlanVersionId: sub.planVersionId, toPlanVersionId: versionId, priceId, payerAccountId: sub.billingAccountId,
    effectiveAt: periodStart, currency: price.currency, productId: 'plan:' + plan.planId, lines: [{ kind: 'SUBSCRIPTION', description: `Subscription ${periodStart.toISOString().slice(0, 10)} – ${periodEnd.toISOString().slice(0, 10)}`, quantity: '1', unitPrice: price.amount.toFixed(), subtotal: price.amount.toFixed() }],
    fingerprint: { renewal: sub.id, price: price.id, periodStart: periodStart.toISOString() }, ttlMinutes: 60 * 24 * 60 });
  return issueInvoiceForQuote(tx, quote.id, { periodStart, periodEnd, subscriptionId: sub.id });
}

/**
 * Lifecycle tick (scheduled job): trial expiry, renewal invoicing, past-due -> 15-day grace with dunning notices,
 * grace end (no destructive cleanup), cancel at period end, scheduled change application for zero-cost renewals.
 */
export async function lifecycleTick(db: PrismaClient, limit = 50) {
  const now = new Date(), stats = { trialsExpired: 0, renewalsIssued: 0, pastDue: 0, graceEnded: 0, cancelled: 0, pendingExpired: 0, dunning: 0 };
  const each = async (rows: { id: string }[], fn: (tx: Tx, sub: Prisma.BillingSubscriptionGetPayload<object>) => Promise<boolean | void>, key: keyof typeof stats) => {
    for (const row of rows) {
      try {
        const done = await db.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-sub:' + row.id}))`;
          const sub = await tx.billingSubscription.findUniqueOrThrow({ where: { id: row.id } });
          return fn(tx, sub);
        }, { timeout: 60000 });
        if (done !== false) stats[key]++;
      } catch { /* isolated; retried next tick */ }
    }
  };
  await each(await db.billingSubscription.findMany({ where: { status: 'TRIALING', trialEnd: { lte: now } }, take: limit, select: { id: true } }), async (tx, sub) => {
    if (sub.status !== 'TRIALING' || !sub.trialEnd || sub.trialEnd > new Date()) return false;
    await transitionSub(tx, sub, 'EXPIRED', {}, 'SUBSCRIPTION_EXPIRED', 'TRIAL_ENDED'); // never auto-charged without authorization
    await tx.billingTrial.updateMany({ where: { workspaceId: sub.workspaceId, consumedAt: null }, data: { consumedAt: new Date(), status: 'ENDED' } });
    await notifyBilling(tx, sub.workspaceId, 'trial-ended:' + sub.id, 'Your trial has ended', 'Your data is kept. Choose a plan to continue using premium features.');
  }, 'trialsExpired');
  await each(await db.billingSubscription.findMany({ where: { status: 'PENDING_PAYMENT', createdAt: { lte: new Date(now.getTime() - PENDING_PAYMENT_DAYS * 86400000) } }, take: limit, select: { id: true } }), async (tx, sub) => {
    if (sub.status !== 'PENDING_PAYMENT') return false;
    await transitionSub(tx, sub, 'EXPIRED', {}, 'SUBSCRIPTION_EXPIRED', 'PAYMENT_NOT_COMPLETED');
  }, 'pendingExpired');
  await each(await db.billingSubscription.findMany({ where: { status: 'ACTIVE', cancelAtPeriodEnd: false, currentPeriodEnd: { lte: new Date(now.getTime() + RENEWAL_LEAD_DAYS * 86400000) } }, take: limit, select: { id: true } }), async (tx, sub) => {
    const before = await tx.billingInvoice.count({ where: { subscriptionId: sub.id, kind: 'RENEWAL', periodStart: sub.currentPeriodEnd ?? undefined } });
    const invoice = await issueRenewal(tx, sub);
    if (!invoice || before) return false;
    if (invoice.status !== 'PAID') await notifyBilling(tx, sub.workspaceId, 'renewal:' + invoice.id, 'Subscription renewal due', `Invoice ${invoice.number} for ${invoice.total.toFixed()} ${invoice.currency} is due before your period ends.`);
  }, 'renewalsIssued');
  await each(await db.billingSubscription.findMany({ where: { status: 'ACTIVE', currentPeriodEnd: { lte: now } }, take: limit, select: { id: true } }), async (tx, sub) => {
    if (sub.status !== 'ACTIVE' || !sub.currentPeriodEnd || sub.currentPeriodEnd > new Date()) return false;
    const invoice = await issueRenewal(tx, sub);
    if (invoice?.status === 'PAID') return false; // zero-cost or prepaid renewal already extended the period
    const graceUntil = new Date(sub.currentPeriodEnd.getTime() + await graceDays(tx) * 86400000); // anchored to the trusted failed renewal
    const pastDue = await transitionSub(tx, sub, 'PAST_DUE', {}, 'SUBSCRIPTION_PAST_DUE', 'RENEWAL_UNPAID');
    await transitionSub(tx, pastDue, 'GRACE', { graceUntil }, 'SUBSCRIPTION_GRACE_STARTED', 'GRACE_STARTED');
    const recovery = await tx.billingRecoveryCase.create({ data: { subscriptionId: sub.id, workspaceId: sub.workspaceId, invoiceId: invoice?.id ?? null, failureReasonCode: 'RENEWAL_UNPAID', graceUntil } });
    for (const day of [0, 3, 7, 14]) {
      const at = new Date(sub.currentPeriodEnd.getTime() + day * 86400000); if (at >= graceUntil) continue;
      await tx.billingDunningAction.create({ data: { caseId: recovery.id, kind: 'PAYMENT_REMINDER', scheduledAt: at, channel: 'NOTIFICATION', idempotencyKey: `${recovery.id}:day${day}` } });
    }
  }, 'pastDue');
  await each(await db.billingSubscription.findMany({ where: { status: 'GRACE', graceUntil: { lte: now } }, take: limit, select: { id: true } }), async (tx, sub) => {
    if (sub.status !== 'GRACE' || !sub.graceUntil || sub.graceUntil > new Date()) return false;
    await transitionSub(tx, sub, 'EXPIRED', {}, 'SUBSCRIPTION_GRACE_ENDED', 'GRACE_ENDED');
    await emitEvent(tx, { workspaceId: sub.workspaceId, eventType: 'SUBSCRIPTION_EXPIRED', aggregateType: 'BillingSubscription', aggregateId: sub.id, actorType: 'SERVICE', payload: { cause: 'GRACE_ENDED' } });
    await tx.billingRecoveryCase.updateMany({ where: { subscriptionId: sub.id, status: 'OPEN' }, data: { status: 'EXPIRED' } });
    // Continuity (07 rule 2/3): existing records stay readable/exportable; only new premium writes are restricted.
    for (const feature of ['commerce', 'sites', 'marketing', 'hr', 'knowledge', 'ai'])
      await tx.billingServiceContinuity.upsert({ where: { workspaceId_feature: { workspaceId: sub.workspaceId, feature } }, create: { workspaceId: sub.workspaceId, feature, existingReadPolicy: 'READ_EXPORT', newWritePolicy: 'BLOCK_PREMIUM', effectiveAt: new Date() }, update: {} });
    await notifyBilling(tx, sub.workspaceId, 'grace-ended:' + sub.id, 'Premium features paused', 'Your records are preserved and exportable. Pay the open invoice to restore full access.');
  }, 'graceEnded');
  await each(await db.billingSubscription.findMany({ where: { status: 'CANCEL_PENDING', currentPeriodEnd: { lte: now } }, take: limit, select: { id: true } }), async (tx, sub) => {
    if (sub.status !== 'CANCEL_PENDING' || !sub.currentPeriodEnd || sub.currentPeriodEnd > new Date()) return false;
    await transitionSub(tx, sub, 'CANCELLED', {}, 'SUBSCRIPTION_CANCELLED', 'PAID_TERM_ENDED');
  }, 'cancelled');
  const actions = await db.billingDunningAction.findMany({ where: { deliveryState: 'SCHEDULED', scheduledAt: { lte: now } }, take: limit });
  for (const action of actions) await db.$transaction(async tx => {
    const claimed = await tx.billingDunningAction.updateMany({ where: { id: action.id, deliveryState: 'SCHEDULED' }, data: { deliveryState: 'SENT' } });
    if (!claimed.count) return;
    const recovery = await tx.billingRecoveryCase.findUniqueOrThrow({ where: { id: action.caseId } });
    if (recovery.status !== 'OPEN') { await tx.billingDunningAction.update({ where: { id: action.id }, data: { deliveryState: 'SKIPPED' } }); return; }
    // Reminder only: no charge is attempted from dunning, so duplicate dunning can never double-charge (07 AC05).
    await notifyBilling(tx, recovery.workspaceId, 'dunning:' + action.idempotencyKey, 'Payment needed to keep premium features', `Grace period ends ${recovery.graceUntil.toISOString().slice(0, 10)}. Your data is safe.`);
    stats.dunning++;
  });
  return stats;
}
registerJob({ type: 'billing.lifecycle', ownerModule: 'billing', maxAttempts: 3, async run() { const { prisma } = await import('../prisma-client'); return lifecycleTick(prisma); } });
registerSchedule({ name: 'billing.lifecycle', ownerModule: 'billing', jobType: 'billing.lifecycle', intervalMinutes: 5 });

/** Trials, subscriptions, plan changes and recovery (31/02, 31/03, 31/07). */
export class BillingSubscriptionService {
  constructor(private readonly db: PrismaClient) {}

  async startTrial(actor: Principal, raw: unknown, deviceHint: string | null, ip: string | null, requestId: string) {
    requirePermission(actor, 'billing.subscription.purchase');
    const input = z.strictObject({ planVersionId: z.uuid() }).parse(raw);
    await enforceRateLimit(this.db, 'billing.trial.start', 'IP', ip ?? 'unknown', { requests: 5, windowSeconds: 3600 });
    const user = await this.db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    const fp = fingerprint(user.email, deviceHint);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-ws:' + actor.workspaceId}))`;
      const { version } = await sellableVersion(tx, input.planVersionId);
      const used = await tx.billingTrial.findFirst({ where: { OR: [{ fingerprintHash: fp.identity }, { workspaceId: actor.workspaceId }, ...(fp.device ? [{ fingerprintHash: fp.device }] : [])] } });
      // Generic answer: never reveals whether another Workspace/person consumed the trial (anti-enumeration).
      if (used) throw new AppError('BUSINESS_RULE_VIOLATION', 'A trial is not available for this Workspace.', 422);
      const live = await liveSubscription(tx, actor.workspaceId);
      if (live && live.status !== 'FREE') throw new AppError('INVALID_STATE_TRANSITION', `Workspace already has a ${live.status} subscription.`, 409);
      const days = version.trialDays ?? await trialDays(tx), now = new Date(), end = new Date(now.getTime() + days * 86400000);
      await tx.billingTrial.create({ data: { workspaceId: actor.workspaceId, fingerprintHash: fp.identity, endsAt: end } });
      const sub = live ? await transitionSub(tx, live, 'TRIALING', { planVersionId: version.id, trialEnd: end, currentPeriodStart: now, currentPeriodEnd: end }, 'SUBSCRIPTION_TRIAL_STARTED', 'TRIAL_STARTED')
        : await tx.billingSubscription.create({ data: { workspaceId: actor.workspaceId, planVersionId: version.id, status: 'TRIALING', trialEnd: end, currentPeriodStart: now, currentPeriodEnd: end } });
      if (!live) {
        await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'SUBSCRIPTION_TRIAL_STARTED', aggregateType: 'BillingSubscription', aggregateId: sub.id, aggregateVersion: 1, actorId: actor.userId, payload: { planVersionId: version.id, trialEnd: end } });
        await recomputeEntitlements(tx, actor.workspaceId, 'TRIAL_STARTED');
      }
      await grantPlanCredits(tx, sub, now, end);
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_TRIAL_STARTED', resourceType: 'BillingSubscription', resourceId: sub.id, after: { planVersionId: version.id, trialEnd: end, days }, requestId });
      return sub;
    });
  }
  /** Purchase: immutable quote + invoice; activation only after the provider-verified payment (02 AC02). */
  async purchase(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.subscription.purchase');
    const input = z.strictObject({ planVersionId: z.uuid(), priceId: z.uuid(), payerAccountId: z.uuid(), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-ws:' + actor.workspaceId}))`;
      const prior = await tx.billingQuote.findFirst({ where: { workspaceId: actor.workspaceId, kind: 'PURCHASE', idempotencyKey: input.idempotencyKey } });
      if (prior) {
        if (prior.toPlanVersionId !== input.planVersionId || prior.priceId !== input.priceId || prior.payerAccountId !== input.payerAccountId) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409);
        return { quote: prior, invoice: await tx.billingInvoice.findUnique({ where: { quoteId: prior.id } }), subscription: await liveSubscription(tx, actor.workspaceId) };
      }
      const { version } = await sellableVersion(tx, input.planVersionId);
      const price = await effectivePrice(tx, input.priceId, version.id);
      const account = await tx.billingAccount.findFirst({ where: { id: input.payerAccountId, workspaceId: actor.workspaceId, status: 'ACTIVE' } }); if (!account) throw notFound('Billing account');
      if (account.billingCurrency !== price.currency) throw new AppError('BUSINESS_RULE_VIOLATION', 'Payer currency does not match the price currency.', 422);
      let live = await liveSubscription(tx, actor.workspaceId);
      if (live && ['ACTIVE', 'PAST_DUE', 'GRACE', 'CANCEL_PENDING'].includes(live.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Workspace already has a paid subscription; use a plan change.', 409);
      if (live?.status === 'PENDING_PAYMENT') {
        const open = await tx.billingQuote.findFirst({ where: { subscriptionId: live.id, kind: 'PURCHASE', status: { in: ['QUOTED', 'INVOICED'] } }, orderBy: { createdAt: 'desc' } });
        const openInvoice = open ? await tx.billingInvoice.findUnique({ where: { quoteId: open.id } }) : null;
        if (openInvoice && ['ISSUED', 'PARTIALLY_PAID'].includes(openInvoice.status)) await tx.billingInvoice.update({ where: { id: openInvoice.id }, data: { status: 'VOID', version: { increment: 1 } } });
        if (openInvoice?.status === 'PARTIALLY_PAID') throw new AppError('INVALID_STATE_TRANSITION', 'A partially paid purchase is in progress.', 409);
      }
      if (!live) live = await tx.billingSubscription.create({ data: { workspaceId: actor.workspaceId, planVersionId: version.id, priceId: price.id, billingAccountId: account.id, status: 'PENDING_PAYMENT' } });
      else if (live.status === 'FREE') live = await transitionSub(tx, live, 'PENDING_PAYMENT', { planVersionId: version.id, priceId: price.id, billingAccountId: account.id }, null, 'CHECKOUT_STARTED');
      const quote = await createQuote(tx, { workspaceId: actor.workspaceId, kind: 'PURCHASE', subscriptionId: live.id, fromPlanVersionId: live.planVersionId, toPlanVersionId: version.id, priceId: price.id, payerAccountId: account.id,
        effectiveAt: new Date(), currency: price.currency, productId: 'plan:' + version.planId, lines: [{ kind: 'SUBSCRIPTION', description: `Subscription (${price.period.toLowerCase()})`, quantity: '1', unitPrice: price.amount.toFixed(), subtotal: price.amount.toFixed() }],
        fingerprint: { price: price.id, amount: price.amount.toFixed() }, idempotencyKey: input.idempotencyKey, createdBy: actor.userId });
      const invoice = await issueInvoiceForQuote(tx, quote.id, { subscriptionId: live.id });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_CHECKOUT_STARTED', resourceType: 'BillingQuote', resourceId: quote.id, after: { planVersionId: version.id, priceId: price.id, total: quote.total.toFixed() }, requestId });
      return { quote, invoice, subscription: live, next: invoice.status === 'PAID' ? null : 'POST /api/v1/billing/payment-attempts' };
    });
  }
  async current(actor: Principal) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const sub = await this.db.billingSubscription.findFirst({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: 'desc' } });
    if (!sub) return null;
    const [version, scheduled, recovery] = await Promise.all([this.db.billingPlanVersion.findUnique({ where: { id: sub.planVersionId } }), this.db.billingSubscriptionChange.findFirst({ where: { subscriptionId: sub.id, status: { in: ['SCHEDULED', 'PAYMENT_PENDING'] } } }),
      this.db.billingRecoveryCase.findFirst({ where: { subscriptionId: sub.id, status: 'OPEN' } })]);
    const plan = version ? await this.db.billingPlan.findUnique({ where: { id: version.planId } }) : null;
    return { ...sub, plan: plan && { code: plan.code, name: plan.name, version: version?.version }, scheduledChange: scheduled, recoveryCase: recovery };
  }
  async history(actor: Principal) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const subs = await this.db.billingSubscription.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: 'desc' } });
    const changes = await this.db.billingSubscriptionChange.findMany({ where: { subscriptionId: { in: subs.map(s => s.id) } }, orderBy: { createdAt: 'desc' } });
    return { subscriptions: subs, changes };
  }
  private async load(tx: Tx, actor: Principal, id: string) {
    const sub = await tx.billingSubscription.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } });
    if (!sub) throw notFound('Subscription');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-sub:' + sub.id}))`;
    return tx.billingSubscription.findUniqueOrThrow({ where: { id: sub.id } });
  }
  /** Manual renewal issues the next-period invoice once; extension happens only on verified payment. */
  async renew(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'billing.subscription.change');
    return this.db.$transaction(async tx => {
      const sub = await this.load(tx, actor, id);
      if (!['ACTIVE', 'PAST_DUE', 'GRACE', 'EXPIRED'].includes(sub.status)) throw new AppError('INVALID_STATE_TRANSITION', `Subscription is ${sub.status}.`, 409);
      const invoice = await issueRenewal(tx, sub);
      if (!invoice) throw new AppError('BUSINESS_RULE_VIOLATION', 'Subscription has no paid price or payer account.', 422);
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_RENEWAL_REQUESTED', resourceType: 'BillingSubscription', resourceId: sub.id, after: { invoiceId: invoice.id }, requestId });
      return { invoice, next: invoice.status === 'PAID' ? null : 'POST /api/v1/billing/payment-attempts' };
    });
  }
  async renewInternal(actor: PlatformPrincipal, id: string) {
    requirePlatform(actor, 'billing.recovery.manage');
    return this.db.$transaction(async tx => { const sub = await tx.billingSubscription.findUnique({ where: { id: z.uuid().parse(id) } }); if (!sub) throw notFound('Subscription'); return issueRenewal(tx, sub); });
  }
  /** Default: stop renewal, keep access through the paid term (02 AC04). Immediate cancel only per explicit refund policy. */
  async cancel(actor: Principal, id: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.subscription.cancel');
    const input = z.strictObject({ atPeriodEnd: z.boolean().default(true), reason: z.string().trim().min(2).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      const sub = await this.load(tx, actor, id);
      let updated;
      if (sub.status === 'TRIALING') updated = await transitionSub(tx, sub, 'EXPIRED', { cancelReason: input.reason }, 'SUBSCRIPTION_EXPIRED', 'TRIAL_CANCELLED');
      else if (sub.status === 'PENDING_PAYMENT') updated = await transitionSub(tx, sub, 'EXPIRED', { cancelReason: input.reason }, 'SUBSCRIPTION_EXPIRED', 'CHECKOUT_CANCELLED');
      else if (input.atPeriodEnd) {
        updated = await transitionSub(tx, sub, 'CANCEL_PENDING', { cancelAtPeriodEnd: true, cancelReason: input.reason }, 'SUBSCRIPTION_CANCEL_REQUESTED', 'CANCEL_AT_PERIOD_END');
        await tx.billingSubscriptionChange.updateMany({ where: { subscriptionId: sub.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
      } else throw new AppError('BUSINESS_RULE_VIOLATION', 'Immediate cancellation requires the refund policy process; cancel at period end instead.', 422);
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_CANCEL_REQUESTED', resourceType: 'BillingSubscription', resourceId: sub.id, after: { atPeriodEnd: input.atPeriodEnd, reason: input.reason }, requestId });
      return updated;
    });
  }
  async reactivate(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'billing.subscription.cancel');
    return this.db.$transaction(async tx => {
      const sub = await this.load(tx, actor, id);
      if (sub.status !== 'CANCEL_PENDING' || !sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Only a pending cancellation within its paid term can be reactivated; purchase a new plan otherwise.', 409);
      const updated = await transitionSub(tx, sub, 'ACTIVE', { cancelAtPeriodEnd: false, cancelReason: null }, 'SUBSCRIPTION_REACTIVATED', 'REACTIVATED');
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_REACTIVATED', resourceType: 'BillingSubscription', resourceId: sub.id, requestId });
      return updated;
    });
  }

  // ------------------------------------------------------------------ 03 plan changes
  private async compatibility(tx: Tx, sub: Prisma.BillingSubscriptionGetPayload<object>, targetVersionId: string) {
    const defs = await tx.billingEntitlementDefinition.findMany({ where: { quotaKind: 'COUNT' } });
    const target = await tx.billingPlanEntitlement.findMany({ where: { versionId: targetVersionId } });
    const findings = [];
    for (const def of defs) {
      const counter = usageCounter(def.code); if (!counter) continue;
      const raw = target.find(t => t.definitionId === def.id)?.value ?? def.defaultValue;
      if (raw === null) continue;
      const limit = D(raw as Prisma.Decimal.Value), usage = await counter(tx, sub.workspaceId);
      if (D(usage).gt(limit)) findings.push({ featureCode: def.code, currentUsage: D(usage), targetLimit: limit, severity: 'WARNING', actionPolicy: 'KEEP_EXISTING_BLOCK_NEW' });
    }
    const booleansLost = (await tx.billingEntitlementDefinition.findMany({ where: { valueType: 'BOOLEAN' } })).filter(def => (target.find(t => t.definitionId === def.id)?.value ?? def.defaultValue) === false);
    const current = await tx.billingPlanEntitlement.findMany({ where: { versionId: sub.planVersionId, definitionId: { in: booleansLost.map(b => b.id) } } });
    for (const c of current.filter(c => c.value === true)) findings.push({ featureCode: booleansLost.find(b => b.id === c.definitionId)!.code, currentUsage: D(1), targetLimit: D(0), severity: 'WARNING', actionPolicy: 'READ_ONLY_EXISTING' });
    const check = await tx.billingCompatibilityCheck.create({ data: { subscriptionId: sub.id, workspaceId: sub.workspaceId, targetVersionId, status: findings.length ? 'WARNINGS' : 'PASS' } });
    for (const f of findings) await tx.billingCompatibilityFinding.create({ data: { checkId: check.id, ...f } });
    return { check, findings };
  }
  async compatibilityCheck(actor: Principal, id: string) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const check = await this.db.billingCompatibilityCheck.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } }); if (!check) throw notFound('Compatibility check');
    return { ...check, findings: await this.db.billingCompatibilityFinding.findMany({ where: { checkId: check.id } }) };
  }
  /** Proration uses one price period as the denominator, so a prepaid next period is credited correctly (03 AC05). */
  private async proration(tx: Tx, sub: Prisma.BillingSubscriptionGetPayload<object>, targetPrice: Prisma.BillingPriceGetPayload<object>) {
    const current = await tx.billingPrice.findUniqueOrThrow({ where: { id: sub.priceId! } });
    const end = sub.currentPeriodEnd!, now = new Date();
    const length = addPeriod(end, current.period).getTime() - end.getTime(), remaining = Math.max(0, end.getTime() - now.getTime());
    const fraction = D(remaining).div(length);
    const charge = money(targetPrice.amount.mul(fraction), targetPrice.currency), credit = money(current.amount.mul(fraction), current.currency);
    return { fraction: fraction.toDecimalPlaces(8).toFixed(), charge, credit, currentPrice: current };
  }
  async changeQuote(actor: Principal, id: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.planChange.request');
    const input = z.strictObject({ targetPlanVersionId: z.uuid(), targetPriceId: z.uuid().optional(), requestedTiming: z.enum(['IMMEDIATE', 'AT_RENEWAL']).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const sub = await this.load(tx, actor, id);
      if (sub.status !== 'ACTIVE' || !sub.priceId || !sub.billingAccountId || !sub.currentPeriodEnd) throw new AppError('INVALID_STATE_TRANSITION', 'Only an active paid subscription can change plans.', 409);
      if (sub.planVersionId === input.targetPlanVersionId) throw new AppError('BUSINESS_RULE_VIOLATION', 'Subscription is already on this plan version.', 422);
      const { version } = await sellableVersion(tx, input.targetPlanVersionId);
      const current = await tx.billingPrice.findUniqueOrThrow({ where: { id: sub.priceId } });
      const target = input.targetPriceId ? await effectivePrice(tx, input.targetPriceId, version.id)
        : await tx.billingPrice.findFirst({ where: { planVersionId: version.id, currency: current.currency, period: current.period, effectiveAt: { lte: new Date() } }, orderBy: { effectiveAt: 'desc' } });
      if (!target || target.currency !== current.currency) throw new AppError('BUSINESS_RULE_VIOLATION', 'Target plan has no price in the subscription currency (FX conversion requires an explicit snapshot).', 422);
      const { check, findings } = await this.compatibility(tx, sub, version.id);
      const downgrade = target.amount.lt(current.amount) || findings.length > 0;
      const timing = input.requestedTiming ?? (downgrade ? 'AT_RENEWAL' : 'IMMEDIATE');
      const p = await this.proration(tx, sub, target);
      const lines: QuoteLine[] = timing === 'IMMEDIATE' ? [{ kind: 'PRORATED_CHARGE', description: `Prorated ${p.fraction} of period on new plan`, quantity: p.fraction, unitPrice: target.amount.toFixed(), subtotal: p.charge.toFixed() }] : [];
      const quote = await createQuote(tx, { workspaceId: actor.workspaceId, kind: 'CHANGE', subscriptionId: sub.id, fromPlanVersionId: sub.planVersionId, toPlanVersionId: version.id, priceId: target.id, payerAccountId: sub.billingAccountId,
        requestedTiming: timing, effectiveAt: timing === 'IMMEDIATE' ? new Date() : sub.currentPeriodEnd, currency: target.currency, productId: 'plan:' + version.planId, lines, credits: timing === 'IMMEDIATE' ? p.credit : ZERO,
        fingerprint: { sub: sub.id, subVersion: sub.version, from: current.id, to: target.id, fromAmount: current.amount.toFixed(), toAmount: target.amount.toFixed(), timing }, createdBy: actor.userId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'SUBSCRIPTION_CHANGE_QUOTED', aggregateType: 'BillingQuote', aggregateId: quote.id, aggregateVersion: 1, actorId: actor.userId, payload: { timing, total: quote.total.toFixed() } });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_CHANGE_QUOTED', resourceType: 'BillingQuote', resourceId: quote.id, after: { to: version.id, timing, total: quote.total.toFixed(), compatibility: check.status }, requestId });
      return { quote, compatibilityCheck: { ...check, findings }, proration: timing === 'IMMEDIATE' ? { fraction: p.fraction, charge: p.charge.toFixed(), credit: p.credit.toFixed() } : null };
    });
  }
  /** Executes a quote; duplicate command with the same quote returns the same change (never double-charges, 03 AC04). */
  async change(actor: Principal, id: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.planChange.approve');
    const input = z.strictObject({ quoteId: z.uuid(), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const sub = await this.load(tx, actor, id);
      const existing = await tx.billingSubscriptionChange.findUnique({ where: { quoteId: input.quoteId } });
      if (existing) return { change: existing, invoice: await tx.billingInvoice.findUnique({ where: { quoteId: input.quoteId } }) };
      const quote = await tx.billingQuote.findFirst({ where: { id: input.quoteId, workspaceId: actor.workspaceId, subscriptionId: sub.id, kind: 'CHANGE' } }); if (!quote) throw notFound('Quote');
      if (quote.status !== 'QUOTED') throw new AppError('INVALID_STATE_TRANSITION', `Quote is ${quote.status}.`, 409);
      const current = await tx.billingPrice.findUniqueOrThrow({ where: { id: sub.priceId! } }), target = await tx.billingPrice.findUniqueOrThrow({ where: { id: quote.priceId! } });
      const lines = quote.lines as QuoteLine[];
      await assertQuoteFresh(tx, quote, { sub: sub.id, subVersion: sub.version, from: current.id, to: target.id, fromAmount: current.amount.toFixed(), toAmount: target.amount.toFixed(), timing: quote.requestedTiming }, 'plan:' + (await tx.billingPlanVersion.findUniqueOrThrow({ where: { id: quote.toPlanVersionId! } })).planId, Prisma.Decimal.max(ZERO, lines.reduce((s, l) => s.add(l.subtotal), ZERO).sub(quote.credits)), quote.currency);
      if (quote.requestedTiming === 'AT_RENEWAL') {
        await tx.billingSubscriptionChange.updateMany({ where: { subscriptionId: sub.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
        const change = await tx.billingSubscriptionChange.create({ data: { subscriptionId: sub.id, changeType: 'DOWNGRADE', fromPlanVersionId: sub.planVersionId, toPlanVersionId: quote.toPlanVersionId!, toPriceId: quote.priceId, quoteId: quote.id, effectiveAt: sub.currentPeriodEnd!, status: 'SCHEDULED', requestedBy: actor.userId } });
        await tx.billingQuote.update({ where: { id: quote.id }, data: { status: 'APPLIED' } });
        await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'SUBSCRIPTION_CHANGE_SCHEDULED', aggregateType: 'BillingSubscriptionChange', aggregateId: change.id, aggregateVersion: 1, actorId: actor.userId, payload: { effectiveAt: change.effectiveAt } });
        await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_CHANGE_SCHEDULED', resourceType: 'BillingSubscriptionChange', resourceId: change.id, after: { effectiveAt: change.effectiveAt }, requestId });
        return { change, invoice: null };
      }
      const change = await tx.billingSubscriptionChange.create({ data: { subscriptionId: sub.id, changeType: 'UPGRADE', fromPlanVersionId: sub.planVersionId, toPlanVersionId: quote.toPlanVersionId!, toPriceId: quote.priceId, quoteId: quote.id, effectiveAt: new Date(), status: 'PAYMENT_PENDING', requestedBy: actor.userId,
        prorationSnapshot: { subtotal: quote.subtotal.toFixed(), credits: quote.credits.toFixed(), discount: quote.discount.toFixed(), total: quote.total.toFixed(), lines: quote.lines } as Prisma.InputJsonValue } });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_CHANGE_REQUESTED', resourceType: 'BillingSubscriptionChange', resourceId: change.id, after: { total: quote.total.toFixed() }, requestId });
      const invoice = await issueInvoiceForQuote(tx, quote.id, { subscriptionId: sub.id }); // zero total applies immediately via the PAID effect
      return { change: await tx.billingSubscriptionChange.findUniqueOrThrow({ where: { id: change.id } }), invoice, next: invoice.status === 'PAID' ? null : 'POST /api/v1/billing/payment-attempts' };
    });
  }
  async cancelScheduledChange(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'billing.planChange.request');
    return this.db.$transaction(async tx => {
      const sub = await this.load(tx, actor, id);
      const cancelled = await tx.billingSubscriptionChange.updateMany({ where: { subscriptionId: sub.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
      if (!cancelled.count) throw new AppError('INVALID_STATE_TRANSITION', 'No scheduled change exists.', 409);
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SUBSCRIPTION_CHANGE_CANCELLED', resourceType: 'BillingSubscription', resourceId: sub.id, requestId });
      return { cancelled: true };
    });
  }

  // ------------------------------------------------------------------ 07 recovery
  async recoveryCase(actor: Principal, id: string) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    const sub = await this.db.billingSubscription.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } }); if (!sub) throw notFound('Subscription');
    const recovery = await this.db.billingRecoveryCase.findFirst({ where: { subscriptionId: sub.id }, orderBy: { startedAt: 'desc' } });
    if (!recovery) return null;
    const [actions, invoice, continuity] = await Promise.all([this.db.billingDunningAction.findMany({ where: { caseId: recovery.id }, orderBy: { scheduledAt: 'asc' } }), recovery.invoiceId ? this.db.billingInvoice.findUnique({ where: { id: recovery.invoiceId }, omit: { legalOwner: true } }) : null,
      this.db.billingServiceContinuity.findMany({ where: { workspaceId: actor.workspaceId } })]);
    return { ...recovery, actions, invoice, continuity };
  }
  /** Retry = a fresh payment attempt on the open invoice under the customer's explicit action (no stored-card auto charge). */
  async retryPayment(actor: Principal, id: string) {
    requirePermission(actor, 'billing.subscription.retryOwn');
    const recovery = await this.recoveryCase(actor, id);
    if (!recovery || recovery.status === 'RESOLVED' || !recovery.invoice) throw new AppError('INVALID_STATE_TRANSITION', 'No unpaid recovery invoice exists.', 409);
    const quoteId = recovery.invoice.quoteId;
    return { invoiceId: recovery.invoice.id, quoteId, next: 'POST /api/v1/billing/payment-attempts with this quoteId and a new idempotencyKey' };
  }
  /** Platform/internal: resolves a case only from a verified payment already recorded on its invoice. */
  async resolveRecovery(actor: PlatformPrincipal, caseId: string, requestId: string) {
    requirePlatform(actor, 'billing.recovery.manage');
    return this.db.$transaction(async tx => {
      const recovery = await tx.billingRecoveryCase.findUnique({ where: { id: z.uuid().parse(caseId) } }); if (!recovery) throw notFound('Recovery case');
      const invoice = recovery.invoiceId ? await tx.billingInvoice.findUnique({ where: { id: recovery.invoiceId } }) : null;
      if (!invoice || invoice.status !== 'PAID') throw new AppError('BUSINESS_RULE_VIOLATION', 'Recovery resolves only after a provider-verified payment; support cannot mark it paid.', 422);
      await tx.billingRecoveryCase.update({ where: { id: recovery.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      await billingAudit(tx, { workspaceId: recovery.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_RECOVERY_RESOLVED', resourceType: 'BillingRecoveryCase', resourceId: recovery.id, requestId });
      return { id: recovery.id, status: 'RESOLVED' };
    });
  }
}
