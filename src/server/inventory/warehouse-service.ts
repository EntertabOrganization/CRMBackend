import type { PrismaClient,InventoryWarehouse } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { parse,uuid,name,code,timezone,pageQuery } from '../process-platform/dto';
import { inventoryVersion,assertInventoryVersion,warehouseType,warehouseStatus } from './dto';
import catalog from '../process-platform/permission-catalog.json';

const actions = catalog.filter(value => value.startsWith('INVENTORY.'));
const action = z.string().refine(value => actions.includes(value));
const scope = z.enum(['NONE','OWN','DEPARTMENT','DEPARTMENT_TREE','ALL']);
const scopes = { OWN: 'OWN',DEPARTMENT: 'DEPARTMENT',DEPARTMENT_TREE: 'DEPARTMENT_TREE',ALL: 'WORKSPACE' };
const locationType = z.enum(['AISLE','RACK','BIN','ZONE']);
const createWarehouse = z.strictObject({ name,code,type: warehouseType,timezone,location: uuid.optional(),phone: z.string().max(40).optional() });
export interface InventoryAddressPort { assertReadable(tx: Tx,actor: Principal,addressId: string): Promise<void> }

/** Warehouse ACL intersects the platform role privilege. Missing grants deny, including owner-role callers. */
export class InventoryWarehouseService {
  constructor(private readonly db: PrismaClient,private readonly addresses?: InventoryAddressPort) {}
  async allowed(tx: Tx,actor: Principal,row: InventoryWarehouse,permission: string) {
    if (!actor.grants.has(permission)) return false;
    const grant = await tx.inventoryWarehousePermission.findUnique({ where: { workspaceId_warehouseId_roleId_action: {
      workspaceId: actor.workspaceId,warehouseId: row.id,roleId: actor.roleId,action: permission } } });
    if (!grant || grant.scope==='NONE' || !Object.hasOwn(scopes,grant.scope)) return false;
    const roleVisible = await ownerVisible(tx,actor,row.createdByUserId,permission);
    const aclActor = { ...actor,grants: new Map(actor.grants).set(permission,scopes[grant.scope as keyof typeof scopes]) };
    return roleVisible && await ownerVisible(tx,aclActor,row.createdByUserId,permission);
  }
  async warehouse(tx: Tx,actor: Principal,id: string,permission: string,active = false) {
    parse(uuid,id); requirePermission(actor,permission);
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    if ((workspace.settings as { entitlements?: { inventory?: boolean } }).entitlements?.inventory===false) throw new AppError('PERMISSION_DENIED','Inventory is unavailable for this Workspace.',403);
    const row = await tx.inventoryWarehouse.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row || !await this.allowed(tx,actor,row,permission)) throw new AppError('WAREHOUSE_NOT_FOUND','Warehouse was not found.',404);
    if (active && row.status!=='ACTIVE') throw new AppError('WAREHOUSE_ACCESS_DENIED','Warehouse is not active.',409);
    if (active && (await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } }))?.isEnabled===false) throw new AppError('PERMISSION_DENIED','Inventory is disabled.',403);
    return row;
  }
  async availableWarehouses(tx: Tx,actor: Principal,permission: string,activeOnly = true) {
    requirePermission(actor,permission);
    const rows = await tx.inventoryWarehouse.findMany({ where: { workspaceId: actor.workspaceId,...(activeOnly ? { status: 'ACTIVE' } : {}) },orderBy: [{ priority: 'asc' },{ id: 'asc' }] });
    const result = [];
    for (const row of rows) if (await this.allowed(tx,actor,row,permission)) result.push(row); return result;
  }
  async create(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.WAREHOUSE_MANAGE',true); const input = parse(createWarehouse,raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.WAREHOUSE_MANAGE',true);
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
      if ((workspace.settings as { entitlements?: { inventory?: boolean } }).entitlements?.inventory===false) throw new AppError('PERMISSION_DENIED','Inventory is unavailable for this Workspace.',403);
      if (input.location) {
        if (!this.addresses) throw new AppError('INVENTORY_ADDRESS_UNAVAILABLE','Shared Address authority is not configured.',503);
        await this.addresses.assertReadable(tx,actor,input.location);
      }
      if (await tx.inventoryWarehouse.count({ where: { workspaceId: actor.workspaceId,code: input.code } })) throw new AppError('WAREHOUSE_CODE_EXISTS','Warehouse code already exists.',409);
      const { location,...data } = input;
      const row = await tx.inventoryWarehouse.create({ data: { ...data,workspaceId: actor.workspaceId,addressId: location,createdByUserId: actor.userId,
        isDefault: !await tx.inventoryWarehouse.count({ where: { workspaceId: actor.workspaceId,status: 'ACTIVE' } }) } });
      await tx.inventoryWarehousePermission.createMany({ data: actions.filter(permission => actor.grants.has(permission)).map(permission => ({
        workspaceId: actor.workspaceId,warehouseId: row.id,roleId: actor.roleId,action: permission,scope: 'ALL' })) });
      await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId,defaultWarehouseId: row.id },
        update: row.isDefault ? { defaultWarehouseId: row.id,version: { increment: 1 } } : {} });
      await evidence(tx,actor,'WAREHOUSE',row.id,'WAREHOUSE_CREATED',{ code: row.code,version: row.version.toString() }); return row;
    },{ timeout: 60000 });
  }
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.WAREHOUSE_READ'); const query = parse(pageQuery.extend({ status: warehouseStatus.optional(),type: warehouseType.optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.inventoryWarehouse.findMany({ where: { workspaceId: actor.workspaceId,status: query.status,type: query.type,
        ...(query.search ? { OR: [{ name: { contains: query.search,mode: 'insensitive' } },{ code: { contains: query.search,mode: 'insensitive' } }] } : {}) },orderBy: [{ priority: 'asc' },{ id: 'asc' }] });
      const visible = [];
      for (const row of rows) if (await this.allowed(tx,actor,row,'INVENTORY.WAREHOUSE_READ')) visible.push(row);
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async get(actor: Principal,id: string) {
    return this.db.$transaction(async tx => {
      const row = await this.warehouse(tx,actor,id,'INVENTORY.WAREHOUSE_READ'),availableActions = [];
      for (const permission of actions) if (await this.allowed(tx,actor,row,permission)) availableActions.push(permission);
      return { ...row,availableActions };
    });
  }
  private async unused(tx: Tx,actor: Principal,id: string) {
    const [balances,reservations,documents,stocktakes] = await Promise.all([
      tx.inventoryBalance.count({ where: { workspaceId: actor.workspaceId,warehouseId: id,OR: [{ onHand: { not: 0 } },{ reserved: { not: 0 } }] } }),
      tx.inventoryReservationAllocation.count({ where: { workspaceId: actor.workspaceId,warehouseId: id,quantity: { gt: 0 } } }),
      tx.inventoryDocument.count({ where: { workspaceId: actor.workspaceId,status: { in: ['DRAFT','PENDING_APPROVAL','APPROVED'] },OR: [{ sourceWarehouseId: id },{ destinationWarehouseId: id }] } }),
      tx.inventoryStocktake.count({ where: { workspaceId: actor.workspaceId,warehouseId: id,status: { in: ['DRAFT','COUNTING','RECONCILING'] } } })]);
    if (balances || reservations || documents || stocktakes) throw new AppError('WAREHOUSE_IN_USE','Warehouse has stock, reservations or active documents.',409);
  }
  async update(actor: Principal,id: string,raw: unknown,archive = false) {
    const input = archive ? parse(z.strictObject({ expectedVersion: inventoryVersion }),raw)
      : parse(z.strictObject({ expectedVersion: inventoryVersion,name: name.optional(),timezone: timezone.optional(),priority: z.number().int().min(0).max(100000).optional(),status: z.enum(['ACTIVE','INACTIVE']).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:warehouse:' + id);
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); const row = await this.warehouse(tx,actor,id,'INVENTORY.WAREHOUSE_MANAGE'); assertInventoryVersion(row.version,input.expectedVersion);
      if (row.status==='ARCHIVED') throw new AppError('WAREHOUSE_ACCESS_DENIED','Archived Warehouse cannot be changed.',409);
      const { expectedVersion,...changes } = input, status = archive ? 'ARCHIVED' : 'status' in input && typeof input.status==='string' ? input.status : undefined;
      if (status && status!=='ACTIVE') await this.unused(tx,actor,id);
      if (status && status!=='ACTIVE' && row.isDefault) {
        const replacement = await tx.inventoryWarehouse.findFirst({ where: { workspaceId: actor.workspaceId,id: { not: id },status: 'ACTIVE' },orderBy: [{ priority: 'asc' },{ id: 'asc' }] });
        // Clear the unique default before assigning its replacement.
        await tx.inventoryWarehouse.update({ where: { id },data: { isDefault: false } });
        if (replacement) await tx.inventoryWarehouse.update({ where: { id: replacement.id },data: { isDefault: true,version: { increment: 1 } } });
        await tx.inventorySettings.updateMany({ where: { workspaceId: actor.workspaceId,defaultWarehouseId: id },data: { defaultWarehouseId: replacement?.id ?? null,version: { increment: 1 } } });
      }
      const updated = await tx.inventoryWarehouse.update({ where: { id },data: { ...changes,status,version: { increment: 1 } } });
      await evidence(tx,actor,'WAREHOUSE',id,archive ? 'WAREHOUSE_ARCHIVED' : 'WAREHOUSE_UPDATED',{ version: updated.version.toString() }); return updated;
    });
  }
  async permissions(actor: Principal,id: string,raw?: unknown) {
    const input = raw===undefined ? undefined : parse(z.strictObject({ expectedVersion: inventoryVersion,grants: z.array(z.strictObject({ roleId: uuid,action,scope })).max(2000)
      .refine(rows => new Set(rows.map(r => r.roleId + ':' + r.action)).size===rows.length) }),raw);
    return this.db.$transaction(async tx => {
      if (input) { await lock(tx,actor.workspaceId,'inventory:warehouse:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); }
      requirePermission(actor,'INVENTORY.PERMISSION_MANAGE',true); const row = await this.warehouse(tx,actor,id,'INVENTORY.PERMISSION_MANAGE');
      if (input) {
        assertInventoryVersion(row.version,input.expectedVersion);
        const roleIds = [...new Set(input.grants.map(g => g.roleId))];
        if (await tx.role.count({ where: { workspaceId: actor.workspaceId,id: { in: roleIds },isDeleted: false } })!==roleIds.length)
          throw new AppError('WAREHOUSE_ACCESS_DENIED','Role is unavailable.',422);
        await tx.inventoryWarehousePermission.deleteMany({ where: { workspaceId: actor.workspaceId,warehouseId: id } });
        await tx.inventoryWarehousePermission.createMany({ data: input.grants.map(g => ({ ...g,workspaceId: actor.workspaceId,warehouseId: id })) });
        const updated = await tx.inventoryWarehouse.update({ where: { id },data: { version: { increment: 1 } } });
        await evidence(tx,actor,'WAREHOUSE',id,'WAREHOUSE_PERMISSION_CHANGED',{ version: updated.version.toString(),grants: input.grants });
        return { version: updated.version.toString() };
      }
      return { version: row.version.toString(),grants: await tx.inventoryWarehousePermission.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: id },orderBy: [{ roleId: 'asc' },{ action: 'asc' }] }) };
    });
  }
  async locations(actor: Principal,warehouseId: string,raw: unknown) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.warehouse(tx,actor,warehouseId,'INVENTORY.WAREHOUSE_READ'); const where = { workspaceId: actor.workspaceId,warehouseId };
      const [rows,total] = await Promise.all([tx.inventoryLocation.findMany({ where,orderBy: [{ code: 'asc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.inventoryLocation.count({ where })]);
      return { data: rows,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async changeLocation(actor: Principal,warehouseId: string,raw: unknown,id?: string) {
    const input = id ? parse(z.strictObject({ expectedVersion: inventoryVersion,name: name.optional(),parentLocationId: uuid.nullable().optional() }),raw)
      : parse(z.strictObject({ parentLocationId: uuid.optional(),code,name,type: locationType }),raw);
    if (id) parse(uuid,id);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:warehouse:' + warehouseId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      await this.warehouse(tx,actor,warehouseId,'INVENTORY.LOCATION_MANAGE',true);
      const row = id ? await tx.inventoryLocation.findFirst({ where: { workspaceId: actor.workspaceId,warehouseId,id } }) : null;
      if (id && !row) throw new AppError('WAREHOUSE_NOT_FOUND','Location was not found.',404);
      if (row && 'expectedVersion' in input) assertInventoryVersion(row.version,input.expectedVersion);
      if (input.parentLocationId) {
        const parents = await tx.inventoryLocation.findMany({ where: { workspaceId: actor.workspaceId,warehouseId,status: 'ACTIVE' } });
        const visited = new Set<string>(); let parent: string | null = input.parentLocationId;
        while (parent) {
          if (parent===id || visited.has(parent)) throw new AppError('LOCATION_CYCLE','Location hierarchy cannot contain a cycle.',422);
          visited.add(parent); const candidate = parents.find(p => p.id===parent);
          if (!candidate) throw new AppError('WAREHOUSE_NOT_FOUND','Parent location is unavailable.',422); parent = candidate.parentLocationId;
        }
      }
      const updated = row && 'expectedVersion' in input ? await tx.inventoryLocation.update({ where: { id: row.id },data: { name: input.name,parentLocationId: input.parentLocationId,version: { increment: 1 } } })
        : 'code' in input ? await tx.inventoryLocation.create({ data: { workspaceId: actor.workspaceId,warehouseId,...input } }) : null;
      if (!updated) throw new AppError('INVALID_ARGUMENT','Location payload is invalid.',400);
      await evidence(tx,actor,'WAREHOUSE',warehouseId,'WAREHOUSE_LOCATION_CHANGED',{ locationId: updated.id,version: updated.version.toString() }); return updated;
    });
  }
}
