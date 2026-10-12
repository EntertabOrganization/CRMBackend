import { z } from 'zod';
import { AppError } from '../errors';
export const inventoryVersion = z.union([z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value)<=9223372036854775807n),z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export function assertInventoryVersion(actual: bigint,expected: string) {
  if (actual!==BigInt(expected)) throw new AppError('RESOURCE_VERSION_CONFLICT','Resource changed; reload and retry.',409);
}
export const warehouseType = z.enum(['PHYSICAL','STORE','FULFILLMENT','RETURNS','DAMAGED','TRANSIT','VIRTUAL']);
export const warehouseStatus = z.enum(['ACTIVE','INACTIVE','ARCHIVED']);
export const documentType = z.enum(['STOCK_RECEIPT','STOCK_ADJUSTMENT','TRANSFER','SALES_ORDER','CUSTOMER_RETURN','SUPPLIER_RETURN','WRITE_OFF']);
export const quantity = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/);
export const positiveQuantity = quantity.refine(value => /[1-9]/.test(value),'Quantity must be positive');
