import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { PlatformNotificationService } from '../platform/notifications-service';
import { assertVersion, audit, emitEvent, notFound, type DbClient, type UserPrincipal } from '../platform/kernel';
import { DELEGABLE, FORBIDDEN_DELEGATION, invalidatePartnerAccess, isActivePartner, partnerActor, READ_ONLY, type Tx } from './support';

const MAX_DAYS = () => Number(process.env.PARTNER_ACCESS_MAX_DAYS ?? 30);
const codes = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{2,100}$/)).min(1).max(40);
function assertDelegable(list: string[], allowWrite: boolean) {
  const bad = list.filter(c => !DELEGABLE.test(c) || FORBIDDEN_DELEGATION.test(c) || (!allowWrite && !READ_ONLY.test(c)));
  if (bad.length) throw new AppError('VALIDATION_FAILED', 'Some permissions cannot be delegated to a Partner.', 400, { fields: bad.map(field => ({ field, reason: 'NOT_DELEGABLE' })) });
}
const accessEvent = (tx: Tx, grantId: string, action: string, actorId: string | null, reason?: string) => tx.partnerAccessEvent.create({ data: { grantId, action, actorId, reason } });

/**
 * Delegated-principal resolution used by `resolvePrincipal` when the caller has no Workspace membership:
 * authority = active Partner membership with partner.access.use ∩ ACTIVE unexpired customer grant ∩ normal permission checks.
 * Nothing is cached; suspension/revocation/expiry take effect on the next request (05 AC02-AC04). Never a Workspace member row.
 */
export async function delegatedPrincipal(db: DbClient, workspaceId: string, userId: string): Promise<Principal | null> {
  const now = new Date();
  if (!await db.workspace.findFirst({ where: { id: workspaceId, isDeleted: false }, select: { id: true } })) return null;
  const grants = await db.partnerWorkspaceAccess.findMany({ where: { workspaceId, status: 'ACTIVE', expiresAt: { gt: now }, OR: [{ granteeUserId: userId }, { granteeUserId: null }] } });
  for (const grant of grants) {
    const partner = await db.partner.findUnique({ where: { id: grant.partnerId } });
    if (!partner || !isActivePartner(partner)) continue;
    const relation = await db.partnerWorkspaceRelation.findFirst({ where: { workspaceId, partnerId: grant.partnerId, status: 'ACTIVE', isDeleted: false } });
    if (!relation) continue;
    try { await partnerActor(db, userId, grant.partnerId, 'partner.access.use'); } catch { continue; }
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || user.isDeleted || user.status !== 'ACTIVE') return null;
    const list = (grant.permissionCodes as string[]).filter(c => !FORBIDDEN_DELEGATION.test(c));
    return { workspaceId, userId, roleId: 'partner-delegation:' + grant.id, grants: new Map(list.map(c => [c, 'WORKSPACE'])), entitlements: {} };
  }
  return null;
}

/** Customer-authorized, time-limited Partner access to a Workspace (32/05). */
export class PartnerAccessService {
  constructor(private readonly db: PrismaClient) {}
  private sameWorkspace(actor: Principal, id: string) { if (actor.workspaceId !== id) throw notFound('Workspace'); }

