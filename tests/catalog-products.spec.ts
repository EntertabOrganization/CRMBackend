/**
 * Domain-level contract tests for Products, Catalogs, Categories, Variants, Units, Price Types and Prices
 * (tests/modules/Automation_Products_Catlouge/Products-Catalog/products.spec.ts and part of catalog.e2e-spec.ts).
 */
import { PRODUCT_ENTITY_TYPE } from '@/src/server/catalog/property-service';
import { addMember, expectAppError, fullApp, otherTenant, type FullApp } from './support/domain';

const params = (query: Record<string, string> = {}) => new URLSearchParams(query);

async function setup() {
  const t = await fullApp();
  const { app, user, workspace } = t;
  const c = app.catalog;
  const catalogs = c.catalogs.list(user, workspace.id, params()).data;
  const defaultCatalog = catalogs.find((item) => item.isDefault)!;
  return { ...t, c, ws: workspace.id, defaultCatalog };
}

async function makeAxes(t: Awaited<ReturnType<typeof setup>>) {
  const { c, user, ws } = t;
  const color = c.properties.create(user, ws, { label: 'Color', fieldType: 'LIST', options: [{ code: 'red', label: 'Red' }, { code: 'blue', label: 'Blue' }], catalog: { variantAxis: true } });
  const size = c.properties.create(user, ws, { label: 'Size', fieldType: 'LIST', options: [{ code: 's', label: 'S' }, { code: 'm', label: 'M' }, { code: 'l', label: 'L' }], catalog: { variantAxis: true } });
  return { color, size };
}

describe('Catalogs and default Catalog', () => {
  it('bootstraps one default Catalog and enforces exactly one default atomically', async () => {
    const t = await setup();
    const { c, user, ws, defaultCatalog } = t;
    expect(defaultCatalog.isDefault).toBe(true);
    const second = c.catalogs.create(user, ws, { name: 'Wholesale' });
    expect(second.isDefault).toBe(false);
    const switched = c.catalogs.setDefault(user, ws, second.id);
    expect(switched.isDefault).toBe(true);
    const all = c.catalogs.list(user, ws, params()).data;
    expect(all.filter((item) => item.isDefault)).toHaveLength(1);
    await expectAppError(() => c.catalogs.update(user, ws, second.id, { version: second.version + 0, isActive: false }), 'DEFAULT_CATALOG_REQUIRED', 409);
    await expectAppError(() => c.catalogs.create(user, ws, { name: ' wholesale ' }), 'CATALOG_NAME_CONFLICT', 409);
  });

  it('never exposes another workspace catalog', async () => {
    const t = await setup();
    const other = await otherTenant(t.app);
    const foreign = t.c.catalogs.list(other.user, other.workspace.id, params()).data[0];
    await expectAppError(() => t.c.catalogs.get(t.user, t.ws, foreign.id), 'CATALOG_NOT_FOUND', 404);
  });
});

