import { canonicalDecimal, compareDecimals } from '../fields/decimal';
import { badRequest } from '../errors';
import type { AxisValue, InheritableAttribute, Product, ProductType } from './types';

export const SELLABLE_TYPES: ProductType[] = ['SIMPLE_PRODUCT', 'VARIANT', 'SERVICE'];
export const MAX_VARIANT_AXES = 5;
export const MAX_VARIANT_COMBINATIONS = 250;

export const isSellable = (product: Pick<Product, 'type'>) => SELLABLE_TYPES.includes(product.type);

/**
 * SKU normalization (explicit, single policy): the SKU is trimmed and stored as entered; uniqueness is compared
 * case-insensitively so "ab-1" and "AB-1" can never coexist in one workspace.
 */
export function normalizeSku(value: unknown, field = 'sku'): { sku: string; skuKey: string } {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('VALIDATION_ERROR', `${field} is required.`, { field });
  const sku = value.trim();
  if (sku.length > 100 || /[\u0000-\u001f]/.test(sku)) {
    throw badRequest('VALIDATION_ERROR', `${field} must be at most 100 printable characters.`, { field });
  }
  return { sku, skuKey: sku.toLowerCase() };
}

export function decimalField(value: unknown, field: string, options: { min?: string; max?: string; maxScale?: number } = {}): string | null {
  if (value === undefined || value === null || value === '') return null;
  const canonical = canonicalDecimal(value, options.maxScale ?? 8);
  if (canonical === null) throw badRequest('VALIDATION_ERROR', `${field} must be a valid decimal number.`, { field });
  if (options.min !== undefined && (compareDecimals(canonical, options.min) ?? 0) < 0) throw badRequest('VALIDATION_ERROR', `${field} must be at least ${options.min}.`, { field });
  if (options.max !== undefined && (compareDecimals(canonical, options.max) ?? 0) > 0) throw badRequest('VALIDATION_ERROR', `${field} must be at most ${options.max}.`, { field });
  return canonical;
}

/** Deterministic normalized combination key: sorted `fieldId=optionId` pairs. Two Variants of one parent can never share it. */
export function axisKeyOf(values: AxisValue[]): string {
  return [...values]
    .map((value) => `${value.fieldId}=${value.optionId}`)
    .sort()
    .join('|');
}

/** The Variant-level value of an inheritable attribute group, or the parent's when the Variant does not override it. */
export function overrides(variant: Product, attribute: InheritableAttribute): boolean {
  return variant.type === 'VARIANT' && variant.overrides.includes(attribute);
}

export type EffectiveProduct = {
  name: string;
  description: string | null;
  shortDescription: string | null;
  primaryUnitId: string | null;
  taxable: boolean;
  taxRate: string | null;
  taxIncluded: boolean;
  taxCode: string | null;
  weight: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
  inherited: Record<InheritableAttribute, boolean>;
};

/**
 * Explicit inheritance contract: `effective = variant override, else parent value`. Nothing is copied from parent to
 * Variant, so a parent edit is immediately visible on every non-overridden Variant and can never clobber an override.
 */
export function effectiveValues(product: Product, parent: Product | undefined, axisLabel: string): EffectiveProduct {
  if (product.type !== 'VARIANT' || !parent) {
    return {
      name: product.name,
      description: product.description,
      shortDescription: product.shortDescription,
      primaryUnitId: product.primaryUnitId,
      taxable: product.taxable,
      taxRate: product.taxRate,
      taxIncluded: product.taxIncluded,
      taxCode: product.taxCode,
      weight: product.weight,
      length: product.length,
      width: product.width,
      height: product.height,
      inherited: { name: false, description: false, shortDescription: false, primaryUnitId: false, tax: false, dimensions: false, media: false, prices: false },
    };
  }
  const own = (attribute: InheritableAttribute) => product.overrides.includes(attribute);
  const tax = own('tax') ? product : parent;
  const dimensions = own('dimensions') ? product : parent;
  return {
    name: own('name') ? product.name : axisLabel ? `${parent.name} — ${axisLabel}` : parent.name,
    description: own('description') ? product.description : parent.description,
    shortDescription: own('shortDescription') ? product.shortDescription : parent.shortDescription,
    primaryUnitId: own('primaryUnitId') ? product.primaryUnitId : parent.primaryUnitId,
    taxable: tax.taxable,
    taxRate: tax.taxRate,
    taxIncluded: tax.taxIncluded,
    taxCode: tax.taxCode,
    weight: dimensions.weight,
    length: dimensions.length,
    width: dimensions.width,
    height: dimensions.height,
    inherited: {
      name: !own('name'),
      description: !own('description'),
      shortDescription: !own('shortDescription'),
      primaryUnitId: !own('primaryUnitId'),
      tax: !own('tax'),
      dimensions: !own('dimensions'),
      media: !own('media'),
      prices: !own('prices'),
    },
  };
}

/** Cartesian product of the option lists, preserving axis order. */
export function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]]);
}
