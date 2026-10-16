import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { enqueueJob, registerJob, registerSchedule } from '../platform/events-service';
import { assertVersion, audit, emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, type PlatformPrincipal, type UserPrincipal } from '../platform/kernel';
import { decrypt, encrypt } from '../suite/kernel';
import { ZERO } from '../billing/support';
import { invalidatePartnerAccess, partnerActor, scopedWorkspaceIds, sha, type Tx } from './support';

const reason = z.string().trim().min(1).max(1000);
const EXPORT_TTL_HOURS = 24;
async function lifecycle(tx: Tx, partnerId: string, operation: string, why: string, actorId: string, eventType: string, approvalRef: string | null = null) {
  await tx.partnerLifecycleCase.create({ data: { partnerId, operation, reason: why, actorId, approvalRef } });
  await audit(tx, { workspaceId: null, partnerId, actorId, actorType: 'PLATFORM', action: eventType, resourceType: 'Partner', resourceId: partnerId, after: { operation, reason: why } });
  await emitEvent(tx, { workspaceId: null, eventType, aggregateType: 'Partner', aggregateId: partnerId, actorId, actorType: 'PLATFORM', payload: { partnerId, operation } });
}

/** Partner report export job: re-authorizes the requester when generating and at download (32/10 AC03). */
registerJob({ type: 'partner.report.export', ownerModule: 'partner', maxAttempts: 3, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const job = await prisma.partnerReportExport.findUnique({ where: { id: String(ctx.payload.exportId) } });
  if (!job || job.status !== 'QUEUED') return { skipped: true };
  await prisma.partnerReportExport.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
  try {
    const actor = await partnerActor(prisma, job.requesterId, job.partnerId, 'partner.report.export', { allowSuspended: true });
    const { period } = job.request as { period: string };
    const data = await new PartnerGovernanceService(prisma).metrics(actor.partnerId, period, await scopedWorkspaceIds(prisma, actor, 'partner.dashboard.readOwn'));
    await prisma.partnerReportExport.update({ where: { id: job.id }, data: { status: 'READY', outputSealed: encrypt(JSON.stringify(data)) } });
  } catch (error) {
    await prisma.partnerReportExport.update({ where: { id: job.id }, data: { status: 'FAILED' } });
    if (!(error instanceof AppError)) throw error;
  }
  return { done: true };
} });

/** Suspension/deletion/governance (32/09) and dashboard/admin search/exports (32/10). */
export class PartnerGovernanceService {
  constructor(private readonly db: PrismaClient) {}

