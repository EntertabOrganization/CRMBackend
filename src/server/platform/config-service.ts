import type { PrismaClient } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { assertVersion, audit, bumpCacheVersion, emitEvent, notFound, requirePlatform, type DbClient, type PlatformPrincipal, type Tx, type UserPrincipal } from './kernel';

export const SUPPORTED_LOCALES = ['en', 'en-US', 'en-GB', 'ar', 'ar-EG', 'ar-SA', 'ar-AE', 'fr', 'fr-FR', 'de', 'de-DE', 'es', 'es-ES', 'it', 'pt', 'pt-BR', 'tr', 'ru', 'nl', 'pl', 'zh-CN', 'ja', 'ko', 'he', 'fa', 'ur', 'hi'] as const;
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'D MMM YYYY'] as const;
const zones = new Set<string>([...(Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'), 'UTC']);
export const ianaTimezone = z.string().max(64).refine(tz => zones.has(tz), 'Unknown IANA timezone.');
export const locale = z.enum(SUPPORTED_LOCALES);
const GLOBAL_SCOPE = '00000000-0000-0000-0000-000000000000';

/** Declared, schema-validated settings documents. Unknown keys are rejected (strictObject); no script-valued config. */
const SETTING_SCHEMAS = {
  workspace: z.strictObject({ defaultLocale: locale, defaultTimezone: ianaTimezone, defaultCurrency: z.string().regex(/^[A-Z]{3}$/), dateFormat: z.enum(DATE_FORMATS),
    weekStartsOn: z.number().int().min(0).max(6), fiscalYearStartMonth: z.number().int().min(1).max(12) }).partial(),
  platform: z.strictObject({ defaultLocale: locale, supportedLocales: z.array(locale).min(1), defaultTimezone: ianaTimezone, maintenanceBanner: z.string().max(300).nullable(),
    trialDays: z.number().int().min(0).max(90), graceDays: z.number().int().min(0).max(90) }).partial(),
} as const;
const WORKSPACE_DEFAULTS = { defaultLocale: 'en', defaultTimezone: 'UTC', defaultCurrency: 'USD', dateFormat: 'YYYY-MM-DD', weekStartsOn: 1, fiscalYearStartMonth: 1 };

/** Rollout gate: a missing flag means "no rollout gate"; DISABLED denies new operations; targetScopes/percent narrow rollout. */
export async function featureEnabled(db: DbClient, name: string, workspaceId: string | null) {
  const flag = await db.featureFlag.findUnique({ where: { name } });
  if (!flag) return true;
  if (flag.state !== 'ENABLED') return false;
  const targets = flag.targetScopes as string[];
  if (targets.length && (!workspaceId || !targets.includes(workspaceId))) return false;
  const percent = Number((flag.rolloutPolicy as { percent?: number }).percent ?? 100);
  if (percent >= 100) return true;
  if (!workspaceId) return false;
  return parseInt(createHash('sha256').update(name + ':' + workspaceId).digest('hex').slice(0, 8), 16) % 100 < percent;
}
/** Independent AND gate (rule 1): call alongside permission/entitlement/resource checks; never a substitute. */
export async function requireFeature(db: DbClient, name: string, workspaceId: string | null) {
  if (!await featureEnabled(db, name, workspaceId)) throw new AppError('FEATURE_DISABLED', `${name} is not enabled for this Workspace.`, 403);
}

/** Atomic numbering: gaps allowed, values never reused; duplicate idempotency key returns the original allocation. */
export async function allocateNumber(tx: Tx, input: { workspaceId: string; entityType: string; sequenceName: string; idempotencyKey: string; prefix?: string; padWidth?: number }) {
  const sequence = await tx.numberSequence.upsert({ where: { workspaceId_entityType_sequenceName: { workspaceId: input.workspaceId, entityType: input.entityType, sequenceName: input.sequenceName } },
    create: { workspaceId: input.workspaceId, entityType: input.entityType, sequenceName: input.sequenceName, prefix: input.prefix ?? '', padWidth: input.padWidth ?? 6 }, update: {} });
  const existing = await tx.numberAllocation.findUnique({ where: { sequenceId_idempotencyKey: { sequenceId: sequence.id, idempotencyKey: input.idempotencyKey } } });
  if (existing) return { value: existing.value, formatted: existing.formatted, replayed: true };
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`UPDATE number_sequences SET next_value = next_value + 1 WHERE id = ${sequence.id}::uuid RETURNING next_value - 1 AS value`;
  const formatted = sequence.prefix + row.value.toString().padStart(sequence.padWidth, '0');
  await tx.numberAllocation.create({ data: { sequenceId: sequence.id, idempotencyKey: input.idempotencyKey, value: row.value, formatted } });
  await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'NUMBER_SEQUENCE_ALLOCATED', aggregateType: 'NumberSequence', aggregateId: sequence.id, actorType: 'SERVICE', payload: { entityType: input.entityType, sequenceName: input.sequenceName, value: row.value.toString() } });
  return { value: row.value, formatted, replayed: false };
}

/** Settings, feature flags, localization and numbering (30-Platform-Services/07). */
export class PlatformConfigService {
  constructor(private readonly db: PrismaClient) {}

  private async settingsRow(db: DbClient, key: 'workspace' | 'platform', scope: 'WORKSPACE' | 'GLOBAL', scopeId: string) {
    return db.platformSetting.findUnique({ where: { key_scope_scopeId: { key, scope, scopeId } } });
  }
  async workspaceSettings(actor: Principal) {
    const row = await this.settingsRow(this.db, 'workspace', 'WORKSPACE', actor.workspaceId);
    return { values: { ...WORKSPACE_DEFAULTS, ...(row?.value as object ?? {}) }, version: row?.version ?? 0, allowedFields: Object.keys(SETTING_SCHEMAS.workspace.shape) };
  }
  async patchWorkspaceSettings(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'workspace.settings.manage');
    const input = z.strictObject({ expectedVersion: z.number().int().min(0), values: SETTING_SCHEMAS.workspace }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'settings:' + actor.workspaceId}))`;
      const row = await this.settingsRow(tx, 'workspace', 'WORKSPACE', actor.workspaceId);
      assertVersion(row?.version ?? 0, input.expectedVersion);
      const before = (row?.value ?? {}) as Record<string, unknown>, value = { ...before, ...input.values };
      const saved = row ? await tx.platformSetting.update({ where: { id: row.id }, data: { value, version: { increment: 1 }, updatedBy: actor.userId } })
        : await tx.platformSetting.create({ data: { key: 'workspace', scope: 'WORKSPACE', scopeId: actor.workspaceId, value, updatedBy: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'PLATFORM_SETTING_CHANGED', resourceType: 'PlatformSetting', resourceId: saved.id, before, after: value, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'PLATFORM_SETTING_CHANGED', aggregateType: 'PlatformSetting', aggregateId: saved.id, aggregateVersion: saved.version, actorId: actor.userId, payload: { fields: Object.keys(input.values) } });
      return { values: { ...WORKSPACE_DEFAULTS, ...value }, version: saved.version };
    });
  }
  async globalSettings(actor: PlatformPrincipal) {
    requirePlatform(actor, 'platform.settings.manageGlobal');
    const row = await this.settingsRow(this.db, 'platform', 'GLOBAL', GLOBAL_SCOPE);
    return { values: row?.value ?? {}, version: row?.version ?? 0, allowedFields: Object.keys(SETTING_SCHEMAS.platform.shape) };
  }
  async patchGlobalSettings(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.settings.manageGlobal');
    const input = z.strictObject({ expectedVersion: z.number().int().min(0), values: SETTING_SCHEMAS.platform }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('settings:global'))`;
      const row = await this.settingsRow(tx, 'platform', 'GLOBAL', GLOBAL_SCOPE);
      assertVersion(row?.version ?? 0, input.expectedVersion);
      const before = (row?.value ?? {}) as Record<string, unknown>, value = { ...before, ...input.values };
      const saved = row ? await tx.platformSetting.update({ where: { id: row.id }, data: { value, version: { increment: 1 }, updatedBy: actor.userId } })
        : await tx.platformSetting.create({ data: { key: 'platform', scope: 'GLOBAL', scopeId: GLOBAL_SCOPE, value, updatedBy: actor.userId } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'PLATFORM_SETTING_CHANGED', resourceType: 'PlatformSetting', resourceId: saved.id, before, after: value, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'PLATFORM_SETTING_CHANGED', aggregateType: 'PlatformSetting', aggregateId: saved.id, aggregateVersion: saved.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { fields: Object.keys(input.values) } });
      return { values: value, version: saved.version };
    });
  }
  static async platformSetting<T = unknown>(db: DbClient, field: string, fallback: T): Promise<T> {
    const row = await db.platformSetting.findUnique({ where: { key_scope_scopeId: { key: 'platform', scope: 'GLOBAL', scopeId: GLOBAL_SCOPE } } });
    const value = (row?.value as Record<string, unknown> | undefined)?.[field];
    return value === undefined ? fallback : value as T;
  }

  // ---------------------------------------------------------------- feature flags
  async flags(actor: PlatformPrincipal) { requirePlatform(actor, 'featureflag.manage'); return this.db.featureFlag.findMany({ orderBy: { name: 'asc' } }); }
  async createFlag(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'featureflag.manage');
    const input = z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/), description: z.string().max(500).default(''), guardPermission: z.string().regex(/^platform\.[a-zA-Z.]+$/).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const flag = await tx.featureFlag.create({ data: { ...input, state: 'DISABLED' } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'FEATURE_FLAG_CHANGED', resourceType: 'FeatureFlag', resourceId: flag.id, after: { name: flag.name, state: flag.state }, requestId });
      return flag;
    });
  }
  async patchFlag(actor: PlatformPrincipal, id: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'featureflag.manage');
    const input = z.strictObject({ expectedVersion: z.number().int().positive(), state: z.enum(['ENABLED', 'DISABLED']).optional(), description: z.string().max(500).optional(),
      rolloutPolicy: z.strictObject({ percent: z.number().int().min(0).max(100) }).optional(), targetScopes: z.array(z.uuid()).max(5000).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const flag = await tx.featureFlag.findUnique({ where: { id: z.uuid().parse(id) } });
      if (!flag) throw notFound('Feature flag');
      // Billing/high-impact flags carry a guard permission beyond featureflag.manage (AC03).
      if (flag.guardPermission) requirePlatform(actor, flag.guardPermission);
      assertVersion(flag.version, input.expectedVersion);
      const { expectedVersion: _v, ...change } = input;
      const updated = await tx.featureFlag.update({ where: { id: flag.id }, data: { ...change, version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'FEATURE_FLAG_CHANGED', resourceType: 'FeatureFlag', resourceId: flag.id, before: { state: flag.state, rolloutPolicy: flag.rolloutPolicy, targets: (flag.targetScopes as string[]).length }, after: { state: updated.state, rolloutPolicy: updated.rolloutPolicy, targets: (updated.targetScopes as string[]).length }, requestId });
      await emitEvent(tx, { workspaceId: null, eventType: 'FEATURE_FLAG_CHANGED', aggregateType: 'FeatureFlag', aggregateId: flag.id, aggregateVersion: updated.version, actorId: actor.userId, actorType: 'PLATFORM', payload: { name: flag.name, state: updated.state } });
      await bumpCacheVersion(tx, 'flags', 'global'); // invalidates permission/entitlement caches; historical states untouched
      return updated;
    });
  }

  // ---------------------------------------------------------------- localization (own preferences only)
  async myLocale(actor: Principal) {
    const pref = await this.db.localizationPreference.findUnique({ where: { userId_workspaceId: { userId: actor.userId, workspaceId: actor.workspaceId } } });
    if (pref) return pref;
    const ws = await this.workspaceSettings(actor);
    return { userId: actor.userId, workspaceId: actor.workspaceId, locale: ws.values.defaultLocale, timezone: ws.values.defaultTimezone, dateFormat: ws.values.dateFormat, rtl: RTL.has(String(ws.values.defaultLocale).split('-')[0]), version: 0 };
  }
  async setMyLocale(actor: Principal, raw: unknown) {
    const input = z.strictObject({ locale: locale.optional(), timezone: ianaTimezone.optional(), dateFormat: z.enum(DATE_FORMATS).optional(), rtl: z.boolean().optional(), expectedVersion: z.number().int().min(0).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const pref = await tx.localizationPreference.findUnique({ where: { userId_workspaceId: { userId: actor.userId, workspaceId: actor.workspaceId } } });
      if (input.expectedVersion !== undefined) assertVersion(pref?.version ?? 0, input.expectedVersion);
      const { expectedVersion: _v, ...change } = input;
      const rtl = change.rtl ?? (change.locale ? RTL.has(change.locale.split('-')[0]) : undefined);
      const saved = await tx.localizationPreference.upsert({ where: { userId_workspaceId: { userId: actor.userId, workspaceId: actor.workspaceId } },
        create: { userId: actor.userId, workspaceId: actor.workspaceId, ...change, ...(rtl !== undefined ? { rtl } : {}) }, update: { ...change, ...(rtl !== undefined ? { rtl } : {}), version: { increment: 1 } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'LOCALIZATION_PREFERENCE_CHANGED', resourceType: 'LocalizationPreference', resourceId: saved.id, after: change });
      return saved;
    });
  }
  static assertUserScope(actor: UserPrincipal, userId: string) { if (actor.userId !== userId) throw new AppError('PERMISSION_DENIED', 'Users may change only their own preferences.', 403); }

  // ---------------------------------------------------------------- internal numbering endpoint
  async nextNumber(serviceToken: string | null, raw: unknown) {
    const expected = process.env.INTERNAL_JOB_TOKEN ?? '';
    if (!expected) throw new AppError('DEPENDENCY_UNAVAILABLE', 'INTERNAL_JOB_TOKEN is not configured.', 503);
    const given = (serviceToken ?? '').replace(/^Bearer\s+/i, '');
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new AppError('UNAUTHENTICATED', 'Service identity is required.', 401);
    const input = z.strictObject({ workspaceId: z.uuid(), entityType: z.string().regex(/^[a-z][a-zA-Z0-9_.]{1,60}$/), sequenceName: z.string().regex(/^[a-zA-Z0-9_.-]{1,60}$/), idempotencyKey: z.string().min(8).max(200),
      prefix: z.string().max(20).regex(/^[A-Za-z0-9_-]*$/).optional(), padWidth: z.number().int().min(1).max(18).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      if (!await tx.workspace.findFirst({ where: { id: input.workspaceId, isDeleted: false } })) throw notFound('Workspace');
      const result = await allocateNumber(tx, input);
      return { value: result.value.toString(), formatted: result.formatted, replayed: result.replayed };
    });
  }
}
