import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid,pageQuery } from '../process-platform/dto';
import { checkRateLimit } from '../rate-limit';
import { CommerceStoreService } from './store-service';
import { commerceCatalogPort } from './catalog-port';
import { commerceVersion,assertCommerceVersion,slug } from './dto';
import { InventoryStockService } from '../inventory/stock-service';

export class CommercePublicationService {
  constructor(private readonly db: PrismaClient,readonly stores = new CommerceStoreService(db),readonly inventory = new InventoryStockService(db)) {}
  async list(actor: Principal,id: string,raw: unknown) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.stores.store(tx,actor,id,'COMMERCE.CATALOG_PUBLISH');
      const where = { workspaceId: actor.workspaceId,storeId: id };
      const [data,total] = await Promise.all([tx.commerceProductPublication.findMany({ where,orderBy: [{ seoSlug: 'asc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.commerceProductPublication.count({ where })]);
      return { data,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async upsert(actor: Principal,id: string,productId: string,raw: unknown) {
    parse(uuid,productId); requirePermission(actor,'COMMERCE.CATALOG_PUBLISH');
    const input = parse(z.strictObject({ variantId: uuid.optional(),published: z.boolean(),seoSlug: slug,
      availabilityWindow: z.strictObject({ from: z.iso.datetime({ offset: true }).nullable().optional(),until: z.iso.datetime({ offset: true }).nullable().optional() }).optional(),
      expectedVersion: z.union([commerceVersion,z.literal('0')]).optional() }),raw);
    if (input.availabilityWindow?.from && input.availabilityWindow.until && new Date(input.availabilityWindow.from)>=new Date(input.availabilityWindow.until))
      throw new AppError('COMMERCE_PUBLICATION_INVALID','Publication window must end after it starts.',422);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); await lock(tx,actor.workspaceId,'commerce:store:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const store = await this.stores.store(tx,actor,id,'COMMERCE.CATALOG_PUBLISH');
      if (store.status==='ARCHIVED') throw new AppError('COMMERCE_STORE_INVALID_STATUS','Archived Store cannot publish products.',409);
      const catalog = await commerceCatalogPort(tx,actor.workspaceId,actor),identity = catalog.identity(store.catalogId,productId,input.variantId ?? null);
      if (input.published) catalog.product(store.catalogId,productId,input.variantId ?? null,store.priceTypeId,store.defaultCurrency);
      const key = { workspaceId: actor.workspaceId,storeId: id,inventoryKey: identity.inventoryKey };
      const current = await tx.commerceProductPublication.findUnique({ where: { workspaceId_storeId_inventoryKey: key } });
      if (input.expectedVersion!==undefined) assertCommerceVersion(current?.version ?? 0n,input.expectedVersion);
      const data = { published: input.published,seoSlug: input.seoSlug,availableFrom: input.availabilityWindow?.from ? new Date(input.availabilityWindow.from) : null,
        availableUntil: input.availabilityWindow?.until ? new Date(input.availabilityWindow.until) : null };
      const row = await tx.commerceProductPublication.upsert({ where: { workspaceId_storeId_inventoryKey: key },create: { ...key,productId,variantId: input.variantId,createdByUserId: actor.userId,...data },
        update: { ...data,version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_STORE',id,input.published ? 'COMMERCE_PRODUCT_PUBLISHED' : 'COMMERCE_PRODUCT_UNPUBLISHED',{ publicationId: row.id,productId,variantId: row.variantId,seoSlug: row.seoSlug,version: row.version.toString() }); return row;
    },{ timeout: 60000 });
  }
  async publicScope(tx: Tx,storeSlug: string) {
    parse(slug,storeSlug);
    checkRateLimit(storeSlug,{ scope: 'commerce.public-products',limit: 2400,windowMs: 60000 });
    const front = await tx.commerceStorefront.findUnique({ where: { slug: storeSlug } });
    if (!front || front.status!=='PUBLISHED' || !['WEB','HEADLESS'].includes(front.type)) throw new AppError('COMMERCE_STORE_NOT_FOUND','Storefront was not found.',404);
    const store = await tx.commerceStore.findFirst({ where: { workspaceId: front.workspaceId,id: front.storeId,status: 'ACTIVE' } });
    const workspace = store && await tx.workspace.findFirst({ where: { id: store.workspaceId,isDeleted: false } });
    if (!store || !workspace || (workspace.settings as { entitlements?: { commerce?: boolean } }).entitlements?.commerce===false)
      throw new AppError('COMMERCE_STORE_NOT_FOUND','Storefront was not found.',404);
    return { store,front };
  }
  async products(storeSlug: string,raw: unknown,productSlug?: string) {
    const query = parse(pageQuery.extend({ categoryId: uuid.optional() }),raw); if (productSlug) parse(slug,productSlug);
    return this.db.$transaction(async tx => {
      const { store } = await this.publicScope(tx,storeSlug),now = new Date();
      const publications = await tx.commerceProductPublication.findMany({ where: { workspaceId: store.workspaceId,storeId: store.id,published: true,seoSlug: productSlug,
        AND: [{ OR: [{ availableFrom: null },{ availableFrom: { lte: now } }] },{ OR: [{ availableUntil: null },{ availableUntil: { gt: now } }] }] },orderBy: [{ seoSlug: 'asc' },{ id: 'asc' }] });
      const categories = await tx.commerceCategoryPublication.findMany({ where: { workspaceId: store.workspaceId,storeId: store.id,published: true },select: { categoryId: true } });
      if (query.categoryId && !categories.some(row => row.categoryId===query.categoryId)) return { data: [],meta: { page: query.page,limit: query.limit,total: 0,totalPages: 0 } };
      const catalog = await commerceCatalogPort(tx,store.workspaceId),visible = [];
      for (const publication of publications) try {
        const product = catalog.product(store.catalogId,publication.productId,publication.variantId,store.priceTypeId,store.defaultCurrency);
        if (query.search && !product.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()) || query.categoryId && !product.categoryIds.includes(query.categoryId)) continue;
        const availability = product.stockable ? await this.inventory.publicSellability(tx,store.workspaceId,product.inventoryKey,store.defaultWarehouseId) : { available: true,backorderAllowed: false };
        visible.push({ productId: product.productId,variantId: product.variantId,slug: publication.seoSlug,name: product.name,description: product.description,
          sku: product.sku,variantLabel: product.variantLabel,price: { amount: product.unitPrice,currency: product.currency },available: availability.available,
          backorderAllowed: availability.backorderAllowed });
      } catch (error) { if (!isAppError(error) || !['COMMERCE_ITEM_NOT_AVAILABLE','COMMERCE_PRICE_MISSING'].includes(error.code)) throw error; }
      if (productSlug) {
        if (!visible.length) throw new AppError('COMMERCE_PRODUCT_NOT_PUBLISHED','Product was not found.',404);
        return visible[0];
      }
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    },{ timeout: 60000 });
  }
}
