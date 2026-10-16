import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { registerJob, registerSchedule } from '../platform/events-service';
import { emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, type PlatformPrincipal } from '../platform/kernel';
import { createQuote, issueInvoiceForQuote, registerInvoiceEffect, consumeApproval } from './payment-service';
import { assertServiceIdentity, billingAudit, D, effectiveEntitlements, liveSubscription, monthOf, units, ZERO, type DbClient, type Tx } from './support';

const RESERVATION_TTL_MINUTES = 15;
const unitsInput = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().nonnegative()]).transform(v => units(v));
/** Usage meters whose quota is the credit ledger rather than a plan count (no duplicate credit service in AI). */
const CREDIT_METERS: Record<string, string> = { 'ai.credits': 'AI' };

// ------------------------------------------------------------------ credit ledger (06)
export async function creditAccount(tx: Tx, workspaceId: string, creditType = 'AI') {
  return tx.billingCreditAccount.upsert({ where: { workspaceId_creditType: { workspaceId, creditType } }, create: { workspaceId, creditType }, update: {} });
}
/** Idempotent grant keyed by sourceRef (duplicate provider events never grant twice, 06 AC04). */
export async function grantCredits(tx: Tx, input: { workspaceId: string; creditType?: string; source: 'PLAN' | 'PURCHASE' | 'ADJUSTMENT'; sourceRef: string; units: Prisma.Decimal; expiresAt: Date | null; eligibleScenarios?: string[]; reason?: string }) {
  if (input.units.lte(0)) return null;
  const account = await creditAccount(tx, input.workspaceId, input.creditType);
  const existing = await tx.billingCreditGrant.findUnique({ where: { accountId_sourceRef: { accountId: account.id, sourceRef: input.sourceRef } } });
  if (existing) return existing;
  const grant = await tx.billingCreditGrant.create({ data: { accountId: account.id, source: input.source, sourceRef: input.sourceRef, initialUnits: input.units, remainingUnits: input.units, expiresAt: input.expiresAt, eligibleScenarios: input.eligibleScenarios ?? [] } });
  await tx.billingCreditLedgerEntry.create({ data: { accountId: account.id, grantId: grant.id, eventKey: 'grant:' + grant.id, entryType: 'GRANT', quantity: input.units, reason: input.reason ?? input.source } });
  await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'BILLING_CREDITS_GRANTED', aggregateType: 'BillingCreditGrant', aggregateId: grant.id, aggregateVersion: 1, actorType: 'SERVICE', payload: { source: input.source, units: input.units.toFixed() } });
  return grant;
}
type Allocation = { grantId: string; units: string };
/**
 * Plan credits first by earliest expiry, then purchased/adjustment credits by earliest expiry, ties by grant id (shared contract 06).
 * Grant rows are locked FOR UPDATE so concurrent runs cannot drive the balance below zero (06 AC05).
 */
