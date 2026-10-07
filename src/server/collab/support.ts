import { createHash } from 'node:crypto';
import type { AccessService, ActorContext } from '../access-service';
import type { PermissionScope } from '../domain';
import { AppError, badRequest, conflict, forbidden } from '../errors';
import { emitDomainEvent } from '../events';
import type { RealtimeHub } from '../realtime';
import { sanitizeAuditPayload } from '../sanitize';
import type { InMemoryStore } from '../store';

/**
 * Shared plumbing for the collaboration modules (Tasks & Projects, Calendar, Files, Communication): request validation,
 * optimistic concurrency, idempotency, outbox events + realtime hints, central Audit and whitelisted list queries.
 * Every module receives one instance; nothing here holds business rules of a specific module.
 */

export type Json = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

export function validationError(field: string, message: string, code = 'VALIDATION_ERROR'): AppError {
  return new AppError(code, message, 400, { field });
}

/** Thrown when a resource is missing, in another Workspace, or not visible to the caller (indistinguishable on purpose). */
export function notFoundError(code: string, entity: string): AppError {
  return new AppError(code, `${entity} was not found.`, 404);
}

export function versionConflict(current: number): AppError {
  return conflict('RESOURCE_VERSION_CONFLICT', 'The resource was changed by someone else. Reload and retry.', { currentVersion: current });
}

// ---- body readers -------------------------------------------------------------------------------------------------------

type StrOptions = { required?: boolean; max?: number; min?: number; trim?: boolean };

export class Body {
  constructor(readonly raw: Json) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  has(key: string) {
    return Object.prototype.hasOwnProperty.call(this.raw, key) && this.raw[key] !== undefined;
  }

  str(key: string, options: StrOptions & { required: true }): string;
  str(key: string, options?: StrOptions): string | null | undefined;
  str(key: string, options: StrOptions = {}): string | null | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return value as null | undefined;
    }
    if (typeof value !== 'string') throw validationError(key, `${key} must be a string.`);
    const result = options.trim === false ? value : value.trim();
    if (options.required && result.length === 0) throw validationError(key, `${key} must not be empty.`);
    if (options.max !== undefined && result.length > options.max) throw validationError(key, `${key} must be at most ${options.max} characters.`);
    if (options.min !== undefined && result.length < options.min) throw validationError(key, `${key} must be at least ${options.min} characters.`);
    return result;
  }

  uuid(key: string, options: { required: true }): string;
  uuid(key: string, options?: { required?: boolean }): string | null | undefined;
  uuid(key: string, options: { required?: boolean } = {}): string | null | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return value as null | undefined;
    }
    if (!isUuid(value)) throw validationError(key, `${key} must be a UUID.`);
    return value.toLowerCase();
  }

  uuids(key: string, options: { required?: boolean; max?: number } = {}): string[] | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return undefined;
    }
    if (!Array.isArray(value) || !value.every(isUuid)) throw validationError(key, `${key} must be an array of UUIDs.`);
    if (options.max !== undefined && value.length > options.max) throw validationError(key, `${key} accepts at most ${options.max} items.`);
    return [...new Set(value.map((item) => item.toLowerCase()))];
  }

  enumOf<T extends string>(key: string, values: readonly T[], options: { required: true }): T;
  enumOf<T extends string>(key: string, values: readonly T[], options?: { required?: boolean }): T | null | undefined;
  enumOf<T extends string>(key: string, values: readonly T[], options: { required?: boolean } = {}): T | null | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return value as null | undefined;
    }
    if (typeof value !== 'string' || !values.includes(value as T)) throw validationError(key, `${key} must be one of ${values.join(', ')}.`);
    return value as T;
  }

  int(key: string, options: { required: true; min?: number; max?: number }): number;
  int(key: string, options?: { required?: boolean; min?: number; max?: number }): number | null | undefined;
  int(key: string, options: { required?: boolean; min?: number; max?: number } = {}): number | null | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return value as null | undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) throw validationError(key, `${key} must be an integer.`);
    if (options.min !== undefined && value < options.min) throw validationError(key, `${key} must be at least ${options.min}.`);
    if (options.max !== undefined && value > options.max) throw validationError(key, `${key} must be at most ${options.max}.`);
    return value;
  }

  bool(key: string, options: { required: true }): boolean;
  bool(key: string, options?: { required?: boolean }): boolean | undefined;
  bool(key: string, options: { required?: boolean } = {}): boolean | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return undefined;
    }
    if (typeof value !== 'boolean') throw validationError(key, `${key} must be a boolean.`);
    return value;
  }

  /** A real instant: ISO-8601 with an explicit offset/`Z`, so the server never guesses a timezone. */
  instant(key: string, options: { required: true }): Date;
  instant(key: string, options?: { required?: boolean }): Date | null | undefined;
  instant(key: string, options: { required?: boolean } = {}): Date | null | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return value as null | undefined;
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
      throw validationError(key, `${key} must be an ISO-8601 date-time with a timezone offset.`);
    }
    return new Date(value);
  }

  /** A calendar date (YYYY-MM-DD) with date semantics: no time, no timezone. */
  date(key: string, options: { required: true }): string;
  date(key: string, options?: { required?: boolean }): string | null | undefined;
  date(key: string, options: { required?: boolean } = {}): string | null | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return value as null | undefined;
    }
    if (typeof value !== 'string' || !isCalendarDate(value)) throw validationError(key, `${key} must be a calendar date (YYYY-MM-DD).`);
    return value;
  }

  object(key: string, options: { required?: boolean } = {}): Json | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) throw validationError(key, `${key} must be an object.`);
    return value as Json;
  }

  array(key: string, options: { required?: boolean; max?: number } = {}): unknown[] | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) {
      if (options.required) throw validationError(key, `${key} is required.`);
      return undefined;
    }
    if (!Array.isArray(value)) throw validationError(key, `${key} must be an array.`);
    if (options.max !== undefined && value.length > options.max) throw validationError(key, `${key} accepts at most ${options.max} items.`);
    return value;
  }

  /** Rejects any property that is not part of the operation's contract (PUT/PATCH must not silently ignore typos). */
  only(allowed: string[]) {
    for (const key of Object.keys(this.raw)) {
      if (!allowed.includes(key)) throw validationError(key, `${key} is not a supported property.`);
    }
    return this;
  }
}

