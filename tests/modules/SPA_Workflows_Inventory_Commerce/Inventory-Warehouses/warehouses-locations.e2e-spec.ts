import { randomUUID } from 'node:crypto';
import { inventoryHttpContract } from '@/tests/support/inventory-http-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
const code = () => 'WH_' + randomUUID().slice(0, 8).toUpperCase();
const contract = inventoryHttpContract('truecrm_inventory_warehouses_http_test', {
  'POST /api/v1/inventory/warehouses': async (f, db) => { const value = code();
    return { permission: 'INVENTORY.WAREHOUSE_MANAGE', ids: {}, body: { name: 'Main', code: value, type: 'PHYSICAL', timezone: 'Africa/Cairo' },
      verify: async data => { expect(data).toMatchObject({ code: value, status: 'ACTIVE', workspaceId: f.workspace.id });
        expect(await db.inventoryWarehouse.count({ where: { workspaceId: f.workspace.id, code: value } })).toBe(1);
        expect(await db.outboxEvent.count({ where: { entityId: data.id, eventType: 'WAREHOUSE_CREATED' } })).toBe(1);
        // The creating role receives warehouse ACL automatically.
        expect(await db.inventoryWarehousePermission.count({ where: { warehouseId: data.id, roleId: f.role.id } })).toBeGreaterThan(0); } }; },
  'GET /api/v1/inventory/warehouses': async f => { const a = await f.warehouse(), b = await f.warehouse();
    return { permission: 'INVENTORY.WAREHOUSE_READ', ids: {}, query: '?status=ACTIVE',
      verify: async (data, json) => { expect(data.map((w: { id: string }) => w.id).sort()).toEqual([a.id, b.id].sort()); expect(json.meta).toMatchObject({ total: 2 }); } }; },
  'GET /api/v1/inventory/warehouses/:warehouseId': async f => { const wh = await f.warehouse();
    return { permission: 'INVENTORY.WAREHOUSE_READ', ids: { warehouseId: wh.id },
      verify: async data => { expect(data).toMatchObject({ id: wh.id, code: wh.code, availableActions: expect.arrayContaining(['INVENTORY.WAREHOUSE_MANAGE']) }); } }; },
  'PATCH /api/v1/inventory/warehouses/:warehouseId': async (f, db) => { const wh = await f.warehouse();
    return { permission: 'INVENTORY.WAREHOUSE_MANAGE', ids: { warehouseId: wh.id }, body: { expectedVersion: wh.version.toString(), name: 'Renamed', priority: 3 },
      verify: async data => { expect(data).toMatchObject({ name: 'Renamed', priority: 3, version: String(wh.version + 1n) });
        expect(await db.inventoryWarehouse.findUniqueOrThrow({ where: { id: wh.id } })).toMatchObject({ name: 'Renamed', code: wh.code }); } }; },
  'POST /api/v1/inventory/warehouses/:warehouseId/archive': async (f, db) => { const wh = await f.warehouse();
    return { permission: 'INVENTORY.WAREHOUSE_MANAGE', ids: { warehouseId: wh.id }, body: { expectedVersion: wh.version.toString() },
      verify: async data => { expect(data).toMatchObject({ id: wh.id, status: 'ARCHIVED' });
        expect(await db.outboxEvent.count({ where: { entityId: wh.id, eventType: 'WAREHOUSE_ARCHIVED' } })).toBe(1); } }; },
  'GET /api/v1/inventory/warehouses/:warehouseId/locations': async f => { const wh = await f.warehouse();
    const bin = await f.warehouses.changeLocation(f.actor, wh.id, { code: 'BIN_1', name: 'Bin 1', type: 'BIN' });
    return { permission: 'INVENTORY.WAREHOUSE_READ', ids: { warehouseId: wh.id },
      verify: async data => { expect(data.map((l: { id: string }) => l.id)).toEqual([bin.id]); } }; },
  'POST /api/v1/inventory/warehouses/:warehouseId/locations': async (f, db) => { const wh = await f.warehouse();
    return { permission: 'INVENTORY.LOCATION_MANAGE', ids: { warehouseId: wh.id }, body: { code: 'ZONE_A', name: 'Zone A', type: 'ZONE' },
      verify: async data => { expect(data).toMatchObject({ warehouseId: wh.id, code: 'ZONE_A', type: 'ZONE' });
        expect(await db.inventoryLocation.count({ where: { warehouseId: wh.id } })).toBe(1);
        expect(await db.outboxEvent.count({ where: { entityId: wh.id, eventType: 'WAREHOUSE_LOCATION_CHANGED' } })).toBe(1); } }; },
  'PATCH /api/v1/inventory/warehouses/:warehouseId/locations/:locationId': async (f, db) => { const wh = await f.warehouse();
    const zone = await f.warehouses.changeLocation(f.actor, wh.id, { code: 'ZONE_A', name: 'Zone A', type: 'ZONE' });
    const bin = await f.warehouses.changeLocation(f.actor, wh.id, { code: 'BIN_1', name: 'Bin 1', type: 'BIN' });
    return { permission: 'INVENTORY.LOCATION_MANAGE', ids: { warehouseId: wh.id, locationId: bin.id }, body: { expectedVersion: bin.version.toString(), name: 'Bin one', parentLocationId: zone.id },
      verify: async data => { expect(data).toMatchObject({ id: bin.id, name: 'Bin one', parentLocationId: zone.id });
        expect(await db.inventoryLocation.findUniqueOrThrow({ where: { id: bin.id } })).toMatchObject({ parentLocationId: zone.id }); } }; },
  'GET /api/v1/inventory/warehouses/:warehouseId/permissions': async f => { const wh = await f.warehouse();
    return { permission: 'INVENTORY.PERMISSION_MANAGE', ids: { warehouseId: wh.id },
      verify: async data => { expect(data.version).toEqual(expect.any(String));
        expect(data.grants).toEqual(expect.arrayContaining([expect.objectContaining({ roleId: f.role.id, action: 'INVENTORY.STOCK_READ' })])); } }; },
  'PUT /api/v1/inventory/warehouses/:warehouseId/permissions': async (f, db) => { const wh = await f.warehouse(), reader = await f.member();
    const current = await f.warehouses.permissions(f.actor, wh.id) as { version: string; grants: Array<{ roleId: string; action: string; scope: string }> };
    const grants = [...current.grants.map(({ roleId, action, scope }) => ({ roleId, action, scope })), { roleId: reader.role.id, action: 'INVENTORY.STOCK_READ', scope: 'ALL' }];
    return { permission: 'INVENTORY.PERMISSION_MANAGE', ids: { warehouseId: wh.id }, body: { expectedVersion: current.version, grants },
      verify: async data => { expect(data).toEqual({ version: String(BigInt(current.version) + 1n) });
        expect(await db.inventoryWarehousePermission.count({ where: { warehouseId: wh.id, roleId: reader.role.id } })).toBe(1);
        expect(await db.outboxEvent.count({ where: { entityId: wh.id, eventType: 'WAREHOUSE_PERMISSION_CHANGED' } })).toBe(1); } }; },
});