async function reserveCreditsInTx(tx: Tx, input: { workspaceId: string; creditType: string; operationKey: string; runId: string; scenario: string; units: Prisma.Decimal }) {
  const account = await creditAccount(tx, input.workspaceId, input.creditType);
  const existing = await tx.billingCreditReservation.findUnique({ where: { accountId_operationKey: { accountId: account.id, operationKey: input.operationKey } } });
  if (existing) { if (!existing.reservedUnits.eq(input.units)) throw new AppError('IDEMPOTENCY_CONFLICT', 'Operation key reused with a different quantity.', 409); return existing; }
  const grants = await tx.$queryRaw<{ id: string; source: string; remaining_units: Prisma.Decimal; held_units: Prisma.Decimal; expires_at: Date | null; eligible_scenarios: unknown }[]>`
    SELECT id, source, remaining_units, held_units, expires_at, eligible_scenarios FROM billing_credit_grants
    WHERE account_id = ${account.id}::uuid AND status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now()) AND remaining_units > held_units
    ORDER BY CASE source WHEN 'PLAN' THEN 0 ELSE 1 END, expires_at ASC NULLS LAST, id ASC FOR UPDATE`;
  let needed = input.units; const allocations: Allocation[] = [];
  for (const g of grants) {
    const scenarios = (g.eligible_scenarios as string[]) ?? [];
    if (scenarios.length && !scenarios.includes(input.scenario)) continue;
    const available = D(g.remaining_units).sub(g.held_units); if (available.lte(0)) continue;
    const take = Prisma.Decimal.min(available, needed);
    allocations.push({ grantId: g.id, units: take.toFixed() }); needed = needed.sub(take);
    if (needed.lte(0)) break;
  }
  if (needed.gt(0)) {
    await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'BILLING_LIMIT_REACHED', aggregateType: 'BillingCreditAccount', aggregateId: account.id, actorType: 'SERVICE', payload: { creditType: input.creditType, requested: input.units.toFixed() } });
    throw new AppError('INSUFFICIENT_QUOTA', 'Not enough credits for this request.', 422, { requested: input.units.toFixed(), shortBy: needed.toFixed() });
  }
  for (const a of allocations) {
    await tx.billingCreditGrant.update({ where: { id: a.grantId }, data: { heldUnits: { increment: D(a.units) } } });
    await tx.billingCreditLedgerEntry.create({ data: { accountId: account.id, grantId: a.grantId, eventKey: `${input.operationKey}:reserve:${a.grantId}`, entryType: 'RESERVE', quantity: D(a.units).neg(), relatedRunRef: input.runId } });
  }
  return tx.billingCreditReservation.create({ data: { accountId: account.id, workspaceId: input.workspaceId, runId: input.runId, operationKey: input.operationKey, scenario: input.scenario, allocations, reservedUnits: input.units, expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60000) } });
}
/** Settle exactly once: consume `actual` in allocation order, release the remainder (06 AC02). */
async function settleCreditsInTx(tx: Tx, reservationId: string, actual: Prisma.Decimal) {
  const r = await tx.billingCreditReservation.findUniqueOrThrow({ where: { id: reservationId } });
  if (r.status !== 'RESERVED') return r;
  if (actual.gt(r.reservedUnits)) throw new AppError('BUSINESS_RULE_VIOLATION', 'Actual usage exceeds the reservation; reserve more before running.', 422);
  let toConsume = actual;
  for (const a of r.allocations as Allocation[]) {
    const held = D(a.units), consume = Prisma.Decimal.min(held, toConsume), release = held.sub(consume); toConsume = toConsume.sub(consume);
    await tx.billingCreditGrant.update({ where: { id: a.grantId }, data: { heldUnits: { decrement: held }, remainingUnits: { decrement: consume } } });
    if (consume.gt(0)) await tx.billingCreditLedgerEntry.create({ data: { accountId: r.accountId, grantId: a.grantId, eventKey: `${r.operationKey}:consume:${a.grantId}`, entryType: 'CONSUME', quantity: consume.neg(), relatedRunRef: r.runId } });
    if (release.gt(0)) await tx.billingCreditLedgerEntry.create({ data: { accountId: r.accountId, grantId: a.grantId, eventKey: `${r.operationKey}:release:${a.grantId}`, entryType: 'RELEASE', quantity: release, relatedRunRef: r.runId } });
    await tx.billingCreditGrant.updateMany({ where: { id: a.grantId, remainingUnits: 0, heldUnits: 0 }, data: { status: 'CONSUMED' } });
  }
  const updated = await tx.billingCreditReservation.update({ where: { id: r.id }, data: { status: 'CONSUMED', consumedUnits: actual } });
  await emitEvent(tx, { workspaceId: r.workspaceId, eventType: 'BILLING_CREDITS_CONSUMED', aggregateType: 'BillingCreditReservation', aggregateId: r.id, actorType: 'SERVICE', payload: { units: actual.toFixed(), runId: r.runId } });
  return updated;
}
async function releaseCreditsInTx(tx: Tx, reservationId: string) {
  const r = await tx.billingCreditReservation.findUniqueOrThrow({ where: { id: reservationId } });
  if (r.status !== 'RESERVED') return r;
  for (const a of r.allocations as Allocation[]) {
    await tx.billingCreditGrant.update({ where: { id: a.grantId }, data: { heldUnits: { decrement: D(a.units) } } });
    await tx.billingCreditLedgerEntry.create({ data: { accountId: r.accountId, grantId: a.grantId, eventKey: `${r.operationKey}:release:${a.grantId}`, entryType: 'RELEASE', quantity: D(a.units), relatedRunRef: r.runId } });
  }
  return tx.billingCreditReservation.update({ where: { id: r.id }, data: { status: 'RELEASED', consumedUnits: ZERO } });
}

// ------------------------------------------------------------------ usage meters (05)
async function currentWindow(db: DbClient, workspaceId: string) {
  const sub = await liveSubscription(db, workspaceId);
  if (sub?.currentPeriodStart && sub.currentPeriodEnd && sub.currentPeriodEnd > new Date() && sub.currentPeriodStart <= new Date()) return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
  if (sub?.trialEnd && sub.status === 'TRIALING') return { start: sub.createdAt, end: sub.trialEnd };
  const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}
