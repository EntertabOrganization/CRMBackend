import type { ActorContext } from '../access-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict, fieldValidationFailed } from '../errors';
import type { FieldEngine } from '../fields/field-engine';
import type { CategoryService } from './catalog-service';
import type { UnitService } from './master-data-service';
import type { ProductPriceService } from './price-service';
import type { PropertyService } from './property-service';
import { PRODUCT_ENTITY_TYPE } from './property-service';
import {
  MAX_VARIANT_AXES,
  axisKeyOf,
  decimalField,
  effectiveValues,
  isSellable,
  normalizeSku,
} from './product-model';
import type { CatalogSupport, Json } from './support';
import { assertOnlyKeys, isPlainObject, optionalBoolean, optionalInt, optionalText, requiredText } from './support';
import type { AxisValue, CatalogUnit, InheritableAttribute, Product, ProductMedia, ProductState, ProductType, ProductUnitRatio } from './types';
import { CATALOG_PERMISSIONS as P, INHERITABLE_ATTRIBUTES } from './types';
import { canonicalDecimal } from '../fields/decimal';
import { toScaled } from './money';

const CREATE_TYPES: ProductType[] = ['SIMPLE_PRODUCT', 'PRODUCT_WITH_VARIANTS', 'SERVICE'];
const SHARED_KEYS = ['name', 'description', 'shortDescription', 'primaryUnitId', 'taxable', 'taxRate', 'taxIncluded', 'taxCode', 'weight', 'length', 'width', 'height', 'barcode', 'customFields'] as const;
const PRODUCT_CREATE_KEYS = [...SHARED_KEYS, 'type', 'catalogId', 'sku', 'categoryIds', 'primaryCategoryId', 'prices', 'variantAxes', 'state', 'idempotencyKey', 'inventoryTracking', 'enforceBatchExpiry'] as const;
const PRODUCT_UPDATE_KEYS = [...SHARED_KEYS, 'type', 'version', 'sku', 'categoryIds', 'primaryCategoryId', 'variantAxes', 'state', 'inventoryTracking', 'enforceBatchExpiry'] as const;
const VARIANT_CREATE_KEYS = [...SHARED_KEYS, 'sku', 'axisValues', 'prices', 'state', 'idempotencyKey'] as const;
const VARIANT_UPDATE_KEYS = [...SHARED_KEYS, 'version', 'sku', 'axisValues', 'inherit', 'state'] as const;
const SORTABLE = ['name', 'sku', 'createdAt', 'updatedAt', 'type', 'state'] as const;

export type ProductUsageChecker = (workspaceId: string, productIds: string[]) => { module: string; count: number };

/** What a commercial row needs to snapshot for one sellable item (effective values, never raw columns). */
export type SellableView = {
  product: Product;
  parent: Product | undefined;
  name: string;
  sku: string | null;
  variantLabel: string | null;
  unit: CatalogUnit | null;
  tax: { taxable: boolean; rate: string | null; included: boolean; code: string | null };
  ratios: ProductUnitRatio[];
};

export class ProductService {
  private readonly usageCheckers: ProductUsageChecker[] = [];

  constructor(
    private readonly support: CatalogSupport,
    private readonly categories: CategoryService,
    private readonly units: UnitService,
    private readonly prices: ProductPriceService,
    private readonly properties: PropertyService,
    private readonly fields: FieldEngine,
  ) {
    // Commercial rows are the built-in dependency; Inventory/Commerce register their own checkers later.
    this.registerUsageChecker((workspaceId, ids) => ({
      module: 'CRM product rows',
      count: this.support.state.commercialProductRows.filter((row) => row.workspaceId === workspaceId && row.productId !== null && ids.includes(row.productId)).length,
    }));
  }

  registerUsageChecker(checker: ProductUsageChecker) {
    this.usageCheckers.push(checker);
  }

  private get state() {
    return this.support.state;
  }

  // ---- lookups -----------------------------------------------------------------------------------------------------

  product(workspaceId: string, productId: unknown, expect: 'PRODUCT' | 'VARIANT' | 'ANY' = 'ANY'): Product {
    const row = typeof productId === 'string' ? this.state.catalogProducts.find((item) => item.id === productId && item.workspaceId === workspaceId) : undefined;
    if (!row || (expect === 'VARIANT' && row.type !== 'VARIANT') || (expect === 'PRODUCT' && row.type === 'VARIANT')) {
      throw new AppError('PRODUCT_NOT_FOUND', expect === 'VARIANT' ? 'Variant was not found.' : 'Product was not found.', 404);
    }
    return row;
  }

  parentOf(product: Product): Product | undefined {
    return product.parentId ? this.state.catalogProducts.find((item) => item.id === product.parentId && item.workspaceId === product.workspaceId) : undefined;
  }

  variantsOf(parentId: string) {
    return this.state.catalogProducts.filter((item) => item.parentId === parentId && item.type === 'VARIANT');
  }

  private assertEditable(product: Product) {
    if (product.state === 'ARCHIVED') throw conflict('PRODUCT_ARCHIVED', 'An archived item cannot be edited. Reactivate it first.', { productId: product.id });
  }

  // ---- effective view ----------------------------------------------------------------------------------------------

  private optionLabel(fieldId: string, optionId: string) {
    return this.state.crmCustomFieldOptions.find((option) => option.fieldId === fieldId && option.id === optionId)?.label ?? '';
  }

  axisLabel(product: Product): string {
    return (product.axisValues ?? []).map((value) => this.optionLabel(value.fieldId, value.optionId)).filter(Boolean).join(' / ');
  }

  effective(product: Product) {
    const parent = this.parentOf(product);
    return { parent, values: effectiveValues(product, parent, this.axisLabel(product)) };
  }

  categoriesOf(product: Product) {
    const owner = product.type === 'VARIANT' ? this.parentOf(product) ?? product : product;
    return {
      ownerId: owner.id,
      primaryCategoryId: owner.primaryCategoryId,
      categoryIds: this.state.catalogProductCategories.filter((row) => row.productId === owner.id).sort((a, b) => a.sortOrder - b.sortOrder).map((row) => row.categoryId),
    };
  }

  ratiosOf(product: Product): { rows: ProductUnitRatio[]; inherited: boolean } {
    const own = this.state.catalogUnitRatios.filter((row) => row.productId === product.id);
    const parent = this.parentOf(product);
    if (product.type === 'VARIANT' && parent && own.length === 0) return { rows: this.state.catalogUnitRatios.filter((row) => row.productId === parent.id), inherited: true };
    return { rows: own, inherited: false };
  }

  mediaOf(product: Product): { rows: ProductMedia[]; inherited: boolean } {
    const parent = this.parentOf(product);
    if (product.type === 'VARIANT' && parent && !product.overrides.includes('media')) return { rows: this.state.catalogProductMedia.filter((row) => row.productId === parent.id), inherited: true };
    return { rows: this.state.catalogProductMedia.filter((row) => row.productId === product.id), inherited: false };
  }

  /** Sellable, active, catalog-active view used by Product Rows and pickers. Returns null when the item is not offerable. */
  sellable(workspaceId: string, productId: string, options: { allowArchived?: boolean } = {}): SellableView | null {
    const product = this.state.catalogProducts.find((item) => item.id === productId && item.workspaceId === workspaceId);
    if (!product || !isSellable(product)) return null;
    const parent = this.parentOf(product);
    if (!options.allowArchived) {
      if (product.state !== 'ACTIVE') return null;
      if (parent && parent.state !== 'ACTIVE') return null;
      const catalog = this.state.catalogs.find((item) => item.id === product.catalogId);
      if (!catalog?.isActive) return null;
    }
    const { values } = this.effective(product);
    return {
      product,
      parent,
      name: values.name,
      sku: product.sku,
      variantLabel: product.type === 'VARIANT' ? this.axisLabel(product) || null : null,
      unit: values.primaryUnitId ? this.state.catalogUnits.find((unit) => unit.id === values.primaryUnitId && unit.workspaceId === workspaceId) ?? null : null,
      tax: { taxable: values.taxable, rate: values.taxRate, included: values.taxIncluded, code: values.taxCode },
      ratios: this.ratiosOf(product).rows,
    };
  }

  // ---- DTOs ---------------------------------------------------------------------------------------------------------

  private customFieldValues(actor: ActorContext, product: Product) {
    const own = this.fields.decorate(actor, PRODUCT_ENTITY_TYPE, [{ id: product.id }])[0]?.customFields ?? {};
    const parent = this.parentOf(product);
    if (product.type !== 'VARIANT' || !parent) return { values: own, inherited: [] as string[] };
    const parentValues = this.fields.decorate(actor, PRODUCT_ENTITY_TYPE, [{ id: parent.id }])[0]?.customFields ?? {};
    const merged: Record<string, unknown> = { ...own };
    const inherited: string[] = [];
    for (const field of this.properties.productFields(product.workspaceId)) {
      const profile = this.properties.profileFor(product.workspaceId, field.id);
      if (profile.variantAxis || profile.appliesTo !== 'BOTH') continue;
      const value = own[field.code];
      const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
      if (empty && field.code in parentValues) {
        merged[field.code] = parentValues[field.code];
        inherited.push(field.code);
      }
    }
    return { values: merged, inherited };
  }

