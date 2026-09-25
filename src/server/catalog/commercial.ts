import type { ActorContext, AccessService } from '../access-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict, forbidden } from '../errors';
import { canonicalDecimal } from '../fields/decimal';
import type { CrmCoreService } from '../crm-core-service';
import type { ProductPriceService } from './price-service';
import type { ProductService, SellableView } from './product-service';
import { calculateRow, fitsCurrency, fromScaled, isValidCurrency, mulDivRound, sumScaled, toScaled } from './money';
import type { CatalogSupport, Json } from './support';
import { assertOnlyKeys, isPlainObject, requiredText } from './support';
import type { CatalogUnit, CommercialProductRow, DiscountType } from './types';
import { CATALOG_PERMISSIONS as P } from './types';

const MAX_ROWS = 500;
const ROW_INPUT_KEYS = ['id', 'productId', 'name', 'quantity', 'unitId', 'unitName', 'priceTypeId', 'unitPrice', 'currency', 'discount', 'tax', 'sortOrder'];
/** Values a client may echo back from a GET; they are never trusted and never read. */
const ROW_ECHO_KEYS = ['subtotal', 'taxAmount', 'total', 'discountAmount', 'isManual', 'priceOverridden', 'discountOverridden', 'taxOverridden', 'version', 'nameSnapshot', 'skuSnapshot', 'sku', 'variantSnapshot', 'unitCodeSnapshot', 'unitNameSnapshot', 'unitRatioSnapshot', 'baseUnitCodeSnapshot', 'priceTypeCodeSnapshot', 'taxCodeSnapshot', 'parentProductId', 'unitCode', 'priceTypeCode', 'createdAt', 'updatedAt', 'gross', 'variantLabel', 'unitRatio', 'baseUnitCode', 'overrides'];

/** Owner of commercial rows (Deal now; Lead/Estimate/Invoice register later without changing Catalog). */
export interface ProductRowOwnerAdapter {
  readonly ownerType: string;
  readonly label: string;
  load(workspaceId: string, ownerId: string): { currencyCode: string | null } | undefined;
  canRead(actor: ActorContext, ownerId: string): boolean;
  canUpdate(actor: ActorContext, ownerId: string): boolean;
  /** Optional recalculation hook: reflect the confirmed row totals on the owner through the owner's own service. */
  applyTotals?(user: User, workspaceId: string, ownerId: string, totals: { currency: string; total: string }): void;
}

export class CrmProductRowOwnerAdapter implements ProductRowOwnerAdapter {
  constructor(
    readonly ownerType: 'DEAL' | 'LEAD',
    readonly label: string,
    private readonly access: AccessService,
    private readonly crm: CrmCoreService,
  ) {}

  load(workspaceId: string, ownerId: string) {
    const record = this.access.crmRecord(workspaceId, this.ownerType, ownerId) as { currencyCode?: string | null } | undefined;
    return record ? { currencyCode: record.currencyCode ?? null } : undefined;
  }

  canRead(actor: ActorContext, ownerId: string) {
    return this.access.canAccessCrmRecord(actor, this.ownerType, ownerId, 'read');
  }

  canUpdate(actor: ActorContext, ownerId: string) {
    return this.access.canAccessCrmRecord(actor, this.ownerType, ownerId, 'update');
  }

  applyTotals(user: User, workspaceId: string, ownerId: string, totals: { currency: string; total: string }) {
    const record = this.access.crmRecord(workspaceId, this.ownerType, ownerId) as { version: number } | undefined;
    if (!record) return;
    // CRM keeps its own numeric amount type; the exact decimal total stays authoritative on the row set.
    const amountKey = this.ownerType === 'DEAL' ? 'amount' : 'estimatedAmount';
    this.crm.updateRecord(user, workspaceId, this.ownerType, ownerId, { [amountKey]: Number(totals.total), currencyCode: totals.currency, expectedVersion: record.version });
  }
}

type Discount = { type: DiscountType; value: string };
type Tax = { taxable: boolean; rate: string; included: boolean };

type Overrides = { price: boolean; discount: boolean; tax: boolean };

