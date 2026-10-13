/**
 * Pricing, units, tax and commercial Product Rows
 * (tests/modules/Automation_Products_Catlouge/Products-Catalog/pricing-product-rows.spec.ts + catalog-security.e2e-spec.ts).
 */
import { calculateRow, fromScaled, toScaled } from '@/src/server/catalog/money';
import { addMember, CRM_READ_UPDATE, expectAppError, fullApp, otherTenant } from './support/domain';

const params = (query: Record<string, string> = {}) => new URLSearchParams(query);
type T = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const t = await fullApp();
  const c = t.app.catalog;
  const ws = t.workspace.id;
  const company = t.app.crmCore.createCompany(t.user, ws, { name: 'Acme' });
  const deal = t.app.crm.createDeal(t.user, ws, { title: 'Big deal', companyId: company.id });
  const base = c.priceTypes.list(t.user, ws, params()).data.find((type) => type.isBase)!;
  const wholesale = c.priceTypes.create(t.user, ws, { code: 'WHOLESALE', name: 'Wholesale' });
  const units = c.units.list(t.user, ws, params()).data;
  const box = units.find((unit) => unit.code === 'BOX')!;
  const product = c.products.create(t.user, ws, {
    type: 'SIMPLE_PRODUCT',
    name: 'Widget',
    sku: 'ROW-1',
    taxable: true,
    taxRate: '15',
    prices: [{ priceTypeId: base.id, currency: 'USD', amount: '10.10' }, { priceTypeId: wholesale.id, currency: 'USD', amount: '8' }],
  });
  c.products.createRatio(t.user, ws, product.id, { unitId: box.id, ratio: '12' });
  const put = (rows: unknown[], extra: Record<string, unknown> = {}, user = t.user, ownerId = deal.id) =>
    c.rows.replace(user, ws, 'deals', ownerId, { rows, ...extra });
  return { ...t, c, ws, deal, base, wholesale, box, product, put };
}

async function seller(t: T, extra: Array<[string, 'WORKSPACE']> = []) {
  return addMember(t.app, t.user, t.ws, 'seller', [...CRM_READ_UPDATE, ['product.read', 'WORKSPACE'], ['product_row.manage', 'WORKSPACE'], ...extra]);
}

describe('Commercial calculation', () => {
  it('uses exact decimals with half-up rounding at currency precision', () => {
    // 3 x 0.10 must be exactly 0.30 (no binary float drift), 10% discount and 15% exclusive tax.
    const a = calculateRow(toScaled('3')!, toScaled('0.10')!, { type: 'NONE', value: 0n }, { taxable: false, rate: 0n, included: false }, 'USD');
    expect(fromScaled(a.total)).toBe('0.3');
    const b = calculateRow(toScaled('3')!, toScaled('19.99')!, { type: 'PERCENT', value: toScaled('10')! }, { taxable: true, rate: toScaled('15')!, included: false }, 'USD');
    expect([fromScaled(b.gross), fromScaled(b.discountAmount), fromScaled(b.subtotal), fromScaled(b.taxAmount), fromScaled(b.total)]).toEqual(['59.97', '6', '53.97', '8.1', '62.07']);
    // Tax-inclusive: total stays the entered net, tax is extracted.
    const c = calculateRow(toScaled('1')!, toScaled('115')!, { type: 'NONE', value: 0n }, { taxable: true, rate: toScaled('15')!, included: true }, 'USD');
    expect([fromScaled(c.subtotal), fromScaled(c.taxAmount), fromScaled(c.total)]).toEqual(['100', '15', '115']);
    // Zero-decimal currencies round to whole units.
    const d = calculateRow(toScaled('3')!, toScaled('33.5')!, { type: 'NONE', value: 0n }, { taxable: false, rate: 0n, included: false }, 'JPY');
    expect(fromScaled(d.total)).toBe('101');
  });
});