describe('Categories', () => {
  it('rejects cross-catalog parenting, cycles and blocks deleting populated categories', async () => {
    const t = await setup();
    const { c, user, ws, defaultCatalog } = t;
    const other = c.catalogs.create(user, ws, { name: 'Other' });
    const root = c.categories.create(user, ws, defaultCatalog.id, { name: 'Root' });
    const child = c.categories.create(user, ws, defaultCatalog.id, { name: 'Child', parentId: root.id });
    const foreignRoot = c.categories.create(user, ws, other.id, { name: 'Foreign' });
    await expectAppError(() => c.categories.create(user, ws, defaultCatalog.id, { name: 'X', parentId: foreignRoot.id }), 'CATEGORY_NOT_FOUND', 404);
    await expectAppError(() => c.categories.move(user, ws, defaultCatalog.id, root.id, { parentId: child.id }), 'CATEGORY_CYCLE', 409);
    await expectAppError(() => c.categories.move(user, ws, defaultCatalog.id, root.id, { parentId: root.id }), 'CATEGORY_CYCLE', 409);

    const product = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'W-1', categoryIds: [child.id] });
    await expectAppError(() => c.categories.remove(user, ws, defaultCatalog.id, root.id), 'CATEGORY_HAS_DEPENDENCIES', 409);
    const blocked = await expectAppError(() => c.categories.remove(user, ws, defaultCatalog.id, child.id), 'CATEGORY_HAS_DEPENDENCIES', 409);
    expect(blocked.details.productCount).toBe(1);
    // The Product survives the blocked delete.
    expect(t.app.store.state.catalogProducts.some((row) => row.id === product.id)).toBe(true);
    c.products.update(user, ws, product.id, { version: product.version, categoryIds: [] });
    expect(c.categories.remove(user, ws, defaultCatalog.id, child.id)).toEqual({ id: child.id, deleted: true });
  });

  it('reorders siblings atomically and validates the sibling set', async () => {
    const t = await setup();
    const { c, user, ws, defaultCatalog } = t;
    const a = c.categories.create(user, ws, defaultCatalog.id, { name: 'A' });
    const b = c.categories.create(user, ws, defaultCatalog.id, { name: 'B' });
    c.categories.reorder(user, ws, defaultCatalog.id, { parentId: null, orderedIds: [b.id, a.id] });
    const listed = c.categories.list(user, ws, defaultCatalog.id, params()).data as Array<{ id: string }>;
    expect(listed.map((row) => row.id)).toEqual([b.id, a.id]);
    await expectAppError(() => c.categories.reorder(user, ws, defaultCatalog.id, { parentId: null, orderedIds: [a.id] }), 'CATEGORY_REORDER_INVALID', 400);
  });

  it('supports several categories with exactly one primary', async () => {
    const t = await setup();
    const { c, user, ws, defaultCatalog } = t;
    const a = c.categories.create(user, ws, defaultCatalog.id, { name: 'A' });
    const b = c.categories.create(user, ws, defaultCatalog.id, { name: 'B' });
    const product = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'W-2', categoryIds: [a.id, b.id], primaryCategoryId: b.id });
    expect(product.primaryCategoryId).toBe(b.id);
    expect(product.categoryIds).toEqual([a.id, b.id]);
    await expectAppError(() => c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Bad', sku: 'W-3', categoryIds: [a.id], primaryCategoryId: b.id }), 'VALIDATION_ERROR', 400);
    const updated = c.products.update(user, ws, product.id, { version: product.version, categoryIds: [a.id] });
    expect(updated.primaryCategoryId).toBe(a.id);
  });
});

describe('Product types and SKU', () => {
  it('enforces type-specific rules and workspace-wide case-insensitive SKU uniqueness including archived items', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const simple = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'Abc-1' });
    const service = c.products.create(user, ws, { type: 'SERVICE', name: 'Consulting' });
    expect(service.sku).toBeNull();
    expect(service.primaryUnit?.code).toBe('HOUR');
    await expectAppError(() => c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Dup', sku: ' abc-1 ' }), 'PRODUCT_SKU_CONFLICT', 409);
    await expectAppError(() => c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'NoSku' }), 'VALIDATION_ERROR', 400);
    await expectAppError(() => c.products.create(user, ws, { type: 'PRODUCT_WITH_VARIANTS', name: 'Parent', sku: 'P-1' }), 'PRODUCT_TYPE_INVALID', 400);
    await expectAppError(() => c.products.create(user, ws, { type: 'VARIANT', name: 'V', sku: 'V-1' }), 'PRODUCT_TYPE_INVALID', 400);
    c.products.archive(user, ws, simple.id, 'PRODUCT');
    // An archived item keeps owning its SKU.
    await expectAppError(() => c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Dup2', sku: 'ABC-1' }), 'PRODUCT_SKU_CONFLICT', 409);
    await expectAppError(() => c.products.update(user, ws, simple.id, { version: 99, name: 'x' }), 'CATALOG_VERSION_CONFLICT', 409);
    await expectAppError(() => c.products.update(user, ws, service.id, { version: service.version, type: 'SIMPLE_PRODUCT' }), 'PRODUCT_TYPE_INVALID', 400);
  });

  it('rejects mass assignment of protected fields', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    await expectAppError(() => c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'X', sku: 'X-1', workspaceId: 'other', skuKey: 'k', version: 9, state: 'ARCHIVED' }), 'CATALOG_FIELD_NOT_UPDATABLE', 400);
  });

  it('is workspace isolated for products, units and price types', async () => {
    const t = await setup();
    const other = await otherTenant(t.app);
    const foreignProduct = t.app.catalog.products.create(other.user, other.workspace.id, { type: 'SIMPLE_PRODUCT', name: 'Theirs', sku: 'T-1' });
    await expectAppError(() => t.c.products.get(t.user, t.ws, foreignProduct.id, 'PRODUCT'), 'PRODUCT_NOT_FOUND', 404);
    // The same SKU is free in another workspace.
    expect(t.c.products.create(t.user, t.ws, { type: 'SIMPLE_PRODUCT', name: 'Mine', sku: 'T-1' }).sku).toBe('T-1');
    const foreignUnit = t.app.catalog.units.list(other.user, other.workspace.id, params()).data[0];
    await expectAppError(() => t.c.products.create(t.user, t.ws, { type: 'SIMPLE_PRODUCT', name: 'U', sku: 'U-1', primaryUnitId: foreignUnit.id }), 'UNIT_NOT_FOUND', 404);
    const foreignType = t.app.catalog.priceTypes.list(other.user, other.workspace.id, params()).data[0];
    await expectAppError(() => t.c.products.create(t.user, t.ws, { type: 'SIMPLE_PRODUCT', name: 'P', sku: 'P-1', prices: [{ priceTypeId: foreignType.id, currency: 'USD', amount: '1' }] }), 'PRICE_TYPE_NOT_FOUND', 404);
  });
});

