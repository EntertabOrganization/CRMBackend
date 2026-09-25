import type { ActorContext } from '../access-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict } from '../errors';
import type { FieldEngine } from '../fields/field-engine';
import type { FieldCapableEntityAdapter, SystemFieldDescriptor } from '../fields/entity-registry';
import type { CustomField } from '../fields/types';
import type { CatalogSupport, Json } from './support';
import { assertOnlyKeys, optionalBoolean, optionalInt } from './support';
import type { ProductType, PropertyAppliesTo, PropertyProfile } from './types';
import { CATALOG_PERMISSIONS as P, PRODUCT_TYPES, PROPERTY_APPLIES_TO } from './types';

export const PRODUCT_ENTITY_TYPE = 'PRODUCT';

const SYSTEM_FIELDS: SystemFieldDescriptor[] = [
  { key: 'name', label: 'Name', dataType: 'TEXT', requirementCapable: false, conditionCapable: true, editable: true },
  { key: 'sku', label: 'SKU', dataType: 'TEXT', requirementCapable: false, conditionCapable: true, editable: true },
  { key: 'description', label: 'Description', dataType: 'TEXT', requirementCapable: true, conditionCapable: true, editable: true },
  { key: 'shortDescription', label: 'Short description', dataType: 'TEXT', requirementCapable: true, conditionCapable: true, editable: true },
  { key: 'barcode', label: 'Barcode', dataType: 'TEXT', requirementCapable: true, conditionCapable: true, editable: true },
  { key: 'state', label: 'State', dataType: 'ENUM', requirementCapable: false, conditionCapable: true, editable: false },
];

/**
 * Registers Catalog Products with the shared Custom Fields engine, so Product properties reuse its typed storage,
 * validation, field-level restrictions and required-field rules instead of a second metadata engine. Record access is
 * decided by Catalog permissions (a Product has no owning user, so any scope of the permission is enough).
 */
export class ProductFieldEntityAdapter implements FieldCapableEntityAdapter {
  readonly entityType = PRODUCT_ENTITY_TYPE;
  readonly label = 'Product';
  readonly supportsPipeline = false;

  constructor(private readonly support: CatalogSupport) {}

  systemFields() {
    return SYSTEM_FIELDS.map((descriptor) => ({ ...descriptor }));
  }

  systemValues(record: unknown): Record<string, unknown> {
    const source = record as Record<string, unknown>;
    return Object.fromEntries(SYSTEM_FIELDS.map((descriptor) => [descriptor.key, source[descriptor.key]]));
  }

  findRecord(workspaceId: string, entityId: string) {
    return this.support.state.catalogProducts.find((item) => item.id === entityId && item.workspaceId === workspaceId);
  }

  canRead(actor: ActorContext) {
    return this.support.hasAny(actor, P.productRead, P.catalogRead, P.catalogManage);
  }

  canUpdate(actor: ActorContext) {
    return this.support.hasAny(actor, P.productUpdate, P.productCreate);
  }

  canCreate(actor: ActorContext) {
    return this.support.hasAny(actor, P.productCreate);
  }
}

const PROFILE_KEYS = ['appliesTo', 'variantAxis', 'filterable', 'searchable', 'displayOnCard', 'displayInList', 'storefrontVisible', 'categoryIds', 'allowedTypes', 'sortOrder'] as const;

/**
 * Catalog-specific metadata over shared Custom Fields (entityType PRODUCT): variant axes, filter/search/display flags,
 * category and product-type applicability. The generic field flags stay owned by the field engine.
 */
export class PropertyService {
  constructor(
    private readonly support: CatalogSupport,
    private readonly fields: FieldEngine,
  ) {}

  private get state() {
    return this.support.state;
  }

