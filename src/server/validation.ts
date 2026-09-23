import { badRequest } from './errors';

/** Returns the trimmed string or throws a 400 when the value is missing or blank. */
export function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('VALIDATION_ERROR', `${field} is required.`);
  }
  return value.trim();
}

export function requireEmail(value: unknown, field = 'email'): string {
  const email = requireText(value, field);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest('VALIDATION_ERROR', `${field} must be a valid email address.`);
  }
  return email;
}
