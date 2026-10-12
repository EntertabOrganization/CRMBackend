import { Prisma,type PrismaClient,type InventoryJob } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { canonical,parse,uuid } from '../process-platform/dto';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { InventoryWarehouseService } from './warehouse-service';
import { InventoryDocumentService } from './document-service';
import { exact,numeric24 } from './decimal';

const target = z.enum(['FIFO','AVERAGE']);
const persisted = z.strictObject({ warehouseIds: z.array(uuid),targetMethod: target.optional(),reason: z.string().max(2000).optional(),previewJobId: uuid.optional() });
type ScopeValue = { warehouseId: string;inventoryKey: string;currency: string;quantity: string;totalValue: string };
const permission = (type: string) => type==='COSTING_PREVIEW' ? 'INVENTORY.COSTING_MANAGE' : type==='COSTING_MIGRATE' ? 'INVENTORY.COSTING_MIGRATE' : 'INVENTORY.RESET';
export class InventoryControlledJobsService {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db),readonly documents = new InventoryDocumentService(db,warehouses)) {}
  private async warehouseIds(tx: Tx,actor: Principal,action: string,id?: string) {
    if (id) return [(await this.warehouses.warehouse(tx,actor,id,action)).id];
    const all = await tx.inventoryWarehouse.findMany({ where: { workspaceId: actor.workspaceId },select: { id: true },orderBy: { id: 'asc' } });
    for (const warehouse of all) await this.warehouses.warehouse(tx,actor,warehouse.id,action);
    return all.map(row => row.id);
  }
  private async authorized(tx: Tx,actor: Principal,id: string,action?: string) {
    parse(uuid,id); const job = await tx.inventoryJob.findFirst({ where: { workspaceId: actor.workspaceId,id,type: { in: ['COSTING_PREVIEW','COSTING_MIGRATE','RESET_PREVIEW','RESET_APPLY'] } } });
    if (!job) throw new AppError('INVENTORY_JOB_NOT_FOUND','Job was not found.',404);
    const required = action ?? permission(job.type); requirePermission(actor,required);
    if (!await ownerVisible(tx,actor,job.requestedByUserId,required)) throw new AppError('INVENTORY_JOB_NOT_FOUND','Job was not found.',404);
    for (const warehouseId of parse(persisted,job.input).warehouseIds) await this.warehouses.warehouse(tx,actor,warehouseId,required);
    return job;
  }
  async get(actor: Principal,id: string,costing = false) {
    return this.db.$transaction(async tx => {
      const job = await this.authorized(tx,actor,id,costing ? 'INVENTORY.COSTING_VIEW' : undefined);
      if (costing && !job.type.startsWith('COSTING_')) throw new AppError('INVENTORY_JOB_NOT_FOUND','Job was not found.',404);
      let result = job.result;
      if (job.type.startsWith('RESET_')) {
        let financial = actor.grants.has('INVENTORY.VALUATION_VIEW');
        for (const warehouseId of parse(persisted,job.input).warehouseIds) {
          const row = await tx.inventoryWarehouse.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: warehouseId } });
          if (!await this.warehouses.allowed(tx,actor,row,'INVENTORY.VALUATION_VIEW')) financial = false;
        }
        if (!financial && result && typeof result==='object' && !Array.isArray(result) && Array.isArray(result.values))
          result = { ...result,values: result.values.map(row => { if (!row || typeof row!=='object' || Array.isArray(row)) return row; const { totalValue,...visible } = row; return visible; }) };
      }
      return { jobId: job.id,type: job.type,status: job.status,correlationId: job.correlationId,result,errorCode: job.errorCode,
        reportFileId: job.reportFileId,createdAt: job.createdAt,completedAt: job.completedAt,attemptCount: job.attemptCount };
    });
  }
  async preview(actor: Principal,raw: unknown,reset = false) {
    const input = reset ? parse(z.strictObject({ warehouseId: uuid.optional(),reason: z.string().trim().min(1).max(2000) }),raw)
      : parse(z.strictObject({ targetMethod: target }),raw);
    const type = reset ? 'RESET_PREVIEW' : 'COSTING_PREVIEW',action = permission(type); requirePermission(actor,action,!reset);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,action,!reset);
      const ids = await this.warehouseIds(tx,actor,action,'warehouseId' in input ? input.warehouseId : undefined);
      const job = await tx.inventoryJob.create({ data: { workspaceId: actor.workspaceId,type,requestedByUserId: actor.userId,input: { warehouseIds: ids,...('targetMethod' in input ? { targetMethod: input.targetMethod } : { reason: input.reason }) } } });
      await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_CONTROLLED_PREVIEW_QUEUED',{ type,warehouseIds: ids,correlationId: job.correlationId });
      return { jobId: job.id,status: job.status,correlationId: job.correlationId };
    });
  }
  async approve(actor: Principal,id: string,raw: unknown) {
    const input = parse(z.strictObject({ reason: z.string().trim().min(1).max(2000) }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:job:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const initial = await tx.inventoryJob.findFirst({ where: { workspaceId: actor.workspaceId,id,type: { in: ['COSTING_PREVIEW','RESET_PREVIEW'] } } });
      if (!initial) throw new AppError('INVENTORY_JOB_NOT_FOUND','Preview was not found.',404);
      const operation = initial.type==='COSTING_PREVIEW' ? 'COSTING_MIGRATE' : 'RESET_APPLY';
      const job = await this.authorized(tx,actor,id,permission(operation));
      if (job.requestedByUserId===actor.userId) throw new AppError('INVENTORY_RESET_NOT_APPROVED','Approval requires another authorized user.',403);
      const report = job.result as { blockedCount?: number } | null;
      if (job.status!=='SUCCEEDED' || !job.sourceHash || report?.blockedCount!==0) throw new AppError('INVENTORY_RESET_BLOCKED','A successful unblocked preview is required.',409);
      const state = await this.state(tx,actor,parse(persisted,job.input).warehouseIds,job.type==='RESET_PREVIEW');
      if (state.hash!==job.sourceHash) throw new AppError('RESOURCE_VERSION_CONFLICT','Preview is stale; request another preview.',409);
      const prior = await tx.inventoryControlledApproval.findUnique({ where: { workspaceId_previewJobId_approvedByUserId: { workspaceId: actor.workspaceId,previewJobId: id,approvedByUserId: actor.userId } } });
      if (prior) {
        if (prior.reason!==input.reason) throw new AppError('IDEMPOTENCY_CONFLICT','Approval reason differs from the recorded approval.',409);
        if (prior.expiresAt<=new Date()) throw new AppError('INVENTORY_RESET_NOT_APPROVED','Approval expired; request another preview.',409);
        return { approvalId: prior.id,previewJobId: id,expiresAt: prior.expiresAt };
      }
      const approval = await tx.inventoryControlledApproval.create({ data: { workspaceId: actor.workspaceId,previewJobId: id,approvedByUserId: actor.userId,
        operation,sourceHash: job.sourceHash,reason: input.reason,expiresAt: new Date(Date.now()+1200000) } });
      await evidence(tx,actor,'INVENTORY_JOB',id,'INVENTORY_CONTROLLED_OPERATION_APPROVED',{ approvalId: approval.id,operation,reason: input.reason,sourceHash: job.sourceHash });
      return { approvalId: approval.id,previewJobId: id,expiresAt: approval.expiresAt };
    },{ timeout: 60000 });
  }
  async apply(actor: Principal,raw: unknown,key: string | null,reset = false) {
    const input = reset ? parse(z.strictObject({ previewId: uuid,approvalId: uuid }),raw) : parse(z.strictObject({ previewJobId: uuid,approvalReference: uuid }),raw);
    const previewId = 'previewId' in input ? input.previewId : input.previewJobId,approvalId = 'approvalId' in input ? input.approvalId : input.approvalReference;
    const type = reset ? 'RESET_APPLY' : 'COSTING_MIGRATE',action = permission(type); requirePermission(actor,action,!reset);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,action,!reset);
      const result = await command(tx,actor,'INVENTORY.' + type,key,input,async () => {
        const preview = await this.authorized(tx,actor,previewId,action);
        if (preview.type!==(reset ? 'RESET_PREVIEW' : 'COSTING_PREVIEW') || preview.status!=='SUCCEEDED' || !preview.sourceHash)
          throw new AppError('INVENTORY_RESET_BLOCKED','A matching successful preview is required.',409);
        await this.approval(tx,actor,preview,approvalId,type);
        const plan = parse(persisted,preview.input),state = await this.state(tx,actor,plan.warehouseIds,reset);
        if (state.hash!==preview.sourceHash || state.blocked.length) throw new AppError('RESOURCE_VERSION_CONFLICT','Preview is stale or blocked.',409);
        const existing = await tx.inventoryJob.findFirst({ where: { workspaceId: actor.workspaceId,type,approvalReference: approvalId } });
        if (existing) return { jobId: existing.id,status: existing.status,correlationId: existing.correlationId };
        const job = await tx.inventoryJob.create({ data: { workspaceId: actor.workspaceId,type,requestedByUserId: actor.userId,approvalReference: approvalId,sourceHash: preview.sourceHash,
          input: { ...plan,previewJobId: preview.id } } });
        await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_CONTROLLED_OPERATION_QUEUED',{ type,previewJobId: preview.id,approvalId,correlationId: job.correlationId });
        return { jobId: job.id,status: job.status,correlationId: job.correlationId };
      }); await this.authorized(tx,actor,result.jobId,action); return result;
    },{ timeout: 60000 });
  }
  private async approval(tx: Tx,actor: Principal,preview: InventoryJob,id: string,operation: string,acceptedAt?: Date) {
    const row = await tx.inventoryControlledApproval.findFirst({ where: { workspaceId: actor.workspaceId,id,previewJobId: preview.id,operation,sourceHash: preview.sourceHash!,expiresAt: { gt: acceptedAt ?? new Date() } } });
    if (!row || row.approvedByUserId===actor.userId || row.approvedByUserId===preview.requestedByUserId) throw new AppError('INVENTORY_RESET_NOT_APPROVED','A current independent approval is required.',409);
    const approver = await resolvePrincipal(tx,actor.workspaceId,row.approvedByUserId); requirePermission(approver,permission(operation));
    for (const warehouseId of parse(persisted,preview.input).warehouseIds) await this.warehouses.warehouse(tx,approver,warehouseId,permission(operation));
  }
  async resume(actor: Principal,id: string,raw: unknown) {
    parse(z.strictObject({}),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:job:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const job = await this.authorized(tx,actor,id,'INVENTORY.RESET'),result = job.result as { documentIds?: string[];awaitingApproval?: boolean } | null;
      if (job.type!=='RESET_APPLY' || job.status!=='QUEUED' || result?.awaitingApproval!==true) throw new AppError('INVENTORY_RESET_BLOCKED','Job is not awaiting document approval.',409);
      const ids = parse(z.array(uuid).min(1).max(10000),result.documentIds);
      for (const documentId of ids) {
        const document = await this.documents.document(tx,actor,documentId,'INVENTORY.DOCUMENT_PROCESS');
        if (document.status!=='APPROVED') throw new AppError('INVENTORY_RESET_NOT_APPROVED','Approve all adjustment documents first.',409);
      }
      await tx.inventoryJob.update({ where: { id },data: { result: { ...result,documentIds: ids,awaitingApproval: false } } });
      await evidence(tx,actor,'INVENTORY_JOB',id,'INVENTORY_RESET_RESUMED',{ documentIds: ids }); return { jobId: id,status: 'QUEUED',correlationId: job.correlationId };
    });
  }
  private async state(tx: Tx,actor: Principal,warehouseIds: string[],reset: boolean,ownDocumentIds: string[] = []) {
    const settings = await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } }),generation = settings?.valuationGeneration ?? 1,method = settings?.costingMethod ?? 'FIFO';
    const balances = await tx.inventoryBalance.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: { in: warehouseIds } },orderBy: [{ warehouseId: 'asc' },{ inventoryKey: 'asc' },{ locationKey: 'asc' }] });
    const watermark = await tx.inventoryMovement.aggregate({ where: { workspaceId: actor.workspaceId,warehouseId: { in: warehouseIds } },_max: { ledgerSequence: true },_count: { id: true } });
    const valuations = await tx.inventoryMovement.groupBy({ by: ['warehouseId','inventoryKey','currency'],where: { workspaceId: actor.workspaceId,warehouseId: { in: warehouseIds } },_sum: { quantityDelta: true,totalCost: true },orderBy: [{ warehouseId: 'asc' },{ inventoryKey: 'asc' },{ currency: 'asc' }] });
    const values: ScopeValue[] = [],blocked: { code: string;warehouseId?: string;inventoryKey?: string }[] = [];
    for (const row of valuations) {
      const qty = exact(row._sum.quantityDelta ?? '0'),value = exact(row._sum.totalCost ?? '0');
      if (qty.eq(0) && value.eq(0)) continue;
      const balanceQty = balances.filter(balance => balance.warehouseId===row.warehouseId && balance.inventoryKey===row.inventoryKey).reduce((sum,balance) => sum.plus(balance.onHand),exact('0'));
      if (qty.lt(0) || value.lt(0) || qty.eq(0) && !value.eq(0) || !qty.eq(balanceQty)) blocked.push({ code: 'STOCK_RECONCILIATION_CONFLICT',warehouseId: row.warehouseId,inventoryKey: row.inventoryKey });
      const scope = { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: row.inventoryKey,currency: row.currency,generation };
      let costQty: string,costValue: string;
      if (method==='FIFO') {
        const layers = await tx.inventoryCostLayer.aggregate({ where: scope,_sum: { remainingQuantity: true,remainingValue: true } });
        costQty = numeric24(layers._sum.remainingQuantity ?? '0'); costValue = numeric24(layers._sum.remainingValue ?? '0');
      } else {
        const average = await tx.inventoryAverageCost.findUnique({ where: { workspaceId_warehouseId_inventoryKey_currency_generation: scope } });
        costQty = numeric24(average?.quantity ?? '0'); costValue = numeric24(average?.totalValue ?? '0');
      }
      if (!qty.eq(costQty) || !value.eq(costValue)) blocked.push({ code: 'COSTING_RECONCILIATION_FAILED',warehouseId: row.warehouseId,inventoryKey: row.inventoryKey });
      values.push({ warehouseId: row.warehouseId,inventoryKey: row.inventoryKey,currency: row.currency,quantity: numeric24(qty),totalValue: numeric24(value) });
    }
    for (const balance of balances) if (!exact(balance.onHand).eq(0) && !values.some(value => value.warehouseId===balance.warehouseId && value.inventoryKey===balance.inventoryKey))
      blocked.push({ code: 'STOCK_RECONCILIATION_CONFLICT',warehouseId: balance.warehouseId,inventoryKey: balance.inventoryKey });
    const stocktakes = await tx.inventoryStocktake.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: { in: warehouseIds },status: { in: ['DRAFT','COUNTING','RECONCILING'] } },select: { id: true,version: true },orderBy: { id: 'asc' } });
    const pending = await tx.inventoryDocument.findMany({ where: { workspaceId: actor.workspaceId,id: { notIn: ownDocumentIds },status: { in: ['DRAFT','PENDING_APPROVAL','APPROVED'] },OR: [{ sourceWarehouseId: { in: warehouseIds } },{ destinationWarehouseId: { in: warehouseIds } }] },select: { id: true,version: true },orderBy: { id: 'asc' } });
    const warehouseState = await tx.inventoryWarehouse.findMany({ where: { workspaceId: actor.workspaceId,id: { in: warehouseIds } },select: { id: true,status: true,version: true },orderBy: { id: 'asc' } });
    if (reset) {
      if (stocktakes.length || pending.length) blocked.push({ code: 'INVENTORY_RESET_BLOCKED' });
      for (const balance of balances) if (exact(balance.reserved).gt(0) || exact(balance.onHand).lt(0)) blocked.push({ code: 'INVENTORY_RESET_BLOCKED',warehouseId: balance.warehouseId,inventoryKey: balance.inventoryKey });
      for (const warehouse of warehouseState) if (warehouse.status!=='ACTIVE' && balances.some(balance => balance.warehouseId===warehouse.id && !exact(balance.onHand).eq(0))) blocked.push({ code: 'WAREHOUSE_ACCESS_DENIED',warehouseId: warehouse.id });
    }
    const hash = createHash('sha256').update(canonical({ settingsVersion: settings?.version.toString() ?? '0',method,generation,
      balances: balances.map(row => ({ id: row.id,version: row.version.toString(),onHand: row.onHand.toFixed(6),reserved: row.reserved.toFixed(6) })),watermark,values,
      warehouseState,stocktakes,pending })).digest('hex');
    return { hash,values,balances,blocked,method,generation };
  }
  private async migrate(tx: Tx,actor: Principal,job: InventoryJob,state: Awaited<ReturnType<InventoryControlledJobsService['state']>>,method: 'FIFO' | 'AVERAGE') {
    if (state.method===method) throw new AppError('COSTING_MIGRATION_REQUIRED','Target method is already active.',409);
    if (state.generation>=2147483647) throw new AppError('COSTING_RECONCILIATION_FAILED','Valuation generation limit reached.',409);
    const generation = state.generation+1,now = new Date();
    for (const row of state.values) {
      const scope = { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: row.inventoryKey,currency: row.currency };
      await lock(tx,actor.workspaceId,'inventory:stock:' + row.warehouseId + ':' + row.inventoryKey);
      await tx.inventoryValuationSnapshot.create({ data: { ...scope,asOfAt: now,quantity: row.quantity,totalValue: row.totalValue,method: state.method,generation: state.generation,jobId: job.id } });
      const opening = await tx.inventoryValuationSnapshot.create({ data: { ...scope,asOfAt: now,quantity: row.quantity,totalValue: row.totalValue,method,generation,jobId: job.id } });
      if (exact(row.quantity).eq(0)) continue;
      const unitCost = numeric24(exact(row.totalValue).div(row.quantity));
      if (method==='AVERAGE') await tx.inventoryAverageCost.create({ data: { ...scope,generation,quantity: row.quantity,totalValue: row.totalValue,averageCost: unitCost } });
      else await tx.inventoryCostLayer.create({ data: { ...scope,generation,openingSnapshotId: opening.id,originalQuantity: row.quantity,remainingQuantity: row.quantity,
        originalValue: row.totalValue,remainingValue: row.totalValue,unitCost,receivedAt: now } });
    }
    const settings = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId,costingMethod: method,valuationGeneration: generation,costingLocked: true },
      update: { costingMethod: method,valuationGeneration: generation,costingLocked: true,version: { increment: 1 } } });
    await evidence(tx,actor,'INVENTORY_SETTINGS',actor.workspaceId,'INVENTORY_COSTING_MIGRATED',{ jobId: job.id,fromMethod: state.method,toMethod: method,fromGeneration: state.generation,generation,version: settings.version.toString(),approvalReference: job.approvalReference });
    await evidence(tx,actor,'INVENTORY_SETTINGS',actor.workspaceId,'INVENTORY_VALUATION_CHANGED',{ jobId: job.id,generation,scopeCount: state.values.length },false);
    return { fromMethod: state.method,toMethod: method,fromGeneration: state.generation,generation,scopeCount: state.values.length,valuationDifference: '0.000000' };
  }
  private async reset(tx: Tx,actor: Principal,job: InventoryJob,state: Awaited<ReturnType<InventoryControlledJobsService['state']>>,existingDocumentIds: string[] = []) {
    const documentIds: string[] = [...existingDocumentIds];
    const groups = new Map<string,typeof state.balances>();
    for (const balance of state.balances.filter(row => exact(row.onHand).gt(0))) {
      const cost = state.values.find(value => value.warehouseId===balance.warehouseId && value.inventoryKey===balance.inventoryKey);
      if (!cost) throw new AppError('COSTING_RECONCILIATION_FAILED','Reset valuation is unavailable.',409);
      const key = balance.warehouseId + ':' + cost.currency; groups.set(key,[...(groups.get(key) ?? []),balance]);
    }
    if (!existingDocumentIds.length) for (const [key,balances] of groups) {
      const denomination = key.slice(-3),warehouseId = balances[0].warehouseId;
      const document = await this.documents.createControlledAdjustmentInTransaction(tx,actor,{ documentType: 'STOCK_ADJUSTMENT',warehouseIds: { source: warehouseId },currency: denomination },job.id);
      for (const balance of balances) await this.documents.addLineInTransaction(tx,actor,document.id,{ productId: balance.productId,variantId: balance.variantId ?? undefined,quantity: balance.onHand.toFixed(6),unitCost: '0',adjustmentDirection: 'OUT',locationId: balance.locationId ?? undefined });
      const current = await tx.inventoryDocument.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: document.id } });
      await this.documents.approvalInTransaction(tx,actor,document.id,{ expectedVersion: current.version.toString() },true);
      documentIds.push(document.id);
    }
    const proposed = await tx.inventoryDocument.findMany({ where: { workspaceId: actor.workspaceId,id: { in: documentIds } } });
    if (proposed.length!==documentIds.length) throw new AppError('INVENTORY_RESET_BLOCKED','Reset adjustment documents are missing.',409);
    let matched = 0; const seen = new Set<string>();
    for (const document of proposed) {
      const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: document.id } });
      if (document.type!=='STOCK_ADJUSTMENT' || document.destinationWarehouseId || !document.sourceWarehouseId) throw new AppError('INVENTORY_RESET_BLOCKED','Reset adjustment identity changed.',409);
      for (const line of lines) {
        const balance = state.balances.find(balance => balance.warehouseId===document.sourceWarehouseId && balance.inventoryKey===line.inventoryKey && balance.locationId===line.sourceLocationId);
        if (!balance || line.adjustmentDirection!=='OUT' || !exact(line.quantity).eq(balance.onHand) || !exact(balance.onHand).gt(0))
          throw new AppError('INVENTORY_RESET_BLOCKED','Reset adjustment no longer matches the approved stock.',409);
        if (seen.has(balance.id)) throw new AppError('INVENTORY_RESET_BLOCKED','Reset contains a duplicate stock adjustment.',409);
        seen.add(balance.id);
        matched++;
      }
    }
    if (matched!==state.balances.filter(row => exact(row.onHand).gt(0)).length) throw new AppError('INVENTORY_RESET_BLOCKED','Reset adjustments do not cover the approved stock exactly.',409);
    if (proposed.some(document => document.status==='PENDING_APPROVAL')) return { documentIds,adjustedLineCount: 0,awaitingApproval: true };
    for (const document of proposed) {
      if (document.status!=='APPROVED') throw new AppError('INVENTORY_RESET_NOT_APPROVED','Approve every reset adjustment before continuing.',409);
      await this.documents.processInTransaction(tx,actor,document.id,{ expectedVersion: document.version.toString() },'RESET_JOB:' + job.id + ':' + document.id,{ controlledJobId: job.id });
    }
    await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_RESET_APPLIED',{ documentIds,previewJobId: parse(persisted,job.input).previewJobId,approvalId: job.approvalReference });
    return { documentIds,adjustedLineCount: state.balances.filter(row => exact(row.onHand).gt(0)).length,awaitingApproval: false };
  }
  private async execute(tx: Tx,job: InventoryJob,lease: string) {
    await lock(tx,job.workspaceId,'inventory:configuration'); await lock(tx,job.workspaceId,'inventory:job:' + job.id);
    if (!await tx.inventoryJob.count({ where: { workspaceId: job.workspaceId,id: job.id,status: 'RUNNING',leaseOwner: lease } })) return false;
    const actor = await resolvePrincipal(tx,job.workspaceId,job.requestedByUserId); await this.authorized(tx,actor,job.id);
    const plan = parse(persisted,job.input);
    for (const id of [...plan.warehouseIds].sort()) await lock(tx,job.workspaceId,'inventory:warehouse:' + id);
    const previous = (job.result ?? {}) as { documentIds?: string[];awaitingApproval?: boolean };
    const ownDocumentIds = parse(z.array(uuid).max(10000),previous.documentIds ?? []);
    const reset = job.type.startsWith('RESET_'),state = await this.state(tx,actor,plan.warehouseIds,reset,ownDocumentIds);
    let result: Prisma.InputJsonValue;
    if (job.type.endsWith('_PREVIEW')) {
      if (!reset && plan.targetMethod===state.method) state.blocked.push({ code: 'COSTING_MIGRATION_REQUIRED' });
      result = { fromMethod: state.method,targetMethod: plan.targetMethod ?? null,generation: state.generation,reason: plan.reason ?? null,
        scopeCount: state.values.length,values: state.values,affectedBalanceCount: state.balances.filter(row => !exact(row.onHand).eq(0)).length,
        blockedCount: state.blocked.length,blocked: state.blocked };
    } else {
      if (!plan.previewJobId || !job.approvalReference) throw new AppError('INVENTORY_RESET_NOT_APPROVED','Approval and preview are required.',409);
      const preview = await this.authorized(tx,actor,plan.previewJobId,permission(job.type));
      await this.approval(tx,actor,preview,job.approvalReference,job.type,job.createdAt);
      if (state.blocked.length || state.hash!==job.sourceHash || state.hash!==preview.sourceHash) throw new AppError('RESOURCE_VERSION_CONFLICT','Approved preview is stale or blocked.',409);
      result = reset ? await this.reset(tx,actor,job,state,ownDocumentIds) : await this.migrate(tx,actor,job,state,parse(target,plan.targetMethod));
      if (reset && typeof result==='object' && result!==null && !Array.isArray(result) && result.awaitingApproval===true) {
        await tx.inventoryJob.update({ where: { id: job.id },data: { status: 'QUEUED',result,leaseOwner: null,leaseUntil: null } });
        await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_RESET_DOCUMENT_APPROVAL_REQUIRED',{ documentIds: result.documentIds }); return true;
      }
    }
    await tx.inventoryJob.update({ where: { id: job.id },data: { status: 'SUCCEEDED',sourceHash: job.sourceHash ?? state.hash,result,completedAt: new Date(),leaseOwner: null,leaseUntil: null,errorCode: null } });
    await evidence(tx,actor,'INVENTORY_JOB',job.id,'INVENTORY_CONTROLLED_JOB_COMPLETED',{ type: job.type,correlationId: job.correlationId }); return true;
  }
  async tick(limit = 5) {
    const candidates = await this.db.inventoryJob.findMany({ where: { type: { in: ['COSTING_PREVIEW','COSTING_MIGRATE','RESET_PREVIEW','RESET_APPLY'] },
      AND: [{ OR: [{ result: { equals: Prisma.DbNull } },{ result: { path: ['awaitingApproval'],equals: false } }] }],
      OR: [{ status: 'QUEUED' },{ status: 'RUNNING',leaseUntil: { lte: new Date() } }] },orderBy: [{ createdAt: 'asc' },{ id: 'asc' }],take: limit });
    let completed = 0,failed = 0;
    for (const job of candidates) {
      const lease = randomUUID(),claimed = await this.db.inventoryJob.updateMany({ where: { workspaceId: job.workspaceId,id: job.id,
        AND: [{ OR: [{ result: { equals: Prisma.DbNull } },{ result: { path: ['awaitingApproval'],equals: false } }] }],
        OR: [{ status: 'QUEUED' },{ status: 'RUNNING',leaseUntil: { lte: new Date() } }] },data: { status: 'RUNNING',leaseOwner: lease,leaseUntil: new Date(Date.now()+120000),attemptCount: { increment: 1 } } });
      if (!claimed.count) continue;
      try { if (await this.db.$transaction(tx => this.execute(tx,job,lease),{ timeout: 60000 })) completed++; }
      catch (error) {
        const errorCode = isAppError(error) ? error.code : 'INVENTORY_CONTROLLED_JOB_FAILED';
        await this.db.$transaction(async tx => {
          await lock(tx,job.workspaceId,'inventory:job:' + job.id);
          const result = await tx.inventoryJob.updateMany({ where: { workspaceId: job.workspaceId,id: job.id,status: 'RUNNING',leaseOwner: lease },data: { status: 'FAILED',errorCode,leaseOwner: null,leaseUntil: null,completedAt: new Date() } });
          if (result.count) await evidence(tx,{ workspaceId: job.workspaceId,userId: job.requestedByUserId,roleId: '00000000-0000-0000-0000-000000000000',grants: new Map() },'INVENTORY_JOB',job.id,'INVENTORY_CONTROLLED_JOB_FAILED',{ type: job.type,errorCode,correlationId: job.correlationId });
        }); failed++;
      }
    }
    return { candidates: candidates.length,completed,failed };
  }
}
