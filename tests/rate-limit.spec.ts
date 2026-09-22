import { AppError } from '@/src/server/errors';
import { checkRateLimit, resetRateLimits } from '@/src/server/rate-limit';

describe('rate limiting', () => {
  afterEach(() => resetRateLimits());

  it('rejects requests after the configured window limit', () => {
    const policy = { scope: 'test', limit: 2, windowMs: 1000 };

    checkRateLimit('client-1', policy, 1000);
    checkRateLimit('client-1', policy, 1001);

    expect(() => checkRateLimit('client-1', policy, 1002)).toThrow(AppError);
    expect(() => checkRateLimit('client-1', policy, 1002)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED', status: 429 }),
    );
  });

  it('opens a fresh bucket after the window resets', () => {
    const policy = { scope: 'test', limit: 1, windowMs: 1000 };

    checkRateLimit('client-1', policy, 1000);
    expect(() => checkRateLimit('client-1', policy, 1999)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
    expect(() => checkRateLimit('client-1', policy, 2000)).not.toThrow();
  });
});
