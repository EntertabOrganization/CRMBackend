import type { User } from '../domain';
import { AppError, badRequest, conflict } from '../errors';
import type { ProductService } from './product-service';
import type { PropertyService } from './property-service';
import { MAX_VARIANT_AXES, MAX_VARIANT_COMBINATIONS, axisKeyOf, cartesian, normalizeSku } from './product-model';
import type { CatalogSupport, Json } from './support';
import { assertOnlyKeys, isPlainObject } from './support';
import type { AxisValue, Product } from './types';
import { CATALOG_PERMISSIONS as P } from './types';

type Status = 'NEW' | 'EXISTING' | 'ARCHIVED_EXISTING';

type Combination = {
  status: Status;
  axisKey: string;
  axisValues: Array<AxisValue & { fieldLabel: string; optionLabel: string; optionCode: string }>;
  sku: string | null;
  variantId: string | null;
  action: 'CREATE' | 'KEEP' | 'REACTIVATE' | 'SKIP';
};

/**
 * Variation matrix: turns chosen axis options into the missing Variants. It only ever ADDS (or reactivates) Variants; an
 * existing combination keeps its identity, so running it twice is a no-op, and combinations that are no longer wanted are
 * reported - never silently deleted.
 */
export class VariantMatrixService {
  constructor(
    private readonly support: CatalogSupport,
    private readonly products: ProductService,
    private readonly properties: PropertyService,
  ) {}

  private get state() {
    return this.support.state;
  }

  generate(user: User, workspaceId: string, parentId: string, input: Json, headerKey?: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productCreate);
    assertOnlyKeys(input, ['axes', 'skuPrefix', 'skuOverrides', 'preview', 'archiveUnwanted', 'reactivateArchived', 'idempotencyKey'], 'variant matrix');
    const preview = input.preview === true;
    const archiveUnwanted = input.archiveUnwanted === true;
    if (archiveUnwanted) this.support.requireManage(actor, P.productArchive);
    const key = preview ? undefined : this.support.validateKey(input.idempotencyKey ?? headerKey);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const operation = `catalog.variants.generate:${parentId}`;
      const replay = this.support.recall(actor, operation, key, input);
      if (replay) return replay as unknown as ReturnType<VariantMatrixService['result']>;

      const parent = this.products.product(workspaceId, parentId, 'PRODUCT');
      if (parent.type !== 'PRODUCT_WITH_VARIANTS') throw new AppError('VARIANT_PARENT_INVALID', 'Only a product with variants has a variation matrix.', 400);
      if (parent.state !== 'ACTIVE') throw conflict('PRODUCT_PARENT_ARCHIVED', 'Variants can only be generated for an active parent product.');

      const axisSelection = this.readAxes(workspaceId, input.axes);
      const currentAxes = parent.variantAxes;
      const axisIds = axisSelection.map((axis) => axis.fieldId);
      const axesChange = JSON.stringify(axisIds) !== JSON.stringify(currentAxes);
      const activeVariants = this.products.variantsOf(parent.id).filter((variant) => variant.state !== 'ARCHIVED');
      if (axesChange && activeVariants.length > 0) {
        throw conflict('VARIANT_COMBINATION_CONFLICT', 'The variant axes of a family with active Variants are fixed. Archive the Variants (never silently rewritten) before changing axes.', { currentAxes, requestedAxes: axisIds });
      }

      const count = axisSelection.reduce((total, axis) => total * axis.options.length, 1);
      if (count > MAX_VARIANT_COMBINATIONS) {
        throw badRequest('VARIANT_MATRIX_TOO_LARGE', `The matrix would create ${count} combinations; the maximum is ${MAX_VARIANT_COMBINATIONS}.`, { combinations: count, maximum: MAX_VARIANT_COMBINATIONS });
      }

      const overrides = this.readSkuOverrides(input.skuOverrides);
      const prefix = typeof input.skuPrefix === 'string' && input.skuPrefix.trim() ? input.skuPrefix.trim() : null;
      const existingByKey = new Map<string, Product>();
      for (const variant of this.products.variantsOf(parent.id)) if (variant.axisKey) existingByKey.set(variant.axisKey, variant);