async function meterFor(tx: Tx, workspaceId: string, code: string) {
  const window = await currentWindow(tx, workspaceId);
  const { values, managed } = await effectiveEntitlements(tx, workspaceId);
  const raw = values[code], limit = CREDIT_METERS[code] || !managed || raw === null || raw === undefined ? null : D(raw as Prisma.Decimal.Value);
  if (managed && raw === undefined && !CREDIT_METERS[code]) throw new AppError('VALIDATION_FAILED', `Unknown usage meter ${code}.`, 400);
  const meter = await tx.billingUsageMeter.upsert({ where: { workspaceId_entitlementCode_windowStart: { workspaceId, entitlementCode: code, windowStart: window.start } },
    create: { workspaceId, entitlementCode: code, windowStart: window.start, windowEnd: window.end, limitValue: limit }, update: { limitValue: limit } });
  // Row lock: spent+reserved+estimate is checked against the cap atomically (05 rule 1).
  await tx.$queryRaw`SELECT id FROM billing_usage_meters WHERE id = ${meter.id}::uuid FOR UPDATE`;
  return tx.billingUsageMeter.findUniqueOrThrow({ where: { id: meter.id } });
}

export type ReserveInput = { workspaceId: string; meterCode: string; units: Prisma.Decimal; operationKey: string; sourceModule: string; scenario?: string; runId?: string };
/** UsageService (shared contract 13): reserve before expensive/provider work, settle actual, release unused. */
export class UsageService {
  static async reserve(tx: Tx, input: ReserveInput) {
    if (input.units.lte(0)) throw new AppError('VALIDATION_FAILED', 'Reservation estimate must be positive.', 400);
    const meter = await meterFor(tx, input.workspaceId, input.meterCode);
    const prior = await tx.billingUsageReservation.findUnique({ where: { workspaceId_meterId_operationKey: { workspaceId: input.workspaceId, meterId: meter.id, operationKey: input.operationKey } } });
    if (prior) { if (!prior.estimate.eq(input.units)) throw new AppError('IDEMPOTENCY_CONFLICT', 'Operation key reused with a different quantity.', 409); return prior; }
    let overageUnits = ZERO, creditReservationId: string | null = null;
    if (CREDIT_METERS[input.meterCode]) {
      creditReservationId = (await reserveCreditsInTx(tx, { workspaceId: input.workspaceId, creditType: CREDIT_METERS[input.meterCode], operationKey: input.operationKey, runId: input.runId ?? input.operationKey, scenario: input.scenario ?? input.sourceModule, units: input.units })).id;
    } else if (meter.limitValue !== null) {
      const after = meter.spent.add(meter.reserved).add(input.units);
      if (after.gt(meter.limitValue)) {
        const policy = await tx.billingOveragePolicy.findUnique({ where: { workspaceId_code: { workspaceId: input.workspaceId, code: input.meterCode } } });
        const over = after.sub(Prisma.Decimal.max(meter.limitValue, meter.spent.add(meter.reserved)));
        if (!policy?.enabled || meter.overage.add(over).gt(policy.hardCap)) {
          await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'BILLING_LIMIT_REACHED', aggregateType: 'BillingUsageMeter', aggregateId: meter.id, actorType: 'SERVICE', payload: { meterCode: input.meterCode, limit: meter.limitValue.toFixed() } });
          throw new AppError('INSUFFICIENT_QUOTA', `${input.meterCode} limit reached for this period.`, 422, { limit: meter.limitValue.toFixed(), spent: meter.spent.toFixed(), reserved: meter.reserved.toFixed() });
        }
        overageUnits = over;
      }
    }
    await tx.billingUsageMeter.update({ where: { id: meter.id }, data: { reserved: { increment: input.units }, overage: { increment: overageUnits }, version: { increment: 1 } } });
    const row = await tx.billingUsageReservation.create({ data: { workspaceId: input.workspaceId, meterId: meter.id, operationKey: input.operationKey, sourceModule: input.sourceModule, estimate: input.units, overageUnits, creditReservationId, expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60000) } });
    await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'BILLING_USAGE_RESERVED', aggregateType: 'BillingUsageReservation', aggregateId: row.id, aggregateVersion: 1, actorType: 'SERVICE', payload: { meterCode: input.meterCode, units: input.units.toFixed() } });
    return row;
  }
  /** Exactly-once settlement keyed by eventKey (05 AC03). */
  static async settle(tx: Tx, reservationId: string, actual: Prisma.Decimal, eventKey: string, sourceRef: string) {
    const r = await tx.billingUsageReservation.findUnique({ where: { id: reservationId } }); if (!r) throw notFound('Reservation');
    const dup = await tx.billingUsageEvent.findUnique({ where: { eventKey } });
    if (dup) return { reservation: r, duplicate: true };
    if (!['RESERVED', 'EXPIRED'].includes(r.status)) throw new AppError('INVALID_STATE_TRANSITION', `Reservation is ${r.status}.`, 409);
    if (actual.lt(0)) throw new AppError('VALIDATION_FAILED', 'Actual usage cannot be negative.', 400);
    await tx.$queryRaw`SELECT id FROM billing_usage_meters WHERE id = ${r.meterId}::uuid FOR UPDATE`;
    if (r.creditReservationId) await settleCreditsInTx(tx, r.creditReservationId, actual);
    else if (actual.gt(r.estimate)) throw new AppError('BUSINESS_RULE_VIOLATION', 'Actual usage exceeds the reservation.', 422);
    const unusedOverage = Prisma.Decimal.min(r.overageUnits, r.estimate.sub(actual));
    await tx.billingUsageMeter.update({ where: { id: r.meterId }, data: { reserved: { decrement: r.estimate }, spent: { increment: actual }, overage: { decrement: Prisma.Decimal.max(ZERO, unusedOverage) }, version: { increment: 1 } } });
    await tx.billingUsageEvent.create({ data: { workspaceId: r.workspaceId, meterId: r.meterId, reservationId: r.id, eventKey, quantity: actual, sourceModule: r.sourceModule, sourceRef } });
    const updated = await tx.billingUsageReservation.update({ where: { id: r.id }, data: { status: 'SETTLED', actual, finishedAt: new Date() } });
    await emitEvent(tx, { workspaceId: r.workspaceId, eventType: 'BILLING_USAGE_SETTLED', aggregateType: 'BillingUsageReservation', aggregateId: r.id, aggregateVersion: 2, actorType: 'SERVICE', payload: { actual: actual.toFixed() } });
    return { reservation: updated, duplicate: false };
  }
  static async release(tx: Tx, reservationId: string, _reason: string) {
    const r = await tx.billingUsageReservation.findUnique({ where: { id: reservationId } }); if (!r) throw notFound('Reservation');
    if (['RELEASED', 'SETTLED'].includes(r.status)) return r;
    await tx.$queryRaw`SELECT id FROM billing_usage_meters WHERE id = ${r.meterId}::uuid FOR UPDATE`;
    if (r.creditReservationId) await releaseCreditsInTx(tx, r.creditReservationId);
    await tx.billingUsageMeter.update({ where: { id: r.meterId }, data: { reserved: { decrement: r.estimate }, overage: { decrement: r.overageUnits }, version: { increment: 1 } } });
    return tx.billingUsageReservation.update({ where: { id: r.id }, data: { status: 'RELEASED', finishedAt: new Date(), actual: ZERO } });
  }
}

