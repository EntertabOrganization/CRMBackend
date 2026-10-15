import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture, type InventoryFixture } from '@/tests/support/inventory-contract';

/** Barcodes, serial and batch lifecycle against Catalog-owned tracking policy and an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_tracking_test');
type Item = Awaited<ReturnType<InventoryFixture['sku']>>;
const sku = (item: Item) => ({ productId: item.productId, variantId: item.variantId! });
const registerSerial = (f: InventoryFixture, item: Item, warehouseId: string, serialNumber: string) => f.tracking.serial(f.actor, { variantId: item.variantId, serialNumber, warehouseId });
const tomorrow = () => new Date(Date.now() + 86400000).toISOString();

describe('Barcodes, Serial and Batch Tracking — unit/integration contract', () => {
  it('duplicate active barcode in workspace rejected', async () => {
    const db = database(), f = await inventoryFixture(db), a = await f.sku(), b = await f.sku(), value = 'BC-' + randomUUID().slice(0, 8);
    await f.warehouse(); // barcode management requires an accessible warehouse scope
    const first = await f.tracking.barcode(f.actor, { productId: a.productId, barcodeType: 'CODE128', value }) as { id: string; isPrimary: boolean };
    expect(first.isPrimary).toBe(true);
    await expect(f.tracking.barcode(f.actor, { productId: b.productId, barcodeType: 'CODE128', value })).rejects.toMatchObject({ code: 'BARCODE_EXISTS', status: 409 });
    await expect(f.tracking.barcode(f.actor, { productId: a.productId, barcodeType: 'CODE128', value })).rejects.toMatchObject({ code: 'BARCODE_EXISTS' });
    await expect(f.tracking.barcode(f.actor, { productId: a.productId, barcodeType: 'EAN13', value: '4006381333932' })).rejects.toMatchObject({ code: 'BARCODE_INVALID', status: 422 });
    // A revoked barcode can only come back for the same SKU; it never moves to another SKU silently.
    await f.tracking.barcode(f.actor, {}, first.id);
    await expect(f.tracking.barcode(f.actor, { productId: b.productId, barcodeType: 'CODE128', value })).rejects.toMatchObject({ code: 'BARCODE_EXISTS' });
    await expect(f.tracking.barcode(f.actor, { productId: a.productId, barcodeType: 'CODE128', value })).resolves.toMatchObject({ id: first.id, isActive: true });
    expect(await db.inventoryBarcode.count({ where: { workspaceId: f.workspace.id, value } })).toBe(1);
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id, action: 'PRODUCT_BARCODE_ASSIGNED' } })).toBe(2);
  });

  it('serial cannot be simultaneously in two warehouses', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku({ variant: true, tracking: 'SERIAL' }), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, item, '1'); await f.receive(b.id, item, '1');
    const serial = await registerSerial(f, item, a.id, 'SN-001');
    await expect(registerSerial(f, item, b.id, 'SN-001')).rejects.toMatchObject({ code: 'SERIAL_NUMBER_EXISTS', status: 409 });
    // Posted stock coverage: one received unit admits one serial.
    await expect(registerSerial(f, item, a.id, 'SN-002')).rejects.toMatchObject({ code: 'SERIAL_RECEIPT_REQUIRED' });
    const transfer = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ ...sku(item), quantity: '1', serialIds: [serial.id] }]); await f.post(transfer.id);
    expect(await db.inventorySerialNumber.findUniqueOrThrow({ where: { id: serial.id } })).toMatchObject({ warehouseId: b.id, status: 'IN_STOCK' });
    expect(await db.inventorySerialNumber.count({ where: { workspaceId: f.workspace.id, serialNumber: 'SN-001' } })).toBe(1);
    await f.receive(a.id, item, '1');
    const again = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ ...sku(item), quantity: '1', serialIds: [serial.id] }]);
    await expect(f.post(again.id)).rejects.toMatchObject({ code: 'SERIAL_NOT_AVAILABLE', status: 409 });
    expect(await f.balance(b.id, item.inventoryKey)).toMatchObject({ onHand: 2 });
    // Tracked lines require serial selection that matches the quantity.
    await expect(f.draft('TRANSFER', { source: b.id, destination: a.id }, [{ ...sku(item), quantity: '2', serialIds: [serial.id] }])).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
  });

  it('issuing sold serial twice rejected', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku({ variant: true, tracking: 'SERIAL' }), wh = await f.warehouse();
    await f.receive(wh.id, item, '2');
    const s1 = await registerSerial(f, item, wh.id, 'SN-A'); await registerSerial(f, item, wh.id, 'SN-B');
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ ...sku(item), quantity: '1', serialIds: [s1.id] }]); await f.post(sale.id);
    expect(await db.inventorySerialNumber.findUniqueOrThrow({ where: { id: s1.id } })).toMatchObject({ status: 'SOLD' });
    const second = await f.draft('SALES_ORDER', { source: wh.id }, [{ ...sku(item), quantity: '1', serialIds: [s1.id] }]);
    await expect(f.post(second.id)).rejects.toMatchObject({ code: 'SERIAL_NOT_AVAILABLE', status: 409 });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 1 });
    expect(await db.inventoryDocument.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'DRAFT' });
    await expect(f.draft('SALES_ORDER', { source: wh.id }, [{ ...sku(item), quantity: '1' }])).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
    // A customer return brings the sold unit back; reversal restores the prior lifecycle state.
    const ret = await f.draft('CUSTOMER_RETURN', { destination: wh.id }, [{ ...sku(item), quantity: '1', serialIds: [s1.id] }]); await f.post(ret.id);
    expect(await db.inventorySerialNumber.findUniqueOrThrow({ where: { id: s1.id } })).toMatchObject({ status: 'RETURNED', warehouseId: wh.id });
  });

  it('expired batch cannot fulfill when expiry enforcement enabled', async () => {
    const db = database(), f = await inventoryFixture(db), wh = await f.warehouse();
    const strict = await f.sku({ variant: true, tracking: 'BATCH', enforceBatchExpiry: true }), lenient = await f.sku({ variant: true, tracking: 'BATCH' });
    await expect(f.tracking.batch(f.actor, { variantId: strict.variantId, batchNumber: 'OLD', expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ code: 'BATCH_EXPIRY_INVALID' });
    const strictBatch = await f.tracking.batch(f.actor, { variantId: strict.variantId, batchNumber: 'B-1', expiresAt: tomorrow() });
    const lenientBatch = await f.tracking.batch(f.actor, { variantId: lenient.variantId, batchNumber: 'B-1', expiresAt: tomorrow() });
    await f.receive(wh.id, strict, '5', '10', 'EGP', { batches: [{ batchId: strictBatch.id, quantity: '5' }] });
    await f.receive(wh.id, lenient, '5', '10', 'EGP', { batches: [{ batchId: lenientBatch.id, quantity: '5' }] });
    expect(await db.inventoryBatchBalance.findFirstOrThrow({ where: { batchId: strictBatch.id, warehouseId: wh.id } })).toMatchObject({ onHand: expect.anything() });
    // Time passes: both batches are now past their expiry.
    await db.inventoryBatch.updateMany({ where: { id: { in: [strictBatch.id, lenientBatch.id] } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const blocked = await f.draft('SALES_ORDER', { source: wh.id }, [{ ...sku(strict), quantity: '1', batches: [{ batchId: strictBatch.id, quantity: '1' }] }]);
    await expect(f.post(blocked.id)).rejects.toMatchObject({ code: 'BATCH_EXPIRED', status: 409 });
    expect(await f.balance(wh.id, strict.inventoryKey)).toMatchObject({ onHand: 5 });
    const allowed = await f.draft('SALES_ORDER', { source: wh.id }, [{ ...sku(lenient), quantity: '1', batches: [{ batchId: lenientBatch.id, quantity: '1' }] }]); await f.post(allowed.id);
    expect((await db.inventoryBatchBalance.findFirstOrThrow({ where: { batchId: lenientBatch.id, warehouseId: wh.id } })).onHand.toFixed(0)).toBe('4');
    // Expired stock may still leave through a write-off; batch quantity cannot go below zero.
    const writeOff = await f.draft('WRITE_OFF', { source: wh.id }, [{ ...sku(strict), quantity: '5', writeOffReason: 'Expired', batches: [{ batchId: strictBatch.id, quantity: '5' }] }]); await f.post(writeOff.id);
    expect((await db.inventoryBatchBalance.findFirstOrThrow({ where: { batchId: strictBatch.id, warehouseId: wh.id } })).onHand.toFixed(0)).toBe('0');
  });

  it('scanner lookup cannot mutate stock', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse(), value = 'SCAN-' + randomUUID().slice(0, 8);
    await f.receive(wh.id, item, '3');
    await f.tracking.barcode(f.actor, { productId: item.productId, barcodeType: 'QR', value });
    const snapshot = async () => ({ balances: await db.inventoryBalance.findMany({ where: { workspaceId: f.workspace.id } }), movements: await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } }),
      outbox: await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } }), audit: await db.auditLog.count({ where: { workspaceId: f.workspace.id } }) });
    const before = await snapshot();
    expect(await f.tracking.resolve(f.actor, { code: value })).toMatchObject({ value, productId: item.productId, inventoryKey: item.inventoryKey });
    await expect(f.tracking.resolve(f.actor, { code: 'missing-' + value })).rejects.toMatchObject({ code: 'BARCODE_NOT_FOUND', status: 404 });
    await expect(f.tracking.resolve(f.actor, { code: value, quantity: '1' })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
    const blind = await f.member({ 'INVENTORY.STOCK_READ': null });
    await expect(f.tracking.resolve(blind.actor, { code: value })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
  });

  it('cross-workspace serial/batch hidden', async () => {
    const db = database(), f = await inventoryFixture(db), other = await inventoryFixture(db), wh = await f.warehouse(), otherWh = await other.warehouse();
    const serialItem = await f.sku({ variant: true, tracking: 'SERIAL' }), batchItem = await f.sku({ variant: true, tracking: 'BATCH' }), value = 'X-' + randomUUID().slice(0, 8);
    await f.receive(wh.id, serialItem, '1'); const serial = await registerSerial(f, serialItem, wh.id, 'SN-X');
    const batch = await f.tracking.batch(f.actor, { variantId: batchItem.variantId, batchNumber: 'LOT-X' });
    await f.tracking.barcode(f.actor, { productId: serialItem.productId, variantId: serialItem.variantId, barcodeType: 'CODE128', value });
    expect((await other.tracking.serials(other.actor, {})).data).toEqual([]);
    expect((await other.tracking.batches(other.actor, {})).data).toEqual([]);
    await expect(other.tracking.serials(other.actor, { warehouseId: wh.id })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(other.tracking.resolve(other.actor, { code: value })).rejects.toMatchObject({ code: 'BARCODE_NOT_FOUND', status: 404 });
    await expect(other.tracking.serial(other.actor, { variantId: serialItem.variantId, serialNumber: 'SN-Y', warehouseId: otherWh.id })).rejects.toMatchObject({ status: 404 });
    // A foreign serial or batch id can never be selected on a document line.
    const own = await other.sku({ variant: true, tracking: 'SERIAL' }); await other.receive(otherWh.id, own, '1');
    await expect(other.draft('SALES_ORDER', { source: otherWh.id }, [{ ...sku(own), quantity: '1', serialIds: [serial.id] }])).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
    const ownBatch = await other.sku({ variant: true, tracking: 'BATCH' });
    await expect(other.draft('STOCK_RECEIPT', { destination: otherWh.id }, [{ ...sku(ownBatch), quantity: '1', batches: [{ batchId: batch.id, quantity: '1' }] }])).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
    expect((await f.tracking.serials(f.actor, {})).data.map(s => s.id)).toEqual([serial.id]);
    expect((await f.tracking.batches(f.actor, {})).data.map(b => b.id)).toEqual([batch.id]);
  });

  it('service product denied stock-tracking', async () => {
    const db = database(), f = await inventoryFixture(db), wh = await f.warehouse(), service = await f.sku({ type: 'SERVICE' }), plain = await f.sku({ variant: true });
    await expect(f.receive(wh.id, service, '1')).rejects.toMatchObject({ code: 'STOCK_SERVICE_NOT_TRACKABLE', status: 422 });
    await expect(f.tracking.barcode(f.actor, { productId: service.productId, barcodeType: 'CODE128', value: 'SRV-' + randomUUID().slice(0, 6) })).rejects.toMatchObject({ code: 'STOCK_SERVICE_NOT_TRACKABLE' });
    await expect(f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: service.productId, quantity: '1', warehouseId: wh.id }, randomUUID())).rejects.toMatchObject({ status: 422 });
    // Untracked SKUs cannot register serials or batches: the tracking policy is owned by Catalog.
    await expect(f.tracking.serial(f.actor, { variantId: plain.variantId, serialNumber: 'SN', warehouseId: wh.id })).rejects.toMatchObject({ code: 'INVENTORY_TRACKING_DISABLED', status: 422 });
    await expect(f.tracking.batch(f.actor, { variantId: plain.variantId, batchNumber: 'LOT' })).rejects.toMatchObject({ code: 'INVENTORY_TRACKING_DISABLED', status: 422 });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await db.inventoryBalance.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });
});

export {};