/** The one commercial calculation implementation: exact decimals, explicit half-up rounding, server-authoritative totals. */
export class CommercialValueService {
  calculate(quantity: string, unitPrice: string, discount: Discount, tax: Tax, currency: string) {
    const qty = toScaled(quantity)!;
    const price = toScaled(unitPrice)!;
    const discountValue = toScaled(discount.value)!;
    if (discount.type === 'AMOUNT' && !fitsCurrency(discountValue, currency)) {
      throw badRequest('PRODUCT_ROW_INVALID', `A discount amount cannot have more decimals than ${currency} allows.`, { field: 'discount.value' });
    }
    try {
      const amounts = calculateRow(qty, price, { type: discount.type, value: discountValue }, { taxable: tax.taxable, rate: toScaled(tax.rate)!, included: tax.included }, currency);
      return {
        gross: fromScaled(amounts.gross),
        discountAmount: fromScaled(amounts.discountAmount),
        subtotal: fromScaled(amounts.subtotal),
        taxAmount: fromScaled(amounts.taxAmount),
        total: fromScaled(amounts.total),
      };
    } catch (error) {
      if (error instanceof RangeError && error.message === 'DISCOUNT_EXCEEDS_LINE') {
        throw badRequest('PRODUCT_ROW_INVALID', 'The discount cannot exceed the line amount.', { field: 'discount' });
      }
      throw error;
    }
  }

  total(rows: Array<{ subtotal: string; taxAmount: string; total: string }>) {
    return {
      subtotal: fromScaled(sumScaled(rows.map((row) => toScaled(row.subtotal)!))),
      taxTotal: fromScaled(sumScaled(rows.map((row) => toScaled(row.taxAmount)!))),
      total: fromScaled(sumScaled(rows.map((row) => toScaled(row.total)!))),
    };
  }
}

export class ProductRowService {
  private readonly owners = new Map<string, ProductRowOwnerAdapter>();
  readonly values = new CommercialValueService();

  constructor(
    private readonly support: CatalogSupport,
    private readonly products: ProductService,
    private readonly prices: ProductPriceService,
  ) {}

  registerOwner(adapter: ProductRowOwnerAdapter) {
    this.owners.set(adapter.ownerType, adapter);
    return this;
  }

  ownerTypes() {
    return [...this.owners.keys()];
  }

  private get state() {
    return this.support.state;
  }

  private owner(ownerTypeRaw: string) {
    const ownerType = ownerTypeRaw.toUpperCase().replace(/S$/, '');
    const adapter = this.owners.get(ownerType);
    if (!adapter) throw badRequest('PRODUCT_ROW_OWNER_UNSUPPORTED', `${ownerTypeRaw} does not support product rows.`);
    return adapter;
  }

