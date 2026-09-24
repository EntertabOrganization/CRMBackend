import { AppError, fieldValidationFailed } from '../errors';
import type { ActivityCommunicationType, Activity, ActivityPriority } from './types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MAX_SUBJECT = 300;
export const MAX_DESCRIPTION = 20_000;
export const MAX_RESULT = 20_000;
export const MAX_LOCATION = 500;
export const MAX_BULK = 100;
export const MAX_BINDINGS = 25;
export const MAX_PARTICIPANTS = 100;
export const MAX_REMINDERS = 20;
export const MAX_COMMUNICATIONS = 25;
export const MAX_FILES = 50;

export const timeInvalid = (message: string) => new AppError('ACTIVITY_TIME_INVALID', message, 400);

/** Real instants only: an ISO-8601 timestamp with an explicit offset, so nothing depends on a server timezone. */
export function parseInstant(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) || Number.isNaN(Date.parse(value))) {
    throw timeInvalid(`${field} must be an ISO-8601 timestamp with a timezone offset.`);
  }
  return new Date(value);
}

export function requireString(value: unknown, field: string, max: number, required = true): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw fieldValidationFailed({ [field]: [{ code: 'REQUIRED', message: `${field} is required.` }] });
    return null;
  }
  if (typeof value !== 'string') throw fieldValidationFailed({ [field]: [{ code: 'INVALID_TYPE', message: `${field} must be a string.` }] });
  const trimmed = value.trim();
  if (trimmed.length > max) throw fieldValidationFailed({ [field]: [{ code: 'MAX_LENGTH', message: `${field} must be at most ${max} characters.` }] });
  return trimmed;
}

export function normalizeCommunicationValue(type: ActivityCommunicationType, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (type === 'EMAIL') {
    const email = value.toLowerCase();
    return EMAIL_PATTERN.test(email) ? email : null;
  }
  if (type === 'PHONE') {
    const compact = value.replace(/[\s().-]/g, '');
    return /^\+?\d{5,15}$/.test(compact) ? compact : null;
  }
  return value.toLowerCase().slice(0, 500);
}

const PRIORITY_RANK: Record<ActivityPriority, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

export function priorityRank(priority: ActivityPriority) {
  return PRIORITY_RANK[priority] ?? 1;
}

/** Overdue basis for a resolved deadline; centralized so lists, the board and the scheduler always agree. */
export function resolvedDeadline(activity: Pick<Activity, 'deadline' | 'endAt' | 'startAt'>, basis: 'DEADLINE' | 'SCHEDULE'): Date | null {
  if (activity.deadline) return new Date(activity.deadline);
  if (basis === 'SCHEDULE') return activity.endAt ? new Date(activity.endAt) : activity.startAt ? new Date(activity.startAt) : null;
  return null;
}

export function isOpenStatus(status: Activity['status']) {
  return status === 'PLANNED' || status === 'IN_PROGRESS';
}

export function encodeCursor(value: { key: string }) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): { key: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.key === 'string') return parsed;
  } catch {
    // fall through
  }
  throw new AppError('CRM_CURSOR_INVALID', 'cursor is invalid.', 400);
}

/** Stable JSON fingerprint used by idempotency keys (independent of key order and of the key itself). */
export function fingerprint(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'idempotencyKey')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, sortKeys(val)]),
    );
  }
  return value;
}
