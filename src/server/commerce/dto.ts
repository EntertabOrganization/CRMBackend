import { z } from 'zod';
import { AppError } from '../errors';
import { isValidCurrency } from '../catalog/money';
export const commerceVersion = z.union([z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value)<=9223372036854775807n),z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export const commerceCurrency = z.string().refine(isValidCurrency,'An ISO currency supported by the Catalog money service is required');
export function assertCommerceVersion(actual: bigint,expected: string) {
  if (actual!==BigInt(expected)) throw new AppError('RESOURCE_VERSION_CONFLICT','Resource changed; reload and retry.',409);
}
export const slug = z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const reservationTiming = z.enum(['CART','ORDER_PLACED','PAYMENT_AUTHORIZED','PAYMENT_PAID','MANUAL']);
export const dealPolicy = z.enum(['NEVER','ALWAYS','ONLY_NEW_CUSTOMER','MANUAL_REVIEW']);
