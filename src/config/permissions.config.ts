import { registerAs } from '@nestjs/config';

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

export default registerAs('permissions', () => ({
  cacheTtlMs: toNumber(process.env.PERMISSIONS_CACHE_TTL_MS, 30_000),
}));
