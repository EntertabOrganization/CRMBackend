import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture, type InventoryFixture } from '@/tests/support/inventory-contract';

/** Reservations, backorder policy, expiry and fulfillment against an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_reservations_test');
const reserve = (f: InventoryFixture, item: { productId: string }, warehouseId: string, quantity: string, extra: Record<string, unknown> = {}, key: string = randomUUID()) =>
  f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity, warehouseId, ...extra }, key);

describe('Stock Reservations, Backorders, Expiry and Allocation — unit/integration contract', () => {
  it('reserve last item from two concurrent requests permits at most available quantity', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '1');
    const results = await Promise.allSettled([reserve(f, item, wh.id, '1'), reserve(f, item, wh.id, '1')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESERVATION_INSUFFICIENT_STOCK', status: 409 } });
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 1, reserved: 1, available: 0 });
    const allocations = await db.inventoryReservationAllocation.aggregate({ where: { workspaceId: f.workspace.id }, _sum: { quantity: true } });
    expect(allocations._sum.quantity!.toFixed(0)).toBe('1');
  });

  it('backorder enabled allows reserved greater than onHand but physical issue stays blocked', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '1');
    await expect(reserve(f, item, wh.id, '3')).rejects.toMatchObject({ code: 'RESERVATION_INSUFFICIENT_STOCK' });
    await f.settings({ allowBackorderReservations: true });
    await reserve(f, item, wh.id, '3');
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 1, reserved: 3, available: -2 });
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '1' }]);
    await expect(f.post(sale.id)).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT', status: 409 });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 1 });
    expect((await db.inventorySettings.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).allowNegativeStock).toBe(false);
    await expect(f.settings({ allowBackorderReservations: false })).rejects.toMatchObject({ code: 'RESERVATION_INSUFFICIENT_STOCK', status: 409 });
  });

  it('reservation cannot exceed planned sale quantity', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    const order = await f.order([{ inventoryKey: item.inventoryKey, quantity: '2' }]);
    const fromOrder = (quantity: string) => f.reservations.create(f.actor, { sourceType: 'ORDER', sourceId: order.id, productId: item.productId, quantity, warehouseId: wh.id }, randomUUID());
    await expect(fromOrder('3')).rejects.toMatchObject({ code: 'RESERVATION_QUANTITY_INVALID', status: 422 });
    const first = await fromOrder('2');
    await expect(fromOrder('1')).rejects.toMatchObject({ code: 'RESERVATION_QUANTITY_INVALID' });
    await expect(f.reservations.update(f.actor, first.id, { expectedVersion: first.version, quantity: '3' })).rejects.toMatchObject({ code: 'RESERVATION_QUANTITY_INVALID' });
    const other = await f.sku();
    await expect(f.reservations.create(f.actor, { sourceType: 'ORDER', sourceId: order.id, productId: other.productId, quantity: '1', warehouseId: wh.id }, randomUUID())).rejects.toMatchObject({ code: 'RESERVATION_SOURCE_INVALID' });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ reserved: 2 });
  });

  it('release reduces reserved but not onHand', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '6');
    const reservation = await reserve(f, item, wh.id, '5');
    const movements = await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } });
    const partial = await f.reservations.release(f.actor, reservation.id, { quantity: '2', reason: 'Customer reduced order' }, randomUUID());
    expect(partial.status).toBe('ACTIVE');
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 6, reserved: 3, available: 3 });
    const full = await f.reservations.release(f.actor, reservation.id, { reason: 'Cancelled' }, randomUUID());
    expect(full.status).toBe('RELEASED');
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 6, reserved: 0, available: 6 });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(movements);
    await expect(f.reservations.release(f.actor, reservation.id, { reason: 'Again' }, randomUUID())).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED', status: 409 });
    expect(await db.outboxEvent.count({ where: { entityId: reservation.id, eventType: 'RESERVATION_RELEASED' } })).toBe(2);
  });

  it('expiry runs once despite duplicate timer dispatch', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '4');
    const reservation = await reserve(f, item, wh.id, '3');
    expect(new Date(reservation.expiresAt).getTime() - Date.now()).toBeGreaterThan(2.9 * 86400000);
    await db.inventoryReservation.update({ where: { id: reservation.id }, data: { reservedAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 3600000) } });
    const results = await Promise.all([f.reservations.expireDue(50), f.reservations.expireDue(50), f.reservations.expireDue(50)]);
    expect(results.reduce((sum, r) => sum + r.expired, 0)).toBe(1);
    expect(await db.inventoryReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: 'EXPIRED' });
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    expect(await db.inventoryReservationHistory.count({ where: { reservationId: reservation.id, action: 'EXPIRED' } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: reservation.id, eventType: 'RESERVATION_EXPIRED' } })).toBe(1);
  });

  it('partial fulfill reduces reserved and associates sale document', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    const reservation = await reserve(f, item, wh.id, '5');
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '2' }], 'EGP', f.actor, { entityType: 'SPA_ITEM', entityId: f.source.id });
    await f.post(sale.id);
    const result = await f.reservations.fulfill(f.actor, reservation.id, { quantity: '2', inventoryDocumentLineId: sale.lineIds[0] }, randomUUID());
    expect(result).toMatchObject({ status: 'PARTIALLY_FULFILLED', alreadyFulfilled: false });
    const row = await db.inventoryReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(row.fulfilledQuantity.toFixed(0)).toBe('2');
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 8, reserved: 3, available: 5 });
    expect(await db.inventoryReservationHistory.findFirstOrThrow({ where: { reservationId: reservation.id, action: 'FULFILLED' } })).toMatchObject({ documentLineId: sale.lineIds[0] });
    const unrelated = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '1' }]);
    await expect(f.reservations.fulfill(f.actor, reservation.id, { quantity: '1', inventoryDocumentLineId: unrelated.lineIds[0] }, randomUUID())).rejects.toMatchObject({ code: 'RESERVATION_SOURCE_INVALID' });
  });

  it('same fulfill retry does not reduce stock twice', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '5');
    const reservation = await reserve(f, item, wh.id, '3');
    // Reserved stock is issued only by consuming the reservation in the processed sale line.
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '3', reservationId: reservation.id }], 'EGP', f.actor, { entityType: 'SPA_ITEM', entityId: f.source.id });
    await f.post(sale.id);
    expect(await db.inventoryReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: 'FULFILLED' });
    const key = randomUUID(), input = { quantity: '3', inventoryDocumentLineId: sale.lineIds[0] };
    const [a, b] = await Promise.all([f.reservations.fulfill(f.actor, reservation.id, input, key), f.reservations.fulfill(f.actor, reservation.id, input, key)]);
    expect(a).toEqual(b); expect(a).toMatchObject({ status: 'FULFILLED', alreadyFulfilled: true });
    expect(await f.reservations.fulfill(f.actor, reservation.id, input, randomUUID())).toMatchObject({ alreadyFulfilled: true });
    await expect(f.reservations.fulfill(f.actor, reservation.id, { ...input, quantity: '1' }, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 2, reserved: 0, available: 2 });
    expect(await db.inventoryReservationHistory.count({ where: { reservationId: reservation.id, action: 'FULFILLED' } })).toBe(1);
    expect(await db.inventoryMovement.count({ where: { documentId: sale.id } })).toBe(1);
  });

  it('unauthorized source/warehouse cross-tenant reservation denied', async () => {
    const db = database(), f = await inventoryFixture(db), other = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse(), foreignWh = await other.warehouse();
    await f.receive(wh.id, item, '5');
    await expect(reserve(f, item, foreignWh.id, '1')).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: other.source.id, productId: item.productId, quantity: '1', warehouseId: wh.id }, randomUUID())).rejects.toMatchObject({ status: 404 });
    const clerk = await f.member();
    await expect(f.reservations.create(clerk.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity: '1', warehouseId: wh.id }, randomUUID())).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND' });
    const reservation = await reserve(f, item, wh.id, '1');
    await expect(other.reservations.get(other.actor, reservation.id)).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND', status: 404 });
    await expect(other.reservations.release(other.actor, reservation.id, { reason: 'Hijack' }, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ reserved: 1 });
    expect(await db.inventoryReservation.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
  });
});

export {};
