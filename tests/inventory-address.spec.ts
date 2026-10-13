import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { spaFixture } from './support/spa-fixture';
import { InventoryWarehouseService } from '../src/server/inventory/warehouse-service';
import { hydrateState } from '../src/server/persistence';
import { InMemoryStore } from '../src/server/store';
import { AccessService } from '../src/server/access-service';
import { RequisiteService } from '../src/server/commercial/requisite-service';

jest.setTimeout(120000); let db: PrismaClient;
beforeAll(async () => { const url = await prepareProcessPlatformDatabase('truecrm_inventory_address_test');
  db = new PrismaClient({ datasources: { db: { url } } }); }, 300000);
afterAll(async () => { await db?.$disconnect(); });
async function fixture() {
  const f = await spaFixture(db), company = await db.crmCompany.create({ data: { workspaceId: f.workspace.id,
    name: 'Address owner', responsibleUserId: f.user.id } });
  const store = new InMemoryStore(await hydrateState(db)), access = new AccessService(store);
  const owner = new RequisiteService(store, access), actor = access.actor(store.state.users.find(user => user.id === f.user.id)!, f.workspace.id);
  const preset = owner.createPreset(actor, { countryCode: 'EG', entityTypeCode: 'COMPANY', name: 'Company', fields: [] });
  const requisite = owner.create(actor, 'COMPANY', company.id, { presetId: preset.id, name: 'Company details', values: {} });
  const address = owner.addAddress(actor, requisite.id, { type: 'SHIPPING', countryCode: 'EG', line1: 'Warehouse location', isDefaultForType: true });
  for (const [collection, row] of [['requisitePresets', preset], ['requisites', requisite], ['requisiteAddresses', address]] as const)
    await db.commercialPackRecord.create({ data: { id: row.id, workspaceId: f.workspace.id, collection,
      data: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonObject } });
  const warehouses = new InventoryWarehouseService(db);
  const create = (id = address.id) => warehouses.create(f.actor, { name: 'Warehouse', code: 'MAIN', type: 'PHYSICAL', timezone: 'Africa/Cairo', location: id });
  return { ...f, company, requisite, address, warehouses, create };
}
async function archive(id: string) {
  const record = await db.commercialPackRecord.findUniqueOrThrow({ where: { id } });
  await db.commercialPackRecord.update({ where: { id }, data: { data: { ...record.data as Prisma.InputJsonObject, active: false } } });
}
describe('Owning shared Address authority for Warehouse bindings', () => {
  it('enforces the same tenant ownership chain for direct database writes', async () => {
    const f = await fixture(), foreign = await fixture();
    for (const addressId of [foreign.address.id, randomUUID()]) await expect(db.inventoryWarehouse.create({ data: {
      workspaceId: f.workspace.id, name: 'Forged', code: 'FORGED', type: 'PHYSICAL', timezone: 'UTC',
      addressId, createdByUserId: f.user.id } })).rejects.toThrow();
    expect(await db.inventoryWarehouse.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    const requisite = await db.commercialPackRecord.findUniqueOrThrow({ where: { id: f.requisite.id } });
    const invalid = { ...requisite.data as Prisma.InputJsonObject }; delete invalid.ownerType;
    await db.commercialPackRecord.update({ where: { id: requisite.id }, data: { data: invalid } });
    await expect(db.inventoryWarehouse.create({ data: { workspaceId: f.workspace.id, name: 'Invalid chain', code: 'INVALID',
      type: 'PHYSICAL', timezone: 'UTC', addressId: f.address.id, createdByUserId: f.user.id } })).rejects.toThrow();
  });
  it('binds a readable shared Address without copying or mutating owning records', async () => {
    const f = await fixture(), before = await db.commercialPackRecord.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: 'asc' } });
    const row = await f.create(); expect(row.addressId).toBe(f.address.id);
    expect(await db.commercialPackRecord.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db.outboxEvent.count({ where: { entityId: row.id, eventType: 'WAREHOUSE_CREATED' } })).toBe(1);
  });
  it('rejects foreign or missing addresses without leaking data or creating Warehouse evidence', async () => {
    const f = await fixture(), foreign = await fixture(), before = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
    for (const id of [foreign.address.id, randomUUID()]) await expect(f.create(id)).rejects.toMatchObject({ code: 'WAREHOUSE_ADDRESS_NOT_FOUND', status: 404 });
    expect(await db.inventoryWarehouse.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before);
  });
  it.each(['address', 'requisite', 'owner'] as const)('rejects an unavailable %s in the ownership chain', async target => {
    const f = await fixture();
    if (target === 'owner') await db.crmCompany.update({ where: { id: f.company.id }, data: { isDeleted: true } });
    else await archive(target === 'address' ? f.address.id : f.requisite.id);
    await expect(f.create()).rejects.toMatchObject({ code: 'WAREHOUSE_ADDRESS_NOT_FOUND', status: 404 });
    expect(await db.inventoryWarehouse.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });
  it('rechecks current explicit owning permission and its OWN scope', async () => {
    const f = await fixture(), grant = await db.permission.findUniqueOrThrow({ where: { key: 'requisite.read' } });
    const where = { roleId_permissionId: { roleId: f.role.id, permissionId: grant.id } };
    await db.rolePermission.update({ where, data: { isDeleted: true } });
    await expect(f.create()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const user = await db.user.create({ data: { firstName: 'Other', lastName: 'Owner', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: user.id, roleId: f.role.id } });
    await db.crmCompany.update({ where: { id: f.company.id }, data: { responsibleUserId: user.id } });
    await db.rolePermission.update({ where, data: { isDeleted: false, scope: 'OWN' } });
    await expect(f.create()).rejects.toMatchObject({ code: 'WAREHOUSE_ADDRESS_NOT_FOUND' });
    await db.crmCompany.update({ where: { id: f.company.id }, data: { responsibleUserId: f.user.id } });
    expect((await f.create()).addressId).toBe(f.address.id);
  });
});
