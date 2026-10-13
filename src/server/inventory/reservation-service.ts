import { Prisma,type PrismaClient,type InventoryReservation,type InventoryDocument,type InventoryDocumentLine } from '@prisma/client';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { parse,uuid,pageQuery } from '../process-platform/dto';
import { inventoryVersion,assertInventoryVersion,positiveQuantity } from './dto';
import { exact,numeric24 } from './decimal';
import { observeReorder } from './reorder-service';
import { InventoryWarehouseService } from './warehouse-service';
import { InventorySourceAuthority } from './source-port';
import { inventoryCatalogPort } from './catalog-port';
import type { ReservationPostingPort,InventoryDocumentService } from './document-service';

const sourceType = z.enum(['DEAL','ORDER','INVOICE','MANUAL','SPA_ITEM']);
const status = z.enum(['ACTIVE','PARTIALLY_FULFILLED','FULFILLED','RELEASED','EXPIRED','CANCELLED']);
const live = ['ACTIVE','PARTIALLY_FULFILLED'];
export const createReservation = z.strictObject({ sourceType,sourceId: uuid,productId: uuid,variantId: uuid.optional(),quantity: positiveQuantity,
  warehouseId: uuid.optional(),expiresAt: z.iso.datetime({ offset: true }).optional() });
type Allocation = { warehouseId: string;locationId: string | null;locationKey: string;quantity: string };
const remaining = (row: InventoryReservation) => exact(row.quantity).minus(row.fulfilledQuantity).minus(row.releasedQuantity);