describe('Warehouses, Locations and Scoped Access — REST E2E contract', () => {
  it('POST /api/v1/inventory/warehouses verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('POST /api/v1/inventory/warehouses'));
  it('GET /api/v1/inventory/warehouses verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/warehouses'));
  it('GET /api/v1/inventory/warehouses/:warehouseId verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/warehouses/:warehouseId'));
  it('PATCH /api/v1/inventory/warehouses/:warehouseId verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('PATCH /api/v1/inventory/warehouses/:warehouseId'));
  it('POST /api/v1/inventory/warehouses/:warehouseId/archive verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('POST /api/v1/inventory/warehouses/:warehouseId/archive'));
  it('GET /api/v1/inventory/warehouses/:warehouseId/locations verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/warehouses/:warehouseId/locations'));
  it('POST /api/v1/inventory/warehouses/:warehouseId/locations verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('POST /api/v1/inventory/warehouses/:warehouseId/locations'));
  it('PATCH /api/v1/inventory/warehouses/:warehouseId/locations/:locationId verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('PATCH /api/v1/inventory/warehouses/:warehouseId/locations/:locationId'));
  it('GET /api/v1/inventory/warehouses/:warehouseId/permissions verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('GET /api/v1/inventory/warehouses/:warehouseId/permissions'));
  it('PUT /api/v1/inventory/warehouses/:warehouseId/permissions verifies response, permission/token, tenant scope, DB effect and outbox', () => contract('PUT /api/v1/inventory/warehouses/:warehouseId/permissions'));
});

export {};
