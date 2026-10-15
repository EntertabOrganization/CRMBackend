import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './process-platform-db';
import { spaFixture } from './spa-fixture';
import { resolvePrincipal, type Principal } from '../../src/server/process-platform/context';
import { resetRateLimits } from '../../src/server/rate-limit';
import { InventoryWarehouseService } from '../../src/server/inventory/warehouse-service';
import { InventoryStockService } from '../../src/server/inventory/stock-service';
import { InventoryPolicyService } from '../../src/server/inventory/policy-service';
import { InventoryCostingService } from '../../src/server/inventory/costing-service';
import { InventoryDocumentService } from '../../src/server/inventory/document-service';
import { InventoryReservationService } from '../../src/server/inventory/reservation-service';
import { InventoryTrackingService } from '../../src/server/inventory/tracking-service';
import { InventoryReorderService } from '../../src/server/inventory/reorder-service';
import { InventoryStocktakeService } from '../../src/server/inventory/stocktake-service';
import { InventoryReconciliationService } from '../../src/server/inventory/reconciliation-service';
import { InventoryControlledJobsService } from '../../src/server/inventory/controlled-jobs-service';

/** Each Inventory contract suite recreates one owned disposable database; each case uses fresh Workspaces. */
export function inventoryDatabase(name: string) {
  let db: PrismaClient;
  beforeAll(async () => {
    const url = await prepareProcessPlatformDatabase(name);
    db = new PrismaClient({ datasources: { db: { url } } });
  }, 300000);
  afterAll(async () => { await db?.$disconnect(); const { prisma } = await import('../../src/server/prisma-client'); await prisma.$disconnect(); });
  beforeEach(() => resetRateLimits());
  jest.setTimeout(180000);
  return () => db;
}

/** The same owning-service composition as the Inventory router. */
export function inventoryServices(db: PrismaClient) {
  const warehouses = new InventoryWarehouseService(db);
  const documents = new InventoryDocumentService(db, warehouses);
  const reservations = new InventoryReservationService(db, warehouses, documents.sources);
  documents.setReservationPort(reservations); reservations.setDocumentAuthority(documents);
  const stocktakes = new InventoryStocktakeService(db, warehouses, documents);
  documents.setStocktakePort(stocktakes);
  return { warehouses, documents, reservations, stocktakes, stock: new InventoryStockService(db, warehouses), policies: new InventoryPolicyService(db),
    costing: new InventoryCostingService(db, warehouses), tracking: new InventoryTrackingService(db, warehouses, documents), reorder: new InventoryReorderService(db, warehouses),
    reconciliation: new InventoryReconciliationService(db, warehouses), jobs: new InventoryControlledJobsService(db, warehouses, documents) };
}

