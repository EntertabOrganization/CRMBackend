import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { enqueueJob, registerJob, registerSchedule } from '../platform/events-service';
import { emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, securityEvent, type PlatformPrincipal } from '../platform/kernel';
import { applyVerifiedPayment, approvalHash, consumeApproval } from './payment-service';
import { billingAudit, D, money, monthOf, provider, recomputeEntitlements, validateEntitlementValue, ZERO, type Tx } from './support';

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const periodRange = (p: string) => { const [y, m] = p.split('-').map(Number); return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) }; };
const FORMULA_VERSION = 1, BATCH = 100;

/** Finding helper: unique per run+key, so resumed runs never duplicate findings (09 rule 5). */
async function finding(tx: Tx, runId: string, f: { key: string; type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; providerEventRef?: string | null; internalRef?: string | null; details?: Record<string, unknown> }) {
  const existing = await tx.billingReconciliationFinding.findUnique({ where: { runId_findingKey: { runId, findingKey: f.key } } });
  if (existing) return false;
  await tx.billingReconciliationFinding.create({ data: { runId, findingKey: f.key, discrepancyType: f.type, severity: f.severity, providerEventRef: f.providerEventRef ?? null, internalRef: f.internalRef ?? null, details: (f.details ?? {}) as Prisma.InputJsonValue } });
  await emitEvent(tx, { workspaceId: null, eventType: 'BILLING_DISCREPANCY_FOUND', aggregateType: 'BillingReconciliationRun', aggregateId: runId, actorType: 'SERVICE', payload: { type: f.type, severity: f.severity } });
  return true;
}

/**
 * Reconciliation: provider receipts vs internal payments/invoices/subscriptions. Cursor checkpoints let a retried job resume.
 * Unmatched provider money becomes a finding with a repair command, never a fabricated payment (09 AC04).
 */