/** Completion checks for expired reservations: owning modules report whether the effect happened (05 rule 3). */
type Completion = (db: DbClient, operationKey: string) => Promise<{ state: 'COMPLETED'; actual: Prisma.Decimal } | { state: 'FAILED' | 'NOT_FOUND' | 'UNKNOWN' }>;
const completionChecks = new Map<string, Completion>();
export function registerUsageCompletionCheck(sourceModule: string, check: Completion) { completionChecks.set(sourceModule, check); }

export async function reconcileExpiredReservations(db: PrismaClient, limit = 50) {
  const due = await db.billingUsageReservation.findMany({ where: { status: { in: ['RESERVED', 'EXPIRED'] }, expiresAt: { lt: new Date() } }, take: limit, orderBy: { expiresAt: 'asc' } });
  let settled = 0, released = 0, pending = 0;
  for (const r of due) {
    const check = completionChecks.get(r.sourceModule);
    const outcome = check ? await check(db, r.operationKey).catch(() => ({ state: 'UNKNOWN' as const })) : { state: 'UNKNOWN' as const };
    await db.$transaction(async tx => {
      if (outcome.state === 'COMPLETED') { await UsageService.settle(tx, r.id, Prisma.Decimal.min(outcome.actual, r.estimate), 'reconcile:' + r.id, r.operationKey); settled++; }
      else if (outcome.state === 'FAILED' || outcome.state === 'NOT_FOUND') { await UsageService.release(tx, r.id, 'EXPIRED_UNUSED'); released++; }
      else { await tx.billingUsageReservation.update({ where: { id: r.id }, data: { status: 'EXPIRED', expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60000) } }); pending++; }
    });
  }
  return { settled, released, pending };
}
/** Expires grant balances not held by in-flight reservations; appends EXPIRE entries (never edits history). */
export async function expireCredits(db: PrismaClient, limit = 100) {
  const grants = await db.billingCreditGrant.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, take: limit });
  let expired = 0;
  for (const g of grants) await db.$transaction(async tx => {
    const [row] = await tx.$queryRaw<{ remaining_units: Prisma.Decimal; held_units: Prisma.Decimal }[]>`SELECT remaining_units, held_units FROM billing_credit_grants WHERE id = ${g.id}::uuid FOR UPDATE`;
    const lapse = D(row.remaining_units).sub(row.held_units);
    if (lapse.gt(0)) {
      await tx.billingCreditLedgerEntry.create({ data: { accountId: g.accountId, grantId: g.id, eventKey: `expire:${g.id}:${D(row.remaining_units).toFixed()}`, entryType: 'EXPIRE', quantity: lapse.neg() } });
      await tx.billingCreditGrant.update({ where: { id: g.id }, data: { remainingUnits: { decrement: lapse } } });
      expired++;
    }
    if (D(row.held_units).eq(0)) await tx.billingCreditGrant.update({ where: { id: g.id }, data: { status: 'EXPIRED' } });
    const account = await tx.billingCreditAccount.findUniqueOrThrow({ where: { id: g.accountId } });
    if (lapse.gt(0)) await emitEvent(tx, { workspaceId: account.workspaceId, eventType: 'BILLING_CREDITS_EXPIRED', aggregateType: 'BillingCreditGrant', aggregateId: g.id, actorType: 'SERVICE', payload: { units: lapse.toFixed() } });
  });
  return { expired };
}