type Tracking = { tracking?: 'NONE' | 'SERIAL' | 'BATCH'; enforceBatchExpiry?: boolean; precision?: number; variant?: boolean; type?: 'SIMPLE_PRODUCT' | 'SERVICE' };
export async function inventoryFixture(db: PrismaClient) {
  const spa = await spaFixture(db);
  const s = inventoryServices(db);
  const source = await spa.create('Inventory source');
  const catalog = await db.catalog.create({ data: { workspaceId: spa.workspace.id, name: 'Inventory', normalizedName: 'inventory-' + randomUUID() } });
  /** Catalog SKU. Tracking policy is Catalog-owned; `variant` returns a Variant SKU of a parent carrying the policy. */
  const sku = async (options: Tracking = {}) => {
    const suffix = randomUUID().slice(0, 8);
    const unit = await db.catalogUnit.create({ data: { workspaceId: spa.workspace.id, name: 'Unit ' + suffix, code: 'U' + suffix.toUpperCase(), precision: options.precision ?? 0 } });
    const type = options.variant ? 'PRODUCT_WITH_VARIANTS' : options.type ?? 'SIMPLE_PRODUCT';
    const parent = await db.catalogProduct.create({ data: { workspaceId: spa.workspace.id, catalogId: catalog.id, type, name: 'SKU ' + suffix, sku: options.variant ? null : 'S-' + suffix,
      skuKey: options.variant ? null : 's-' + suffix, primaryUnitId: unit.id, inventoryTracking: options.tracking ?? 'NONE', enforceBatchExpiry: options.enforceBatchExpiry ?? false } });
    if (!options.variant) return { productId: parent.id, variantId: undefined as string | undefined, inventoryKey: parent.id, unit };
    const variant = await db.catalogProduct.create({ data: { workspaceId: spa.workspace.id, catalogId: catalog.id, type: 'VARIANT', parentId: parent.id, name: 'Variant ' + suffix,
      sku: 'V-' + suffix, skuKey: 'v-' + suffix, primaryUnitId: unit.id, axisKey: suffix } });
    return { productId: parent.id, variantId: variant.id as string | undefined, inventoryKey: variant.id, unit };
  };
  const warehouse = async (code = 'WH_' + randomUUID().slice(0, 8).toUpperCase(), actor: Principal = spa.actor) =>
    s.warehouses.create(actor, { name: code, code, type: 'PHYSICAL', timezone: 'Africa/Cairo' });
  type Line = { productId: string; variantId?: string; quantity: string; unitCost?: string } & Record<string, unknown>;
  /** Draft document with lines; returns the document id and current version. */
  const draft = async (documentType: string, warehouseIds: { source?: string; destination?: string }, lines: Line[], currency = 'EGP', actor: Principal = spa.actor, sourceRef?: object) => {
    const document = await s.documents.create(actor, { documentType, warehouseIds, currency, ...(sourceRef ? { sourceRef } : {}) });
    let version = document.version.toString(); const lineIds: string[] = [];
    for (const line of lines) {
      const added = await s.documents.line(actor, document.id, { unitCost: '0', ...line }) as { id: string; documentVersion: string };
      version = added.documentVersion; lineIds.push(added.id);
    }
    return { id: document.id, version, lineIds };
  };
  const post = async (id: string, actor: Principal = spa.actor, key: string = randomUUID()) => {
    const current = await db.inventoryDocument.findUniqueOrThrow({ where: { id } });
    return s.documents.process(actor, id, { expectedVersion: current.version.toString() }, key);
  };
  const receive = async (warehouseId: string, item: { productId: string; variantId?: string }, quantity: string, unitCost = '10', currency = 'EGP', extra: Record<string, unknown> = {}) => {
    const d = await draft('STOCK_RECEIPT', { destination: warehouseId }, [{ productId: item.productId, ...(item.variantId ? { variantId: item.variantId } : {}), quantity, unitCost, ...extra }], currency);
    await post(d.id); return d;
  };
  const balance = async (warehouseId: string, inventoryKey: string) => {
    const rows = await db.inventoryBalance.findMany({ where: { workspaceId: spa.workspace.id, warehouseId, inventoryKey } });
    const sum = (key: 'onHand' | 'reserved') => rows.reduce((total, row) => total + Number(row[key]), 0);
    return { onHand: sum('onHand'), reserved: sum('reserved'), available: sum('onHand') - sum('reserved') };
  };
  const member = async (grants: Record<string, string | null> = {}) => {
    const user = await db.user.create({ data: { firstName: 'Inventory', lastName: 'Member', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    const role = await db.role.create({ data: { workspaceId: spa.workspace.id, name: 'Member ' + randomUUID().slice(0, 8) } });
    await db.workspaceMembership.create({ data: { workspaceId: spa.workspace.id, userId: user.id, roleId: role.id } });
    await db.rolePermission.createMany({ data: (await db.permission.findMany()).filter(p => grants[p.key] !== null)
      .map(p => ({ roleId: role.id, permissionId: p.id, scope: (grants[p.key] ?? 'WORKSPACE') as 'WORKSPACE' })) });
    return { user, role, actor: await resolvePrincipal(db, spa.workspace.id, user.id) };
  };
  /** Grant a role warehouse ACL actions (the creator's role receives ALL automatically). */
  const grantWarehouse = async (warehouseId: string, roleId: string, actions: string[], scope = 'ALL') => {
    const current = await s.warehouses.permissions(spa.actor, warehouseId) as { version: string; grants: Array<{ roleId: string; action: string; scope: string }> };
    const grants = [...current.grants.filter(g => !(g.roleId === roleId && actions.includes(g.action))).map(({ roleId, action, scope }) => ({ roleId, action, scope })),
      ...actions.map(action => ({ roleId, action, scope }))];
    return s.warehouses.permissions(spa.actor, warehouseId, { expectedVersion: current.version, grants });
  };
  /** Commerce Order source carrying planned SKU quantities (owning Order authority reads its snapshot). */
  const order = async (lines: Array<{ inventoryKey: string; quantity: string }>) => {
    const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
    const store = await db.commerceStore.create({ data: { workspaceId: spa.workspace.id, name: 'Store', code: 'ST' + randomUUID().slice(0, 6).toUpperCase(), status: 'ACTIVE', catalogId: catalog.id,
      defaultCurrency: 'EGP', timezone: 'Africa/Cairo', createdByUserId: spa.user.id, settings: {} } });
    const cart = await db.commerceCart.create({ data: { workspaceId: spa.workspace.id, storeId: store.id, tokenHash: hash(), currency: 'EGP', expiresAt: new Date(Date.now() + 3600000) } });
    const session = await db.commerceCheckoutSession.create({ data: { workspaceId: spa.workspace.id, storeId: store.id, cartId: cart.id, tokenHash: hash(), customerSnapshot: {}, addressSnapshot: {}, payerType: 'PERSON', expiresAt: new Date(Date.now() + 3600000) } });
    return db.commerceOrder.create({ data: { workspaceId: spa.workspace.id, storeId: store.id, cartId: cart.id, checkoutSessionId: session.id, currency: 'EGP', total: '100',
      snapshot: { lines: lines.map(line => ({ itemId: randomUUID(), ...line })) }, consents: [] } });
  };
  const settings = async (changes: Record<string, unknown>) => {
    const current = await s.policies.get(spa.actor) as { version: bigint | string };
    return s.policies.update(spa.actor, { expectedVersion: current.version.toString(), ...changes });
  };
  return { ...spa, ...s, source, catalog, sku, warehouse, draft, post, receive, balance, member, grantWarehouse, order, settings };
}
export type InventoryFixture = Awaited<ReturnType<typeof inventoryFixture>>;
