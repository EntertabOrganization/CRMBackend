import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { lock,requirePermission,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid,pageQuery } from '../process-platform/dto';
import { quantity } from './dto';
import { InventoryWarehouseService } from './warehouse-service';
import { inventoryCatalogPort } from './catalog-port';
import { exact } from './decimal';

export class InventoryStockService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db)) {}
  /** Read-only owning ledger/projection comparison for authorized Commerce consistency checks. */
  async reconcileProjection(tx:Tx,actor:Principal,warehouseIds:string[],inventoryKeys:string[]){
    requirePermission(actor,'INVENTORY.STOCK_READ');requirePermission(actor,'INVENTORY.MOVEMENT_READ');
    await lock(tx,actor.workspaceId,'inventory:configuration');
    const ids=[...new Set(warehouseIds)].sort(),keys=[...new Set(inventoryKeys)].sort();
    for(const id of ids){await this.warehouses.warehouse(tx,actor,id,'INVENTORY.STOCK_READ');await this.warehouses.warehouse(tx,actor,id,'INVENTORY.MOVEMENT_READ');}
    const balances=await tx.inventoryBalance.findMany({where:{workspaceId:actor.workspaceId,warehouseId:{in:ids},inventoryKey:{in:keys}}});
    const movements=await tx.inventoryMovement.groupBy({by:['warehouseId','inventoryKey','locationId'],where:{workspaceId:actor.workspaceId,warehouseId:{in:ids},inventoryKey:{in:keys}},_sum:{quantityDelta:true}});
    const live=await tx.inventoryReservation.findMany({where:{workspaceId:actor.workspaceId,inventoryKey:{in:keys},status:{in:['ACTIVE','PARTIALLY_FULFILLED']}},select:{id:true,inventoryKey:true}});
    const allocations=await tx.inventoryReservationAllocation.findMany({where:{workspaceId:actor.workspaceId,warehouseId:{in:ids},reservationId:{in:live.map(r=>r.id)}}});
    const rows=new Map<string,{warehouseId:string;inventoryKey:string;locationId:string|null;onHand:string;ledgerOnHand:string;reserved:string;ledgerReserved:string}>();
    const identity=(r:{warehouseId:string;inventoryKey:string;locationId:string|null})=>r.warehouseId+':'+r.inventoryKey+':'+(r.locationId??'');
    const get=(r:{warehouseId:string;inventoryKey:string;locationId:string|null})=>{const key=identity(r);if(!rows.has(key))rows.set(key,{...r,onHand:'0.000000',ledgerOnHand:'0.000000',reserved:'0.000000',ledgerReserved:'0.000000'});return rows.get(key)!;};
    for(const r of balances)Object.assign(get({warehouseId:r.warehouseId,inventoryKey:r.inventoryKey,locationId:r.locationId}),{onHand:r.onHand.toFixed(6),reserved:r.reserved.toFixed(6)});
    for(const r of movements)get(r).ledgerOnHand=exact(r._sum.quantityDelta??0).toFixed(6);
    const owners=new Map(live.map(r=>[r.id,r.inventoryKey]));
    for(const r of allocations){const row=get({warehouseId:r.warehouseId,inventoryKey:owners.get(r.reservationId)!,locationId:r.locationId});row.ledgerReserved=exact(row.ledgerReserved).plus(r.quantity).toFixed(6);}
    return [...rows.values()].sort((a,b)=>identity(a).localeCompare(identity(b)));
  }
  /** Internal owning projection. Commerce supplies scope only after resolving a published Store.
   * Never exposes warehouse quantities, cost, location or identities to public callers. */
  async publicSellability(tx: Tx,workspaceId: string,inventoryKey: string,warehouseId?: string | null) {
    const workspace = await tx.workspace.findFirst({ where: { id: workspaceId,isDeleted: false } });
    if (!workspace || (workspace.settings as { entitlements?: { inventory?: boolean } }).entitlements?.inventory===false) return { available: false,backorderAllowed: false };
    const settings = await tx.inventorySettings.findUnique({ where: { workspaceId } });
    if (settings?.isEnabled===false) return { available: false,backorderAllowed: false };
    const warehouses = await tx.inventoryWarehouse.findMany({ where: { workspaceId,status: 'ACTIVE',type: { in: ['PHYSICAL','STORE','FULFILLMENT'] },...(warehouseId ? { id: warehouseId } : {}) },select: { id: true } });
    const locations = await tx.inventoryLocation.findMany({ where: { workspaceId,warehouseId: { in: warehouses.map(row => row.id) },status: 'ACTIVE' },select: { id: true } });
    const rows = await tx.inventoryBalance.aggregate({ where: { workspaceId,inventoryKey,warehouseId: { in: warehouses.map(row => row.id) },OR: [{ locationId: null },{ locationId: { in: locations.map(row => row.id) } }] },_sum: { onHand: true,reserved: true } });
    const backorderAllowed = Boolean(settings?.allowBackorderReservations && warehouses.length);
    return { available: exact(rows._sum.onHand ?? '0').minus(rows._sum.reserved ?? '0').gt(0) || backorderAllowed,backorderAllowed };
  }
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.STOCK_READ'); const query = parse(pageQuery.extend({ warehouseId: uuid.optional(),productId: uuid.optional(),variantId: uuid.optional() }),raw);
    return this.db.$transaction(async tx => {
      const ids = query.warehouseId ? [(await this.warehouses.warehouse(tx,actor,query.warehouseId,'INVENTORY.STOCK_READ')).id]
        : (await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.STOCK_READ',false)).map(w => w.id);
      const where = { workspaceId: actor.workspaceId,warehouseId: { in: ids },productId: query.productId,variantId: query.variantId };
      const [rows,total] = await Promise.all([tx.inventoryBalance.findMany({ where,orderBy: [{ warehouseId: 'asc' },{ inventoryKey: 'asc' },{ locationKey: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.inventoryBalance.count({ where })]);
      return { data: rows.map(row => ({ ...row,available: exact(row.onHand).minus(row.reserved).toFixed(6) })),meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async availability(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.STOCK_READ'); const query = parse(z.strictObject({ productId: uuid,variantId: uuid.optional(),quantity: quantity.optional(),warehouseId: uuid.optional() }),raw);
    return this.db.$transaction(async tx => {
      const sku = (await inventoryCatalogPort(tx,actor)).sku(query.productId,query.variantId);
      const ids = query.warehouseId ? [(await this.warehouses.warehouse(tx,actor,query.warehouseId,'INVENTORY.STOCK_READ',true)).id]
        : (await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.STOCK_READ')).map(w => w.id);
      const [balances,settings] = await Promise.all([tx.inventoryBalance.aggregate({ where: { workspaceId: actor.workspaceId,warehouseId: { in: ids },inventoryKey: sku.inventoryKey },_sum: { onHand: true,reserved: true } }),
        tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } })]);
      const onHand = exact(balances._sum.onHand ?? '0'),reserved = exact(balances._sum.reserved ?? '0'),available = onHand.minus(reserved);
      return { productId: sku.productId,variantId: sku.variantId,onHand: onHand.toFixed(6),reserved: reserved.toFixed(6),available: available.toFixed(6),
        backorderAllowed: settings?.allowBackorderReservations ?? false,canReserve: ids.length>0 && (available.gte(query.quantity ?? '0') || Boolean(settings?.allowBackorderReservations)) };
    });
  }
  async movements(actor: Principal,raw: unknown,movementId?: string) {
    requirePermission(actor,'INVENTORY.MOVEMENT_READ');
    const query = parse(z.strictObject({ warehouseId: uuid.optional(),productId: uuid.optional(),from: z.iso.datetime({ offset: true }).optional(),to: z.iso.datetime({ offset: true }).optional(),
      cursor: uuid.optional(),limit: z.coerce.number().int().min(1).max(100).default(50) }),raw);
    if (movementId) parse(uuid,movementId);
    return this.db.$transaction(async tx => {
      const warehouses = query.warehouseId ? [await this.warehouses.warehouse(tx,actor,query.warehouseId,'INVENTORY.MOVEMENT_READ')]
        : await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.MOVEMENT_READ',false);
      const costVisible = new Set<string>();
      for (const warehouse of warehouses) if (await this.warehouses.allowed(tx,actor,warehouse,'INVENTORY.COSTING_VIEW') || await this.warehouses.allowed(tx,actor,warehouse,'INVENTORY.VALUATION_VIEW')) costVisible.add(warehouse.id);
      const where = { workspaceId: actor.workspaceId,warehouseId: { in: warehouses.map(w => w.id) },productId: query.productId,
        occurredAt: { ...(query.from ? { gte: new Date(query.from) } : {}),...(query.to ? { lte: new Date(query.to) } : {}) } };
      const redact = (row: Awaited<ReturnType<typeof tx.inventoryMovement.findFirstOrThrow>>) => {
        const { unitCost,totalCost,...publicFields } = row;
        return costVisible.has(row.warehouseId) ? row : publicFields;
      };
      if (movementId) {
        const row = await tx.inventoryMovement.findFirst({ where: { workspaceId: actor.workspaceId,id: movementId } });
        if (!row) throw new AppError('STOCK_NOT_FOUND','Movement was not found.',404);
        await this.warehouses.warehouse(tx,actor,row.warehouseId,'INVENTORY.MOVEMENT_READ'); return redact(row);
      }
      if (query.cursor && !await tx.inventoryMovement.count({ where: { ...where,id: query.cursor } })) throw new AppError('STOCK_NOT_FOUND','Cursor is unavailable.',404);
      const rows = await tx.inventoryMovement.findMany({ where,orderBy: [{ occurredAt: 'desc' },{ id: 'desc' }],take: query.limit+1,...(query.cursor ? { cursor: { id: query.cursor },skip: 1 } : {}) });
      return { data: rows.slice(0,query.limit).map(redact),nextCursor: rows.length>query.limit ? rows[query.limit-1].id : null };
    });
  }
}
