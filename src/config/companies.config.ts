import { registerAs } from '@nestjs/config';

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

export default registerAs('companies', () => ({
  cacheTtlMs: toNumber(process.env.COMPANIES_CACHE_TTL_MS, 30_000),
}));
