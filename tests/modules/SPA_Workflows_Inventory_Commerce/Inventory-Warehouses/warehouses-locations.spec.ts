import { randomUUID } from 'node:crypto';
import { inventoryDatabase, inventoryFixture } from '@/tests/support/inventory-contract';

/** Warehouse identity, lifecycle, location hierarchy and ACL against an owned migrated database. */
const database = inventoryDatabase('truecrm_inventory_warehouses_test');

describe('Warehouses, Locations and Warehouse Access — unit/integration contract', () => {
  it('warehouse code uniqueness and stable external business ID', async () => {
    const db = database(), f = await inventoryFixture(db), other = await inventoryFixture(db);
    const main = await f.warehouse('MAIN');
    await expect(f.warehouse('MAIN')).rejects.toMatchObject({ code: 'WAREHOUSE_CODE_EXISTS', status: 409 });
    await expect(other.warehouse('MAIN')).resolves.toMatchObject({ code: 'MAIN' });
    await expect(f.warehouses.update(f.actor, main.id, { expectedVersion: main.version.toString(), code: 'RENAMED' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
    const updated = await f.warehouses.update(f.actor, main.id, { expectedVersion: main.version.toString(), name: 'Main hub', priority: 5 });
    expect(updated).toMatchObject({ id: main.id, code: 'MAIN', name: 'Main hub', version: main.version + 1n });
    await expect(f.warehouses.update(f.actor, main.id, { expectedVersion: main.version.toString(), name: 'Stale' })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT', status: 409 });
    expect(await db.inventoryWarehouse.count({ where: { workspaceId: f.workspace.id, code: 'MAIN' } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: main.id, eventType: 'WAREHOUSE_CREATED' } })).toBe(1);
  });

  it('warehouse archive blocked when nonzero stock or reservations', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse(), spare = await f.warehouse();
    const version = async () => (await db.inventoryWarehouse.findUniqueOrThrow({ where: { id: wh.id } })).version.toString();
    await f.receive(wh.id, item, '3');
    await expect(f.warehouses.update(f.actor, wh.id, { expectedVersion: await version() }, true)).rejects.toMatchObject({ code: 'WAREHOUSE_IN_USE', status: 409 });
    const reservation = await f.reservations.create(f.actor, { sourceType: 'SPA_ITEM', sourceId: f.source.id, productId: item.productId, quantity: '3', warehouseId: wh.id }, randomUUID());
    const transfer = await f.draft('TRANSFER', { source: wh.id, destination: spare.id }, [{ productId: item.productId, quantity: '3' }]);
    await expect(f.post(transfer.id)).rejects.toMatchObject({ code: 'STOCK_INSUFFICIENT' });
    await f.reservations.release(f.actor, reservation.id, { reason: 'Moving stock' }, randomUUID());
    await expect(f.warehouses.update(f.actor, wh.id, { expectedVersion: await version() }, true)).rejects.toMatchObject({ code: 'WAREHOUSE_IN_USE' });
    await f.post(transfer.id);
    const archived = await f.warehouses.update(f.actor, wh.id, { expectedVersion: await version() }, true);
    expect(archived.status).toBe('ARCHIVED');
    await expect(f.warehouses.update(f.actor, wh.id, { expectedVersion: archived.version.toString(), name: 'Reopen' })).rejects.toMatchObject({ code: 'WAREHOUSE_ACCESS_DENIED' });
    await expect(f.draft('STOCK_RECEIPT', { destination: wh.id }, [])).rejects.toMatchObject({ code: 'WAREHOUSE_ACCESS_DENIED', status: 409 });
    expect(await db.outboxEvent.count({ where: { entityId: wh.id, eventType: 'WAREHOUSE_ARCHIVED' } })).toBe(1);
  });

  it('location parent cycle rejected', async () => {
    const db = database(), f = await inventoryFixture(db), wh = await f.warehouse();
    const zone = await f.warehouses.changeLocation(f.actor, wh.id, { code: 'ZONE_A', name: 'Zone A', type: 'ZONE' });
    const aisle = await f.warehouses.changeLocation(f.actor, wh.id, { code: 'AISLE_1', name: 'Aisle 1', type: 'AISLE', parentLocationId: zone.id });
    const bin = await f.warehouses.changeLocation(f.actor, wh.id, { code: 'BIN_7', name: 'Bin 7', type: 'BIN', parentLocationId: aisle.id });
    await expect(f.warehouses.changeLocation(f.actor, wh.id, { expectedVersion: zone.version.toString(), parentLocationId: bin.id }, zone.id)).rejects.toMatchObject({ code: 'LOCATION_CYCLE', status: 422 });
    await expect(f.warehouses.changeLocation(f.actor, wh.id, { expectedVersion: zone.version.toString(), parentLocationId: zone.id }, zone.id)).rejects.toMatchObject({ code: 'LOCATION_CYCLE' });
    await expect(db.inventoryLocation.update({ where: { id: zone.id }, data: { parentLocationId: bin.id } })).rejects.toThrow(/LOCATION_CYCLE/);
    expect((await db.inventoryLocation.findUniqueOrThrow({ where: { id: zone.id } })).parentLocationId).toBeNull();
    const moved = await f.warehouses.changeLocation(f.actor, wh.id, { expectedVersion: bin.version.toString(), parentLocationId: zone.id }, bin.id);
    expect(moved).toMatchObject({ parentLocationId: zone.id });
    expect((await f.warehouses.locations(f.actor, wh.id, {})).data.map(l => l.code)).toEqual(['AISLE_1', 'BIN_7', 'ZONE_A']);
  });

  it('transfer permission requires access to BOTH warehouses', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), a = await f.warehouse(), b = await f.warehouse();
    await f.receive(a.id, item, '4');
    const clerk = await f.member();
    const actions = ['INVENTORY.DOCUMENT_CREATE', 'INVENTORY.DOCUMENT_EDIT', 'INVENTORY.DOCUMENT_PROCESS', 'INVENTORY.DOCUMENT_READ', 'INVENTORY.WAREHOUSE_READ'];
    await f.grantWarehouse(a.id, clerk.role.id, actions);
    await expect(f.documents.create(clerk.actor, { documentType: 'TRANSFER', warehouseIds: { source: a.id, destination: b.id }, currency: 'EGP' })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(f.documents.create(clerk.actor, { documentType: 'TRANSFER', warehouseIds: { source: b.id, destination: a.id }, currency: 'EGP' })).rejects.toMatchObject({ status: 404 });
    // Holding INVENTORY.DOCUMENT_PROCESS alone does not move stock out of a warehouse the role cannot access.
    await f.grantWarehouse(b.id, clerk.role.id, actions);
    const transfer = await f.draft('TRANSFER', { source: a.id, destination: b.id }, [{ productId: item.productId, quantity: '1' }], 'EGP', clerk.actor);
    await f.grantWarehouse(a.id, clerk.role.id, ['INVENTORY.DOCUMENT_PROCESS'], 'NONE');
    await expect(f.post(transfer.id, clerk.actor)).rejects.toMatchObject({ status: 404 });
    await f.grantWarehouse(a.id, clerk.role.id, ['INVENTORY.DOCUMENT_PROCESS'], 'ALL');
    await expect(f.post(transfer.id, clerk.actor)).resolves.toMatchObject({ status: 'PROCESSED' });
    expect(await f.balance(b.id, item.inventoryKey)).toMatchObject({ onHand: 1 });
    expect(await db.inventoryMovement.count({ where: { documentId: transfer.id } })).toBe(2);
  });

  it('cross-workspace location/warehouse ID rejected', async () => {
    const db = database(), f = await inventoryFixture(db), other = await inventoryFixture(db), item = await f.sku(), wh = await f.warehouse(), foreignWh = await other.warehouse();
    const foreignLocation = await other.warehouses.changeLocation(other.actor, foreignWh.id, { code: 'FOREIGN', name: 'Foreign', type: 'BIN' });
    await expect(f.warehouses.changeLocation(f.actor, foreignWh.id, { code: 'MINE', name: 'Mine', type: 'BIN' })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(f.warehouses.changeLocation(f.actor, wh.id, { code: 'CHILD', name: 'Child', type: 'BIN', parentLocationId: foreignLocation.id })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 422 });
    const receipt = await f.documents.create(f.actor, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: wh.id }, currency: 'EGP' });
    await expect(f.documents.line(f.actor, receipt.id, { productId: item.productId, quantity: '1', unitCost: '1', locationId: foreignLocation.id })).rejects.toMatchObject({ code: 'INVENTORY_LINE_INVALID', status: 422 });
    await expect(f.warehouses.get(f.actor, foreignWh.id)).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    await expect(db.inventoryLocation.create({ data: { workspaceId: f.workspace.id, warehouseId: foreignWh.id, code: 'BAD', name: 'Bad', type: 'BIN' } })).rejects.toThrow();
    expect(await db.inventoryLocation.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

  it('warehouse read list hides unauthorized warehouse balances', async () => {
    const db = database(), f = await inventoryFixture(db), item = await f.sku(), visible = await f.warehouse(), hidden = await f.warehouse();
    await f.receive(visible.id, item, '2'); await f.receive(hidden.id, item, '9');
    const viewer = await f.member();
    await f.grantWarehouse(visible.id, viewer.role.id, ['INVENTORY.WAREHOUSE_READ', 'INVENTORY.STOCK_READ', 'INVENTORY.MOVEMENT_READ']);
    expect((await f.warehouses.list(viewer.actor, {})).data.map(w => w.id)).toEqual([visible.id]);
    const stock = await f.stock.list(viewer.actor, {});
    expect(stock.data.map(row => row.warehouseId)).toEqual([visible.id]);
    expect(await f.stock.availability(viewer.actor, { productId: item.productId })).toMatchObject({ onHand: '2.000000' });
    const movements = (await f.stock.movements(viewer.actor, {}) as { data: Array<Record<string, unknown>> }).data;
    expect(movements.length).toBeGreaterThan(0);
    // The viewer lacks costing/valuation grants: movement costs are redacted.
    expect(movements.every(row => row.warehouseId === visible.id && !('unitCost' in row) && !('totalCost' in row))).toBe(true);
    await expect(f.stock.list(viewer.actor, { warehouseId: hidden.id })).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
    expect((await f.warehouses.list(f.actor, {})).data).toHaveLength(2);
  });

  it('permission changes invalidate cache and write Audit', async () => {
    const db = database(), f = await inventoryFixture(db), wh = await f.warehouse(), reader = await f.member();
    await expect(f.warehouses.get(reader.actor, wh.id)).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND' });
    await f.grantWarehouse(wh.id, reader.role.id, ['INVENTORY.WAREHOUSE_READ']);
    expect(await f.warehouses.get(reader.actor, wh.id)).toMatchObject({ id: wh.id, availableActions: ['INVENTORY.WAREHOUSE_READ'] });
    const current = await f.warehouses.permissions(f.actor, wh.id) as { version: string; grants: Array<{ roleId: string; action: string; scope: string }> };
    await f.warehouses.permissions(f.actor, wh.id, { expectedVersion: current.version, grants: current.grants.filter(g => g.roleId !== reader.role.id).map(({ roleId, action, scope }) => ({ roleId, action, scope })) });
    await expect(f.warehouses.get(reader.actor, wh.id)).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND' });
    const audits = await db.auditLog.findMany({ where: { entityId: wh.id, action: 'WAREHOUSE_PERMISSION_CHANGED' }, orderBy: { occurredAt: 'asc' } });
    expect(audits).toHaveLength(2); expect(audits[1].actorUserId).toBe(f.user.id);
    await expect(f.warehouses.permissions(f.actor, wh.id, { expectedVersion: current.version, grants: [] })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT', status: 409 });
    await expect(f.warehouses.permissions(reader.actor, wh.id, { expectedVersion: current.version, grants: [] })).rejects.toMatchObject({ status: 404 });
    const foreignRole = (await inventoryFixture(db)).role;
    const latest = await f.warehouses.permissions(f.actor, wh.id) as { version: string };
    await expect(f.warehouses.permissions(f.actor, wh.id, { expectedVersion: latest.version, grants: [{ roleId: foreignRole.id, action: 'INVENTORY.WAREHOUSE_READ', scope: 'ALL' }] })).rejects.toMatchObject({ code: 'WAREHOUSE_ACCESS_DENIED', status: 422 });
  });
});

export {};
