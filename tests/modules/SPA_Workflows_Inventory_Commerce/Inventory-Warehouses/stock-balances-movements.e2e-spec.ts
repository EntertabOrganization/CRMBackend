import { randomUUID } from 'node:crypto';
import { inventoryHttpContract } from '@/tests/support/inventory-http-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
const contract = inventoryHttpContract('truecrm_inventory_stock_http_test', {
  'GET /api/v1/inventory/stock': async f => { const item = await f.sku(), wh = await f.warehouse(); await f.receive(wh.id, item, '5');
    return { permission: 'INVENTORY.STOCK_READ', ids: {}, query: '?warehouseId=' + wh.id,
      verify: async (data, json) => { expect(data).toEqual([expect.objectContaining({ warehouseId: wh.id, inventoryKey: item.inventoryKey, onHand: '5', available: '5.000000' })]);
        expect(json.meta).toMatchObject({ total: 1 }); } }; },
  'GET /api/v1/inventory/availability': async f => { const item = await f.sku(), wh = await f.warehouse(); await f.receive(wh.id, item, '4');
    await f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity: '1', warehouseId: wh.id }, randomUUID());
    return { permission: 'INVENTORY.STOCK_READ', ids: {}, query: `?productId=${item.productId}&quantity=3`,
      verify: async data => { expect(data).toEqual({ productId: item.productId, variantId: null, onHand: '4.000000', reserved: '1.000000', available: '3.000000', backorderAllowed: false, canReserve: true }); } }; },
  'GET /api/v1/inventory/movements': async f => { const item = await f.sku(), wh = await f.warehouse(); await f.receive(wh.id, item, '2', '7');
    return { permission: 'INVENTORY.MOVEMENT_READ', ids: {}, query: '?warehouseId=' + wh.id,
      verify: async data => { expect(data.data).toEqual([expect.objectContaining({ type: 'STOCK_RECEIPT_IN', quantityDelta: '2', unitCost: '7' })]); expect(data.nextCursor).toBeNull(); } }; },
  'GET /api/v1/inventory/movements/:movementId': async (f, db) => { const item = await f.sku(), wh = await f.warehouse(), receipt = await f.receive(wh.id, item, '3');
    const movement = await db.inventoryMovement.findFirstOrThrow({ where: { documentId: receipt.id } });
    return { permission: 'INVENTORY.MOVEMENT_READ', ids: { movementId: movement.id },
      verify: async data => { expect(data).toMatchObject({ id: movement.id, documentId: receipt.id, warehouseId: wh.id, quantityDelta: '3' }); } }; },
  'POST /api/v1/inventory/stock/reconciliation-jobs': async (f, db) => { const wh = await f.warehouse();
    return { permission: 'INVENTORY.STOCK_RECONCILE', ids: {}, body: { warehouseId: wh.id, dryRun: true },
      verify: async data => { expect(data).toMatchObject({ jobId: expect.any(String), status: 'QUEUED' });
        expect(await db.inventoryJob.findUniqueOrThrow({ where: { id: data.jobId } })).toMatchObject({ type: 'STOCK_RECONCILE', input: { warehouseIds: [wh.id], dryRun: true } });
        expect(await db.outboxEvent.count({ where: { entityId: data.jobId, eventType: 'INVENTORY_RECONCILIATION_QUEUED' } })).toBe(1); } }; },
  'GET /api/v1/inventory/stock/reconciliation-jobs/:jobId': async f => { const item = await f.sku(), wh = await f.warehouse(); await f.receive(wh.id, item, '1');
    const job = await f.reconciliation.create(f.actor, { warehouseId: wh.id }, randomUUID()); await f.reconciliation.tick(10);
    return { permission: 'INVENTORY.STOCK_RECONCILE', ids: { jobId: job.jobId },
      verify: async data => { expect(data).toMatchObject({ jobId: job.jobId, status: 'SUCCEEDED', dryRun: true, errorCode: null }); } }; },
});

describe('Stock Availability, Immutable Ledger and Rebuild — REST E2E contract', () => {
  it('GET /api/v1/inventory/stock verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/stock'));
  it('GET /api/v1/inventory/availability verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/availability'));
  it('GET /api/v1/inventory/movements verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/movements'));
  it('GET /api/v1/inventory/movements/:movementId verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/movements/:movementId'));
  it('POST /api/v1/inventory/stock/reconciliation-jobs verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('POST /api/v1/inventory/stock/reconciliation-jobs'));
  it('GET /api/v1/inventory/stock/reconciliation-jobs/:jobId verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/stock/reconciliation-jobs/:jobId'));
});

export {};