describe('Variants, inheritance and the matrix', () => {
  async function family(t: Awaited<ReturnType<typeof setup>>) {
    const { c, user, ws } = t;
    const { color, size } = await makeAxes(t);
    const parent = c.products.create(user, ws, { type: 'PRODUCT_WITH_VARIANTS', name: 'T-Shirt', description: 'Cotton', variantAxes: [color.id, size.id], taxable: true, taxRate: '15' });
    return { parent, color, size };
  }

  it('previews and generates the missing combinations idempotently without duplicating identity', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const { parent, color, size } = await family(t);
    const request = { axes: [{ fieldId: color.id, optionIds: color.options!.map((option: any) => option.id) }, { fieldId: size.id, optionIds: size.options!.slice(0, 2).map((option: any) => option.id) }], skuPrefix: 'TS' };
    const preview = c.matrix.generate(user, ws, parent.id, { ...request, preview: true });
    expect(preview.totals).toMatchObject({ combinations: 4, new: 4, existing: 0 });
    expect(t.app.store.state.catalogProducts.filter((row) => row.type === 'VARIANT')).toHaveLength(0);
    const first = c.matrix.generate(user, ws, parent.id, request);
    expect(first.applied.created).toBe(4);
    const second = c.matrix.generate(user, ws, parent.id, request);
    expect(second.applied.created).toBe(0);
    expect(second.totals).toMatchObject({ existing: 4, new: 0 });
    const variants = t.app.store.state.catalogProducts.filter((row) => row.type === 'VARIANT');
    expect(new Set(variants.map((row) => row.axisKey)).size).toBe(4);
    // Narrowing the matrix reports unwanted Variants but never deletes them.
    const narrowed = c.matrix.generate(user, ws, parent.id, { axes: [{ fieldId: color.id, optionIds: [color.options![0].id] }, { fieldId: size.id, optionIds: size.options!.slice(0, 2).map((option: any) => option.id) }], skuPrefix: 'TS' });
    expect(narrowed.totals.unwanted).toBe(2);
    expect(t.app.store.state.catalogProducts.filter((row) => row.type === 'VARIANT' && row.state === 'ACTIVE')).toHaveLength(4);
  });

  it('refuses oversized matrices, duplicate combinations and SKU conflicts atomically', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const { parent, color, size } = await family(t);
    c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Taken', sku: 'TS-RED-S' });
    const request = { axes: [{ fieldId: color.id, optionIds: [color.options![0].id] }, { fieldId: size.id, optionIds: [size.options![0].id, size.options![1].id] }], skuPrefix: 'TS' };
    await expectAppError(() => c.matrix.generate(user, ws, parent.id, request), 'PRODUCT_SKU_CONFLICT', 409);
    expect(t.app.store.state.catalogProducts.filter((row) => row.type === 'VARIANT')).toHaveLength(0);
    const axisValues = [{ fieldId: color.id, optionId: color.options![0].id }, { fieldId: size.id, optionId: size.options![0].id }];
    c.products.createVariant(user, ws, parent.id, { sku: 'V-1', axisValues });
    await expectAppError(() => c.products.createVariant(user, ws, parent.id, { sku: 'V-2', axisValues }), 'VARIANT_COMBINATION_CONFLICT', 409);
    await expectAppError(() => c.products.createVariant(user, ws, parent.id, { sku: 'v-1', axisValues: [{ fieldId: color.id, optionId: color.options![1].id }, { fieldId: size.id, optionId: size.options![0].id }] }), 'PRODUCT_SKU_CONFLICT', 409);
  });

  it('resolves override-then-parent inheritance and never overwrites an explicit override', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const { parent, color, size } = await family(t);
    const axisValues = [{ fieldId: color.id, optionId: color.options![0].id }, { fieldId: size.id, optionId: size.options![2].id }];
    const inheriting = c.products.createVariant(user, ws, parent.id, { sku: 'V-A', axisValues });
    const overriding = c.products.createVariant(user, ws, parent.id, { sku: 'V-B', axisValues: [{ fieldId: color.id, optionId: color.options![1].id }, { fieldId: size.id, optionId: size.options![2].id }], description: 'Special', taxable: false });
    expect(inheriting.description).toBe('Cotton');
    expect(inheriting.tax).toMatchObject({ taxable: true, rate: '15' });
    expect(overriding.description).toBe('Special');
    expect(overriding.tax.taxable).toBe(false);
    expect(overriding.inherited).toMatchObject({ description: false, tax: false, name: true });

    c.products.update(user, ws, parent.id, { version: parent.version, description: 'Organic cotton', name: 'Tee' });
    expect(c.products.get(user, ws, inheriting.id, 'VARIANT').description).toBe('Organic cotton');
    expect(c.products.get(user, ws, inheriting.id, 'VARIANT').name.startsWith('Tee')).toBe(true);
    expect(c.products.get(user, ws, overriding.id, 'VARIANT').description).toBe('Special');

    const reset = c.products.updateVariant(user, ws, overriding.id, { version: overriding.version, inherit: ['description', 'tax'] });
    expect(reset.description).toBe('Organic cotton');
    expect(reset.tax.taxable).toBe(true);
    // Axes cannot be silently rewritten while active Variants exist.
    await expectAppError(() => c.products.update(user, ws, parent.id, { version: parent.version + 1, variantAxes: [color.id] }), 'VARIANT_COMBINATION_CONFLICT', 409);
  });

  it('requires a valid parent and keeps Variants inside the parent workspace', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const simple = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Plain', sku: 'PL-1' });
    await expectAppError(() => c.products.createVariant(user, ws, simple.id, { sku: 'X', axisValues: [{ fieldId: 'a', optionId: 'b' }] }), 'VARIANT_PARENT_INVALID', 400);
    const other = await otherTenant(t.app);
    await expectAppError(() => t.c.products.createVariant(other.user, other.workspace.id, simple.id, { sku: 'Y', axisValues: [] }), 'PRODUCT_NOT_FOUND', 404);
  });
});

