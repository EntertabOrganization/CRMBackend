import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture } from '@/tests/support/inventory-contract';

/** Append-only ledger, derived balances and reconciliation against an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_stock_test');

describe('Stock Balances, Movements and Ledger — unit/integration contract', () => {
  it('receipt +10 yields onHand10,available10', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    const before = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'STOCK_CHANGED' } });
    await f.receive(wh.id, item, '10', '7.5');
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 10, reserved: 0, available: 10 });
    expect(await f.stock.availability(f.actor, { productId: item.productId, quantity: '10' })).toMatchObject({ onHand: '10.000000', reserved: '0.000000', available: '10.000000', canReserve: true });
    const movements = await db.inventoryMovement.findMany({ where: { workspaceId: f.workspace.id, warehouseId: wh.id } });
    expect(movements).toEqual([expect.objectContaining({ type: 'STOCK_RECEIPT_IN', inventoryKey: item.inventoryKey })]);
    expect(movements[0].quantityDelta.toFixed(6)).toBe('10.000000'); expect(movements[0].totalCost.toFixed(6)).toBe('75.000000');
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'STOCK_CHANGED' } })).toBe(before + 1);
  });

  it('reserve 4 keeps onHand10,reserved4,available6', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    const movements = await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } });
    await f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity: '4', warehouseId: wh.id }, randomUUID());
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 10, reserved: 4, available: 6 });
    expect(await f.stock.availability(f.actor, { productId: item.productId })).toMatchObject({ onHand: '10.000000', reserved: '4.000000', available: '6.000000' });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(movements);
  });

  it('movement table rejects update/delete even by normal admin API', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '5');
    const movement = await db.inventoryMovement.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    await expect(db.inventoryMovement.update({ where: { id: movement.id }, data: { quantityDelta: '50' } })).rejects.toThrow(/STOCK_LEDGER_IMMUTABLE/);
    await expect(db.inventoryMovement.delete({ where: { id: movement.id } })).rejects.toThrow(/STOCK_LEDGER_IMMUTABLE/);
    const { inventoryRouter } = await import('@/src/server/inventory/routes');
    expect(inventoryRouter.entries.filter(e => /movements|\/stock$|balances/.test(e.path) && e.method !== 'GET')).toEqual([]);
    expect((await db.inventoryMovement.findUniqueOrThrow({ where: { id: movement.id } })).quantityDelta.toFixed(6)).toBe('5.000000');
  });

  it('simultaneous reservations against final unit cannot oversell under default', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '1');
    const request = () => f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity: '1', warehouseId: wh.id }, randomUUID());
    const results = await Promise.allSettled([request(), request(), request()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter(r => r.status === 'rejected')) expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'RESERVATION_INSUFFICIENT_STOCK', status: 409 });
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 1, reserved: 1, available: 0 });
    expect(await db.inventoryReservation.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
  });

  it('ledger replay matches balance across receipt/transfer/reversal', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, item, '10', '4');
    const transfer = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ productId: item.productId, quantity: '4' }]); await f.post(transfer.id);
    const sale = await f.draft('SALES_ORDER', { source: b.id }, [{ productId: item.productId, quantity: '3' }]); await f.post(sale.id);
    const posted = await db.inventoryDocument.findUniqueOrThrow({ where: { id: sale.id } });
    await f.documents.reverse(f.actor, sale.id, { expectedVersion: posted.version.toString(), reason: 'Wrong shipment' }, randomUUID());
    expect(await f.balance(a.id, item.inventoryKey)).toMatchObject({ onHand: 6 }); expect(await f.balance(b.id, item.inventoryKey)).toMatchObject({ onHand: 4 });
    const job = await f.reconciliation.create(f.actor, { dryRun: true }, randomUUID()); await f.reconciliation.tick(10);
    expect((await f.reconciliation.get(f.actor, job.jobId)).result).toMatchObject({ driftCount: 0, checkedCount: 2 });
    // A corrupted projection is detected against the immutable ledger and repaired only by an authorized controlled job.
    await db.inventoryBalance.updateMany({ where: { workspaceId: f.workspace.id, warehouseId: b.id, inventoryKey: item.inventoryKey }, data: { onHand: '99' } });
    const repair = await f.reconciliation.create(f.actor, { dryRun: false, warehouseId: b.id }, randomUUID()); await f.reconciliation.tick(10);
    expect((await f.reconciliation.get(f.actor, repair.jobId)).result).toMatchObject({ driftCount: 1, resolvedCount: 1 });
    expect(await f.balance(b.id, item.inventoryKey)).toMatchObject({ onHand: 4 });
    const ledger = await db.inventoryMovement.aggregate({ where: { workspaceId: f.workspace.id, warehouseId: b.id }, _sum: { quantityDelta: true } });
    expect(ledger._sum.quantityDelta!.toFixed(6)).toBe('4.000000');
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'STOCK_BALANCE_RECONCILED' } })).toBe(1);
  });

  it('wrong workspace SKU or warehouse not visible', async () => {
    const db = database(), f = await inventoryFixture(db), other = await inventoryFixture(db);
    const foreignItem = await other.sku(), foreignWh = await other.warehouse(), own = await f.warehouse();
    await other.receive(foreignWh.id, foreignItem, '5');
    const document = await f.documents.create(f.actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: own.id }, currency: 'EGP' });
    await expect(f.documents.line(f.actor, document.id, { productId: foreignItem.productId, quantity: '1', unitCost: '1' })).rejects.toMatchObject({ status: 404 });
    await expect(f.documents.create(f.actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: foreignWh.id }, currency: 'EGP' })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(f.stock.list(f.actor, { warehouseId: foreignWh.id })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND' });
    expect((await f.stock.list(f.actor, {})).data).toEqual([]);
    const foreignMovement = await db.inventoryMovement.findFirstOrThrow({ where: { workspaceId: other.workspace.id } });
    await expect(f.stock.movements(f.actor, {}, foreignMovement.id)).rejects.toMatchObject({ code: 'STOCK_NOT_FOUND', status: 404 });
    await expect(f.stock.availability(f.actor, { productId: foreignItem.productId })).rejects.toMatchObject({ status: 404 });
  });

  it('service product forbidden for stock movement', async () => {
    const db = database(), f = await inventoryFixture(db), service = await f.sku({ type: 'SERVICE' }), wh = await f.warehouse();
    const document = await f.documents.create(f.actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: wh.id }, currency: 'EGP' });
    await expect(f.documents.line(f.actor, document.id, { productId: service.productId, quantity: '1', unitCost: '1' })).rejects.toMatchObject({ code: 'STOCK_SERVICE_NOT_TRACKABLE', status: 422 });
    await expect(f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: service.productId, quantity: '1', warehouseId: wh.id }, randomUUID()))
      .rejects.toMatchObject({ code: 'STOCK_SERVICE_NOT_TRACKABLE' });
    await expect(f.stock.availability(f.actor, { productId: service.productId })).rejects.toMatchObject({ code: 'STOCK_SERVICE_NOT_TRACKABLE' });
    await expect(db.catalogProduct.update({ where: { id: service.productId }, data: { inventoryTracking: 'SERIAL' } })).rejects.toThrow(/catalog_product_tracking_ck/);
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

  it('NUMERIC precision preserved for fractional quantities', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku({ precision: 3 }), wh = await f.warehouse();
    await f.receive(wh.id, item, '1.125', '3.333333');
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '0.375' }]); await f.post(sale.id);
    const balance = await db.inventoryBalance.findFirstOrThrow({ where: { workspaceId: f.workspace.id, warehouseId: wh.id } });
    expect(balance.onHand.toFixed(6)).toBe('0.750000');
    const issue = await db.inventoryMovement.findFirstOrThrow({ where: { workspaceId: f.workspace.id, type: 'SALES_ORDER_OUT' } });
    expect(issue.quantityDelta.toFixed(6)).toBe('-0.375000'); expect(issue.totalCost.toFixed(6)).toBe('-1.250000');
    const layer = await db.inventoryCostLayer.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(layer.remainingQuantity.toFixed(6)).toBe('0.750000'); expect(layer.remainingValue.toFixed(6)).toBe('2.500000');
    const document = await f.documents.create(f.actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: wh.id }, currency: 'EGP' });
    await expect(f.documents.line(f.actor, document.id, { productId: item.productId, quantity: '0.0001', unitCost: '1' })).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
    await expect(f.documents.line(f.actor, document.id, { productId: item.productId, quantity: 0.5, unitCost: '1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
  });
});

export {};
