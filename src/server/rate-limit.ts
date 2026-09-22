import type { NextRequest } from 'next/server';
import { tooManyRequests } from './errors';

type RateLimitPolicy = {
  scope: string;
  limit: number;
  windowMs: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitBucket>();

export const authRateLimitPolicies = {
  signup: { scope: 'auth.signup', limit: 10, windowMs: 60 * 60 * 1000 },
  signin: { scope: 'auth.signin', limit: 20, windowMs: 15 * 60 * 1000 },
  verifyEmail: { scope: 'auth.verify-email', limit: 30, windowMs: 15 * 60 * 1000 },
  resendVerification: { scope: 'auth.resend-verification', limit: 5, windowMs: 60 * 60 * 1000 },
  refresh: { scope: 'auth.refresh', limit: 60, windowMs: 15 * 60 * 1000 },
  forgotPassword: { scope: 'auth.forgot-password', limit: 5, windowMs: 60 * 60 * 1000 },
  resetPassword: { scope: 'auth.reset-password', limit: 10, windowMs: 60 * 60 * 1000 },
  googleAuth: { scope: 'auth.google', limit: 20, windowMs: 15 * 60 * 1000 },
  logout: { scope: 'auth.logout', limit: 60, windowMs: 15 * 60 * 1000 },
  logoutAll: { scope: 'auth.logout-all', limit: 20, windowMs: 15 * 60 * 1000 },
} satisfies Record<string, RateLimitPolicy>;

export function checkRateLimit(identifier: string, policy: RateLimitPolicy, now = Date.now()) {
  const key = `${policy.scope}:${identifier}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    return;
  }

  if (bucket.count >= policy.limit) {
    throw tooManyRequests();
  }

  bucket.count += 1;
}

export function rateLimitRequest(request: NextRequest, policy: RateLimitPolicy) {
  checkRateLimit(clientIdentifier(request), policy);
}

export function resetRateLimits() {
  buckets.clear();
}

function clientIdentifier(request: NextRequest) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || request.headers.get('x-real-ip') || 'local';
}
