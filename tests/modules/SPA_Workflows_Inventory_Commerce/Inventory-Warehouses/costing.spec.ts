import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture } from '@/tests/support/inventory-contract';

/** FIFO/AVERAGE valuation, transfers, locking, migration preview and currency safety. */
const database = inventoryDatabase('truecrm_inventory_costing_test');

describe('Inventory Costing and Valuation — unit/integration contract', () => {
  it('FIFO 10 at 100 and 5 at 60, issue 12 allocates 10 at100 plus 2 at60', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10', '100'); await f.receive(wh.id, item, '5', '60');
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '12' }]); await f.post(sale.id);
    const issue = await db.inventoryMovement.findFirstOrThrow({ where: { documentId: sale.id } });
    expect(issue.totalCost.toFixed(2)).toBe('-1120.00'); expect(issue.costingMethod).toBe('FIFO');
    const allocations = await db.inventoryCostAllocation.findMany({ where: { movementId: issue.id } });
    expect(allocations.map(a => [a.quantity.toFixed(0), a.unitCost.toFixed(0), a.totalCost.toFixed(0)]).sort()).toEqual([['10', '100', '1000'], ['2', '60', '120']]);
    const layers = await db.inventoryCostLayer.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { receivedAt: 'asc' } });
    expect(layers.map(l => [l.remainingQuantity.toFixed(0), l.remainingValue.toFixed(0)])).toEqual([['0', '0'], ['3', '180']]);
    expect((await f.costing.valuation(f.actor, { warehouseId: wh.id })).valuations).toEqual([expect.objectContaining({ onHand: '3.000000', totalValue: '180.000000' })]);
  });

  it('AVERAGE receipt 10 at100 then10 at120 gives average110', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await expect(f.costing.initialize(f.actor, { method: 'AVERAGE' })).resolves.toMatchObject({ method: 'AVERAGE', locked: false });
    await f.receive(wh.id, item, '10', '100'); await f.receive(wh.id, item, '10', '120');
    const average = await db.inventoryAverageCost.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect([average.quantity.toFixed(0), average.totalValue.toFixed(0), average.averageCost.toFixed(0)]).toEqual(['20', '2200', '110']);
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '5' }]); await f.post(sale.id);
    const issue = await db.inventoryMovement.findFirstOrThrow({ where: { documentId: sale.id } });
    expect([issue.unitCost.toFixed(0), issue.totalCost.toFixed(0), issue.costingMethod]).toEqual(['110', '-550', 'AVERAGE']);
    expect((await db.inventoryAverageCost.findUniqueOrThrow({ where: { id: average.id } })).averageCost.toFixed(0)).toBe('110');
    expect(await f.costing.policy(f.actor)).toMatchObject({ method: 'AVERAGE', locked: true });
  });

  it('warehouse transfer preserves total valuation without recognizing profit', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, item, '10', '100');
    const transfer = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ productId: item.productId, quantity: '4', unitCost: '999' }]); await f.post(transfer.id);
    const legs = await db.inventoryMovement.findMany({ where: { documentId: transfer.id }, orderBy: { quantityDelta: 'asc' } });
    expect(legs.map(m => [m.type, m.quantityDelta.toFixed(0), m.totalCost.toFixed(0)])).toEqual([['TRANSFER_OUT', '-4', '-400'], ['TRANSFER_IN', '4', '400']]);
    const valuations = (await f.costing.valuation(f.actor, {})).valuations;
    const total = valuations.reduce((sum, v) => sum + Number(v.totalValue), 0);
    expect(total).toBe(1000);
    expect(valuations.find(v => v.warehouseId === b.id)).toMatchObject({ onHand: '4.000000', totalValue: '400.000000' });
    expect((await db.inventoryCostLayer.findFirstOrThrow({ where: { warehouseId: b.id } })).unitCost.toFixed(0)).toBe('100');
  });

  it('costing method cannot toggle after first posting with plain PATCH', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '1', '5');
    await expect(f.costing.initialize(f.actor, { method: 'AVERAGE' })).rejects.toMatchObject({ code: 'COSTING_METHOD_LOCKED', status: 409 });
    await expect(f.settings({ costingMethod: 'AVERAGE' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
    expect(await f.costing.policy(f.actor)).toMatchObject({ method: 'FIFO', locked: true, generation: 1 });
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'INVENTORY_COSTING_INITIALIZED' } })).toBe(0);
  });

  it('migration preview does not mutate stock/valuation', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '4', '25');
    const snapshot = async () => ({ balances: await db.inventoryBalance.findMany({ where: { workspaceId: f.workspace.id } }), layers: await db.inventoryCostLayer.findMany({ where: { workspaceId: f.workspace.id } }),
      settings: await db.inventorySettings.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } }), movements: await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } }),
      averages: await db.inventoryAverageCost.count({ where: { workspaceId: f.workspace.id } }) });
    const before = await snapshot();
    const job = await f.jobs.preview(f.actor, { targetMethod: 'AVERAGE' });
    expect(job.status).toBe('QUEUED'); await f.jobs.tick(10);
    const result = await f.jobs.get(f.actor, job.jobId, true);
    expect(result).toMatchObject({ status: 'SUCCEEDED', result: { fromMethod: 'FIFO', targetMethod: 'AVERAGE', blockedCount: 0, values: [expect.objectContaining({ quantity: '4.000000', totalValue: '100.000000' })] } });
    expect(await snapshot()).toEqual(before);
    expect(await db.inventoryValuationSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

  it('multi-currency valuation requires explicit policy/rate reference', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '2', '10', 'EGP');
    await expect(f.receive(wh.id, item, '2', '1', 'USD')).rejects.toMatchObject({ code: 'COSTING_CURRENCY_INVALID', status: 422 });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id, currency: 'USD' } })).toBe(0);
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 2 });
    const settings = await f.policies.get(f.actor) as { version: bigint };
    await f.policies.documentPolicy(f.actor, 'SALES_ORDER', { expectedVersion: settings.version.toString(), policy: { requiresApproval: true, minimumValue: '1', currency: 'USD' } });
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '1' }]);
    await expect(f.documents.approval(f.actor, sale.id, { expectedVersion: sale.version }, true)).rejects.toMatchObject({ code: 'COSTING_CURRENCY_INVALID' });
  });

  it('valuation read excludes inaccessible warehouse', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, item, '1', '10'); await f.receive(b.id, item, '1', '90');
    const analyst = await f.member();
    await f.grantWarehouse(a.id, analyst.role.id, ['INVENTORY.VALUATION_VIEW']);
    const visible = await f.costing.valuation(analyst.actor, {});
    expect(visible.valuations.map(v => v.warehouseId)).toEqual([a.id]);
    expect(JSON.stringify(visible)).not.toContain('90.000000');
    await expect(f.costing.valuation(analyst.actor, { warehouseId: b.id })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    const noGrant = await f.member({ 'INVENTORY.VALUATION_VIEW': null });
    await expect(f.costing.valuation(noGrant.actor, {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: { startsWith: 'INVENTORY_VALUATION' } } })).toBe(0);
  });
});

export {};