      const combinations: Combination[] = cartesian(axisSelection.map((axis) => axis.options)).map((picked) => {
        const axisValues = picked.map((option, index) => ({
          fieldId: axisSelection[index].fieldId,
          optionId: option.id,
          fieldLabel: axisSelection[index].label,
          optionLabel: option.label,
          optionCode: option.code,
        }));
        const axisKey = axisKeyOf(axisValues);
        const existing = existingByKey.get(axisKey);
        if (existing) {
          const archived = existing.state === 'ARCHIVED';
          return {
            status: archived ? 'ARCHIVED_EXISTING' : 'EXISTING',
            axisKey,
            axisValues,
            sku: existing.sku,
            variantId: existing.id,
            action: archived && input.reactivateArchived === true ? 'REACTIVATE' : archived ? 'SKIP' : 'KEEP',
          } as Combination;
        }
        const overrideSku = overrides.get(axisKey);
        const sku = overrideSku ?? (prefix ? `${prefix}-${axisValues.map((value) => value.optionCode.toUpperCase()).join('-')}` : null);
        return { status: 'NEW', axisKey, axisValues, sku, variantId: null, action: 'CREATE' } as Combination;
      });

      const wanted = new Set(combinations.map((combination) => combination.axisKey));
      const unwanted = activeVariants.filter((variant) => variant.axisKey && !wanted.has(variant.axisKey));

      const conflicts: Array<{ axisKey: string; sku: string | null; reason: string; productId?: string }> = [];
      const seenSku = new Set<string>();
      for (const combination of combinations.filter((item) => item.action === 'CREATE')) {
        if (!combination.sku) {
          conflicts.push({ axisKey: combination.axisKey, sku: null, reason: 'SKU_REQUIRED' });
          continue;
        }
        const normalized = normalizeSku(combination.sku, 'sku');
        const taken = this.state.catalogProducts.find((item) => item.workspaceId === workspaceId && item.skuKey === normalized.skuKey);
        if (taken) conflicts.push({ axisKey: combination.axisKey, sku: combination.sku, reason: 'SKU_TAKEN', productId: taken.id });
        else if (seenSku.has(normalized.skuKey)) conflicts.push({ axisKey: combination.axisKey, sku: combination.sku, reason: 'SKU_DUPLICATE_IN_REQUEST' });
        seenSku.add(normalized.skuKey);
      }

      const totals = {
        combinations: combinations.length,
        new: combinations.filter((item) => item.status === 'NEW').length,
        existing: combinations.filter((item) => item.status === 'EXISTING').length,
        archivedExisting: combinations.filter((item) => item.status === 'ARCHIVED_EXISTING').length,
        unwanted: unwanted.length,
      };
      const unwantedList = unwanted.map((variant) => ({ variantId: variant.id, sku: variant.sku, label: this.products.axisLabel(variant) }));

      if (preview) {
        return this.result(parent, true, axisSelection, totals, combinations, unwantedList, conflicts, { created: 0, reactivated: 0, archived: 0 });
      }
      if (conflicts.length > 0) {
        // The whole generation is refused: no partial family is ever created.
        throw conflict('PRODUCT_SKU_CONFLICT', 'One or more generated SKUs are missing, duplicated or already used.', { conflicts });
      }

