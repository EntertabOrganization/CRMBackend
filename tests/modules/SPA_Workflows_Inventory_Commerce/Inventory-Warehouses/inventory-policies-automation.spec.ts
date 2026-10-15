import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture, type InventoryFixture } from '@/tests/support/inventory-contract';

/** Settings, reorder alerts, numbering and controlled reset against an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_policies_test');
const sell = async (f: InventoryFixture, warehouseId: string, productId: string, quantity: string) => {
  const sale = await f.draft('SALES_ORDER', { source: warehouseId }, [{ productId, quantity }]); return f.post(sale.id);
};
async function resetApprover(f: InventoryFixture, warehouseId: string) {
  const approver = await f.member();
  await f.grantWarehouse(warehouseId, approver.role.id, ['INVENTORY.RESET', 'INVENTORY.DOCUMENT_READ']);
  return approver;
}

describe('Inventory Policies, Reorder Alerts, Numbering and Reset — unit/integration contract', () => {
  it('low stock crossing emits one event, not every polling cycle', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '10');
    await f.reorder.upsert(f.actor, randomUUID(), { warehouseId: wh.id, productId: item.productId, reorderPoint: '5', reorderQuantity: '20', safetyStock: '2' });
    const events = () => db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'INVENTORY_LOW_STOCK' } });
    expect(await events()).toBe(0);
    await sell(f, wh.id, item.productId, '6'); expect(await events()).toBe(1);
    await sell(f, wh.id, item.productId, '1'); expect(await events()).toBe(1);
    // A reconciliation pass re-observes thresholds without a duplicate crossing event.
    await f.reconciliation.create(f.actor, { dryRun: false }, randomUUID()); await f.reconciliation.tick(10);
    expect(await events()).toBe(1);
    expect((await f.reorder.list(f.actor, {}, true)).data).toEqual([expect.objectContaining({ warehouseId: wh.id, inventoryKey: item.inventoryKey, resolvedAt: null })]);
  });

  it('stock restored above threshold closes alert and allows future crossing event', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '6');
    await f.reorder.upsert(f.actor, randomUUID(), { warehouseId: wh.id, productId: item.productId, reorderPoint: '5', reorderQuantity: '10', safetyStock: '2' });
    const count = (eventType: string) => db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType } });
    await sell(f, wh.id, item.productId, '2'); expect(await count('INVENTORY_LOW_STOCK')).toBe(1);
    await f.receive(wh.id, item, '2'); // available 6: inside the hysteresis band (<= reorder point + safety stock)
    expect(await count('INVENTORY_LOW_STOCK_RECOVERED')).toBe(0);
    await f.receive(wh.id, item, '2'); // available 8 > 7
    expect(await count('INVENTORY_LOW_STOCK_RECOVERED')).toBe(1);
    expect((await f.reorder.list(f.actor, {}, true)).data).toEqual([]);
    await sell(f, wh.id, item.productId, '4');
    expect(await count('INVENTORY_LOW_STOCK')).toBe(2);
    expect(await db.inventoryLowStockAlert.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
  });

  it('negative-stock option does not imply backorder allowed', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '2', '10');
    await f.settings({ allowNegativeStock: true });
    await expect(f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity: '3', warehouseId: wh.id }, randomUUID()))
      .rejects.toMatchObject({ code: 'RESERVATION_INSUFFICIENT_STOCK' });
    await sell(f, wh.id, item.productId, '5');
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: -3 });
    const issue = await db.inventoryMovement.findFirstOrThrow({ where: { workspaceId: f.workspace.id, type: 'SALES_ORDER_OUT' } });
    expect(issue.totalCost.toFixed(2)).toBe('-50.00');
    const deficit = await db.inventoryCostDeficit.findFirstOrThrow({ where: { issueMovementId: issue.id } });
    expect([deficit.quantity.toFixed(0), deficit.remainingQuantity.toFixed(0), deficit.provisionalUnitCost.toFixed(0)]).toEqual(['3', '3', '10']);
    // The next receipt settles the deficit first and records the explicit cost variance; only the rest enters FIFO.
    await f.receive(wh.id, item, '4', '12');
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 1 });
    const settlement = await db.inventoryCostDeficitSettlement.findFirstOrThrow({ where: { deficitId: deficit.id } });
    expect([settlement.quantity.toFixed(0), settlement.actualUnitCost.toFixed(0), settlement.varianceValue.toFixed(0)]).toEqual(['3', '12', '6']);
    expect((await db.inventoryCostDeficit.findUniqueOrThrow({ where: { id: deficit.id } })).remainingQuantity.toFixed(0)).toBe('0');
    expect((await db.inventoryCostLayer.findMany({ where: { workspaceId: f.workspace.id, remainingQuantity: { gt: 0 } } })).map(l => [l.remainingQuantity.toFixed(0), l.unitCost.toFixed(0)])).toEqual([['1', '12']]);
    expect((await f.costing.valuation(f.actor, { warehouseId: wh.id })).valuations).toEqual([expect.objectContaining({ onHand: '1.000000', totalValue: '12.000000' })]);
    // Settled negative-stock costs cannot be silently undone by reversing the issue.
    const sale = await db.inventoryDocument.findFirstOrThrow({ where: { workspaceId: f.workspace.id, type: 'SALES_ORDER' } });
    await expect(f.documents.reverse(f.actor, sale.id, { expectedVersion: sale.version.toString(), reason: 'Undo' }, randomUUID())).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_REVERSAL_BLOCKED' });
  });

  it('unsafe policy change with negative current stock requires remediation', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '1', '8');
    await f.settings({ allowNegativeStock: true });
    await sell(f, wh.id, item.productId, '3');
    await expect(f.settings({ allowNegativeStock: false })).rejects.toMatchObject({ code: 'STOCK_RECONCILIATION_CONFLICT', status: 409 });
    expect(await db.inventorySettings.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).toMatchObject({ allowNegativeStock: true });
    // A negative valuation scope blocks controlled reset/migration until remediated.
    const preview = await f.jobs.preview(f.actor, { reason: 'Audit', warehouseId: wh.id }, true); await f.jobs.tick(10);
    expect((await f.jobs.get(f.actor, preview.jobId)).result).toMatchObject({ blockedCount: expect.any(Number) });
    expect(((await f.jobs.get(f.actor, preview.jobId)).result as { blockedCount: number }).blockedCount).toBeGreaterThan(0);
    await f.receive(wh.id, item, '2', '8');
    await expect(f.settings({ allowNegativeStock: false })).resolves.toMatchObject({ allowNegativeStock: false });
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id, action: 'INVENTORY_SETTINGS_CHANGED' } })).toBe(2);
  });

  it('numbering concurrency yields distinct GRN numbers', async () => {
    const db = database(), f = await inventoryFixture(db), wh = await f.warehouse();
    await f.policies.numbering(f.actor, 'STOCK_RECEIPT', { expectedVersion: '0', prefixTemplate: 'GRN-{YYYY}-', padding: 5, resetPolicy: 'YEARLY' });
    const created = await Promise.all(Array.from({ length: 10 }, () => f.documents.create(f.actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: wh.id }, currency: 'EGP' })));
    const numbers = created.map(d => d.number).sort();
    const year = new Date().getUTCFullYear();
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `GRN-${year}-${String(i + 1).padStart(5, '0')}`));
    await expect(f.policies.numbering(f.actor, 'STOCK_RECEIPT', { expectedVersion: '1', prefixTemplate: 'GRN-{DAY}-', padding: 5, resetPolicy: 'NEVER' })).rejects.toMatchObject({ status: 400 });
    expect((await f.documents.create(f.actor, { documentType: 'TRANSFER', warehouseIds: { source: wh.id, destination: (await f.warehouse()).id }, currency: 'EGP' })).number).toMatch(/^TRANSFER-\d{4}-0*1$/);
    expect(new Set((await db.inventoryDocument.findMany({ where: { workspaceId: f.workspace.id } })).map(d => d.number)).size).toBe(11);
  });

  it('reset preview has no mutation', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '7', '3');
    const before = { balances: await db.inventoryBalance.findMany({ where: { workspaceId: f.workspace.id } }), documents: await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id } }),
      movements: await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } }) };
    const preview = await f.jobs.preview(f.actor, { warehouseId: wh.id, reason: 'Year-end clean start' }, true);
    await f.jobs.tick(10);
    expect(await f.jobs.get(f.actor, preview.jobId)).toMatchObject({ status: 'SUCCEEDED', type: 'RESET_PREVIEW', result: { blockedCount: 0, affectedBalanceCount: 1 } });
    expect(await db.inventoryBalance.findMany({ where: { workspaceId: f.workspace.id } })).toEqual(before.balances);
    expect(await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id } })).toBe(before.documents);
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(before.movements);
  });

  it('reset apply creates auditable adjustments and is idempotent', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '7', '3');
    // Warehouse ACL changes bump the warehouse version and stale any earlier preview, so the approver is set up first.
    const approver = await resetApprover(f, wh.id);
    const preview = await f.jobs.preview(f.actor, { warehouseId: wh.id, reason: 'Clean start' }, true); await f.jobs.tick(10);
    const approval = await f.jobs.approve(approver.actor, preview.jobId, { reason: 'Second approver verified count' });
    const key = randomUUID(), input = { previewId: preview.jobId, approvalId: approval.approvalId };
    const [a, b] = await Promise.all([f.jobs.apply(f.actor, input, key, true), f.jobs.apply(f.actor, input, key, true)]);
    expect(a).toEqual(b);
    expect(await f.jobs.apply(f.actor, input, randomUUID(), true)).toMatchObject({ jobId: a.jobId });
    await f.jobs.tick(10);
    const job = await f.jobs.get(f.actor, a.jobId);
    expect(job).toMatchObject({ status: 'SUCCEEDED', type: 'RESET_APPLY', result: { adjustedLineCount: 1, awaitingApproval: false } });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 0 });
    const adjustment = await db.inventoryDocument.findFirstOrThrow({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT' } });
    expect(adjustment.status).toBe('PROCESSED');
    expect(await db.inventoryMovement.findMany({ where: { documentId: adjustment.id } })).toEqual([expect.objectContaining({ type: 'STOCK_ADJUSTMENT_OUT' })]);
    expect(await db.auditLog.count({ where: { entityId: a.jobId, action: 'INVENTORY_RESET_APPLIED' } })).toBe(1);
    await f.jobs.tick(10);
    expect(await db.inventoryDocument.count({ where: { workspaceId: f.workspace.id, type: 'STOCK_ADJUSTMENT' } })).toBe(1);
  });

  it('nonprivileged reset is forbidden', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '2');
    const clerk = await f.member({ 'INVENTORY.RESET': null });
    await expect(f.jobs.preview(clerk.actor, { warehouseId: wh.id, reason: 'Try' }, true)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    const unscoped = await f.member();
    await expect(f.jobs.preview(unscoped.actor, { warehouseId: wh.id, reason: 'Try' }, true)).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    const preview = await f.jobs.preview(f.actor, { warehouseId: wh.id, reason: 'Reset' }, true); await f.jobs.tick(10);
    await expect(f.jobs.approve(f.actor, preview.jobId, { reason: 'Self approval' })).rejects.toMatchObject({ code: 'INVENTORY_RESET_NOT_APPROVED', status: 403 });
    await expect(f.jobs.approve(clerk.actor, preview.jobId, { reason: 'Unauthorized' })).rejects.toMatchObject({ status: 403 });
    await expect(f.jobs.apply(f.actor, { previewId: preview.jobId, approvalId: randomUUID() }, randomUUID(), true)).rejects.toMatchObject({ code: 'INVENTORY_RESET_NOT_APPROVED' });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 2 });
    expect(await db.inventoryJob.count({ where: { workspaceId: f.workspace.id, type: 'RESET_APPLY' } })).toBe(0);
  });
});

export {};