registerJob({ type: 'billing.reconciliation', ownerModule: 'billing', maxAttempts: 5, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const run = await prisma.billingReconciliationRun.findUnique({ where: { id: String(ctx.payload.runId) } });
  if (!run || ['COMPLETE', 'FAILED'].includes(run.status)) return { skipped: true };
  await prisma.billingReconciliationRun.update({ where: { id: run.id }, data: { status: 'RUNNING' } });
  const { from, to } = periodRange(run.period);
  let cursor = run.cursor, count = run.discrepanciesCount, partial = false;
  // Phase 1: provider events without an internal match.
  if (!cursor || cursor.startsWith('events:')) {
    let after = cursor?.slice(7) || null;
    for (;;) {
      const events = await prisma.billingProviderEvent.findMany({ where: { provider: run.providerId, receivedAt: { gte: from, lt: to }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: BATCH });
      if (!events.length) break;
      await prisma.$transaction(async tx => {
        for (const e of events) if (['UNMATCHED', 'CURRENCY_MISMATCH', 'INVALID_AMOUNT'].includes(e.result ?? '') || !e.processedAt)
          if (await finding(tx, run.id, { key: 'event:' + e.id, type: e.result === 'UNMATCHED' ? 'UNMATCHED_PROVIDER_EVENT' : e.processedAt ? (e.result ?? 'UNKNOWN') : 'UNPROCESSED_PROVIDER_EVENT', severity: 'HIGH', providerEventRef: e.providerEventId, internalRef: e.transactionRef })) count++;
        after = events[events.length - 1].id;
        await tx.billingReconciliationRun.update({ where: { id: run.id }, data: { cursor: 'events:' + after, discrepanciesCount: count } });
      });
    }
    cursor = 'attempts:';
  }
  // Phase 2: pending/unknown attempts are re-read from the provider's authoritative lookup.
  if (cursor.startsWith('attempts:')) {
    let after = cursor.slice(9) || null;
    for (;;) {
      const attempts = await prisma.billingPaymentAttempt.findMany({ where: { provider: run.providerId, status: { in: ['PENDING', 'UNKNOWN'] }, createdAt: { gte: from, lt: to }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: BATCH });
      if (!attempts.length) break;
      for (const a of attempts) {
        if (!a.transactionRef) continue;
        const state = await provider(run.providerId).retrievePayment(a.transactionRef).catch(() => null);
        if (!state) { partial = true; continue; }
        await prisma.$transaction(async tx => {
          if (state.status === 'SUCCEEDED') {
            const paid = await tx.billingPayment.findUnique({ where: { provider_providerTransactionId: { provider: run.providerId, providerTransactionId: a.transactionRef! } } });
            if (!paid && await finding(tx, run.id, { key: 'attempt:' + a.id, type: 'PROVIDER_PAID_NOT_RECORDED', severity: 'HIGH', internalRef: a.id, details: { amount: state.amount, currency: state.currencyCode } })) count++;
          } else if (state.status === 'FAILED') await tx.billingPaymentAttempt.update({ where: { id: a.id }, data: { status: 'FAILED' } });
        });
      }
      after = attempts[attempts.length - 1].id;
      await prisma.billingReconciliationRun.update({ where: { id: run.id }, data: { cursor: 'attempts:' + after, discrepanciesCount: count } });
    }
    cursor = 'invoices:';
  }
  // Phase 3: invoice balances vs immutable payment rows; paid subscriptions without a paid invoice.
  if (cursor.startsWith('invoices:')) {
    const invoices = await prisma.billingInvoice.findMany({ where: { createdAt: { gte: from, lt: to }, status: { in: ['PAID', 'PARTIALLY_PAID', 'REFUNDED'] } } });
    await prisma.$transaction(async tx => {
      for (const inv of invoices) {
        const sum = await tx.billingPayment.aggregate({ where: { invoiceId: inv.id, provider: run.providerId }, _sum: { amount: true } });
        const any = await tx.billingPayment.count({ where: { invoiceId: inv.id } });
        if (!any) continue;
        if (!(sum._sum.amount ?? ZERO).eq(inv.paid) && await tx.billingPayment.count({ where: { invoiceId: inv.id, provider: { not: run.providerId } } }) === 0)
          if (await finding(tx, run.id, { key: 'invoice:' + inv.id, type: 'INVOICE_BALANCE_MISMATCH', severity: 'MEDIUM', internalRef: inv.id, details: { recorded: inv.paid.toFixed(), payments: (sum._sum.amount ?? ZERO).toFixed() } })) count++;
      }
      await tx.billingReconciliationRun.update({ where: { id: run.id }, data: { cursor: 'done', discrepanciesCount: count } });
    }, { timeout: 120000 });
  }
  await prisma.$transaction(async tx => {
    await tx.billingReconciliationRun.update({ where: { id: run.id }, data: { status: partial ? 'PARTIAL' : 'COMPLETE', completedAt: new Date(), discrepanciesCount: count } });
    await emitEvent(tx, { workspaceId: null, eventType: 'BILLING_RECONCILIATION_COMPLETED', aggregateType: 'BillingReconciliationRun', aggregateId: run.id, actorType: 'SERVICE', payload: { discrepancies: count, partial } });
  });
  return { discrepancies: count, partial };
} });

/** Monthly MRR facts (formula v1): monthly price, yearly/12; FX from the period's fixed snapshot; never touches subscriptions. */
export async function computeMrrFacts(db: PrismaClient, p: string, reportingCurrency: string) {
  const { from, to } = periodRange(p);
  const subs = await db.billingSubscription.findMany({ where: { priceId: { not: null }, createdAt: { lt: to }, OR: [{ currentPeriodEnd: { gt: from } }, { status: { in: ['ACTIVE', 'PAST_DUE', 'GRACE', 'CANCEL_PENDING'] } }] } });
  let written = 0;
  for (const sub of subs) {
    if (['TRIALING', 'PENDING_PAYMENT', 'FREE'].includes(sub.status)) continue;
    const exists = await db.billingMrrFact.findUnique({ where: { subscriptionId_period: { subscriptionId: sub.id, period: p } } });
    if (exists) continue; // facts are period snapshots: later price/FX changes never rewrite them (09 AC03)
    const price = await db.billingPrice.findUniqueOrThrow({ where: { id: sub.priceId! } });
    const mrr = money(price.period === 'YEARLY' ? price.amount.div(12) : price.amount, price.currency);
    const fx = price.currency === reportingCurrency ? D(1) : (await db.billingFxRate.findUnique({ where: { period_base_quote: { period: p, base: price.currency, quote: reportingCurrency } } }))?.rate;
    if (!fx) continue; // missing FX snapshot: fact skipped until finance publishes the rate
    const snapshot = await db.billingPartnerTransaction.findFirst({ where: { workspaceId: sub.workspaceId }, orderBy: { createdAt: 'desc' } });
    const invoiceIds = (await db.billingInvoice.findMany({ where: { subscriptionId: sub.id }, select: { id: true } })).map(i => i.id);
    const payments = await db.billingPayment.findMany({ where: { invoiceId: { in: invoiceIds }, occurredAt: { gte: from, lt: to } }, select: { id: true } });
    await db.billingMrrFact.create({ data: { workspaceId: sub.workspaceId, subscriptionId: sub.id, period: p, effectivePlanVersionId: sub.planVersionId, currency: price.currency, mrrLocal: mrr, reportingCurrency, fxRateSnapshot: fx,
      mrrReporting: money(mrr.mul(fx), reportingCurrency), partnerIdSnapshot: snapshot?.partnerId ?? null, status: sub.status, sourceEventIds: payments.map(x => x.id), formulaVersion: FORMULA_VERSION } });
    written++;
  }
  return { written };
}
registerJob({ type: 'billing.mrr', ownerModule: 'billing', maxAttempts: 3, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const p = String(ctx.payload.period ?? monthOf(new Date(Date.now() - 86400000)));
  return computeMrrFacts(prisma, p, String(ctx.payload.reportingCurrency ?? process.env.BILLING_REPORTING_CURRENCY ?? 'USD'));
} });
registerSchedule({ name: 'billing.mrr.daily', ownerModule: 'billing', jobType: 'billing.mrr', dailyLocalTime: '02:15', timezone: 'UTC' });

