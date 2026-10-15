import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture, type InventoryFixture } from '@/tests/support/inventory-contract';
import type { Principal } from '@/src/server/process-platform/context';

/** Stocktake snapshot, counting, reconciliation and posting against an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_stocktakes_test');
type Session = { id: string; version: bigint | string };
/** Create and start a counting session; lines are keyed by inventory key. */
async function open(f: InventoryFixture, warehouseId: string, actor: Principal = f.actor) {
  const created = await f.stocktakes.create(actor, { warehouseId });
  await f.stocktakes.start(actor, created.id, { expectedVersion: created.version.toString() });
  return created.id;
}
const lines = async (f: InventoryFixture, id: string, actor: Principal = f.actor) => (await f.stocktakes.get(actor, id)).lines;
const line = async (f: InventoryFixture, id: string, inventoryKey: string) => (await lines(f, id)).find(l => l.inventoryKey === inventoryKey)!;
const version = async (f: InventoryFixture, id: string) => ((await f.stocktakes.get(f.actor, id)) as Session).version.toString();
async function count(f: InventoryFixture, id: string, inventoryKey: string, quantity: string, actor: Principal = f.actor) {
  const target = await line(f, id, inventoryKey);
  return f.stocktakes.count(actor, id, target.id, { quantity, expectedVersion: target.version.toString() });
}
const reconcile = async (f: InventoryFixture, id: string, actor: Principal = f.actor) => f.stocktakes.reconcile(actor, id, { expectedVersion: await version(f, id) });
const post = async (f: InventoryFixture, id: string, actor: Principal = f.actor, key = randomUUID()) => f.stocktakes.post(actor, id, { expectedVersion: await version(f, id) }, key);
const sell = async (f: InventoryFixture, warehouseId: string, productId: string, quantity: string) => {
  const sale = await f.draft('SALES_ORDER', { source: warehouseId }, [{ productId, quantity }]); return f.post(sale.id);
};

