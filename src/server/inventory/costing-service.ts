import { Prisma,type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { InventoryWarehouseService } from './warehouse-service';

export class InventoryCostingService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db)) {}
  async policy(actor: Principal) {
    requirePermission(actor,'INVENTORY.COSTING_VIEW');
    const row = await this.db.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } });
    return { method: row?.costingMethod ?? 'FIFO',locked: row?.costingLocked ?? false,generation: row?.valuationGeneration ?? 1,version: row?.version.toString() ?? '0' };
  }
  async initialize(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.COSTING_MANAGE',true); const input = parse(z.strictObject({ method: z.enum(['FIFO','AVERAGE']) }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.COSTING_MANAGE',true);
      const current = await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } });
      if (current?.costingLocked || await tx.inventoryMovement.count({ where: { workspaceId: actor.workspaceId } })) throw new AppError('COSTING_METHOD_LOCKED','Costing changes require an approved migration.',409);
      const row = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId,costingMethod: input.method },update: { costingMethod: input.method,version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_SETTINGS',actor.workspaceId,'INVENTORY_COSTING_INITIALIZED',{ method: input.method,version: row.version.toString() });
      return { method: row.costingMethod,locked: row.costingLocked,version: row.version.toString() };
    });
  }
  async valuation(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.VALUATION_VIEW'); const query = parse(z.strictObject({ warehouseId: uuid.optional(),productId: uuid.optional(),asOf: z.iso.datetime({ offset: true }).optional() }),raw);
    return this.db.$transaction(async tx => {
      const ids = query.warehouseId ? [(await this.warehouses.warehouse(tx,actor,query.warehouseId,'INVENTORY.VALUATION_VIEW')).id]
        : (await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.VALUATION_VIEW',false)).map(w => w.id);
      const rows = await tx.inventoryMovement.groupBy({ by: ['warehouseId','inventoryKey','productId','variantId','currency'],
        where: { workspaceId: actor.workspaceId,warehouseId: { in: ids },productId: query.productId,...(query.asOf ? { occurredAt: { lte: new Date(query.asOf) } } : {}) },
        _sum: { quantityDelta: true,totalCost: true },orderBy: [{ warehouseId: 'asc' },{ inventoryKey: 'asc' },{ currency: 'asc' }] });
      // Settled negative-stock deficits move their cost variance out of on-hand valuation (into cost of goods).
      const settlements = await tx.inventoryCostDeficitSettlement.findMany({ where: { workspaceId: actor.workspaceId,...(query.asOf ? { occurredAt: { lte: new Date(query.asOf) } } : {}) } });
      const deficits = settlements.length ? await tx.inventoryCostDeficit.findMany({ where: { workspaceId: actor.workspaceId,id: { in: [...new Set(settlements.map(s => s.deficitId))] },warehouseId: { in: ids } } }) : [];
      const variance = new Map<string,Prisma.Decimal>();
      for (const settlement of settlements) {
        const deficit = deficits.find(d => d.id===settlement.deficitId); if (!deficit) continue;
        const key = deficit.warehouseId+':'+deficit.inventoryKey+':'+deficit.currency;
        variance.set(key,(variance.get(key) ?? new Prisma.Decimal(0)).plus(settlement.varianceValue));
      }
      return { asOf: query.asOf ?? new Date().toISOString(),valuations: rows.map(row => ({ warehouseId: row.warehouseId,inventoryKey: row.inventoryKey,
        productId: row.productId,variantId: row.variantId,currency: row.currency,onHand: row._sum.quantityDelta?.toFixed(6) ?? '0.000000',
        totalValue: new Prisma.Decimal(row._sum.totalCost ?? 0).minus(variance.get(row.warehouseId+':'+row.inventoryKey+':'+row.currency) ?? 0).toFixed(6) })) };
    });
  }
}
