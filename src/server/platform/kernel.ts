import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { sanitizeAuditPayload } from '../sanitize';
import { verifyAccessToken } from '../security';
import { canonical } from '../process-platform/dto';
import type { Principal, Tx } from '../process-platform/context';

/**
 * Final-pack platform kernel (30-Platform-Services). Shared by Billing, Partner, Knowledge and AI:
 * - platform principals (platform.* grants only, never tenant data access)
 * - versioned domain events written in the SAME transaction as the business change
 * - redacted audit + security events (append-only)
 * - durable idempotent commands with canonical request hashes and tenant/actor-scoped keys
 */
export type { Principal, Tx };
export type DbClient = PrismaClient | Tx;
export type PlatformPrincipal = { userId: string; role: string; permissions: Set<string>; mfaRequired: boolean };
export type UserPrincipal = { userId: string };

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const requestHash = (input: unknown) => sha256(canonical(input ?? null));
export const uuid = z.uuid();

// ------------------------------------------------------------------ principals
export async function authenticateUser(authorization: string | null): Promise<UserPrincipal> {
  if (!authorization?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Authentication is required.', 401);
  return { userId: await verifyAccessToken(authorization.slice(7)) };
}
export async function resolvePlatformPrincipal(db: DbClient, userId: string): Promise<PlatformPrincipal> {
  const row = await db.platformRoleAssignment.findUnique({ where: { userId } });
  if (!row || !row.active || row.revokedAt) throw new AppError('PERMISSION_DENIED', 'Platform role is required.', 403);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.isDeleted || user.status !== 'ACTIVE') throw new AppError('PERMISSION_DENIED', 'Platform role is required.', 403);
  return { userId, role: row.role, permissions: new Set((row.permissions as string[]) ?? []), mfaRequired: row.mfaRequired };
}
export async function isPlatformActor(db: DbClient, userId: string, permission: string) {
  try { return (await resolvePlatformPrincipal(db, userId)).permissions.has(permission); } catch { return false; }
}
export function requirePlatform(actor: PlatformPrincipal, permission: string) {
  if (!actor.permissions.has(permission)) throw new AppError('PERMISSION_DENIED', `${permission} permission is required.`, 403);
}
/** High-risk platform actions need step-up MFA. No MFA verifier is integrated yet, so they fail closed (decision D5). */
export function requireStepUp(actor: PlatformPrincipal, assertion: string | null) {
  if (!actor.mfaRequired) return;
  const verifierSecret = process.env.PLATFORM_MFA_VERIFIER_SECRET;
  if (!verifierSecret) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Step-up MFA verifier is not configured for high-risk platform actions.', 503);
  // Assertion format issued by the MFA service: `<userId>.<expiresEpoch>.<hmac>`.
  const [userId, expires, mac] = (assertion ?? '').split('.');
  const expected = createHmac('sha256', verifierSecret).update(`${userId}.${expires}`).digest('hex');
  if (userId !== actor.userId || Number(expires) * 1000 < Date.now() || !mac || mac !== expected)
    throw new AppError('PERMISSION_DENIED', 'A recent step-up MFA assertion is required.', 403);
}

// ------------------------------------------------------------------ events
export type EventInput = {
  workspaceId: string | null; eventType: string; aggregateType: string; aggregateId: string; aggregateVersion?: number | null;
  actorId?: string | null; actorType?: 'USER' | 'SERVICE' | 'PLATFORM'; payload?: Record<string, unknown>; correlationId?: string | null; causationId?: string | null;
  audience?: 'GLOBAL' | 'PARTNER'; partnerId?: string | null; eventVersion?: number;
};
const FORBIDDEN_PAYLOAD = /password|secret|token|apiKey|cardNumber|cvv|prompt|body|content/i;
/** Payloads carry references and safe minimal context only (Shared-Contracts/04). */
export function safePayload(payload: Record<string, unknown> = {}) {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (!FORBIDDEN_PAYLOAD.test(k)) clean[k] = typeof v === 'bigint' ? v.toString() : v instanceof Prisma.Decimal ? v.toFixed() : v;
  return JSON.parse(JSON.stringify(clean)) as Prisma.InputJsonObject;
}
export async function emitEvent(tx: Tx, input: EventInput) {
  const id = randomUUID(), correlationId = input.correlationId ?? id;
  if (input.workspaceId) {
    await tx.outboxEvent.create({ data: { id, workspaceId: input.workspaceId, eventType: input.eventType, entityType: input.aggregateType, entityId: input.aggregateId,
      aggregateVersion: input.aggregateVersion ?? null, actorUserId: input.actorType === 'SERVICE' ? null : input.actorId ?? null, eventVersion: input.eventVersion ?? 1,
      correlationId, causationId: input.causationId ?? null, payload: safePayload(input.payload) } });
  } else {
    await tx.platformGlobalEvent.create({ data: { id, audience: input.audience ?? 'GLOBAL', eventType: input.eventType, eventVersion: input.eventVersion ?? 1, aggregateType: input.aggregateType,
      aggregateId: input.aggregateId, aggregateVersion: input.aggregateVersion ?? null, partnerId: input.partnerId ?? null, actorType: input.actorType ?? 'USER', actorId: input.actorId ?? null,
      payload: safePayload(input.payload), correlationId, causationId: input.causationId ?? null } });
  }
  return id;
}
export type AuditInput = { workspaceId: string | null; partnerId?: string | null; actorId: string | null; actorType?: 'USER' | 'SERVICE' | 'PLATFORM'; action: string; resourceType: string; resourceId: string | null;
  before?: unknown; after?: unknown; requestId?: string | null };