// Top-up invoices: credits activate only after the verified payment; a refund posts a compensating REFUND entry.
registerInvoiceEffect('TOPUP', {
  async paid(tx, invoice) {
    const quote = invoice.quoteId ? await tx.billingQuote.findUnique({ where: { id: invoice.quoteId } }) : null;
    const product = quote?.topupProductId ? await tx.billingTopupProduct.findUnique({ where: { id: quote.topupProductId } }) : null;
    if (!product) return;
    await grantCredits(tx, { workspaceId: invoice.workspaceId, creditType: product.creditType, source: 'PURCHASE', sourceRef: 'invoice:' + invoice.id, units: product.units, expiresAt: product.expiresInDays ? new Date(Date.now() + product.expiresInDays * 86400000) : null, reason: 'TOPUP ' + product.code });
  },
  async refunded(tx, invoice, amount, refundId) {
    const account = await tx.billingCreditAccount.findFirst({ where: { workspaceId: invoice.workspaceId } }); if (!account) return;
    const grant = await tx.billingCreditGrant.findUnique({ where: { accountId_sourceRef: { accountId: account.id, sourceRef: 'invoice:' + invoice.id } } }); if (!grant) return;
    const share = invoice.paid.gt(0) ? units(grant.initialUnits.mul(amount).div(invoice.paid)) : ZERO;
    const removable = Prisma.Decimal.min(share, grant.remainingUnits.sub(grant.heldUnits));
    if (removable.lte(0)) return;
    await tx.billingCreditLedgerEntry.create({ data: { accountId: account.id, grantId: grant.id, eventKey: 'refund:' + refundId, entryType: 'REFUND', quantity: removable.neg(), reason: 'Top-up refund' } });
    await tx.billingCreditGrant.update({ where: { id: grant.id }, data: { remainingUnits: { decrement: removable } } });
    await emitEvent(tx, { workspaceId: invoice.workspaceId, eventType: 'BILLING_CREDIT_REVERSAL_POSTED', aggregateType: 'BillingCreditGrant', aggregateId: grant.id, actorType: 'SERVICE', payload: { units: removable.toFixed(), refundId } });
  },
});

