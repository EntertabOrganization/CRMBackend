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
let lastBucketCleanup = 0;
const MAX_BUCKETS = 50000;
export const processRateLimitPolicies = {
  read: { scope: 'process.read',limit: 600,windowMs: 60000 },
  write: { scope: 'process.write',limit: 120,windowMs: 60000 },
  callbackGlobal: { scope: 'workflow.callback-global',limit: 1200,windowMs: 60000 },
  callback: { scope: 'workflow.callback',limit: 60,windowMs: 60000 },
} satisfies Record<string,RateLimitPolicy>;

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

/** Per-user limits for the CRM configuration, bulk and comment endpoints (keyed by user, not by address). */
export const crmRateLimitPolicies = {
  configWrite: { scope: 'crm.config-write', limit: 240, windowMs: 60 * 1000 },
  bulk: { scope: 'crm.activity-bulk', limit: 30, windowMs: 60 * 1000 },
  comment: { scope: 'crm.timeline-comment', limit: 120, windowMs: 60 * 1000 },
  migration: { scope: 'crm.field-migration', limit: 20, windowMs: 60 * 60 * 1000 },
} satisfies Record<string, RateLimitPolicy>;

export type CrmRateLimit = keyof typeof crmRateLimitPolicies;

export function rateLimitUser(userId: string, policy: keyof typeof crmRateLimitPolicies) {
  checkRateLimit(userId, crmRateLimitPolicies[policy]);
}

export function checkRateLimit(identifier: string, policy: RateLimitPolicy, now = Date.now()) {
  if (now-lastBucketCleanup>60000 && buckets.size>10000) {
    for (const [key,bucket] of buckets) if (bucket.resetAt<=now) buckets.delete(key);
    lastBucketCleanup=now;
  }
  const key = `${policy.scope}:${identifier}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size>=MAX_BUCKETS) throw tooManyRequests();
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