export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ---- list queries ------------------------------------------------------------------------------------------------------

export type PageResult<T> = { data: T[]; meta: { page: number; limit: number; total: number; totalPages: number } };
export type CursorResult<T> = { data: T[]; meta: { nextCursor: string | null; hasMore: boolean; limit: number } };

const OPERATORS = ['eq', 'neq', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte', 'isNull'] as const;
type Operator = (typeof OPERATORS)[number];

export type ListConfig<T> = {
  searchable: (keyof T & string)[];
  filterable: (keyof T & string)[];
  sortable: (keyof T & string)[];
  defaultSort: keyof T & string;
  defaultOrder?: 'asc' | 'desc';
};

function comparable(value: unknown): string | number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value ?? '');
}

function compareValues(a: unknown, b: unknown) {
  const left = comparable(a);
  const right = comparable(b);
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function matches(value: unknown, op: Operator, expected: unknown): boolean {
  const normalize = (input: unknown) => (input instanceof Date ? input.toISOString() : input);
  const actual = normalize(value);
  switch (op) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'notIn': return Array.isArray(expected) && !expected.includes(actual);
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'startsWith': return String(actual ?? '').toLowerCase().startsWith(String(expected ?? '').toLowerCase());
    case 'endsWith': return String(actual ?? '').toLowerCase().endsWith(String(expected ?? '').toLowerCase());
    case 'isNull': return (expected === false) ? actual != null : actual == null;
    default: {
      if (actual == null || expected == null) return false;
      const cmp = typeof expected === 'number' ? Number(comparable(value)) - expected : compareValues(value instanceof Date ? value.toISOString() : value, expected);
      if (op === 'gt') return cmp > 0;
      if (op === 'gte') return cmp >= 0;
      if (op === 'lt') return cmp < 0;
      return cmp <= 0;
    }
  }
}

function parseFilters(query: URLSearchParams, filterable: string[]) {
  const raw = query.get('filters');
  const result: Array<{ field: string; op: Operator; value: unknown }> = [];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badRequest('QUERY_INVALID', 'filters must be valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('QUERY_INVALID', 'filters must be an object.');
    for (const [field, condition] of Object.entries(parsed as Json)) {
      if (!filterable.includes(field)) throw badRequest('QUERY_FIELD_NOT_ALLOWED', `Filtering by ${field} is not allowed.`);
      const spec = (condition && typeof condition === 'object' && !Array.isArray(condition) ? condition : { op: 'eq', value: condition }) as { op?: string; value?: unknown };
      const op = (spec.op ?? 'eq') as Operator;
      if (!OPERATORS.includes(op)) throw badRequest('QUERY_OPERATOR_NOT_ALLOWED', `Operator ${spec.op} is not allowed.`);
      result.push({ field, op, value: spec.value });
    }
  }
  // Simple `?field=value` equality filters for whitelisted fields.
  for (const field of filterable) {
    const value = query.get(field);
    if (value !== null && !result.some((item) => item.field === field)) result.push({ field, op: 'eq', value: value === 'true' ? true : value === 'false' ? false : value });
  }
  return result;
}

