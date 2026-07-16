import { registerAs } from '@nestjs/config';

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

export default registerAs('roles', () => ({
  cacheTtlMs: toNumber(process.env.ROLES_CACHE_TTL_MS, 30_000),
}));
