import { Prisma } from '@prisma/client';
import { AppError } from '../errors';
/** Pack arithmetic requires enough precision for NUMERIC(24,6) multiplication before final rounding. */
export const ExactDecimal = Prisma.Decimal.clone({ precision: 60,rounding: Prisma.Decimal.ROUND_HALF_EVEN });
export const exact = (value: Prisma.Decimal.Value) => new ExactDecimal(value);
export function numeric24(value: Prisma.Decimal.Value) {
  const rounded = exact(value).toDecimalPlaces(6);
  if (!rounded.isFinite() || rounded.abs().gte('1000000000000000000')) throw new AppError('INVENTORY_LINE_INVALID','Quantity or cost exceeds numeric precision.',422);
  return rounded.toFixed(6);
}
