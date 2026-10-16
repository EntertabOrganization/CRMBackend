import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import { bumpCacheVersion, notFound, type DbClient, type Tx } from '../platform/kernel';

export type { DbClient, Tx };
export const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Partner-scope permission catalog (never Workspace permissions; never platform.*). */
export const PARTNER_PERMISSIONS = [
  'partner.members.invite', 'partner.members.read', 'partner.members.manage', 'partner.roles.manage',
  'partner.discount.readOwn', 'partner.workspace.provision', 'partner.workspace.link', 'partner.workspace.end', 'partner.workspace.read',
  'partner.access.request', 'partner.access.use', 'partner.referrals.manage', 'partner.referrals.readOwn',
  'partner.finance.readOwn', 'partner.payout.request', 'partner.payout.readOwn', 'partner.dashboard.readOwn', 'partner.report.export',
] as const;
export type PartnerPermission = (typeof PARTNER_PERMISSIONS)[number];
export const PARTNER_SCOPES = ['PARTNER_ALL', 'OWN_RELATIONSHIPS', 'ASSIGNED_WORKSPACES'] as const;
export const ROLE_DEFAULTS: Record<'OWNER' | 'SALES' | 'FINANCE' | 'SUPPORT', { name: string; permissions: Array<[PartnerPermission, (typeof PARTNER_SCOPES)[number]]> }> = {
  OWNER: { name: 'Partner Owner', permissions: PARTNER_PERMISSIONS.map(p => [p, 'PARTNER_ALL'] as [PartnerPermission, 'PARTNER_ALL']) },
  SALES: { name: 'Sales', permissions: [['partner.workspace.provision', 'PARTNER_ALL'], ['partner.workspace.link', 'PARTNER_ALL'], ['partner.workspace.read', 'OWN_RELATIONSHIPS'], ['partner.referrals.manage', 'PARTNER_ALL'],
    ['partner.referrals.readOwn', 'PARTNER_ALL'], ['partner.discount.readOwn', 'PARTNER_ALL'], ['partner.dashboard.readOwn', 'OWN_RELATIONSHIPS'], ['partner.access.request', 'OWN_RELATIONSHIPS']] },
  FINANCE: { name: 'Finance', permissions: [['partner.finance.readOwn', 'PARTNER_ALL'], ['partner.payout.request', 'PARTNER_ALL'], ['partner.payout.readOwn', 'PARTNER_ALL'], ['partner.discount.readOwn', 'PARTNER_ALL'],
    ['partner.dashboard.readOwn', 'PARTNER_ALL'], ['partner.report.export', 'PARTNER_ALL'], ['partner.workspace.read', 'PARTNER_ALL']] },
  SUPPORT: { name: 'Support', permissions: [['partner.access.request', 'ASSIGNED_WORKSPACES'], ['partner.access.use', 'ASSIGNED_WORKSPACES'], ['partner.workspace.read', 'ASSIGNED_WORKSPACES']] },
};
/** Delegated Workspace permissions a customer may grant; ownership, billing secrets and tenant administration are never grantable. */
export const DELEGABLE = /^(crm|task|tasks|calendar|drive|files|sites|marketing|commerce|catalog|spa|knowledge|activity|activities)\.[a-zA-Z_.]+$/i;
export const READ_ONLY = /\.(read|list|view|readRevision|export)$/;
export const FORBIDDEN_DELEGATION = /(\.delete$|owner|billing|secret|role\.|user\.|workspace\.|platform\.|partner\.)/i;

export type PartnerActor = { userId: string; partnerId: string; membershipId: string; roleId: string; roleCode: string; grants: Map<string, string>; partnerStatus: string };

/**
 * Resolves the caller's Partner membership. Non-members get 404 (no cross-Partner disclosure, 02 AC01/05);
 * members without the permission get 403. Suspended/deleted Partners keep only read/finance obligations.
 */