/** Usage, overage and credit APIs (31/05, 31/06). */
export class BillingUsageService {
  constructor(private readonly db: PrismaClient) {}
  // internal (service identity)
  async internalReserve(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ workspaceId: z.uuid(), meterCode: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/), units: unitsInput, operationKey: z.string().min(4).max(200), sourceModule: z.string().regex(/^[a-z][a-z0-9_.-]{1,40}$/).default('internal'), scenario: z.string().max(60).optional() }).parse(raw);
    return this.db.$transaction(tx => UsageService.reserve(tx, input));
  }
  async internalSettle(authorization: string | null, reservationId: string, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ actualUnits: unitsInput, eventKey: z.string().min(4).max(200), sourceRef: z.string().max(200).default('') }).parse(raw);
    return this.db.$transaction(tx => UsageService.settle(tx, z.uuid().parse(reservationId), input.actualUnits, input.eventKey, input.sourceRef));
  }
  async internalRelease(authorization: string | null, reservationId: string, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ reason: z.string().max(200) }).parse(raw);
    return this.db.$transaction(tx => UsageService.release(tx, z.uuid().parse(reservationId), input.reason));
  }
  async internalCreditReserve(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ workspaceId: z.uuid(), operationKey: z.string().min(4).max(200), units: unitsInput, scenario: z.string().max(60), runId: z.string().max(200).optional() }).parse(raw);
    return this.db.$transaction(tx => UsageService.reserve(tx, { workspaceId: input.workspaceId, meterCode: 'ai.credits', units: input.units, operationKey: input.operationKey, sourceModule: 'ai', scenario: input.scenario, runId: input.runId }));
  }

  async usage(actor: Principal, raw: unknown) {
    requirePermission(actor, 'workspace.billing.readUsage');
    const q = z.object({ meterCode: z.string().max(60).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(raw);
    const meters = await this.db.billingUsageMeter.findMany({ where: { workspaceId: actor.workspaceId, ...(q.meterCode ? { entitlementCode: q.meterCode } : {}) }, orderBy: { windowStart: 'desc' }, take: 100 });
    return meters.filter(m => !q.period || monthOf(m.windowStart) === q.period).map(m => ({ meterCode: m.entitlementCode, windowStart: m.windowStart, windowEnd: m.windowEnd, limit: m.limitValue?.toFixed() ?? null, spent: m.spent.toFixed(), reserved: m.reserved.toFixed(), overage: m.overage.toFixed() }));
  }
  /** Explicit acceptance of a platform-published overage rate and cap; nothing is charged without it (05 AC05). */
  async acceptOverage(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.overage.manage');
    const input = z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/), acceptedLimit: unitsInput, acceptedPriceVersion: z.string().min(1).max(60), enabled: z.boolean().default(true) }).parse(raw);
    return this.db.$transaction(async tx => {
      const sub = await liveSubscription(tx, actor.workspaceId);
      const account = sub?.billingAccountId ? await tx.billingAccount.findUnique({ where: { id: sub.billingAccountId } }) : null;
      const rate = await tx.billingOverageRate.findFirst({ where: { code: input.code, version: input.acceptedPriceVersion, active: true, ...(account ? { currency: account.billingCurrency } : {}) } });
      if (!rate) throw new AppError('BUSINESS_RULE_VIOLATION', 'No active overage price exists for this code/version.', 422);
      const policy = await tx.billingOveragePolicy.upsert({ where: { workspaceId_code: { workspaceId: actor.workspaceId, code: input.code } },
        create: { workspaceId: actor.workspaceId, code: input.code, enabled: input.enabled, rate: rate.rate, currency: rate.currency, hardCap: input.acceptedLimit, acceptedPriceVersion: rate.version, acceptanceRef: requestId, acceptedBy: actor.userId },
        update: { enabled: input.enabled, rate: rate.rate, currency: rate.currency, hardCap: input.acceptedLimit, acceptedPriceVersion: rate.version, acceptanceRef: requestId, acceptedBy: actor.userId, version: { increment: 1 } } });
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_OVERAGE_ACCEPTED', resourceType: 'BillingOveragePolicy', resourceId: policy.id, after: { code: input.code, cap: input.acceptedLimit.toFixed(), rate: rate.rate.toFixed(), currency: rate.currency, enabled: input.enabled }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'BILLING_OVERAGE_ACCEPTED', aggregateType: 'BillingOveragePolicy', aggregateId: policy.id, aggregateVersion: policy.version, actorId: actor.userId, payload: { code: input.code, enabled: input.enabled } });
      return policy;
    });
  }
  async setOverageRate(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    const input = z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/), version: z.string().min(1).max(60), rate: unitsInput, currency: z.string().regex(/^[A-Z]{3}$/) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.billingOverageRate.create({ data: input });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_OVERAGE_RATE_PUBLISHED', resourceType: 'BillingOverageRate', resourceId: row.id, after: { ...input, rate: input.rate.toFixed() }, requestId });
      return row;
    });
  }

  async balance(actor: Principal) {
    requirePermission(actor, 'billing.credits.read');
    const accounts = await this.db.billingCreditAccount.findMany({ where: { workspaceId: actor.workspaceId } });
    const now = new Date(), soon = new Date(Date.now() + 7 * 86400000);
    const out = [];
    for (const account of accounts) {
      const grants = await this.db.billingCreditGrant.findMany({ where: { accountId: account.id, status: 'ACTIVE' }, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }] });
      const live = grants.filter(g => !g.expiresAt || g.expiresAt > now);
      const sum = (rows: typeof grants, f: (g: (typeof grants)[number]) => Prisma.Decimal) => rows.reduce((s, g) => s.add(f(g)), ZERO).toFixed();
      out.push({ creditType: account.creditType, unit: account.unit, available: sum(live, g => g.remainingUnits.sub(g.heldUnits)), held: sum(live, g => g.heldUnits),
        plan: sum(live.filter(g => g.source === 'PLAN'), g => g.remainingUnits.sub(g.heldUnits)), purchased: sum(live.filter(g => g.source !== 'PLAN'), g => g.remainingUnits.sub(g.heldUnits)),
        expiringSoon: live.filter(g => g.expiresAt && g.expiresAt <= soon).map(g => ({ grantId: g.id, units: g.remainingUnits.sub(g.heldUnits).toFixed(), expiresAt: g.expiresAt })) });
    }
    return out;
  }
  async ledger(actor: Principal, raw: unknown) {
    requirePermission(actor, 'billing.credits.read');
    const q = pageQuery.extend({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).parse(raw);
    const accounts = await this.db.billingCreditAccount.findMany({ where: { workspaceId: actor.workspaceId }, select: { id: true } });
    const where = { accountId: { in: accounts.map(a => a.id) }, ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}) };
    const [rows, total] = await Promise.all([this.db.billingCreditLedgerEntry.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), this.db.billingCreditLedgerEntry.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async topupProducts() { return this.db.billingTopupProduct.findMany({ where: { active: true }, orderBy: { price: 'asc' } }); }
  async createTopupProduct(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    const input = z.strictObject({ code: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/), name: z.string().trim().min(2).max(120), creditType: z.enum(['AI', 'OTHER']).default('AI'), units: unitsInput, price: z.string().regex(/^\d+(\.\d{1,4})?$/), currency: z.string().regex(/^[A-Z]{3}$/), expiresInDays: z.number().int().min(1).max(3650).nullable().default(365) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.billingTopupProduct.create({ data: { ...input, price: D(input.price) } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_TOPUP_PRODUCT_CREATED', resourceType: 'BillingTopupProduct', resourceId: row.id, after: { ...input, units: input.units.toFixed() }, requestId });
      return row;
    });
  }
  async topupQuote(actor: Principal, raw: unknown) {
    requirePermission(actor, 'billing.credits.purchase');
    const input = z.strictObject({ productId: z.uuid(), amount: z.number().int().min(1).max(100).default(1), payerAccountId: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const product = await tx.billingTopupProduct.findFirst({ where: { id: input.productId, active: true } }); if (!product) throw notFound('Top-up product');
      const account = await tx.billingAccount.findFirst({ where: { id: input.payerAccountId, workspaceId: actor.workspaceId, status: 'ACTIVE' } }); if (!account) throw notFound('Billing account');
      if (account.billingCurrency !== product.currency) throw new AppError('BUSINESS_RULE_VIOLATION', 'Payer currency does not match the product price.', 422);
      // Partner discounts reduce the purchase invoice, never the unit count (06 rule 4).
      return createQuote(tx, { workspaceId: actor.workspaceId, kind: 'TOPUP', topupProductId: product.id, payerAccountId: account.id, effectiveAt: new Date(), currency: product.currency, productId: 'topup:' + product.code,
        lines: Array.from({ length: input.amount }, () => ({ kind: 'TOPUP', description: `${product.name} (${product.units.toFixed()} credits)`, quantity: '1', unitPrice: product.price.toFixed(), subtotal: product.price.toFixed() })),
        fingerprint: { product: product.id, version: product.version, price: product.price.toFixed(), amount: input.amount }, createdBy: actor.userId });
    });
  }
  async topupPurchase(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'billing.credits.purchase');
    const input = z.strictObject({ quoteId: z.uuid(), payerAccountId: z.uuid(), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const quote = await tx.billingQuote.findFirst({ where: { id: input.quoteId, workspaceId: actor.workspaceId, kind: 'TOPUP' } }); if (!quote) throw notFound('Quote');
      if (quote.payerAccountId !== input.payerAccountId) throw new AppError('BUSINESS_RULE_VIOLATION', 'Payer differs from the quote.', 422);
      if (quote.status === 'QUOTED' && quote.expiresAt <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Quote expired; request a new quote.', 409);
      const invoice = await issueInvoiceForQuote(tx, quote.id);
      await billingAudit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_TOPUP_REQUESTED', resourceType: 'BillingInvoice', resourceId: invoice.id, after: { quoteId: quote.id }, requestId });
      return { invoiceId: invoice.id, total: invoice.total.toFixed(), currency: invoice.currency, status: invoice.status, next: 'POST /api/v1/billing/payment-attempts' };
    });
  }
  /** Platform Finance only: positive adjustment grant or compensating reversal; consumed rows are never edited (06 AC03). */
  async adjust(actor: PlatformPrincipal, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'billing.credits.adjust'); requireStepUp(actor, mfa);
    const input = z.strictObject({ workspaceId: z.uuid(), kind: z.enum(['GRANT', 'REVERSE']), units: unitsInput, grantId: z.uuid().optional(), reason: z.string().trim().min(5).max(500), expiresAt: z.iso.datetime({ offset: true }).nullable().default(null), approvalId: z.uuid().optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      await consumeApproval(tx, { approvalId: input.approvalId, action: 'CREDIT_ADJUSTMENT', payload: { workspaceId: input.workspaceId, kind: input.kind, units: input.units.toFixed(), grantId: input.grantId ?? null }, requesterId: actor.userId });
      if (input.kind === 'GRANT') {
        const grant = await grantCredits(tx, { workspaceId: input.workspaceId, source: 'ADJUSTMENT', sourceRef: 'adjust:' + requestId, units: input.units, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, reason: input.reason });
        await billingAudit(tx, { workspaceId: input.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_CREDITS_ADJUSTED', resourceType: 'BillingCreditGrant', resourceId: grant?.id ?? null, after: { kind: input.kind, units: input.units.toFixed(), reason: input.reason }, requestId });
        return grant;
      }
      if (!input.grantId) throw new AppError('VALIDATION_FAILED', 'grantId is required for a reversal.', 400);
      const [row] = await tx.$queryRaw<{ account_id: string; remaining_units: Prisma.Decimal; held_units: Prisma.Decimal }[]>`SELECT account_id, remaining_units, held_units FROM billing_credit_grants WHERE id = ${input.grantId}::uuid FOR UPDATE`;
      if (!row) throw notFound('Credit grant');
      const account = await tx.billingCreditAccount.findUniqueOrThrow({ where: { id: row.account_id } });
      if (account.workspaceId !== input.workspaceId) throw notFound('Credit grant');
      if (input.units.gt(D(row.remaining_units).sub(row.held_units))) throw new AppError('BUSINESS_RULE_VIOLATION', 'Reversal exceeds the available grant balance.', 422);
      await tx.billingCreditLedgerEntry.create({ data: { accountId: account.id, grantId: input.grantId, eventKey: 'reverse:' + requestId, entryType: 'REVERSE', quantity: input.units.neg(), reason: input.reason } });
      await tx.billingCreditGrant.update({ where: { id: input.grantId }, data: { remainingUnits: { decrement: input.units } } });
      await billingAudit(tx, { workspaceId: input.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_CREDIT_REVERSAL_POSTED', resourceType: 'BillingCreditGrant', resourceId: input.grantId, after: { units: input.units.toFixed(), reason: input.reason }, requestId });
      await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'BILLING_CREDIT_REVERSAL_POSTED', aggregateType: 'BillingCreditGrant', aggregateId: input.grantId, actorId: actor.userId, actorType: 'PLATFORM', payload: { units: input.units.toFixed() } });
      return { reversed: input.units.toFixed() };
    });
  }
}

registerJob({ type: 'billing.usage.maintenance', ownerModule: 'billing', maxAttempts: 3, async run() {
  const { prisma } = await import('../prisma-client');
  return { reservations: await reconcileExpiredReservations(prisma), credits: await expireCredits(prisma) };
} });
registerSchedule({ name: 'billing.usage.maintenance', ownerModule: 'billing', jobType: 'billing.usage.maintenance', intervalMinutes: 5 });
