import { randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import type { Tx } from '../process-platform/context';
import type { InventoryMovement, Prisma } from '@prisma/client';
import { exact,numeric24 } from './decimal';

export type CostScope = { workspaceId: string;warehouseId: string;inventoryKey: string;currency: string;generation: number };
type Part = { quantity: string;unitCost: string;totalCost: string };
/** Internal valuation repository. The posting owner locks the document and warehouse/SKU keys before calling it. */
export class InventoryCostBook {
  /** Provisional cost for issue beyond valuation: the latest receipt cost in this valuation scope, never a guessed price. */
  private async provisionalUnitCost(tx: Tx,scope: CostScope) {
    const latest = await tx.inventoryMovement.findFirst({ where: { workspaceId: scope.workspaceId,warehouseId: scope.warehouseId,inventoryKey: scope.inventoryKey,
      currency: scope.currency,valuationGeneration: scope.generation,quantityDelta: { gt: 0 },reversesMovementId: null },orderBy: { ledgerSequence: 'desc' } });
    return latest ? latest.unitCost.toFixed(6) : '0.000000';
  }
  async previewIssue(tx: Tx,scope: CostScope,method: string,quantity: string,allowNegative = false) {
    const qty = exact(quantity);
    if (method==='AVERAGE') {
      const average = await tx.inventoryAverageCost.findUnique({ where: { workspaceId_warehouseId_inventoryKey_currency_generation: scope } });
      const covered = exact(average?.quantity ?? '0');
      if (qty.gt(covered)) {
        if (!allowNegative) throw new AppError('COSTING_LAYER_SHORTAGE','Valuation does not cover the proposed issue.',409);
        return numeric24(exact(average?.totalValue ?? '0').plus(numeric24(qty.minus(covered).mul(await this.provisionalUnitCost(tx,scope)))));
      }
      return numeric24(qty.eq(average!.quantity) ? average!.totalValue : exact(average!.totalValue).mul(qty).div(average!.quantity));
    }
    const layers = await tx.inventoryCostLayer.findMany({ where: { ...scope,remainingQuantity: { gt: 0 } },orderBy: [{ receivedAt: 'asc' },{ ordinal: 'asc' },{ id: 'asc' }] });
    let needed = qty,total = exact('0');
    for (const layer of layers) {
      if (needed.eq(0)) break;
      const amount = needed.lt(layer.remainingQuantity) ? needed : exact(layer.remainingQuantity);
      total = total.plus(amount.eq(layer.remainingQuantity) ? layer.remainingValue : numeric24(exact(layer.remainingValue).mul(amount).div(layer.remainingQuantity)));
      needed = needed.minus(amount);
    }
    if (needed.gt(0)) {
      if (!allowNegative) throw new AppError('COSTING_LAYER_SHORTAGE','FIFO valuation does not cover the proposed issue.',409);
      total = total.plus(numeric24(needed.mul(await this.provisionalUnitCost(tx,scope))));
    }
    return numeric24(total);
  }
  async reverse(tx: Tx,scope: CostScope,method: string,original: InventoryMovement,reversalMovementId: string) {
    if (original.valuationGeneration!==scope.generation || original.costingMethod!==method) throw new AppError('COSTING_MIGRATION_REQUIRED','Reversal crosses a valuation migration and requires controlled reconciliation.',409);
    let qty = exact(original.quantityDelta).abs(),value = exact(original.totalCost).abs();
    const receipt = exact(original.quantityDelta).gt(0);
    if (receipt && await tx.inventoryCostDeficitSettlement.count({ where: { workspaceId: scope.workspaceId,receiptMovementId: original.id } }))
      throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','This receipt settled negative-stock cost; correct it with an adjustment.',409);
    if (!receipt) {
      const deficit = await tx.inventoryCostDeficit.findUnique({ where: { workspaceId_issueMovementId: { workspaceId: scope.workspaceId,issueMovementId: original.id } } });
      if (deficit) {
        if (!exact(deficit.remainingQuantity).eq(deficit.quantity) || deficit.cancelledByMovementId)
          throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Negative-stock cost of this issue was already settled; correct it with an adjustment.',409);
        await tx.inventoryCostDeficit.update({ where: { id: deficit.id },data: { remainingQuantity: '0',cancelledByMovementId: reversalMovementId } });
        // Only the layer-covered part of the issue returns to valuation.
        qty = qty.minus(deficit.quantity); value = value.minus(numeric24(exact(deficit.quantity).mul(deficit.provisionalUnitCost)));
        if (qty.eq(0)) return;
      }
    }
    if (method==='AVERAGE') {
      const current = await tx.inventoryAverageCost.findUnique({ where: { workspaceId_warehouseId_inventoryKey_currency_generation: scope } });
      if (!current) throw new AppError('COSTING_RECONCILIATION_FAILED','Average valuation is unavailable.',409);
      const nextQty = exact(current.quantity).plus(receipt ? qty.neg() : qty),nextValue = exact(current.totalValue).plus(receipt ? value.neg() : value);
      if (nextQty.lt(0) || nextValue.lt(0) || nextQty.eq(0) && !nextValue.eq(0)) throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Reversal would leave inconsistent valuation.',409);
      await tx.inventoryAverageCost.update({ where: { id: current.id },data: { quantity: numeric24(nextQty),totalValue: numeric24(nextValue),
        averageCost: nextQty.eq(0) ? '0' : numeric24(nextValue.div(nextQty)),version: { increment: 1 } } }); return;
    }
    if (method!=='FIFO') throw new AppError('COSTING_NOT_INITIALIZED','Costing policy is unavailable.',409);
    if (receipt) {
      const layers = await tx.inventoryCostLayer.findMany({ where: { ...scope,sourceMovementId: original.id },orderBy: { ordinal: 'asc' } });
      if (!layers.length || layers.some(l => !exact(l.remainingQuantity).eq(l.originalQuantity) || !exact(l.remainingValue).eq(l.originalValue)))
        throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Receipt layers were consumed; reverse dependent documents first.',409);
      for (const layer of layers) {
        await tx.inventoryCostLayer.update({ where: { id: layer.id },data: { remainingQuantity: '0',remainingValue: '0' } });
        await tx.inventoryCostAllocation.create({ data: { workspaceId: scope.workspaceId,movementId: reversalMovementId,layerId: layer.id,
          quantity: layer.originalQuantity,unitCost: layer.unitCost,totalCost: layer.originalValue } });
      }
    } else {
      const allocations = await tx.inventoryCostAllocation.findMany({ where: { workspaceId: scope.workspaceId,movementId: original.id } });
      if (!allocations.reduce((sum,a) => sum.plus(a.quantity),exact('0')).eq(qty) || !allocations.reduce((sum,a) => sum.plus(a.totalCost),exact('0')).eq(value))
        throw new AppError('COSTING_RECONCILIATION_FAILED','Original issue allocations do not reconcile.',409);
      for (const allocation of allocations) {
        const layer = await tx.inventoryCostLayer.findFirstOrThrow({ where: { ...scope,id: allocation.layerId } });
        await tx.inventoryCostLayer.update({ where: { id: layer.id },data: { remainingQuantity: numeric24(exact(layer.remainingQuantity).plus(allocation.quantity)),
          remainingValue: numeric24(exact(layer.remainingValue).plus(allocation.totalCost)) } });
      }
    }
  }
  async receipt(tx: Tx,scope: CostScope,method: string,input: { quantity: string;unitCost: string;totalCost: string;movementId: string;documentLineId: string;occurredAt: Date;
    parts?: { quantity: string;unitCost: string;totalCost: string }[] }) {
    const qty = exact(input.quantity),value = exact(input.totalCost);
    if (qty.lte(0) || value.lt(0)) throw new AppError('INVENTORY_LINE_INVALID','Receipt valuation is invalid.',422);
    const foreignCurrency = method==='FIFO' ? await tx.inventoryCostLayer.count({ where: { workspaceId: scope.workspaceId,warehouseId: scope.warehouseId,inventoryKey: scope.inventoryKey,
      generation: scope.generation,remainingQuantity: { gt: 0 },currency: { not: scope.currency } } })
      : await tx.inventoryAverageCost.count({ where: { workspaceId: scope.workspaceId,warehouseId: scope.warehouseId,inventoryKey: scope.inventoryKey,generation: scope.generation,
        quantity: { not: 0 },currency: { not: scope.currency } } });
    if (foreignCurrency || await tx.inventoryCostDeficit.count({ where: { workspaceId: scope.workspaceId,warehouseId: scope.warehouseId,inventoryKey: scope.inventoryKey,
      generation: scope.generation,remainingQuantity: { gt: 0 },currency: { not: scope.currency } } }))
      throw new AppError('COSTING_CURRENCY_INVALID','Convert using an approved historical FX reference before posting.',422);
    const given = input.parts?.length ? input.parts : [{ quantity: input.quantity,unitCost: input.unitCost,totalCost: input.totalCost }];
    if (!given.reduce((sum,p) => sum.plus(p.quantity),exact('0')).eq(qty) || !given.reduce((sum,p) => sum.plus(p.totalCost),exact('0')).eq(value))
      throw new AppError('COSTING_RECONCILIATION_FAILED','Transfer valuation legs do not reconcile.',409);
    const parts = await this.settleDeficits(tx,scope,given,input.movementId,input.occurredAt);
    if (!parts.length) return;
    if (method==='FIFO') {
      for (const [ordinal,part] of parts.entries()) await tx.inventoryCostLayer.create({ data: { ...scope,sourceDocumentLineId: input.documentLineId,sourceMovementId: input.movementId,ordinal,
        originalQuantity: part.quantity,remainingQuantity: part.quantity,unitCost: part.unitCost,originalValue: part.totalCost,remainingValue: part.totalCost,receivedAt: input.occurredAt } });
    } else if (method==='AVERAGE') {
      const key = { workspaceId_warehouseId_inventoryKey_currency_generation: scope };
      const current = await tx.inventoryAverageCost.findUnique({ where: key });
      const nextQty = exact(current?.quantity ?? '0').plus(parts.reduce((sum,p) => sum.plus(p.quantity),exact('0')));
      const nextValue = exact(current?.totalValue ?? '0').plus(parts.reduce((sum,p) => sum.plus(p.totalCost),exact('0')));
      if (nextQty.lte(0) || nextValue.lt(0)) throw new AppError('COSTING_RECONCILIATION_FAILED','Opening valuation requires reconciliation.',409);
      await tx.inventoryAverageCost.upsert({ where: key,create: { ...scope,quantity: numeric24(nextQty),totalValue: numeric24(nextValue),averageCost: numeric24(nextValue.div(nextQty)) },
        update: { quantity: numeric24(nextQty),totalValue: numeric24(nextValue),averageCost: numeric24(nextValue.div(nextQty)),version: { increment: 1 } } });
    } else throw new AppError('COSTING_NOT_INITIALIZED','Costing policy is unavailable.',409);
  }
  /** A receipt first settles outstanding negative-stock deficits (oldest first), recording the exact cost variance; the rest enters valuation. */
  private async settleDeficits(tx: Tx,scope: CostScope,parts: Part[],receiptMovementId: string,occurredAt: Date): Promise<Part[]> {
    const deficits = await tx.inventoryCostDeficit.findMany({ where: { ...scope,remainingQuantity: { gt: 0 } },orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }] });
    if (!deficits.length) return parts;
    const remaining: Part[] = [];
    for (const part of parts) {
      let qty = exact(part.quantity),value = exact(part.totalCost);
      for (const deficit of deficits) {
        const open = exact(deficit.remainingQuantity);
        if (qty.eq(0) || open.eq(0)) continue;
        const take = qty.lt(open) ? qty : open,settledValue = take.eq(qty) ? value : exact(numeric24(value.mul(take).div(qty)));
        const unitCost = numeric24(settledValue.div(take));
        await tx.inventoryCostDeficitSettlement.create({ data: { workspaceId: scope.workspaceId,deficitId: deficit.id,receiptMovementId,quantity: numeric24(take),
          actualUnitCost: unitCost,varianceValue: numeric24(settledValue.minus(numeric24(take.mul(deficit.provisionalUnitCost)))),occurredAt } });
        await tx.inventoryCostDeficit.update({ where: { id: deficit.id },data: { remainingQuantity: numeric24(open.minus(take)) } });
        deficit.remainingQuantity = open.minus(take) as never;
        qty = qty.minus(take); value = value.minus(settledValue);
      }
      if (qty.gt(0)) remaining.push({ quantity: numeric24(qty),unitCost: numeric24(value.div(qty)),totalCost: numeric24(value) });
    }
    return remaining;
  }
  private async deficit(tx: Tx,scope: CostScope,quantity: Prisma.Decimal,movementId: string) {
    const provisional = await this.provisionalUnitCost(tx,scope);
    await tx.inventoryCostDeficit.create({ data: { ...scope,issueMovementId: movementId,quantity: numeric24(quantity),remainingQuantity: numeric24(quantity),
      provisionalUnitCost: provisional,occurredAt: new Date() } });
    return exact(numeric24(quantity.mul(provisional)));
  }
  async issue(tx: Tx,scope: CostScope,method: string,quantity: string,movementId: string,allowNegative = false) {
    const qty = exact(quantity);
    if (qty.lte(0)) throw new AppError('INVENTORY_LINE_INVALID','Issue quantity must be positive.',422);
    if (method==='AVERAGE') {
      const current = await tx.inventoryAverageCost.findUnique({ where: { workspaceId_warehouseId_inventoryKey_currency_generation: scope } });
      const covered = exact(current?.quantity ?? '0');
      if (covered.lt(qty)) {
        if (!allowNegative) throw new AppError('COSTING_LAYER_SHORTAGE','Valuation does not cover this issue.',409);
        // Negative physical stock: consume the whole valuation and cost the uncovered quantity provisionally.
        let total = exact(current?.totalValue ?? '0');
        if (current && covered.gt(0)) await tx.inventoryAverageCost.update({ where: { id: current.id },data: { quantity: '0',totalValue: '0',version: { increment: 1 } } });
        total = total.plus(await this.deficit(tx,scope,qty.minus(covered),movementId));
        return { unitCost: numeric24(total.div(qty)),totalCost: numeric24(total),allocations: [] as { layerId: string;quantity: string;totalCost: string;unitCost: string }[] };
      }
      if (!current) throw new AppError('COSTING_LAYER_SHORTAGE','Valuation does not cover this issue.',409);
      const onHand = exact(current.quantity),value = exact(current.totalValue),remainingQty = onHand.minus(qty);
      const consumed = qty.eq(onHand) ? value : exact(numeric24(value.mul(qty).div(onHand)));
      const remainingValue = value.minus(consumed);
      await tx.inventoryAverageCost.update({ where: { id: current.id },data: { quantity: numeric24(remainingQty),totalValue: numeric24(remainingValue),
        averageCost: remainingQty.eq(0) ? '0' : numeric24(remainingValue.div(remainingQty)),version: { increment: 1 } } });
      return { unitCost: numeric24(consumed.div(qty)),totalCost: numeric24(consumed),allocations: [] as { layerId: string;quantity: string;totalCost: string;unitCost: string }[] };
    }
    if (method!=='FIFO') throw new AppError('COSTING_NOT_INITIALIZED','Costing policy is unavailable.',409);
    const layers = await tx.inventoryCostLayer.findMany({ where: { ...scope,remainingQuantity: { gt: 0 } },orderBy: [{ receivedAt: 'asc' },{ ordinal: 'asc' },{ id: 'asc' }] });
    if (layers.reduce((sum,l) => sum.plus(l.remainingQuantity),exact('0')).lt(qty) && !allowNegative) throw new AppError('COSTING_LAYER_SHORTAGE','FIFO layers do not cover this issue.',409);
    let remaining = qty,total = exact('0');
    const allocations: { layerId: string;quantity: string;totalCost: string;unitCost: string }[] = [];
    for (const layer of layers) {
      if (remaining.eq(0)) break;
      const layerQty = exact(layer.remainingQuantity),layerValue = exact(layer.remainingValue),take = remaining.lt(layerQty) ? remaining : layerQty;
      const cost = take.eq(layerQty) ? layerValue : exact(numeric24(layerValue.mul(take).div(layerQty)));
      const allocation = { layerId: layer.id,quantity: numeric24(take),totalCost: numeric24(cost),unitCost: numeric24(cost.div(take)) };
      allocations.push(allocation); total = total.plus(cost); remaining = remaining.minus(take);
      await tx.inventoryCostLayer.update({ where: { id: layer.id },data: { remainingQuantity: numeric24(layerQty.minus(take)),remainingValue: numeric24(layerValue.minus(cost)) } });
      await tx.inventoryCostAllocation.create({ data: { id: randomUUID(),workspaceId: scope.workspaceId,movementId,...allocation } });
    }
    if (remaining.gt(0)) total = total.plus(await this.deficit(tx,scope,remaining,movementId));
    return { unitCost: numeric24(total.div(qty)),totalCost: numeric24(total),allocations };
  }
}
