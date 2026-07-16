import { registerAs } from '@nestjs/config';

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

export const resolveSensitiveThrottleConfig = () => ({
  ttl: toNumber(process.env.SENSITIVE_THROTTLE_TTL_MS, 60_000),
  limit: toNumber(process.env.SENSITIVE_THROTTLE_LIMIT, 10),
});

export default registerAs('throttler', () => ({
  defaultTtl: toNumber(process.env.THROTTLE_TTL_MS, 60_000),
  defaultLimit: toNumber(process.env.THROTTLE_LIMIT, 60),
  sensitiveTtl: resolveSensitiveThrottleConfig().ttl,
  sensitiveLimit: resolveSensitiveThrottleConfig().limit,
}));
