import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import type { Principal } from '../process-platform/context';
import { emitEvent, notFound, requirePlatform, type PlatformPrincipal } from '../platform/kernel';
import { assertServiceIdentity, billingAudit, checkEntitlement, currency, effectiveEntitlements, ensureDefinitions, money, recomputeEntitlements, validateEntitlementValue } from './support';

const code = z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/);
const priceInput = z.strictObject({ currency, amount: z.union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().nonnegative()]), period: z.enum(['MONTHLY', 'YEARLY']),
  effectiveAt: z.iso.datetime({ offset: true }).optional(), providerPriceRef: z.string().max(200).optional() });

/** Plan catalog, immutable versions and entitlement resolution (31/01). */
export class BillingCatalogService {
  constructor(private readonly db: PrismaClient) {}

  async definitions(actor: PlatformPrincipal) { requirePlatform(actor, 'billing.plan.manage'); await ensureDefinitions(this.db); return this.db.billingEntitlementDefinition.findMany({ orderBy: { code: 'asc' } }); }
  async createDefinition(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    const input = z.strictObject({ code, valueType: z.enum(['BOOLEAN', 'INTEGER', 'DECIMAL', 'SET']), defaultValue: z.unknown(), quotaKind: z.enum(['NONE', 'COUNT', 'USAGE', 'CREDIT']).default('NONE'),
      minValue: z.number().nonnegative().optional(), maxValue: z.number().nonnegative().optional(), description: z.string().max(300).default('') }).parse(raw);
    validateEntitlementValue({ code: input.code, valueType: input.valueType, minValue: null, maxValue: null }, input.defaultValue);
    return this.db.$transaction(async tx => {
      const row = await tx.billingEntitlementDefinition.create({ data: { ...input, defaultValue: input.defaultValue as Prisma.InputJsonValue } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_ENTITLEMENT_DEFINITION_CREATED', resourceType: 'BillingEntitlementDefinition', resourceId: row.id, after: input, requestId });
      return row;
    });
  }
  async plans(actor: PlatformPrincipal) {
    requirePlatform(actor, 'billing.plan.manage');
    const plans = await this.db.billingPlan.findMany({ orderBy: { code: 'asc' } });
    const versions = await this.db.billingPlanVersion.findMany({ where: { planId: { in: plans.map(p => p.id) } }, orderBy: { version: 'desc' } });
    return plans.map(p => ({ ...p, versions: versions.filter(v => v.planId === p.id) }));
  }
  async createPlan(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    const input = z.strictObject({ code, name: z.string().trim().min(2).max(120) }).parse(raw);
    return this.db.$transaction(async tx => {
      const plan = await tx.billingPlan.create({ data: { ...input, createdBy: actor.userId } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_PLAN_CREATED', resourceType: 'BillingPlan', resourceId: plan.id, after: input, requestId });
      return plan;
    });
  }
  async retirePlan(actor: PlatformPrincipal, planId: string, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    return this.db.$transaction(async tx => {
      const plan = await tx.billingPlan.findUnique({ where: { id: z.uuid().parse(planId) } }); if (!plan) throw notFound('Plan');
      await tx.billingPlan.update({ where: { id: plan.id }, data: { status: 'RETIRED' } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_PLAN_RETIRED', resourceType: 'BillingPlan', resourceId: plan.id, requestId });
      return { id: plan.id, status: 'RETIRED', note: 'Existing subscriptions stay pinned to their activated version.' };
    });
  }
  /** Draft version with entitlement values and prices; published versions are never edited (new version instead). */
  async createVersion(actor: PlatformPrincipal, planId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    const input = z.strictObject({ entitlements: z.record(z.string(), z.unknown()), prices: z.array(priceInput).min(0).max(20), trialDays: z.number().int().min(0).max(90).optional(), sellable: z.boolean().default(true) }).parse(raw);
    return this.db.$transaction(async tx => {
      await ensureDefinitions(tx);
      const plan = await tx.billingPlan.findUnique({ where: { id: z.uuid().parse(planId) } }); if (!plan) throw notFound('Plan');
      if (plan.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Plan is retired.', 409);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-plan:' + plan.id}))`;
      const defs = await tx.billingEntitlementDefinition.findMany({ where: { code: { in: Object.keys(input.entitlements) } } });
      const unknown = Object.keys(input.entitlements).filter(k => !defs.some(d => d.code === k));
      if (unknown.length) throw new AppError('VALIDATION_FAILED', 'Unknown entitlement keys.', 400, { fields: unknown.map(field => ({ field, reason: 'UNKNOWN_ENTITLEMENT' })) });
      for (const d of defs) validateEntitlementValue(d, input.entitlements[d.code]);
      const last = await tx.billingPlanVersion.findFirst({ where: { planId: plan.id }, orderBy: { version: 'desc' } });
      const version = await tx.billingPlanVersion.create({ data: { planId: plan.id, version: (last?.version ?? 0) + 1, trialDays: input.trialDays ?? null, sellable: input.sellable, createdBy: actor.userId } });
      for (const d of defs) await tx.billingPlanEntitlement.create({ data: { versionId: version.id, definitionId: d.id, value: input.entitlements[d.code] as Prisma.InputJsonValue } });
      for (const p of input.prices) await tx.billingPrice.create({ data: { planVersionId: version.id, currency: p.currency, amount: money(p.amount, p.currency), period: p.period, effectiveAt: p.effectiveAt ? new Date(p.effectiveAt) : new Date(), providerPriceRef: p.providerPriceRef ?? null } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_PLAN_VERSION_CREATED', resourceType: 'BillingPlanVersion', resourceId: version.id, after: { plan: plan.code, version: version.version, entitlements: input.entitlements, prices: input.prices }, requestId });
      return this.versionDetail(tx, version.id);
    });
  }
  async publishVersion(actor: PlatformPrincipal, versionId: string, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    return this.db.$transaction(async tx => {
      const version = await tx.billingPlanVersion.findUnique({ where: { id: z.uuid().parse(versionId) } }); if (!version) throw notFound('Plan version');
      if (version.status !== 'DRAFT') throw new AppError('INVALID_STATE_TRANSITION', `Plan version is ${version.status}.`, 409);
      if (version.sellable && !await tx.billingPrice.count({ where: { planVersionId: version.id } })) throw new AppError('BUSINESS_RULE_VIOLATION', 'A sellable plan version needs at least one price.', 422);
      const updated = await tx.billingPlanVersion.update({ where: { id: version.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_PLAN_VERSION_PUBLISHED', resourceType: 'BillingPlanVersion', resourceId: version.id, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'BILLING_PLAN_VERSION_PUBLISHED', aggregateType: 'BillingPlanVersion', aggregateId: version.id, aggregateVersion: version.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { planId: version.planId } });
      return updated;
    });
  }
  async retireVersion(actor: PlatformPrincipal, versionId: string, requestId: string) {
    requirePlatform(actor, 'billing.plan.manage');
    return this.db.$transaction(async tx => {
      const version = await tx.billingPlanVersion.findUnique({ where: { id: z.uuid().parse(versionId) } }); if (!version) throw notFound('Plan version');
      if (version.status !== 'PUBLISHED') throw new AppError('INVALID_STATE_TRANSITION', `Plan version is ${version.status}.`, 409);
      await tx.billingPlanVersion.update({ where: { id: version.id }, data: { status: 'RETIRED', retiredAt: new Date() } });
      await billingAudit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_PLAN_VERSION_RETIRED', resourceType: 'BillingPlanVersion', resourceId: version.id, requestId });
      return { id: version.id, status: 'RETIRED' };
    });
  }
  private async versionDetail(db: Prisma.TransactionClient | PrismaClient, versionId: string) {
    const version = await db.billingPlanVersion.findUniqueOrThrow({ where: { id: versionId } });
    const [plan, ents, prices] = await Promise.all([db.billingPlan.findUniqueOrThrow({ where: { id: version.planId } }), db.billingPlanEntitlement.findMany({ where: { versionId } }), db.billingPrice.findMany({ where: { planVersionId: versionId }, orderBy: { effectiveAt: 'desc' } })]);
    const defs = await db.billingEntitlementDefinition.findMany({ where: { id: { in: ents.map(e => e.definitionId) } } });
    return { ...version, plan: { id: plan.id, code: plan.code, name: plan.name }, entitlements: Object.fromEntries(ents.map(e => [defs.find(d => d.id === e.definitionId)?.code, e.value])), prices };
  }
  /** Sellable catalog for customers: published, sellable versions with the currently effective price per currency/period. */
  async catalog(raw: unknown) {
    const q = z.object({ currency: currency.optional(), period: z.enum(['MONTHLY', 'YEARLY']).optional() }).parse(raw);
    const versions = await this.db.billingPlanVersion.findMany({ where: { status: 'PUBLISHED', sellable: true } });
    const plans = await this.db.billingPlan.findMany({ where: { id: { in: versions.map(v => v.planId) }, status: 'ACTIVE' } });
    const out = [];
    for (const v of versions) {
      const plan = plans.find(p => p.id === v.planId); if (!plan) continue;
      // Latest version per plan only.
      if (versions.some(o => o.planId === v.planId && o.version > v.version)) continue;
      const detail = await this.versionDetail(this.db, v.id);
      const now = new Date();
      const prices = detail.prices.filter(p => p.effectiveAt <= now && (!q.currency || p.currency === q.currency) && (!q.period || p.period === q.period))
        .filter((p, i, all) => all.findIndex(o => o.currency === p.currency && o.period === p.period) === i);
      if (prices.length) out.push({ planVersionId: v.id, plan: detail.plan, version: v.version, trialDays: v.trialDays, entitlements: detail.entitlements, prices: prices.map(p => ({ id: p.id, currency: p.currency, amount: p.amount.toFixed(), period: p.period })) });
    }
    return out;
  }
  /** Workspace view: effective values only, never hidden global override reasons/approvals. */
  async workspaceEntitlements(actor: Principal) {
    const current = await effectiveEntitlements(this.db, actor.workspaceId);
    const overrides = await this.db.billingEntitlementOverride.count({ where: { workspaceId: actor.workspaceId, revokedAt: null, expiresAt: { gt: new Date() } } });
    return { managed: current.managed, version: current.version, values: current.values, adjusted: overrides > 0 };
  }
  async entitlementHistory(actor: Principal, raw: unknown) {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(raw);
    return this.db.billingEntitlementHistory.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { occurredAt: 'desc' }, take: q.limit, select: { version: true, values: true, cause: true, occurredAt: true } });
  }
  /** POST /internal/billing/entitlements/check — service identity only; workspace comes from the trusted caller. */
  async internalCheck(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ workspaceId: z.uuid(), feature: code, requestedUnits: z.number().int().min(0).max(1000000).optional() }).parse(raw);
    return checkEntitlement(this.db, input.workspaceId, input.feature, input.requestedUnits ?? 0);
  }
  async recompute(actor: PlatformPrincipal, workspaceId: string, requestId: string) {
    requirePlatform(actor, 'platform.billing.manage');
    return this.db.$transaction(async tx => {
      const values = await recomputeEntitlements(tx, z.uuid().parse(workspaceId), 'ADMIN_RECOMPUTE');
      await billingAudit(tx, { workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BILLING_ENTITLEMENTS_RECOMPUTED', resourceType: 'BillingEffectiveEntitlement', resourceId: workspaceId, requestId });
      return values;
    });
  }
}
