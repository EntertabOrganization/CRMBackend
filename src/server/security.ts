import argon2 from 'argon2';
import { createHmac, timingSafeEqual } from 'crypto';
import { badRequest, unauthorized } from './errors';

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function assertPasswordPolicy(password: string) {
  if (password.length < 8 || password.length > 128) {
    throw badRequest('WEAK_PASSWORD', 'Password must be between 8 and 128 characters.');
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw badRequest('WEAK_PASSWORD', 'Password must include uppercase, lowercase and number characters.');
  }
}

export function newSecretToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export async function hashSecret(value: string) {
  return argon2.hash(value, { type: argon2.argon2id });
}

export async function verifyHash(hash: string | null | undefined, value: string) {
  if (!hash) return false;
  try {
    return argon2.verify(hash, value);
  } catch {
    return false;
  }
}

export async function signAccessToken(userId: string) {
  const payload = {
    sub: userId,
    typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(body);
  return `${body}.${signature}`;
}

export async function verifyAccessToken(token: string) {
  try {
    const [body, signature] = token.split('.');
    if (!body || !signature || !safeEqual(signature, sign(body))) throw unauthorized();
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
    if (!payload.sub || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw unauthorized();
    return payload.sub;
  } catch {
    throw unauthorized('Invalid or expired access token.');
  }
}

function sign(value: string) {
  return createHmac('sha256', process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-minimum-32-chars')
    .update(value)
    .digest('base64url');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
