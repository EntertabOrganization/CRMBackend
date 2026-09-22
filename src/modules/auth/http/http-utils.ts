import { AuthDomainService } from './auth-domain.service';
import { QueryOptions } from '../auth-module';

export function ok<T>(data: T, meta: unknown = null) {
  return { success: true, data, meta };
}

export function page<T>(result: { data: T[]; meta: unknown }) {
  return { success: true, data: result.data, meta: result.meta };
}

type HeaderRequest = { headers?: Record<string, string | string[] | undefined> };

export function currentUserId(auth: AuthDomainService, req: HeaderRequest): string {
  const headerValue = req.headers?.authorization;
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return auth.verifyAccessToken('');
  return auth.verifyAccessToken(match[1]);
}

export function workspaceId(req: HeaderRequest, fallback?: string): string {
  const value = req.headers?.['x-workspace-id'];
  const fromHeader = Array.isArray(value) ? value[0] : value;
  return fromHeader ?? fallback ?? '';
}

export function normalizeQuery(query: Record<string, unknown>): QueryOptions {
  const normalized: QueryOptions = {};
  const filters: NonNullable<QueryOptions['filter']> = {};

  for (const [key, value] of Object.entries(query ?? {})) {
    const scalar = Array.isArray(value) ? value[0] : value;
    const filterMatch = key.match(/^filter\[([^\]]+)\]\[([^\]]+)\]$/);
    if (filterMatch) {
      const [, field, operator] = filterMatch;
      filters[field] = { ...(filters[field] ?? {}), [operator]: coerceValue(scalar) } as any;
      continue;
    }
    if (key === 'page' || key === 'limit') {
      (normalized as any)[key] = Number(scalar);
      continue;
    }
    if (key === 'sortOrder') {
      normalized.sortOrder = scalar === 'desc' ? 'desc' : 'asc';
      continue;
    }
    if (['search', 'sortBy'].includes(key)) {
      (normalized as any)[key] = String(scalar);
    }
  }

  if (Object.keys(filters).length > 0) normalized.filter = filters;
  return normalized;
}

function coerceValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value.includes(',')) return value.split(',').map(coerceValue);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
