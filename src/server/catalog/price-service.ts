import type { ActorContext } from '../access-service';
import { badRequest, conflict } from '../errors';
import type { CatalogSupport, Json } from './support';
import { isPlainObject } from './support';
import { fromScaled, isValidCurrency, toScaled } from './money';
import type { PriceType, Product, ProductPrice } from './types';

const MAX_PRICES_PER_ITEM = 200;

export type ParsedPrice = { priceTypeId: string; currency: string; amount: string };

/**
 * Current Product prices: one row per (item, Price Type, currency), precise decimals, explicit currency. Catalog keeps
 * the current state plus Audit history; historical transaction values live in commercial row snapshots, so a price
 * change never touches an existing row.
 */
export class ProductPriceService {
  constructor(private readonly support: CatalogSupport) {}

  private get state() {
    return this.support.state;
  }

  rowsOf(productId: string): ProductPrice[] {
    return this.state.catalogPrices.filter((row) => row.productId === productId);
  }

  /** Effective prices: a Variant that overrides `prices` uses its own set, otherwise the parent's. */
  effectiveRows(product: Product, parent: Product | undefined): { rows: ProductPrice[]; inherited: boolean } {
    if (product.type === 'VARIANT' && parent && !product.overrides.includes('prices')) return { rows: this.rowsOf(parent.id), inherited: true };
    return { rows: this.rowsOf(product.id), inherited: false };
  }

  toDto(row: ProductPrice, types: Map<string, PriceType>, baseId: string | null) {
    const type = types.get(row.priceTypeId);
    return {
      id: row.id,
      priceTypeId: row.priceTypeId,
      priceTypeCode: type?.code ?? null,
      isBase: row.priceTypeId === baseId,
      amount: row.amount,
      currency: row.currency,
      version: row.version,
    };
  }

  priceTypeMap(workspaceId: string) {
    return new Map(this.state.catalogPriceTypes.filter((type) => type.workspaceId === workspaceId).map((type) => [type.id, type]));
  }

  parse(workspaceId: string, input: unknown): ParsedPrice[] {
    if (!Array.isArray(input)) throw badRequest('PRODUCT_PRICE_INVALID', 'prices must be an array.', { field: 'prices' });
    if (input.length > MAX_PRICES_PER_ITEM) throw badRequest('PRODUCT_PRICE_INVALID', `At most ${MAX_PRICES_PER_ITEM} prices are allowed per item.`, { field: 'prices' });
    const seen = new Set<string>();
    return input.map((entry, index) => {
      if (!isPlainObject(entry)) throw badRequest('PRODUCT_PRICE_INVALID', `prices[${index}] must be an object.`, { field: `prices[${index}]` });
      const extra = Object.keys(entry).filter((key) => !['priceTypeId', 'currency', 'amount', 'id', 'version'].includes(key));
      if (extra.length > 0) throw badRequest('PRODUCT_PRICE_INVALID', `prices[${index}] has unsupported keys: ${extra.join(', ')}.`, { field: `prices[${index}]` });
      // A Price Type from another workspace is reported exactly like a missing one.
      const type = this.support.priceType(workspaceId, entry.priceTypeId);
      if (!type.isActive) throw conflict('PRICE_TYPE_INACTIVE', 'An inactive price type cannot receive new prices.', { priceTypeId: type.id });
      const currency = typeof entry.currency === 'string' ? entry.currency.trim().toUpperCase() : '';
      if (!isValidCurrency(currency)) throw badRequest('PRODUCT_PRICE_INVALID', `prices[${index}].currency must be a valid ISO 4217 code.`, { field: `prices[${index}].currency` });
      const scaled = typeof entry.amount === 'string' || typeof entry.amount === 'number' ? toScaled(entry.amount) : null;
      if (scaled === null || scaled < 0n) throw badRequest('PRODUCT_PRICE_INVALID', `prices[${index}].amount must be a non-negative decimal with at most 8 fraction digits.`, { field: `prices[${index}].amount` });
      const key = `${type.id}:${currency}`;
      if (seen.has(key)) throw badRequest('PRODUCT_PRICE_INVALID', 'Only one current price is allowed per item, price type and currency.', { priceTypeId: type.id, currency });
      seen.add(key);
      return { priceTypeId: type.id, currency, amount: fromScaled(scaled) };
    });
  }

  /**
   * Replaces the item's current price set (keyed by price type + currency). Existing rows are updated in place so their ids and
   * audit trail persist; keys missing from the request are removed. Returns what changed for audit/events.
   */
  replace(actor: ActorContext, product: Product, parsed: ParsedPrice[]) {
    const existing = this.rowsOf(product.id);
    const byKey = new Map(existing.map((row) => [`${row.priceTypeId}:${row.currency}`, row]));
    const changes: Array<{ priceTypeId: string; currency: string; before: string | null; after: string | null }> = [];
    const keep = new Set<string>();
    const now = new Date();
    for (const price of parsed) {
      const key = `${price.priceTypeId}:${price.currency}`;
      keep.add(key);
      const row = byKey.get(key);
      if (row) {
        if (row.amount !== price.amount) {
          changes.push({ priceTypeId: price.priceTypeId, currency: price.currency, before: row.amount, after: price.amount });
          row.amount = price.amount;
          row.version += 1;
          row.updatedAt = now;
        }
      } else {
        changes.push({ priceTypeId: price.priceTypeId, currency: price.currency, before: null, after: price.amount });
        this.state.catalogPrices.push({
          id: this.support.store.id(),
          workspaceId: actor.workspaceId,
          productId: product.id,
          priceTypeId: price.priceTypeId,
          amount: price.amount,
          currency: price.currency,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    for (const row of existing) {
      if (keep.has(`${row.priceTypeId}:${row.currency}`)) continue;
      changes.push({ priceTypeId: row.priceTypeId, currency: row.currency, before: row.amount, after: null });
    }
    this.state.catalogPrices = this.state.catalogPrices.filter((row) => row.productId !== product.id || keep.has(`${row.priceTypeId}:${row.currency}`));
    return changes;
  }

  /** Resolves the price a new commercial row should start from: the requested type (default: base), preferred currency first. */
  resolve(product: Product, parent: Product | undefined, priceTypeId: string, preferredCurrency: string | null): ProductPrice | null {
    const { rows } = this.effectiveRows(product, parent);
    const candidates = rows.filter((row) => row.priceTypeId === priceTypeId);
    if (candidates.length === 0) return null;
    if (preferredCurrency) {
      const match = candidates.find((row) => row.currency === preferredCurrency);
      if (match) return match;
    }
    return [...candidates].sort((a, b) => a.currency.localeCompare(b.currency))[0];
  }

  list(product: Product, parent: Product | undefined, workspaceId: string) {
    const settings = this.support.settings(workspaceId);
    const types = this.priceTypeMap(workspaceId);
    const { rows, inherited } = this.effectiveRows(product, parent);
    return {
      inherited,
      basePriceTypeId: settings.basePriceTypeId,
      prices: rows
        .map((row) => this.toDto(row, types, settings.basePriceTypeId))
        .sort((a, b) => (a.isBase === b.isBase ? String(a.priceTypeCode).localeCompare(String(b.priceTypeCode)) || a.currency.localeCompare(b.currency) : a.isBase ? -1 : 1)),
    };
  }
}

export type { Json };
