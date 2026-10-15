import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../../src/server/process-platform/context';
import { InventoryDocumentService } from '../../src/server/inventory/document-service';
import { InventoryReservationService } from '../../src/server/inventory/reservation-service';

/** Catalog SKU plus a Warehouse stocked through a real posted STOCK_RECEIPT (append-only ledger). */
export async function stockFixture(db: PrismaClient, actor: Principal, options: { quantity?: string; unitCost?: string; code?: string; precision?: number } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const catalog = await db.catalog.create({ data: { workspaceId: actor.workspaceId, name: 'Stock ' + suffix, normalizedName: 'stock ' + suffix } });
  const unit = await db.catalogUnit.create({ data: { workspaceId: actor.workspaceId, name: 'Each ' + suffix, code: 'EA' + suffix.slice(0, 4).toUpperCase(), precision: options.precision ?? 0 } });
  const product = await db.catalogProduct.create({ data: { workspaceId: actor.workspaceId, catalogId: catalog.id, type: 'SIMPLE_PRODUCT', name: 'Stocked ' + suffix,
    sku: 'SKU-' + suffix, skuKey: 'sku-' + suffix, primaryUnitId: unit.id } });
  const documents = new InventoryDocumentService(db), reservations = new InventoryReservationService(db, documents.warehouses);
  const code = options.code ?? 'WH_' + suffix.toUpperCase();
  const warehouse = await documents.warehouses.create(actor, { name: code, code, type: 'PHYSICAL', timezone: 'Africa/Cairo' });
  const receive = async (quantity: string, unitCost = options.unitCost ?? '2', warehouseId: string = warehouse.id) => {
    const receipt = await documents.create(actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: warehouseId }, currency: 'EGP' });
    const line = await documents.line(actor, receipt.id, { productId: product.id, quantity, unitCost }) as { documentVersion: string };
    return documents.process(actor, receipt.id, { expectedVersion: line.documentVersion }, randomUUID());
  };
  if (options.quantity !== '0') await receive(options.quantity ?? '5');
  const balance = async (warehouseId: string = warehouse.id) => {
    const rows = await db.inventoryBalance.findMany({ where: { workspaceId: actor.workspaceId, warehouseId, inventoryKey: product.id } });
    const sum = (key: 'onHand' | 'reserved') => rows.reduce((total, row) => total + Number(row[key]), 0);
    return { onHand: sum('onHand'), reserved: sum('reserved') };
  };
  return { catalog, unit, product, warehouse, documents, reservations, receive, balance };
}