  compact(product: Product) {
    const { parent, values } = this.effective(product);
    const settings = this.support.settings(product.workspaceId);
    const category = this.categoriesOf(product);
    const primary = category.primaryCategoryId ? this.state.catalogCategories.find((item) => item.id === category.primaryCategoryId) : undefined;
    const unit = values.primaryUnitId ? this.state.catalogUnits.find((item) => item.id === values.primaryUnitId) : undefined;
    const effectivePrices = settings.basePriceTypeId ? this.prices.effectiveRows(product, parent).rows.filter((row) => row.priceTypeId === settings.basePriceTypeId) : [];
    const base = effectivePrices.sort((a, b) => a.currency.localeCompare(b.currency))[0];
    return {
      id: product.id,
      catalogId: product.catalogId,
      type: product.type,
      parentId: product.parentId,
      parentName: parent?.name ?? null,
      name: values.name,
      sku: product.sku,
      state: product.state,
      primaryCategory: primary ? { id: primary.id, name: primary.name } : null,
      primaryUnit: unit ? { id: unit.id, code: unit.code, name: unit.name, symbol: unit.symbol } : null,
      variantCount: product.type === 'PRODUCT_WITH_VARIANTS' ? this.variantsOf(product.id).filter((variant) => variant.state !== 'ARCHIVED').length : null,
      variantLabel: product.type === 'VARIANT' ? this.axisLabel(product) : null,
      basePrice: base ? { amount: base.amount, currency: base.currency } : null,
      tax: { taxable: values.taxable, rate: values.taxRate, included: values.taxIncluded, code: values.taxCode },
      version: product.version,
      updatedAt: product.updatedAt,
    };
  }

  detail(actor: ActorContext, product: Product) {
    const { parent, values } = this.effective(product);
    const category = this.categoriesOf(product);
    const custom = this.customFieldValues(actor, product);
    const priceList = this.prices.list(product, parent, product.workspaceId);
    const ratios = this.ratiosOf(product);
    const media = this.mediaOf(product);
    const units = new Map(this.state.catalogUnits.filter((unit) => unit.workspaceId === product.workspaceId).map((unit) => [unit.id, unit]));
    const axes = product.type === 'PRODUCT_WITH_VARIANTS'
      ? product.variantAxes.map((fieldId) => {
          const field = this.state.crmCustomFields.find((item) => item.id === fieldId);
          return { fieldId, code: field?.code ?? null, label: field?.label ?? null };
        })
      : undefined;
    return {
      ...this.compact(product),
      description: values.description,
      shortDescription: values.shortDescription,
      barcode: product.barcode,
      inventoryTracking: (product.type === 'VARIANT' ? this.effective(product).parent?.inventoryTracking : product.inventoryTracking) ?? 'NONE',
      enforceBatchExpiry: (product.type === 'VARIANT' ? this.effective(product).parent?.enforceBatchExpiry : product.enforceBatchExpiry) ?? false,
      dimensions: { weight: values.weight, length: values.length, width: values.width, height: values.height },
      ownName: product.name,
      inherited: product.type === 'VARIANT' ? values.inherited : undefined,
      overrides: product.type === 'VARIANT' ? product.overrides : undefined,
      axes,
      axisValues: product.type === 'VARIANT'
        ? (product.axisValues ?? []).map((value) => ({ ...value, label: this.optionLabel(value.fieldId, value.optionId) }))
        : undefined,
      categoryIds: category.categoryIds,
      primaryCategoryId: category.primaryCategoryId,
      categoriesInherited: product.type === 'VARIANT',
      customFields: custom.values,
      inheritedCustomFields: custom.inherited,
      prices: priceList.prices,
      pricesInherited: priceList.inherited,
      basePriceTypeId: priceList.basePriceTypeId,
      unitRatios: ratios.rows.map((row) => this.ratioDto(row, units)),
      unitRatiosInherited: ratios.inherited,
      media: media.rows.sort((a, b) => a.sortOrder - b.sortOrder).map((row) => ({ id: row.id, fileId: row.fileId, altText: row.altText, sortOrder: row.sortOrder })),
      mediaInherited: media.inherited,
      archivedAt: product.archivedAt,
      archiveCause: product.archiveCause,
      createdAt: product.createdAt,
    };
  }

  private ratioDto(row: ProductUnitRatio, units: Map<string, CatalogUnit>) {
    const unit = units.get(row.unitId);
    const base = units.get(row.baseUnitId);
    return {
      id: row.id,
      unitId: row.unitId,
      unitCode: unit?.code ?? null,
      baseUnitId: row.baseUnitId,
      baseUnitCode: base?.code ?? null,
      ratio: row.ratio,
      // The API states the direction explicitly so it is never inferred: 1 <unit> = <ratio> <base unit>.
      description: `1 ${unit?.name ?? 'unit'} = ${row.ratio} ${base?.name ?? 'base unit'}`,
    };
  }