  /** Default profile for a PRODUCT field that has no explicit Catalog metadata (created through the generic field API). */
  profileFor(workspaceId: string, fieldId: string): PropertyProfile {
    const existing = this.state.catalogPropertyProfiles.find((row) => row.fieldId === fieldId && row.workspaceId === workspaceId);
    if (existing) return existing;
    const now = new Date(0);
    return {
      id: `default:${fieldId}`,
      workspaceId,
      fieldId,
      appliesTo: 'BOTH',
      variantAxis: false,
      filterable: false,
      searchable: false,
      displayOnCard: false,
      displayInList: false,
      storefrontVisible: false,
      categoryIds: [],
      allowedTypes: [],
      sortOrder: 0,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  productFields(workspaceId: string): CustomField[] {
    return this.state.crmCustomFields.filter((field) => field.workspaceId === workspaceId && field.entityType === PRODUCT_ENTITY_TYPE);
  }

  private productField(workspaceId: string, fieldId: string): CustomField {
    const field = this.state.crmCustomFields.find((item) => item.id === fieldId && item.workspaceId === workspaceId && item.entityType === PRODUCT_ENTITY_TYPE);
    if (!field) throw new AppError('CUSTOM_FIELD_NOT_FOUND', 'Product property was not found.', 404);
    return field;
  }

  /** An active LIST property flagged as a variant axis. */
  axisField(workspaceId: string, fieldId: string): CustomField | null {
    const field = this.state.crmCustomFields.find((item) => item.id === fieldId && item.workspaceId === workspaceId && item.entityType === PRODUCT_ENTITY_TYPE);
    if (!field || !field.isActive || field.fieldType !== 'LIST') return null;
    return this.profileFor(workspaceId, fieldId).variantAxis ? field : null;
  }

  toDto(field: CustomField) {
    const profile = this.profileFor(field.workspaceId, field.id);
    const admin = this.fields.definitions.toAdminDto(field);
    return {
      id: field.id,
      code: field.code,
      label: field.label,
      helpText: field.helpText ?? null,
      fieldType: field.fieldType,
      isMultiple: field.isMultiple,
      isActive: field.isActive,
      validationConfig: field.validationConfig ?? null,
      options: admin.options,
      version: field.version,
      schemaVersion: admin.schemaVersion,
      catalog: {
        appliesTo: profile.appliesTo,
        variantAxis: profile.variantAxis,
        filterable: profile.filterable,
        searchable: profile.searchable,
        displayOnCard: profile.displayOnCard,
        displayInList: profile.displayInList,
        storefrontVisible: profile.storefrontVisible,
        categoryIds: profile.categoryIds,
        allowedTypes: profile.allowedTypes,
        sortOrder: profile.sortOrder,
        version: profile.version,
      },
    };
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.propertyManage);
    const axisOnly = searchParams.get('variantAxis');
    const includeInactive = searchParams.get('includeInactive') === 'true';
    const rows = this.productFields(workspaceId)
      .filter((field) => includeInactive || field.isActive)
      .filter((field) => axisOnly === null || this.profileFor(workspaceId, field.id).variantAxis === (axisOnly === 'true'))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
    return { data: rows.map((field) => this.toDto(field)), meta: null };
  }

  private parseProfile(input: Json, current: PropertyProfile | null, fieldType: string, workspaceId: string) {
    assertOnlyKeys(input, [...PROFILE_KEYS, 'version'], 'property catalog settings');
    const next = {
      appliesTo: (current?.appliesTo ?? 'BOTH') as PropertyAppliesTo,
      variantAxis: current?.variantAxis ?? false,
      filterable: current?.filterable ?? false,
      searchable: current?.searchable ?? false,
      displayOnCard: current?.displayOnCard ?? false,
      displayInList: current?.displayInList ?? false,
      storefrontVisible: current?.storefrontVisible ?? false,
      categoryIds: current?.categoryIds ?? [],
      allowedTypes: current?.allowedTypes ?? ([] as ProductType[]),
      sortOrder: current?.sortOrder ?? 0,
    };
    if (input.appliesTo !== undefined) {
      if (!PROPERTY_APPLIES_TO.includes(input.appliesTo as PropertyAppliesTo)) throw badRequest('VALIDATION_ERROR', 'appliesTo must be PARENT, SELLABLE or BOTH.', { field: 'appliesTo' });
      next.appliesTo = input.appliesTo as PropertyAppliesTo;
    }
    for (const key of ['variantAxis', 'filterable', 'searchable', 'displayOnCard', 'displayInList', 'storefrontVisible'] as const) {
      const value = optionalBoolean(input[key], key);
      if (value !== undefined) next[key] = value;
    }
    if (input.categoryIds !== undefined) {
      if (!Array.isArray(input.categoryIds) || input.categoryIds.some((id) => typeof id !== 'string')) throw badRequest('VALIDATION_ERROR', 'categoryIds must be an array of category ids.', { field: 'categoryIds' });
      const ids = [...new Set(input.categoryIds as string[])];
      for (const id of ids) {
        if (!this.state.catalogCategories.some((row) => row.id === id && row.workspaceId === workspaceId)) throw new AppError('CATEGORY_NOT_FOUND', 'A category was not found.', 404, { categoryId: id });
      }
      next.categoryIds = ids;
    }
    if (input.allowedTypes !== undefined) {
      if (!Array.isArray(input.allowedTypes) || input.allowedTypes.some((type) => !PRODUCT_TYPES.includes(type as ProductType))) throw badRequest('VALIDATION_ERROR', 'allowedTypes must list valid product types.', { field: 'allowedTypes' });
      next.allowedTypes = [...new Set(input.allowedTypes as ProductType[])];
    }
    if (input.sortOrder !== undefined) next.sortOrder = optionalInt(input.sortOrder, 'sortOrder', 0, 100000)!;
    if (next.variantAxis) {
      // Axes need a stable, finite, single-valued option identity to build a deterministic combination key.
      if (fieldType !== 'LIST') throw badRequest('PROPERTY_AXIS_TYPE_INVALID', 'Only LIST properties can be variant axes.', { field: 'variantAxis' });
      next.appliesTo = 'SELLABLE';
    }
    return next;
  }

  /** Creates the shared field definition (entityType forced to PRODUCT) and its Catalog metadata in one atomic step. */
  create(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.propertyManage);
    const { catalog, ...definition } = input as Json & { catalog?: Json };
    if (definition.entityType !== undefined && definition.entityType !== PRODUCT_ENTITY_TYPE) throw badRequest('CATALOG_FIELD_NOT_UPDATABLE', 'entityType is fixed to PRODUCT for Catalog properties.');
    return this.support.store.atomicSync(() => {
      const profileInput = (catalog ?? {}) as Json;
      const created = this.fields.definitions.runWithDelegatedManagePermission(P.propertyManage, () =>
        this.fields.definitions.create(user, workspaceId, { ...definition, entityType: PRODUCT_ENTITY_TYPE }),
      );
      const parsed = this.parseProfile(profileInput, null, created.fieldType, workspaceId);
      this.insertProfile(workspaceId, created.id, parsed);
      this.support.audit(actor, 'PRODUCT_PROPERTY.CREATED', 'CatalogPropertyProfile', created.id, null, { code: created.code, variantAxis: parsed.variantAxis });
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PROPERTY_CHANGED', 'PRODUCT_PROPERTY', created.id, { change: 'CREATED' });
      return this.toDto(this.productField(workspaceId, created.id));
    });
  }

