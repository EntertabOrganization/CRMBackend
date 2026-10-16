import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { enforceRateLimit } from '../platform/governance-service';
import { PlatformNotificationService } from '../platform/notifications-service';
import { assertVersion, audit, emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, type PlatformPrincipal, type UserPrincipal } from '../platform/kernel';
import { createDefaultRoles, invalidatePartnerAccess, normalizeEmail, partnerActor, PARTNER_PERMISSIONS, PARTNER_SCOPES, sha, type Tx } from './support';

const TERMS_VERSION = () => process.env.PARTNER_TERMS_VERSION ?? '2026-10', PRIVACY_VERSION = () => process.env.PARTNER_PRIVACY_VERSION ?? '2026-10';
const INVITE_DAYS = 7;
const name = (min: number, max: number) => z.string().trim().min(min).max(max);
const e164 = z.string().trim().transform(v => v.replace(/[\s().-]/g, '')).pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 (e.g. +201001234567).'));
const country = z.string().regex(/^[A-Z]{2}$/);
const website = z.url().refine(u => u.startsWith('https://'), 'Website must use HTTPS.').max(300);
const partnerEvent = (tx: Tx, partnerId: string, eventType: string, payload: Record<string, unknown>, actorId: string | null, actorType: 'USER' | 'PLATFORM' | 'SERVICE' = 'USER') =>
  emitEvent(tx, { workspaceId: null, eventType, aggregateType: 'Partner', aggregateId: partnerId, actorId, actorType, payload: { partnerId, ...payload } });

/** Public applications + atomic approval (32/01) and Partner memberships/roles (32/02). */
export class PartnerProgramService {
  constructor(private readonly db: PrismaClient) {}