export class InventoryReservationService implements ReservationPostingPort {
  readonly sources: InventorySourceAuthority;
  private documents?: Pick<InventoryDocumentService,'document'>;
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db),sources?: InventorySourceAuthority) {
    this.sources = sources ?? new InventorySourceAuthority(db);
  }
  setDocumentAuthority(owner: Pick<InventoryDocumentService,'document'>) { this.documents = owner; }
  async inspectOrderReservation(tx:Tx,actor:Principal,id:string,orderId:string){
    requirePermission(actor,'INVENTORY.RESERVATION_READ');
    const row=await tx.inventoryReservation.findFirst({where:{workspaceId:actor.workspaceId,id,sourceType:'ORDER',sourceId:orderId}});
    if(!row||!await ownerVisible(tx,actor,row.createdByUserId,'INVENTORY.RESERVATION_READ'))throw new AppError('RESERVATION_NOT_FOUND','Reservation was not found.',404);
    await import('../commerce/order-authority').then(({commerceOrderRead})=>commerceOrderRead(tx,actor,orderId));
    const legs=await tx.inventoryReservationAllocation.findMany({where:{workspaceId:actor.workspaceId,reservationId:id}});
    for(const warehouseId of new Set([row.warehouseId,...legs.map(l=>l.warehouseId)]))await this.warehouses.warehouse(tx,actor,warehouseId,'INVENTORY.RESERVATION_READ');
    return row;
  }
  async shipmentAllocations(tx: Tx,actor: Principal,orderId: string,inventoryKey: string,warehouseId: string,requestedQuantity: string,reservationIds?:string[]) {
    await lock(tx,actor.workspaceId,'inventory:configuration');
    requirePermission(actor,'INVENTORY.RESERVATION_READ'); parse(positiveQuantity,requestedQuantity);
    const rows = await tx.inventoryReservation.findMany({ where: { workspaceId: actor.workspaceId,sourceType: 'ORDER',sourceId: orderId,inventoryKey,...(reservationIds?{id:{in:reservationIds}}:{}),status: { in: live },expiresAt: { gt: new Date() } },orderBy: { id: 'asc' } });
    if (rows.length) {
      const sku = (await inventoryCatalogPort(tx,actor)).sku(rows[0].productId,rows[0].variantId ?? undefined);
      if (exact(requestedQuantity).decimalPlaces()>sku.unitPrecision) throw new AppError('RESERVATION_QUANTITY_INVALID','Shipment quantity exceeds Catalog unit precision.',422);
    }
    const result: { reservationId: string;locationId: string|null;quantity: string }[] = [];
    for (const row of rows) {
      await this.reservation(tx,actor,row.id,'INVENTORY.RESERVATION_READ');
      const legs = await tx.inventoryReservationAllocation.findMany({ where: { workspaceId: actor.workspaceId,reservationId: row.id,warehouseId,quantity: { gt: 0 } },orderBy: { locationKey: 'asc' } });
      result.push(...legs.map(leg => ({ reservationId: row.id,locationId: leg.locationId,quantity: leg.quantity.toFixed(6) })));
    }
    return result;
  }
  private async source(tx: Tx,actor: Principal,row: { sourceType: string;sourceId: string },inventoryKey?: string) {
    if (row.sourceType==='MANUAL') return {};
    return this.sources.read(tx,actor,{ entityType: row.sourceType,entityId: row.sourceId },inventoryKey);
  }
  async reservation(tx: Tx,actor: Principal,id: string,permission: string) {
    parse(uuid,id); requirePermission(actor,permission);
    const row = await tx.inventoryReservation.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row || !await ownerVisible(tx,actor,row.createdByUserId,permission)) throw new AppError('RESERVATION_NOT_FOUND','Reservation was not found.',404);
    await this.source(tx,actor,row);
    const allocations = await tx.inventoryReservationAllocation.findMany({ where: { workspaceId: actor.workspaceId,reservationId: row.id } });
    for (const warehouseId of [...new Set([row.warehouseId,...allocations.map(a => a.warehouseId)])]) await this.warehouses.warehouse(tx,actor,warehouseId,permission);
    return row;
  }
  private expiry(value: string | undefined,days: number) {
    const now = new Date(),date = value ? new Date(value) : new Date(now.getTime()+days*86400000);
    if (date<=now || date.getTime()>now.getTime()+365*86400000) throw new AppError('RESERVATION_EXPIRED','Expiry must be in the future and within one year.',422);
    return date;
  }
  private async planned(tx: Tx,actor: Principal,row: { sourceType: string;sourceId: string;inventoryKey: string },newQty: string,exclude?: string) {
    const result = await this.source(tx,actor,row,row.inventoryKey);
    if (!result.plannedQuantity) return;
    const others = await tx.inventoryReservation.findMany({ where: { workspaceId: actor.workspaceId,sourceType: row.sourceType,sourceId: row.sourceId,inventoryKey: row.inventoryKey,
      status: { notIn: ['EXPIRED','RELEASED','CANCELLED'] },...(exclude ? { id: { not: exclude } } : {}) },select: { quantity: true,releasedQuantity: true } });
    const committed = others.reduce((sum,other) => sum.plus(exact(other.quantity).minus(other.releasedQuantity)),exact('0')).plus(newQty);
    if (committed.gt(result.plannedQuantity)) throw new AppError('RESERVATION_QUANTITY_INVALID','Reservations exceed the source planned quantity.',422);
  }
  private async allocate(tx: Tx,actor: Principal,inventoryKey: string,quantity: string,permission: string,explicitWarehouseId?: string) {
    const settings = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId },update: {} });
    if (!settings.isEnabled) throw new AppError('PERMISSION_DENIED','Inventory is disabled.',403);
    const strategy = explicitWarehouseId ? 'MANUAL' : settings.defaultAllocationStrategy;
    if (strategy==='MANUAL' && !explicitWarehouseId) throw new AppError('RESERVATION_SOURCE_INVALID','Manual allocation requires a warehouse.',422);
    let warehouses = explicitWarehouseId ? [await this.warehouses.warehouse(tx,actor,explicitWarehouseId,permission,true)] : await this.warehouses.availableWarehouses(tx,actor,permission);
    if (strategy==='DEFAULT_WAREHOUSE') warehouses = warehouses.filter(w => w.id===settings.defaultWarehouseId);
    for (const id of warehouses.map(w => w.id).sort()) { await lock(tx,actor.workspaceId,'inventory:warehouse:' + id); await lock(tx,actor.workspaceId,'inventory:stock:' + id + ':' + inventoryKey); }
    const locations = await tx.inventoryLocation.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: { in: warehouses.map(w => w.id) },status: 'ACTIVE' },select: { id: true } });
    const balances = await tx.inventoryBalance.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: { in: warehouses.map(w => w.id) },inventoryKey,
      OR: [{ locationId: null },{ locationId: { in: locations.map(location => location.id) } }] },orderBy: [{ warehouseId: 'asc' },{ locationKey: 'asc' }] });
    if (strategy==='MOST_AVAILABLE') warehouses.sort((a,b) => {
      const availability = (id: string) => balances.filter(row => row.warehouseId===id).reduce((sum,row) => sum.plus(exact(row.onHand).minus(row.reserved)),exact('0'));
      return availability(b.id).comparedTo(availability(a.id)) || a.id.localeCompare(b.id);
    });
    const allocations: Allocation[] = []; let needed = exact(quantity);
    for (const warehouse of warehouses) for (const balance of balances.filter(row => row.warehouseId===warehouse.id)) {
      if (needed.eq(0)) break;
      const available = exact(balance.onHand).minus(balance.reserved);
      if (available.lte(0)) continue;
      const take = available.lt(needed) ? available : needed;
      allocations.push({ warehouseId: warehouse.id,locationId: balance.locationId,locationKey: balance.locationKey,quantity: numeric24(take) }); needed = needed.minus(take);
    }
    if (needed.gt(0)) {
      if (!settings.allowBackorderReservations || !warehouses.length) throw new AppError('RESERVATION_INSUFFICIENT_STOCK','Authorized stock does not cover the reservation.',409);
      const prior = allocations.find(a => a.warehouseId===warehouses[0].id && !a.locationId);
      if (prior) prior.quantity = numeric24(exact(prior.quantity).plus(needed));
      else allocations.push({ warehouseId: warehouses[0].id,locationId: null,locationKey: '',quantity: numeric24(needed) });
    }
    return allocations;
  }
  private async balance(tx: Tx,actor: Principal,row: { inventoryKey: string;productId: string;variantId: string | null },allocation: Allocation,delta: string) {
    const key = { workspaceId: actor.workspaceId,warehouseId: allocation.warehouseId,inventoryKey: row.inventoryKey,locationKey: allocation.locationKey };
    const balance = await tx.inventoryBalance.upsert({ where: { workspaceId_warehouseId_inventoryKey_locationKey: key },create: { ...key,locationId: allocation.locationId,productId: row.productId,variantId: row.variantId },update: {} });
    const reserved = exact(balance.reserved).plus(delta);
    if (reserved.lt(0)) throw new AppError('STOCK_RECONCILIATION_CONFLICT','Reserved projection requires reconciliation.',409);
    await tx.inventoryBalance.update({ where: { id: balance.id },data: { reserved: numeric24(reserved),version: { increment: 1 } } });
  }
  private async add(tx: Tx,actor: Principal,row: InventoryReservation,allocations: Allocation[]) {
    for (const allocation of allocations) {
      await this.balance(tx,actor,row,allocation,allocation.quantity);
      const where = { workspaceId_reservationId_warehouseId_locationKey: { workspaceId: actor.workspaceId,reservationId: row.id,warehouseId: allocation.warehouseId,locationKey: allocation.locationKey } };
      await tx.inventoryReservationAllocation.upsert({ where,create: { workspaceId: actor.workspaceId,reservationId: row.id,...allocation },update: { quantity: { increment: allocation.quantity } } });
    }
  }
  private async take(tx: Tx,actor: Principal,row: InventoryReservation,quantity: string,leg?: { warehouseId: string;locationId: string | null }) {
    let needed = exact(quantity);
    const allocations = await tx.inventoryReservationAllocation.findMany({ where: { workspaceId: actor.workspaceId,reservationId: row.id,quantity: { gt: 0 },
      ...(leg ? { warehouseId: leg.warehouseId,locationId: leg.locationId } : {}) },orderBy: [{ warehouseId: 'asc' },{ locationKey: 'asc' }] });
    for (const allocation of allocations) {
      if (needed.eq(0)) break;
      await lock(tx,actor.workspaceId,'inventory:warehouse:' + allocation.warehouseId); await lock(tx,actor.workspaceId,'inventory:stock:' + allocation.warehouseId + ':' + row.inventoryKey);
      const amount = exact(allocation.quantity).lt(needed) ? exact(allocation.quantity) : needed;
      await this.balance(tx,actor,row,{ ...allocation,quantity: allocation.quantity.toFixed(6) },numeric24(amount.neg()));
      await tx.inventoryReservationAllocation.update({ where: { id: allocation.id },data: { quantity: numeric24(exact(allocation.quantity).minus(amount)) } }); needed = needed.minus(amount);
    }
    if (needed.gt(0)) throw new AppError('RESERVATION_QUANTITY_INVALID','Allocation legs do not cover the quantity.',409);
  }
  private async history(tx: Tx,actor: Principal,row: InventoryReservation,action: string,quantity: string,lineId?: string) {
    await tx.inventoryReservationHistory.create({ data: { workspaceId: actor.workspaceId,reservationId: row.id,actorUserId: actor.userId,action,quantity,documentLineId: lineId } });
    await evidence(tx,actor,'INVENTORY_RESERVATION',row.id,'RESERVATION_' + action,{ inventoryKey: row.inventoryKey,quantity,status: row.status,version: row.version.toString(),documentLineId: lineId ?? null });
    if (action!=='FULFILLED') {
      const allocations = await tx.inventoryReservationAllocation.findMany({ where: { workspaceId: actor.workspaceId,reservationId: row.id },select: { warehouseId: true } });
      for (const warehouseId of [...new Set(allocations.map(allocation => allocation.warehouseId))]) await observeReorder(tx,actor,warehouseId,row.inventoryKey);
    }
  }
  async createInTransaction(tx: Tx,actor: Principal,raw: unknown,key: string | null) {
    const input = parse(createReservation,raw); await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.RESERVATION_CREATE');
    await this.source(tx,actor,input);
    const result = await command(tx,actor,'INVENTORY.RESERVATION_CREATE',key,input,async () => {
      const sku = (await inventoryCatalogPort(tx,actor)).sku(input.productId,input.variantId);
      if (exact(input.quantity).decimalPlaces()>sku.unitPrecision) throw new AppError('RESERVATION_QUANTITY_INVALID','Quantity exceeds Catalog unit precision.',422);
      await this.planned(tx,actor,{ ...input,inventoryKey: sku.inventoryKey },input.quantity);
      const allocations = await this.allocate(tx,actor,sku.inventoryKey,input.quantity,'INVENTORY.RESERVATION_CREATE',input.warehouseId);
      const settings = await tx.inventorySettings.findUniqueOrThrow({ where: { workspaceId: actor.workspaceId } });
      const row = await tx.inventoryReservation.create({ data: { workspaceId: actor.workspaceId,sourceType: input.sourceType,sourceId: input.sourceId,warehouseId: allocations[0].warehouseId,
        productId: sku.productId,variantId: sku.variantId,inventoryKey: sku.inventoryKey,quantity: input.quantity,createdByUserId: actor.userId,expiresAt: this.expiry(input.expiresAt,settings.defaultReservationDays) } });
      await this.add(tx,actor,row,allocations); await this.history(tx,actor,row,'CREATED',input.quantity); return { id: row.id,status: row.status,version: row.version.toString(),expiresAt: row.expiresAt.toISOString() };
    });
    await this.reservation(tx,actor,result.id,'INVENTORY.RESERVATION_CREATE'); return result;
  }
  async create(actor: Principal,raw: unknown,key: string | null) { return this.db.$transaction(tx => this.createInTransaction(tx,actor,raw,key),{ timeout: 60000 }); }
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.RESERVATION_READ'); const query = parse(pageQuery.extend({ sourceType: sourceType.optional(),status: status.optional(),warehouseId: uuid.optional() }),raw);
    return this.db.$transaction(async tx => {
      const legs = query.warehouseId ? await tx.inventoryReservationAllocation.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: query.warehouseId },select: { reservationId: true } }) : [];
      const rows = await tx.inventoryReservation.findMany({ where: { workspaceId: actor.workspaceId,sourceType: query.sourceType,status: query.status,
        ...(query.warehouseId ? { OR: [{ warehouseId: query.warehouseId },{ id: { in: legs.map(leg => leg.reservationId) } }] } : {}) },orderBy: [{ reservedAt: 'desc' },{ id: 'asc' }] });
      const visible = [];
      for (const row of rows) try { await this.reservation(tx,actor,row.id,'INVENTORY.RESERVATION_READ'); visible.push(row); }
      catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async get(actor: Principal,id: string) {
    return this.db.$transaction(async tx => { const row = await this.reservation(tx,actor,id,'INVENTORY.RESERVATION_READ');
      return { ...row,remainingQuantity: numeric24(remaining(row)),allocations: await tx.inventoryReservationAllocation.findMany({ where: { workspaceId: actor.workspaceId,reservationId: id },orderBy: [{ warehouseId: 'asc' },{ locationKey: 'asc' }] }) }; });
  }
  async update(actor: Principal,id: string,raw: unknown,extend = false) {
    const input = extend ? parse(z.strictObject({ expectedVersion: inventoryVersion,expiresAt: z.iso.datetime({ offset: true }) }),raw)
      : parse(z.strictObject({ expectedVersion: inventoryVersion,quantity: positiveQuantity.optional(),expiresAt: z.iso.datetime({ offset: true }).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:reservation:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.reservation(tx,actor,id,'INVENTORY.RESERVATION_MANAGE'); assertInventoryVersion(row.version,input.expectedVersion);
      if (!live.includes(row.status) || row.expiresAt<=new Date()) throw new AppError('RESERVATION_EXPIRED','Reservation is closed or expired.',409);
      const qty = 'quantity' in input && typeof input.quantity==='string' ? input.quantity : row.quantity.toFixed(6);
      const sku = (await inventoryCatalogPort(tx,actor)).sku(row.productId,row.variantId ?? undefined);
      if (exact(qty).decimalPlaces()>sku.unitPrecision || exact(qty).lt(exact(row.fulfilledQuantity).plus(row.releasedQuantity))) throw new AppError('RESERVATION_QUANTITY_INVALID','Quantity is below consumed quantities or exceeds unit precision.',422);
      await this.planned(tx,actor,row,numeric24(exact(qty).minus(row.releasedQuantity)),row.id);
      const delta = exact(qty).minus(row.quantity);
      if (delta.gt(0)) await this.add(tx,actor,row,await this.allocate(tx,actor,row.inventoryKey,numeric24(delta),'INVENTORY.RESERVATION_MANAGE',row.warehouseId));
      if (delta.lt(0)) await this.take(tx,actor,row,numeric24(delta.neg()));
      const expiresAt = input.expiresAt ? this.expiry(input.expiresAt,3) : row.expiresAt;
      if (extend && expiresAt<=row.expiresAt) throw new AppError('RESERVATION_EXPIRED','Extension must increase expiry.',422);
      const closed = exact(qty).eq(exact(row.fulfilledQuantity).plus(row.releasedQuantity));
      const updated = await tx.inventoryReservation.update({ where: { id },data: { quantity: qty,expiresAt,status: closed ? exact(row.fulfilledQuantity).gt(0) ? 'FULFILLED' : 'RELEASED' : row.status,version: { increment: 1 } } });
      await this.history(tx,actor,updated,'CHANGED',numeric24(delta.abs())); return updated;
    },{ timeout: 60000 });
  }
  async releaseInTransaction(tx: Tx,actor: Principal,id: string,raw: unknown,key: string | null) {
    const input = parse(z.strictObject({ quantity: positiveQuantity.optional(),reason: z.string().trim().min(1).max(2000) }),raw);
    await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:reservation:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
    const row = await this.reservation(tx,actor,id,'INVENTORY.RESERVATION_MANAGE');
    return command(tx,actor,'INVENTORY.RESERVATION_RELEASE:' + id,key,input,async () => {
      if (!live.includes(row.status)) throw new AppError('RESERVATION_EXPIRED','Reservation is closed.',409);
      const qty = input.quantity ? exact(input.quantity) : remaining(row);
      if (qty.lte(0) || qty.gt(remaining(row))) throw new AppError('RESERVATION_QUANTITY_INVALID','Release exceeds remaining reservation.',422);
      await this.take(tx,actor,row,numeric24(qty));
      const updated = await tx.inventoryReservation.update({ where: { id },data: { releasedQuantity: { increment: numeric24(qty) },status: qty.eq(remaining(row)) ? 'RELEASED' : row.status,version: { increment: 1 } } });
      await this.history(tx,actor,updated,'RELEASED',numeric24(qty));
      await evidence(tx,actor,'INVENTORY_RESERVATION',id,'RESERVATION_RELEASE_REASON',{ reason: input.reason },true); return { id,status: updated.status,version: updated.version.toString() };
    });
  }
  async release(actor: Principal,id: string,raw: unknown,key: string | null) { return this.db.$transaction(tx => this.releaseInTransaction(tx,actor,id,raw,key),{ timeout: 60000 }); }
  async releaseShipmentAllocation(tx: Tx,actor: Principal,id: string,quantity: string,warehouseId: string,locationId: string|null,key: string) {
    parse(positiveQuantity,quantity); await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:reservation:'+id);
    actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
    const row = await this.reservation(tx,actor,id,'INVENTORY.RESERVATION_MANAGE');
    return command(tx,actor,'INVENTORY.SHIPMENT_RELEASE:'+id,key,{ quantity,warehouseId,locationId },async () => {
      if (!live.includes(row.status) || exact(quantity).gt(remaining(row))) throw new AppError('RESERVATION_QUANTITY_INVALID','Reservation no longer covers this shipment.',409);
      await this.take(tx,actor,row,quantity,{ warehouseId,locationId });
      const updated = await tx.inventoryReservation.update({ where: { id },data: { releasedQuantity: { increment: quantity },status: exact(quantity).eq(remaining(row)) ? 'RELEASED' : row.status,version: { increment: 1 } } });
      await this.history(tx,actor,updated,'RELEASED',quantity); return { id,status: updated.status };
    });
  }
  private async consume(tx: Tx,actor: Principal,row: InventoryReservation,line: InventoryDocumentLine,document: InventoryDocument,qty: string) {
    if (document.type!=='SALES_ORDER' || document.reversedAt || line.inventoryKey!==row.inventoryKey || !document.sourceWarehouseId
      || row.sourceType!=='MANUAL' && (row.sourceType!==document.sourceEntityType || row.sourceId!==document.sourceEntityId)) throw new AppError('RESERVATION_SOURCE_INVALID','Sale line does not match this reservation source and SKU.',422);
    if (!live.includes(row.status) || row.expiresAt<=new Date() || exact(qty).gt(remaining(row))) throw new AppError('RESERVATION_QUANTITY_INVALID','Reservation does not cover fulfillment.',409);
    const consumed = await tx.inventoryReservationHistory.aggregate({ where: { workspaceId: actor.workspaceId,documentLineId: line.id,action: 'FULFILLED' },_sum: { quantity: true } });
    if (exact(consumed._sum.quantity ?? '0').plus(qty).gt(line.quantity)) throw new AppError('RESERVATION_ALREADY_FULFILLED','Sale line was already consumed.',409);
    await this.take(tx,actor,row,qty,{ warehouseId: document.sourceWarehouseId,locationId: line.sourceLocationId });
    const updated = await tx.inventoryReservation.update({ where: { id: row.id },data: { fulfilledQuantity: { increment: qty },status: exact(qty).eq(remaining(row)) ? 'FULFILLED' : 'PARTIALLY_FULFILLED',version: { increment: 1 } } });
    await this.history(tx,actor,updated,'FULFILLED',qty,line.id); return updated;
  }
  async consumeForPosting(tx: Tx,actor: Principal,id: string,line: InventoryDocumentLine,document: InventoryDocument) {
    await lock(tx,actor.workspaceId,'inventory:reservation:' + id); const row = await this.reservation(tx,actor,id,'INVENTORY.RESERVATION_FULFILL');
    await this.consume(tx,actor,row,line,document,line.quantity.toFixed(6));
  }
  async fulfill(actor: Principal,id: string,raw: unknown,key: string | null) {
    const input = parse(z.strictObject({ quantity: positiveQuantity,inventoryDocumentLineId: uuid }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const line = await tx.inventoryDocumentLine.findFirst({ where: { workspaceId: actor.workspaceId,id: input.inventoryDocumentLineId } });
      if (!line) throw new AppError('RESERVATION_SOURCE_INVALID','Sale line was not found.',404);
      await lock(tx,actor.workspaceId,'inventory:document:' + line.documentId); await lock(tx,actor.workspaceId,'inventory:reservation:' + id);
      const row = await this.reservation(tx,actor,id,'INVENTORY.RESERVATION_FULFILL'); requirePermission(actor,'INVENTORY.DOCUMENT_READ');
      if (!this.documents) throw new AppError('RESERVATION_SOURCE_INVALID','Document owning adapter is unavailable.',503);
      const document = await this.documents.document(tx,actor,line.documentId,'INVENTORY.DOCUMENT_READ');
      if (document.status!=='PROCESSED' || document.reversedAt) throw new AppError('RESERVATION_SOURCE_INVALID','Sale document is not processed or was reversed.',409);
      return command(tx,actor,'INVENTORY.RESERVATION_FULFILL:' + id,key,input,async () => {
        const prior = await tx.inventoryReservationHistory.aggregate({ where: { workspaceId: actor.workspaceId,reservationId: id,documentLineId: line.id,action: 'FULFILLED' },_sum: { quantity: true } });
        if (prior._sum.quantity && exact(prior._sum.quantity).eq(input.quantity)) return { id,status: row.status,version: row.version.toString(),alreadyFulfilled: true };
        const updated = await this.consume(tx,actor,row,line,document,input.quantity);
        await observeReorder(tx,actor,document.sourceWarehouseId!,row.inventoryKey);
        return { id,status: updated.status,version: updated.version.toString(),alreadyFulfilled: false };
      });
    },{ timeout: 60000 });
  }
  async expireDue(limit = 50) {
    const rows = await this.db.inventoryReservation.findMany({ where: { status: { in: live },expiresAt: { lte: new Date() } },orderBy: { expiresAt: 'asc' },take: limit }); let expired = 0;
    for (const candidate of rows) {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'inventory:configuration'); await lock(tx,candidate.workspaceId,'inventory:reservation:' + candidate.id);
        const row = await tx.inventoryReservation.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: { in: live },expiresAt: { lte: new Date() } } });
        if (!row) return false;
        const actor: Principal = { workspaceId: row.workspaceId,userId: row.createdByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() };
        const qty = remaining(row); await this.take(tx,actor,row,numeric24(qty));
        const updated = await tx.inventoryReservation.update({ where: { id: row.id },data: { status: 'EXPIRED',releasedQuantity: { increment: numeric24(qty) },version: { increment: 1 } } });
        await this.history(tx,actor,updated,'EXPIRED',numeric24(qty)); return true;
      },{ timeout: 60000 }); if (done) expired++;
    }
    return { candidates: rows.length,expired };
  }
}