export async function partnerActor(db: DbClient, userId: string, partnerId: string, permission: PartnerPermission, opts: { allowSuspended?: boolean } = {}): Promise<PartnerActor> {
  const partner = await db.partner.findUnique({ where: { id: partnerId } });
  const membership = partner ? await db.partnerMembership.findFirst({ where: { partnerId, userId, status: 'ACTIVE', isDeleted: false } }) : null;
  if (!partner || !membership || partner.purgedAt) throw notFound('Partner');
  if ((partner.status !== 'ACTIVE' || partner.isDeleted) && !opts.allowSuspended) throw new AppError('PERMISSION_DENIED', 'Partner is suspended; this action is unavailable.', 403);
  const role = await db.partnerRole.findUnique({ where: { id: membership.partnerRoleId } });
  if (!role || role.isDeleted) throw new AppError('PERMISSION_DENIED', 'Partner role is unavailable.', 403);
  const grants = new Map((await db.partnerRolePermission.findMany({ where: { partnerRoleId: role.id, effect: 'ALLOW' } })).map(g => [g.permissionCode, g.scope]));
  // Legacy owner roles (Auth pack) predate explicit grants: they hold every Partner permission.
  if (role.isOwnerRole && grants.size === 0) for (const p of PARTNER_PERMISSIONS) grants.set(p, 'PARTNER_ALL');
  if (!grants.has(permission)) throw new AppError('PERMISSION_DENIED', `${permission} permission is required.`, 403);
  return { userId, partnerId, membershipId: membership.id, roleId: role.id, roleCode: role.code, grants, partnerStatus: partner.isDeleted ? 'SOFT_DELETED' : partner.status };
}
/** Workspace ids visible to the actor under a scoped permission (scope applied before pagination). */
export async function scopedWorkspaceIds(db: DbClient, actor: PartnerActor, permission: PartnerPermission): Promise<string[] | null> {
  const scope = actor.grants.get(permission);
  if (scope === 'PARTNER_ALL') return null;
  if (scope === 'OWN_RELATIONSHIPS') return (await db.partnerWorkspaceRelation.findMany({ where: { partnerId: actor.partnerId, createdByMemberId: actor.membershipId }, select: { workspaceId: true } })).map(r => r.workspaceId);
  return (await db.partnerWorkspaceAccess.findMany({ where: { partnerId: actor.partnerId, granteeUserId: actor.userId, status: 'ACTIVE' }, select: { workspaceId: true } })).map(r => r.workspaceId);
}
export async function createDefaultRoles(tx: Tx, partnerId: string) {
  const roles: Record<string, string> = {};
  for (const [code, def] of Object.entries(ROLE_DEFAULTS)) {
    const role = await tx.partnerRole.create({ data: { name: def.name, isOwnerRole: code === 'OWNER', partnerId, code, protected: code === 'OWNER' } });
    for (const [permissionCode, scope] of def.permissions) await tx.partnerRolePermission.create({ data: { partnerRoleId: role.id, permissionCode, scope } });
    roles[code] = role.id;
  }
  return roles;
}
/** Revocation/suspension must defeat cached Workspace authority and realtime streams immediately. */
export async function invalidatePartnerAccess(tx: Tx, partnerId: string, scope: string) {
  const last = await tx.partnerAccessInvalidation.findFirst({ where: { partnerId }, orderBy: { version: 'desc' } });
  await tx.partnerAccessInvalidation.create({ data: { partnerId, scope, version: (last?.version ?? 0) + 1 } });
  const grants = await tx.partnerWorkspaceAccess.findMany({ where: { partnerId }, select: { workspaceId: true, granteeUserId: true } });
  for (const g of grants) if (g.granteeUserId) await bumpCacheVersion(tx, 'auth', `${g.workspaceId}:${g.granteeUserId}`);
  await bumpCacheVersion(tx, 'partner', partnerId);
}
export const isActivePartner = (p: { status: string; isDeleted: boolean; purgedAt: Date | null }) => p.status === 'ACTIVE' && !p.isDeleted && !p.purgedAt;
export type PartnerRow = Prisma.PartnerGetPayload<object>;
export type Db = PrismaClient;
