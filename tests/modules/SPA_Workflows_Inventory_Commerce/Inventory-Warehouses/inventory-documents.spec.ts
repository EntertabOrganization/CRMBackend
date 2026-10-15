import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture } from '@/tests/support/inventory-contract';

/** Inventory document lifecycle, approval and atomic posting against an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_documents_test');

describe('Inventory Documents and Posting — unit/integration contract', () => {
  it('draft creation does not change stock', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '3');
    const movements = await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } });
    const draft = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '2' }]);
    expect(await db.inventoryDocument.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'DRAFT', type: 'SALES_ORDER', number: expect.stringMatching(/^SALES_ORDER-\d{4}-/) });
    expect(await f.balance(wh.id, item.inventoryKey)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(movements);
    expect(await db.outboxEvent.count({ where: { entityId: draft.id, eventType: 'INVENTORY_DOCUMENT_CREATED' } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: draft.id, eventType: 'INVENTORY_DOCUMENT_PROCESSED' } })).toBe(0);
  });

  it('post receipt generates one movement per line and adjusts balance', async () => {
    const db = database(), f = await inventoryFixture(db), a = await f.sku(), b = await f.sku(), wh = await f.warehouse();
    const draft = await f.draft('STOCK_RECEIPT', { destination: wh.id }, [{ productId: a.productId, quantity: '5', unitCost: '2' }, { productId: b.productId, quantity: '7', unitCost: '3' }]);
    const result = await f.post(draft.id);
    expect(result).toMatchObject({ id: draft.id, status: 'PROCESSED' });
    const movements = await db.inventoryMovement.findMany({ where: { documentId: draft.id }, orderBy: { ledgerSequence: 'asc' } });
    expect(movements.map(m => [m.documentLineId, m.quantityDelta.toFixed(0), m.type])).toEqual([[draft.lineIds[0], '5', 'STOCK_RECEIPT_IN'], [draft.lineIds[1], '7', 'STOCK_RECEIPT_IN']]);
    expect(await f.balance(wh.id, a.inventoryKey)).toMatchObject({ onHand: 5 }); expect(await f.balance(wh.id, b.inventoryKey)).toMatchObject({ onHand: 7 });
    expect(await db.inventoryDocumentHistory.count({ where: { documentId: draft.id, action: 'INVENTORY_DOCUMENT_PROCESSED' } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: draft.id, eventType: 'INVENTORY_DOCUMENT_PROCESSED' } })).toBe(1);
    expect(await db.inventorySettings.findUniqueOrThrow({ where: { workspaceId: f.workspace.id } })).toMatchObject({ costingLocked: true });
  });

  it('cannot post transfer with only source warehouse access', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, item, '5');
    const transfer = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ productId: item.productId, quantity: '2' }]);
    const clerk = await f.member();
    await f.grantWarehouse(a.id, clerk.role.id, ['INVENTORY.DOCUMENT_PROCESS', 'INVENTORY.DOCUMENT_READ', 'INVENTORY.DOCUMENT_CREATE']);
    await expect(f.post(transfer.id, clerk.actor)).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(f.documents.create(clerk.actor, { documentType: 'TRANSFER', warehouseIds: { source: a.id, destination: b.id }, currency: 'EGP' })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND' });
    expect(await db.inventoryMovement.count({ where: { documentId: transfer.id } })).toBe(0);
    expect(await f.balance(a.id, item.inventoryKey)).toMatchObject({ onHand: 5 });
    await f.grantWarehouse(b.id, clerk.role.id, ['INVENTORY.DOCUMENT_PROCESS', 'INVENTORY.DOCUMENT_READ']);
    await expect(f.post(transfer.id, clerk.actor)).resolves.toMatchObject({ status: 'PROCESSED' });
    expect(await f.balance(b.id, item.inventoryKey)).toMatchObject({ onHand: 2 });
  });

  it('simultaneous process same document posts once via idempotency', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    const draft = await f.draft('STOCK_RECEIPT', { destination: wh.id }, [{ productId: item.productId, quantity: '4', unitCost: '1' }]);
    const key = randomUUID(), replay = () => f.documents.process(f.actor, draft.id, { expectedVersion: draft.version }, key);
    const [a, b] = await Promise.all([replay(), replay()]);
    expect(a).toEqual(b);
    const raced = await f.draft('STOCK_RECEIPT', { destination: wh.id }, [{ productId: item.productId, quantity: '4', unitCost: '1' }]);
    const results = await Promise.allSettled([f.post(raced.id), f.post(raced.id), f.post(raced.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').every(r => [409].includes((r as PromiseRejectedResult).reason.status))).toBe(true);
    expect(await db.inventoryMovement.count({ where: { documentId: { in: [draft.id, raced.id] } } })).toBe(2);
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 8 });
    await expect(replay()).resolves.toEqual(a);
  });

  it('post failure rolls back both transfer legs, history and outbox', async () => {
    const db = database(), f = await inventoryFixture(db), first = await f.sku(), second = await f.sku(), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, first, '5'); await f.receive(a.id, second, '1');
    const transfer = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ productId: first.productId, quantity: '3' }, { productId: second.productId, quantity: '2' }]);
    const before = { outbox: await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } }), history: await db.inventoryDocumentHistory.count({ where: { documentId: transfer.id } }),
      layers: await db.inventoryCostLayer.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: 'asc' } }) };
    await expect(f.post(transfer.id)).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT', status: 409 });
    expect(await db.inventoryMovement.count({ where: { documentId: transfer.id } })).toBe(0);
    expect(await f.balance(a.id, first.inventoryKey)).toMatchObject({ onHand: 5 }); expect(await f.balance(b.id, first.inventoryKey)).toMatchObject({ onHand: 0 });
    expect(await db.inventoryDocument.findUniqueOrThrow({ where: { id: transfer.id } })).toMatchObject({ status: 'DRAFT' });
    expect(await db.inventoryDocumentHistory.count({ where: { documentId: transfer.id } })).toBe(before.history);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before.outbox);
    expect(await db.inventoryCostLayer.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: 'asc' } })).toEqual(before.layers);
  });

  it('processed line cannot be updated/deleted', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    const receipt = await f.receive(wh.id, item, '2');
    const line = await db.inventoryDocumentLine.findFirstOrThrow({ where: { documentId: receipt.id } });
    await expect(f.documents.line(f.actor, receipt.id, { expectedVersion: line.version.toString(), quantity: '9' }, line.id)).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_NOT_DRAFT', status: 409 });
    await expect(f.documents.line(f.actor, receipt.id, {}, line.id, true)).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_NOT_DRAFT' });
    await expect(f.documents.line(f.actor, receipt.id, { productId: item.productId, quantity: '1', unitCost: '1' })).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_NOT_DRAFT' });
    await expect(db.inventoryDocumentLine.update({ where: { id: line.id }, data: { quantity: '9' } })).rejects.toThrow(/INVENTORY_DOCUMENT_NOT_DRAFT/);
    await expect(db.inventoryDocumentLine.delete({ where: { id: line.id } })).rejects.toThrow();
    expect((await db.inventoryDocumentLine.findUniqueOrThrow({ where: { id: line.id } })).quantity.toFixed(0)).toBe('2');
  });

  it('approval-required write-off cannot skip approval', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    await f.receive(wh.id, item, '5', '10');
    const settings = await f.policies.get(f.actor) as { version: bigint };
    await f.policies.documentPolicy(f.actor, 'WRITE_OFF', { expectedVersion: settings.version.toString(), policy: { requiresApproval: true, minimumValue: '1', currency: 'EGP' } });
    const writeOff = await f.draft('WRITE_OFF', { source: wh.id }, [{ productId: item.productId, quantity: '2', writeOffReason: 'Damaged in storage' }]);
    await expect(f.post(writeOff.id)).rejects.toMatchObject({ code: 'INVENTORY_APPROVAL_REQUIRED', status: 409 });
    const submitted = await f.documents.approval(f.actor, writeOff.id, { expectedVersion: writeOff.version }, true);
    expect(submitted.status).toBe('PENDING_APPROVAL');
    await expect(f.post(writeOff.id)).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_NOT_DRAFT' });
    await expect(f.documents.approval(f.actor, writeOff.id, { expectedVersion: submitted.version.toString(), decision: 'APPROVE' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    const approver = await f.member();
    await f.grantWarehouse(wh.id, approver.role.id, ['INVENTORY.DOCUMENT_APPROVE', 'INVENTORY.DOCUMENT_READ']);
    const approved = await f.documents.approval(approver.actor, writeOff.id, { expectedVersion: submitted.version.toString(), decision: 'APPROVE', comment: 'Verified damage' });
    expect(approved.status).toBe('APPROVED');
    await expect(f.post(writeOff.id)).resolves.toMatchObject({ status: 'PROCESSED' });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 3 });
    expect(await db.inventoryDocumentApproval.findMany({ where: { documentId: writeOff.id } })).toEqual([expect.objectContaining({ actorUserId: approver.user.id, decision: 'APPROVE' })]);
  });

  it('reverse receipt cannot overdraw source stock and never deletes original movements', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse();
    const receipt = await f.receive(wh.id, item, '10', '5');
    const sale = await f.draft('SALES_ORDER', { source: wh.id }, [{ productId: item.productId, quantity: '8' }]); await f.post(sale.id);
    const original = await db.inventoryMovement.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { ledgerSequence: 'asc' } });
    const version = async (id: string) => (await db.inventoryDocument.findUniqueOrThrow({ where: { id } })).version.toString();
    await expect(f.documents.reverse(f.actor, receipt.id, { expectedVersion: await version(receipt.id), reason: 'Supplier error' }, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 2 });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(original.length);
    await f.documents.reverse(f.actor, sale.id, { expectedVersion: await version(sale.id), reason: 'Order cancelled' }, randomUUID());
    expect(await f.balance(wh.id, item.inventoryKey)).toMatchObject({ onHand: 10 });
    const after = await db.inventoryMovement.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { ledgerSequence: 'asc' } });
    expect(after.slice(0, original.length)).toEqual(original);
    expect(after.slice(original.length)).toEqual([expect.objectContaining({ type: 'REVERSAL', reversesMovementId: original[1].id })]);
    await expect(f.documents.reverse(f.actor, sale.id, { expectedVersion: await version(sale.id), reason: 'Again' }, randomUUID())).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_REVERSAL_BLOCKED' });
    expect(await db.outboxEvent.count({ where: { entityId: sale.id, eventType: 'INVENTORY_DOCUMENT_REVERSED' } })).toBe(1);
  });
});

export {};
