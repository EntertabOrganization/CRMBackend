import { Prisma, type PrismaClient } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { DeterministicPaymentAdapter, PaymentProviderRegistry, StripePaymentAdapter, UnconfiguredPaymentAdapter, XPayPaymentAdapter, type PaymentProviderAdapter } from '../commercial/payment-providers';
import { PlatformConfigService } from '../platform/config-service';
import { audit, bumpCacheVersion, emitEvent, type DbClient, type Tx } from '../platform/kernel';

export type { Tx, DbClient };
export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const ZERO = D(0);
const THREE_DIGIT = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']), ZERO_DIGIT = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
export const minorUnits = (currency: string) => ZERO_DIGIT.has(currency) ? 0 : THREE_DIGIT.has(currency) ? 3 : 2;
/** ROUND_HALF_UP at the ISO-4217 minor unit; never JS floats for persisted money. */
export const money = (value: Prisma.Decimal.Value, currency: string) => D(value).toDecimalPlaces(minorUnits(currency), Prisma.Decimal.ROUND_HALF_UP);
export const units = (value: Prisma.Decimal.Value) => D(value).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
/** Basis-point discount per shared contract 06: discount = ROUND_HALF_UP(base * bps / 10000). */
export function applyBps(base: Prisma.Decimal.Value, bps: number, currency: string) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new AppError('VALIDATION_FAILED', 'Basis points must be 0..10000.', 400);
  const discount = money(D(base).mul(bps).div(10000), currency);
  return { discount, net: money(D(base).sub(discount), currency) };
}
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const decimalString = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().nonnegative()]).transform(v => D(v));
export const GRACE_DAYS_DEFAULT = 15, TRIAL_DAYS_DEFAULT = 14, QUOTE_TTL_MINUTES = 30;
export const LIVE_STATUSES = ['FREE', 'TRIALING', 'PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCEL_PENDING'] as const;
/** Statuses that keep paid plan entitlements; GRACE preserves service (07 rule 1). */
export const ENTITLED_STATUSES = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCEL_PENDING']);
export const SUBSCRIPTION_MACHINE: Record<string, string[]> = {
  FREE: ['TRIALING', 'PENDING_PAYMENT'], TRIALING: ['ACTIVE', 'EXPIRED', 'PENDING_PAYMENT'], PENDING_PAYMENT: ['ACTIVE', 'EXPIRED'],
  ACTIVE: ['PAST_DUE', 'CANCEL_PENDING', 'CANCELLED'], PAST_DUE: ['GRACE', 'ACTIVE'], GRACE: ['ACTIVE', 'EXPIRED'], CANCEL_PENDING: ['CANCELLED', 'ACTIVE'], EXPIRED: ['ACTIVE'],
};
export function assertTransition(from: string, to: string) {
  if (!(SUBSCRIPTION_MACHINE[from] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Subscription cannot move from ${from} to ${to}.`, 409);
}
export const graceDays = (db: DbClient) => PlatformConfigService.platformSetting<number>(db, 'graceDays', GRACE_DAYS_DEFAULT);
export const trialDays = (db: DbClient) => PlatformConfigService.platformSetting<number>(db, 'trialDays', TRIAL_DAYS_DEFAULT);
export function addPeriod(start: Date, period: string) {
  const d = new Date(start);
  if (period === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
export const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/** Service identity for `/internal/billing/*` (shared INTERNAL_JOB_TOKEN; never a browser credential). */
export function assertServiceIdentity(header: string | null) {
  const given = (header ?? '').replace(/^Bearer\s+/i, '');
  if (!given) throw new AppError('UNAUTHENTICATED', 'Service identity is required.', 401);
  const expected = process.env.INTERNAL_JOB_TOKEN ?? '';
  if (!expected) throw new AppError('DEPENDENCY_UNAVAILABLE', 'INTERNAL_JOB_TOKEN is not configured.', 503);
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new AppError('UNAUTHENTICATED', 'Service identity is required.', 401);
}

// ------------------------------------------------------------------ SaaS payment providers (separate credentials from Commerce)
let registry: PaymentProviderRegistry | null = null;
export function billingProviders(): PaymentProviderRegistry {
  if (registry) return registry;
  const r = new PaymentProviderRegistry(), env = process.env;
  r.register(env.BILLING_STRIPE_SECRET_KEY && env.BILLING_STRIPE_WEBHOOK_SECRET ? new StripePaymentAdapter(env.BILLING_STRIPE_SECRET_KEY, env.BILLING_STRIPE_WEBHOOK_SECRET, env.BILLING_STRIPE_ACCOUNT_ID ?? 'truecrm') : new UnconfiguredPaymentAdapter('stripe'));
  r.register(env.BILLING_XPAY_SECRET_KEY && env.BILLING_XPAY_WEBHOOK_SECRET && env.BILLING_XPAY_ACCOUNT_ID
    ? new XPayPaymentAdapter(env.BILLING_XPAY_SECRET_KEY, env.BILLING_XPAY_WEBHOOK_SECRET, env.BILLING_XPAY_ACCOUNT_ID, env.BILLING_XPAY_RETURN_URL ?? (env.APP_URL ?? '') + '/billing', env.BILLING_XPAY_API_BASE ?? 'https://api.xpay.app') : new UnconfiguredPaymentAdapter('xpay'));
  // Deterministic sandbox for non-production environments only (never accepted in production).
  if (env.BILLING_SANDBOX_SECRET && env.NODE_ENV !== 'production') r.register(new DeterministicPaymentAdapter('sandbox', env.BILLING_SANDBOX_SECRET, 'truecrm-sandbox', true));
  return (registry = r);
}
/** Test seam: replaces the provider registry (e.g. with sandbox adapters exposing duplicate/failure scenarios). */
export function setBillingProviders(next: PaymentProviderRegistry | null) { registry = next; }
export const provider = (key: string): PaymentProviderAdapter => billingProviders().get(key);

// ------------------------------------------------------------------ entitlement definitions & projection
export type DefinitionSeed = { code: string; valueType: 'BOOLEAN' | 'INTEGER' | 'DECIMAL' | 'SET'; defaultValue: unknown; quotaKind: 'NONE' | 'COUNT' | 'USAGE' | 'CREDIT'; description: string };
/** Capability codes consumed by domain modules (never plan names). Platform admins may add more via the API. */
export const BUILTIN_DEFINITIONS: DefinitionSeed[] = [
  { code: 'commerce', valueType: 'BOOLEAN', defaultValue: false, quotaKind: 'NONE', description: 'Online store & commerce' },
  { code: 'commerce.stores.max', valueType: 'INTEGER', defaultValue: 0, quotaKind: 'COUNT', description: 'Active online stores' },
  { code: 'sites', valueType: 'BOOLEAN', defaultValue: false, quotaKind: 'NONE', description: 'Sites & landing pages' },
  { code: 'sites.max', valueType: 'INTEGER', defaultValue: 0, quotaKind: 'COUNT', description: 'Sites' },
  { code: 'marketing', valueType: 'BOOLEAN', defaultValue: false, quotaKind: 'NONE', description: 'Marketing campaigns' },
  { code: 'marketing.messages.monthly', valueType: 'INTEGER', defaultValue: 0, quotaKind: 'USAGE', description: 'Marketing messages per billing period' },
  { code: 'hr', valueType: 'BOOLEAN', defaultValue: false, quotaKind: 'NONE', description: 'HR & time tracking' },
  { code: 'hr.employees.max', valueType: 'INTEGER', defaultValue: 0, quotaKind: 'COUNT', description: 'Employee records' },
  { code: 'users.seats', valueType: 'INTEGER', defaultValue: 1, quotaKind: 'COUNT', description: 'Active workspace members' },
  { code: 'storage.gb', valueType: 'DECIMAL', defaultValue: 1, quotaKind: 'COUNT', description: 'File storage (GB)' },
  { code: 'knowledge', valueType: 'BOOLEAN', defaultValue: false, quotaKind: 'NONE', description: 'Knowledge base' },
  { code: 'ai', valueType: 'BOOLEAN', defaultValue: false, quotaKind: 'NONE', description: 'AI CoPilot' },
  { code: 'ai.credits', valueType: 'DECIMAL', defaultValue: 0, quotaKind: 'CREDIT', description: 'Plan-included AI credits per period (credit-ledger backed)' },
  { code: 'api.requests.monthly', valueType: 'INTEGER', defaultValue: 0, quotaKind: 'USAGE', description: 'Public API requests per billing period' },
];
const LEGACY_QUOTA_ALIASES: Record<string, string> = { 'sites.max': 'sitesLimit', 'commerce.stores.max': 'commerceStoreLimit', 'hr.employees.max': 'hrEmployeeLimit' };
export async function ensureDefinitions(db: DbClient) {
  const count = await db.billingEntitlementDefinition.count();
  if (count >= BUILTIN_DEFINITIONS.length) return;
  for (const d of BUILTIN_DEFINITIONS) await db.billingEntitlementDefinition.upsert({ where: { code: d.code }, create: { ...d, defaultValue: d.defaultValue as Prisma.InputJsonValue }, update: {} });
}
export function validateEntitlementValue(def: { code: string; valueType: string; minValue: Prisma.Decimal | null; maxValue: Prisma.Decimal | null }, value: unknown) {
  const bad = (reason: string) => new AppError('VALIDATION_FAILED', `Entitlement ${def.code}: ${reason}.`, 400, { fields: [{ field: def.code, reason }] });
  if (value === null) return null; // null = unlimited for quota definitions
  switch (def.valueType) {
    case 'BOOLEAN': if (typeof value !== 'boolean') throw bad('BOOLEAN_EXPECTED'); return value;
    case 'INTEGER': if (!Number.isInteger(value)) throw bad('INTEGER_EXPECTED'); break;
    case 'DECIMAL': if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) throw bad('DECIMAL_EXPECTED'); break;
    case 'SET': if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw bad('SET_EXPECTED'); return value;
  }
  const n = D(value as Prisma.Decimal.Value);
  if (n.isNegative()) throw bad('NEGATIVE_QUOTA');
  if (def.minValue && n.lt(def.minValue) || def.maxValue && n.gt(def.maxValue)) throw bad('OUT_OF_RANGE');
  return value;
}

/** Workspace's current non-terminal subscription, or null. */
export const liveSubscription = (db: DbClient, workspaceId: string) => db.billingSubscription.findFirst({ where: { workspaceId, status: { in: [...LIVE_STATUSES] } } });

/**
 * Rebuilds the effective entitlement projection (subscription plan values + active overrides) and bumps the
 * entitlement cache version so permission/search/realtime caches refresh immediately (01 AC04).
 * Capabilities that switch from on to off get `<code>ExpiredAt` so domain continuity rules (e.g. Sites read-only) apply.
 */
export async function recomputeEntitlements(tx: Tx, workspaceId: string, cause: string) {
  await ensureDefinitions(tx);
  const definitions = await tx.billingEntitlementDefinition.findMany();
  const sub = await tx.billingSubscription.findFirst({ where: { workspaceId }, orderBy: [{ createdAt: 'desc' }] });
  const live = sub && LIVE_STATUSES.includes(sub.status as never) ? sub : null;
  let planVersionId: string | null = live && ENTITLED_STATUSES.has(live.status) ? live.planVersionId : null;
  if (!planVersionId) planVersionId = await PlatformConfigService.platformSetting<string | null>(tx, 'billingFallbackPlanVersionId', null);
  const planValues = planVersionId ? await tx.billingPlanEntitlement.findMany({ where: { versionId: planVersionId } }) : [];
  const values: Record<string, unknown> = {};
  for (const def of definitions) values[def.code] = planValues.find(p => p.definitionId === def.id)?.value ?? def.defaultValue;
  const overrides = await tx.billingEntitlementOverride.findMany({ where: { workspaceId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'asc' } });
  for (const o of overrides) { const def = definitions.find(d => d.id === o.definitionId); if (def) values[def.code] = o.value; }
  const previous = await tx.billingEffectiveEntitlement.findUnique({ where: { workspaceId } });
  const before = (previous?.values ?? {}) as Record<string, unknown>;
  for (const def of definitions.filter(d => d.valueType === 'BOOLEAN')) {
    if (before[def.code] === true && values[def.code] === false) { values[def.code + 'ExpiredAt'] = new Date().toISOString(); values[def.code + 'GraceDays'] = 0; }
    else if (values[def.code] === false && before[def.code + 'ExpiredAt']) { values[def.code + 'ExpiredAt'] = before[def.code + 'ExpiredAt']; values[def.code + 'GraceDays'] = 0; }
  }
  // Aliases for quota keys already enforced by Pack 1 modules (Sites/Commerce/HR); null = unlimited, so no alias.
  for (const [code, alias] of Object.entries(LEGACY_QUOTA_ALIASES)) if (typeof values[code] === 'number') values[alias] = values[code];
  values.billingStatus = sub?.status ?? 'NONE';
  const saved = await tx.billingEffectiveEntitlement.upsert({ where: { workspaceId }, create: { workspaceId, values: values as Prisma.InputJsonValue, sourceSubscriptionId: sub?.id ?? null },
    update: { values: values as Prisma.InputJsonValue, sourceSubscriptionId: sub?.id ?? null, version: { increment: 1 }, computedAt: new Date() } });
  await tx.billingEntitlementHistory.create({ data: { workspaceId, version: saved.version, values: values as Prisma.InputJsonValue, cause } });
  await bumpCacheVersion(tx, 'entitlements', workspaceId);
  const changed = Object.keys(values).filter(k => JSON.stringify(values[k]) !== JSON.stringify(before[k]));
  if (changed.length) await emitEvent(tx, { workspaceId, eventType: 'BILLING_ENTITLEMENT_CHANGED', aggregateType: 'BillingEffectiveEntitlement', aggregateId: workspaceId, aggregateVersion: saved.version, actorType: 'SERVICE', payload: { changed: changed.slice(0, 50), cause } });
  return values;
}
export async function effectiveEntitlements(db: DbClient, workspaceId: string) {
  const row = await db.billingEffectiveEntitlement.findUnique({ where: { workspaceId } });
  return row ? { values: row.values as Record<string, unknown>, version: row.version, managed: true } : { values: {} as Record<string, unknown>, version: 0, managed: false };
}

/** Count-based usage providers per capability code (owning modules count their own records; nothing is deleted). */
type Counter = (db: DbClient, workspaceId: string) => Promise<number>;
const counters = new Map<string, Counter>();
export function registerUsageCounter(code: string, counter: Counter) { counters.set(code, counter); }
export const usageCounter = (code: string) => counters.get(code);
registerUsageCounter('users.seats', (db, ws) => db.workspaceMembership.count({ where: { workspaceId: ws, status: 'ACTIVE', isDeleted: false } }));
registerUsageCounter('sites.max', (db, ws) => db.site.count({ where: { workspaceId: ws, archivedAt: null } }));
registerUsageCounter('commerce.stores.max', (db, ws) => db.commerceStore.count({ where: { workspaceId: ws, status: { not: 'ARCHIVED' } } }));
registerUsageCounter('hr.employees.max', (db, ws) => db.hrEmployee.count({ where: { workspaceId: ws, status: { not: 'TERMINATED' } } }));

/**
 * EntitlementService.check: boolean capability and count quota (rule 2: rollout flag, entitlement, permission and
 * resource state are independent AND gates; this is only the entitlement gate). Workspaces without a billing
 * projection are unmanaged (legacy) and allowed.
 */
export async function checkEntitlement(db: DbClient, workspaceId: string, feature: string, requestedUnits = 0) {
  const { values, managed } = await effectiveEntitlements(db, workspaceId);
  if (!managed) return { allowed: true, managed: false, feature, reason: null as string | null };
  const value = values[feature];
  if (value === undefined) return { allowed: false, managed: true, feature, reason: 'UNKNOWN_CAPABILITY' };
  if (value === false) return { allowed: false, managed: true, feature, reason: 'NOT_ENTITLED' };
  if (value === true || value === null || requestedUnits <= 0 && typeof value !== 'number') return { allowed: true, managed: true, feature, reason: null };
  const counter = counters.get(feature);
  const current = counter ? await counter(db, workspaceId) : 0;
  const limit = D(value as Prisma.Decimal.Value);
  const allowed = D(current).add(requestedUnits).lte(limit);
  return { allowed, managed: true, feature, reason: allowed ? null : 'LIMIT_REACHED', current, limit: limit.toFixed() };
}
export async function assertEntitled(db: DbClient, workspaceId: string, feature: string, requestedUnits = 0) {
  const result = await checkEntitlement(db, workspaceId, feature, requestedUnits);
  if (!result.allowed) throw new AppError(result.reason === 'LIMIT_REACHED' ? 'INSUFFICIENT_QUOTA' : 'PERMISSION_DENIED', result.reason === 'LIMIT_REACHED' ? `${feature} limit reached for this subscription; existing records are kept.` : `${feature} is not included in this subscription.`, result.reason === 'LIMIT_REACHED' ? 422 : 403, result);
}

export async function billingAudit(tx: Tx, input: { workspaceId: string | null; actorId: string | null; actorType?: 'USER' | 'SERVICE' | 'PLATFORM'; action: string; resourceType: string; resourceId: string | null; before?: unknown; after?: unknown; requestId?: string }) {
  return audit(tx, input);
}
export type BillingDb = PrismaClient;
