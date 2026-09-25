import { createHash } from 'node:crypto';
import type { AccessService, ActorContext } from '../access-service';
import { AuditService } from '../audit-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict, forbidden } from '../errors';
import { emitDomainEvent } from '../events';
import type { FilePort } from '../ports';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import type { Catalog, CatalogSettings, CatalogUnit, PriceType } from './types';
import { CATALOG_PERMISSIONS as P } from './types';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export type Json = Record<string, unknown>;

export const SYSTEM_UNITS: Array<{ code: string; name: string; symbol: string; precision: number }> = [
  { code: 'PIECE', name: 'Piece', symbol: 'pcs', precision: 0 },
  { code: 'BOX', name: 'Box', symbol: 'box', precision: 0 },
  { code: 'KILOGRAM', name: 'Kilogram', symbol: 'kg', precision: 3 },
  { code: 'METER', name: 'Meter', symbol: 'm', precision: 3 },
  { code: 'HOUR', name: 'Hour', symbol: 'h', precision: 2 },
  { code: 'LICENSE', name: 'License', symbol: 'lic', precision: 0 },
];

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`).join(',')}}`;
}

export function fingerprint(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects request keys outside the whitelist (mass-assignment protection: nothing is ever spread into a row). */
export function assertOnlyKeys(input: Json, allowed: readonly string[], what: string) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest('CATALOG_FIELD_NOT_UPDATABLE', `These ${what} fields cannot be set here: ${unknown.join(', ')}.`, { fields: unknown });
  }
}

export function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('VALIDATION_ERROR', `${field} is required.`, { field });
  const text = value.trim();
  if (text.length > max) throw badRequest('VALIDATION_ERROR', `${field} must be at most ${max} characters.`, { field });
  return text;
}

export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('VALIDATION_ERROR', `${field} must be a string or null.`, { field });
  const text = value.trim();
  if (text.length > max) throw badRequest('VALIDATION_ERROR', `${field} must be at most ${max} characters.`, { field });
  return text || null;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest('VALIDATION_ERROR', `${field} must be a boolean.`, { field });
  return value;
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest('VALIDATION_ERROR', `${field} must be an integer between ${min} and ${max}.`, { field });
  }
  return value;
}

export function normalizeCode(value: unknown, field = 'code'): string {
  const raw = requiredText(value, field, 32).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!CODE_PATTERN.test(raw)) throw badRequest('VALIDATION_ERROR', `${field} must start with a letter and contain only letters, digits and underscores (max 32).`, { field });
  return raw;
}

export function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Shared plumbing for every Catalog service: actor/permissions, audit, outbox events, realtime hints, idempotency. */
export class CatalogSupport {
  constructor(
    readonly store: InMemoryStore,
    readonly access: AccessService,
    readonly realtime: RealtimeHub,
    readonly filePort: () => FilePort,
  ) {}

  get state() {
    return this.store.state;
  }

  actor(user: User, workspaceId: string): ActorContext {
    return this.access.actor(user, workspaceId);
  }

  /** Master-data mutations are workspace-wide capabilities; a narrower scope is not enough. */
  requireManage(actor: ActorContext, permission: string) {
    this.access.requireWorkspaceScope(actor, permission);
  }

  /** Product/Catalog data is not owned by a user, so any scope of a read permission is sufficient. */
  hasAny(actor: ActorContext, ...permissions: string[]) {
    return permissions.some((permission) => this.access.scopeFor(actor, permission) !== null);
  }

  requireAny(actor: ActorContext, ...permissions: string[]) {
    if (!this.hasAny(actor, ...permissions)) throw forbidden(`${permissions[0]} permission is required.`);
  }

  /** Lookup data (catalogs, categories, units, price types) is readable by anyone who reads or sells products. */
  requireLookupRead(actor: ActorContext) {
    this.requireAny(actor, P.catalogRead, P.productRead, P.rowManage, P.catalogManage);
  }

  assertVersion(current: number, provided: unknown, what: string) {
    if (typeof provided !== 'number' || !Number.isInteger(provided)) {
      throw badRequest('CATALOG_VERSION_REQUIRED', `The current ${what} version is required.`, { field: 'version' });
    }
    if (provided !== current) throw conflict('CATALOG_VERSION_CONFLICT', `The ${what} changed after you loaded it.`, { currentVersion: current });
  }

  audit(actor: ActorContext, action: string, entityType: string, entityId: string, before: unknown, after: unknown, metadata?: unknown) {
    new AuditService(this.store).write({ workspaceId: actor.workspaceId, actorUserId: actor.user.id, action, entityType, entityId, beforeData: before, afterData: after, metadata });
  }

  /** Outbox event (same commit as the state change) + advisory realtime hint (released after commit). */
  emit(workspaceId: string, actorUserId: string | null, eventType: string, entityType: string, entityId: string, changes: Json = {}) {
    emitDomainEvent(this.store, { workspaceId, eventType, entityType, entityId, actorUserId, changes });
    this.realtime.enqueue({ type: eventType, workspaceId, data: { entityType, entityId, ...safeHint(changes) } });
  }

  // ---- idempotency -----------------------------------------------------------------------------------------------