  // ---- list / search ---------------------------------------------------------------------------------------------------

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.catalogManage);
    this.support.settings(workspaceId);
    const q = (key: string) => searchParams.get(key) ?? undefined;
    const csv = (key: string) => q(key)?.split(',').map((item) => item.trim()).filter(Boolean);
    const picker = q('purpose') === 'picker';

    const types = csv('type');
    for (const type of types ?? []) if (!['SIMPLE_PRODUCT', 'PRODUCT_WITH_VARIANTS', 'VARIANT', 'SERVICE'].includes(type)) throw badRequest('CATALOG_QUERY_INVALID', `Unknown type ${type}.`);
    let states = csv('state');
    for (const state of states ?? []) if (!['ACTIVE', 'INACTIVE', 'ARCHIVED'].includes(state)) throw badRequest('CATALOG_QUERY_INVALID', `Unknown state ${state}.`);
    if (picker) states = ['ACTIVE'];
    else if (!states) states = q('includeArchived') === 'true' ? ['ACTIVE', 'INACTIVE', 'ARCHIVED'] : ['ACTIVE', 'INACTIVE'];
    const sellableOnly = picker || q('sellable') === 'true';
    const parentId = q('parentId');
    const includeVariants = q('includeVariants') === 'true' || Boolean(types?.includes('VARIANT')) || Boolean(parentId) || sellableOnly;
    const sortBy = q('sortBy') ?? 'name';
    if (!(SORTABLE as readonly string[]).includes(sortBy)) throw badRequest('CATALOG_QUERY_INVALID', 'sortBy is not allowed for this endpoint.');
    const sortOrder = q('sortOrder') === 'desc' ? -1 : 1;
    const page = Math.max(Number(q('page') ?? '1') || 1, 1);
    const limit = Math.min(Math.max(Number(q('limit') ?? '20') || 20, 1), 100);
    const search = q('search')?.trim().toLowerCase();
    const skuFilter = q('sku')?.trim().toLowerCase();
    const catalogId = q('catalogId');
    if (catalogId) this.support.catalog(workspaceId, catalogId);
    const categoryId = q('categoryId');
    let categoryScope: Set<string> | null = null;
    if (categoryId) {
      const category = this.state.catalogCategories.find((item) => item.id === categoryId && item.workspaceId === workspaceId);
      if (!category) throw new AppError('CATEGORY_NOT_FOUND', 'Category was not found.', 404);
      categoryScope = new Set([categoryId]);
      if (q('includeSubcategories') !== 'false') for (const id of this.categories.descendantIds(categoryId)) categoryScope.add(id);
    }
    const dateFilter = (key: string) => {
      const raw = q(key);
      if (raw === undefined) return undefined;
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) throw badRequest('CATALOG_QUERY_INVALID', `${key} must be an ISO timestamp.`);
      return ms;
    };
    const createdFrom = dateFilter('createdFrom');
    const createdTo = dateFilter('createdTo');
    const updatedFrom = dateFilter('updatedFrom');
    const updatedTo = dateFilter('updatedTo');

    // Price filters use the effective price of one Price Type (default: base) in one currency.
    const minPrice = q('minPrice');
    const maxPrice = q('maxPrice');
    const priceTypeId = q('priceTypeId') ?? this.support.settings(workspaceId).basePriceTypeId ?? undefined;
    if (q('priceTypeId')) this.support.priceType(workspaceId, q('priceTypeId'));
    const priceCurrency = q('currency')?.toUpperCase();
    for (const [key, value] of [['minPrice', minPrice], ['maxPrice', maxPrice]] as const) {
      if (value !== undefined && toScaled(value) === null) throw badRequest('CATALOG_QUERY_INVALID', `${key} must be a decimal.`);
    }

    // Filterable Product properties: prop.<code>=<value>, only for properties flagged filterable in their Catalog profile.
    const propertyMatchers: Array<Set<string>> = [];
    for (const [key, raw] of searchParams.entries()) {
      if (!key.startsWith('prop.')) continue;
      const code = key.slice(5);
      const field = this.properties.productFields(workspaceId).find((item) => item.code === code);
      if (!field || !this.properties.profileFor(workspaceId, field.id).filterable) throw badRequest('CATALOG_QUERY_FIELD_NOT_ALLOWED', `Property ${code} is not filterable.`);
      propertyMatchers.push(this.matchingByProperty(workspaceId, field.id, field.fieldType, raw));
    }

    const names = new Map<string, string>();
    const nameOf = (product: Product) => {
      let name = names.get(product.id);
      if (name === undefined) {
        name = this.effective(product).values.name;
        names.set(product.id, name);
      }
      return name;
    };

    let rows = this.state.catalogProducts.filter((product) => {
      if (product.workspaceId !== workspaceId) return false;
      if (!includeVariants && product.type === 'VARIANT') return false;
      if (sellableOnly && !isSellable(product)) return false;
      if (types && !types.includes(product.type)) return false;
      if (!states!.includes(product.state)) return false;
      if (catalogId && product.catalogId !== catalogId) return false;
      if (parentId && product.parentId !== parentId) return false;
      if (skuFilter && product.skuKey !== skuFilter) return false;
      if (createdFrom !== undefined && product.createdAt.getTime() < createdFrom) return false;
      if (createdTo !== undefined && product.createdAt.getTime() > createdTo) return false;
      if (updatedFrom !== undefined && product.updatedAt.getTime() < updatedFrom) return false;
      if (updatedTo !== undefined && product.updatedAt.getTime() > updatedTo) return false;
      if (categoryScope) {
        const owner = this.categoriesOf(product);
        if (!owner.categoryIds.some((id) => categoryScope!.has(id))) return false;
      }
      // Variants inherit the parent's value for properties they do not override.
      for (const matcher of propertyMatchers) {
        if (!matcher.has(product.id) && !(product.type === 'VARIANT' && product.parentId && matcher.has(product.parentId))) return false;
      }
      if (picker) {
        const parent = this.parentOf(product);
        if (parent && parent.state !== 'ACTIVE') return false;
        if (!this.state.catalogs.find((catalog) => catalog.id === product.catalogId)?.isActive) return false;
      }
      return true;
    });

    if (search) {
      rows = rows.filter((product) => {
        const haystack = [nameOf(product), product.sku ?? '', product.barcode ?? '', this.parentOf(product)?.name ?? ''].join(' ').toLowerCase();
        return haystack.includes(search);
      });
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      const lower = minPrice !== undefined ? toScaled(minPrice)! : null;
      const upper = maxPrice !== undefined ? toScaled(maxPrice)! : null;
      rows = rows.filter((product) => {
        if (!priceTypeId) return false;
        const parent = this.parentOf(product);
        return this.prices
          .effectiveRows(product, parent)
          .rows.filter((row) => row.priceTypeId === priceTypeId && (!priceCurrency || row.currency === priceCurrency))
          .some((row) => {
            const amount = toScaled(row.amount)!;
            return (lower === null || amount >= lower) && (upper === null || amount <= upper);
          });
      });
    }

    const sortValue = (product: Product): string | number => {
      switch (sortBy) {
        case 'name':
          return nameOf(product).toLowerCase();
        case 'sku':
          return (product.sku ?? '').toLowerCase();
        case 'createdAt':
          return product.createdAt.getTime();
        case 'updatedAt':
          return product.updatedAt.getTime();
        case 'type':
          return product.type;
        default:
          return product.state;
      }
    };
    rows.sort((a, b) => {
      const left = sortValue(a);
      const right = sortValue(b);
      const primary = left < right ? -1 : left > right ? 1 : 0;
      return (primary || a.id.localeCompare(b.id)) * sortOrder;
    });

    const total = rows.length;
    const start = (page - 1) * limit;
    const data = rows.slice(start, start + limit).map((product) => this.compact(product));
    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Product ids whose stored value for the property equals `raw` (LIST: option id or code; TEXT: case-insensitive equality). */
  private matchingByProperty(workspaceId: string, fieldId: string, fieldType: string, raw: string): Set<string> {
    const matches = new Set<string>();
    const options = this.state.crmCustomFieldOptions.filter((option) => option.fieldId === fieldId);
    const optionId = options.find((option) => option.id === raw || option.code.toLowerCase() === raw.toLowerCase())?.id;
    for (const row of this.state.crmCustomFieldValues) {
      if (row.workspaceId !== workspaceId || row.fieldId !== fieldId || row.entityType !== PRODUCT_ENTITY_TYPE) continue;
      if (fieldType === 'LIST' || fieldType === 'MULTI_LIST') {
        if (optionId && row.valueUuid === optionId) matches.add(row.entityId);
      } else if (fieldType === 'BOOLEAN') {
        if (String(row.valueBoolean) === raw.toLowerCase()) matches.add(row.entityId);
      } else if (fieldType === 'INTEGER' || fieldType === 'DECIMAL') {
        const wanted = canonicalDecimal(raw);
        const stored = row.valueInteger !== null && row.valueInteger !== undefined ? String(row.valueInteger) : row.valueDecimal;
        if (wanted !== null && stored !== null && stored !== undefined && canonicalDecimal(stored) === wanted) matches.add(row.entityId);
      } else if ((row.valueText ?? '').toLowerCase() === raw.toLowerCase()) {
        matches.add(row.entityId);
      }
    }
    return matches;
  }

  get(user: User, workspaceId: string, productId: string, expect: 'PRODUCT' | 'VARIANT') {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.catalogManage);
    this.support.settings(workspaceId);
    return this.detail(actor, this.product(workspaceId, productId, expect));
  }

  // ---- create ---------------------------------------------------------------------------------------------------------

  create(user: User, workspaceId: string, input: Json, headerKey?: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productCreate);
    assertOnlyKeys(input, PRODUCT_CREATE_KEYS, 'product');
    const key = this.support.validateKey(input.idempotencyKey ?? headerKey);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const replay = this.support.recall(actor, 'catalog.product.create', key, input);
      if (replay) return this.detail(actor, this.product(workspaceId, replay.productId));

      const type = input.type as ProductType;
      if (!CREATE_TYPES.includes(type)) {
        throw badRequest('PRODUCT_TYPE_INVALID', 'type must be SIMPLE_PRODUCT, PRODUCT_WITH_VARIANTS or SERVICE. Variants are created under their parent.', { field: 'type' });
      }
      const catalogId = typeof input.catalogId === 'string' ? input.catalogId : this.support.settings(workspaceId).defaultCatalogId;
      const catalog = this.support.catalog(workspaceId, catalogId);
      if (!catalog.isActive) throw conflict('CATALOG_INACTIVE', 'Products cannot be added to an inactive Catalog.');

      const sku = this.readSku(type, input.sku);
      this.assertSkuFree(workspaceId, sku?.skuKey ?? null);
      const now = new Date();
      const product: Product = {
        id: this.support.store.id(),
        workspaceId,
        catalogId: catalog.id,
        type,
        parentId: null,
        name: requiredText(input.name, 'name', 300),
        sku: sku?.sku ?? null,
        skuKey: sku?.skuKey ?? null,
        description: optionalText(input.description, 'description', 20000),
        shortDescription: optionalText(input.shortDescription, 'shortDescription', 1000),
        state: this.readCreateState(input.state),
        archiveCause: null,
        archivedAt: null,
        archivedByUserId: null,
        primaryCategoryId: null,
        primaryUnitId: this.readUnit(workspaceId, input.primaryUnitId, type),
        taxable: false,
        taxRate: null,
        taxIncluded: false,
        taxCode: null,
        weight: null,
        length: null,
        width: null,
        height: null,
        barcode: optionalText(input.barcode, 'barcode', 100),
        inventoryTracking: 'NONE',
        enforceBatchExpiry: false,
        variantAxes: [],
        axisKey: null,
        axisValues: null,
        overrides: [],
        version: 1,
        createdByUserId: actor.user.id,
        updatedByUserId: actor.user.id,
        createdAt: now,
        updatedAt: now,
      };
      this.applyTaxAndDimensions(product, input);
      this.applyInventoryTracking(product, input);
      if (type === 'PRODUCT_WITH_VARIANTS') product.variantAxes = this.readAxes(workspaceId, input.variantAxes);
      else if (input.variantAxes !== undefined && !(Array.isArray(input.variantAxes) && input.variantAxes.length === 0)) {
        throw badRequest('PRODUCT_TYPE_INVALID', 'Only a product with variants can define variant axes.', { field: 'variantAxes' });
      }

      const categoryPlan = this.readCategories(workspaceId, catalog.id, input.categoryIds, input.primaryCategoryId);
      const prepared = this.fields.validateWrite({
        actor,
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: null,
        isCreate: true,
        supplied: input.customFields,
        systemState: this.fields.support.deps.registry.get(PRODUCT_ENTITY_TYPE).systemValues(product),
      });
      this.assertPropertiesApplicable(workspaceId, product, prepared.changes, categoryPlan.categoryIds);
      const priceRows = input.prices === undefined ? [] : this.prices.parse(workspaceId, input.prices);

      this.state.catalogProducts.push(product);
      this.writeCategories(workspaceId, product, categoryPlan);
      this.fields.commit(prepared, product.id);
      this.prices.replace(actor, product, priceRows);

      this.support.audit(actor, 'PRODUCT.CREATED', 'CatalogProduct', product.id, null, this.auditShape(product));
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_CREATED', 'PRODUCT', product.id, { productType: product.type, catalogId: catalog.id, version: product.version });
      if (priceRows.length > 0) this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PRICE_CHANGED', 'PRODUCT', product.id, { changes: priceRows.length });
      this.support.remember(actor, 'catalog.product.create', key, input, { productId: product.id });
      return this.detail(actor, product);
    });
  }

  // ---- update ---------------------------------------------------------------------------------------------------------

  update(user: User, workspaceId: string, productId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productUpdate);
    assertOnlyKeys(input, PRODUCT_UPDATE_KEYS, 'product');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const product = this.product(workspaceId, productId, 'PRODUCT');
      this.support.assertVersion(product.version, input.version, 'product');
      if (input.type !== undefined && input.type !== product.type) {
        throw badRequest('PRODUCT_TYPE_INVALID', 'The type of an existing item cannot be changed.', { field: 'type', currentType: product.type });
      }
      this.assertEditable(product);
      const before = this.auditShape(product);
      const skuBefore = product.sku;

      if (input.name !== undefined) product.name = requiredText(input.name, 'name', 300);
      if (input.description !== undefined) product.description = optionalText(input.description, 'description', 20000);
      if (input.shortDescription !== undefined) product.shortDescription = optionalText(input.shortDescription, 'shortDescription', 1000);
      if (input.barcode !== undefined) product.barcode = optionalText(input.barcode, 'barcode', 100);
      if (input.primaryUnitId !== undefined) {
        const unitId = this.readUnit(workspaceId, input.primaryUnitId, product.type);
        if (unitId !== product.primaryUnitId && this.state.catalogUnitRatios.some((row) => row.productId === product.id)) {
          throw conflict('UNIT_RATIO_INVALID', 'Remove the unit ratios before changing the primary unit; ratios are defined against it.');
        }
        product.primaryUnitId = unitId;
      }
      if (input.sku !== undefined) {
        const sku = this.readSku(product.type, input.sku);
        this.assertSkuFree(workspaceId, sku?.skuKey ?? null, product.id);
        product.sku = sku?.sku ?? null;
        product.skuKey = sku?.skuKey ?? null;
      }
      if (input.state !== undefined) {
        if (input.state !== 'ACTIVE' && input.state !== 'INACTIVE') throw badRequest('VALIDATION_ERROR', 'state can only be set to ACTIVE or INACTIVE here; use archive/reactivate for the rest.', { field: 'state' });
        product.state = input.state as ProductState;
      }
      this.applyTaxAndDimensions(product, input);
      this.applyInventoryTracking(product, input);
      if (input.variantAxes !== undefined) {
        if (product.type !== 'PRODUCT_WITH_VARIANTS') throw badRequest('PRODUCT_TYPE_INVALID', 'Only a product with variants can define variant axes.', { field: 'variantAxes' });
        const axes = this.readAxes(workspaceId, input.variantAxes);
        if (JSON.stringify(axes) !== JSON.stringify(product.variantAxes)) {
          const activeVariants = this.variantsOf(product.id).filter((variant) => variant.state !== 'ARCHIVED');
          if (activeVariants.length > 0) {
            throw conflict('VARIANT_COMBINATION_CONFLICT', 'The variant axes cannot change while active Variants exist. Archive them first; Variant identity is never rewritten silently.', { activeVariantCount: activeVariants.length });
          }
          product.variantAxes = axes;
        }
      }

      let categoryPlan: ReturnType<ProductService['readCategories']> | null = null;
      if (input.categoryIds !== undefined || input.primaryCategoryId !== undefined) {
        const current = this.categoriesOf(product);
        const nextIds = (input.categoryIds ?? current.categoryIds) as string[];
        let nextPrimary = input.primaryCategoryId;
        // Changing only the memberships keeps the current primary when it is still a member.
        if (nextPrimary === undefined && current.primaryCategoryId && Array.isArray(nextIds) && nextIds.includes(current.primaryCategoryId)) nextPrimary = current.primaryCategoryId;
        categoryPlan = this.readCategories(workspaceId, product.catalogId, nextIds, nextPrimary);
      }

      const merged = this.categoriesOf(product).categoryIds;
      const prepared = this.fields.validateWrite({
        actor,
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: product.id,
        isCreate: false,
        supplied: input.customFields,
        systemState: this.fields.support.deps.registry.get(PRODUCT_ENTITY_TYPE).systemValues(product),
      });
      this.assertPropertiesApplicable(workspaceId, product, prepared.changes, categoryPlan?.categoryIds ?? merged);
      if (categoryPlan) this.writeCategories(workspaceId, product, categoryPlan);
      this.fields.commit(prepared, product.id);
      product.version += 1;
      product.updatedAt = new Date();
      product.updatedByUserId = actor.user.id;

      this.support.audit(actor, 'PRODUCT.UPDATED', 'CatalogProduct', product.id, before, this.auditShape(product));
      if (skuBefore !== product.sku) this.support.audit(actor, 'PRODUCT.SKU_CHANGED', 'CatalogProduct', product.id, { sku: skuBefore }, { sku: product.sku });
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_UPDATED', 'PRODUCT', product.id, { productType: product.type, version: product.version });
      return this.detail(actor, product);
    });
  }

  // ---- Variants -------------------------------------------------------------------------------------------------------

  listVariants(user: User, workspaceId: string, parentId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.catalogManage);
    this.support.settings(workspaceId);
    const parent = this.product(workspaceId, parentId, 'PRODUCT');
    if (parent.type !== 'PRODUCT_WITH_VARIANTS') throw new AppError('VARIANT_PARENT_INVALID', 'Only a product with variants has Variants.', 400);
    const includeArchived = searchParams.get('includeArchived') === 'true';
    const rows = this.variantsOf(parent.id)
      .filter((variant) => includeArchived || variant.state !== 'ARCHIVED')
      .map((variant) => this.compact(variant))
      .sort((a, b) => (a.variantLabel ?? '').localeCompare(b.variantLabel ?? '') || a.id.localeCompare(b.id));
    return { data: rows, meta: null };
  }

  createVariant(user: User, workspaceId: string, parentId: string, input: Json, headerKey?: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productCreate);
    assertOnlyKeys(input, VARIANT_CREATE_KEYS, 'variant');
    const key = this.support.validateKey(input.idempotencyKey ?? headerKey);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const replay = this.support.recall(actor, `catalog.variant.create:${parentId}`, key, input);
      if (replay) return this.detail(actor, this.product(workspaceId, replay.productId));
      const variant = this.buildVariant(actor, workspaceId, parentId, input);
      this.support.remember(actor, `catalog.variant.create:${parentId}`, key, input, { productId: variant.id });
      return this.detail(actor, variant);
    });
  }

  /** Creates one Variant row (validation + custom values + prices + events). Shared by manual creation and matrix generation. */
  buildVariant(actor: ActorContext, workspaceId: string, parentId: string, input: Json): Product {
    const parent = this.product(workspaceId, parentId, 'PRODUCT');
    if (parent.type !== 'PRODUCT_WITH_VARIANTS') throw new AppError('VARIANT_PARENT_INVALID', 'A Variant needs a parent product with variants.', 400);
    if (parent.state !== 'ACTIVE') throw conflict('PRODUCT_PARENT_ARCHIVED', 'Variants can only be added to an active parent product.');
    const axisValues = this.readAxisValues(workspaceId, parent, input.axisValues);
    const axisKey = axisKeyOf(axisValues);
    const duplicate = this.variantsOf(parent.id).find((variant) => variant.axisKey === axisKey);
    if (duplicate) throw conflict('VARIANT_COMBINATION_CONFLICT', 'A Variant with this option combination already exists for the parent.', { variantId: duplicate.id });
    const sku = normalizeSku(input.sku);
    this.assertSkuFree(workspaceId, sku.skuKey);

    const now = new Date();
    const variant: Product = {
      id: this.support.store.id(),
      workspaceId,
      catalogId: parent.catalogId,
      type: 'VARIANT',
      parentId: parent.id,
      name: parent.name,
      sku: sku.sku,
      skuKey: sku.skuKey,
      description: null,
      shortDescription: null,
      state: this.readCreateState(input.state),
      archiveCause: null,
      archivedAt: null,
      archivedByUserId: null,
      primaryCategoryId: null,
      primaryUnitId: null,
      taxable: false,
      taxRate: null,
      taxIncluded: false,
      taxCode: null,
      weight: null,
      length: null,
      width: null,
      height: null,
      barcode: optionalText(input.barcode, 'barcode', 100),
      variantAxes: [],
      axisKey,
      axisValues,
      overrides: [],
      version: 1,
      createdByUserId: actor.user.id,
      updatedByUserId: actor.user.id,
      createdAt: now,
      updatedAt: now,
    };
    variant.name = `${parent.name} — ${axisValues.map((value) => this.optionLabel(value.fieldId, value.optionId)).join(' / ')}`;
    this.applyOverrides(workspaceId, variant, input);

    const supplied = { ...(isPlainObject(input.customFields) ? input.customFields : {}) };
    for (const value of axisValues) {
      const field = this.state.crmCustomFields.find((item) => item.id === value.fieldId)!;
      if (field.code in supplied) throw fieldValidationFailed({ [field.code]: [{ code: 'VARIANT_AXIS_READ_ONLY', message: 'Axis values are set through axisValues.' }] });
      supplied[field.code] = value.optionId;
    }
    const prepared = this.fields.validateWrite({
      actor,
      entityType: PRODUCT_ENTITY_TYPE,
      entityId: null,
      isCreate: true,
      supplied,
      systemState: this.fields.support.deps.registry.get(PRODUCT_ENTITY_TYPE).systemValues(variant),
    });
    this.assertPropertiesApplicable(workspaceId, variant, prepared.changes, this.categoriesOf(parent).categoryIds);
    const priceRows = input.prices === undefined ? [] : this.prices.parse(workspaceId, input.prices);
    if (priceRows.length > 0) variant.overrides = [...variant.overrides, 'prices'];

    this.state.catalogProducts.push(variant);
    this.fields.commit(prepared, variant.id);
    this.prices.replace(actor, variant, priceRows);
    this.support.audit(actor, 'VARIANT.CREATED', 'CatalogProduct', variant.id, null, this.auditShape(variant));
    this.support.emit(workspaceId, actor.user.id, 'VARIANT_CREATED', 'VARIANT', variant.id, { parentId: parent.id, version: variant.version });
    if (priceRows.length > 0) this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PRICE_CHANGED', 'VARIANT', variant.id, { changes: priceRows.length });
    return variant;
  }

  updateVariant(user: User, workspaceId: string, variantId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productUpdate);
    assertOnlyKeys(input, VARIANT_UPDATE_KEYS, 'variant');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const variant = this.product(workspaceId, variantId, 'VARIANT');
      this.support.assertVersion(variant.version, input.version, 'variant');
      this.assertEditable(variant);
      const parent = this.parentOf(variant);
      if (!parent) throw new AppError('VARIANT_PARENT_INVALID', 'The Variant has no valid parent.', 409);
      const before = this.auditShape(variant);
      const skuBefore = variant.sku;

      if (input.sku !== undefined) {
        const sku = normalizeSku(input.sku);
        this.assertSkuFree(workspaceId, sku.skuKey, variant.id);
        variant.sku = sku.sku;
        variant.skuKey = sku.skuKey;
      }
      if (input.barcode !== undefined) variant.barcode = optionalText(input.barcode, 'barcode', 100);
      if (input.state !== undefined) {
        if (input.state !== 'ACTIVE' && input.state !== 'INACTIVE') throw badRequest('VALIDATION_ERROR', 'state can only be set to ACTIVE or INACTIVE here; use archive/reactivate for the rest.', { field: 'state' });
        variant.state = input.state as ProductState;
      }
      if (input.axisValues !== undefined) {
        const axisValues = this.readAxisValues(workspaceId, parent, input.axisValues, variant);
        const axisKey = axisKeyOf(axisValues);
        const duplicate = this.variantsOf(parent.id).find((item) => item.axisKey === axisKey && item.id !== variant.id);
        if (duplicate) throw conflict('VARIANT_COMBINATION_CONFLICT', 'Another Variant already uses this option combination.', { variantId: duplicate.id });
        variant.axisValues = axisValues;
        variant.axisKey = axisKey;
        variant.name = `${parent.name} — ${this.axisLabel(variant)}`;
      }
      this.applyOverrides(workspaceId, variant, input);
      if (input.inherit !== undefined) this.resetOverrides(variant, input.inherit);

      const supplied: Record<string, unknown> = { ...(isPlainObject(input.customFields) ? input.customFields : {}) };
      for (const value of variant.axisValues ?? []) {
        const field = this.state.crmCustomFields.find((item) => item.id === value.fieldId)!;
        if (field.code in supplied) throw fieldValidationFailed({ [field.code]: [{ code: 'VARIANT_AXIS_READ_ONLY', message: 'Axis values are set through axisValues.' }] });
        if (input.axisValues !== undefined) supplied[field.code] = value.optionId;
      }
      const prepared = this.fields.validateWrite({
        actor,
        entityType: PRODUCT_ENTITY_TYPE,
        entityId: variant.id,
        isCreate: false,
        supplied,
        systemState: this.fields.support.deps.registry.get(PRODUCT_ENTITY_TYPE).systemValues(variant),
      });
      this.assertPropertiesApplicable(workspaceId, variant, prepared.changes, this.categoriesOf(parent).categoryIds);
      this.fields.commit(prepared, variant.id);
      variant.version += 1;
      variant.updatedAt = new Date();
      variant.updatedByUserId = actor.user.id;
      this.support.audit(actor, 'VARIANT.UPDATED', 'CatalogProduct', variant.id, before, this.auditShape(variant));
      if (skuBefore !== variant.sku) this.support.audit(actor, 'PRODUCT.SKU_CHANGED', 'CatalogProduct', variant.id, { sku: skuBefore }, { sku: variant.sku });
      this.support.emit(workspaceId, actor.user.id, 'VARIANT_UPDATED', 'VARIANT', variant.id, { parentId: parent.id, version: variant.version });
      return this.detail(actor, variant);
    });
  }

  /** Attributes the Variant explicitly overrides; anything not supplied keeps resolving from the parent. */
  private applyOverrides(workspaceId: string, variant: Product, input: Json) {
    const set = new Set<InheritableAttribute>(variant.overrides);
    if (input.name !== undefined) {
      variant.name = requiredText(input.name, 'name', 300);
      set.add('name');
    }
    if (input.description !== undefined) {
      variant.description = optionalText(input.description, 'description', 20000);
      set.add('description');
    }
    if (input.shortDescription !== undefined) {
      variant.shortDescription = optionalText(input.shortDescription, 'shortDescription', 1000);
      set.add('shortDescription');
    }
    if (input.primaryUnitId !== undefined) {
      variant.primaryUnitId = this.readUnit(workspaceId, input.primaryUnitId, 'VARIANT');
      set.add('primaryUnitId');
    }
    if (['taxable', 'taxRate', 'taxIncluded', 'taxCode'].some((key) => input[key] !== undefined)) {
      if (!set.has('tax')) {
        // Start the override from the parent's current values so unspecified tax attributes are not silently reset.
        const parent = this.parentOf(variant);
        if (parent) {
          variant.taxable = parent.taxable;
          variant.taxRate = parent.taxRate;
          variant.taxIncluded = parent.taxIncluded;
          variant.taxCode = parent.taxCode;
        }
      }
      this.applyTaxAndDimensions(variant, input);
      set.add('tax');
    }
    if (['weight', 'length', 'width', 'height'].some((key) => input[key] !== undefined)) {
      if (!set.has('dimensions')) {
        const parent = this.parentOf(variant);
        if (parent) {
          variant.weight = parent.weight;
          variant.length = parent.length;
          variant.width = parent.width;
          variant.height = parent.height;
        }
      }
      this.applyTaxAndDimensions(variant, input);
      set.add('dimensions');
    }
    variant.overrides = INHERITABLE_ATTRIBUTES.filter((attribute) => set.has(attribute));
  }

  private resetOverrides(variant: Product, requested: unknown) {
    if (!Array.isArray(requested) || requested.some((item) => !(INHERITABLE_ATTRIBUTES as readonly string[]).includes(item as string))) {
      throw badRequest('VALIDATION_ERROR', `inherit must list attributes from: ${INHERITABLE_ATTRIBUTES.join(', ')}.`, { field: 'inherit' });
    }
    const reset = new Set(requested as InheritableAttribute[]);
    if (reset.has('prices')) {
      this.state.catalogPrices = this.state.catalogPrices.filter((row) => row.productId !== variant.id);
    }
    if (reset.has('media')) {
      this.state.catalogProductMedia = this.state.catalogProductMedia.filter((row) => row.productId !== variant.id);
    }
    if (reset.has('tax')) {
      variant.taxable = false;
      variant.taxRate = null;
      variant.taxIncluded = false;
      variant.taxCode = null;
    }
    if (reset.has('dimensions')) {
      variant.weight = null;
      variant.length = null;
      variant.width = null;
      variant.height = null;
    }
    if (reset.has('name')) {
      const parent = this.parentOf(variant);
      variant.name = `${parent?.name ?? variant.name} — ${this.axisLabel(variant)}`;
    }
    variant.overrides = variant.overrides.filter((attribute) => !reset.has(attribute));
  }

  // ---- lifecycle: archive / reactivate / delete ---------------------------------------------------------------------------

  archive(user: User, workspaceId: string, productId: string, expect: 'PRODUCT' | 'VARIANT', input: Json = {}) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productArchive);
    assertOnlyKeys(input, ['version', 'reason'], 'archive');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const product = this.product(workspaceId, productId, expect);
      if (input.version !== undefined) this.support.assertVersion(product.version, input.version, 'product');
      if (product.state === 'ARCHIVED') return this.detail(actor, product);
      const now = new Date();
      const family = product.type === 'PRODUCT_WITH_VARIANTS' ? this.variantsOf(product.id).filter((variant) => variant.state !== 'ARCHIVED') : [];
      // Archiving a parent retires its whole family atomically, so no active orphan Variant remains selectable.
      for (const variant of family) {
        variant.state = 'ARCHIVED';
        variant.archiveCause = 'PARENT';
        variant.archivedAt = now;
        variant.archivedByUserId = actor.user.id;
        variant.version += 1;
        variant.updatedAt = now;
        this.support.emit(workspaceId, actor.user.id, 'VARIANT_ARCHIVED', 'VARIANT', variant.id, { parentId: product.id, cause: 'PARENT' });
      }
      product.state = 'ARCHIVED';
      product.archiveCause = 'DIRECT';
      product.archivedAt = now;
      product.archivedByUserId = actor.user.id;
      product.version += 1;
      product.updatedAt = now;
      this.support.audit(actor, 'PRODUCT.ARCHIVED', 'CatalogProduct', product.id, { state: 'ACTIVE' }, { state: 'ARCHIVED', familyVariantCount: family.length }, { reason: optionalText(input.reason, 'reason', 500) });
      this.support.emit(workspaceId, actor.user.id, product.type === 'VARIANT' ? 'VARIANT_ARCHIVED' : 'PRODUCT_ARCHIVED', product.type === 'VARIANT' ? 'VARIANT' : 'PRODUCT', product.id, { familyVariantCount: family.length, version: product.version });
      return this.detail(actor, product);
    });
  }

  reactivate(user: User, workspaceId: string, productId: string, expect: 'PRODUCT' | 'VARIANT', input: Json = {}) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productArchive);
    assertOnlyKeys(input, ['version'], 'reactivate');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const product = this.product(workspaceId, productId, expect);
      if (input.version !== undefined) this.support.assertVersion(product.version, input.version, 'product');
      if (product.state === 'ACTIVE') return this.detail(actor, product);
      const parent = this.parentOf(product);
      if (product.type === 'VARIANT' && (!parent || parent.state !== 'ACTIVE')) {
        throw conflict('PRODUCT_PARENT_ARCHIVED', 'A Variant cannot be reactivated while its parent product is archived or inactive.', { parentId: product.parentId });
      }
      // Reactivation re-validates what archived items no longer guard: SKU identity, unit and Catalog references.
      const sameSku = product.skuKey ? this.state.catalogProducts.find((item) => item.workspaceId === workspaceId && item.skuKey === product.skuKey && item.id !== product.id) : undefined;
      if (sameSku) throw conflict('PRODUCT_SKU_CONFLICT', 'The SKU is now used by another item.', { sku: product.sku });
      const values = this.effective(product).values;
      if (values.primaryUnitId && !this.state.catalogUnits.some((unit) => unit.id === values.primaryUnitId && unit.workspaceId === workspaceId && unit.isActive)) {
        throw conflict('UNIT_INACTIVE', 'The primary unit of this item is no longer active.', { unitId: values.primaryUnitId });
      }
      if (!this.state.catalogs.find((catalog) => catalog.id === product.catalogId && catalog.isActive)) throw conflict('CATALOG_INACTIVE', 'The Catalog of this item is inactive.');
      const now = new Date();
      const restored: Product[] = [];
      if (product.type === 'PRODUCT_WITH_VARIANTS') {
        for (const variant of this.variantsOf(product.id)) {
          if (variant.state === 'ARCHIVED' && variant.archiveCause === 'PARENT') restored.push(variant);
        }
      }
      for (const variant of restored) {
        variant.state = 'ACTIVE';
        variant.archiveCause = null;
        variant.archivedAt = null;
        variant.archivedByUserId = null;
        variant.version += 1;
        variant.updatedAt = now;
        this.support.emit(workspaceId, actor.user.id, 'VARIANT_REACTIVATED', 'VARIANT', variant.id, { parentId: product.id });
      }
      product.state = 'ACTIVE';
      product.archiveCause = null;
      product.archivedAt = null;
      product.archivedByUserId = null;
      product.version += 1;
      product.updatedAt = now;
      this.support.audit(actor, 'PRODUCT.REACTIVATED', 'CatalogProduct', product.id, { state: 'ARCHIVED' }, { state: 'ACTIVE', restoredVariantCount: restored.length });
      this.support.emit(workspaceId, actor.user.id, product.type === 'VARIANT' ? 'VARIANT_REACTIVATED' : 'PRODUCT_REACTIVATED', product.type === 'VARIANT' ? 'VARIANT' : 'PRODUCT', product.id, { restoredVariantCount: restored.length, version: product.version });
      return this.detail(actor, product);
    });
  }

  /** Hard delete only for unused items; a parent takes its Variants with it, and only if none of them is used. */
  usageOf(workspaceId: string, product: Product) {
    const ids = [product.id, ...(product.type === 'PRODUCT_WITH_VARIANTS' ? this.variantsOf(product.id).map((variant) => variant.id) : [])];
    const usage = this.usageCheckers.map((checker) => checker(workspaceId, ids)).filter((entry) => entry.count > 0);
    return { ids, usage };
  }

  remove(user: User, workspaceId: string, productId: string, expect: 'PRODUCT' | 'VARIANT') {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productDelete);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const product = this.product(workspaceId, productId, expect);
      const { ids, usage } = this.usageOf(workspaceId, product);
      if (usage.length > 0) {
        throw conflict('PRODUCT_HAS_DEPENDENCIES', 'This item is used by other records and can only be archived.', {
          usage,
          remediation: 'Archive the item instead; archived items stay available to historical records.',
        });
      }
      const before = this.auditShape(product);
      const gone = new Set(ids);
      this.state.catalogProducts = this.state.catalogProducts.filter((row) => !gone.has(row.id));
      this.state.catalogProductCategories = this.state.catalogProductCategories.filter((row) => !gone.has(row.productId));
      this.state.catalogPrices = this.state.catalogPrices.filter((row) => !gone.has(row.productId));
      this.state.catalogUnitRatios = this.state.catalogUnitRatios.filter((row) => !gone.has(row.productId));
      this.state.catalogProductMedia = this.state.catalogProductMedia.filter((row) => !gone.has(row.productId));
      this.state.crmCustomFieldValues = this.state.crmCustomFieldValues.filter((row) => !(row.entityType === PRODUCT_ENTITY_TYPE && gone.has(row.entityId)));
      this.support.audit(actor, 'PRODUCT.DELETED', 'CatalogProduct', product.id, before, null, { removedIds: ids });
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_DELETED', product.type === 'VARIANT' ? 'VARIANT' : 'PRODUCT', product.id, { removedCount: ids.length });
      return { id: product.id, deleted: true, removedCount: ids.length };
    });
  }

  // ---- unit ratios -----------------------------------------------------------------------------------------------------

  listRatios(user: User, workspaceId: string, productId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.catalogManage);
    this.support.settings(workspaceId);
    const product = this.product(workspaceId, productId);
    const units = new Map(this.state.catalogUnits.filter((unit) => unit.workspaceId === workspaceId).map((unit) => [unit.id, unit]));
    const { rows, inherited } = this.ratiosOf(product);
    return { inherited, ratios: rows.map((row) => this.ratioDto(row, units)) };
  }

  createRatio(user: User, workspaceId: string, productId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productUpdate);
    assertOnlyKeys(input, ['unitId', 'ratio'], 'unit ratio');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const product = this.product(workspaceId, productId);
      this.assertEditable(product);
      const values = this.effective(product).values;
      if (!values.primaryUnitId) throw badRequest('UNIT_RATIO_INVALID', 'Set the primary unit before defining ratios.');
      const unit = this.support.unit(workspaceId, input.unitId);
      if (!unit.isActive) throw conflict('UNIT_INACTIVE', 'An inactive unit cannot be used for a new ratio.', { unitId: unit.id });
      if (unit.id === values.primaryUnitId) throw badRequest('UNIT_RATIO_INVALID', 'The ratio unit must differ from the primary unit.');
      const ratio = this.readRatio(input.ratio);
      if (this.state.catalogUnitRatios.some((row) => row.productId === product.id && row.unitId === unit.id)) throw conflict('UNIT_RATIO_CONFLICT', 'A ratio for this unit already exists.');
      const now = new Date();
      const row: ProductUnitRatio = { id: this.support.store.id(), workspaceId, productId: product.id, unitId: unit.id, baseUnitId: values.primaryUnitId, ratio, createdAt: now, updatedAt: now };
      this.state.catalogUnitRatios.push(row);
      this.touchProduct(product, actor);
      this.support.audit(actor, 'PRODUCT.UNIT_RATIO_SET', 'CatalogProduct', product.id, null, { unitId: unit.id, ratio });
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_UPDATED', 'PRODUCT', product.id, { change: 'UNIT_RATIO', version: product.version });
      return this.ratioDto(row, new Map(this.state.catalogUnits.map((item) => [item.id, item])));
    });
  }

  updateRatio(user: User, workspaceId: string, productId: string, ratioId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productUpdate);
    assertOnlyKeys(input, ['ratio'], 'unit ratio');
    return this.support.store.atomicSync(() => {
      const product = this.product(workspaceId, productId);
      this.assertEditable(product);
      const row = this.state.catalogUnitRatios.find((item) => item.id === ratioId && item.productId === product.id && item.workspaceId === workspaceId);
      if (!row) throw new AppError('UNIT_RATIO_NOT_FOUND', 'Unit ratio was not found.', 404);
      const before = row.ratio;
      row.ratio = this.readRatio(input.ratio);
      row.updatedAt = new Date();
      this.touchProduct(product, actor);
      this.support.audit(actor, 'PRODUCT.UNIT_RATIO_SET', 'CatalogProduct', product.id, { unitId: row.unitId, ratio: before }, { unitId: row.unitId, ratio: row.ratio });
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_UPDATED', 'PRODUCT', product.id, { change: 'UNIT_RATIO', version: product.version });
      return this.ratioDto(row, new Map(this.state.catalogUnits.map((item) => [item.id, item])));
    });
  }

  deleteRatio(user: User, workspaceId: string, productId: string, ratioId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productUpdate);
    return this.support.store.atomicSync(() => {
      const product = this.product(workspaceId, productId);
      this.assertEditable(product);
      const row = this.state.catalogUnitRatios.find((item) => item.id === ratioId && item.productId === product.id && item.workspaceId === workspaceId);
      if (!row) throw new AppError('UNIT_RATIO_NOT_FOUND', 'Unit ratio was not found.', 404);
      this.state.catalogUnitRatios = this.state.catalogUnitRatios.filter((item) => item.id !== row.id);
      this.touchProduct(product, actor);
      this.support.audit(actor, 'PRODUCT.UNIT_RATIO_REMOVED', 'CatalogProduct', product.id, { unitId: row.unitId, ratio: row.ratio }, null);
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_UPDATED', 'PRODUCT', product.id, { change: 'UNIT_RATIO', version: product.version });
      return { id: row.id, deleted: true };
    });
  }

  private readRatio(value: unknown): string {
    const scaled = typeof value === 'string' || typeof value === 'number' ? toScaled(value) : null;
    if (scaled === null || scaled <= 0n) throw badRequest('UNIT_RATIO_INVALID', 'ratio must be a positive decimal (1 alternate unit = ratio x base unit).', { field: 'ratio' });
    return canonicalDecimal(value)!;
  }

  // ---- prices ---------------------------------------------------------------------------------------------------------------

  getPrices(user: User, workspaceId: string, productId: string, expect: 'PRODUCT' | 'VARIANT') {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.catalogManage);
    this.support.settings(workspaceId);
    const product = this.product(workspaceId, productId, expect);
    return this.prices.list(product, this.parentOf(product), workspaceId);
  }

  putPrices(user: User, workspaceId: string, productId: string, expect: 'PRODUCT' | 'VARIANT', input: Json, headerKey?: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.priceManage);
    assertOnlyKeys(input, ['prices', 'inherit', 'idempotencyKey'], 'prices');
    const key = this.support.validateKey(input.idempotencyKey ?? headerKey);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const product = this.product(workspaceId, productId, expect);
      const operation = `catalog.prices.put:${product.id}`;
      const replay = this.support.recall(actor, operation, key, input);
      if (replay) return this.prices.list(product, this.parentOf(product), workspaceId);
      this.assertEditable(product);
      let changes: ReturnType<ProductPriceService['replace']>;
      if (input.inherit === true) {
        if (product.type !== 'VARIANT') throw badRequest('PRODUCT_PRICE_INVALID', 'Only a Variant can inherit its parent prices.', { field: 'inherit' });
        changes = this.prices.replace(actor, product, []);
        product.overrides = product.overrides.filter((attribute) => attribute !== 'prices');
      } else {
        const parsed = this.prices.parse(workspaceId, input.prices ?? []);
        changes = this.prices.replace(actor, product, parsed);
        if (product.type === 'VARIANT' && !product.overrides.includes('prices')) product.overrides = [...product.overrides, 'prices'];
      }
      if (changes.length > 0) {
        product.updatedAt = new Date();
        this.support.audit(actor, 'PRODUCT.PRICE_CHANGED', 'CatalogProduct', product.id, { prices: changes.map((c) => ({ priceTypeId: c.priceTypeId, currency: c.currency, amount: c.before })) }, { prices: changes.map((c) => ({ priceTypeId: c.priceTypeId, currency: c.currency, amount: c.after })) });
        this.support.emit(workspaceId, actor.user.id, 'PRODUCT_PRICE_CHANGED', product.type === 'VARIANT' ? 'VARIANT' : 'PRODUCT', product.id, { changes: changes.length });
      }
      this.support.remember(actor, operation, key, input, { productId: product.id });
      return this.prices.list(product, this.parentOf(product), workspaceId);
    });
  }

  // ---- media ----------------------------------------------------------------------------------------------------------------------

  getMedia(user: User, workspaceId: string, productId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.productRead, P.catalogRead, P.catalogManage);
    const product = this.product(workspaceId, productId);
    const { rows, inherited } = this.mediaOf(product);
    return { inherited, media: rows.sort((a, b) => a.sortOrder - b.sortOrder).map((row) => ({ id: row.id, fileId: row.fileId, altText: row.altText, sortOrder: row.sortOrder })) };
  }

  /** Replaces the media bindings. Files stay in Files; each id is checked through the FilePort for workspace and access. */
  putMedia(user: User, workspaceId: string, productId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.productUpdate);
    assertOnlyKeys(input, ['media', 'inherit'], 'media');
    return this.support.store.atomicSync(() => {
      const product = this.product(workspaceId, productId);
      this.assertEditable(product);
      if (input.inherit === true) {
        if (product.type !== 'VARIANT') throw badRequest('VALIDATION_ERROR', 'Only a Variant can inherit parent media.', { field: 'inherit' });
        this.state.catalogProductMedia = this.state.catalogProductMedia.filter((row) => row.productId !== product.id);
        product.overrides = product.overrides.filter((attribute) => attribute !== 'media');
      } else {
        if (!Array.isArray(input.media) || input.media.length > 50) throw badRequest('VALIDATION_ERROR', 'media must be an array (max 50).', { field: 'media' });
        const seen = new Set<string>();
        const rows: ProductMedia[] = [];
        (input.media as unknown[]).forEach((entry, index) => {
          if (!isPlainObject(entry) || typeof entry.fileId !== 'string') throw badRequest('VALIDATION_ERROR', `media[${index}].fileId is required.`, { field: `media[${index}]` });
          const check = this.support.filePort().check(workspaceId, actor, entry.fileId);
          if (check === 'UNAVAILABLE') throw new AppError('FILES_UNAVAILABLE', 'File references cannot be validated right now.', 503);
          if (check !== 'OK') throw new AppError('CATALOG_FILE_INVALID', 'A file was not found or is not accessible.', 400, { fileId: entry.fileId });
          const fileId = entry.fileId.toLowerCase();
          if (seen.has(fileId)) throw badRequest('VALIDATION_ERROR', 'A file can only be attached once.', { fileId });
          seen.add(fileId);
          rows.push({ id: this.support.store.id(), workspaceId, productId: product.id, fileId, altText: optionalText(entry.altText, 'altText', 300), sortOrder: optionalInt(entry.sortOrder, 'sortOrder', 0, 1000) ?? index, createdAt: new Date() });
        });
        this.state.catalogProductMedia = [...this.state.catalogProductMedia.filter((row) => row.productId !== product.id), ...rows];
        if (product.type === 'VARIANT' && !product.overrides.includes('media')) product.overrides = [...product.overrides, 'media'];
      }
      this.touchProduct(product, actor);
      this.support.audit(actor, 'PRODUCT.MEDIA_CHANGED', 'CatalogProduct', product.id, null, { count: this.mediaOf(product).rows.length });
      this.support.emit(workspaceId, actor.user.id, product.type === 'VARIANT' ? 'VARIANT_UPDATED' : 'PRODUCT_UPDATED', product.type === 'VARIANT' ? 'VARIANT' : 'PRODUCT', product.id, { change: 'MEDIA', version: product.version });
      const { rows, inherited } = this.mediaOf(product);
      return { inherited, media: rows.sort((a, b) => a.sortOrder - b.sortOrder).map((row) => ({ id: row.id, fileId: row.fileId, altText: row.altText, sortOrder: row.sortOrder })) };
    });
  }

  // ---- shared validation --------------------------------------------------------------------------------------------------------

  private touchProduct(product: Product, actor: ActorContext) {
    product.version += 1;
    product.updatedAt = new Date();
    product.updatedByUserId = actor.user.id;
  }

  private readCreateState(value: unknown): ProductState {
    if (value === undefined) return 'ACTIVE';
    if (value !== 'ACTIVE' && value !== 'INACTIVE') throw badRequest('VALIDATION_ERROR', 'state must be ACTIVE or INACTIVE when creating.', { field: 'state' });
    return value;
  }

  private readSku(type: ProductType, value: unknown) {
    if (type === 'PRODUCT_WITH_VARIANTS') {
      if (value !== undefined && value !== null) throw badRequest('PRODUCT_TYPE_INVALID', 'A product with variants is a container and has no SKU; its Variants carry the SKUs.', { field: 'sku' });
      return null;
    }
    if (type === 'SERVICE' && (value === undefined || value === null || value === '')) return null;
    return normalizeSku(value);
  }

  /** Workspace-wide SKU uniqueness across products, Variants and services, archived items included (an archived item keeps its SKU). */
  private assertSkuFree(workspaceId: string, skuKey: string | null, exceptId?: string) {
    if (!skuKey) return;
    const taken = this.state.catalogProducts.find((item) => item.workspaceId === workspaceId && item.skuKey === skuKey && item.id !== exceptId);
    if (taken) throw conflict('PRODUCT_SKU_CONFLICT', 'This SKU is already used by another item in the workspace.', { sku: taken.sku, productId: taken.id, state: taken.state });
  }

  private readUnit(workspaceId: string, value: unknown, type: string): string | null {
    if (value === undefined) return this.units.defaultUnitId(workspaceId, type);
    if (value === null) return null;
    const unit = this.support.unit(workspaceId, value);
    if (!unit.isActive) throw conflict('UNIT_INACTIVE', 'An inactive unit cannot be selected.', { unitId: unit.id });
    return unit.id;
  }

  /** Optional SKU serial/batch policy (Q29). Services are never stock-tracked; expiry enforcement applies to batches only. */
  private applyInventoryTracking(product: Product, input: Json) {
    if (input.inventoryTracking !== undefined) {
      if (!['NONE', 'SERIAL', 'BATCH'].includes(input.inventoryTracking as string)) throw badRequest('VALIDATION_ERROR', 'inventoryTracking must be NONE, SERIAL or BATCH.', { field: 'inventoryTracking' });
      if (product.type === 'SERVICE' && input.inventoryTracking !== 'NONE') throw badRequest('PRODUCT_TYPE_INVALID', 'A service is not stock-tracked.', { field: 'inventoryTracking' });
      product.inventoryTracking = input.inventoryTracking as 'NONE' | 'SERIAL' | 'BATCH';
    }
    if (input.enforceBatchExpiry !== undefined) product.enforceBatchExpiry = optionalBoolean(input.enforceBatchExpiry, 'enforceBatchExpiry')!;
    if (product.enforceBatchExpiry && product.inventoryTracking !== 'BATCH') throw badRequest('VALIDATION_ERROR', 'Expiry enforcement requires batch tracking.', { field: 'enforceBatchExpiry' });
  }

  private applyTaxAndDimensions(product: Product, input: Json) {
    if (input.taxable !== undefined) product.taxable = optionalBoolean(input.taxable, 'taxable')!;
    if (input.taxRate !== undefined) product.taxRate = decimalField(input.taxRate, 'taxRate', { min: '0', max: '100', maxScale: 4 });
    if (input.taxIncluded !== undefined) product.taxIncluded = optionalBoolean(input.taxIncluded, 'taxIncluded')!;
    if (input.taxCode !== undefined) product.taxCode = optionalText(input.taxCode, 'taxCode', 50);
    if (product.taxable && product.taxRate === null && (input.taxable !== undefined || input.taxRate !== undefined)) {
      throw badRequest('VALIDATION_ERROR', 'A taxable item needs a taxRate (use 0 for zero-rated).', { field: 'taxRate' });
    }
    for (const key of ['weight', 'length', 'width', 'height'] as const) {
      if (input[key] !== undefined) product[key] = decimalField(input[key], key, { min: '0' });
    }
  }

  private readAxes(workspaceId: string, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw badRequest('VALIDATION_ERROR', 'variantAxes must be an array of property ids.', { field: 'variantAxes' });
    const ids = [...new Set(value as string[])];
    if (ids.length > MAX_VARIANT_AXES) throw badRequest('VALIDATION_ERROR', `At most ${MAX_VARIANT_AXES} variant axes are allowed.`, { field: 'variantAxes' });
    for (const id of ids) {
      if (!this.properties.axisField(workspaceId, id)) throw badRequest('PRODUCT_TYPE_INVALID', 'Every axis must be an active LIST property flagged as a variant axis.', { field: 'variantAxes', propertyId: id });
    }
    return ids;
  }

  private readAxisValues(workspaceId: string, parent: Product, value: unknown, existing?: Product): AxisValue[] {
    if (!Array.isArray(value) || value.length === 0) throw badRequest('VALIDATION_ERROR', 'axisValues must list one option per variant axis.', { field: 'axisValues' });
    if (parent.variantAxes.length === 0) throw badRequest('VARIANT_PARENT_INVALID', 'The parent product defines no variant axes yet.', { field: 'axisValues' });
    const byField = new Map<string, string>();
    for (const entry of value) {
      if (!isPlainObject(entry) || typeof entry.fieldId !== 'string' || typeof entry.optionId !== 'string') throw badRequest('VALIDATION_ERROR', 'Each axis value needs fieldId and optionId.', { field: 'axisValues' });
      if (!parent.variantAxes.includes(entry.fieldId)) throw badRequest('VARIANT_PARENT_INVALID', 'The property is not a variant axis of the parent.', { fieldId: entry.fieldId });
      if (byField.has(entry.fieldId)) throw badRequest('VALIDATION_ERROR', 'Each axis may only appear once.', { fieldId: entry.fieldId });
      const option = this.state.crmCustomFieldOptions.find((item) => item.id === entry.optionId && item.fieldId === entry.fieldId && item.workspaceId === workspaceId);
      if (!option) throw new AppError('FIELD_OPTION_NOT_FOUND', 'The selected option does not exist.', 404, { fieldId: entry.fieldId, optionId: entry.optionId });
      const held = existing?.axisValues?.some((item) => item.fieldId === entry.fieldId && item.optionId === entry.optionId);
      if (!option.isActive && !held) throw conflict('FIELD_OPTION_INACTIVE', 'The selected option is no longer available.', { optionId: option.id });
      byField.set(entry.fieldId, option.id);
    }
    if (byField.size !== parent.variantAxes.length) throw badRequest('VALIDATION_ERROR', 'axisValues must contain exactly one option for every variant axis.', { field: 'axisValues' });
    return parent.variantAxes.map((fieldId) => ({ fieldId, optionId: byField.get(fieldId)! }));
  }

  private readCategories(workspaceId: string, catalogId: string, categoryIds: unknown, primaryId: unknown) {
    const ids = categoryIds === undefined || categoryIds === null ? [] : categoryIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw badRequest('VALIDATION_ERROR', 'categoryIds must be an array of category ids.', { field: 'categoryIds' });
    const unique = [...new Set(ids as string[])];
    this.categories.assertAssignable(workspaceId, catalogId, unique);
    let primary: string | null = null;
    if (unique.length > 0) {
      primary = typeof primaryId === 'string' ? primaryId : unique[0];
      if (!unique.includes(primary)) throw badRequest('VALIDATION_ERROR', 'primaryCategoryId must be one of categoryIds.', { field: 'primaryCategoryId' });
    } else if (primaryId !== undefined && primaryId !== null) {
      throw badRequest('VALIDATION_ERROR', 'primaryCategoryId requires categoryIds.', { field: 'primaryCategoryId' });
    }
    return { categoryIds: unique, primaryCategoryId: primary };
  }

  private writeCategories(workspaceId: string, product: Product, plan: { categoryIds: string[]; primaryCategoryId: string | null }) {
    const existing = this.state.catalogProductCategories.filter((row) => row.productId === product.id);
    const keep = new Set(plan.categoryIds);
    this.state.catalogProductCategories = this.state.catalogProductCategories.filter((row) => row.productId !== product.id || keep.has(row.categoryId));
    const now = new Date();
    plan.categoryIds.forEach((categoryId, index) => {
      const row = existing.find((item) => item.categoryId === categoryId);
      if (row) row.sortOrder = index;
      else this.state.catalogProductCategories.push({ id: this.support.store.id(), workspaceId, productId: product.id, categoryId, sortOrder: index, createdAt: now });
    });
    product.primaryCategoryId = plan.primaryCategoryId;
  }

  /**
   * Property applicability (Catalog profile over the shared field): variant axes are only set on Variants (through
   * axisValues), parent-only / sellable-only / product-type / category rules are enforced here, server-side.
   */
  private assertPropertiesApplicable(workspaceId: string, product: Product, changes: Map<string, { field: { id: string; code: string } }>, categoryIds: string[]) {
    const violations: Record<string, Array<{ code: string; message: string }>> = {};
    for (const { field } of changes.values()) {
      const profile = this.properties.profileFor(workspaceId, field.id);
      const problem = (message: string) => (violations[field.code] ??= []).push({ code: 'PROPERTY_NOT_APPLICABLE', message });
      if (profile.variantAxis && product.type !== 'VARIANT') problem('Variant axis properties are only set on Variants.');
      else if (profile.appliesTo === 'PARENT' && product.type !== 'PRODUCT_WITH_VARIANTS') problem('This property only applies to parent products.');
      else if (profile.appliesTo === 'SELLABLE' && product.type === 'PRODUCT_WITH_VARIANTS') problem('This property only applies to sellable items.');
      else if (profile.allowedTypes.length > 0 && !profile.allowedTypes.includes(product.type)) problem(`This property does not apply to ${product.type}.`);
      else if (profile.categoryIds.length > 0 && !categoryIds.some((id) => profile.categoryIds.includes(id))) problem('This property applies only to Products in specific categories.');
    }
    if (Object.keys(violations).length > 0) throw fieldValidationFailed(violations);
  }

  auditShape(product: Product) {
    return {
      type: product.type,
      catalogId: product.catalogId,
      parentId: product.parentId,
      name: product.name,
      sku: product.sku,
      state: product.state,
      primaryUnitId: product.primaryUnitId,
      taxable: product.taxable,
      taxRate: product.taxRate,
      taxIncluded: product.taxIncluded,
      axisKey: product.axisKey,
      overrides: product.overrides,
      version: product.version,
    };
  }
}
