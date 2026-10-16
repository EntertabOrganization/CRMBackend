import { Prisma, type PrismaClient } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { command, evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { canonical, parse, uuid } from '../process-platform/dto';

/**
 * Shared kernel for the Commerce/Marketing/HR/Sites business suite. Every command runs:
 * resolve current membership -> entitlement -> permission/scope -> tenant-scoped lock ->
 * authoritative change + audit + outbox in ONE PostgreSQL transaction.
 */
export type SuiteModule = 'commerce' | 'marketing' | 'hr' | 'sites';
export { parse, uuid, canonical, lock, evidence, requirePermission, resolvePrincipal, ownerVisible };
export type { Principal, Tx };

export const expectedVersion = z.coerce.number().int().positive().max(2147483647);
export const isoInstant = z.iso.datetime({ offset: true }).transform(v => new Date(v));
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v), 'A valid local DATE is required');
export const ianaZone = z.string().min(1).max(64).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'A valid IANA timezone is required');
export const reason = z.string().trim().min(1).max(500);
export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  status: z.string().trim().max(40).optional(),
}).passthrough();

export function paged<T>(rows: T[], total: number, page: number, limit: number) {
  return { data: rows, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new AppError('VERSION_CONFLICT', 'Resource changed; reload and retry.', 409, { currentVersion: actual });
}

export function transition<S extends string>(machine: Record<string, readonly S[]>, from: string, to: S) {
  if (!(machine[from] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Cannot move from ${from} to ${to}.`, 409, { from, to });
  return to;
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} was not found.`, 404);
export const policyMissing = (what: string) => new AppError('POLICY_NOT_CONFIGURED', `${what} must be configured before this operation.`, 409);

/** Subscription entitlement seam: workspace.settings.entitlements[capability] === false denies new premium actions. */
export function entitled(actor: Principal, capability: string) {
  const value = actor.entitlements?.[capability];
  if (value === false) throw new AppError('PERMISSION_DENIED', `${capability} is unavailable for this Workspace subscription.`, 403);
  return value;
}

/** Execute a workspace command with refreshed authority. */
export async function inTx<T>(db: PrismaClient, actor: Principal, fn: (tx: Tx, actor: Principal) => Promise<T>, locks: string[] = []): Promise<T> {
  return db.$transaction(async tx => {
    for (const name of locks) await lock(tx, actor.workspaceId, name);
    const current = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
    return fn(tx, current);
  }, { timeout: 60000 });
}

/** Idempotent command (workspace, actor, operation, key, request hash). */
export function idempotent<T>(tx: Tx, actor: Principal, operation: string, key: string | null, input: unknown, effect: () => Promise<T>) {
  return command(tx, actor, operation, key, input, effect);
}

/** Scope check of a record owned by a user (OWN/DEPARTMENT/DEPARTMENT_TREE/WORKSPACE). */
export async function scoped(tx: Tx, actor: Principal, ownerUserId: string | null | undefined, permission: string) {
  requirePermission(actor, permission);
  if (!ownerUserId) return actor.grants.get(permission) === 'WORKSPACE';
  return ownerVisible(tx, actor, ownerUserId, permission);
}

export const emit = evidence;

/** Public/customer/system events: outbox + audit without an employee actor. */
export async function systemEvent(tx: Tx, workspaceId: string, entityType: string, entityId: string, eventType: string, payload: Prisma.InputJsonObject = {}, audit = true) {
  const event = await tx.outboxEvent.create({ data: { workspaceId, entityType, entityId, eventType, payload, correlationId: entityId } });
  if (audit) await tx.auditLog.create({ data: { workspaceId, entityType, entityId, action: eventType, afterData: payload, metadata: { eventId: event.id, actorType: 'SYSTEM_OR_PUBLIC' } } });
  return event;
}

export function newToken(prefix = '') { return prefix + randomBytes(32).toString('base64url'); }
export function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function requestHash(input: unknown) { return sha256(canonical(input)); }

function keyMaterial(name: string) {
  const configured = process.env.SUITE_DATA_KEY;
  if (!configured && process.env.NODE_ENV === 'production') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Data protection key is not configured.', 503);
  return createHash('sha256').update(name + ':' + (configured ?? process.env.JWT_ACCESS_SECRET ?? 'local-suite-development-key')).digest();
}
/** Keyed, non-reversible destination hash (email/phone) used for dedupe, suppression and consent. */
export function destinationHash(channel: string, normalized: string) {
  return createHmac('sha256', keyMaterial('destination-hash')).update(channel + ':' + normalized).digest('hex');
}
/** AES-256-GCM encryption for PII and confidential HR fields; never logged or evented. */
export function encrypt(plain: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyMaterial('field-encryption'), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return 'v1.' + iv.toString('base64url') + '.' + cipher.getAuthTag().toString('base64url') + '.' + body.toString('base64url');
}
export function decrypt(sealed: string | null | undefined) {
  if (!sealed) return null;
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new AppError('INTERNAL_ERROR', 'Protected value is unreadable.', 500);
  const decipher = createDecipheriv('aes-256-gcm', keyMaterial('field-encryption'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
export function maskDestination(channel: string, value: string) {
  if (channel === 'EMAIL') { const [user, domain] = value.split('@'); return (user?.slice(0, 1) ?? '') + '***@' + (domain ?? ''); }
  return value.slice(0, 3) + '***' + value.slice(-2);
}
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function normalizeDestination(channel: string, raw: string) {
  const value = raw.trim();
  if (channel === 'EMAIL') {
    const email = value.toLowerCase();
    if (!/^[^\s@<>"']{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) return null;
    return email;
  }
  const phone = value.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

/** Deterministic allocation in [0,100) used for experiments (stable per seed + subject). */
export function bucket(seed: string, subject: string) {
  return parseInt(sha256(seed + ':' + subject).slice(0, 8), 16) % 10000 / 100;
}
export function allocate<T extends { id: string; percent: number }>(variants: T[], seed: string, subject: string) {
  const point = bucket(seed, subject); let cursor = 0;
  for (const variant of [...variants].sort((a, b) => a.id.localeCompare(b.id))) { cursor += variant.percent; if (point < cursor) return variant; }
  return variants[variants.length - 1];
}
export function assertAllocation(percentages: number[]) {
  if (percentages.length < 2) throw new AppError('VALIDATION_FAILED', 'At least two variants are required.', 400, { fields: [{ field: 'variants', reason: 'MIN_TWO' }] });
  const total = Math.round(percentages.reduce((a, b) => a + b, 0) * 100) / 100;
  if (total !== 100) throw new AppError('VALIDATION_FAILED', 'Variant allocations must total exactly 100.', 400, { fields: [{ field: 'variants', reason: 'ALLOCATION_NOT_100', total }] });
}

/** Local wall time in an IANA zone -> UTC instant (resolves DST gaps forward, overlaps to the first instant). */
export function zonedInstant(date: string, time: string, zone: string) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMinutes(new Date(guess), zone);
    const candidate = Date.UTC(y, m - 1, d, hh, mm) - offset * 60000;
    if (candidate === guess) break; guess = candidate;
  }
  return new Date(guess);
}
export function zoneOffsetMinutes(at: Date, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at.getTime() / 1000) * 1000) / 60000;
}
export function localDateOf(at: Date, zone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
export function addLocalDays(date: string, days: number) {
  const t = new Date(date + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10);
}
export function dateRange(from: string, to: string) {
  const out: string[] = []; for (let d = from; d <= to; d = addLocalDays(d, 1)) out.push(d); return out;
}
export function weekday(date: string) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
export const asDate = (value: string) => new Date(value + 'T00:00:00Z');
export const fromDate = (value: Date) => value.toISOString().slice(0, 10);

/** Inbound text sanitizer: rejects executable markup, returns inert text. */
export function assertNoExecutable(value: unknown, path = 'value'): void {
  if (typeof value === 'string') {
    if (/<\s*script|javascript:|vbscript:|data:text\/html|\bon[a-z]+\s*=|<\s*iframe|<\s*object|<\s*embed|expression\s*\(|@import/i.test(value))
      throw new AppError('VALIDATION_FAILED', 'Executable content is not allowed.', 400, { fields: [{ field: path, reason: 'EXECUTABLE_CONTENT' }] });
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoExecutable(v, path + '[' + i + ']')); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoExecutable(v, path + '.' + k);
}
export function safeUrl(value: string, allowRelative = true) {
  if (allowRelative && /^\/(?!\/)[^\s]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) throw new Error();
    return url.toString();
  } catch { throw new AppError('VALIDATION_FAILED', 'URL is not allowed.', 400, { fields: [{ field: 'url', reason: 'UNSAFE_URL' }] }); }
}
export function json<T>(value: T) { return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v)) as Prisma.InputJsonValue; }
export { uuid as uuidSchema };
export function id(raw: string) { return parse(uuid, raw); }