function filtered<T extends object>(rows: T[], query: URLSearchParams, config: ListConfig<T>) {
  const record = (row: T) => row as unknown as Record<string, unknown>;
  const search = query.get('search')?.trim().toLowerCase();
  let result = rows;
  if (search) result = result.filter((row) => config.searchable.some((field) => String(record(row)[field] ?? '').toLowerCase().includes(search)));
  for (const filter of parseFilters(query, config.filterable)) result = result.filter((row) => matches(record(row)[filter.field], filter.op, filter.value));
  const sortBy = query.get('sortBy') ?? config.defaultSort;
  if (!config.sortable.includes(sortBy as keyof T & string)) throw badRequest('QUERY_FIELD_NOT_ALLOWED', `Sorting by ${sortBy} is not allowed.`);
  const order = (query.get('sortOrder') ?? config.defaultOrder ?? 'asc') === 'desc' ? -1 : 1;
  return {
    sortBy,
    order,
    rows: [...result].sort((a, b) => {
      const primary = compareValues(record(a)[sortBy], record(b)[sortBy]);
      return order * (primary !== 0 ? primary : String(record(a).id).localeCompare(String(record(b).id)));
    }),
  };
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number, name: string) {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw badRequest('QUERY_INVALID', `${name} must be an integer >= ${min}.`);
  return Math.min(value, max);
}

export function pageOf<T extends object>(rows: T[], query: URLSearchParams, config: ListConfig<T>): PageResult<T> {
  const page = boundedInt(query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page');
  const limit = boundedInt(query.get('limit'), 20, 1, 100, 'limit');
  const sorted = filtered(rows, query, config).rows;
  const total = sorted.length;
  return { data: sorted.slice((page - 1) * limit, page * limit), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

/** Deterministic cursor pagination over (sortField, id) for chronological/high-churn streams. */
export function cursorOf<T extends { id: string }>(rows: T[], query: URLSearchParams, config: ListConfig<T>): CursorResult<T> {
  const limit = boundedInt(query.get('limit'), 20, 1, 100, 'limit');
  const { sortBy, order, rows: sorted } = filtered(rows, query, config);
  const record = (row: T) => row as unknown as Record<string, unknown>;
  const cursorRaw = query.get('cursor');
  let start = 0;
  if (cursorRaw) {
    let cursor: { v: string | number; id: string };
    try {
      cursor = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
    } catch {
      throw badRequest('CURSOR_INVALID', 'cursor is invalid.');
    }
    if (!cursor || typeof cursor.id !== 'string') throw badRequest('CURSOR_INVALID', 'cursor is invalid.');
    start = sorted.findIndex((row) => {
      const primary = compareValues(comparable(record(row)[sortBy]), cursor.v);
      return order * (primary !== 0 ? primary : row.id.localeCompare(cursor.id)) > 0;
    });
    if (start < 0) start = sorted.length;
  }
  const data = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  const last = data.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ v: comparable(record(last)[sortBy]), id: last.id }), 'utf8').toString('base64url') : null;
  return { data, meta: { nextCursor, hasMore, limit } };
}

// ---- support service ---------------------------------------------------------------------------------------------------

export type CollabDeps = { store: InMemoryStore; access: AccessService; realtime: RealtimeHub };

export class CollabSupport {
  constructor(private readonly deps: CollabDeps) {}

  get store() {
    return this.deps.store;
  }

  get state() {
    return this.deps.store.state;
  }

  get access() {
    return this.deps.access;
  }

  id() {
    return this.deps.store.id();
  }

  now() {
    return new Date();
  }

  // ---- authorization helpers ---------------------------------------------------------------------------------------------

  scope(actor: ActorContext, permission: string): PermissionScope | null {
    return this.deps.access.scopeFor(actor, permission);
  }

  require(actor: ActorContext, permission: string): PermissionScope {
    const scope = this.scope(actor, permission);
    if (!scope) throw forbidden(`${permission} permission is required.`);
    return scope;
  }

  requireWorkspaceScope(actor: ActorContext, permission: string) {
    if (this.require(actor, permission) !== 'WORKSPACE') throw forbidden(`${permission} requires workspace scope.`);
  }

  /** Active internal Workspace member (external/guest identities never qualify). */
  isEligibleUser(workspaceId: string, userId: string) {
    const user = this.state.users.find((item) => item.id === userId && !item.isDeleted);
    return Boolean(user && user.status === 'ACTIVE' && this.deps.access.isActiveMember(workspaceId, userId));
  }

