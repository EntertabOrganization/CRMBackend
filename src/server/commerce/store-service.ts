import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { parse,uuid,name,code,timezone,pageQuery } from '../process-platform/dto';
import { commerceVersion,commerceCurrency as currency,assertCommerceVersion,reservationTiming,dealPolicy,slug } from './dto';
import { commerceCatalogPort } from './catalog-port';
import { InventoryWarehouseService } from '../inventory/warehouse-service';

export class CommerceStoreService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db)) {}
  async store(tx: Tx,actor: Principal,id: string,permission: string) {
    parse(uuid,id); requirePermission(actor,permission);
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    if ((workspace.settings as { entitlements?: { commerce?: boolean } }).entitlements?.commerce===false) throw new AppError('PERMISSION_DENIED','Commerce is unavailable for this Workspace.',403);
    const row = await tx.commerceStore.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row || !await ownerVisible(tx,actor,row.createdByUserId,permission)) throw new AppError('COMMERCE_STORE_NOT_FOUND','Store was not found.',404); return row;
  }
  async create(actor: Principal,raw: unknown) {
    const input = parse(z.strictObject({ name,code,defaultCurrency: currency,timezone,catalogId: uuid }),raw); requirePermission(actor,'COMMERCE.STORE_MANAGE');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'COMMERCE.STORE_MANAGE');
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
      if ((workspace.settings as { entitlements?: { commerce?: boolean } }).entitlements?.commerce===false) throw new AppError('PERMISSION_DENIED','Commerce is unavailable.',403);
      const catalog = (await commerceCatalogPort(tx,actor.workspaceId,actor)).configuration(input.catalogId);
      const row = await tx.commerceStore.create({ data: { workspaceId: actor.workspaceId,...input,priceTypeId: catalog.priceTypeId,createdByUserId: actor.userId } });
      await evidence(tx,actor,'COMMERCE_STORE',row.id,'COMMERCE_STORE_CREATED',{ code: row.code,version: row.version.toString() }); return row;
    },{ timeout: 60000 });
  }
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'COMMERCE.STORE_VIEW'); const query = parse(pageQuery.extend({ status: z.enum(['DRAFT','ACTIVE','SUSPENDED','ARCHIVED']).optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.commerceStore.findMany({ where: { workspaceId: actor.workspaceId,status: query.status,...(query.search ? { OR: [{ name: { contains: query.search,mode: 'insensitive' } },{ code: { contains: query.search,mode: 'insensitive' } }] } : {}) },orderBy: [{ createdAt: 'desc' },{ id: 'asc' }] });
      const visible = [];
      for (const row of rows) if (await ownerVisible(tx,actor,row.createdByUserId,'COMMERCE.STORE_VIEW')) visible.push(row);
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async get(actor: Principal,id: string) {
    return this.db.$transaction(async tx => {
      const row = await this.store(tx,actor,id,'COMMERCE.STORE_VIEW');
      const availableActions = [];
      for (const permission of ['COMMERCE.STORE_MANAGE','COMMERCE.CATALOG_PUBLISH','COMMERCE.ORDER_VIEW','COMMERCE.DELIVERY_MANAGE','COMMERCE.PROMOTION_MANAGE','COMMERCE.TAX_MANAGE'])
        if (actor.grants.has(permission) && await ownerVisible(tx,actor,row.createdByUserId,permission)) availableActions.push(permission);
      return { ...row,availableActions };
    });
  }
  async update(actor: Principal,id: string,raw: unknown,suspend = false) {
    const input = suspend ? parse(z.strictObject({ expectedVersion: commerceVersion }),raw) : parse(z.strictObject({ expectedVersion: commerceVersion,name: name.optional(),
      timezone: timezone.optional(),defaultCurrency: currency.optional(),catalogId: uuid.optional(),priceTypeId: uuid.optional(),defaultWarehouseId: uuid.nullable().optional(),
      reservationTiming: reservationTiming.optional(),dealCreationPolicy: dealPolicy.optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); await lock(tx,actor.workspaceId,'commerce:store:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.store(tx,actor,id,'COMMERCE.STORE_MANAGE'); assertCommerceVersion(row.version,input.expectedVersion);
      if (row.status==='ARCHIVED' || suspend && row.status!=='ACTIVE') throw new AppError('COMMERCE_STORE_INVALID_STATUS','Store cannot perform this change.',409);
      const { expectedVersion,...data } = input;
      if ('defaultCurrency' in data && data.defaultCurrency!==row.defaultCurrency && row.status!=='DRAFT') throw new AppError('COMMERCE_STORE_INVALID_STATUS','Currency is fixed after activation.',409);
      if ('catalogId' in data && data.catalogId!==row.catalogId && (await tx.commerceProductPublication.count({ where: { workspaceId: actor.workspaceId,storeId: id } }) || await tx.commerceCategoryPublication.count({ where: { workspaceId: actor.workspaceId,storeId: id } })))
        throw new AppError('COMMERCE_STORE_INVALID_STATUS','Catalog cannot change while publications exist.',409);
      if ('catalogId' in data || 'priceTypeId' in data) (await commerceCatalogPort(tx,actor.workspaceId,actor)).configuration('catalogId' in data && typeof data.catalogId==='string' ? data.catalogId : row.catalogId,'priceTypeId' in data && typeof data.priceTypeId==='string' ? data.priceTypeId : row.priceTypeId);
      if ('defaultWarehouseId' in data && typeof data.defaultWarehouseId==='string') await this.warehouses.warehouse(tx,actor,data.defaultWarehouseId,'INVENTORY.WAREHOUSE_READ',true);
      const updated = await tx.commerceStore.update({ where: { id },data: { ...data,...(suspend ? { status: 'SUSPENDED' } : {}),version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_STORE',id,suspend ? 'COMMERCE_STORE_SUSPENDED' : 'COMMERCE_STORE_CHANGED',{ changes: data as Prisma.InputJsonObject,version: updated.version.toString() }); return updated;
    },{ timeout: 60000 });
  }
  async storefronts(actor: Principal,id: string,raw?: unknown) {
    if (raw===undefined) return this.db.$transaction(async tx => {
      await this.store(tx,actor,id,'COMMERCE.STORE_VIEW'); return tx.commerceStorefront.findMany({ where: { workspaceId: actor.workspaceId,storeId: id },orderBy: { slug: 'asc' } });
    });
    const input = parse(z.strictObject({ type: z.enum(['WEB','HEADLESS','MOBILE','SOCIAL','EMBEDDED']),slug,domain: z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); await this.store(tx,actor,id,'COMMERCE.STORE_MANAGE');
      const row = await tx.commerceStorefront.create({ data: { workspaceId: actor.workspaceId,storeId: id,...input } });
      await evidence(tx,actor,'COMMERCE_STORE',id,'COMMERCE_STOREFRONT_CREATED',{ storefrontId: row.id,type: row.type,slug: row.slug }); return row;
    });
  }
  async automation(actor: Principal,id: string,raw?: unknown) {
    if (raw===undefined) return this.db.$transaction(async tx => {
      const row = await this.store(tx,actor,id,'COMMERCE.STORE_MANAGE'); return { abandonedAfterMinutes: row.abandonedAfterMinutes,dealCreationPolicy: row.dealCreationPolicy,version: row.version.toString() };
    });
    const input = parse(z.strictObject({ expectedVersion: commerceVersion,abandonedAfterMinutes: z.number().int().min(5).max(43200).optional(),dealCreationPolicy: dealPolicy.optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.store(tx,actor,id,'COMMERCE.STORE_MANAGE'); assertCommerceVersion(row.version,input.expectedVersion); const { expectedVersion,...data } = input;
      const updated = await tx.commerceStore.update({ where: { id },data: { ...data,version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_STORE',id,'COMMERCE_AUTOMATION_POLICY_CHANGED',{ before: { abandonedAfterMinutes: row.abandonedAfterMinutes,dealCreationPolicy: row.dealCreationPolicy },after: data,version: updated.version.toString() });
      return { abandonedAfterMinutes: updated.abandonedAfterMinutes,dealCreationPolicy: updated.dealCreationPolicy,version: updated.version.toString() };
    });
  }
}
