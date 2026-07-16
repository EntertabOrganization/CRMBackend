import { registerAs } from '@nestjs/config';

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

export default registerAs('users', () => ({
  cacheTtlMs: toNumber(process.env.USERS_CACHE_TTL_MS, 30_000),
  jwtSecret: process.env.JWT_SECRET ?? 'trueform-dev-secret',
  jwtExpiresInSeconds: toNumber(process.env.JWT_EXPIRES_IN_SECONDS, 86_400),
  accessTokenExpiresInSeconds: toNumber(process.env.ACCESS_TOKEN_EXPIRES_IN_SECONDS, 3600), // 60 minutes
  refreshTokenExpiresInSeconds: toNumber(process.env.REFRESH_TOKEN_EXPIRES_IN_SECONDS, 259200), // 3 days
}));