  /** Does `scope` of `permission` cover a resource owned by any of `userIds`? */
  scopeCovers(actor: ActorContext, scope: PermissionScope | null, userIds: Array<string | null | undefined>) {
    if (!scope) return false;
    return userIds.some((userId) => this.deps.access.scopeCoversUser(scope, actor.user.id, userId, actor.workspaceId));
  }

  // ---- concurrency -------------------------------------------------------------------------------------------------------

  /** Version from the body (`version`) or an `If-Match` header; mandatory for PUT/PATCH of shared aggregates. */
  expectVersion(row: { version: number }, expected: unknown, required = true) {
    if (expected === undefined || expected === null) {
      if (required) throw validationError('version', 'version is required for this update (optimistic concurrency).');
      return;
    }
    if (typeof expected !== 'number' || !Number.isInteger(expected)) throw validationError('version', 'version must be an integer.');
    if (expected !== row.version) throw versionConflict(row.version);
  }

  /** Every mutation of a versioned row goes through here; the database trigger rejects writes that do not advance it. */
  touch<T extends { version: number; updatedAt: Date }>(row: T): T {
    row.version += 1;
    row.updatedAt = this.now();
    return row;
  }

  // ---- idempotency -------------------------------------------------------------------------------------------------------

  idempotencyKey(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string' || raw.length > 200) throw badRequest('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be a string of at most 200 characters.');
    return raw;
  }

  recall(actor: ActorContext, operation: string, key: string | undefined, request: unknown): Json | null {
    if (!key) return null;
    const existing = this.state.idempotencyRecords.find(
      (item) => item.workspaceId === actor.workspaceId && item.actorUserId === actor.user.id && item.operation === operation && item.idempotencyKey === key && item.expiresAt > this.now(),
    );
    if (!existing) return null;
    if (existing.requestHash !== fingerprint(request)) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different payload.');
    return existing.response;
  }

  remember(actor: ActorContext, operation: string, key: string | undefined, request: unknown, response: Json) {
    if (!key) return;
    // An expired record for the same key is replaced so the unique (workspace, actor, operation, key) index stays valid.
    this.state.idempotencyRecords = this.state.idempotencyRecords.filter(
      (item) => !(item.workspaceId === actor.workspaceId && item.actorUserId === actor.user.id && item.operation === operation && item.idempotencyKey === key),
    );
    this.state.idempotencyRecords.push({
      id: this.id(),
      workspaceId: actor.workspaceId,
      actorUserId: actor.user.id,
      operation,
      idempotencyKey: key,
      requestHash: fingerprint(request),
      response,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      createdAt: this.now(),
    });
  }

  // ---- outbox / realtime / audit -----------------------------------------------------------------------------------------

  /** Domain event in the transactional outbox + an advisory realtime hint released only after commit. */
  event(input: {
    workspaceId: string;
    type: string;
    entityType: string;
    entityId: string;
    actorUserId: string | null;
    changes?: Json;
    audienceUserIds?: string[];
    idempotencyKey?: string | null;
  }) {
    const event = emitDomainEvent(this.deps.store, {
      workspaceId: input.workspaceId,
      eventType: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.actorUserId,
      changes: input.changes ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
    });
    this.deps.realtime.enqueue({
      type: input.type,
      workspaceId: input.workspaceId,
      data: { entityType: input.entityType, entityId: input.entityId },
      ...(input.audienceUserIds ? { audienceUserIds: [...new Set(input.audienceUserIds)] } : {}),
    });
    return event;
  }

  audit(actor: { workspaceId: string; user: { id: string } } | null, workspaceId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown, metadata: unknown = null) {
    this.state.auditLogs.push({
      id: this.id(),
      workspaceId,
      partnerId: null,
      actorUserId: actor?.user.id ?? null,
      action,
      entityType,
      entityId,
      // Prisma stores SQL NULL for an omitted JSON column but rejects a plain `null`.
      beforeData: sanitizeAuditPayload(before ?? undefined),
      afterData: sanitizeAuditPayload(after ?? undefined),
      metadata: sanitizeAuditPayload(metadata ?? undefined),
      ipAddress: null,
      userAgent: null,
      requestId: null,
      occurredAt: this.now(),
    });
  }
}

export function fingerprint(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Json).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Json)[key])}`).join(',')}}`;
}

export const pick = <T extends object, K extends keyof T>(row: T, keys: K[]) => Object.fromEntries(keys.map((key) => [key, row[key]])) as Pick<T, K>;