  /** Suspension blocks provisioning, referrals, future discounts and delegated access immediately (09 AC01); customer Workspaces are untouched. */
  async suspend(actor: PlatformPrincipal, partnerId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.lifecycle.manage');
    const input = z.strictObject({ reason, expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const p = await tx.partner.findFirst({ where: { id: z.uuid().parse(partnerId), isDeleted: false } }); if (!p) throw notFound('Partner');
      assertVersion(p.version, input.expectedVersion);
      if (p.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', `Partner is ${p.status}.`, 409);
      const updated = await tx.partner.update({ where: { id: p.id }, data: { status: 'SUSPENDED', version: { increment: 1 } } });
      await tx.partnerReferralLink.updateMany({ where: { partnerId: p.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await invalidatePartnerAccess(tx, p.id, 'SUSPENDED');
      await lifecycle(tx, p.id, 'SUSPEND', input.reason, actor.userId, 'PARTNER.SUSPENDED');
      return updated;
    });
  }
  /** Reactivation never silently restores revoked/expired customer delegations (09 AC04). */
  async reactivate(actor: PlatformPrincipal, partnerId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.lifecycle.manage');
    const input = z.strictObject({ reason }).parse(raw);
    return this.db.$transaction(async tx => {
      const p = await tx.partner.findFirst({ where: { id: z.uuid().parse(partnerId), isDeleted: false } }); if (!p) throw notFound('Partner');
      if (p.status !== 'SUSPENDED') throw new AppError('INVALID_STATE_TRANSITION', `Partner is ${p.status}.`, 409);
      if (await tx.partnerMembership.findFirst({ where: { partnerId: p.id, userId: actor.userId, isDeleted: false } })) throw new AppError('PERMISSION_DENIED', 'Partner members cannot reactivate their own organization.', 403);
      const updated = await tx.partner.update({ where: { id: p.id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
      await invalidatePartnerAccess(tx, p.id, 'REACTIVATED');
      await lifecycle(tx, p.id, 'REACTIVATE', input.reason, actor.userId, 'PARTNER.REACTIVATED');
      return updated;
    });
  }
  /** Soft delete hides the Partner but keeps relations/invoice snapshots and payout obligations (09 AC03). */
  async softDelete(actor: PlatformPrincipal, partnerId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.lifecycle.manage');
    const input = z.strictObject({ reason: reason.default('Soft delete') }).parse(raw ?? {});
    return this.db.$transaction(async tx => {
      const p = await tx.partner.findFirst({ where: { id: z.uuid().parse(partnerId), isDeleted: false } }); if (!p) throw notFound('Partner');
      const updated = await tx.partner.update({ where: { id: p.id }, data: { isDeleted: true, deletedAt: new Date(), version: { increment: 1 } } });
      await tx.partnerWorkspaceAccess.updateMany({ where: { partnerId: p.id, status: { in: ['ACTIVE', 'REQUESTED'] } }, data: { status: 'REVOKED', revokedAt: new Date(), version: { increment: 1 } } });
      await tx.partnerReferralLink.updateMany({ where: { partnerId: p.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await invalidatePartnerAccess(tx, p.id, 'SOFT_DELETED');
      await lifecycle(tx, p.id, 'SOFT_DELETE', input.reason, actor.userId, 'PARTNER.SOFT_DELETED');
      return { id: updated.id, deleted: true };
    });
  }
  async restore(actor: PlatformPrincipal, partnerId: string, requestId: string) {
    requirePlatform(actor, 'platform.partner.lifecycle.manage');
    return this.db.$transaction(async tx => {
      const p = await tx.partner.findFirst({ where: { id: z.uuid().parse(partnerId), isDeleted: true, purgedAt: null } }); if (!p) throw notFound('Partner');
      const updated = await tx.partner.update({ where: { id: p.id }, data: { isDeleted: false, deletedAt: null, version: { increment: 1 } } });
      await lifecycle(tx, p.id, 'RESTORE', 'Restored', actor.userId, 'PARTNER.RESTORED');
      return updated;
    });
  }
  /**
   * Irreversible purge = anonymization of the organization's identifying fields; financial history keeps its Partner id.
   * Blocked by legal holds and by outstanding payable obligations (09 AC05).
   */
  async purge(actor: PlatformPrincipal, partnerId: string, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.partner.lifecycle.manage'); requireStepUp(actor, mfa);
    const input = z.strictObject({ legalBasis: z.string().trim().min(5).max(500), approvalRef: z.string().trim().min(3).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const p = await tx.partner.findFirst({ where: { id: z.uuid().parse(partnerId), isDeleted: true, purgedAt: null } });
      if (!p) throw new AppError('INVALID_STATE_TRANSITION', 'Only a soft-deleted Partner can be purged.', 409);
      const refs = await tx.partnerRetentionRef.findMany({ where: { partnerId: p.id, legalHoldId: { not: null } } });
      const holds = refs.length ? await tx.suiteLegalHold.count({ where: { id: { in: refs.map(r => r.legalHoldId!) }, releasedAt: null } }) : 0;
      if (holds) throw new AppError('LEGAL_HOLD_ACTIVE', 'A legal hold prevents purging this Partner.', 409);
      const open = await tx.partnerCommission.findMany({ where: { partnerId: p.id, status: { in: ['ELIGIBLE', 'HELD', 'APPROVED'] } } });
      if (open.some(c => c.commissionAmount.sub(c.reversedAmount).sub(c.paidAmount).gt(0)) || await tx.partnerPayoutBatch.count({ where: { partnerId: p.id, status: { in: ['SUBMITTED', 'APPROVED', 'PROCESSING'] } } }))
        throw new AppError('BUSINESS_RULE_VIOLATION', 'Outstanding commissions or payouts must be settled before purge.', 422);
      await tx.partner.update({ where: { id: p.id }, data: { name: 'Purged partner ' + p.id.slice(0, 8), website: null, businessDescription: null, settings: {}, meta: Prisma.DbNull, purgedAt: new Date(), version: { increment: 1 } } });
      await tx.partnerMembership.updateMany({ where: { partnerId: p.id }, data: { isDeleted: true, status: 'SUSPENDED' } });
      await tx.partnerInvitation.updateMany({ where: { partnerId: p.id, status: 'PENDING' }, data: { status: 'REVOKED' } });
      await lifecycle(tx, p.id, 'PURGE', input.legalBasis, actor.userId, 'PARTNER.HARD_DELETED', input.approvalRef);
      return { id: p.id, purged: true };
    });
  }
  async lifecycleHistory(actor: PlatformPrincipal, partnerId: string) {
    requirePlatform(actor, 'platform.partner.lifecycle.manage');
    return this.db.partnerLifecycleCase.findMany({ where: { partnerId: z.uuid().parse(partnerId) }, orderBy: { occurredAt: 'desc' } });
  }

  // ------------------------------------------------------------------ 10 dashboard, search, exports
  /** Metrics come from Billing/commission ledgers only, never an editable dashboard store (10 rule 4). */
  async metrics(partnerId: string, period: string, scope: string[] | null) {
    const from = new Date(period + '-01T00:00:00Z'), to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
    const wsFilter = scope ? { workspaceId: { in: scope } } : {};
    const [relations, txns, snapshots, commissions, payouts] = await Promise.all([
      this.db.partnerWorkspaceRelation.count({ where: { partnerId, startedAt: { gte: from, lt: to }, ...wsFilter } }),
      this.db.billingPartnerTransaction.groupBy({ by: ['currency'], where: { partnerId, createdAt: { gte: from, lt: to }, ...wsFilter }, _sum: { amount: true }, _count: true }),
      this.db.billingPartnerPriceSnapshot.groupBy({ by: ['currency'], where: { partnerId, calculatedAt: { gte: from, lt: to } }, _sum: { discountAmount: true } }),
      this.db.partnerCommission.groupBy({ by: ['currency'], where: { partnerId, createdAt: { gte: from, lt: to }, ...wsFilter }, _sum: { commissionAmount: true, reversedAmount: true } }),
      this.db.partnerPayoutBatch.groupBy({ by: ['currency'], where: { partnerId, status: 'PAID', paidAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    ]);
    const currencies = [...new Set([...txns.map(t => t.currency), ...commissions.map(c => c.currency), ...payouts.map(p => p.currency)])];
    return { period, workspacesLinked: relations, byCurrency: currencies.map(c => ({ currency: c,
      eligibleRevenue: (txns.find(t => t.currency === c)?._sum.amount ?? ZERO).toFixed(), transactions: txns.find(t => t.currency === c)?._count ?? 0,
      discounts: scope ? null : (snapshots.find(s => s.currency === c)?._sum.discountAmount ?? ZERO).toFixed(),
      commissionAccrued: (commissions.find(x => x.currency === c)?._sum.commissionAmount ?? ZERO).toFixed(), commissionReversed: (commissions.find(x => x.currency === c)?._sum.reversedAmount ?? ZERO).toFixed(),
      payouts: (payouts.find(p => p.currency === c)?._sum.amount ?? ZERO).toFixed() })) };
  }
  async dashboard(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.dashboard.readOwn', { allowSuspended: true });
    const q = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).default(new Date().toISOString().slice(0, 7)), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).parse(raw);
    const data = await this.metrics(actor.partnerId, q.period, await scopedWorkspaceIds(this.db, actor, 'partner.dashboard.readOwn'));
    return { ...data, byCurrency: q.currency ? data.byCurrency.filter(c => c.currency === q.currency) : data.byCurrency };
  }
  async savePreferences(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.dashboard.readOwn', { allowSuspended: true });
    const input = z.strictObject({ savedFilters: z.record(z.string().regex(/^[a-zA-Z]{1,40}$/), z.union([z.string().max(200), z.number(), z.boolean()])), visibility: z.enum(['PRIVATE', 'PARTNER']).default('PRIVATE') }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.partnerDashboardPreference.upsert({ where: { partnerId_userId: { partnerId: actor.partnerId, userId: user.userId } }, create: { partnerId: actor.partnerId, userId: user.userId, ...input }, update: input });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER_DASHBOARD_FILTER_CHANGED', aggregateType: 'Partner', aggregateId: actor.partnerId, actorId: user.userId, payload: {} });
      return row;
    });
  }
  async requestExport(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.report.export', { allowSuspended: true });
    const input = z.strictObject({ period: z.string().regex(/^\d{4}-\d{2}$/), fields: z.array(z.enum(['eligibleRevenue', 'discounts', 'commissionAccrued', 'commissionReversed', 'payouts', 'workspacesLinked'])).min(1).default(['eligibleRevenue']) }).parse(raw);
    return this.db.$transaction(async tx => {
      const job = await tx.partnerReportExport.create({ data: { partnerId: actor.partnerId, requesterId: user.userId, scopeHash: sha(JSON.stringify([...actor.grants.entries()].sort())), request: input, expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3600000) } });
      await enqueueJob(tx, { type: 'partner.report.export', ownerModule: 'partner', payload: { exportId: job.id }, idempotencyKey: 'partner-export:' + job.id });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER_REPORT_EXPORTED', resourceType: 'PartnerReportExport', resourceId: job.id, after: input, requestId });
      return { jobId: job.id, status: job.status };
    });
  }
  /** Download re-authorizes the requester's current membership/permission; expired or revoked access fails (10 AC03). */
  async download(user: UserPrincipal, partnerId: string, jobId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.report.export', { allowSuspended: true });
    const job = await this.db.partnerReportExport.findFirst({ where: { id: z.uuid().parse(jobId), partnerId: actor.partnerId, requesterId: user.userId } }); if (!job) throw notFound('Export');
    if (job.expiresAt <= new Date()) { await this.db.partnerReportExport.update({ where: { id: job.id }, data: { status: 'EXPIRED', outputSealed: null } }); throw new AppError('INVALID_STATE_TRANSITION', 'Export expired.', 409); }
    if (job.status !== 'READY' || !job.outputSealed) return { status: job.status };
    const data = JSON.parse(decrypt(job.outputSealed)!), fields = (job.request as { fields: string[] }).fields;
    return { status: 'READY', period: data.period, rows: (data.byCurrency as Record<string, unknown>[]).map(r => Object.fromEntries([['currency', r.currency], ...fields.map(f => [f, f === 'workspacesLinked' ? data.workspacesLinked : r[f]])])) };
  }
  /** Platform overview: allowlisted filters/sorts only (10 AC05); no customer operational data. */
  async platformPartners(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.partner.query');
    const q = pageQuery.extend({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(), isDeleted: z.enum(['true', 'false']).optional(),
      sortBy: z.enum(['name', 'country', 'createdAt', 'status']).default('createdAt'), sortDir: z.enum(['asc', 'desc']).default('desc') }).strict().parse(raw);
    const where: Prisma.PartnerWhereInput = { purgedAt: null, isDeleted: q.isDeleted === 'true', ...(q.status ? { status: q.status } : {}), ...(q.country ? { country: q.country } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { website: { contains: q.search, mode: 'insensitive' } }, { country: { equals: q.search.toUpperCase() } }] } : {}) };
    const [rows, total] = await Promise.all([this.db.partner.findMany({ where, orderBy: [{ [q.sortBy]: q.sortDir }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit,
      select: { id: true, name: true, country: true, website: true, status: true, isDeleted: true, defaultDiscountBasisPoints: true, createdAt: true, version: true } }), this.db.partner.count({ where })]);
    const counts = await this.db.partnerWorkspaceRelation.groupBy({ by: ['partnerId'], where: { partnerId: { in: rows.map(r => r.id) }, status: 'ACTIVE' }, _count: true });
    return paged(rows.map(r => ({ ...r, activeCustomers: counts.find(c => c.partnerId === r.id)?._count ?? 0 })), total, q.page, q.limit);
  }
  static async expireExports(db: PrismaClient) {
    const r = await db.partnerReportExport.updateMany({ where: { expiresAt: { lte: new Date() }, status: { in: ['READY', 'QUEUED', 'RUNNING'] } }, data: { status: 'EXPIRED', outputSealed: null } });
    return { expired: r.count };
  }
}

registerJob({ type: 'partner.maintenance', ownerModule: 'partner', maxAttempts: 3, async run() {
  const { prisma } = await import('../prisma-client');
  const { PartnerAccessService } = await import('./access-service');
  return { access: await PartnerAccessService.expireDue(prisma), exports: await PartnerGovernanceService.expireExports(prisma) };
} });
registerSchedule({ name: 'partner.maintenance', ownerModule: 'partner', jobType: 'partner.maintenance', intervalMinutes: 10 });
