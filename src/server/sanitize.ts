import type { SafeUser, User } from './domain';

const SECRET_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'credential',
  'secret',
  'apiKey',
]);

export function safeUser(user: User): SafeUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    settings: user.settings,
    meta: user.meta,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
  };
}

export function sanitizeAuditPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeAuditPayload);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      SECRET_KEYS.has(key) ? '[REDACTED]' : sanitizeAuditPayload(inner),
    ]),
  );
}