describe('Product Rows - snapshots', () => {
  it('snapshots name/SKU/unit/price/tax for a catalog row, ignoring client totals', async () => {
    const t = await setup();
    const view = t.put([{ productId: t.product.id, quantity: '3', subtotal: '1', total: '1', taxAmount: '999' }]);
    const row = view.rows[0];
    expect(row).toMatchObject({ name: 'Widget', sku: 'ROW-1', unitCode: 'PIECE', unitPrice: '10.1', currency: 'USD', isManual: false, priceTypeCode: 'BASE' });
    expect(row.tax).toMatchObject({ taxable: true, rate: '15', included: false });
    expect([row.subtotal, row.taxAmount, row.total]).toEqual(['30.3', '4.55', '34.85']);
    expect(view.totals.total).toBe('34.85');
    expect(view.version).toBe(1);
    // The Deal amount reflects the row total through the CRM service.
    expect(t.app.store.state.crmDeals.find((deal) => deal.id === t.deal.id)?.amount).toBe(34.85);
  });

  it('does not rewrite historical rows after price, tax, name or unit master changes', async () => {
    const t = await setup();
    const before = t.put([{ productId: t.product.id, quantity: '2' }]).rows[0];
    const fresh = t.c.products.get(t.user, t.ws, t.product.id, 'PRODUCT');
    t.c.products.putPrices(t.user, t.ws, t.product.id, 'PRODUCT', { prices: [{ priceTypeId: t.base.id, currency: 'USD', amount: '99' }] });
    t.c.products.update(t.user, t.ws, t.product.id, { version: fresh.version, name: 'Renamed', taxable: false, taxRate: null });
    t.c.units.update(t.user, t.ws, t.c.units.list(t.user, t.ws, params()).data.find((unit) => unit.code === 'PIECE')!.id, { version: 1, name: 'Each' });
    const after = t.c.rows.list(t.user, t.ws, 'deals', t.deal.id).rows[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({ name: 'Widget', unitPrice: '10.1', unitName: 'Piece' });
    expect(after.tax.rate).toBe('15');
    // A brand new row picks up the new master values.
    const next = t.put([{ id: before.id, quantity: '2' }, { productId: t.product.id, quantity: '1' }], { expectedVersion: 1 });
    expect(next.rows[1]).toMatchObject({ name: 'Renamed', unitPrice: '99' });
    expect(next.rows[0].name).toBe('Widget');
  });

  it('supports alternate units with a ratio snapshot and price scaled by the ratio', async () => {
    const t = await setup();
    const row = t.put([{ productId: t.product.id, quantity: '2', unitId: t.box.id }]).rows[0];
    expect(row).toMatchObject({ unitCode: 'BOX', unitRatio: '12', baseUnitCode: 'PIECE', unitPrice: '121.2' });
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1', unitId: t.c.units.list(t.user, t.ws, params()).data.find((unit) => unit.code === 'METER')!.id }], { expectedVersion: 1 }), 'UNIT_RATIO_INVALID', 400);
  });

  it('creates manual one-off rows without a Product master record', async () => {
    const t = await setup();
    const view = t.put([{ name: 'Custom installation', quantity: '1.5', unitName: 'day', unitPrice: '200', currency: 'USD', tax: { taxable: true, rate: '10' } }]);
    expect(view.rows[0]).toMatchObject({ isManual: true, productId: null, name: 'Custom installation', unitName: 'day', total: '330' });
    expect(t.app.store.state.catalogProducts.some((product) => product.name === 'Custom installation')).toBe(false);
    await expectAppError(() => t.put([{ name: '', quantity: '1', unitPrice: '1', currency: 'USD' }], { expectedVersion: 1 }), 'VALIDATION_ERROR', 400);
    await expectAppError(() => t.put([{ name: 'x', quantity: '0', unitPrice: '1', currency: 'USD' }], { expectedVersion: 1 }), 'PRODUCT_ROW_INVALID', 400);
  });

  it('replaces rows atomically, enforces one currency and optimistic versions', async () => {
    const t = await setup();
    t.put([{ productId: t.product.id, quantity: '1' }]);
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1' }], { expectedVersion: 0 }), 'CATALOG_VERSION_CONFLICT', 409);
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1' }, { name: 'EUR item', quantity: '1', unitPrice: '1', currency: 'EUR' }], { expectedVersion: 1 }), 'PRODUCT_ROW_CURRENCY_MISMATCH', 400);
    // The failed replace left the previous rows untouched.
    expect(t.c.rows.list(t.user, t.ws, 'deals', t.deal.id)).toMatchObject({ version: 1, rows: [{ productId: t.product.id }] });
    expect(t.put([], { expectedVersion: 1 }).rows).toHaveLength(0);
  });

  it('is idempotent for a repeated request key', async () => {
    const t = await setup();
    t.put([{ productId: t.product.id, quantity: '1' }], { idempotencyKey: 'k1' });
    const replay = t.put([{ productId: t.product.id, quantity: '1' }], { idempotencyKey: 'k1' });
    expect(replay.version).toBe(1);
    expect(t.app.store.state.commercialProductRows).toHaveLength(1);
  });
});

describe('Product Rows - override permissions and isolation', () => {
  it('lets a sales user add a product and change quantity but blocks price/discount/tax overrides regardless of client flags', async () => {
    const t = await setup();
    const s = await seller(t);
    const view = t.put([{ productId: t.product.id, quantity: '2' }], {}, s.user);
    const rowId = view.rows[0].id;
    // Quantity edit is fine.
    expect(t.put([{ id: rowId, quantity: '5' }], { expectedVersion: 1 }, s.user).rows[0].quantity).toBe('5');
    // Echoing the row unchanged (including override flags set to false) is not an override.
    t.put([{ ...view.rows[0], quantity: '5', priceOverridden: false }], { expectedVersion: 2 }, s.user);
    for (const [patch, what] of [
      [{ unitPrice: '1' }, 'price'],
      [{ discount: { type: 'PERCENT', value: '10' } }, 'discount'],
      [{ tax: { taxable: false } }, 'tax'],
      [{ priceTypeId: t.wholesale.id }, 'price'],
    ] as const) {
      const denied = await expectAppError(() => t.put([{ id: rowId, ...patch, priceOverridden: false, discountOverridden: false, taxOverridden: false }], { expectedVersion: 3 }, s.user), 'PRODUCT_ROW_OVERRIDE_FORBIDDEN', 403);
      expect(denied.details.overrides).toContain(what);
    }
    // New rows are subject to the same detection (a custom price is an override; so is a manual row).
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1', unitPrice: '0.01' }], { expectedVersion: 3 }, s.user), 'PRODUCT_ROW_OVERRIDE_FORBIDDEN', 403);
    await expectAppError(() => t.put([{ name: 'free lunch', quantity: '1', unitPrice: '0', currency: 'USD' }], { expectedVersion: 3 }, s.user), 'PRODUCT_ROW_OVERRIDE_FORBIDDEN', 403);
    expect(t.c.rows.list(s.user, t.ws, 'deal', t.deal.id).capabilities).toEqual({ canManage: true, canEditPrice: false, canEditDiscount: false, canEditTax: false });
  });

  it('accepts each dedicated override permission independently', async () => {
    const t = await setup();
    const p = await seller(t, [['product_row.edit_price', 'WORKSPACE']]);
    const d = await seller(t, [['product_row.edit_discount', 'WORKSPACE']]);
    const x = await seller(t, [['product_row.edit_tax', 'WORKSPACE']]);
    const base = t.put([{ productId: t.product.id, quantity: '1' }]);
    const id = base.rows[0].id;
    expect(t.put([{ id, unitPrice: '7' }], { expectedVersion: 1 }, p.user).rows[0]).toMatchObject({ unitPrice: '7', overrides: { price: true } });
    await expectAppError(() => t.put([{ id, discount: { type: 'AMOUNT', value: '1' } }], { expectedVersion: 2 }, p.user), 'PRODUCT_ROW_OVERRIDE_FORBIDDEN', 403);
    expect(t.put([{ id, discount: { type: 'AMOUNT', value: '1' } }], { expectedVersion: 2 }, d.user).rows[0].discount).toMatchObject({ type: 'AMOUNT', amount: '1' });
    expect(t.put([{ id, tax: { taxable: true, rate: '5', included: true } }], { expectedVersion: 3 }, x.user).rows[0].tax).toMatchObject({ rate: '5', included: true });
    await expectAppError(() => t.put([{ id, tax: { taxable: false } }], { expectedVersion: 4 }, d.user), 'PRODUCT_ROW_OVERRIDE_FORBIDDEN', 403);
  });

  it('rejects a Product, Unit or Price Type from another workspace and hides inaccessible owners', async () => {
    const t = await setup();
    const other = await otherTenant(t.app);
    const foreign = t.c.products.create(other.user, other.workspace.id, { type: 'SIMPLE_PRODUCT', name: 'Theirs', sku: 'F-1', prices: [] });
    await expectAppError(() => t.put([{ productId: foreign.id, quantity: '1' }]), 'PRODUCT_NOT_FOUND', 404);
    const foreignType = t.c.priceTypes.list(other.user, other.workspace.id, params()).data[0];
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1', priceTypeId: foreignType.id }]), 'PRICE_TYPE_NOT_FOUND', 404);
    const foreignUnit = t.c.units.list(other.user, other.workspace.id, params()).data[0];
    await expectAppError(() => t.put([{ name: 'x', quantity: '1', unitPrice: '1', currency: 'USD', unitId: foreignUnit.id }]), 'UNIT_NOT_FOUND', 404);
    // Owner from another workspace / not readable by the caller is a plain 404, never a row leak.
    await expectAppError(() => t.c.rows.list(other.user, other.workspace.id, 'deals', t.deal.id), 'PRODUCT_ROW_OWNER_NOT_FOUND', 404);
    const blind = await addMember(t.app, t.user, t.ws, 'blind', [['product_row.manage', 'WORKSPACE']]);
    await expectAppError(() => t.c.rows.list(blind.user, t.ws, 'deals', t.deal.id), 'PRODUCT_ROW_OWNER_NOT_FOUND', 404);
    await expectAppError(() => t.c.rows.list(t.user, t.ws, 'estimates', t.deal.id), 'PRODUCT_ROW_OWNER_UNSUPPORTED', 400);
  });

  it('requires the owner update permission plus row management to write', async () => {
    const t = await setup();
    const readOnly = await addMember(t.app, t.user, t.ws, 'ro', [['crm.deal.read', 'WORKSPACE'], ['product_row.manage', 'WORKSPACE'], ['product.read', 'WORKSPACE']]);
    expect(t.c.rows.list(readOnly.user, t.ws, 'deals', t.deal.id).rows).toEqual([]);
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1' }], {}, readOnly.user), 'PERMISSION_DENIED', 403);
    const noRow = await addMember(t.app, t.user, t.ws, 'norow', CRM_READ_UPDATE);
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1' }], {}, noRow.user), 'PERMISSION_DENIED', 403);
  });

  it('does not offer archived products for new rows but keeps existing rows readable', async () => {
    const t = await setup();
    t.put([{ productId: t.product.id, quantity: '1' }]);
    t.c.products.archive(t.user, t.ws, t.product.id, 'PRODUCT');
    await expectAppError(() => t.put([{ productId: t.product.id, quantity: '1' }, { productId: t.product.id, quantity: '1' }], { expectedVersion: 1 }), 'PRODUCT_ARCHIVED', 409);
    expect(t.c.rows.list(t.user, t.ws, 'deals', t.deal.id).rows[0].name).toBe('Widget');
    await expectAppError(() => t.c.products.remove(t.user, t.ws, t.product.id, 'PRODUCT'), 'PRODUCT_HAS_DEPENDENCIES', 409);
  });
});
