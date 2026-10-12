import { randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import type { Tx } from '../process-platform/context';
import type { InventoryMovement } from '@prisma/client';
import { exact,numeric24 } from './decimal';

export type CostScope = { workspaceId: string;warehouseId: string;inventoryKey: string;currency: string;generation: number };
/** Internal valuation repository. The posting owner locks the document and warehouse/SKU keys before calling it. */
export class InventoryCostBook {
  async previewIssue(tx: Tx,scope: CostScope,method: string,quantity: string) {
    const qty = exact(quantity);
    if (method==='AVERAGE') {
      const average = await tx.inventoryAverageCost.findUnique({ where: { workspaceId_warehouseId_inventoryKey_currency_generation: scope } });
      if (!average || qty.gt(average.quantity)) throw new AppError('COSTING_LAYER_SHORTAGE','Valuation does not cover the proposed issue.',409);
      return numeric24(qty.eq(average.quantity) ? average.totalValue : exact(average.totalValue).mul(qty).div(average.quantity));
    }
    const layers = await tx.inventoryCostLayer.findMany({ where: { ...scope,remainingQuantity: { gt: 0 } },orderBy: [{ receivedAt: 'asc' },{ ordinal: 'asc' },{ id: 'asc' }] });
    let needed = qty,total = exact('0');
    for (const layer of layers) {
      if (needed.eq(0)) break;
      const amount = needed.lt(layer.remainingQuantity) ? needed : exact(layer.remainingQuantity);
      total = total.plus(amount.eq(layer.remainingQuantity) ? layer.remainingValue : numeric24(exact(layer.remainingValue).mul(amount).div(layer.remainingQuantity)));
      needed = needed.minus(amount);
    }
    if (needed.gt(0)) throw new AppError('COSTING_LAYER_SHORTAGE','FIFO valuation does not cover the proposed issue.',409);
    return numeric24(total);
  }
  async reverse(tx: Tx,scope: CostScope,method: string,original: InventoryMovement,reversalMovementId: string) {
    if (original.valuationGeneration!==scope.generation || original.costingMethod!==method) throw new AppError('COSTING_MIGRATION_REQUIRED','Reversal crosses a valuation migration and requires controlled reconciliation.',409);
    const qty = exact(original.quantityDelta).abs(),value = exact(original.totalCost).abs(),receipt = exact(original.quantityDelta).gt(0);
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
    if (foreignCurrency) throw new AppError('COSTING_CURRENCY_INVALID','Convert using an approved historical FX reference before posting.',422);
    if (method==='FIFO') {
      const parts = input.parts?.length ? input.parts : [{ quantity: input.quantity,unitCost: input.unitCost,totalCost: input.totalCost }];
      if (!parts.reduce((sum,p) => sum.plus(p.quantity),exact('0')).eq(qty) || !parts.reduce((sum,p) => sum.plus(p.totalCost),exact('0')).eq(value))
        throw new AppError('COSTING_RECONCILIATION_FAILED','Transfer valuation legs do not reconcile.',409);
      for (const [ordinal,part] of parts.entries()) await tx.inventoryCostLayer.create({ data: { ...scope,sourceDocumentLineId: input.documentLineId,sourceMovementId: input.movementId,ordinal,
        originalQuantity: part.quantity,remainingQuantity: part.quantity,unitCost: part.unitCost,originalValue: part.totalCost,remainingValue: part.totalCost,receivedAt: input.occurredAt } });
    } else if (method==='AVERAGE') {
      const key = { workspaceId_warehouseId_inventoryKey_currency_generation: scope };
      const current = await tx.inventoryAverageCost.findUnique({ where: key });
      const nextQty = exact(current?.quantity ?? '0').plus(qty),nextValue = exact(current?.totalValue ?? '0').plus(value);
      if (nextQty.lte(0) || nextValue.lt(0)) throw new AppError('COSTING_RECONCILIATION_FAILED','Opening valuation requires reconciliation.',409);
      await tx.inventoryAverageCost.upsert({ where: key,create: { ...scope,quantity: numeric24(nextQty),totalValue: numeric24(nextValue),averageCost: numeric24(nextValue.div(nextQty)) },
        update: { quantity: numeric24(nextQty),totalValue: numeric24(nextValue),averageCost: numeric24(nextValue.div(nextQty)),version: { increment: 1 } } });
    } else throw new AppError('COSTING_NOT_INITIALIZED','Costing policy is unavailable.',409);
  }
  async issue(tx: Tx,scope: CostScope,method: string,quantity: string,movementId: string) {
    const qty = exact(quantity);
    if (qty.lte(0)) throw new AppError('INVENTORY_LINE_INVALID','Issue quantity must be positive.',422);
    if (method==='AVERAGE') {
      const current = await tx.inventoryAverageCost.findUnique({ where: { workspaceId_warehouseId_inventoryKey_currency_generation: scope } });
      if (!current || exact(current.quantity).lt(qty)) throw new AppError('COSTING_LAYER_SHORTAGE','Valuation does not cover this issue.',409);
      const onHand = exact(current.quantity),value = exact(current.totalValue),remainingQty = onHand.minus(qty);
      const consumed = qty.eq(onHand) ? value : exact(numeric24(value.mul(qty).div(onHand)));
      const remainingValue = value.minus(consumed);
      await tx.inventoryAverageCost.update({ where: { id: current.id },data: { quantity: numeric24(remainingQty),totalValue: numeric24(remainingValue),
        averageCost: remainingQty.eq(0) ? '0' : numeric24(remainingValue.div(remainingQty)),version: { increment: 1 } } });
      return { unitCost: numeric24(consumed.div(qty)),totalCost: numeric24(consumed),allocations: [] as { layerId: string;quantity: string;totalCost: string;unitCost: string }[] };
    }
    if (method!=='FIFO') throw new AppError('COSTING_NOT_INITIALIZED','Costing policy is unavailable.',409);
    const layers = await tx.inventoryCostLayer.findMany({ where: { ...scope,remainingQuantity: { gt: 0 } },orderBy: [{ receivedAt: 'asc' },{ ordinal: 'asc' },{ id: 'asc' }] });
    if (layers.reduce((sum,l) => sum.plus(l.remainingQuantity),exact('0')).lt(qty)) throw new AppError('COSTING_LAYER_SHORTAGE','FIFO layers do not cover this issue.',409);
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
    return { unitCost: numeric24(total.div(qty)),totalCost: numeric24(total),allocations };
  }
}