/** Redacted, append-only audit (DB trigger forbids UPDATE/DELETE). Stores redacted delta + before/after hashes. */
export async function audit(tx: Tx, input: AuditInput) {
  const before = input.before === undefined ? null : sanitizeAuditPayload(input.before), after = input.after === undefined ? null : sanitizeAuditPayload(input.after);
  await tx.auditLog.create({ data: { workspaceId: input.workspaceId, partnerId: input.partnerId ?? null, actorUserId: input.actorType === 'SERVICE' ? null : input.actorId,
    action: input.action, entityType: input.resourceType, entityId: input.resourceId, beforeData: before as Prisma.InputJsonValue ?? Prisma.DbNull, afterData: after as Prisma.InputJsonValue ?? Prisma.DbNull,
    requestId: input.requestId ?? null, metadata: { actorType: input.actorType ?? 'USER', beforeHash: before === null ? null : sha256(JSON.stringify(before)), afterHash: after === null ? null : sha256(JSON.stringify(after)) } } });
}
/** Audit + event in the caller's transaction: either both commit with the business change or neither does. */
export async function record(tx: Tx, input: AuditInput & Omit<EventInput, 'workspaceId' | 'aggregateType' | 'aggregateId'> & { audit?: boolean }) {
  if (input.audit !== false) await audit(tx, input);
  return emitEvent(tx, { ...input, workspaceId: input.workspaceId, aggregateType: input.resourceType, aggregateId: input.resourceId!, payload: input.payload ?? (input.after as Record<string, unknown> | undefined) });
}
export async function securityEvent(db: DbClient, input: { workspaceId?: string | null; principalId?: string | null; eventType: string; risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; details?: Record<string, unknown>; requestId?: string | null }) {
  await db.securityEvent.create({ data: { workspaceId: input.workspaceId ?? null, principalId: input.principalId ?? null, eventType: input.eventType, risk: input.risk ?? 'LOW', details: safePayload(input.details), requestId: input.requestId ?? null } });
}

// ------------------------------------------------------------------ idempotency (30-Platform-Services/08)
/**
 * Durable command idempotency. Scope = tenant/partner/platform + actor, so equal keys in two tenants never collide.
 * Same key + same canonical request returns the stored response; a changed request is 409 IDEMPOTENCY_CONFLICT.
 * The claim row commits in the same transaction as the effect, so a rolled-back effect leaves no claim.
 */
export async function idempotentCommand<T>(tx: Tx, scope: { scopeKey: string; operation: string; key: string | null; input: unknown; required?: boolean; ttlHours?: number }, effect: () => Promise<T>): Promise<T> {
  if (!scope.key) { if (scope.required) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header is required for this operation.', 400, { fields: [{ field: 'Idempotency-Key', reason: 'REQUIRED' }] }); return effect(); }
  if (scope.key.length < 8 || scope.key.length > 200) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 8 to 200 characters.', 400);
  const keyHash = sha256(scope.key), hash = requestHash(scope.input);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.scopeKey + ':' + scope.operation + ':' + keyHash}, 0))::text`;
  const prior = await tx.platformIdempotencyKey.findUnique({ where: { scopeKey_operationCode_keyHash: { scopeKey: scope.scopeKey, operationCode: scope.operation, keyHash } } });
  if (prior && prior.expiresAt > new Date()) {
    if (prior.requestHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request.', 409);
    if (prior.state === 'SUCCEEDED') return prior.response as T;
  }
  const result = await effect();
  const data = { requestHash: hash, state: 'SUCCEEDED', response: JSON.parse(JSON.stringify(result ?? null, (_k, v) => typeof v === 'bigint' ? v.toString() : v)) as Prisma.InputJsonValue,
    lockedUntil: new Date(), expiresAt: new Date(Date.now() + (scope.ttlHours ?? 72) * 3600000) };
  await tx.platformIdempotencyKey.upsert({ where: { scopeKey_operationCode_keyHash: { scopeKey: scope.scopeKey, operationCode: scope.operation, keyHash } },
    create: { scopeKey: scope.scopeKey, operationCode: scope.operation, keyHash, ...data }, update: data });
  return result;
}
export const workspaceScope = (actor: { workspaceId: string; userId: string }) => `ws:${actor.workspaceId}:${actor.userId}`;

// ------------------------------------------------------------------ cache versions (permission freshness)
export async function bumpCacheVersion(tx: Tx, namespace: string, scopeId: string) {
  await tx.cacheVersion.upsert({ where: { namespace_scopeId: { namespace, scopeId } }, create: { namespace, scopeId, version: 2 }, update: { version: { increment: 1 }, invalidatedAt: new Date() } });
}
export async function cacheVersion(db: DbClient, namespace: string, scopeId: string) {
  return (await db.cacheVersion.findUnique({ where: { namespace_scopeId: { namespace, scopeId } } }))?.version ?? 1;
}

// ------------------------------------------------------------------ lists
export const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().max(500).optional() }).passthrough();
export function paged<T>(data: T[], total: number, page: number, limit: number) { return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } }; }
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} was not found.`, 404);
export function transition(machine: Record<string, readonly string[]>, from: string, to: string) {
  if (!(machine[from] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Cannot move from ${from} to ${to}.`, 409);
}
export function assertVersion(actual: number, expected: number | undefined) {
  if (expected === undefined || actual !== expected) throw new AppError('VERSION_CONFLICT', 'Resource changed; reload and retry.', 409, { currentVersion: actual });
}
export const expectedVersion = z.coerce.number().int().positive();
export async function advisoryLock(tx: Tx, scope: string, aggregate: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ':' + aggregate}, 0))::text`;
}
export function inTransaction<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>, timeout = 60000) { return db.$transaction(fn, { timeout }); }