      if (axesChange) {
        parent.variantAxes = axisIds;
        parent.version += 1;
        parent.updatedAt = new Date();
        parent.updatedByUserId = actor.user.id;
      }
      let created = 0;
      let reactivated = 0;
      let archived = 0;
      for (const combination of combinations) {
        if (combination.action === 'CREATE') {
          this.products.buildVariant(actor, workspaceId, parent.id, {
            sku: combination.sku,
            axisValues: combination.axisValues.map((value) => ({ fieldId: value.fieldId, optionId: value.optionId })),
          });
          created += 1;
        } else if (combination.action === 'REACTIVATE' && combination.variantId) {
          this.products.reactivate(user, workspaceId, combination.variantId, 'VARIANT');
          reactivated += 1;
        }
      }
      if (archiveUnwanted) {
        for (const variant of unwanted) {
          this.products.archive(user, workspaceId, variant.id, 'VARIANT', { reason: 'Removed from the variation matrix' });
          archived += 1;
        }
      }
      this.support.audit(actor, 'VARIANT.MATRIX_GENERATED', 'CatalogProduct', parent.id, null, { created, reactivated, archived, combinations: combinations.length });
      const result = this.result(parent, false, axisSelection, totals, combinations, unwantedList, [], { created, reactivated, archived });
      this.support.remember(actor, operation, key, input, result as unknown as Json);
      return result;
    });
  }

  private result(
    parent: Product,
    preview: boolean,
    axes: Array<{ fieldId: string; label: string; options: Array<{ id: string; code: string; label: string }> }>,
    totals: Json,
    combinations: Combination[],
    unwanted: unknown[],
    conflicts: unknown[],
    applied: { created: number; reactivated: number; archived: number },
  ) {
    return {
      preview,
      parentId: parent.id,
      axes: axes.map((axis) => ({ fieldId: axis.fieldId, label: axis.label, optionIds: axis.options.map((option) => option.id) })),
      maximum: MAX_VARIANT_COMBINATIONS,
      totals,
      combinations: combinations.map((item) => ({
        status: item.status,
        action: item.action,
        sku: item.sku,
        variantId: item.variantId,
        axisValues: item.axisValues.map((value) => ({ fieldId: value.fieldId, optionId: value.optionId, fieldLabel: value.fieldLabel, optionLabel: value.optionLabel })),
      })),
      unwanted,
      conflicts,
      applied,
    };
  }

  private readAxes(workspaceId: string, value: unknown) {
    if (!Array.isArray(value) || value.length === 0) throw badRequest('VALIDATION_ERROR', 'axes must list the variant axes with their selected option ids.', { field: 'axes' });
    if (value.length > MAX_VARIANT_AXES) throw badRequest('VALIDATION_ERROR', `At most ${MAX_VARIANT_AXES} variant axes are allowed.`, { field: 'axes' });
    const seen = new Set<string>();
    return value.map((entry, index) => {
      if (!isPlainObject(entry) || typeof entry.fieldId !== 'string' || !Array.isArray(entry.optionIds) || entry.optionIds.length === 0) {
        throw badRequest('VALIDATION_ERROR', `axes[${index}] needs fieldId and a non-empty optionIds array.`, { field: `axes[${index}]` });
      }
      const field = this.properties.axisField(workspaceId, entry.fieldId);
      if (!field) throw badRequest('PRODUCT_TYPE_INVALID', 'Every axis must be an active LIST property flagged as a variant axis.', { propertyId: entry.fieldId });
      if (seen.has(field.id)) throw badRequest('VALIDATION_ERROR', 'Each axis may only appear once.', { propertyId: field.id });
      seen.add(field.id);
      const unique = [...new Set(entry.optionIds as string[])];
      const options = unique.map((optionId) => {
        const option = this.state.crmCustomFieldOptions.find((item) => item.id === optionId && item.fieldId === field.id && item.workspaceId === workspaceId);
        if (!option) throw new AppError('FIELD_OPTION_NOT_FOUND', 'The selected option does not exist.', 404, { propertyId: field.id, optionId });
        if (!option.isActive) throw conflict('FIELD_OPTION_INACTIVE', 'The selected option is no longer available.', { optionId });
        return { id: option.id, code: option.code, label: option.label };
      });
      return { fieldId: field.id, label: field.label, options };
    });
  }

  private readSkuOverrides(value: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (value === undefined || value === null) return map;
    if (!Array.isArray(value)) throw badRequest('VALIDATION_ERROR', 'skuOverrides must be an array.', { field: 'skuOverrides' });
    for (const entry of value) {
      if (!isPlainObject(entry) || !Array.isArray(entry.axisValues) || typeof entry.sku !== 'string') throw badRequest('VALIDATION_ERROR', 'Each SKU override needs axisValues and sku.', { field: 'skuOverrides' });
      const values = (entry.axisValues as unknown[]).map((item) => {
        if (!isPlainObject(item) || typeof item.fieldId !== 'string' || typeof item.optionId !== 'string') throw badRequest('VALIDATION_ERROR', 'Invalid axis value in skuOverrides.', { field: 'skuOverrides' });
        return { fieldId: item.fieldId, optionId: item.optionId };
      });
      map.set(axisKeyOf(values), entry.sku);
    }
    return map;
  }
}