describe('Stocktake Sessions, Snapshots and Reconciliation — unit/integration contract', () => {
  it('counting does not freeze other warehouse stock operations', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse(), other = await f.warehouse();
    await f.receive(wh.id, item, '10'); await f.receive(other.id, item, '4');
    const id = await open(f, wh.id);
    expect(await lines(f, id)).toEqual([expect.objectContaining({ inventoryKey: item.inventoryKey })]);
    await count(f, id, item.inventoryKey, '10');
    // Stock keeps moving in both the counted and other warehouses while counting.
    await f.receive(wh.id, item, '3'); await sell(f, other.id, item.productId, '1');
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 13 });
    expect(await f.balance(other.id, item.inventoryKey)).toMatchObject({ onHand: 3 });
    await reconcile(f, id);
    // The interim receipt after the count is not a variance.
    expect(await line(f, id, item.inventoryKey)).toMatchObject({ varianceQuantity: expect.anything() });
    const reconciled = await line(f, id, item.inventoryKey);
    expect([reconciled.varianceQuantity!.toFixed(0), reconciled.reconciliationQuantity!.toFixed(0)]).toEqual(['0', '13']);
    expect(await post(f, id)).toMatchObject({ status: 'POSTED', documentId: null });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 13 });
  });

  it('movement after snapshot requires reconciliation before post', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    const id = await open(f, wh.id);
    await count(f, id, item.inventoryKey, '8');
    await expect(post(f, id)).rejects.toMatchObject({ code: 'STOCKTAKE_INVALID_STATUS', status: 409 });
    await reconcile(f, id);
    await sell(f, wh.id, item.productId, '1');
    await expect(post(f, id)).rejects.toMatchObject({ code: 'STOCKTAKE_CONCURRENT_MOVEMENTS', status: 409 });
    expect(await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT' } })).toBe(0);
    await reconcile(f, id);
    const reconciled = await line(f, id, item.inventoryKey);
    expect([reconciled.varianceQuantity!.toFixed(0), reconciled.reconciliationQuantity!.toFixed(0)]).toEqual(['-2', '7']);
    await expect(post(f, id)).resolves.toMatchObject({ status: 'POSTED' });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 7 });
  });

  it('missing count line blocks post unless explicit approved skip', async () => {
    const db = database(), f = await inventoryFixture(db), a = await f.sku(), b = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, a, '5'); await f.receive(wh.id, b, '6');
    const id = await open(f, wh.id);
    await count(f, id, a.inventoryKey, '4');
    await expect(reconcile(f, id)).rejects.toMatchObject({ code: 'STOCKTAKE_UNCOUNTED_LINES', status: 409 });
    const counter = await f.member({ 'INVENTORY.STOCKTAKE_MANAGE': null });
    await f.grantWarehouse(wh.id, counter.role.id, ['INVENTORY.STOCKTAKE_COUNT', 'INVENTORY.STOCKTAKE_READ']);
    const skipLine = await line(f, id, b.inventoryKey);
    await expect(f.stocktakes.count(counter.actor, id, skipLine.id, { skip: true, reason: 'Shelf blocked', expectedVersion: skipLine.version.toString() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    await expect(f.stocktakes.count(f.actor, id, skipLine.id, { skip: true, reason: '', expectedVersion: skipLine.version.toString() })).rejects.toMatchObject({ status: 400 });
    await f.stocktakes.count(f.actor, id, skipLine.id, { skip: true, reason: 'Shelf blocked', expectedVersion: skipLine.version.toString() });
    expect(await line(f, id, b.inventoryKey)).toMatchObject({ skipApprovedByUserId: f.user.id, skipReason: 'Shelf blocked', countedQuantity: null });
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id, action: 'STOCKTAKE_LINE_SKIP_APPROVED' } })).toBe(1);
    await reconcile(f, id);
    const result = await post(f, id) as { documentId: string };
    const adjustment = await db.inventoryDocumentLine.findMany({ where: { documentId: result.documentId } });
    expect(adjustment.map(l => [l.inventoryKey, l.quantity.toFixed(0), l.adjustmentDirection])).toEqual([[a.inventoryKey, '1', 'OUT']]);
    expect(await f.balance(wh.id, b.inventoryKey)).toMatchObject({ onHand: 6 });
  });

  it('posting makes adjustment document and append-only movement', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10', '4');
    const id = await open(f, wh.id);
    await count(f, id, item.inventoryKey, '7'); await reconcile(f, id);
    const result = await post(f, id) as { documentId: string; status: string };
    expect(result.status).toBe('POSTED');
    const document = await db.inventoryDocument.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(document).toMatchObject({ type: 'STOCK_ADJUSTMENT', status: 'PROCESSED', sourceWarehouseId: wh.id });
    const [movement] = await db.inventoryMovement.findMany({ where: { documentId: document.id } });
    expect([movement.type, movement.quantityDelta.toFixed(0), movement.totalCost.toFixed(0)]).toEqual(['STOCK_ADJUSTMENT_OUT', '-3', '-12']);
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 7 });
    expect(await line(f, id, item.inventoryKey)).toMatchObject({ adjustmentDocumentLineId: expect.any(String) });
    await expect(db.inventoryMovement.update({ where: { id: movement.id }, data: { quantityDelta: '-1' } })).rejects.toThrow();
    await expect(db.inventoryMovement.delete({ where: { id: movement.id } })).rejects.toThrow();
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id, entityId: id, action: 'STOCKTAKE_POSTED' } })).toBe(1);
    await expect(count(f, id, item.inventoryKey, '5')).rejects.toMatchObject({ status: 409 });
  });

  it('concurrent double post creates one adjustment only', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    const id = await open(f, wh.id);
    await count(f, id, item.inventoryKey, '6'); await reconcile(f, id);
    const expectedVersion = await version(f, id), key = randomUUID();
    const results = await Promise.allSettled([f.stocktakes.post(f.actor, id, { expectedVersion }, randomUUID()), f.stocktakes.post(f.actor, id, { expectedVersion }, randomUUID()),
      f.stocktakes.post(f.actor, id, { expectedVersion }, key)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const failure of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) expect(failure.reason).toMatchObject({ status: 409 });
    expect(await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT' } })).toBe(1);
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT_OUT' } })).toBe(1);
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 6 });
  });

  it('counting rights do not grant posting rights', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    const counter = await f.member({ 'INVENTORY.STOCKTAKE_POST': null });
    await f.grantWarehouse(wh.id, counter.role.id, ['INVENTORY.STOCKTAKE_CREATE', 'INVENTORY.STOCKTAKE_COUNT', 'INVENTORY.STOCKTAKE_READ', 'INVENTORY.STOCKTAKE_RECONCILE']);
    const id = await open(f, wh.id, counter.actor);
    await count(f, id, item.inventoryKey, '9', counter.actor);
    await f.stocktakes.reconcile(counter.actor, id, { expectedVersion: await version(f, id) });
    await expect(f.stocktakes.post(counter.actor, id, { expectedVersion: await version(f, id) }, randomUUID())).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    // Workspace post permission without the warehouse post grant is still denied.
    const scoped = await f.member();
    await f.grantWarehouse(wh.id, scoped.role.id, ['INVENTORY.STOCKTAKE_READ']);
    await expect(f.stocktakes.post(scoped.actor, id, { expectedVersion: await version(f, id) }, randomUUID())).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT' } })).toBe(0);
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 10 });
    await expect(post(f, id)).resolves.toMatchObject({ status: 'POSTED' });
  });

  it('post failure rolls back all adjustment lines', async () => {
    const db = database(), f = await inventoryFixture(db), a = await f.sku(), b = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, a, '5'); await f.receive(wh.id, b, '5');
    const id = await open(f, wh.id);
    await count(f, id, a.inventoryKey, '3'); await count(f, id, b.inventoryKey, '8'); await reconcile(f, id);
    const outboxBefore = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
    // One SKU becomes non-stockable between reconciliation and posting: the whole proposal must fail atomically.
    await db.catalogProduct.update({ where: { id: [a, b].sort((x, y) => x.inventoryKey.localeCompare(y.inventoryKey))[1].productId }, data: { state: 'INACTIVE' } });
    await expect(post(f, id)).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
    expect(await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT' } })).toBe(0);
    expect(await db.inventoryDocumentLine.count({ where: { workspaceId: f.workspace.id, adjustmentDirection: { not: null } } })).toBe(0);
    expect((await lines(f, id)).map(l => l.adjustmentDocumentLineId)).toEqual([null, null]);
    expect(await f.stocktakes.get(f.actor, id)).toMatchObject({ status: 'RECONCILING' });
    expect(await f.balance(wh.id, a.inventoryKey)).toMatchObject({ onHand: 5 });
    expect(await f.balance(wh.id, b.inventoryKey)).toMatchObject({ onHand: 5 });
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(outboxBefore);
    await db.catalogProduct.updateMany({ where: { id: { in: [a.productId, b.productId] } }, data: { state: 'ACTIVE' } });
    await expect(post(f, id)).resolves.toMatchObject({ status: 'POSTED' });
    expect(await f.balance(wh.id, a.inventoryKey)).toMatchObject({ onHand: 3 });
    expect(await f.balance(wh.id, b.inventoryKey)).toMatchObject({ onHand: 8 });
  });
});

export {};