/** Finance reconciliation/reporting (31/09) and billing security/operations (31/10). */
export class BillingFinanceService {
  constructor(private readonly db: PrismaClient) {}

  async startReconciliation(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.reconciliation.run');
    const input = z.strictObject({ providerId: z.enum(['stripe', 'xpay', 'sandbox']), period, runScope: z.enum(['FULL']).default('FULL') }).parse(raw);
    return this.db.$transaction(async tx => {
      const existing = await tx.billingReconciliationRun.findUnique({ where: { providerId_period_runScope: { providerId: input.providerId, period: input.period, runScope: input.runScope } } });
      const run = existing && !['COMPLETE', 'FAILED', 'PARTIAL'].includes(existing.status) ? existing
        : existing ? await tx.billingReconciliationRun.update({ where: { id: existing.id }, data: { status: 'QUEUED', cursor: null, completedAt: null } })
        : await tx.billingReconciliationRun.create({ data: { ...input, requestedBy: actor.userId } });
      await enqueueJob(tx, { type: 'billing.reconciliation', ownerModule: 'billing', payload: { runId: run.id }, idempotencyKey: `recon:${run.id}:${run.startedAt.getTime()}:${existing ? Date.now() : 0}` });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_RECONCILIATION_REQUESTED', resourceType: 'BillingReconciliationRun', resourceId: run.id, after: input, requestId });
      return { id: run.id, status: run.status };
    });
  }
  async reconciliation(actor: PlatformPrincipal, id: string) {
    requirePlatform(actor, 'billing.reconciliation.review');
    const run = await this.db.billingReconciliationRun.findUnique({ where: { id: z.uuid().parse(id) } }); if (!run) throw notFound('Reconciliation run');
    return run;
  }
  async findings(actor: PlatformPrincipal, id: string, raw: unknown) {
    requirePlatform(actor, 'billing.reconciliation.review');
    const q = pageQuery.extend({ status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED']).optional() }).parse(raw);
    const where = { runId: z.uuid().parse(id), ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([this.db.billingReconciliationFinding.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.billingReconciliationFinding.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  /** Repair commands re-verify with the provider; a resolution always carries an action log entry. */
  async resolveFinding(actor: PlatformPrincipal, id: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.reconciliation.review');
    const input = z.strictObject({ resolution: z.enum(['INVESTIGATING', 'APPLY_VERIFIED_PAYMENT', 'NO_ACTION_REQUIRED', 'IGNORED']), reason: z.string().trim().min(5).max(1000) }).parse(raw);
    const f = await this.db.billingReconciliationFinding.findUnique({ where: { id: z.uuid().parse(id) } }); if (!f) throw notFound('Finding');
    if (['RESOLVED', 'IGNORED'].includes(f.status)) throw new AppError('INVALID_STATE_TRANSITION', `Finding is ${f.status}.`, 409);
    const run = await this.db.billingReconciliationRun.findUniqueOrThrow({ where: { id: f.runId } });
    let repair: string | null = null;
    if (input.resolution === 'APPLY_VERIFIED_PAYMENT') {
      const attempt = f.internalRef ? await this.db.billingPaymentAttempt.findUnique({ where: { id: f.internalRef } }) : null;
      const ref = attempt?.transactionRef ?? f.internalRef;
      if (!ref) throw new AppError('BUSINESS_RULE_VIOLATION', 'Finding has no provider transaction to verify.', 422);
      const state = await provider(run.providerId).retrievePayment(ref);
      if (state.status !== 'SUCCEEDED') throw new AppError('BUSINESS_RULE_VIOLATION', `Provider reports ${state.status}; nothing to apply.`, 422);
      repair = await this.db.$transaction(tx => applyVerifiedPayment(tx, run.providerId, state));
      if (repair === 'UNMATCHED') throw new AppError('BUSINESS_RULE_VIOLATION', 'No internal payment attempt matches this transaction; investigate manually.', 422);
    }
    return this.db.$transaction(async tx => {
      const status = input.resolution === 'INVESTIGATING' ? 'INVESTIGATING' : input.resolution === 'IGNORED' ? 'IGNORED' : 'RESOLVED';
      const updated = await tx.billingReconciliationFinding.update({ where: { id: f.id }, data: { status, resolution: input.resolution, reason: input.reason, ...(status !== 'INVESTIGATING' ? { resolvedBy: actor.userId, resolvedAt: new Date() } : {}) } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_DISCREPANCY_RESOLVED', resourceType: 'BillingReconciliationFinding', resourceId: f.id, before: { status: f.status }, after: { status, resolution: input.resolution, reason: input.reason, repair }, requestId });
      if (status !== 'INVESTIGATING') await emitEvent(tx, { workspaceId: null, eventType: 'BILLING_DISCREPANCY_RESOLVED', aggregateType: 'BillingReconciliationFinding', aggregateId: f.id, actorId: actor.userId, actorType: 'PLATFORM', payload: { resolution: input.resolution } });
      return updated;
    });
  }
  async setFxRate(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.billing.manage');
    const input = z.strictObject({ period, base: z.string().regex(/^[A-Z]{3}$/), quote: z.string().regex(/^[A-Z]{3}$/), rate: z.string().regex(/^\d+(\.\d{1,10})?$/) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.billingFxRate.create({ data: { ...input, rate: D(input.rate), createdBy: actor.userId } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_FX_RATE_PUBLISHED', resourceType: 'BillingFxRate', resourceId: row.id, after: input, requestId });
      return row;
    });
  }
  async computeMrr(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.billing.manage');
    const input = z.strictObject({ period, reportingCurrency: z.string().regex(/^[A-Z]{3}$/) }).parse(raw);
    return enqueueJob(this.db, { type: 'billing.mrr', ownerModule: 'billing', payload: input, idempotencyKey: `mrr:${input.period}:${input.reportingCurrency}:${Date.now()}` });
  }
  /**
   * Revenue report. Workspace callers see only their own Workspace; platform finance sees aggregates. Duplicate provider
   * transactions can't double count (unique payment rows), refunds reduce net in the refund's own period (09 AC01/AC02).
   */
  private async revenue(where: { workspaceId?: string }, p: string, cur: string | undefined) {
    const { from, to } = periodRange(p);
    const payments = await this.db.billingPayment.groupBy({ by: ['currency'], where: { ...where, occurredAt: { gte: from, lt: to }, ...(cur ? { currency: cur } : {}) }, _sum: { amount: true }, _count: true });
    const refunds = await this.db.billingRefund.groupBy({ by: ['currency'], where: { ...where, createdAt: { gte: from, lt: to }, status: { not: 'FAILED' }, ...(cur ? { currency: cur } : {}) }, _sum: { amount: true } });
    const mrr = await this.db.billingMrrFact.groupBy({ by: ['reportingCurrency'], where: { ...where, period: p }, _sum: { mrrReporting: true }, _count: true });
    const trials = await this.db.billingTrial.count({ where: { ...where, startedAt: { gte: from, lt: to } } });
    const churned = await this.db.billingSubscription.count({ where: { ...where, status: { in: ['CANCELLED', 'EXPIRED'] }, updatedAt: { gte: from, lt: to } } });
    const topups = await this.db.billingInvoice.groupBy({ by: ['currency'], where: { ...where, kind: 'TOPUP', status: { in: ['PAID', 'REFUNDED'] }, issuedAt: { gte: from, lt: to } }, _sum: { total: true } });
    const partner = await this.db.billingPartnerTransaction.groupBy({ by: ['currency'], where: { ...where, createdAt: { gte: from, lt: to } }, _sum: { amount: true } });
    const currencies = [...new Set([...payments.map(x => x.currency), ...refunds.map(x => x.currency)])];
    return { period: p, formulaVersion: FORMULA_VERSION,
      revenue: currencies.map(c => { const g = payments.find(x => x.currency === c)?._sum.amount ?? ZERO, r = refunds.find(x => x.currency === c)?._sum.amount ?? ZERO; return { currency: c, gross: g.toFixed(), refunds: r.toFixed(), net: g.sub(r).toFixed() }; }),
      mrr: mrr.map(m => ({ currency: m.reportingCurrency, mrr: (m._sum.mrrReporting ?? ZERO).toFixed(), arr: (m._sum.mrrReporting ?? ZERO).mul(12).toFixed(), subscriptions: m._count })),
      trialsStarted: trials, churnedSubscriptions: churned, creditPurchases: topups.map(t => ({ currency: t.currency, total: (t._sum.total ?? ZERO).toFixed() })), partnerAttributed: partner.map(t => ({ currency: t.currency, total: (t._sum.amount ?? ZERO).toFixed() })) };
  }
  async workspaceRevenue(actor: Principal, raw: unknown) {
    requirePermission(actor, 'billing.finance.read');
    const q = z.object({ period, currency: z.string().regex(/^[A-Z]{3}$/).optional() }).parse(raw);
    return this.revenue({ workspaceId: actor.workspaceId }, q.period, q.currency);
  }
  async platformRevenue(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.billing.manage');
    const q = z.object({ period, currency: z.string().regex(/^[A-Z]{3}$/).optional(), workspaceId: z.uuid().optional() }).parse(raw);
    return this.revenue(q.workspaceId ? { workspaceId: q.workspaceId } : {}, q.period, q.currency);
  }
  async usageReport(actor: Principal, raw: unknown) {
    requirePermission(actor, 'workspace.billing.readUsage');
    const q = z.object({ period }).parse(raw), { from, to } = periodRange(q.period);
    const rows = await this.db.billingUsageEvent.groupBy({ by: ['sourceModule', 'meterId'], where: { workspaceId: actor.workspaceId, occurredAt: { gte: from, lt: to } }, _sum: { quantity: true }, _count: true });
    const meters = await this.db.billingUsageMeter.findMany({ where: { id: { in: rows.map(r => r.meterId) } }, select: { id: true, entitlementCode: true } });
    return rows.map(r => ({ meterCode: meters.find(m => m.id === r.meterId)?.entitlementCode, sourceModule: r.sourceModule, quantity: (r._sum.quantity ?? ZERO).toFixed(), events: r._count }));
  }

  // ------------------------------------------------------------------ 10 approvals, overrides, audit, preferences
  /** Change approvals (REQUESTED -> APPROVED|REJECTED|EXPIRED) bound to an exact payload hash. */
  async requestApproval(actor: { userId: string }, scope: { workspaceId: string | null }, raw: unknown, requestId: string) {
    const input = z.strictObject({ action: z.enum(['REFUND', 'ENTITLEMENT_OVERRIDE', 'CREDIT_ADJUSTMENT', 'PAYER_TRANSITION']), payload: z.record(z.string(), z.unknown()), reason: z.string().trim().min(5).max(1000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.billingChangeApproval.create({ data: { workspaceId: scope.workspaceId, action: input.action, payload: input.payload as Prisma.InputJsonValue, payloadHash: approvalHash(input.payload), requesterId: actor.userId, reason: input.reason, expiresAt: new Date(Date.now() + 72 * 3600000) } });
      await billingAudit(tx, { workspaceId: scope.workspaceId, actorId: actor.userId, actorType: scope.workspaceId ? 'USER' : 'PLATFORM', action: 'BILLING_APPROVAL_REQUESTED', resourceType: 'BillingChangeApproval', resourceId: row.id, after: { action: input.action, reason: input.reason }, requestId });
      return row;
    });
  }
  async requestPlatformApproval(actor: PlatformPrincipal, raw: unknown, requestId: string) { requirePlatform(actor, 'platform.billing.manage'); return this.requestApproval(actor, { workspaceId: null }, raw, requestId); }
  async requestWorkspaceApproval(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.account.manage');
    const parsed = z.object({ action: z.literal('PAYER_TRANSITION') }).passthrough().parse(raw);
    return this.requestApproval(actor, { workspaceId: actor.workspaceId }, parsed, requestId);
  }
  /** Platform approvals: a different platform user decides, with step-up MFA (separation of duties). */
  async decidePlatformApproval(actor: PlatformPrincipal, id: string, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.billing.manage'); requireStepUp(actor, mfa);
    return this.decide(actor.userId, id, raw, null, requestId);
  }
  /** Workspace approvals (payer transition): only the Workspace owner may approve. */
  async decideWorkspaceApproval(actor: Principal, id: string, raw: unknown, requestId: string) {
    const ws = await this.db.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    if (ws.ownerUserId !== actor.userId) throw new AppError('PERMISSION_DENIED', 'Only the Workspace owner can approve this change.', 403);
    return this.decide(actor.userId, id, raw, actor.workspaceId, requestId);
  }
  private async decide(userId: string, id: string, raw: unknown, workspaceId: string | null, requestId: string) {
    const input = z.strictObject({ decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().min(3).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.billingChangeApproval.findFirst({ where: { id: z.uuid().parse(id), workspaceId } }); if (!row) throw notFound('Approval');
      if (row.status !== 'REQUESTED') throw new AppError('INVALID_STATE_TRANSITION', `Approval is ${row.status}.`, 409);
      if (row.expiresAt <= new Date()) { await tx.billingChangeApproval.update({ where: { id: row.id }, data: { status: 'EXPIRED' } }); throw new AppError('INVALID_STATE_TRANSITION', 'Approval request expired.', 409); }
      if (row.requesterId === userId && workspaceId === null) throw new AppError('PERMISSION_DENIED', 'Requester cannot approve their own request.', 403);
      const updated = await tx.billingChangeApproval.update({ where: { id: row.id }, data: { status: input.decision, approverId: userId, decisionAt: new Date() } });
      await billingAudit(tx, { workspaceId, actorId: userId, actorType: workspaceId ? 'USER' : 'PLATFORM', action: 'BILLING_APPROVAL_' + input.decision, resourceType: 'BillingChangeApproval', resourceId: row.id, after: { action: row.action, reason: input.reason }, requestId });
      return updated;
    });
  }
  async approvals(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.billing.manage');
    const q = pageQuery.extend({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED']).optional() }).parse(raw);
    const where = { workspaceId: null, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([this.db.billingChangeApproval.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.billingChangeApproval.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  /** POST /platform/billing/overrides — strongly privileged, approved by another platform user, time-boxed. */
  async createOverride(actor: PlatformPrincipal, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'billing.plan.override'); requireStepUp(actor, mfa);
    const input = z.strictObject({ workspaceId: z.uuid(), feature: z.string().max(80), value: z.unknown(), reason: z.string().trim().min(5).max(500), expiresAt: z.iso.datetime({ offset: true }), approvalId: z.uuid().optional() }).parse(raw);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= new Date() || expiresAt.getTime() - Date.now() > 366 * 86400000) throw new AppError('VALIDATION_FAILED', 'Overrides expire within one year.', 400);
    return this.db.$transaction(async tx => {
      const def = await tx.billingEntitlementDefinition.findUnique({ where: { code: input.feature } }); if (!def) throw new AppError('VALIDATION_FAILED', 'Unknown entitlement.', 400);
      validateEntitlementValue(def, input.value);
      const approval = await consumeApproval(tx, { approvalId: input.approvalId, action: 'ENTITLEMENT_OVERRIDE', payload: { workspaceId: input.workspaceId, feature: input.feature, value: input.value }, requesterId: actor.userId });
      const row = await tx.billingEntitlementOverride.create({ data: { workspaceId: input.workspaceId, definitionId: def.id, value: input.value as Prisma.InputJsonValue, reason: input.reason, expiresAt, approvalId: approval.id, createdBy: actor.userId } });
      await recomputeEntitlements(tx, input.workspaceId, 'OVERRIDE_APPROVED');
      await billingAudit(tx, { workspaceId: input.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_OVERRIDE_APPROVED', resourceType: 'BillingEntitlementOverride', resourceId: row.id, after: { feature: input.feature, value: input.value, expiresAt }, requestId });
      await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'BILLING_OVERRIDE_APPROVED', aggregateType: 'BillingEntitlementOverride', aggregateId: row.id, aggregateVersion: 1, actorId: actor.userId, actorType: 'PLATFORM', payload: { feature: input.feature } });
      return row;
    });
  }
  async revokeOverride(actor: PlatformPrincipal, id: string, requestId: string) {
    requirePlatform(actor, 'billing.plan.override');
    return this.db.$transaction(async tx => {
      const row = await tx.billingEntitlementOverride.findUnique({ where: { id: z.uuid().parse(id) } }); if (!row || row.revokedAt) throw notFound('Override');
      await tx.billingEntitlementOverride.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedBy: actor.userId } });
      await recomputeEntitlements(tx, row.workspaceId, 'OVERRIDE_REVOKED');
      await billingAudit(tx, { workspaceId: row.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_OVERRIDE_REVOKED', resourceType: 'BillingEntitlementOverride', resourceId: row.id, requestId });
      await emitEvent(tx, { workspaceId: row.workspaceId, eventType: 'BILLING_OVERRIDE_REVOKED', aggregateType: 'BillingEntitlementOverride', aggregateId: row.id, actorId: actor.userId, actorType: 'PLATFORM', payload: {} });
      return { id: row.id, revoked: true };
    });
  }
  /** Workspace billing audit (scoped): billing resource types only, own Workspace only. */
  async workspaceAudit(actor: Principal, raw: unknown) {
    requirePermission(actor, 'billing.finance.read');
    const q = pageQuery.extend({ entityId: z.string().max(80).optional() }).parse(raw);
    const where = { workspaceId: actor.workspaceId, entityType: { startsWith: 'Billing' }, ...(q.entityId ? { entityId: q.entityId } : {}) };
    const [rows, total] = await Promise.all([this.db.auditLog.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, select: { id: true, action: true, entityType: true, entityId: true, actorUserId: true, occurredAt: true, afterData: true } }), this.db.auditLog.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async preferences(actor: Principal) {
    requirePermission(actor, 'billing.invoice.readWorkspace');
    return (await this.db.billingCustomerPreference.findUnique({ where: { workspaceId: actor.workspaceId } })) ?? { workspaceId: actor.workspaceId, invoiceDeliveryEmail: null, currency: null, taxProfileVersion: 1, version: 0 };
  }
  async updatePreferences(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.account.manage');
    const input = z.strictObject({ expectedVersion: z.number().int().min(0), invoiceDeliveryEmail: z.email().nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.billingCustomerPreference.findUnique({ where: { workspaceId: actor.workspaceId } });
      if ((row?.version ?? 0) !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Preferences changed; reload and retry.', 409);
      const { expectedVersion: _v, ...data } = input;
      const saved = await tx.billingCustomerPreference.upsert({ where: { workspaceId: actor.workspaceId }, create: { workspaceId: actor.workspaceId, ...data }, update: { ...data, version: { increment: 1 } } });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_PREFERENCES_CHANGED', resourceType: 'BillingCustomerPreference', resourceId: actor.workspaceId, after: data, requestId });
      return saved;
    });
  }
  /**
   * Payment-method change must be provider-hosted tokenization (no PAN/CVV in TrueCRM). The current adapters expose no hosted
   * setup session, so this fails closed and is recorded as an integration blocker (customers pay each invoice via hosted checkout).
   */
  async paymentMethodChange(actor: Principal) {
    requirePermission(actor, 'billing.payment.manage');
    await securityEvent(this.db, { workspaceId: actor.workspaceId, principalId: actor.userId, eventType: 'BILLING_PAYMENT_METHOD_CHANGE_UNAVAILABLE', risk: 'LOW' });
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'Hosted payment-method setup is not configured for the billing provider; pay invoices via hosted checkout.', 503);
  }
}