  /** Partner member asks; the customer decides. Partners can never self-grant. */
  async request(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.access.request');
    const input = z.strictObject({ workspaceId: z.uuid(), requestedPermissions: codes, expiresAt: z.iso.datetime({ offset: true }), reason: z.string().trim().min(5).max(1000), granteeUserId: z.uuid().optional() }).parse(raw);
    assertDelegable(input.requestedPermissions, true);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= new Date() || expiresAt.getTime() - Date.now() > MAX_DAYS() * 86400000) throw new AppError('VALIDATION_FAILED', `Access must expire within ${MAX_DAYS()} days.`, 400);
    return this.db.$transaction(async tx => {
      const relation = await tx.partnerWorkspaceRelation.findFirst({ where: { partnerId: actor.partnerId, workspaceId: input.workspaceId, status: 'ACTIVE', isDeleted: false } });
      if (!relation) throw notFound('Workspace');
      if (input.granteeUserId && !await tx.partnerMembership.findFirst({ where: { partnerId: actor.partnerId, userId: input.granteeUserId, status: 'ACTIVE', isDeleted: false } })) throw notFound('Partner member');
      const grant = await tx.partnerWorkspaceAccess.create({ data: { partnerId: actor.partnerId, workspaceId: input.workspaceId, granteeUserId: input.granteeUserId ?? user.userId, permissionCodes: input.requestedPermissions,
        grantScope: input.requestedPermissions.every(c => READ_ONLY.test(c)) ? 'READ_ONLY' : 'EXTENDED', reason: input.reason, requestedBy: user.userId, expiresAt } });
      await accessEvent(tx, grant.id, 'REQUESTED', user.userId, input.reason);
      await audit(tx, { workspaceId: input.workspaceId, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.WORKSPACE_ACCESS_REQUESTED', resourceType: 'PartnerWorkspaceAccess', resourceId: grant.id, after: { permissions: input.requestedPermissions, expiresAt }, requestId });
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: input.workspaceId } });
      await PlatformNotificationService.emitInTx(tx, { workspaceId: input.workspaceId, recipientIds: [ws.ownerUserId], topic: 'SECURITY', title: 'Partner access requested', message: 'Your Partner requested temporary access. Review it in Settings → Partner access.', eventId: 'partner-access:' + grant.id });
      return grant;
    });
  }
  /** Customer requests on behalf of their Partner (POST /workspaces/:id/partner-access/requests). */
  async customerRequest(actor: Principal, workspaceId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'workspace.partnerAccess.approve');
    const input = z.strictObject({ partnerId: z.uuid(), requestedPermissions: codes, expiresAt: z.iso.datetime({ offset: true }), reason: z.string().trim().min(5).max(1000) }).parse(raw);
    assertDelegable(input.requestedPermissions, true);
    return this.db.$transaction(async tx => {
      if (!await tx.partnerWorkspaceRelation.findFirst({ where: { partnerId: input.partnerId, workspaceId, status: 'ACTIVE', isDeleted: false } })) throw notFound('Partner');
      const grant = await tx.partnerWorkspaceAccess.create({ data: { partnerId: input.partnerId, workspaceId, granteeUserId: null, permissionCodes: input.requestedPermissions, reason: input.reason, requestedBy: actor.userId, expiresAt: new Date(input.expiresAt) } });
      await accessEvent(tx, grant.id, 'REQUESTED', actor.userId, input.reason);
      await audit(tx, { workspaceId, partnerId: input.partnerId, actorId: actor.userId, action: 'PARTNER.WORKSPACE_ACCESS_REQUESTED', resourceType: 'PartnerWorkspaceAccess', resourceId: grant.id, after: { permissions: input.requestedPermissions }, requestId });
      return grant;
    });
  }
  /** Read-only by default; write permissions require the Workspace owner or an eligible admin to approve them explicitly. */
  async approve(actor: Principal, workspaceId: string, grantId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'workspace.partnerAccess.approve');
    const input = z.strictObject({ permissions: codes, expiresAt: z.iso.datetime({ offset: true }), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const grant = await tx.partnerWorkspaceAccess.findFirst({ where: { id: z.uuid().parse(grantId), workspaceId } }); if (!grant) throw notFound('Partner access');
      assertVersion(grant.version, input.expectedVersion);
      if (grant.status !== 'REQUESTED') throw new AppError('INVALID_STATE_TRANSITION', `Access is ${grant.status}.`, 409);
      const requested = new Set(grant.permissionCodes as string[]);
      if (input.permissions.some(p => !requested.has(p))) throw new AppError('VALIDATION_FAILED', 'Approval cannot broaden the requested permissions.', 400);
      assertDelegable(input.permissions, true);
      const writes = input.permissions.filter(p => !READ_ONLY.test(p));
      // Customers can't delegate rights they don't hold themselves; write scopes need the owner or an admin holding each right.
      for (const p of input.permissions) if (!actor.grants.has(p)) throw new AppError('PERMISSION_DENIED', `You cannot delegate ${p}.`, 403);
      const expiresAt = new Date(input.expiresAt);
      if (expiresAt <= new Date() || expiresAt.getTime() - Date.now() > MAX_DAYS() * 86400000) throw new AppError('VALIDATION_FAILED', `Access must expire within ${MAX_DAYS()} days.`, 400);
      const updated = await tx.partnerWorkspaceAccess.update({ where: { id: grant.id }, data: { status: 'ACTIVE', permissionCodes: input.permissions, grantScope: writes.length ? 'EXTENDED' : 'READ_ONLY', grantedByCustomerUserId: actor.userId, expiresAt, version: { increment: 1 } } });
      await accessEvent(tx, grant.id, 'GRANTED', actor.userId);
      await audit(tx, { workspaceId, partnerId: grant.partnerId, actorId: actor.userId, action: 'PARTNER.WORKSPACE_ACCESS_GRANTED', resourceType: 'PartnerWorkspaceAccess', resourceId: grant.id, after: { permissions: input.permissions, expiresAt }, requestId });
      await emitEvent(tx, { workspaceId, eventType: 'PARTNER.WORKSPACE_ACCESS_GRANTED', aggregateType: 'PartnerWorkspaceAccess', aggregateId: grant.id, aggregateVersion: updated.version, actorId: actor.userId, payload: { partnerId: grant.partnerId } });
      return updated;
    });
  }
  async reject(actor: Principal, workspaceId: string, grantId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'workspace.partnerAccess.approve');
    const input = z.strictObject({ reason: z.string().trim().min(3).max(1000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const r = await tx.partnerWorkspaceAccess.updateMany({ where: { id: z.uuid().parse(grantId), workspaceId, status: 'REQUESTED' }, data: { status: 'REJECTED', version: { increment: 1 } } });
      if (!r.count) throw new AppError('INVALID_STATE_TRANSITION', 'Only pending requests can be rejected.', 409);
      await accessEvent(tx, grantId, 'REJECTED', actor.userId, input.reason);
      await audit(tx, { workspaceId, actorId: actor.userId, action: 'PARTNER.WORKSPACE_ACCESS_REJECTED', resourceType: 'PartnerWorkspaceAccess', resourceId: grantId, after: input, requestId });
      return { id: grantId, status: 'REJECTED' };
    });
  }
  /** The customer revokes without Partner consent; effective on the next request (05 AC02). */
  async revoke(actor: Principal, workspaceId: string, grantId: string, raw: unknown, requestId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'workspace.partnerAccess.revoke');
    const input = z.strictObject({ reason: z.string().trim().min(3).max(1000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const grant = await tx.partnerWorkspaceAccess.findFirst({ where: { id: z.uuid().parse(grantId), workspaceId } }); if (!grant) throw notFound('Partner access');
      if (!['ACTIVE', 'REQUESTED'].includes(grant.status)) throw new AppError('INVALID_STATE_TRANSITION', `Access is ${grant.status}.`, 409);
      const updated = await tx.partnerWorkspaceAccess.update({ where: { id: grant.id }, data: { status: 'REVOKED', revokedAt: new Date(), version: { increment: 1 } } });
      await accessEvent(tx, grant.id, 'REVOKED', actor.userId, input.reason);
      await invalidatePartnerAccess(tx, grant.partnerId, 'GRANT:' + grant.id);
      await audit(tx, { workspaceId, partnerId: grant.partnerId, actorId: actor.userId, action: 'PARTNER.WORKSPACE_ACCESS_REVOKED', resourceType: 'PartnerWorkspaceAccess', resourceId: grant.id, after: input, requestId });
      await emitEvent(tx, { workspaceId, eventType: 'PARTNER.WORKSPACE_ACCESS_REVOKED', aggregateType: 'PartnerWorkspaceAccess', aggregateId: grant.id, aggregateVersion: updated.version, actorId: actor.userId, payload: { partnerId: grant.partnerId } });
      return updated;
    });
  }
  async customerList(actor: Principal, workspaceId: string) {
    this.sameWorkspace(actor, workspaceId); requirePermission(actor, 'workspace.partnerAccess.approve');
    const rows = await this.db.partnerWorkspaceAccess.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const events = await this.db.partnerAccessEvent.findMany({ where: { grantId: { in: rows.map(r => r.id) } }, orderBy: { occurredAt: 'asc' } });
    return rows.map(r => ({ ...r, history: events.filter(e => e.grantId === r.id) }));
  }
  async partnerDelegations(user: UserPrincipal, partnerId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.access.request', { allowSuspended: true });
    const scope = actor.grants.get('partner.access.request');
    return this.db.partnerWorkspaceAccess.findMany({ where: { partnerId: actor.partnerId, ...(scope === 'PARTNER_ALL' ? {} : { granteeUserId: user.userId }) }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, workspaceId: true, granteeUserId: true, permissionCodes: true, grantScope: true, status: true, expiresAt: true, revokedAt: true, createdAt: true } });
  }
  /** Sweeper: marks lapsed grants EXPIRED (authorization already ignores them by expiresAt). */
  static async expireDue(db: PrismaClient) {
    const due = await db.partnerWorkspaceAccess.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, take: 200 });
    for (const g of due) await db.$transaction(async tx => {
      const r = await tx.partnerWorkspaceAccess.updateMany({ where: { id: g.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', version: { increment: 1 } } });
      if (!r.count) return;
      await accessEvent(tx, g.id, 'EXPIRED', null);
      await invalidatePartnerAccess(tx, g.partnerId, 'GRANT:' + g.id);
      await emitEvent(tx, { workspaceId: g.workspaceId, eventType: 'PARTNER.WORKSPACE_ACCESS_EXPIRED', aggregateType: 'PartnerWorkspaceAccess', aggregateId: g.id, actorType: 'SERVICE', payload: { partnerId: g.partnerId } });
    });
    return { expired: due.length };
  }
}