  private rowsOf(workspaceId: string, ownerType: string, ownerId: string) {
    return this.state.commercialProductRows
      .filter((row) => row.workspaceId === workspaceId && row.ownerType === ownerType && row.ownerId === ownerId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  private rowSet(workspaceId: string, ownerType: string, ownerId: string) {
    return this.state.commercialRowSets.find((row) => row.workspaceId === workspaceId && row.ownerType === ownerType && row.ownerId === ownerId);
  }

  capabilities(actor: ActorContext) {
    return {
      canManage: this.support.hasAny(actor, P.rowManage),
      canEditPrice: this.support.hasAny(actor, P.rowEditPrice),
      canEditDiscount: this.support.hasAny(actor, P.rowEditDiscount),
      canEditTax: this.support.hasAny(actor, P.rowEditTax),
    };
  }

  rowDto(row: CommercialProductRow) {
    // Everything shown comes from the row's own snapshot - never from the current Product master.
    return {
      id: row.id,
      productId: row.productId,
      parentProductId: row.parentProductId,
      isManual: row.isManual,
      name: row.nameSnapshot,
      sku: row.skuSnapshot,
      variantLabel: row.variantSnapshot,
      unitId: row.unitId,
      unitCode: row.unitCodeSnapshot,
      unitName: row.unitNameSnapshot,
      unitRatio: row.unitRatioSnapshot,
      baseUnitCode: row.baseUnitCodeSnapshot,
      quantity: row.quantity,
      priceTypeId: row.priceTypeId,
      priceTypeCode: row.priceTypeCodeSnapshot,
      unitPrice: row.unitPrice,
      currency: row.currency,
      discount: { type: row.discountType, value: row.discountValue, amount: row.discountAmount },
      tax: { taxable: row.taxable, rate: row.taxRate, included: row.taxIncluded, code: row.taxCodeSnapshot },
      subtotal: row.subtotal,
      taxAmount: row.taxAmount,
      total: row.total,
      overrides: { price: row.priceOverridden, discount: row.discountOverridden, tax: row.taxOverridden },
      sortOrder: row.sortOrder,
      version: row.version,
    };
  }

  private view(workspaceId: string, ownerType: string, ownerId: string, actor: ActorContext) {
    const set = this.rowSet(workspaceId, ownerType, ownerId);
    const rows = this.rowsOf(workspaceId, ownerType, ownerId);
    return {
      ownerType,
      ownerId,
      version: set?.version ?? 0,
      currency: set?.currency ?? null,
      totals: set ? { subtotal: set.subtotal, taxTotal: set.taxTotal, total: set.total } : { subtotal: '0', taxTotal: '0', total: '0' },
      rows: rows.map((row) => this.rowDto(row)),
      capabilities: this.capabilities(actor),
    };
  }

  // ---- read ---------------------------------------------------------------------------------------------------------------

  list(user: User, workspaceId: string, ownerTypeRaw: string, ownerId: string) {
    const actor = this.support.actor(user, workspaceId);
    const adapter = this.owner(ownerTypeRaw);
    // A missing, foreign or unreadable owner is indistinguishable, so rows never leak through this API.
    if (!adapter.load(workspaceId, ownerId) || !adapter.canRead(actor, ownerId)) throw new AppError('PRODUCT_ROW_OWNER_NOT_FOUND', 'The record was not found.', 404);
    return this.view(workspaceId, adapter.ownerType, ownerId, actor);
  }

  // ---- replace ------------------------------------------------------------------------------------------------------------

  replace(user: User, workspaceId: string, ownerTypeRaw: string, ownerId: string, input: Json, headerKey?: string) {
    const actor = this.support.actor(user, workspaceId);
    const adapter = this.owner(ownerTypeRaw);
    const owner = adapter.load(workspaceId, ownerId);
    if (!owner || !adapter.canRead(actor, ownerId)) throw new AppError('PRODUCT_ROW_OWNER_NOT_FOUND', 'The record was not found.', 404);
    if (!adapter.canUpdate(actor, ownerId)) throw forbidden('You cannot edit this record.');
    this.support.requireAny(actor, P.rowManage);
    assertOnlyKeys(input, ['rows', 'expectedVersion', 'syncOwnerAmount', 'idempotencyKey'], 'product rows');
    const key = this.support.validateKey(input.idempotencyKey ?? headerKey);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const operation = `catalog.product-rows.put:${adapter.ownerType}:${ownerId}`;
      const replay = this.support.recall(actor, operation, key, input);
      if (replay) return this.view(workspaceId, adapter.ownerType, ownerId, actor);

      const existingSet = this.rowSet(workspaceId, adapter.ownerType, ownerId);
      const currentVersion = existingSet?.version ?? 0;
      if (input.expectedVersion !== undefined || existingSet) {
        if (typeof input.expectedVersion !== 'number' || !Number.isInteger(input.expectedVersion)) {
          throw badRequest('CATALOG_VERSION_REQUIRED', 'expectedVersion (the current row-set version) is required.', { field: 'expectedVersion' });
        }
        if (input.expectedVersion !== currentVersion) throw conflict('CATALOG_VERSION_CONFLICT', 'The product rows changed after you loaded them.', { currentVersion });
      }
      if (!Array.isArray(input.rows)) throw badRequest('PRODUCT_ROW_INVALID', 'rows must be an array.', { field: 'rows' });
      if (input.rows.length > MAX_ROWS) throw badRequest('PRODUCT_ROW_INVALID', `At most ${MAX_ROWS} rows are allowed.`, { field: 'rows' });

      const existingRows = this.rowsOf(workspaceId, adapter.ownerType, ownerId);
      const settings = this.support.settings(workspaceId);
      const seenIds = new Set<string>();
      const overridesUsed: Overrides = { price: false, discount: false, tax: false };
      const now = new Date();
      const built: CommercialProductRow[] = [];

      (input.rows as unknown[]).forEach((raw, index) => {
        if (!isPlainObject(raw)) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}] must be an object.`, { field: `rows[${index}]` });
        const unknownKeys = Object.keys(raw).filter((key) => !ROW_INPUT_KEYS.includes(key) && !ROW_ECHO_KEYS.includes(key));
        if (unknownKeys.length > 0) throw badRequest('PRODUCT_ROW_FIELD_NOT_ALLOWED', `rows[${index}] has unsupported keys: ${unknownKeys.join(', ')}.`, { fields: unknownKeys });
        let existing: CommercialProductRow | undefined;
        if (raw.id !== undefined) {
          existing = existingRows.find((row) => row.id === raw.id);
          if (!existing) throw new AppError('PRODUCT_ROW_NOT_FOUND', 'A product row was not found on this record.', 404, { rowId: raw.id });
          if (seenIds.has(existing.id)) throw badRequest('PRODUCT_ROW_INVALID', 'A row can only appear once.', { rowId: existing.id });
          seenIds.add(existing.id);
        }
        const result = existing ? this.updateExisting(actor, existing, raw, index, owner.currencyCode) : this.buildNew(actor, workspaceId, adapter.ownerType, ownerId, raw, index, owner.currencyCode, settings.basePriceTypeId, now);
        overridesUsed.price ||= result.overrides.price;
        overridesUsed.discount ||= result.overrides.discount;
        overridesUsed.tax ||= result.overrides.tax;
        built.push(result.row);
      });

      // Server-side override enforcement: the flags come from comparing values with resolved defaults, never from the client.
      const denied: string[] = [];
      const caps = this.capabilities(actor);
      if (overridesUsed.price && !caps.canEditPrice) denied.push('price');
      if (overridesUsed.discount && !caps.canEditDiscount) denied.push('discount');
      if (overridesUsed.tax && !caps.canEditTax) denied.push('tax');
      if (denied.length > 0) {
        throw new AppError('PRODUCT_ROW_OVERRIDE_FORBIDDEN', `You are not allowed to override: ${denied.join(', ')}.`, 403, { overrides: denied });
      }

      const currencies = new Set(built.map((row) => row.currency));
      if (currencies.size > 1) throw badRequest('PRODUCT_ROW_CURRENCY_MISMATCH', 'All rows of one record must use the same currency.', { currencies: [...currencies] });
      const currency = built.length > 0 ? built[0].currency : null;

      built.forEach((row, index) => {
        row.sortOrder = typeof (input.rows as Json[])[index]?.sortOrder === 'number' ? ((input.rows as Json[])[index].sortOrder as number) : index;
      });
      const keepIds = new Set(built.map((row) => row.id));
      const removed = existingRows.filter((row) => !keepIds.has(row.id));
      this.state.commercialProductRows = [
        ...this.state.commercialProductRows.filter((row) => !(row.workspaceId === workspaceId && row.ownerType === adapter.ownerType && row.ownerId === ownerId)),
        ...built,
      ];

      const totals = this.values.total(built);
      let set = existingSet;
      if (!set) {
        set = { id: this.support.store.id(), workspaceId, ownerType: adapter.ownerType, ownerId, version: 0, currency: null, subtotal: '0', taxTotal: '0', total: '0', updatedByUserId: null, updatedAt: now };
        this.state.commercialRowSets.push(set);
      }
      set.version += 1;
      set.currency = currency;
      set.subtotal = totals.subtotal;
      set.taxTotal = totals.taxTotal;
      set.total = totals.total;
      set.updatedByUserId = actor.user.id;
      set.updatedAt = now;

      if (currency && input.syncOwnerAmount !== false && adapter.applyTotals) adapter.applyTotals(user, workspaceId, ownerId, { currency, total: totals.total });

      const overrideRows = built.filter((row) => row.priceOverridden || row.discountOverridden || row.taxOverridden);
      if (overrideRows.length > 0) {
        this.support.audit(actor, 'PRODUCT_ROW.OVERRIDE', 'CommercialProductRow', ownerId, null, {
          ownerType: adapter.ownerType,
          rows: overrideRows.map((row) => ({ rowId: row.id, price: row.priceOverridden, discount: row.discountOverridden, tax: row.taxOverridden })),
        });
      }
      this.support.audit(actor, 'PRODUCT_ROW.REPLACED', 'CommercialProductRow', ownerId, { rows: existingRows.length }, { rows: built.length, removed: removed.length, total: totals.total, currency });
      this.support.emit(workspaceId, actor.user.id, 'PRODUCT_ROW_CHANGED', adapter.ownerType, ownerId, { rowCount: built.length, version: set.version });
      this.support.remember(actor, operation, key, input, { version: set.version });
      return this.view(workspaceId, adapter.ownerType, ownerId, actor);
    });
  }

  // ---- row construction ------------------------------------------------------------------------------------------------------

  private readQuantity(value: unknown, index: number, unit: CatalogUnit | null): string {
    const scaled = typeof value === 'string' || typeof value === 'number' ? toScaled(value) : null;
    if (scaled === null || scaled <= 0n) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].quantity must be a positive decimal.`, { field: `rows[${index}].quantity` });
    const canonical = canonicalDecimal(value)!;
    if (unit) {
      const fraction = canonical.split('.')[1] ?? '';
      if (fraction.length > unit.precision) {
        throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].quantity allows at most ${unit.precision} decimals for ${unit.code}.`, { field: `rows[${index}].quantity` });
      }
    }
    return canonical;
  }

  private readDiscount(value: unknown, index: number): Discount | null {
    if (value === undefined) return null;
    if (value === null) return { type: 'NONE', value: '0' };
    if (!isPlainObject(value)) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].discount must be an object.`, { field: `rows[${index}].discount` });
    assertOnlyKeys(value, ['type', 'value', 'amount'], `rows[${index}].discount`);
    if (value.type !== 'NONE' && value.type !== 'PERCENT' && value.type !== 'AMOUNT') throw badRequest('PRODUCT_ROW_INVALID', 'discount.type must be NONE, PERCENT or AMOUNT.', { field: `rows[${index}].discount.type` });
    if (value.type === 'NONE') return { type: 'NONE', value: '0' };
    const scaled = typeof value.value === 'string' || typeof value.value === 'number' ? toScaled(value.value) : null;
    if (scaled === null || scaled < 0n) throw badRequest('PRODUCT_ROW_INVALID', 'discount.value must be a non-negative decimal.', { field: `rows[${index}].discount.value` });
    if (value.type === 'PERCENT' && scaled > 100n * 10n ** 8n) throw badRequest('PRODUCT_ROW_INVALID', 'A percent discount cannot exceed 100.', { field: `rows[${index}].discount.value` });
    return { type: value.type, value: canonicalDecimal(value.value)! };
  }

  private readTax(value: unknown, index: number): Tax | null {
    if (value === undefined) return null;
    if (!isPlainObject(value)) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].tax must be an object.`, { field: `rows[${index}].tax` });
    assertOnlyKeys(value, ['taxable', 'rate', 'included', 'code', 'amount'], `rows[${index}].tax`);
    const taxable = value.taxable === true;
    const rateRaw = value.rate ?? '0';
    const scaled = typeof rateRaw === 'string' || typeof rateRaw === 'number' ? toScaled(rateRaw) : null;
    const rate = canonicalDecimal(rateRaw, 4);
    if (scaled === null || rate === null || scaled < 0n || scaled > 100n * 10n ** 8n) throw badRequest('PRODUCT_ROW_INVALID', 'tax.rate must be a decimal between 0 and 100 (max 4 fraction digits).', { field: `rows[${index}].tax.rate` });
    if (taxable && value.rate === undefined) throw badRequest('PRODUCT_ROW_INVALID', 'A taxable row needs a tax.rate.', { field: `rows[${index}].tax.rate` });
    return { taxable, rate: taxable ? rate : '0', included: taxable && value.included === true };
  }

  private readMoney(value: unknown, field: string): string {
    const scaled = typeof value === 'string' || typeof value === 'number' ? toScaled(value) : null;
    if (scaled === null || scaled < 0n) throw badRequest('PRODUCT_ROW_INVALID', `${field} must be a non-negative decimal with at most 8 fraction digits.`, { field });
    return canonicalDecimal(value)!;
  }

  private readCurrency(value: unknown, field: string): string {
    const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!isValidCurrency(currency)) throw badRequest('PRODUCT_ROW_INVALID', `${field} must be a valid ISO 4217 currency code.`, { field });
    return currency;
  }

  private sameTax(a: Tax, b: Tax) {
    return a.taxable === b.taxable && (!a.taxable || (a.rate === b.rate && a.included === b.included));
  }

  private buildNew(
    actor: ActorContext,
    workspaceId: string,
    ownerType: string,
    ownerId: string,
    raw: Json,
    index: number,
    ownerCurrency: string | null,
    basePriceTypeId: string | null,
    now: Date,
  ): { row: CommercialProductRow; overrides: Overrides } {
    const isManual = raw.productId === undefined || raw.productId === null;
    const overrides: Overrides = { price: false, discount: false, tax: false };
    const discountInput = this.readDiscount(raw.discount, index);
    const taxInput = this.readTax(raw.tax, index);

    let name: string;
    let sku: string | null = null;
    let productId: string | null = null;
    let parentProductId: string | null = null;
    let variantLabel: string | null = null;
    let unit: CatalogUnit | null = null;
    let unitNameOverride: string | null = null;
    let ratio: string | null = null;
    let baseUnitCode: string | null = null;
    let priceTypeId: string | null = null;
    let priceTypeCode: string | null = null;
    let unitPrice: string;
    let currency: string;
    let defaultTax: Tax = { taxable: false, rate: '0', included: false };
    let taxCode: string | null = null;

    if (isManual) {
      name = requiredText(raw.name, `rows[${index}].name`, 300);
      if (raw.unitPrice === undefined) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].unitPrice is required for a manual row.`, { field: `rows[${index}].unitPrice` });
      unitPrice = this.readMoney(raw.unitPrice, `rows[${index}].unitPrice`);
      currency = raw.currency !== undefined ? this.readCurrency(raw.currency, `rows[${index}].currency`) : ownerCurrency && isValidCurrency(ownerCurrency) ? ownerCurrency : '';
      if (!currency) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].currency is required for a manual row.`, { field: `rows[${index}].currency` });
      if (raw.unitId !== undefined && raw.unitId !== null) unit = this.support.unit(workspaceId, raw.unitId);
      else if (typeof raw.unitName === 'string' && raw.unitName.trim()) unitNameOverride = raw.unitName.trim().slice(0, 60);
      // A manually typed price is by definition a commercial override.
      overrides.price = true;
    } else {
      const productRef = String(raw.productId);
      const sellable = this.products.sellable(workspaceId, productRef, { allowArchived: true });
      // A Product from another workspace is reported exactly like a missing one.
      if (!sellable) throw new AppError('PRODUCT_NOT_FOUND', 'Product was not found.', 404, { productId: productRef });
      const offerable = this.products.sellable(workspaceId, productRef);
      if (!offerable) throw conflict('PRODUCT_ARCHIVED', 'Archived or inactive items cannot be added to a record.', { productId: productRef });
      productId = sellable.product.id;
      parentProductId = sellable.parent?.id ?? null;
      name = sellable.name;
      sku = sellable.product.sku;
      variantLabel = sellable.variantLabel;
      defaultTax = { taxable: sellable.tax.taxable, rate: sellable.tax.rate ?? '0', included: sellable.tax.included };
      taxCode = sellable.tax.code;
      const primary = sellable.unit;
      const resolved = this.resolveUnit(workspaceId, sellable, primary, raw.unitId, index);
      unit = resolved.unit;
      ratio = resolved.ratio;
      baseUnitCode = resolved.baseUnitCode;

      const requestedType = raw.priceTypeId !== undefined && raw.priceTypeId !== null ? this.support.priceType(workspaceId, raw.priceTypeId) : null;
      if (requestedType && !requestedType.isActive) throw conflict('PRICE_TYPE_INACTIVE', 'An inactive price type cannot be selected.', { priceTypeId: requestedType.id });
      const type = requestedType ?? (basePriceTypeId ? this.state.catalogPriceTypes.find((item) => item.id === basePriceTypeId) ?? null : null);
      // Choosing another Price Type than the base is a pricing decision and needs the price capability.
      if (requestedType && requestedType.id !== basePriceTypeId) overrides.price = true;
      const requestedCurrency = raw.currency !== undefined ? this.readCurrency(raw.currency, `rows[${index}].currency`) : null;
      const preferred = requestedCurrency ?? (ownerCurrency && isValidCurrency(ownerCurrency) ? ownerCurrency : null);
      const price = type ? this.prices.resolve(sellable.product, sellable.parent, type.id, preferred) : null;
      priceTypeId = type?.id ?? null;
      priceTypeCode = type?.code ?? null;
      let defaultPrice: string | null = null;
      let defaultCurrency: string | null = null;
      if (price && (!requestedCurrency || price.currency === requestedCurrency)) {
        defaultCurrency = price.currency;
        // Prices are per primary unit; an alternate unit multiplies by its ratio (rounded half-up at the storage scale).
        defaultPrice = ratio ? fromScaled(mulDivRound(toScaled(price.amount)!, toScaled(ratio)!, 10n ** 8n, 8)) : price.amount;
      }
      currency = requestedCurrency ?? defaultCurrency ?? (ownerCurrency && isValidCurrency(ownerCurrency) ? ownerCurrency : '');
      if (raw.unitPrice !== undefined) {
        unitPrice = this.readMoney(raw.unitPrice, `rows[${index}].unitPrice`);
        if (!defaultPrice || toScaled(unitPrice) !== toScaled(defaultPrice)) overrides.price = true;
        if (!currency) throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].currency is required.`, { field: `rows[${index}].currency` });
      } else {
        if (!defaultPrice || !defaultCurrency) {
          throw new AppError('PRODUCT_PRICE_INVALID', 'The item has no price for the selected price type and currency. Enter a price manually if you are allowed to.', 409, { productId, priceTypeId, currency: currency || null });
        }
        unitPrice = defaultPrice;
        currency = defaultCurrency;
      }
    }

    const discount = discountInput ?? { type: 'NONE' as DiscountType, value: '0' };
    if (discount.type !== 'NONE' && discount.value !== '0') overrides.discount = true;
    const tax = taxInput ?? defaultTax;
    if (taxInput && !this.sameTax(taxInput, defaultTax)) overrides.tax = true;

    const quantity = this.readQuantity(raw.quantity, index, unit);
    const amounts = this.values.calculate(quantity, unitPrice, discount, tax, currency);
    const row: CommercialProductRow = {
      id: this.support.store.id(),
      workspaceId,
      ownerType,
      ownerId,
      productId,
      parentProductId,
      isManual,
      nameSnapshot: name,
      skuSnapshot: sku,
      variantSnapshot: variantLabel,
      unitId: unit?.id ?? null,
      unitCodeSnapshot: unit?.code ?? null,
      unitNameSnapshot: unit?.name ?? unitNameOverride,
      unitRatioSnapshot: ratio,
      baseUnitCodeSnapshot: baseUnitCode,
      quantity,
      priceTypeId,
      priceTypeCodeSnapshot: priceTypeCode,
      unitPrice,
      currency,
      discountType: discount.type,
      discountValue: discount.value,
      discountAmount: amounts.discountAmount,
      taxable: tax.taxable,
      taxRate: tax.rate,
      taxIncluded: tax.included,
      taxCodeSnapshot: taxCode,
      subtotal: amounts.subtotal,
      taxAmount: amounts.taxAmount,
      total: amounts.total,
      priceOverridden: overrides.price,
      discountOverridden: overrides.discount,
      taxOverridden: overrides.tax,
      sortOrder: index,
      version: 1,
      createdByUserId: actor.user.id,
      createdAt: now,
      updatedAt: now,
    };
    return { row, overrides };
  }

  private resolveUnit(workspaceId: string, sellable: SellableView, primary: CatalogUnit | null, requestedUnitId: unknown, index: number) {
    if (requestedUnitId === undefined || requestedUnitId === null || (primary && requestedUnitId === primary.id)) {
      return { unit: primary, ratio: null as string | null, baseUnitCode: null as string | null };
    }
    const unit = this.support.unit(workspaceId, requestedUnitId);
    const ratio = sellable.ratios.find((item) => item.unitId === unit.id);
    if (!ratio) throw badRequest('UNIT_RATIO_INVALID', `rows[${index}].unitId has no ratio defined for this item.`, { field: `rows[${index}].unitId` });
    const base = this.state.catalogUnits.find((item) => item.id === ratio.baseUnitId);
    return { unit, ratio: ratio.ratio, baseUnitCode: base?.code ?? null };
  }

  /**
   * Existing rows keep their snapshot. Only fields the client actually CHANGED are treated as edits, and each privileged
   * change (price, discount, tax) is detected here and enforced by the caller - echoing a row back unchanged needs no override.
   */
  private updateExisting(actor: ActorContext, existing: CommercialProductRow, raw: Json, index: number, ownerCurrency: string | null): { row: CommercialProductRow; overrides: Overrides } {
    void ownerCurrency;
    const overrides: Overrides = { price: false, discount: false, tax: false };
    if (raw.productId !== undefined && raw.productId !== existing.productId) {
      throw badRequest('PRODUCT_ROW_INVALID', `rows[${index}].productId cannot change; remove the row and add another.`, { field: `rows[${index}].productId` });
    }
    const row: CommercialProductRow = { ...existing };
    if (raw.name !== undefined) {
      const name = requiredText(raw.name, `rows[${index}].name`, 300);
      if (name !== row.nameSnapshot) {
        row.nameSnapshot = name;
      }
    }
    if (raw.unitId !== undefined && raw.unitId !== row.unitId) {
      if (!row.isManual) throw badRequest('PRODUCT_ROW_UNIT_LOCKED', `rows[${index}].unitId cannot change on a catalog row; remove it and add it again with the other unit.`, { field: `rows[${index}].unitId` });
      const unit = raw.unitId === null ? null : this.support.unit(existing.workspaceId, raw.unitId);
      row.unitId = unit?.id ?? null;
      row.unitCodeSnapshot = unit?.code ?? null;
      row.unitNameSnapshot = unit?.name ?? null;
    }
    if (raw.currency !== undefined) {
      const currency = this.readCurrency(raw.currency, `rows[${index}].currency`);
      if (currency !== row.currency) {
        row.currency = currency;
        overrides.price = true;
      }
    }
    if (raw.priceTypeId !== undefined && raw.priceTypeId !== row.priceTypeId) {
      if (row.isManual) throw badRequest('PRODUCT_ROW_INVALID', 'A manual row has no price type.', { field: `rows[${index}].priceTypeId` });
      const type = raw.priceTypeId === null ? null : this.support.priceType(existing.workspaceId, raw.priceTypeId);
      if (type && !type.isActive) throw conflict('PRICE_TYPE_INACTIVE', 'An inactive price type cannot be selected.', { priceTypeId: type.id });
      row.priceTypeId = type?.id ?? null;
      row.priceTypeCodeSnapshot = type?.code ?? null;
      overrides.price = true;
    }
    if (raw.unitPrice !== undefined) {
      const unitPrice = this.readMoney(raw.unitPrice, `rows[${index}].unitPrice`);
      if (toScaled(unitPrice) !== toScaled(row.unitPrice)) {
        row.unitPrice = unitPrice;
        overrides.price = true;
      }
    }
    const discount = this.readDiscount(raw.discount, index);
    if (discount && (discount.type !== row.discountType || toScaled(discount.value) !== toScaled(row.discountValue))) {
      row.discountType = discount.type;
      row.discountValue = discount.value;
      overrides.discount = true;
    }
    const tax = this.readTax(raw.tax, index);
    if (tax && !this.sameTax(tax, { taxable: row.taxable, rate: row.taxRate, included: row.taxIncluded })) {
      row.taxable = tax.taxable;
      row.taxRate = tax.rate;
      row.taxIncluded = tax.included;
      overrides.tax = true;
    }
    if (raw.quantity !== undefined) {
      const unitForPrecision = row.unitId ? this.state.catalogUnits.find((unit) => unit.id === row.unitId) ?? null : null;
      row.quantity = this.readQuantity(raw.quantity, index, unitForPrecision);
    }
    const amounts = this.values.calculate(row.quantity, row.unitPrice, { type: row.discountType, value: row.discountValue }, { taxable: row.taxable, rate: row.taxRate, included: row.taxIncluded }, row.currency);
    row.discountAmount = amounts.discountAmount;
    row.subtotal = amounts.subtotal;
    row.taxAmount = amounts.taxAmount;
    row.total = amounts.total;
    row.priceOverridden = existing.priceOverridden || overrides.price;
    row.discountOverridden = existing.discountOverridden || overrides.discount;
    row.taxOverridden = existing.taxOverridden || overrides.tax;
    const changed = JSON.stringify({ ...row, version: 0, updatedAt: 0, sortOrder: 0 }) !== JSON.stringify({ ...existing, version: 0, updatedAt: 0, sortOrder: 0 });
    if (changed) {
      row.version = existing.version + 1;
      row.updatedAt = new Date();
    }
    void actor;
    return { row, overrides };
  }
}

