import { Prisma,type PrismaClient,type InventoryJob } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { parse,uuid } from '../process-platform/dto';
import { InventoryWarehouseService } from './warehouse-service';
import { exact,numeric24 } from './decimal';
import { observeReorder } from './reorder-service';

const request = z.strictObject({ warehouseId: uuid.optional(),dryRun: z.boolean().default(true) });
const jobInput = z.strictObject({ warehouseIds: z.array(uuid).min(1),dryRun: z.boolean() });
type Projection = { warehouseId: string;inventoryKey: string;productId: string;variantId: string | null;locationId: string | null;locationKey: string;onHand: string;reserved: string };
export class InventoryReconciliationService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db)) {}
  async create(actor: Principal,raw: unknown,key: string | null) {
    const input = parse(request,raw); requirePermission(actor,'INVENTORY.STOCK_RECONCILE');
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.STOCK_RECONCILE');
      const result = await command(tx,actor,'INVENTORY.STOCK_RECONCILE',key,input,async () => {
        const warehouseIds = input.warehouseId ? [(await this.warehouses.warehouse(tx,actor,input.warehouseId,'INVENTORY.STOCK_RECONCILE')).id]
          : (await this.warehouses.availableWarehouses(tx,actor,'INVENTORY.STOCK_RECONCILE',false)).map(row => row.id);
        if (!warehouseIds.length) throw new AppError('WAREHOUSE_ACCESS_DENIED','No warehouse is available for reconciliation.',403);
        const job = await tx.inventoryJob.create({ data: { workspaceId: actor.workspaceId,type: 'STOCK_RECONCILE',requestedByUserId: actor.userId,input: { warehouseIds,dryRun: input.dryRun } } });
        await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_RECONCILIATION_QUEUED',{ warehouseIds,dryRun: input.dryRun,correlationId: job.correlationId });
        return { jobId: job.id,status: job.status,correlationId: job.correlationId };
      });
      await this.authorized(tx,actor,result.jobId); return result;
    });
  }
  private async authorized(tx: Tx,actor: Principal,id: string) {
    parse(uuid,id); requirePermission(actor,'INVENTORY.STOCK_RECONCILE');
    const job = await tx.inventoryJob.findFirst({ where: { workspaceId: actor.workspaceId,id,type: 'STOCK_RECONCILE' } });
    if (!job || !await ownerVisible(tx,actor,job.requestedByUserId,'INVENTORY.STOCK_RECONCILE')) throw new AppError('STOCK_RECONCILIATION_NOT_FOUND','Reconciliation job was not found.',404);
    for (const warehouseId of parse(jobInput,job.input).warehouseIds) await this.warehouses.warehouse(tx,actor,warehouseId,'INVENTORY.STOCK_RECONCILE');
    return job;
  }
  async get(actor: Principal,id: string) {
    return this.db.$transaction(async tx => {
      const job = await this.authorized(tx,actor,id);
      return { jobId: job.id,status: job.status,correlationId: job.correlationId,dryRun: parse(jobInput,job.input).dryRun,result: job.result,errorCode: job.errorCode,
        createdAt: job.createdAt,completedAt: job.completedAt,attemptCount: job.attemptCount };
    });
  }
  private async replay(tx: Tx,workspaceId: string,warehouseIds: string[]) {
    const projections = new Map<string,Projection>();
    const identity = (row: { warehouseId: string;inventoryKey: string;locationId: string | null }) => row.warehouseId + ':' + row.inventoryKey + ':' + (row.locationId ?? '');
    const movements = await tx.inventoryMovement.groupBy({ by: ['warehouseId','inventoryKey','productId','variantId','locationId'],where: { workspaceId,warehouseId: { in: warehouseIds } },_sum: { quantityDelta: true } });
    for (const movement of movements) projections.set(identity(movement),{ warehouseId: movement.warehouseId,inventoryKey: movement.inventoryKey,
      productId: movement.productId,variantId: movement.variantId,locationId: movement.locationId,locationKey: movement.locationId ?? '',onHand: numeric24(movement._sum.quantityDelta ?? '0'),reserved: '0' });
    // Expired ACTIVE records retain their allocation until the reservation owner's expiry transaction releases them.
    const reservations = await tx.inventoryReservation.findMany({ where: { workspaceId,status: { in: ['ACTIVE','PARTIALLY_FULFILLED'] } },select: { id: true,inventoryKey: true,productId: true,variantId: true } });
    const owners = new Map(reservations.map(row => [row.id,row]));
    const legs = await tx.inventoryReservationAllocation.findMany({ where: { workspaceId,warehouseId: { in: warehouseIds },reservationId: { in: reservations.map(row => row.id) },quantity: { gt: 0 } } });
    for (const leg of legs) {
      const owner = owners.get(leg.reservationId)!,key = identity({ ...leg,inventoryKey: owner.inventoryKey });
      const projection = projections.get(key) ?? { warehouseId: leg.warehouseId,inventoryKey: owner.inventoryKey,productId: owner.productId,variantId: owner.variantId,locationId: leg.locationId,locationKey: leg.locationKey,onHand: '0',reserved: '0' };
      projection.reserved = numeric24(exact(projection.reserved).plus(leg.quantity)); projections.set(key,projection);
    }
    return { projections,identity };
  }
  private async execute(tx: Tx,job: InventoryJob,lease: string) {
    await lock(tx,job.workspaceId,'inventory:configuration'); await lock(tx,job.workspaceId,'inventory:job:' + job.id);
    const live = await tx.inventoryJob.findFirst({ where: { workspaceId: job.workspaceId,id: job.id,status: 'RUNNING',leaseOwner: lease } });
    if (!live) return false;
    const actor = await resolvePrincipal(tx,job.workspaceId,job.requestedByUserId);
    await this.authorized(tx,actor,job.id); const input = parse(jobInput,job.input);
    for (const warehouseId of [...input.warehouseIds].sort()) await lock(tx,job.workspaceId,'inventory:warehouse:' + warehouseId);
    const { projections,identity } = await this.replay(tx,job.workspaceId,input.warehouseIds);
    const balances = await tx.inventoryBalance.findMany({ where: { workspaceId: job.workspaceId,warehouseId: { in: input.warehouseIds } } });
    for (const row of balances) if (!projections.has(identity(row))) projections.set(identity(row),{ warehouseId: row.warehouseId,inventoryKey: row.inventoryKey,
      productId: row.productId,variantId: row.variantId,locationId: row.locationId,locationKey: row.locationKey,onHand: '0',reserved: '0' });
    const indexed = new Map(balances.map(row => [identity(row),row])),settings = await tx.inventorySettings.findUnique({ where: { workspaceId: job.workspaceId } });
    let driftCount = 0,resolvedCount = 0,blockedCount = 0; const drift: Prisma.InputJsonObject[] = [];
    for (const key of [...projections.keys()].sort()) {
      const expected = projections.get(key)!,current = indexed.get(key);
      if (exact(current?.onHand ?? '0').eq(expected.onHand) && exact(current?.reserved ?? '0').eq(expected.reserved)) continue;
      driftCount++;
      const blocked = !settings?.allowNegativeStock && exact(expected.onHand).lt(0) || !settings?.allowBackorderReservations && exact(expected.reserved).gt(expected.onHand);
      const entry = { warehouseId: expected.warehouseId,inventoryKey: expected.inventoryKey,locationId: expected.locationId,
        current: { onHand: current?.onHand.toFixed(6) ?? '0',reserved: current?.reserved.toFixed(6) ?? '0' },expected: { onHand: expected.onHand,reserved: expected.reserved },blocked: Boolean(blocked) };
      if (drift.length<1000) drift.push(entry);
      if (blocked) { blockedCount++; continue; }
      if (input.dryRun) continue;
      await lock(tx,job.workspaceId,'inventory:stock:' + expected.warehouseId + ':' + expected.inventoryKey);
      const { onHand,reserved,...data } = expected;
      const repaired = await tx.inventoryBalance.upsert({ where: { workspaceId_warehouseId_inventoryKey_locationKey: { workspaceId: job.workspaceId,warehouseId: expected.warehouseId,inventoryKey: expected.inventoryKey,locationKey: expected.locationKey } },
        create: { workspaceId: job.workspaceId,...data,onHand,reserved },update: { onHand,reserved,version: { increment: 1 } } });
      resolvedCount++;
      await evidence(tx,actor,'INVENTORY_STOCK',repaired.id,'STOCK_BALANCE_RECONCILED',{ ...entry,jobId: job.id,version: repaired.version.toString() });
    }
    if (!input.dryRun) for (const row of projections.values()) await observeReorder(tx,actor,row.warehouseId,row.inventoryKey);
    const result = { dryRun: input.dryRun,driftCount,resolvedCount,blockedCount,checkedCount: projections.size,drift,reportTruncated: driftCount>drift.length };
    await tx.inventoryJob.update({ where: { id: job.id },data: { status: 'SUCCEEDED',result,completedAt: new Date(),leaseOwner: null,leaseUntil: null,errorCode: null } });
    await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_RECONCILIATION_COMPLETED',{ dryRun: input.dryRun,driftCount,resolvedCount,blockedCount,correlationId: job.correlationId }); return true;
  }
  async tick(limit = 5) {
    const now = new Date(),candidates = await this.db.inventoryJob.findMany({ where: { type: 'STOCK_RECONCILE',OR: [{ status: 'QUEUED' },{ status: 'RUNNING',leaseUntil: { lte: now } }] },orderBy: [{ createdAt: 'asc' },{ id: 'asc' }],take: limit });
    let completed = 0,failed = 0;
    for (const job of candidates) {
      const lease = randomUUID(),claim = await this.db.inventoryJob.updateMany({ where: { workspaceId: job.workspaceId,id: job.id,OR: [{ status: 'QUEUED' },{ status: 'RUNNING',leaseUntil: { lte: new Date() } }] },
        data: { status: 'RUNNING',leaseOwner: lease,leaseUntil: new Date(Date.now()+120000),attemptCount: { increment: 1 } } });
      if (!claim.count) continue;
      try { if (await this.db.$transaction(tx => this.execute(tx,job,lease),{ timeout: 60000 })) completed++; }
      catch (error) {
        const errorCode = isAppError(error) ? error.code : 'STOCK_RECONCILIATION_FAILED';
        await this.db.$transaction(async tx => {
          await lock(tx,job.workspaceId,'inventory:job:' + job.id);
          const result = await tx.inventoryJob.updateMany({ where: { workspaceId: job.workspaceId,id: job.id,status: 'RUNNING',leaseOwner: lease },data: { status: 'FAILED',errorCode,completedAt: new Date(),leaseOwner: null,leaseUntil: null } });
          if (result.count) await evidence(tx,{ workspaceId: job.workspaceId,userId: job.requestedByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() },'INVENTORY_JOB',job.id,'INVENTORY_RECONCILIATION_FAILED',{ errorCode,correlationId: job.correlationId });
        }); failed++;
      }
    }
    return { candidates: candidates.length,completed,failed };
  }
}