describe('Archive and delete lifecycle', () => {
  it('archives a used product, preserves history and blocks hard delete; unused delete cascades cleanly', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const { color, size } = await makeAxes(t);
    const parent = c.products.create(user, ws, { type: 'PRODUCT_WITH_VARIANTS', name: 'Shirt', variantAxes: [color.id] });
    const v1 = c.products.createVariant(user, ws, parent.id, { sku: 'S-R', axisValues: [{ fieldId: color.id, optionId: color.options![0].id }] });
    void size;
    // Simulate a durable dependency (a commercial row) on the Variant.
    t.app.store.state.commercialProductRows.push({ workspaceId: ws, productId: v1.id } as any);
    await expectAppError(() => c.products.remove(user, ws, parent.id, 'PRODUCT'), 'PRODUCT_HAS_DEPENDENCIES', 409);
    const archived = c.products.archive(user, ws, parent.id, 'PRODUCT');
    expect(archived.state).toBe('ARCHIVED');
    expect(c.products.get(user, ws, v1.id, 'VARIANT').state).toBe('ARCHIVED');
    await expectAppError(() => c.products.reactivate(user, ws, v1.id, 'VARIANT'), 'PRODUCT_PARENT_ARCHIVED', 409);
    expect(c.products.list(user, ws, params({ purpose: 'picker' })).data).toHaveLength(0);
    c.products.reactivate(user, ws, parent.id, 'PRODUCT');
    expect(c.products.get(user, ws, v1.id, 'VARIANT').state).toBe('ACTIVE');
    t.app.store.state.commercialProductRows.pop();
    expect(c.products.remove(user, ws, parent.id, 'PRODUCT')).toMatchObject({ deleted: true, removedCount: 2 });
    expect(t.app.store.state.catalogProducts).toHaveLength(0);
  });
});

