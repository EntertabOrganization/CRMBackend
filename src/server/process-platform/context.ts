import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { AppError } from '../errors';
import { verifyAccessToken } from '../security';
import { sanitizeAuditPayload } from '../sanitize';
import { canonical, parse, uuid } from './dto';

export type Principal = {
  workspaceId: string;
  userId: string;
  roleId: string;
  grants: Map<string, string>;
  entitlements?: Record<string, unknown>;
};
export type Tx = Prisma.TransactionClient;

/** Shares platform identities and role data; dedicated privileges never use the legacy owner bypass. */
export async function authenticate(db: PrismaClient | Tx, request: NextRequest): Promise<Principal> {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Authentication is required.', 401);
  if (authorization.startsWith('Bearer trm_api_') && /^\/api\/v1\/spa(?:\/|$)/.test(request.nextUrl.pathname)) {
    const { authenticateDomainCredential } = await import('../intelligence/api-authority');
    return authenticateDomainCredential(db, request, request.method === 'GET' ? 'spa.read' : 'spa.write');
  }
  const userId = await verifyAccessToken(authorization.slice(7));
  const workspaceId = parse(uuid, request.headers.get('x-workspace-id'));
  return resolvePrincipal(db, workspaceId, userId);
}

/** Workers resolve current membership and explicit grants instead of persisting an authority snapshot. */
export async function resolvePrincipal(db: PrismaClient | Tx, workspaceId: string, userId: string): Promise<Principal> {
  const membership = await db.workspaceMembership.findFirst({
    where: { workspaceId, userId, status: 'ACTIVE', isDeleted: false,
      user: { isDeleted: false, status: 'ACTIVE' }, workspace: { isDeleted: false }, role: { isDeleted: false, workspaceId } },
    include: { workspace: true, role: { include: { rolePermissions: { where: { isDeleted: false }, include: { permission: true } } } } },
  });
  if (!membership) throw new AppError('PERMISSION_DENIED', 'Active Workspace membership is required.', 403);
  const grants = new Map<string, string>();
  for (const grant of membership.role.rolePermissions) {
    if (!grant.permission.isDeleted) grants.set(grant.permission.key, grant.scope);
  }
  const settings = membership.workspace.settings as Record<string, unknown>;
  const configured = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.entitlements : undefined;
  const entitlements = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown> : undefined;
  const { spaEntitlements } = await import('../spa/entitlements');
  const spa = await spaEntitlements(db, workspaceId, false);
  return { workspaceId, userId, roleId: membership.roleId, grants, entitlements: { ...entitlements, ...spa } };
}

export function requirePermission(actor: Principal, permission: string, workspaceWide = false): string {
  if (permission.startsWith('SPA.') && actor.entitlements?.spa === false)
    throw new AppError('SPA_PLAN_LIMIT', 'Smart Processes are unavailable for this Workspace.', 403);
  const scope = actor.grants.get(permission);
  if (!scope || workspaceWide && scope !== 'WORKSPACE')
    throw new AppError('PERMISSION_DENIED', `${permission} permission is required.`, 403);
  return scope;
}

/** Stable tenant-scoped advisory locks also fence missing rows and competing API processes. */
export async function lock(tx: Tx, workspaceId: string, aggregate: string) {
  // PostgreSQL returns void; expose a supported scalar so Prisma can deserialize the result.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':' + aggregate}, 0))::text`;
}

export function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new AppError('RESOURCE_VERSION_CONFLICT', 'Resource changed; reload and retry.', 409);
}

export async function evidence(tx: Tx, actor: Principal, entityType: string, entityId: string,
  eventType: string, changes: Prisma.InputJsonObject = {}, audit = true) {
  const eventId = randomUUID();
  await tx.outboxEvent.create({ data: { id: eventId, workspaceId: actor.workspaceId, entityType, entityId,
    actorUserId: actor.userId, eventType, correlationId: eventId, payload: changes } });
  if (audit) await tx.auditLog.create({ data: { workspaceId: actor.workspaceId, actorUserId: actor.userId,
    entityType, entityId, action: eventType, afterData: sanitizeAuditPayload(changes) as Prisma.InputJsonValue,
    metadata: { eventId } } });
}

/** Command result and owning business effect commit together; replay survives HTTP-key expiry. */
export async function command<T>(tx: Tx, actor: Principal, operation: string, key: string | null,
  input: unknown, effect: () => Promise<T>): Promise<T> {
  if (!key || key.length < 8 || key.length > 128)
    throw new AppError('INVALID_ARGUMENT', 'Idempotency-Key must contain 8 to 128 characters.', 400);
  const requestHash = createHash('sha256').update(canonical(input)).digest('hex');
  await lock(tx, actor.workspaceId, `command:${actor.userId}:${operation}:${key}`);
  const where = { workspaceId_actorUserId_operation_idempotencyKey: {
    workspaceId: actor.workspaceId, actorUserId: actor.userId, operation, idempotencyKey: key } };
  const prior = await tx.idempotencyRecord.findUnique({ where });
  if (prior) {
    if (prior.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Key was used with another request.', 409);
    return prior.response as T;
  }
  const result = await effect();
  const response = JSON.parse(JSON.stringify(result,(_key,value) => typeof value==='bigint' ? value.toString() : value)) as Prisma.InputJsonValue;
  await tx.idempotencyRecord.create({ data: { ...where.workspaceId_actorUserId_operation_idempotencyKey,
    requestHash, response, expiresAt: new Date(Date.now() + 86400000) } });
  return result;
}
