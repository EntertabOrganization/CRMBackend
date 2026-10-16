import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { runStateUnit } from '../response';
import { registerPartnerDiscountResolver, registerPartnerRelationLookup } from '../billing/partner-billing';
import { assertServiceIdentity } from '../billing/support';
import { assertVersion, audit, emitEvent, notFound, pageQuery, paged, requirePlatform, type DbClient, type PlatformPrincipal, type UserPrincipal } from '../platform/kernel';
import { isActivePartner, partnerActor, scopedWorkspaceIds, sha, type Tx } from './support';

const MAX_WINDOW_DAYS = () => Number(process.env.PARTNER_MAX_ATTRIBUTION_DAYS ?? 90);
const relationEvent = (tx: Tx, workspaceId: string, relationId: string, eventType: string, payload: Record<string, unknown>, actorId: string | null) =>
  emitEvent(tx, { workspaceId, eventType, aggregateType: 'PartnerWorkspaceRelation', aggregateId: relationId, actorId, payload });

// ------------------------------------------------------------------ 03 discount resolution (authoritative for Billing)
type Rule = Prisma.PartnerDiscountRuleGetPayload<object>;
/** exact product > most specific category (caller's category order: most specific first) > default; ties by priorityVersion desc then id. */
export async function resolveDiscount(db: DbClient, input: { partnerId: string; productId: string; categoryIds: string[]; at: Date }) {
  const partner = await db.partner.findUnique({ where: { id: input.partnerId } });
  if (!partner || !isActivePartner(partner)) return { basisPoints: 0, ruleVersion: 0, ruleId: null };
  const rules = await db.partnerDiscountRule.findMany({ where: { partnerId: input.partnerId, status: 'ACTIVE', validFrom: { lte: input.at }, OR: [{ validUntil: null }, { validUntil: { gt: input.at } }] } });
  const pick = (candidates: Rule[]) => candidates.sort((a, b) => b.priorityVersion - a.priorityVersion || a.id.localeCompare(b.id))[0];
  const product = pick(rules.filter(r => r.targetType === 'PRODUCT' && r.targetId === input.productId));
  let chosen = product;
  if (!chosen) for (const category of input.categoryIds) { chosen = pick(rules.filter(r => r.targetType === 'CATEGORY' && r.targetId === category)); if (chosen) break; }
  chosen ??= pick(rules.filter(r => r.targetType === 'DEFAULT'));
  const version = await db.partnerDiscountVersion.findFirst({ where: { partnerId: input.partnerId }, orderBy: { version: 'desc' } });
  // Expired/absent overrides fall back to the Partner default (03 AC04).
  return chosen ? { basisPoints: chosen.basisPoints, ruleVersion: version?.version ?? chosen.priorityVersion, ruleId: chosen.id } : { basisPoints: partner.defaultDiscountBasisPoints, ruleVersion: version?.version ?? 0, ruleId: null };
}
registerPartnerDiscountResolver((db, input) => resolveDiscount(db, input));
registerPartnerRelationLookup(async (db, workspaceId) => {
  const rows = await db.partnerWorkspaceRelation.findMany({ where: { workspaceId, status: 'ACTIVE', isDeleted: false }, include: { partner: true }, take: 2 });
  if (rows.length > 1) throw new AppError('BUSINESS_RULE_VIOLATION', 'Workspace has more than one active Partner relation.', 422);
  const r = rows[0];
  // Suspended Partners stop discounting future quotes (09 rule 1).
  return r && isActivePartner(r.partner) ? { relationId: r.id, partnerId: r.partnerId } : null;
});

async function snapshotRules(tx: Tx, partnerId: string, actorId: string, action: string, oldHash: string | null) {
  const rules = await tx.partnerDiscountRule.findMany({ where: { partnerId, status: { in: ['ACTIVE', 'DRAFT'] } }, orderBy: { id: 'asc' } });
  const partner = await tx.partner.findUniqueOrThrow({ where: { id: partnerId } });
  const snapshot = { default: partner.defaultDiscountBasisPoints, rules: rules.map(r => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, basisPoints: r.basisPoints, priorityVersion: r.priorityVersion, validFrom: r.validFrom, validUntil: r.validUntil, status: r.status })) };
  const last = await tx.partnerDiscountVersion.findFirst({ where: { partnerId }, orderBy: { version: 'desc' } });
  await tx.partnerDiscountVersion.create({ data: { partnerId, version: (last?.version ?? 0) + 1, rulesSnapshot: snapshot as Prisma.InputJsonValue } });
  await tx.partnerPriceAudit.create({ data: { partnerId, action, oldRuleHash: oldHash, newRuleHash: sha(JSON.stringify(snapshot)), actorId } });
  await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.DISCOUNT_UPDATED', aggregateType: 'Partner', aggregateId: partnerId, actorId, actorType: 'PLATFORM', payload: { version: (last?.version ?? 0) + 1 } });
}