  validateKey(key: unknown): string | undefined {
    if (key === undefined || key === null) return undefined;
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      throw badRequest('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string (max 200 characters).');
    }
    return key;
  }

  recall(actor: ActorContext, operation: string, key: string | undefined, request: unknown): Json | null {
    if (!key) return null;
    const existing = this.state.idempotencyRecords.find(
      (item) => item.workspaceId === actor.workspaceId && item.actorUserId === actor.user.id && item.operation === operation && item.idempotencyKey === key && item.expiresAt > new Date(),
    );
    if (!existing) return null;
    if (existing.requestHash !== fingerprint(request)) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different payload.');
    return existing.response;
  }

  remember(actor: ActorContext, operation: string, key: string | undefined, request: unknown, response: Json) {
    if (!key) return;
    this.state.idempotencyRecords.push({
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      actorUserId: actor.user.id,
      operation,
      idempotencyKey: key,
      requestHash: fingerprint(request),
      response,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      createdAt: new Date(),
    });
  }

  // ---- bootstrap / settings --------------------------------------------------------------------------------------

  /**
   * Idempotently creates what every workspace needs before Catalog can be used: the settings row, a default Catalog, the
   * base Price Type and the standard Units. Deterministic, so running it on an existing workspace is a no-op.
   */
  ensureBootstrap(workspaceId: string, actorUserId: string | null = null): CatalogSettings {
    const now = new Date();
    let settings = this.state.catalogSettings.find((row) => row.workspaceId === workspaceId);
    if (!settings) {
      settings = { id: this.store.id(), workspaceId, defaultCatalogId: null, basePriceTypeId: null, version: 1, createdAt: now, updatedAt: now };
      this.state.catalogSettings.push(settings);
    }
    if (!settings.defaultCatalogId || !this.state.catalogs.some((row) => row.id === settings!.defaultCatalogId && row.workspaceId === workspaceId)) {
      const existing = this.state.catalogs.filter((row) => row.workspaceId === workspaceId && row.isActive).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
      const catalog = existing ?? this.createCatalogRow(workspaceId, 'Main catalog', 'MAIN', actorUserId);
      settings.defaultCatalogId = catalog.id;
      settings.version += 1;
      settings.updatedAt = now;
    }
    if (!settings.basePriceTypeId || !this.state.catalogPriceTypes.some((row) => row.id === settings!.basePriceTypeId && row.workspaceId === workspaceId)) {
      const existing = this.state.catalogPriceTypes.find((row) => row.workspaceId === workspaceId && row.code === 'BASE');
      const type = existing ?? this.createPriceTypeRow(workspaceId, 'BASE', 'Base price', 0);
      settings.basePriceTypeId = type.id;
      settings.version += 1;
      settings.updatedAt = now;
    }
    if (!this.state.catalogUnits.some((row) => row.workspaceId === workspaceId)) {
      SYSTEM_UNITS.forEach((unit, index) => this.state.catalogUnits.push(this.unitRow(workspaceId, unit, index)));
    }
    return settings;
  }

  private createCatalogRow(workspaceId: string, name: string, code: string, actorUserId: string | null): Catalog {
    const now = new Date();
    const row: Catalog = {
      id: this.store.id(),
      workspaceId,
      name,
      normalizedName: normalizeName(name),
      code,
      description: null,
      isActive: true,
      sortOrder: 0,
      version: 1,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    };
    this.state.catalogs.push(row);
    return row;
  }

  private createPriceTypeRow(workspaceId: string, code: string, name: string, sortOrder: number): PriceType {
    const now = new Date();
    const row: PriceType = { id: this.store.id(), workspaceId, code, name, isActive: true, sortOrder, version: 1, createdAt: now, updatedAt: now };
    this.state.catalogPriceTypes.push(row);
    return row;
  }

  private unitRow(workspaceId: string, unit: (typeof SYSTEM_UNITS)[number], index: number): CatalogUnit {
    const now = new Date();
    return { id: this.store.id(), workspaceId, code: unit.code, name: unit.name, symbol: unit.symbol, precision: unit.precision, isActive: true, isSystem: true, sortOrder: index, version: 1, createdAt: now, updatedAt: now };
  }

  settings(workspaceId: string): CatalogSettings {
    return this.ensureBootstrap(workspaceId);
  }

  // ---- scoped lookups (a foreign id is indistinguishable from a missing one) ---------------------------------------

  catalog(workspaceId: string, catalogId: unknown): Catalog {
    const row = typeof catalogId === 'string' ? this.state.catalogs.find((item) => item.id === catalogId && item.workspaceId === workspaceId) : undefined;
    if (!row) throw new AppError('CATALOG_NOT_FOUND', 'Catalog was not found.', 404);
    return row;
  }

  unit(workspaceId: string, unitId: unknown): CatalogUnit {
    const row = typeof unitId === 'string' ? this.state.catalogUnits.find((item) => item.id === unitId && item.workspaceId === workspaceId) : undefined;
    if (!row) throw new AppError('UNIT_NOT_FOUND', 'Unit was not found.', 404);
    return row;
  }

  priceType(workspaceId: string, priceTypeId: unknown): PriceType {
    const row = typeof priceTypeId === 'string' ? this.state.catalogPriceTypes.find((item) => item.id === priceTypeId && item.workspaceId === workspaceId) : undefined;
    if (!row) throw new AppError('PRICE_TYPE_NOT_FOUND', 'Price type was not found.', 404);
    return row;
  }
}

/** Realtime hints carry ids/versions only. */
function safeHint(changes: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(changes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}
