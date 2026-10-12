import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal } from '../process-platform/context';
import { parse,uuid,pageQuery } from '../process-platform/dto';
import { inventoryCatalogPort } from './catalog-port';
import { InventoryWarehouseService } from './warehouse-service';
import { InventoryDocumentService } from './document-service';
import { exact } from './decimal';

const barcodeType = z.enum(['EAN13','UPC','CODE128','QR','CUSTOM']);
const identifier = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
function validBarcode(type: string,value: string) {
  if (!['EAN13','UPC'].includes(type)) return true;
  if (!new RegExp(type==='EAN13' ? '^\\d{13}$' : '^\\d{12}$').test(value)) return false;
  let sum = 0,weight = 3;
  for (let i = value.length-2;i>=0;i--) { sum += Number(value[i])*weight; weight = weight===3 ? 1 : 3; }
  return (10-sum%10)%10===Number(value.at(-1));
}
export class InventoryTrackingService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db),readonly documents = new InventoryDocumentService(db,warehouses)) {}
  async resolve(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.STOCK_READ'); const input = parse(z.strictObject({ code: z.string().min(1).max(200) }),raw);
    return this.db.$transaction(async tx => {
      if (!(await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.STOCK_READ')).length) throw new AppError('WAREHOUSE_ACCESS_DENIED','No warehouse is accessible.',403);
      const barcode = await tx.inventoryBarcode.findFirst({ where: { workspaceId: actor.workspaceId,value: input.code,isActive: true } });
      if (!barcode) throw new AppError('BARCODE_NOT_FOUND','Barcode was not found.',404);
      const sku = (await inventoryCatalogPort(tx,actor)).sku(barcode.productId,barcode.variantId ?? undefined);
      return { barcodeId: barcode.id,barcodeType: barcode.type,value: barcode.value,...sku };
    });
  }
  async barcode(actor: Principal,raw: unknown,id?: string) {
    requirePermission(actor,'INVENTORY.TRACKING_MANAGE');
    const input = id ? parse(z.strictObject({}),raw) : parse(z.strictObject({ productId: uuid,variantId: uuid.optional(),barcodeType,value: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)) }),raw);
    if (id) parse(uuid,id);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.TRACKING_MANAGE');
      if (!(await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.TRACKING_MANAGE')).length) throw new AppError('WAREHOUSE_ACCESS_DENIED','No warehouse is accessible.',403);
      const catalog = await inventoryCatalogPort(tx,actor);
      if (id) {
        const row = await tx.inventoryBarcode.findFirst({ where: { workspaceId: actor.workspaceId,id,isActive: true } });
        if (!row) throw new AppError('BARCODE_NOT_FOUND','Barcode was not found.',404);
        catalog.sku(row.productId,row.variantId ?? undefined,false);
        await tx.inventoryBarcode.update({ where: { id },data: { isActive: false,isPrimary: false } });
        await evidence(tx,actor,'PRODUCT',row.inventoryKey,'PRODUCT_BARCODE_REVOKED',{ barcodeId: id }); return { id,revoked: true };
      }
      if (!('productId' in input)) throw new AppError('INVALID_ARGUMENT','Barcode input is invalid.',400);
      const data = input as { productId: string;variantId?: string;barcodeType: string;value: string };
      if (!validBarcode(data.barcodeType,data.value)) throw new AppError('BARCODE_INVALID','Barcode format or check digit is invalid.',422);
      const sku = catalog.sku(data.productId,data.variantId);
      const prior = await tx.inventoryBarcode.findUnique({ where: { workspaceId_value: { workspaceId: actor.workspaceId,value: data.value } } });
      if (prior?.isActive || prior && prior.inventoryKey!==sku.inventoryKey) throw new AppError('BARCODE_EXISTS','Barcode is already assigned.',409);
      const primary = !await tx.inventoryBarcode.count({ where: { workspaceId: actor.workspaceId,inventoryKey: sku.inventoryKey,isActive: true,isPrimary: true } });
      const row = prior ? await tx.inventoryBarcode.update({ where: { id: prior.id },data: { type: data.barcodeType,isActive: true,isPrimary: primary } })
        : await tx.inventoryBarcode.create({ data: { workspaceId: actor.workspaceId,productId: sku.productId,variantId: sku.variantId,inventoryKey: sku.inventoryKey,type: data.barcodeType,value: data.value,isPrimary: primary } });
      await evidence(tx,actor,'PRODUCT',sku.inventoryKey,'PRODUCT_BARCODE_ASSIGNED',{ barcodeId: row.id,barcodeType: row.type }); return row;
    });
  }
  async serials(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.TRACKING_READ'); const query = parse(pageQuery.extend({ productId: uuid.optional(),warehouseId: uuid.optional(),status: z.enum(['IN_STOCK','RESERVED','SOLD','RETURNED','DAMAGED','WRITTEN_OFF']).optional() }),raw);
    return this.db.$transaction(async tx => {
      const ids = query.warehouseId ? [(await this.warehouses.warehouse(tx,actor,query.warehouseId,'INVENTORY.TRACKING_READ')).id]
        : (await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.TRACKING_READ',false)).map(w => w.id);
      const where = { workspaceId: actor.workspaceId,warehouseId: { in: ids },productId: query.productId,status: query.status,...(query.search ? { serialNumber: { contains: query.search,mode: 'insensitive' as const } } : {}) };
      const [rows,total] = await Promise.all([tx.inventorySerialNumber.findMany({ where,orderBy: [{ serialNumber: 'asc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.inventorySerialNumber.count({ where })]);
      return { data: rows,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async serial(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.TRACKING_MANAGE'); const input = parse(z.strictObject({ variantId: uuid,serialNumber: identifier,warehouseId: uuid }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.TRACKING_MANAGE');
      await this.warehouses.warehouse(tx,actor,input.warehouseId,'INVENTORY.TRACKING_MANAGE',true);
      const catalog = await inventoryCatalogPort(tx,actor),sku = catalog.sku(catalog.variantParent(input.variantId),input.variantId);
      await lock(tx,actor.workspaceId,'inventory:warehouse:' + input.warehouseId); await lock(tx,actor.workspaceId,'inventory:stock:' + input.warehouseId + ':' + sku.inventoryKey);
      const duplicate = await tx.inventorySerialNumber.count({ where: { workspaceId: actor.workspaceId,inventoryKey: sku.inventoryKey,serialNumber: input.serialNumber } });
      if (duplicate) throw new AppError('SERIAL_NUMBER_EXISTS','Serial number already exists for this SKU.',409);
      const balance = await tx.inventoryBalance.aggregate({ where: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,inventoryKey: sku.inventoryKey },_sum: { onHand: true } });
      const registered = await tx.inventorySerialNumber.count({ where: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,inventoryKey: sku.inventoryKey,status: { in: ['IN_STOCK','RESERVED','RETURNED','DAMAGED'] } } });
      if (exact(balance._sum.onHand ?? '0').lt(registered+1)) throw new AppError('SERIAL_RECEIPT_REQUIRED','Posted stock does not cover another serial unit.',409);
      const movements = await tx.inventoryMovement.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,inventoryKey: sku.inventoryKey,
        quantityDelta: { gt: 0 },reversesMovementId: null,type: { in: ['STOCK_RECEIPT_IN','CUSTOMER_RETURN_IN','STOCK_ADJUSTMENT_IN'] } },orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }] });
      for (const movement of movements) {
        const document = await this.documents.document(tx,actor,movement.documentId,'INVENTORY.DOCUMENT_READ');
        if (document.status!=='PROCESSED' || document.reversedAt) continue;
        const count = await tx.inventorySerialNumber.count({ where: { workspaceId: actor.workspaceId,receiptDocumentLineId: movement.documentLineId } });
        if (exact(movement.quantityDelta).lt(count+1)) continue;
        const row = await tx.inventorySerialNumber.create({ data: { workspaceId: actor.workspaceId,productId: sku.productId,variantId: sku.variantId,inventoryKey: sku.inventoryKey,
          serialNumber: input.serialNumber,warehouseId: input.warehouseId,receiptDocumentLineId: movement.documentLineId } });
        await evidence(tx,actor,'PRODUCT',sku.inventoryKey,'INVENTORY_SERIAL_REGISTERED',{ serialId: row.id,warehouseId: input.warehouseId,receiptDocumentLineId: movement.documentLineId }); return row;
      }
      throw new AppError('SERIAL_RECEIPT_REQUIRED','An eligible receipt unit is required.',422);
    },{ timeout: 60000 });
  }
  async batches(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.TRACKING_READ'); const query = parse(pageQuery.extend({ productId: uuid.optional(),expiresBefore: z.iso.datetime({ offset: true }).optional() }),raw);
    return this.db.$transaction(async tx => {
      if (!(await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.TRACKING_READ',false)).length) throw new AppError('WAREHOUSE_ACCESS_DENIED','No warehouse is accessible.',403);
      const where = { workspaceId: actor.workspaceId,productId: query.productId,...(query.expiresBefore ? { expiresAt: { lte: new Date(query.expiresBefore) } } : {}),
        ...(query.search ? { batchNumber: { contains: query.search,mode: 'insensitive' as const } } : {}) };
      const rows = await tx.inventoryBatch.findMany({ where,orderBy: [{ batchNumber: 'asc' },{ id: 'asc' }] }),catalog = await inventoryCatalogPort(tx,actor),visible = [];
      for (const row of rows) { catalog.sku(row.productId,row.variantId ?? undefined,false); visible.push(row); }
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async batch(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.TRACKING_MANAGE'); const input = parse(z.strictObject({ variantId: uuid,batchNumber: identifier,expiresAt: z.iso.datetime({ offset: true }).optional() }),raw);
    if (input.expiresAt && new Date(input.expiresAt)<=new Date()) throw new AppError('BATCH_EXPIRY_INVALID','Register a future expiry date.',422);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.TRACKING_MANAGE');
      if (!(await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.TRACKING_MANAGE')).length) throw new AppError('WAREHOUSE_ACCESS_DENIED','No warehouse is accessible.',403);
      const catalog = await inventoryCatalogPort(tx,actor),sku = catalog.sku(catalog.variantParent(input.variantId),input.variantId);
      if (await tx.inventoryBatch.count({ where: { workspaceId: actor.workspaceId,inventoryKey: sku.inventoryKey,batchNumber: input.batchNumber } })) throw new AppError('BATCH_NUMBER_EXISTS','Batch already exists for this SKU.',409);
      const row = await tx.inventoryBatch.create({ data: { workspaceId: actor.workspaceId,productId: sku.productId,variantId: sku.variantId,inventoryKey: sku.inventoryKey,batchNumber: input.batchNumber,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined } });
      await evidence(tx,actor,'PRODUCT',sku.inventoryKey,'INVENTORY_BATCH_REGISTERED',{ batchId: row.id }); return row;
    });
  }
}