  private insertProfile(workspaceId: string, fieldId: string, parsed: ReturnType<PropertyService['parseProfile']>) {
    const now = new Date();
    const row: PropertyProfile = { id: this.support.store.id(), workspaceId, fieldId, ...parsed, version: 1, createdAt: now, updatedAt: now };
    this.state.catalogPropertyProfiles.push(row);
    return row;
  }

  /** Updates the shared field definition (label/help/validation) - the Catalog flags use updateCatalogSettings. */
  update(user: User, workspaceId: string, fieldId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.propertyManage);
    this.productField(workspaceId, fieldId);
    return this.support.store.atomicSync(() => {
      this.fields.definitions.runWithDelegatedManagePermission(P.propertyManage, () => this.fields.definitions.update(user, workspaceId, fieldId, input));
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PROPERTY_CHANGED', 'PRODUCT_PROPERTY', fieldId, { change: 'UPDATED' });
      return this.toDto(this.productField(workspaceId, fieldId));
    });
  }

  updateCatalogSettings(user: User, workspaceId: string, fieldId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.propertyManage);
    return this.support.store.atomicSync(() => {
      const field = this.productField(workspaceId, fieldId);
      const existing = this.state.catalogPropertyProfiles.find((row) => row.fieldId === fieldId && row.workspaceId === workspaceId) ?? null;
      const current = this.profileFor(workspaceId, fieldId);
      if (existing) this.support.assertVersion(existing.version, input.version, 'property');
      const parsed = this.parseProfile(input, current, field.fieldType, workspaceId);
      if (current.variantAxis && !parsed.variantAxis) {
        const usedBy = this.axisUsage(workspaceId, fieldId);
        if (usedBy.length > 0) throw conflict('PROPERTY_IN_USE', 'This property is a variant axis of existing Products.', { productIds: usedBy });
      }
      if (parsed.variantAxis && !current.variantAxis) {
        const holders = this.state.crmCustomFieldValues.filter((row) => row.fieldId === fieldId).length;
        if (holders > 0) throw conflict('PROPERTY_IN_USE', 'A property that already holds Product values cannot become a variant axis.');
      }
      const before = { ...current };
      let row = existing;
      if (!row) {
        row = this.insertProfile(workspaceId, fieldId, parsed);
      } else {
        Object.assign(row, parsed);
        row.version += 1;
        row.updatedAt = new Date();
      }
      this.support.audit(actor, 'PRODUCT_PROPERTY.SETTINGS_CHANGED', 'CatalogPropertyProfile', row.id, before, parsed);
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PROPERTY_CHANGED', 'PRODUCT_PROPERTY', fieldId, { change: 'SETTINGS' });
      return this.toDto(field);
    });
  }

  reorder(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.propertyManage);
    return this.support.store.atomicSync(() => {
      const ids = input.orderedFieldIds;
      if (Array.isArray(ids)) for (const id of ids) this.productField(workspaceId, id as string);
      const result = this.fields.definitions.runWithDelegatedManagePermission(P.propertyManage, () =>
        this.fields.definitions.reorder(user, workspaceId, { entityType: PRODUCT_ENTITY_TYPE, orderedFieldIds: ids as string[], expectedSchemaVersion: input.expectedSchemaVersion as number }),
      );
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PROPERTY_CHANGED', 'PRODUCT_PROPERTY', workspaceId, { change: 'REORDERED' });
      return result;
    });
  }

  // ---- options (stable ids/codes; used options are deactivated, never removed) ------------------------------------------

  listOptions(user: User, workspaceId: string, fieldId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.propertyManage);
    this.productField(workspaceId, fieldId);
    return this.state.crmCustomFieldOptions
      .filter((option) => option.fieldId === fieldId && option.workspaceId === workspaceId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((option) => ({
        ...option,
        inUse: this.state.crmCustomFieldValues.some((row) => row.fieldId === fieldId && row.valueUuid === option.id),
        variantUsageCount: this.activeVariantsUsing(workspaceId, fieldId, option.id).length,
      }));
  }

  createOption(user: User, workspaceId: string, fieldId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.propertyManage);
    this.productField(workspaceId, fieldId);
    return this.support.store.atomicSync(() => {
      const option = this.fields.definitions.runWithDelegatedManagePermission(P.propertyManage, () => this.fields.definitions.createOption(user, workspaceId, fieldId, input));
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PROPERTY_CHANGED', 'PRODUCT_PROPERTY', fieldId, { change: 'OPTION_CREATED' });
      return option;
    });
  }

  updateOption(user: User, workspaceId: string, fieldId: string, optionId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.propertyManage);
    this.productField(workspaceId, fieldId);
    assertOnlyKeys(input, ['label', 'version', 'isActive'], 'property option');
    return this.support.store.atomicSync(() => {
      let option = this.state.crmCustomFieldOptions.find((item) => item.id === optionId && item.fieldId === fieldId && item.workspaceId === workspaceId);
      if (!option) throw new AppError('CUSTOM_FIELD_OPTION_NOT_FOUND', 'Option was not found.', 404);
      if (input.label !== undefined) {
        option = this.fields.definitions.runWithDelegatedManagePermission(P.propertyManage, () => this.fields.definitions.updateOption(user, workspaceId, fieldId, optionId, { label: input.label as string, version: input.version as number }));
      }
      if (input.isActive !== undefined) {
        const active = optionalBoolean(input.isActive, 'isActive')!;
        if (!active) {
          const impacted = this.activeVariantsUsing(workspaceId, fieldId, optionId);
          if (impacted.length > 0) {
            throw conflict('PROPERTY_OPTION_IN_USE', 'Active Variants use this option. Archive or re-assign them before deactivating it.', { variantIds: impacted.slice(0, 50), variantCount: impacted.length });
          }
        }
        option = this.fields.definitions.runWithDelegatedManagePermission(P.propertyManage, () => this.fields.definitions.setOptionActive(user, workspaceId, fieldId, optionId, active));
      }
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PROPERTY_CHANGED', 'PRODUCT_PROPERTY', fieldId, { change: 'OPTION_UPDATED' });
      return option;
    });
  }

  // ---- dependency reporting ------------------------------------------------------------------------------------------

  /** Parents that use the property as a variant axis (non-archived). */
  axisUsage(workspaceId: string, fieldId: string): string[] {
    return this.state.catalogProducts
      .filter((product) => product.workspaceId === workspaceId && product.type === 'PRODUCT_WITH_VARIANTS' && product.state !== 'ARCHIVED' && product.variantAxes.includes(fieldId))
      .map((product) => product.id);
  }

  activeVariantsUsing(workspaceId: string, fieldId: string, optionId: string): string[] {
    return this.state.catalogProducts
      .filter(
        (product) =>
          product.workspaceId === workspaceId &&
          product.type === 'VARIANT' &&
          product.state !== 'ARCHIVED' &&
          (product.axisValues ?? []).some((value) => value.fieldId === fieldId && value.optionId === optionId),
      )
      .map((product) => product.id);
  }

  /** Registered with the shared field engine so deactivating a property reports Catalog dependencies. */
  dependencyProvider = (workspaceId: string, field: CustomField) => {
    if (field.entityType !== PRODUCT_ENTITY_TYPE) return [];
    return this.axisUsage(workspaceId, field.id).map((productId) => ({
      module: 'Products & Catalog',
      type: 'VARIANT_AXIS',
      id: productId,
      description: 'Used as a variant axis of a Product family.',
      remediation: 'Archive the Product family or remove the axis before deactivating the property.',
    }));
  };
}
