import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { checkRateLimit } from '../rate-limit';
import { requirePermission, type Principal } from '../process-platform/context';
import { PlatformNotificationService } from './notifications-service';
import { assertVersion, audit, bumpCacheVersion, emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, securityEvent, type DbClient, type PlatformPrincipal } from './kernel';

const MAX_SUPPORT_HOURS = 72, EMERGENCY_MINUTES = 60;
const scopeList = z.array(z.string().regex(/^[a-z][a-zA-Z0-9_.]{2,80}$/)).min(1).max(30);
/** Support grants are read-only by construction: only *.read / *.readRevision style scopes are grantable. */
const READ_ONLY = /\.(read|readRevision|inspect|list)$/;
const ownersOf = async (db: DbClient, workspaceId: string) => {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  const approvers = await db.workspaceMembership.findMany({ where: { workspaceId, status: 'ACTIVE', isDeleted: false, role: { rolePermissions: { some: { isDeleted: false, permission: { key: 'workspace.support.approve' } } } } }, select: { userId: true } });
  return [...new Set([ws?.ownerUserId, ...approvers.map(a => a.userId)].filter(Boolean) as string[])];
};

/** Immutable audit, security events and support access (30-Platform-Services/06). */
export class PlatformGovernanceService {
  constructor(private readonly db: PrismaClient) {}