  /** 202 for every outcome: never reveals whether an account, application or Partner exists. */
  async submitPublic(raw: unknown, ip: string | null, requestId: string, authenticatedUserId: string | null = null) {
    const input = z.strictObject({ firstName: name(1, 100), lastName: name(1, 100), email: z.email().max(254), phone: e164, partnerName: name(2, 200), country, website: website.optional(),
      businessDescription: name(10, 4000), termsAccepted: z.literal(true), privacyAccepted: z.literal(true) }).parse(raw);
    await enforceRateLimit(this.db, 'partner.application.submit', 'IP', ip ?? 'unknown', { requests: 5, windowSeconds: 3600 });
    const email = normalizeEmail(input.email);
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-app:' + email}))`;
      const user = await tx.user.findFirst({ where: { email, isDeleted: false } });
      // An authenticated caller can only apply for their own identity.
      if (authenticatedUserId && user?.id !== authenticatedUserId) throw new AppError('VALIDATION_FAILED', 'Applications use your own account email.', 400);
      const pending = await tx.partnerApplication.findFirst({ where: { emailNormalized: email, status: 'PENDING', isDeleted: false } });
      if (pending) return; // silently idempotent; no enumeration signal
      const flags: string[] = [];
      const similar = await tx.partner.findMany({ where: { isDeleted: false, country: input.country, name: { equals: input.partnerName, mode: 'insensitive' } }, select: { id: true } });
      if (similar.length) flags.push('PROBABLE_DUPLICATE_ORGANIZATION');
      if (input.website && await tx.partner.count({ where: { website: input.website, isDeleted: false } })) flags.push('WEBSITE_ALREADY_REGISTERED');
      const app = await tx.partnerApplication.create({ data: { userId: user?.id ?? null, firstName: input.firstName, lastName: input.lastName, email, emailNormalized: email, phone: input.phone, partnerName: input.partnerName,
        country: input.country, website: input.website ?? null, businessDescription: input.businessDescription, termsVersion: TERMS_VERSION(), privacyVersion: PRIVACY_VERSION(), reviewFlags: flags } });
      await audit(tx, { workspaceId: null, actorId: user?.id ?? null, actorType: user ? 'USER' : 'SERVICE', action: 'PARTNER.APPLICATION_SUBMITTED', resourceType: 'PartnerApplication', resourceId: app.id, after: { partnerName: app.partnerName, country: app.country, flags }, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.APPLICATION_SUBMITTED', aggregateType: 'PartnerApplication', aggregateId: app.id, aggregateVersion: 1, actorType: 'SERVICE', payload: { flags } });
    });
    return { status: 'PENDING', message: 'If the details are valid, your application is pending review.' };
  }
  async myApplications(actor: UserPrincipal) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: actor.userId } });
    return this.db.partnerApplication.findMany({ where: { OR: [{ userId: actor.userId }, { emailNormalized: normalizeEmail(user.email) }], isDeleted: false }, orderBy: { createdAt: 'desc' },
      select: { id: true, partnerName: true, country: true, status: true, decisionReason: true, decidedAt: true, createdAt: true } });
  }
  async listApplications(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.partner.application.review');
    const q = pageQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), country: country.optional(), sortBy: z.enum(['createdAt', 'partnerName', 'country']).default('createdAt'), sortDir: z.enum(['asc', 'desc']).default('desc') }).parse(raw);
    const where: Prisma.PartnerApplicationWhereInput = { isDeleted: false, ...(q.status ? { status: q.status } : {}), ...(q.country ? { country: q.country } : {}),
      ...(q.search ? { OR: [{ partnerName: { contains: q.search, mode: 'insensitive' } }, { email: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [rows, total] = await Promise.all([this.db.partnerApplication.findMany({ where, orderBy: [{ [q.sortBy]: q.sortDir }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), this.db.partnerApplication.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  /**
   * Atomic approval: Partner + protected Owner role + default roles + applicant membership + audit/outbox in one transaction.
   * Same key + same payload replays; concurrent approvals serialize on the application row (exactly one Partner, 01 AC01).
   */
  async approve(actor: PlatformPrincipal, applicationId: string, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.partner.application.approve'); requireStepUp(actor, mfa);
    const input = z.strictObject({ expectedVersion: z.number().int().positive(), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const id = z.uuid().parse(applicationId);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-app-decision:' + id}))`;
      const replay = await tx.partnerApprovalEvent.findUnique({ where: { applicationId_idempotencyKey: { applicationId: id, idempotencyKey: input.idempotencyKey } } });
      if (replay) {
        if (replay.decision !== 'APPROVED' || replay.requestHash !== sha(JSON.stringify(input))) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409);
        return { partnerId: replay.partnerId, replayed: true };
      }
      const app = await tx.partnerApplication.findFirst({ where: { id, isDeleted: false } }); if (!app) throw notFound('Partner application');
      assertVersion(app.version, input.expectedVersion);
      if (app.status !== 'PENDING') throw new AppError('INVALID_STATE_TRANSITION', `Application is ${app.status}.`, 409);
      const user = app.userId ? await tx.user.findUnique({ where: { id: app.userId } }) : await tx.user.findFirst({ where: { email: app.emailNormalized ?? app.email, isDeleted: false } });
      if (!user || user.isDeleted || user.status !== 'ACTIVE' || !user.emailVerifiedAt) throw new AppError('BUSINESS_RULE_VIOLATION', 'Applicant must have a verified, active account before approval.', 422, { reason: 'APPLICANT_NOT_VERIFIED' });
      if (user.id === actor.userId) throw new AppError('PERMISSION_DENIED', 'Platform admins cannot approve their own Partner application.', 403);
      const partner = await tx.partner.create({ data: { name: app.partnerName, country: app.country, website: app.website, businessDescription: app.businessDescription, status: 'ACTIVE', defaultDiscount: 10, defaultDiscountBasisPoints: 1000, sourceApplicationId: app.id } });
      const roles = await createDefaultRoles(tx, partner.id);
      const membership = await tx.partnerMembership.create({ data: { partnerId: partner.id, userId: user.id, partnerRoleId: roles.OWNER, status: 'ACTIVE' } });
      await tx.partnerApplication.update({ where: { id: app.id }, data: { status: 'APPROVED', userId: user.id, decisionBy: actor.userId, decidedAt: new Date(), version: { increment: 1 } } });
      await tx.partnerDiscountVersion.create({ data: { partnerId: partner.id, version: 1, rulesSnapshot: { default: 1000, rules: [] } } });
      await tx.partnerApprovalEvent.create({ data: { applicationId: app.id, decision: 'APPROVED', actorUserId: actor.userId, idempotencyKey: input.idempotencyKey, requestHash: sha(JSON.stringify(input)), partnerId: partner.id } });
      await audit(tx, { workspaceId: null, partnerId: partner.id, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.APPLICATION_APPROVED', resourceType: 'PartnerApplication', resourceId: app.id, after: { partnerId: partner.id }, requestId });
      await audit(tx, { workspaceId: null, partnerId: partner.id, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.CREATED', resourceType: 'Partner', resourceId: partner.id, after: { name: partner.name, country: partner.country }, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.APPLICATION_APPROVED', aggregateType: 'PartnerApplication', aggregateId: app.id, aggregateVersion: app.version + 1, actorId: actor.userId, actorType: 'PLATFORM', payload: { partnerId: partner.id } });
      await partnerEvent(tx, partner.id, 'PARTNER.CREATED', { ownerMembershipId: membership.id }, actor.userId, 'PLATFORM');
      return { partnerId: partner.id, membershipId: membership.id, replayed: false };
    });
  }
  async reject(actor: PlatformPrincipal, applicationId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.partner.application.approve');
    const input = z.strictObject({ reason: z.string().trim().min(3).max(1000), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const app = await tx.partnerApplication.findFirst({ where: { id: z.uuid().parse(applicationId), isDeleted: false } }); if (!app) throw notFound('Partner application');
      assertVersion(app.version, input.expectedVersion);
      if (app.status !== 'PENDING') throw new AppError('INVALID_STATE_TRANSITION', `Application is ${app.status}.`, 409);
      const updated = await tx.partnerApplication.update({ where: { id: app.id }, data: { status: 'REJECTED', decisionBy: actor.userId, decisionReason: input.reason, decidedAt: new Date(), version: { increment: 1 } } });
      await tx.partnerApprovalEvent.create({ data: { applicationId: app.id, decision: 'REJECTED', actorUserId: actor.userId, idempotencyKey: 'reject:' + requestId, requestHash: sha(input.reason) } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'PARTNER.APPLICATION_REJECTED', resourceType: 'PartnerApplication', resourceId: app.id, after: { reason: input.reason }, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PARTNER.APPLICATION_REJECTED', aggregateType: 'PartnerApplication', aggregateId: app.id, aggregateVersion: updated.version, actorId: actor.userId, actorType: 'PLATFORM', payload: {} });
      return { id: app.id, status: updated.status };
    });
  }

  // ------------------------------------------------------------------ 02 memberships & roles
  async invite(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.members.invite');
    const input = z.strictObject({ email: z.email().max(254), roleId: z.uuid() }).parse(raw);
    const token = randomBytes(32).toString('base64url');
    await this.db.$transaction(async tx => {
      const role = await tx.partnerRole.findFirst({ where: { id: input.roleId, partnerId: actor.partnerId, isDeleted: false } }); if (!role) throw notFound('Partner role');
      if (role.code === 'OWNER' && actor.roleCode !== 'OWNER') throw new AppError('PERMISSION_DENIED', 'Only an owner can invite owners.', 403);
      const inv = await tx.partnerInvitation.create({ data: { partnerId: actor.partnerId, emailHash: sha(normalizeEmail(input.email)), roleId: role.id, tokenHash: sha(token), invitedBy: user.userId, expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000) } });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.MEMBER_INVITED', resourceType: 'PartnerInvitation', resourceId: inv.id, after: { roleId: role.id }, requestId });
    });
    // The token is returned once for out-of-band delivery; only its hash is stored.
    return { status: 'PENDING', invitationToken: token, expiresInDays: INVITE_DAYS };
  }
  /** Expired/revoked tokens fail without creating Users or memberships (02 AC04). */
  async acceptInvitation(user: UserPrincipal, raw: unknown, requestId: string) {
    const input = z.strictObject({ token: z.string().min(20).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const inv = await tx.partnerInvitation.findUnique({ where: { tokenHash: sha(input.token) } });
      if (!inv || inv.status !== 'PENDING') throw new AppError('VALIDATION_FAILED', 'Invitation is invalid.', 400);
      if (inv.expiresAt <= new Date()) { await tx.partnerInvitation.update({ where: { id: inv.id }, data: { status: 'EXPIRED' } }); throw new AppError('VALIDATION_FAILED', 'Invitation has expired.', 400); }
      const account = await tx.user.findUniqueOrThrow({ where: { id: user.userId } });
      if (sha(normalizeEmail(account.email)) !== inv.emailHash) throw new AppError('PERMISSION_DENIED', 'Invitation was issued to another email.', 403);
      const partner = await tx.partner.findUnique({ where: { id: inv.partnerId } });
      if (!partner || partner.status !== 'ACTIVE' || partner.isDeleted) throw new AppError('INVALID_STATE_TRANSITION', 'Partner is not accepting members.', 409);
      const existing = await tx.partnerMembership.findUnique({ where: { partnerId_userId: { partnerId: inv.partnerId, userId: user.userId } } });
      if (existing && !existing.isDeleted && existing.status === 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Already a member of this Partner.', 409);
      const membership = existing ? await tx.partnerMembership.update({ where: { id: existing.id }, data: { isDeleted: false, status: 'ACTIVE', partnerRoleId: inv.roleId, joinedAt: new Date(), version: { increment: 1 } } })
        : await tx.partnerMembership.create({ data: { partnerId: inv.partnerId, userId: user.userId, partnerRoleId: inv.roleId } });
      await tx.partnerInvitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', acceptedBy: user.userId } });
      await audit(tx, { workspaceId: null, partnerId: inv.partnerId, actorId: user.userId, action: 'PARTNER.MEMBER_ADDED', resourceType: 'PartnerMembership', resourceId: membership.id, after: { roleId: inv.roleId }, requestId });
      await partnerEvent(tx, inv.partnerId, 'PARTNER.MEMBER_ADDED', { membershipId: membership.id }, user.userId);
      return { partnerId: inv.partnerId, membershipId: membership.id };
    });
  }
  async members(user: UserPrincipal, partnerId: string, raw: unknown) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.members.read', { allowSuspended: true });
    const q = pageQuery.extend({ roleId: z.uuid().optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']).optional() }).parse(raw);
    const where: Prisma.PartnerMembershipWhereInput = { partnerId: actor.partnerId, ...(q.status === 'REMOVED' ? { isDeleted: true } : { isDeleted: false, ...(q.status ? { status: q.status } : {}) }), ...(q.roleId ? { partnerRoleId: q.roleId } : {}),
      ...(q.search ? { user: { OR: [{ email: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } } : {}) };
    const [rows, total] = await Promise.all([this.db.partnerMembership.findMany({ where, orderBy: { joinedAt: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { user: { select: { firstName: true, lastName: true, email: true } }, partnerRole: { select: { id: true, name: true, code: true } } } }), this.db.partnerMembership.count({ where })]);
    return paged(rows.map(r => ({ id: r.id, userId: r.userId, user: r.user, role: r.partnerRole, status: r.isDeleted ? 'REMOVED' : r.status, joinedAt: r.joinedAt, version: r.version })), total, q.page, q.limit);
  }
  /** Last active protected owner can't be removed, suspended or demoted (02 AC03). */
  async updateMember(user: UserPrincipal, partnerId: string, memberId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.members.manage');
    const input = z.strictObject({ roleId: z.uuid().optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']).optional(), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'partner-members:' + actor.partnerId}))`;
      const member = await tx.partnerMembership.findFirst({ where: { id: z.uuid().parse(memberId), partnerId: actor.partnerId } }); if (!member) throw notFound('Member');
      assertVersion(member.version, input.expectedVersion);
      const currentRole = await tx.partnerRole.findUniqueOrThrow({ where: { id: member.partnerRoleId } });
      const newRole = input.roleId ? await tx.partnerRole.findFirst({ where: { id: input.roleId, partnerId: actor.partnerId, isDeleted: false } }) : currentRole;
      if (!newRole) throw notFound('Partner role');
      if ((newRole.code === 'OWNER' || currentRole.code === 'OWNER') && actor.roleCode !== 'OWNER') throw new AppError('PERMISSION_DENIED', 'Only owners can change owner memberships.', 403);
      const losingOwner = currentRole.code === 'OWNER' && (newRole.code !== 'OWNER' || (input.status && input.status !== 'ACTIVE'));
      if (losingOwner) {
        const owners = await tx.partnerMembership.count({ where: { partnerId: actor.partnerId, status: 'ACTIVE', isDeleted: false, partnerRole: { code: 'OWNER' } } });
        if (owners <= 1) throw new AppError('BUSINESS_RULE_VIOLATION', 'The last active Partner owner cannot be removed, suspended or demoted; transfer ownership first.', 422);
      }
      const updated = await tx.partnerMembership.update({ where: { id: member.id }, data: { partnerRoleId: newRole.id, ...(input.status === 'REMOVED' ? { isDeleted: true } : input.status ? { status: input.status, isDeleted: false } : {}), version: { increment: 1 } } });
      if (input.status && input.status !== 'ACTIVE') {
        await tx.partnerWorkspaceAccess.updateMany({ where: { partnerId: actor.partnerId, granteeUserId: member.userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date(), version: { increment: 1 } } });
        await invalidatePartnerAccess(tx, actor.partnerId, 'MEMBER:' + member.id);
      }
      const action = input.status === 'REMOVED' ? 'PARTNER.MEMBER_REMOVED' : 'PARTNER.MEMBER_ROLE_CHANGED';
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action, resourceType: 'PartnerMembership', resourceId: member.id, before: { roleId: member.partnerRoleId, status: member.status }, after: { roleId: newRole.id, status: input.status ?? member.status }, requestId });
      await partnerEvent(tx, actor.partnerId, action, { membershipId: member.id }, user.userId);
      return { id: updated.id, roleId: updated.partnerRoleId, status: updated.isDeleted ? 'REMOVED' : updated.status, version: updated.version };
    });
  }
  async roles(user: UserPrincipal, partnerId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.members.read', { allowSuspended: true });
    const roles = await this.db.partnerRole.findMany({ where: { partnerId: actor.partnerId, isDeleted: false }, orderBy: { name: 'asc' } });
    const grants = await this.db.partnerRolePermission.findMany({ where: { partnerRoleId: { in: roles.map(r => r.id) } } });
    return roles.map(r => ({ ...r, permissions: grants.filter(g => g.partnerRoleId === r.id).map(g => ({ code: g.permissionCode, scope: g.scope })) }));
  }
  private permissionsInput = z.array(z.strictObject({ code: z.enum(PARTNER_PERMISSIONS), scope: z.enum(PARTNER_SCOPES).default('PARTNER_ALL') })).min(1).max(PARTNER_PERMISSIONS.length);
  /** Custom roles only from the Partner permission allowlist: platform privileges are not representable (02 AC05). */
  async createRole(user: UserPrincipal, partnerId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.roles.manage');
    const input = z.strictObject({ name: name(2, 80), permissions: this.permissionsInput }).parse(raw);
    return this.db.$transaction(async tx => {
      const role = await tx.partnerRole.create({ data: { name: input.name, partnerId: actor.partnerId, code: 'CUSTOM' } });
      for (const p of input.permissions) await tx.partnerRolePermission.create({ data: { partnerRoleId: role.id, permissionCode: p.code, scope: p.scope } });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.ROLE_CHANGED', resourceType: 'PartnerRole', resourceId: role.id, after: input, requestId });
      await partnerEvent(tx, actor.partnerId, 'PARTNER.ROLE_CHANGED', { roleId: role.id }, user.userId);
      return role;
    });
  }
  async updateRole(user: UserPrincipal, partnerId: string, roleId: string, raw: unknown, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.roles.manage');
    const input = z.strictObject({ name: name(2, 80).optional(), permissions: this.permissionsInput.optional(), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const role = await tx.partnerRole.findFirst({ where: { id: z.uuid().parse(roleId), partnerId: actor.partnerId, isDeleted: false } }); if (!role) throw notFound('Partner role');
      if (role.protected || role.code !== 'CUSTOM') throw new AppError('BUSINESS_RULE_VIOLATION', 'System Partner roles are fixed.', 422);
      assertVersion(role.version, input.expectedVersion);
      const updated = await tx.partnerRole.update({ where: { id: role.id }, data: { ...(input.name ? { name: input.name } : {}), version: { increment: 1 } } });
      if (input.permissions) {
        await tx.partnerRolePermission.deleteMany({ where: { partnerRoleId: role.id } });
        for (const p of input.permissions) await tx.partnerRolePermission.create({ data: { partnerRoleId: role.id, permissionCode: p.code, scope: p.scope } });
        await invalidatePartnerAccess(tx, actor.partnerId, 'ROLE:' + role.id);
      }
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.ROLE_CHANGED', resourceType: 'PartnerRole', resourceId: role.id, after: input, requestId });
      await partnerEvent(tx, actor.partnerId, 'PARTNER.ROLE_CHANGED', { roleId: role.id }, user.userId);
      return updated;
    });
  }
  async deleteRole(user: UserPrincipal, partnerId: string, roleId: string, requestId: string) {
    const actor = await partnerActor(this.db, user.userId, z.uuid().parse(partnerId), 'partner.roles.manage');
    return this.db.$transaction(async tx => {
      const role = await tx.partnerRole.findFirst({ where: { id: z.uuid().parse(roleId), partnerId: actor.partnerId, isDeleted: false } }); if (!role) throw notFound('Partner role');
      if (role.code !== 'CUSTOM') throw new AppError('BUSINESS_RULE_VIOLATION', 'System Partner roles cannot be deleted.', 422);
      if (await tx.partnerMembership.count({ where: { partnerRoleId: role.id, isDeleted: false } })) throw new AppError('BUSINESS_RULE_VIOLATION', 'Role is still assigned.', 422);
      await tx.partnerRole.update({ where: { id: role.id }, data: { isDeleted: true, version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, partnerId: actor.partnerId, actorId: user.userId, action: 'PARTNER.ROLE_CHANGED', resourceType: 'PartnerRole', resourceId: role.id, after: { deleted: true }, requestId });
      return { id: role.id, deleted: true };
    });
  }
  /** Memberships of the caller across Partners (a user may belong to several Partners independently). */
  async myPartners(user: UserPrincipal) {
    const rows = await this.db.partnerMembership.findMany({ where: { userId: user.userId, isDeleted: false, partner: { isDeleted: false, purgedAt: null } }, include: { partner: { select: { id: true, name: true, status: true, country: true } }, partnerRole: { select: { name: true, code: true } } } });
    return rows.map(r => ({ membershipId: r.id, partner: r.partner, role: r.partnerRole, status: r.status }));
  }
  static async notifyApplicant(tx: Tx, workspaceId: string, userId: string, title: string, message: string, eventId: string) {
    await PlatformNotificationService.emitInTx(tx, { workspaceId, recipientIds: [userId], topic: 'PARTNER', title, message, eventId });
  }
}
