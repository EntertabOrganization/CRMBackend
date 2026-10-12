import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid,pageQuery } from '../process-platform/dto';
import { quantity,positiveQuantity,inventoryVersion,assertInventoryVersion } from './dto';
import { exact,numeric24 } from './decimal';
import { InventoryWarehouseService } from './warehouse-service';
import { inventoryCatalogPort } from './catalog-port';

/** Called once an owning command's physical/reserved projections have reached their final state.
 * Configuration and warehouse/SKU locks must already be held by the caller. */
export async function observeReorder(tx: Tx,actor: Principal,warehouseId: string,inventoryKey: string) {
  const rule = await tx.inventoryReorderSetting.findUnique({ where: { workspaceId_warehouseId_inventoryKey: { workspaceId: actor.workspaceId,warehouseId,inventoryKey } } });
  if (!rule) return;
  const totals = await tx.inventoryBalance.aggregate({ where: { workspaceId: actor.workspaceId,warehouseId,inventoryKey },_sum: { onHand: true,reserved: true } });
  const available = exact(totals._sum.onHand ?? '0').minus(totals._sum.reserved ?? '0');
  const open = await tx.inventoryLowStockAlert.findFirst({ where: { workspaceId: actor.workspaceId,warehouseId,inventoryKey,resolvedAt: null } });
  if (!open && available.lte(rule.reorderPoint)) {
    const alert = await tx.inventoryLowStockAlert.create({ data: { workspaceId: actor.workspaceId,warehouseId,inventoryKey,threshold: rule.reorderPoint } });
    await evidence(tx,actor,'INVENTORY_REORDER_RULE',rule.id,'INVENTORY_LOW_STOCK',{ alertId: alert.id,warehouseId,inventoryKey,
      available: numeric24(available),threshold: rule.reorderPoint.toFixed(6),reorderQuantity: rule.reorderQuantity.toFixed(6) },false);
  } else if (open && available.gt(exact(rule.reorderPoint).plus(rule.safetyStock))) {
    await tx.inventoryLowStockAlert.update({ where: { id: open.id },data: { resolvedAt: new Date() } });
    await evidence(tx,actor,'INVENTORY_REORDER_RULE',rule.id,'INVENTORY_LOW_STOCK_RECOVERED',{ alertId: open.id,warehouseId,inventoryKey,available: numeric24(available) },false);
  }
}

export class InventoryReorderService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db)) {}
  async list(actor: Principal,raw: unknown,alerts = false) {
    requirePermission(actor,'INVENTORY.REORDER_READ');
    const query = parse(pageQuery.extend({ warehouseId: uuid.optional(),...(alerts ? { status: z.enum(['OPEN','RESOLVED','ALL']).default('OPEN') } : {}) }),raw);
    return this.db.$transaction(async tx => {
      const ids = query.warehouseId ? [(await this.warehouses.warehouse(tx,actor,query.warehouseId,'INVENTORY.REORDER_READ')).id]
        : (await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.REORDER_READ',false)).map(row => row.id);
      if (alerts) {
        const status = 'status' in query ? query.status : 'OPEN';
        const where = { workspaceId: actor.workspaceId,warehouseId: { in: ids },...(status==='OPEN' ? { resolvedAt: null } : status==='RESOLVED' ? { resolvedAt: { not: null } } : {}) };
        const [data,total] = await Promise.all([tx.inventoryLowStockAlert.findMany({ where,orderBy: [{ openSince: 'desc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.inventoryLowStockAlert.count({ where })]);
        return { data,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
      }
      const where = { workspaceId: actor.workspaceId,warehouseId: { in: ids } };
      const [data,total] = await Promise.all([tx.inventoryReorderSetting.findMany({ where,orderBy: [{ warehouseId: 'asc' },{ inventoryKey: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.inventoryReorderSetting.count({ where })]);
      return { data,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async upsert(actor: Principal,id: string,raw: unknown) {
    parse(uuid,id); requirePermission(actor,'INVENTORY.REORDER_MANAGE');
    const input = parse(z.strictObject({ warehouseId: uuid,productId: uuid,variantId: uuid.optional(),reorderPoint: quantity,reorderQuantity: positiveQuantity,safetyStock: quantity,
      expectedVersion: z.union([inventoryVersion,z.literal('0')]).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.REORDER_MANAGE');
      await this.warehouses.warehouse(tx,actor,input.warehouseId,'INVENTORY.REORDER_MANAGE',true);
      const sku = (await inventoryCatalogPort(tx,actor)).sku(input.productId,input.variantId);
      for (const value of [input.reorderPoint,input.reorderQuantity,input.safetyStock]) if (exact(value).decimalPlaces()>sku.unitPrecision)
        throw new AppError('INVENTORY_REORDER_RULE_INVALID','Rule quantities exceed Catalog unit precision.',422);
      await lock(tx,actor.workspaceId,'inventory:warehouse:' + input.warehouseId); await lock(tx,actor.workspaceId,'inventory:stock:' + input.warehouseId + ':' + sku.inventoryKey);
      const current = await tx.inventoryReorderSetting.findFirst({ where: { workspaceId: actor.workspaceId,id } });
      if (current && (current.warehouseId!==input.warehouseId || current.inventoryKey!==sku.inventoryKey))
        throw new AppError('INVENTORY_REORDER_RULE_INVALID','An existing rule cannot be moved to a different warehouse or SKU.',409);
      if (input.expectedVersion!==undefined) assertInventoryVersion(current?.version ?? 0n,input.expectedVersion);
      if (!current && await tx.inventoryReorderSetting.count({ where: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,inventoryKey: sku.inventoryKey } }))
        throw new AppError('INVENTORY_REORDER_RULE_INVALID','A rule already exists for this warehouse and SKU.',409);
      const values = { reorderPoint: input.reorderPoint,reorderQuantity: input.reorderQuantity,safetyStock: input.safetyStock };
      const row = current ? await tx.inventoryReorderSetting.update({ where: { id },data: { ...values,version: { increment: 1 } } })
        : await tx.inventoryReorderSetting.create({ data: { id,workspaceId: actor.workspaceId,warehouseId: input.warehouseId,productId: sku.productId,variantId: sku.variantId,inventoryKey: sku.inventoryKey,...values } });
      await evidence(tx,actor,'INVENTORY_REORDER_RULE',id,'INVENTORY_REORDER_RULE_CHANGED',{ warehouseId: row.warehouseId,inventoryKey: row.inventoryKey,
        before: current ? { reorderPoint: current.reorderPoint.toFixed(6),reorderQuantity: current.reorderQuantity.toFixed(6),safetyStock: current.safetyStock.toFixed(6) } : null,after: values,version: row.version.toString() });
      await observeReorder(tx,actor,row.warehouseId,row.inventoryKey); return row;
    });
  }
}
