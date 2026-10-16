import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../errors';
import { decimal, name as nameDto, parse, uuid } from '../../process-platform/dto';
import { evidence, lock, resolvePrincipal, type Principal } from '../../process-platform/context';
import { commerceCurrency, slug } from '../dto';
import { CommerceStoreService } from '../store-service';
import { CommerceCartService } from '../cart-service';
import { commerceCatalogPort } from '../catalog-port';
import { calculateRow, fromScaled, toScaled } from '../../catalog/money';
import { assertVersion, expectedVersion } from '../../suite/kernel';

/** Store listing overrides, store categories and price preview (spec OnlineStore-Commerce/02). Catalog stays the product truth. */
export class CommerceListingService {
  constructor(private readonly db: PrismaClient, readonly stores = new CommerceStoreService(db), readonly carts = new CommerceCartService(db)) {}

  async patch(actor: Principal, listingId: string, raw: unknown) {
    parse(uuid, listingId);
    const input = parse(z.strictObject({ expectedVersion: expectedVersion.optional(), price: z.strictObject({ amount: decimal, currency: commerceCurrency, validFrom: z.iso.datetime({ offset: true }).optional(), validTo: z.iso.datetime({ offset: true }).optional(), priceTypeId: uuid.optional() }).nullable().optional(),
      categoryIds: z.array(uuid).max(50).optional(), sortRank: z.number().int().min(0).max(1000000).optional(), seoOverrides: z.strictObject({ title: z.string().max(160).optional(), description: z.string().max(320).optional() }).optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const publication = await tx.commerceProductPublication.findFirst({ where: { workspaceId: actor.workspaceId, id: listingId } });
      if (!publication) throw new AppError('NOT_FOUND', 'Listing was not found.', 404);
      const store = await this.stores.store(tx, actor, publication.storeId, input.price !== undefined ? 'COMMERCE.PRICE_MANAGE' : 'COMMERCE.CATALOG_PUBLISH');
      if (input.price && input.price.currency !== store.defaultCurrency) throw new AppError('VALIDATION_FAILED', 'Override currency must equal the store currency.', 400, { fields: [{ field: 'price.currency', reason: 'CURRENCY_MISMATCH' }] });
      if (input.categoryIds?.length && await tx.commerceStoreCategory.count({ where: { workspaceId: actor.workspaceId, storeId: store.id, id: { in: input.categoryIds } } }) !== input.categoryIds.length)
        throw new AppError('NOT_FOUND', 'Store category was not found.', 404);
      const current = await tx.commerceListingOverride.findUnique({ where: { workspaceId_publicationId: { workspaceId: actor.workspaceId, publicationId: listingId } } });
      if (current && input.expectedVersion !== undefined) assertVersion(current.version, input.expectedVersion);
      const data = { ...(input.price !== undefined ? { amount: input.price?.amount ?? null, currency: input.price?.currency ?? store.defaultCurrency, priceTypeId: input.price?.priceTypeId ?? null,
          validFrom: input.price?.validFrom ? new Date(input.price.validFrom) : null, validTo: input.price?.validTo ? new Date(input.price.validTo) : null } : {}),
        ...(input.categoryIds ? { categoryIds: input.categoryIds } : {}), ...(input.sortRank !== undefined ? { sortRank: input.sortRank } : {}), ...(input.seoOverrides ? { seoOverrides: input.seoOverrides } : {}) };
      const row = current ? await tx.commerceListingOverride.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 } } })
        : await tx.commerceListingOverride.create({ data: { workspaceId: actor.workspaceId, storeId: store.id, publicationId: listingId, currency: store.defaultCurrency, ...data } });
      if (input.price !== undefined) await evidence(tx, actor, 'COMMERCE_STORE', store.id, 'STORE_PRICE_CHANGED', { listingId, before: current?.amount?.toFixed(6) ?? null, after: row.amount?.toFixed(6) ?? null, currency: row.currency });
      else await evidence(tx, actor, 'COMMERCE_STORE', store.id, 'STORE_LISTING_CHANGED', { listingId, version: row.version });
      return { ...row, amount: row.amount?.toFixed(6) ?? null };
    });
  }

  async pricePreview(actor: Principal, storeId: string, raw: unknown) {
    const query = parse(z.object({ productId: uuid, variantId: uuid.optional(), qty: decimal.default('1') }), raw);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const store = await this.stores.store(tx, actor, storeId, 'COMMERCE.STORE_VIEW');
      (await commerceCatalogPort(tx, actor.workspaceId, actor)).identity(store.catalogId, query.productId, query.variantId ?? null);
      const product = await this.carts.product(tx, store, query.productId, query.variantId ?? null);
      const amounts = calculateRow(toScaled(query.qty)!, toScaled(product.unitPrice)!, { type: 'NONE', value: 0n }, { taxable: product.tax.taxable, rate: toScaled(product.tax.rate ?? '0')!, included: product.tax.included }, store.defaultCurrency);
      const source = 'override' in product.revision ? 'STORE_OVERRIDE' : 'CATALOG_PRICE_TYPE';
      return { storeId, productId: query.productId, variantId: query.variantId ?? null, quantity: query.qty, currency: store.defaultCurrency, unitPrice: product.unitPrice, priceSource: source,
        subtotal: fromScaled(amounts.subtotal), tax: fromScaled(amounts.taxAmount), total: fromScaled(amounts.total), note: 'Preview only; checkout recalculates promotions, store tax rules and delivery.' };
    }, { timeout: 60000 });
  }

  async categories(actor: Principal, storeId: string, raw?: unknown) {
    if (raw === undefined) return this.db.$transaction(async tx => { await this.stores.store(tx, actor, storeId, 'COMMERCE.STORE_VIEW'); return tx.commerceStoreCategory.findMany({ where: { workspaceId: actor.workspaceId, storeId }, orderBy: [{ sortRank: 'asc' }, { slug: 'asc' }] }); });
    const input = parse(z.strictObject({ name: nameDto, slug, parentId: uuid.optional(), sourceCatalogCategoryId: uuid.optional(), sortRank: z.number().int().min(0).default(0) }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const store = await this.stores.store(tx, actor, storeId, 'COMMERCE.CATALOG_PUBLISH');
      if (input.parentId && !await tx.commerceStoreCategory.findFirst({ where: { workspaceId: actor.workspaceId, storeId, id: input.parentId } })) throw new AppError('NOT_FOUND', 'Parent category was not found.', 404);
      if (input.sourceCatalogCategoryId) (await commerceCatalogPort(tx, actor.workspaceId, actor)).references(store.catalogId, { categoryIds: [input.sourceCatalogCategoryId] });
      const row = await tx.commerceStoreCategory.create({ data: { workspaceId: actor.workspaceId, storeId, ...input } });
      await evidence(tx, actor, 'COMMERCE_STORE', storeId, 'STORE_CATEGORY_CREATED', { categoryId: row.id, slug: row.slug }); return row;
    });
  }
}