  async auditQuery(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.audit.read');
    const q = pageQuery.extend({ resourceType: z.string().max(80).optional(), resourceId: z.uuid().optional(), action: z.string().max(120).optional(), workspaceId: z.uuid().optional(),
      from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).parse(raw);
    const where = { ...(q.resourceType ? { entityType: q.resourceType } : {}), ...(q.resourceId ? { entityId: q.resourceId } : {}), ...(q.action ? { action: q.action } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}) };
    const [rows, total] = await Promise.all([this.db.auditLog.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit,
      select: { id: true, workspaceId: true, partnerId: true, actorUserId: true, action: true, entityType: true, entityId: true, metadata: true, requestId: true, occurredAt: true } }), this.db.auditLog.count({ where })]);
    await this.db.$transaction(tx => audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'AUDIT_QUERIED', resourceType: 'AuditLog', resourceId: null, after: { filters: { ...q, page: undefined } } }));
    return paged(rows, total, q.page, q.limit); // metadata only: redacted payloads stay with the tenant audit viewer
  }
  async securityEvents(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.audit.read');
    const q = pageQuery.extend({ eventType: z.string().max(120).optional(), workspaceId: z.uuid().optional() }).parse(raw);
    const where = { ...(q.eventType ? { eventType: q.eventType } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) };
    const [rows, total] = await Promise.all([this.db.securityEvent.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.securityEvent.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }

  // ------------------------------------------------------------------ support access
  async requestSupport(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.support.request');
    const input = z.strictObject({ workspaceId: z.uuid(), purpose: z.string().trim().min(10).max(1000), scope: scopeList, expiresAt: z.iso.datetime({ offset: true }) }).parse(raw);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= new Date() || expiresAt.getTime() - Date.now() > MAX_SUPPORT_HOURS * 3600000) throw new AppError('VALIDATION_FAILED', `Support access expires within ${MAX_SUPPORT_HOURS} hours.`, 400, { fields: [{ field: 'expiresAt', reason: 'OUT_OF_RANGE' }] });
    if (input.scope.some(s => !READ_ONLY.test(s))) throw new AppError('VALIDATION_FAILED', 'Support access is read-only.', 400, { fields: [{ field: 'scope', reason: 'WRITE_SCOPE_NOT_GRANTABLE' }] });
    return this.db.$transaction(async tx => {
      if (!await tx.workspace.findFirst({ where: { id: input.workspaceId, isDeleted: false } })) throw notFound('Workspace');
      const grant = await tx.supportAccessGrant.create({ data: { workspaceId: input.workspaceId, platformUserId: actor.userId, purpose: input.purpose, scope: input.scope, expiresAt } });
      await audit(tx, { workspaceId: input.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'SUPPORT_ACCESS_REQUESTED', resourceType: 'SupportAccessGrant', resourceId: grant.id, after: { scope: input.scope, expiresAt }, requestId });
      await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'SUPPORT_ACCESS_REQUESTED', aggregateType: 'SupportAccessGrant', aggregateId: grant.id, aggregateVersion: 1, actorId: actor.userId, actorType: 'PLATFORM', payload: { scope: input.scope } });
      await PlatformNotificationService.emitInTx(tx, { workspaceId: input.workspaceId, recipientIds: await ownersOf(tx, input.workspaceId), topic: 'SECURITY', title: 'Support access requested', message: 'TrueCRM support requested temporary read access. Review it in Settings → Support access.', eventId: grant.id, subject: null });
      return { id: grant.id, status: grant.status, expiresAt: grant.expiresAt, note: 'No access until the workspace approves.' };
    });
  }
  async decideSupport(actor: Principal, grantId: string, raw: unknown, decision: 'approve' | 'reject' | 'revoke', requestId: string) {
    requirePermission(actor, 'workspace.support.approve');
    const input = z.strictObject({ expectedVersion: z.number().int().positive(), reason: z.string().trim().max(500).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const grant = await tx.supportAccessGrant.findFirst({ where: { workspaceId: actor.workspaceId, id: z.uuid().parse(grantId) } });
      if (!grant) throw notFound('Support access');
      assertVersion(grant.version, input.expectedVersion);
      const to = { approve: 'ACTIVE', reject: 'REJECTED', revoke: 'REVOKED' }[decision];
      const allowed: Record<string, string[]> = { REQUESTED: ['ACTIVE', 'REJECTED', 'REVOKED'], ACTIVE: ['REVOKED'] };
      if (!(allowed[grant.status] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Support access is ${grant.status}.`, 409);
      if (to === 'ACTIVE' && grant.expiresAt <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Request already expired.', 409);
      const updated = await tx.supportAccessGrant.update({ where: { id: grant.id }, data: { status: to, version: { increment: 1 }, ...(to === 'ACTIVE' ? { approvedBy: actor.userId, approvedAt: new Date() } : { revokedBy: actor.userId, revokedAt: new Date() }) } });
      const action = to === 'ACTIVE' ? 'SUPPORT_ACCESS_GRANTED' : to === 'REVOKED' ? 'SUPPORT_ACCESS_REVOKED' : 'SUPPORT_ACCESS_REJECTED';
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action, resourceType: 'SupportAccessGrant', resourceId: grant.id, before: { status: grant.status }, after: { status: to, reason: input.reason }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: action, aggregateType: 'SupportAccessGrant', aggregateId: grant.id, aggregateVersion: updated.version, actorId: actor.userId, payload: {} });
      await bumpCacheVersion(tx, 'support', `${grant.workspaceId}:${grant.platformUserId}`);
      return { id: updated.id, status: updated.status, version: updated.version };
    });
  }
  async supportHistory(actor: Principal) {
    requirePermission(actor, 'workspace.support.approve');
    return this.db.supportAccessGrant.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { requestedAt: 'desc' }, take: 200 });
  }
  /** Gate for any platform read of tenant content. Expired grants are denied on the next read, cached sessions notwithstanding. */
  static async assertSupportAccess(db: DbClient, platformUserId: string, workspaceId: string, permission: string) {
    const grants = await db.supportAccessGrant.findMany({ where: { workspaceId, platformUserId, status: 'ACTIVE' } });
    const now = new Date(), live = grants.find(g => g.expiresAt > now && (g.scope as string[]).includes(permission));
    for (const g of grants.filter(g => g.expiresAt <= now)) await db.supportAccessGrant.updateMany({ where: { id: g.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', version: { increment: 1 } } });
    if (!live) {
      await securityEvent(db, { workspaceId, principalId: platformUserId, eventType: 'SUPPORT_ACCESS_DENIED', risk: 'MEDIUM', details: { permission } });
      throw new AppError('PERMISSION_DENIED', 'An active, customer-approved support grant is required.', 403);
    }
    return live;
  }
  /** Read-only principal limited to the grant scope (never a WorkspaceMembership). */
  static async supportPrincipal(db: DbClient, platformUserId: string, workspaceId: string, permission: string): Promise<Principal> {
    const grant = await PlatformGovernanceService.assertSupportAccess(db, platformUserId, workspaceId, permission);
    return { workspaceId, userId: platformUserId, roleId: 'support:' + grant.id, grants: new Map((grant.scope as string[]).map(s => [s, 'WORKSPACE'])) };
  }

  // ------------------------------------------------------------------ break-glass (dual control)
  async emergency(actor: PlatformPrincipal, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.breakglass.invoke'); requireStepUp(actor, mfa);
    const input = z.strictObject({ workspaceId: z.uuid(), reason: z.string().trim().min(20).max(1000), incidentRef: z.string().trim().min(3).max(120), scope: scopeList }).parse(raw);
    if (input.scope.some(s => !READ_ONLY.test(s))) throw new AppError('VALIDATION_FAILED', 'Emergency access is read-only.', 400);
    return this.db.$transaction(async tx => {
      const session = await tx.emergencySupportSession.create({ data: { workspaceId: input.workspaceId, platformUserId: actor.userId, reason: input.reason, incidentRef: input.incidentRef, expiresAt: new Date(Date.now() + EMERGENCY_MINUTES * 60000) } });
      await tx.supportAccessGrant.create({ data: { id: session.id, workspaceId: input.workspaceId, platformUserId: actor.userId, purpose: 'EMERGENCY: ' + input.incidentRef, scope: input.scope, status: 'REQUESTED', emergency: true, expiresAt: session.expiresAt } });
      await securityEvent(tx, { workspaceId: input.workspaceId, principalId: actor.userId, eventType: 'BREAKGLASS_REQUESTED', risk: 'CRITICAL', details: { incidentRef: input.incidentRef }, requestId });
      return { id: session.id, status: session.status, note: 'A second platform approver is required.' };
    });
  }
  async approveEmergency(actor: PlatformPrincipal, sessionId: string, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.breakglass.approve'); requireStepUp(actor, mfa);
    return this.db.$transaction(async tx => {
      const session = await tx.emergencySupportSession.findUnique({ where: { id: z.uuid().parse(sessionId) } });
      if (!session) throw notFound('Emergency session');
      if (session.platformUserId === actor.userId) throw new AppError('PERMISSION_DENIED', 'A different platform approver is required.', 403);
      if (session.status !== 'PENDING_SECOND_APPROVAL') throw new AppError('INVALID_STATE_TRANSITION', `Session is ${session.status}.`, 409);
      await tx.emergencySupportSession.update({ where: { id: session.id }, data: { status: 'ACTIVE', secondApproverId: actor.userId, grantId: session.id, customerNotifiedAt: new Date() } });
      await tx.supportAccessGrant.update({ where: { id: session.id }, data: { status: 'ACTIVE', approvedBy: actor.userId, approvedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, { workspaceId: session.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BREAKGLASS_SESSION_STARTED', resourceType: 'EmergencySupportSession', resourceId: session.id, after: { incidentRef: session.incidentRef, expiresAt: session.expiresAt }, requestId });
      // Customer-facing trace: workspace owners are notified (mandatory SECURITY topic).
      await PlatformNotificationService.emitInTx(tx, { workspaceId: session.workspaceId, recipientIds: await ownersOf(tx, session.workspaceId), topic: 'SECURITY', title: 'Emergency support access started', message: `Incident ${session.incidentRef}: temporary read-only access for up to ${EMERGENCY_MINUTES} minutes.`, eventId: 'breakglass:' + session.id });
      return { id: session.id, status: 'ACTIVE', expiresAt: session.expiresAt };
    });
  }
  async reviewEmergency(actor: PlatformPrincipal, sessionId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.breakglass.approve');
    const input = z.strictObject({ note: z.string().trim().min(10).max(4000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const session = await tx.emergencySupportSession.findUnique({ where: { id: z.uuid().parse(sessionId) } });
      if (!session) throw notFound('Emergency session');
      if (session.reviewedAt) throw new AppError('INVALID_STATE_TRANSITION', 'Session already reviewed.', 409);
      await tx.emergencySupportSession.update({ where: { id: session.id }, data: { reviewedAt: new Date(), reviewedBy: actor.userId, reviewNote: input.note, status: 'REVIEWED' } });
      await tx.supportAccessGrant.updateMany({ where: { id: session.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', version: { increment: 1 } } });
      await audit(tx, { workspaceId: session.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: 'BREAKGLASS_REVIEWED', resourceType: 'EmergencySupportSession', resourceId: session.id, after: { reviewed: true }, requestId });
      return { id: session.id, reviewed: true };
    });
  }

  // ------------------------------------------------------------------ 08 rate limits, idempotency, caches
  async rateLimits(actor: PlatformPrincipal) { requirePlatform(actor, 'platform.rateLimit.manage'); return this.db.rateLimitPolicy.findMany({ orderBy: [{ operationCode: 'asc' }, { principalScope: 'asc' }] }); }
  async setRateLimit(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.rateLimit.manage');
    const input = z.strictObject({ operationCode: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/), principalScope: z.enum(['USER', 'IP', 'WORKSPACE', 'PROVIDER', 'PARTNER']), requests: z.number().int().min(1).max(1000000), windowSeconds: z.number().int().min(1).max(86400), burst: z.number().int().min(0).max(100000).default(0), riskClass: z.enum(['STANDARD', 'HIGH', 'CRITICAL']).default('STANDARD') }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.rateLimitPolicy.upsert({ where: { operationCode_principalScope: { operationCode: input.operationCode, principalScope: input.principalScope } }, create: input, update: { ...input, version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'RATE_LIMIT_POLICY_CHANGED', resourceType: 'RateLimitPolicy', resourceId: row.id, after: input, requestId });
      policyCache.delete(input.operationCode + ':' + input.principalScope);
      return row;
    });
  }
  async idempotencyRecord(actor: PlatformPrincipal, id: string) {
    requirePlatform(actor, 'platform.rateLimit.manage');
    const row = await this.db.platformIdempotencyKey.findUnique({ where: { id: z.uuid().parse(id) }, select: { id: true, operationCode: true, state: true, createdAt: true, expiresAt: true, lockedUntil: true } });
    if (!row) throw notFound('Idempotency record'); return row; // metadata only, never the stored response
  }
  async invalidateCache(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.cache.invalidate');
    const input = z.strictObject({ namespace: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/), scopeId: z.string().min(1).max(120), reason: z.string().trim().min(1).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      await bumpCacheVersion(tx, input.namespace, input.scopeId);
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'CACHE_VERSION_INVALIDATED', resourceType: 'CacheVersion', resourceId: null, after: input, requestId });
      return { namespace: input.namespace, scopeId: input.scopeId, invalidated: true };
    });
  }
}

const policyCache = new Map<string, { at: number; policy: { requests: number; windowSeconds: number } | null }>();
/** Enforces a configured policy before expensive work; falls back to the given default. 429 carries Retry-After. */
export async function enforceRateLimit(db: DbClient, operationCode: string, principalScope: 'USER' | 'IP' | 'WORKSPACE' | 'PROVIDER' | 'PARTNER', principalKey: string, fallback: { requests: number; windowSeconds: number }) {
  const cacheKey = operationCode + ':' + principalScope; let cached = policyCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > 60000) {
    const row = await db.rateLimitPolicy.findUnique({ where: { operationCode_principalScope: { operationCode, principalScope } } });
    cached = { at: Date.now(), policy: row ? { requests: row.requests + row.burst, windowSeconds: row.windowSeconds } : null }; policyCache.set(cacheKey, cached);
  }
  const policy = cached.policy ?? fallback;
  try { checkRateLimit(principalScope + ':' + principalKey, { scope: operationCode, limit: policy.requests, windowMs: policy.windowSeconds * 1000 }); }
  catch (error) { await securityEvent(db, { eventType: 'RATE_LIMIT_TRIGGERED', details: { operationCode, principalScope } }).catch(() => null); throw error; }
}