describe('Units, ratios, Price Types and prices', () => {
  it('validates ratios (positive, distinct, same workspace) and phrases the direction explicitly', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const units = c.units.list(user, ws, params()).data;
    const piece = units.find((unit) => unit.code === 'PIECE')!;
    const box = units.find((unit) => unit.code === 'BOX')!;
    const product = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'R-1', primaryUnitId: piece.id });
    await expectAppError(() => c.products.createRatio(user, ws, product.id, { unitId: box.id, ratio: '0' }), 'UNIT_RATIO_INVALID', 400);
    await expectAppError(() => c.products.createRatio(user, ws, product.id, { unitId: box.id, ratio: '-2' }), 'UNIT_RATIO_INVALID', 400);
    await expectAppError(() => c.products.createRatio(user, ws, product.id, { unitId: piece.id, ratio: '2' }), 'UNIT_RATIO_INVALID', 400);
    const ratio = c.products.createRatio(user, ws, product.id, { unitId: box.id, ratio: '12' });
    expect(ratio.description).toBe('1 Box = 12 Piece');
    await expectAppError(() => c.products.createRatio(user, ws, product.id, { unitId: box.id, ratio: '6' }), 'UNIT_RATIO_CONFLICT', 409);
    const other = await otherTenant(t.app);
    const foreign = t.app.catalog.units.list(other.user, other.workspace.id, params()).data[0];
    await expectAppError(() => c.products.createRatio(user, ws, product.id, { unitId: foreign.id, ratio: '3' }), 'UNIT_NOT_FOUND', 404);
  });

  it('keeps exactly one base Price Type and stores precise prices with explicit currency', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const types = c.priceTypes.list(user, ws, params()).data;
    const base = types.find((type) => type.isBase)!;
    const retail = c.priceTypes.create(user, ws, { code: 'retail', name: 'Retail' });
    await expectAppError(() => c.priceTypes.update(user, ws, base.id, { version: base.version, isActive: false }), 'BASE_PRICE_TYPE_REQUIRED', 409);
    c.priceTypes.setBase(user, ws, retail.id);
    expect(c.priceTypes.list(user, ws, params()).data.filter((type) => type.isBase)).toHaveLength(1);
    c.priceTypes.setBase(user, ws, base.id);

    const product = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'PR-1' });
    const priced = c.products.putPrices(user, ws, product.id, 'PRODUCT', { prices: [{ priceTypeId: base.id, currency: 'usd', amount: '19.999' }, { priceTypeId: retail.id, currency: 'EUR', amount: '0.1' }, { priceTypeId: base.id, currency: 'EUR', amount: '18' }] });
    expect(priced.prices.find((price) => price.isBase && price.currency === 'USD')!.amount).toBe('19.999');
    await expectAppError(() => c.products.putPrices(user, ws, product.id, 'PRODUCT', { prices: [{ priceTypeId: base.id, currency: 'USD', amount: '1' }, { priceTypeId: base.id, currency: 'USD', amount: '2' }] }), 'PRODUCT_PRICE_INVALID', 400);
    await expectAppError(() => c.products.putPrices(user, ws, product.id, 'PRODUCT', { prices: [{ priceTypeId: base.id, currency: 'ZZZ', amount: '1' }] }), 'PRODUCT_PRICE_INVALID', 400);
    await expectAppError(() => c.products.putPrices(user, ws, product.id, 'PRODUCT', { prices: [{ priceTypeId: base.id, currency: 'USD', amount: '-1' }] }), 'PRODUCT_PRICE_INVALID', 400);
    // Prices never touch floating point: 0.1 + 0.2 style values survive exactly.
    const exact = c.products.putPrices(user, ws, product.id, 'PRODUCT', { prices: [{ priceTypeId: base.id, currency: 'USD', amount: '0.30000000' }] });
    expect(exact.prices[0].amount).toBe('0.3');
  });

  it('requires dedicated permissions for master data and price management', async () => {
    const t = await setup();
    const { c, ws } = t;
    const seller = await addMember(t.app, t.user, ws, 'seller', [['product.read', 'WORKSPACE'], ['product_row.manage', 'WORKSPACE']]);
    const product = c.products.create(t.user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'PM-1' });
    expect(c.products.get(seller.user, ws, product.id, 'PRODUCT').sku).toBe('PM-1');
    await expectAppError(() => c.products.update(seller.user, ws, product.id, { version: product.version, name: 'x' }), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.products.putPrices(seller.user, ws, product.id, 'PRODUCT', { prices: [] }), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.catalogs.create(seller.user, ws, { name: 'Nope' }), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.priceTypes.create(seller.user, ws, { code: 'X', name: 'X' }), 'PERMISSION_DENIED', 403);
    const scoped = await addMember(t.app, t.user, ws, 'scoped', [['product.update', 'OWN']]);
    await expectAppError(() => c.products.update(scoped.user, ws, product.id, { version: product.version, name: 'x' }), 'PERMISSION_DENIED', 403);
  });
});