/** Discounts (32/03), customer workspace provisioning/relations (32/04), referrals and transfers (32/06). */
export class PartnerCommercialService {
  constructor(private readonly db: PrismaClient) {}

  async discounts(user: UserPrincipal, partnerId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.discount.readOwn', { allowSuspended: true });
    const partner = await this.db.partner.findUniqueOrThrow({ where: { id: actor.partnerId } });
    const rules = await this.db.partnerDiscountRule.findMany({ where: { partnerId: actor.partnerId, status: 'ACTIVE' }, orderBy: [{ targetType: 'asc' }, { priorityVersion: 'desc' }] });
    return { defaultBasisPoints: partner.defaultDiscountBasisPoints, rules: rules.map(r => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, basisPoints: r.basisPoints, validFrom: r.validFrom, validUntil: r.validUntil })) };
  }
  async createRule(actor: PlatformPrincipal, partnerId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.discount.manage');
    const input = z.strictObject({ targetType: z.enum(['DEFAULT', 'CATEGORY', 'PRODUCT']), targetId: z.string().min(1).max(120).optional(), basisPoints: z.number().int().min(0).max(10000),
      validFrom: z.iso.datetime({ offset: true }), validUntil: z.iso.datetime({ offset: true }).optional() }).parse(raw);
    if (input.targetType !== 'DEFAULT' && !input.targetId) throw new AppError('VALIDATION_FAILED', 'targetId is required for product/category rules.', 400, { fields: [{ field: 'targetId', reason: 'REQUIRED' }] });
    if (input.validUntil && new Date(input.validUntil) <= new Date(input.validFrom)) throw new AppError('VALIDATION_FAILED', 'validUntil must be after validFrom.', 400);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-discounts:' + partnerId}))`;
      const partner = await tx.partner.findFirst({ where: { id: z.uuid().parse(partnerId), isDeleted: false } }); if (!partner) throw notFound('Partner');
      if (input.targetType === 'PRODUCT' && !/^(plan|topup):/.test(input.targetId!)) throw new AppError('VALIDATION_FAILED', 'Product targets must reference the Billing catalog (plan:<planId> or topup:<code>).', 400);
      const prev = await tx.partnerDiscountVersion.findFirst({ where: { partnerId: partner.id }, orderBy: { version: 'desc' } });
      const top = await tx.partnerDiscountRule.findFirst({ where: { partnerId: partner.id }, orderBy: { priorityVersion: 'desc' } });
      const rule = await tx.partnerDiscountRule.create({ data: { partnerId: partner.id, targetType: input.targetType, targetId: input.targetType === 'DEFAULT' ? null : input.targetId!, basisPoints: input.basisPoints,
        priorityVersion: (top?.priorityVersion ?? 0) + 1, validFrom: new Date(input.validFrom), validUntil: input.validUntil ? new Date(input.validUntil) : null, approvedBy: actor.userId } });
      if (input.targetType === 'DEFAULT') await tx.partner.update({ where: { id: partner.id }, data: { defaultDiscountBasisPoints: input.basisPoints, defaultDiscount: Math.round(input.basisPoints / 100), version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, partnerId: partner.id, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.DISCOUNT_UPDATED', resourceType: 'PartnerDiscountRule', resourceId: rule.id, after: input, requestId });
      await snapshotRules(tx, partner.id, actor.userId, 'RULE_CREATED', prev ? sha(JSON.stringify(prev.rulesSnapshot)) : null);
      return rule;
    });
  }
  async updateRule(actor: PlatformPrincipal, partnerId: string, ruleId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.discount.manage');
    const input = z.strictObject({ basisPoints: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional(), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const rule = await tx.partnerDiscountRule.findFirst({ where: { id: z.uuid().parse(ruleId), partnerId: z.uuid().parse(partnerId) } }); if (!rule) throw notFound('Discount rule');
      assertVersion(rule.version, input.expectedVersion);
      const prev = await tx.partnerDiscountVersion.findFirst({ where: { partnerId: rule.partnerId }, orderBy: { version: 'desc' } });
      // New quotes only: issued quotes/invoices keep their Billing snapshots (03 AC02).
      const updated = await tx.partnerDiscountRule.update({ where: { id: rule.id }, data: { ...(input.basisPoints !== undefined ? { basisPoints: input.basisPoints } : {}), ...(input.active !== undefined ? { status: input.active ? 'ACTIVE' : 'DISABLED' } : {}), version: { increment: 1 } } });
      if (rule.targetType === 'DEFAULT' && input.basisPoints !== undefined) await tx.partner.update({ where: { id: rule.partnerId }, data: { defaultDiscountBasisPoints: input.basisPoints, defaultDiscount: Math.round(input.basisPoints / 100), version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, partnerId: rule.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.DISCOUNT_UPDATED', resourceType: 'PartnerDiscountRule', resourceId: rule.id, before: { basisPoints: rule.basisPoints, status: rule.status }, after: { basisPoints: updated.basisPoints, status: updated.status }, requestId });
      await snapshotRules(tx, rule.partnerId, actor.userId, 'RULE_UPDATED', prev ? sha(JSON.stringify(prev.rulesSnapshot)) : null);
      return updated;
    });
  }
  async internalResolve(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ partnerId: z.uuid(), productId: z.string().min(1).max(120), categoryIds: z.array(z.string().max(120)).max(20).default([]), pricingTime: z.iso.datetime({ offset: true }).optional() }).parse(raw);
    // Pricing time is trusted only from the server clock unless a service caller replays a historical quote.
    return resolveDiscount(this.db, { ...input, at: input.pricingTime ? new Date(input.pricingTime) : new Date() });
  }

  // ------------------------------------------------------------------ 04 provisioning & relations
  /** Uses the normal Workspace bootstrap: the customer is the Owner, never the Partner (04 AC01); retries never duplicate (AC04). */
  async provision(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.workspace.provision');
    const input = z.strictObject({ customerUserId: z.uuid(), workspaceName: z.string().trim().min(2).max(120), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const requestHash = sha(JSON.stringify({ c: input.customerUserId, n: input.workspaceName }));
    const job = await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-provision:' + actor.partnerId + ':' + input.idempotencyKey}))`;
      const existing = await tx.partnerWorkspaceProvisioning.findUnique({ where: { partnerId_idempotencyKey: { partnerId: actor.partnerId, idempotencyKey: input.idempotencyKey } } });
      if (existing) { if (existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409); return existing; }
      const customer = await tx.user.findUnique({ where: { id: input.customerUserId } });
      if (!customer || customer.isDeleted || customer.status !== 'ACTIVE' || !customer.emailVerifiedAt) throw new AppError('BUSINESS_RULE_VIOLATION', 'Customer must be a verified, active user.', 422);
      if (await tx.partnerMembership.findFirst({ where: { partnerId: actor.partnerId, userId: customer.id, isDeleted: false } })) throw new AppError('BUSINESS_RULE_VIOLATION', 'Customer owner must not be a member of the provisioning Partner.', 422);
      return tx.partnerWorkspaceProvisioning.create({ data: { partnerId: actor.partnerId, initiatingMemberId: actor.membershipId, customerUserId: customer.id, workspaceName: input.workspaceName, idempotencyKey: input.idempotencyKey, requestHash } });
    });
    if (job.status === 'CREATED') return { provisioningId: job.id, status: job.status, workspaceId: job.workspaceId };
    try {
      const workspaceId = await runStateUnit(async () => {
        const { appContext } = await import('../app-context');
        const state = appContext.store.state;
        const existing = state.workspaces.find(w => (w.meta as { partnerProvisioningId?: string } | null)?.partnerProvisioningId === job.id);
        if (existing) return existing.id;
        const customer = state.users.find(u => u.id === job.customerUserId);
        if (!customer) throw new AppError('BUSINESS_RULE_VIOLATION', 'Customer user is unavailable.', 422);
        const workspace = await appContext.workspaces.createOwnedWorkspace(customer, job.workspaceName);
        workspace.meta = { ...(workspace.meta ?? {}), partnerProvisioningId: job.id };
        return workspace.id;
      });
      return this.db.$transaction(async tx => {
        await tx.partnerWorkspaceProvisioning.update({ where: { id: job.id }, data: { status: 'CREATED', workspaceId } });
        const relation = await tx.partnerWorkspaceRelation.create({ data: { partnerId: actor.partnerId, workspaceId, status: 'ACTIVE', createdByMemberId: actor.membershipId } });
        await audit(tx, { workspaceId, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.WORKSPACE_PROVISIONED', resourceType: 'PartnerWorkspaceRelation', resourceId: relation.id, after: { provisioningId: job.id, ownerUserId: job.customerUserId }, requestId });
        await relationEvent(tx, workspaceId, relation.id, 'PARTNER.WORKSPACE_PROVISIONED', { partnerId: actor.partnerId }, user.userId);
        await relationEvent(tx, workspaceId, relation.id, 'PARTNER.WORKSPACE_RELATION_CREATED', { partnerId: actor.partnerId }, user.userId);
        return { provisioningId: job.id, status: 'CREATED', workspaceId, relationId: relation.id };
      });
    } catch (error) {
      await this.db.partnerWorkspaceProvisioning.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: error instanceof AppError ? error.code : 'BOOTSTRAP_FAILED' } });
      throw error;
    }
  }
  /** Commercial summary only (zero CRM data): name, relation status/dates and Billing subscription status. */
  async customerWorkspaces(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.workspace.read', { allowSuspended: true });
    const q = pageQuery.extend({ status: z.enum(['PENDING', 'ACTIVE', 'ENDED']).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional() }).parse(raw);
    const scoped = await scopedWorkspaceIds(this.db, actor, 'partner.workspace.read');
    const where: Prisma.PartnerWorkspaceRelationWhereInput = { partnerId: actor.partnerId, isDeleted: false, ...(q.status ? { status: q.status } : {}), ...(scoped ? { workspaceId: { in: scoped } } : {}),
      ...(q.search ? { workspace: { name: { contains: q.search, mode: 'insensitive' } } } : {}) };
    const [rows, total] = await Promise.all([this.db.partnerWorkspaceRelation.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { workspace: { select: { id: true, name: true, isDeleted: true } } } }), this.db.partnerWorkspaceRelation.count({ where })]);
    const subs = await this.db.billingSubscription.findMany({ where: { workspaceId: { in: rows.map(r => r.workspaceId) } }, orderBy: { createdAt: 'desc' }, select: { workspaceId: true, status: true, currentPeriodEnd: true } });
    return paged(rows.map(r => ({ relationId: r.id, workspace: { id: r.workspace.id, name: r.workspace.name }, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, subscription: subs.find(s => s.workspaceId === r.workspaceId) ?? null })), total, q.page, q.limit);
  }
  /** Linking an existing tenant needs the customer owner's consent (04 rule 4); the partial unique index forbids two ACTIVE relations. */
  async link(user: UserPrincipal, partnerId: string, workspaceId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.workspace.link');
    const input = z.strictObject({ customerOwnerConsentRef: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const ws = await tx.workspace.findFirst({ where: { id: z.uuid().parse(workspaceId), isDeleted: false } }); if (!ws) throw notFound('Workspace');
      // The consent reference is a Billing change approval decided by the Workspace owner for this exact link.
      const consent = await tx.billingChangeApproval.findFirst({ where: { id: input.customerOwnerConsentRef, workspaceId: ws.id, action: 'PARTNER_LINK', status: 'APPROVED', consumedAt: null, expiresAt: { gt: new Date() }, approverId: ws.ownerUserId } });
      if (!consent || (consent.payload as { partnerId?: string }).partnerId !== actor.partnerId) throw new AppError('BUSINESS_RULE_VIOLATION', 'Customer owner consent for this Partner is required.', 422);
      if (await tx.partnerWorkspaceRelation.findFirst({ where: { workspaceId: ws.id, status: 'ACTIVE', isDeleted: false } })) throw new AppError('BUSINESS_RULE_VIOLATION', 'Workspace already has an active Partner; use a transfer.', 409);
      await tx.billingChangeApproval.update({ where: { id: consent.id }, data: { consumedAt: new Date() } });
      const relation = await tx.partnerWorkspaceRelation.create({ data: { partnerId: actor.partnerId, workspaceId: ws.id, status: 'ACTIVE', createdByMemberId: actor.membershipId, consentRef: consent.id } });
      await audit(tx, { workspaceId: ws.id, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.WORKSPACE_RELATION_CREATED', resourceType: 'PartnerWorkspaceRelation', resourceId: relation.id, after: { consentRef: consent.id }, requestId });
      await relationEvent(tx, ws.id, relation.id, 'PARTNER.WORKSPACE_RELATION_CREATED', { partnerId: actor.partnerId }, user.userId);
      return relation;
    });
  }
  /** Ending keeps invoices/attributions (04 AC05) and never touches the Workspace itself. */
  async endRelation(user: UserPrincipal, partnerId: string, workspaceId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.workspace.end', { allowSuspended: true });
    const input = z.strictObject({ reason: z.string().trim().min(3).max(1000), approvalRef: z.string().trim().min(3).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const relation = await tx.partnerWorkspaceRelation.findFirst({ where: { partnerId: actor.partnerId, workspaceId: z.uuid().parse(workspaceId), status: 'ACTIVE', isDeleted: false } }); if (!relation) throw notFound('Relation');
      const updated = await tx.partnerWorkspaceRelation.update({ where: { id: relation.id }, data: { status: 'ENDED', endedAt: new Date(), endReason: input.reason, relationVersion: { increment: 1 } } });
      await tx.partnerWorkspaceAccess.updateMany({ where: { partnerId: actor.partnerId, workspaceId: relation.workspaceId, status: { in: ['ACTIVE', 'REQUESTED'] } }, data: { status: 'REVOKED', revokedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, { workspaceId: relation.workspaceId, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.WORKSPACE_RELATION_ENDED', resourceType: 'PartnerWorkspaceRelation', resourceId: relation.id, after: input, requestId });
      await relationEvent(tx, relation.workspaceId, relation.id, 'PARTNER.WORKSPACE_RELATION_ENDED', { partnerId: actor.partnerId }, user.userId);
      return updated;
    });
  }

  // ------------------------------------------------------------------ 06 referrals, attribution, transfers
  async createReferralLink(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.referrals.manage');
    const input = z.strictObject({ campaignLabel: z.string().trim().min(1).max(120), windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS()) }).parse(raw);
    const code = randomBytes(12).toString('base64url');
    return this.db.$transaction(async tx => {
      const link = await tx.partnerReferralLink.create({ data: { partnerId: actor.partnerId, codeHash: sha(code), publicCode: code, campaignLabel: input.campaignLabel, attributionWindowDays: input.windowDays, createdBy: user.userId } });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.REFERRAL_LINK_CREATED', resourceType: 'PartnerReferralLink', resourceId: link.id, after: input, requestId });
      return { id: link.id, code, url: `${process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? ''}/?ref=${code}`, windowDays: link.attributionWindowDays };
    });
  }
  async revokeReferralLink(user: UserPrincipal, partnerId: string, linkId: string, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.referrals.manage', { allowSuspended: true });
    return this.db.$transaction(async tx => {
      const revoked = await tx.partnerReferralLink.updateMany({ where: { id: z.uuid().parse(linkId), partnerId: actor.partnerId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      if (!revoked.count) throw notFound('Referral link');
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.REFERRAL_LINK_REVOKED', resourceType: 'PartnerReferralLink', resourceId: linkId, requestId });
      return { id: linkId, status: 'REVOKED' };
    });
  }
  async referrals(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.referrals.readOwn', { allowSuspended: true });
    const q = z.object({ status: z.enum(['PROPOSED', 'CONFIRMED', 'DISPUTED', 'REJECTED']).optional() }).parse(raw);
    const links = await this.db.partnerReferralLink.findMany({ where: { partnerId: actor.partnerId }, orderBy: { createdAt: 'desc' }, select: { id: true, publicCode: true, campaignLabel: true, attributionWindowDays: true, status: true, createdAt: true } });
    const touches = await this.db.partnerReferralTouch.groupBy({ by: ['codeId'], where: { partnerId: actor.partnerId }, _count: true });
    const attributions = await this.db.partnerReferralAttribution.groupBy({ by: ['status'], where: { partnerId: actor.partnerId, ...(q.status ? { status: q.status } : {}) }, _count: true });
    return { links: links.map(l => ({ ...l, touches: touches.find(t => t.codeId === l.id)?._count ?? 0 })), attributions: attributions.map(a => ({ status: a.status, count: a._count })) }; // counts only, no customer identities
  }
  /** Consent-gated touch: no tracking without consent; visitor reference is hashed; expired/revoked codes record nothing (06 AC04). */
  async recordTouch(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ code: z.string().min(8).max(64), visitorToken: z.string().min(8).max(200), consent: z.enum(['ATTRIBUTION', 'NONE']) }).parse(raw);
    if (input.consent !== 'ATTRIBUTION') return { recorded: false, reason: 'NO_CONSENT' };
    const link = await this.db.partnerReferralLink.findUnique({ where: { codeHash: sha(input.code) } });
    const partner = link ? await this.db.partner.findUnique({ where: { id: link.partnerId } }) : null;
    if (!link || link.status !== 'ACTIVE' || !partner || !isActivePartner(partner)) return { recorded: false, reason: 'INACTIVE_CODE' };
    const touch = await this.db.$transaction(async tx => {
      const row = await tx.partnerReferralTouch.create({ data: { partnerId: link.partnerId, codeId: link.id, visitorRef: sha('visitor:' + input.visitorToken), consentScope: input.consent } });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.REFERRAL_RECORDED', aggregateType: 'PartnerReferralLink', aggregateId: link.id, actorType: 'SERVICE', payload: { partnerId: link.partnerId } });
      return row;
    });
    return { recorded: true, touchId: touch.id };
  }
  /**
   * Proposes an attribution when a Workspace is created by a visitor with a consented, in-window touch. Fraud checks: a Partner
   * member cannot refer their own Workspace; an existing active relation makes the attribution DISPUTED instead of a 2nd Partner.
   * Attribution never grants Workspace access (06 AC01).
   */
  static async attributeWorkspace(tx: Tx, workspaceId: string, ownerUserId: string, visitorToken: string) {
    const visitorRef = sha('visitor:' + visitorToken);
    const touch = await tx.partnerReferralTouch.findFirst({ where: { visitorRef }, orderBy: { observedAt: 'desc' } }); if (!touch) return null;
    const link = await tx.partnerReferralLink.findUniqueOrThrow({ where: { id: touch.codeId } });
    if (link.status !== 'ACTIVE' || touch.observedAt.getTime() + link.attributionWindowDays * 86400000 < Date.now()) return null;
    if (await tx.partnerMembership.count({ where: { partnerId: link.partnerId, userId: ownerUserId, isDeleted: false } })) return null; // self-referral
    const active = await tx.partnerWorkspaceRelation.findFirst({ where: { workspaceId, status: 'ACTIVE', isDeleted: false } });
    return tx.partnerReferralAttribution.create({ data: { workspaceId, partnerId: link.partnerId, sourceTouchId: touch.id, modelVersion: link.modelVersion, effectiveAt: new Date(), status: active && active.partnerId !== link.partnerId ? 'DISPUTED' : 'PROPOSED' } });
  }
  async disputeAttribution(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.attribution.review');
    const input = z.strictObject({ workspaceId: z.uuid(), claimId: z.uuid(), reason: z.string().trim().min(3).max(1000), decision: z.enum(['CONFIRMED', 'REJECTED', 'DISPUTED']).default('DISPUTED') }).parse(raw);
    return this.db.$transaction(async tx => {
      const claim = await tx.partnerReferralAttribution.findFirst({ where: { id: input.claimId, workspaceId: input.workspaceId } }); if (!claim) throw notFound('Attribution');
      const updated = await tx.partnerReferralAttribution.update({ where: { id: claim.id }, data: { status: input.decision, disputeReason: input.reason, reviewedBy: actor.userId } });
      await audit(tx, { workspaceId: input.workspaceId, partnerId: claim.partnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.ATTRIBUTION_' + input.decision, resourceType: 'PartnerReferralAttribution', resourceId: claim.id, after: input, requestId });
      if (input.decision === 'CONFIRMED') await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'PARTNER.ATTRIBUTION_CONFIRMED', aggregateType: 'PartnerReferralAttribution', aggregateId: claim.id, actorId: actor.userId, actorType: 'PLATFORM', payload: { partnerId: claim.partnerId } });
      return updated;
    });
  }
  /** Customer side: the Workspace owner requests (and thereby consents to) moving to another Partner. */
  async requestTransfer(actor: Principal, workspaceId: string, raw: unknown, requestId: string) {
    if (actor.workspaceId !== workspaceId) throw notFound('Workspace');
    requirePermission(actor, 'workspace.partner.transfer.request');
    const input = z.strictObject({ toPartnerId: z.uuid(), reason: z.string().trim().min(3).max(1000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      if (ws.ownerUserId !== actor.userId) throw new AppError('PERMISSION_DENIED', 'Only the Workspace owner can consent to a Partner transfer.', 403);
      const target = await tx.partner.findUnique({ where: { id: input.toPartnerId } });
      if (!target || !isActivePartner(target)) throw notFound('Partner');
      const current = await tx.partnerWorkspaceRelation.findFirst({ where: { workspaceId, status: 'ACTIVE', isDeleted: false } });
      if (current?.partnerId === target.id) throw new AppError('BUSINESS_RULE_VIOLATION', 'Workspace is already with this Partner.', 422);
      const transfer = await tx.partnerRelationTransfer.create({ data: { workspaceId, fromPartnerId: current?.partnerId ?? null, toPartnerId: target.id, reason: input.reason, requestedBy: actor.userId, customerOwnerConsent: `owner:${actor.userId}:${new Date().toISOString()}` } });
      await audit(tx, { workspaceId, actorId: actor.userId, action: 'PARTNER.TRANSFER_REQUESTED', resourceType: 'PartnerRelationTransfer', resourceId: transfer.id, after: input, requestId });
      return transfer;
    });
  }
  /** Platform approval applies atomically: end old + start new under the one-ACTIVE partial index (06 AC02); history keeps old Partner (AC03). */
  async approveTransfer(actor: PlatformPrincipal, transferId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.transfer.approve');
    const input = z.strictObject({ decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'), reason: z.string().trim().min(3).max(1000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const t = await tx.partnerRelationTransfer.findUnique({ where: { id: z.uuid().parse(transferId) } }); if (!t) throw notFound('Transfer');
      if (t.status !== 'PENDING') throw new AppError('INVALID_STATE_TRANSITION', `Transfer is ${t.status}.`, 409);
      if (!t.customerOwnerConsent) throw new AppError('BUSINESS_RULE_VIOLATION', 'Customer owner consent is missing.', 422);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-relation:' + t.workspaceId}))`;
      if (input.decision === 'REJECTED') {
        await tx.partnerRelationTransfer.update({ where: { id: t.id }, data: { status: 'REJECTED', platformApprovalBy: actor.userId, decidedAt: new Date() } });
        await audit(tx, { workspaceId: t.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.TRANSFER_REJECTED', resourceType: 'PartnerRelationTransfer', resourceId: t.id, after: input, requestId });
        return { id: t.id, status: 'REJECTED' };
      }
      const old = await tx.partnerWorkspaceRelation.findFirst({ where: { workspaceId: t.workspaceId, status: 'ACTIVE', isDeleted: false } });
      if (old) {
        await tx.partnerWorkspaceRelation.update({ where: { id: old.id }, data: { status: 'ENDED', endedAt: new Date(), endReason: 'TRANSFERRED', relationVersion: { increment: 1 } } });
        await tx.partnerWorkspaceAccess.updateMany({ where: { partnerId: old.partnerId, workspaceId: t.workspaceId, status: { in: ['ACTIVE', 'REQUESTED'] } }, data: { status: 'REVOKED', revokedAt: new Date(), version: { increment: 1 } } });
      }
      const relation = await tx.partnerWorkspaceRelation.create({ data: { partnerId: t.toPartnerId, workspaceId: t.workspaceId, status: 'ACTIVE', consentRef: t.customerOwnerConsent } });
      await tx.partnerRelationTransfer.update({ where: { id: t.id }, data: { status: 'APPLIED', platformApprovalBy: actor.userId, decidedAt: new Date() } });
      await audit(tx, { workspaceId: t.workspaceId, partnerId: t.toPartnerId, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.RELATION_TRANSFERRED', resourceType: 'PartnerWorkspaceRelation', resourceId: relation.id, before: { partnerId: old?.partnerId ?? null }, after: { partnerId: t.toPartnerId }, requestId });
      await relationEvent(tx, t.workspaceId, relation.id, 'PARTNER.RELATION_TRANSFERRED', { fromPartnerId: old?.partnerId ?? null, toPartnerId: t.toPartnerId }, actor.userId);
      return { id: t.id, status: 'APPLIED', relationId: relation.id };
    });
  }
}
