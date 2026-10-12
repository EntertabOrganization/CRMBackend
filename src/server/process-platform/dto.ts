import { z } from 'zod';
import { AppError } from '../errors';

export const uuid = z.uuid();
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const name = z.string().trim().min(1).max(160);
export const code = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const timezone = z.string().refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'A valid IANA timezone is required');
export const decimal = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/);
export const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_ARGUMENT', 'Request validation failed.', 400,
    { issues: result.error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
  return result.data;
}

/** Stable canonical form for immutable schema checksums and idempotent commands. */
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