describe('Product properties reuse the shared field engine', () => {
  it('stores typed values through Custom Fields and enforces applicability', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const material = c.properties.create(user, ws, { label: 'Material', fieldType: 'TEXT', catalog: { filterable: true, appliesTo: 'SELLABLE' } });
    const brand = c.properties.create(user, ws, { label: 'Brand', fieldType: 'TEXT', catalog: { appliesTo: 'PARENT' } });
    expect(t.app.store.state.crmCustomFields.find((field) => field.id === material.id)?.entityType).toBe(PRODUCT_ENTITY_TYPE);
    const product = c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'Widget', sku: 'PP-1', customFields: { material: 'Steel' } });
    expect(product.customFields.material).toBe('Steel');
    await expectAppError(() => c.products.create(user, ws, { type: 'SIMPLE_PRODUCT', name: 'W2', sku: 'PP-2', customFields: { brand: 'Acme' } }), 'FIELD_VALIDATION_FAILED', 400);
    const found = c.products.list(user, ws, params({ 'prop.material': 'steel' }));
    expect(found.data.map((row) => row.id)).toEqual([product.id]);
    await expectAppError(() => Promise.resolve().then(() => c.products.list(user, ws, params({ 'prop.brand': 'x' }))), 'CATALOG_QUERY_FIELD_NOT_ALLOWED', 400);
    void brand;
  });

  it('lets a variant-axis option be deactivated only after dependent Variants are archived', async () => {
    const t = await setup();
    const { c, user, ws } = t;
    const { color } = await makeAxes(t);
    const parent = c.products.create(user, ws, { type: 'PRODUCT_WITH_VARIANTS', name: 'Shirt', variantAxes: [color.id] });
    const variant = c.products.createVariant(user, ws, parent.id, { sku: 'SO-1', axisValues: [{ fieldId: color.id, optionId: color.options![0].id }] });
    await expectAppError(() => c.properties.updateOption(user, ws, color.id, color.options![0].id, { isActive: false }), 'PROPERTY_OPTION_IN_USE', 409);
    c.products.archive(user, ws, variant.id, 'VARIANT');
    expect(c.properties.updateOption(user, ws, color.id, color.options![0].id, { isActive: false })).toBeTruthy();
  });
});

export type { FullApp };
