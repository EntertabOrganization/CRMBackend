import { Prisma,type PrismaClient,type InventoryStocktake,type InventoryDocument } from '@prisma/client';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { parse,uuid,pageQuery,currency } from '../process-platform/dto';
import { inventoryVersion,assertInventoryVersion,quantity } from './dto';
import { exact,numeric24 } from './decimal';
import { InventoryWarehouseService } from './warehouse-service';
import { inventoryCatalogPort } from './catalog-port';
import { InventoryDocumentService,type StocktakePostingPort } from './document-service';

const scopeDto = z.discriminatedUnion('mode',[z.strictObject({ mode: z.literal('ALL') }),
  z.strictObject({ mode: z.literal('SELECTED_SKUS'),inventoryKeys: z.array(uuid).min(1).max(1000).refine(keys => new Set(keys).size===keys.length) })]);
const state = z.enum(['DRAFT','COUNTING','RECONCILING','POSTED','CANCELLED']);
export class InventoryStocktakeService implements StocktakePostingPort {
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db),readonly documents = new InventoryDocumentService(db,warehouses)) {}
  async session(tx: Tx,actor: Principal,id: string,permission: string) {
    parse(uuid,id); requirePermission(actor,permission);
    const row = await tx.inventoryStocktake.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row || !await ownerVisible(tx,actor,row.startedByUserId,permission)) throw new AppError('STOCKTAKE_NOT_FOUND','Stocktake was not found.',404);
    await this.warehouses.warehouse(tx,actor,row.warehouseId,permission); return row;
  }
  private async locked(tx: Tx,actor: Principal,id: string,permission: string) {
    await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:stocktake:' + id);
    actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); const row = await this.session(tx,actor,id,permission);
    await lock(tx,actor.workspaceId,'inventory:warehouse:' + row.warehouseId);
    await this.warehouses.warehouse(tx,actor,row.warehouseId,permission,true); return { actor,row };
  }
  private async snapshot(tx: Tx,actor: Principal,row: InventoryStocktake) {
    const scope = parse(scopeDto,row.scope),catalog = await inventoryCatalogPort(tx,actor);
    const balances = await tx.inventoryBalance.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,
      ...(row.locationId ? { locationId: row.locationId } : {}),...(scope.mode==='SELECTED_SKUS' ? { inventoryKey: { in: scope.inventoryKeys } } : {}) },orderBy: [{ inventoryKey: 'asc' },{ locationKey: 'asc' }] });
    if (balances.length>1000) throw new AppError('STOCKTAKE_SCOPE_TOO_LARGE','Limit a session to at most 1000 SKU/location lines.',422);
    for (const balance of balances) {
      catalog.sku(balance.productId,balance.variantId ?? undefined,false);
      await tx.inventoryStocktakeLine.create({ data: { workspaceId: actor.workspaceId,sessionId: row.id,productId: balance.productId,variantId: balance.variantId,
        inventoryKey: balance.inventoryKey,locationId: balance.locationId,locationKey: balance.locationKey,expectedQuantity: balance.onHand,expectedBalanceVersion: balance.version } });
    }
    if (scope.mode==='SELECTED_SKUS') for (const inventoryKey of scope.inventoryKeys.filter(key => !balances.some(balance => balance.inventoryKey===key))) {
      const identity = catalog.identityForKey(inventoryKey),sku = catalog.sku(identity.productId,identity.variantId);
      await tx.inventoryStocktakeLine.create({ data: { workspaceId: actor.workspaceId,sessionId: row.id,productId: sku.productId,variantId: sku.variantId,
        inventoryKey,locationId: row.locationId,locationKey: row.locationId ?? '',expectedQuantity: '0',expectedBalanceVersion: 0n } });
    }
  }
  async create(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.STOCKTAKE_CREATE');
    const input = parse(z.strictObject({ warehouseId: uuid,locationId: uuid.optional(),scope: scopeDto.default({ mode: 'ALL' }) }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'INVENTORY.STOCKTAKE_CREATE');
      await lock(tx,actor.workspaceId,'inventory:warehouse:' + input.warehouseId); await this.warehouses.warehouse(tx,actor,input.warehouseId,'INVENTORY.STOCKTAKE_CREATE',true);
      if (input.locationId && !await tx.inventoryLocation.count({ where: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,id: input.locationId,status: 'ACTIVE' } }))
        throw new AppError('WAREHOUSE_NOT_FOUND','Counting location is unavailable.',404);
      const row = await tx.inventoryStocktake.create({ data: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,locationId: input.locationId,scope: input.scope as Prisma.InputJsonValue,startedByUserId: actor.userId } });
      await this.snapshot(tx,actor,row); await evidence(tx,actor,'INVENTORY_STOCKTAKE',row.id,'STOCKTAKE_CREATED',{ warehouseId: row.warehouseId,scope: input.scope }); return row;
    },{ timeout: 60000 });
  }
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.STOCKTAKE_READ'); const query = parse(pageQuery.extend({ status: state.optional(),warehouseId: uuid.optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.inventoryStocktake.findMany({ where: { workspaceId: actor.workspaceId,status: query.status,warehouseId: query.warehouseId },orderBy: [{ asOfAt: 'desc' },{ id: 'asc' }] }),visible = [];
      for (const row of rows) try { await this.session(tx,actor,row.id,'INVENTORY.STOCKTAKE_READ'); visible.push(row); }
      catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async get(actor: Principal,id: string) {
    return this.db.$transaction(async tx => {
      const row = await this.session(tx,actor,id,'INVENTORY.STOCKTAKE_READ');
      const lines = await tx.inventoryStocktakeLine.findMany({ where: { workspaceId: actor.workspaceId,sessionId: id },orderBy: [{ inventoryKey: 'asc' },{ locationKey: 'asc' }] });
      const countHistory = await tx.inventoryStocktakeCountHistory.findMany({ where: { workspaceId: actor.workspaceId,sessionId: id },orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }] });
      return { ...row,lines,countHistory };
    });
  }
  async start(actor: Principal,id: string,raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: inventoryVersion }),raw);
    return this.db.$transaction(async tx => {
      const current = await this.locked(tx,actor,id,'INVENTORY.STOCKTAKE_COUNT'); actor = current.actor; const row = current.row; assertInventoryVersion(row.version,input.expectedVersion);
      if (row.status!=='DRAFT') throw new AppError('STOCKTAKE_INVALID_STATUS','Only a draft can start counting.',409);
      await tx.inventoryStocktakeLine.deleteMany({ where: { workspaceId: actor.workspaceId,sessionId: id } });
      const watermark = await tx.inventoryMovement.aggregate({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId },_max: { ledgerSequence: true } });
      const updated = await tx.inventoryStocktake.update({ where: { id },data: { status: 'COUNTING',asOfAt: new Date(),baselineLedgerSequence: watermark._max.ledgerSequence ?? 0n,version: { increment: 1 } } });
      await this.snapshot(tx,actor,updated); await evidence(tx,actor,'INVENTORY_STOCKTAKE',id,'STOCKTAKE_STARTED',{ warehouseId: row.warehouseId,asOfAt: updated.asOfAt.toISOString(),version: updated.version.toString() }); return updated;
    },{ timeout: 60000 });
  }
  async count(actor: Principal,id: string,lineId: string,raw: unknown) {
    parse(uuid,lineId); const input = parse(z.strictObject({ quantity,expectedVersion: inventoryVersion }),raw);
    return this.db.$transaction(async tx => {
      const current = await this.locked(tx,actor,id,'INVENTORY.STOCKTAKE_COUNT'); actor = current.actor; const row = current.row;
      if (!['COUNTING','RECONCILING'].includes(row.status)) throw new AppError('STOCKTAKE_INVALID_STATUS','Session is not open for counting.',409);
      const line = await tx.inventoryStocktakeLine.findFirst({ where: { workspaceId: actor.workspaceId,sessionId: id,id: lineId } });
      if (!line) throw new AppError('STOCKTAKE_NOT_FOUND','Count line was not found.',404); assertInventoryVersion(line.version,input.expectedVersion);
      if (await tx.inventoryStocktakeLine.count({ where: { workspaceId: actor.workspaceId,sessionId: id,adjustmentDocumentLineId: { not: null } } }))
        throw new AppError('STOCKTAKE_APPROVAL_REQUIRED','An adjustment proposal already exists for this session.',409);
      const sku = (await inventoryCatalogPort(tx,actor)).sku(line.productId,line.variantId ?? undefined,false);
      if (exact(input.quantity).decimalPlaces()>sku.unitPrecision) throw new AppError('INVENTORY_LINE_INVALID','Count exceeds Catalog unit precision.',422);
      const now = new Date();
      const watermark = await tx.inventoryMovement.aggregate({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId },_max: { ledgerSequence: true } });
      const updated = await tx.inventoryStocktakeLine.update({ where: { id: lineId },data: { countedQuantity: input.quantity,countedByUserId: actor.userId,countedAt: now,
        countedLedgerSequence: watermark._max.ledgerSequence ?? 0n,varianceQuantity: null,reconciledBalanceVersion: null,reconciliationQuantity: null,version: { increment: 1 } } });
      await tx.inventoryStocktakeCountHistory.create({ data: { workspaceId: actor.workspaceId,sessionId: id,lineId,actorUserId: actor.userId,quantity: input.quantity,occurredAt: now } });
      const session = await tx.inventoryStocktake.update({ where: { id },data: { status: 'COUNTING',version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_STOCKTAKE',id,'STOCKTAKE_COUNT_RECORDED',{ lineId,quantity: input.quantity,lineVersion: updated.version.toString() },false);
      return { line: updated,sessionVersion: session.version.toString() };
    });
  }
  async reconcile(actor: Principal,id: string,raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: inventoryVersion }),raw);
    return this.db.$transaction(async tx => {
      const current = await this.locked(tx,actor,id,'INVENTORY.STOCKTAKE_RECONCILE'); actor = current.actor; const row = current.row; assertInventoryVersion(row.version,input.expectedVersion);
      if (!['COUNTING','RECONCILING'].includes(row.status)) throw new AppError('STOCKTAKE_INVALID_STATUS','Session is not open for reconciliation.',409);
      const lines = await tx.inventoryStocktakeLine.findMany({ where: { workspaceId: actor.workspaceId,sessionId: id } });
      if (!lines.length || lines.some(line => line.countedQuantity===null || line.countedAt===null)) throw new AppError('STOCKTAKE_UNCOUNTED_LINES','Count every snapshot line before reconciliation.',409);
      const scope = parse(scopeDto,row.scope);
      const balances = await tx.inventoryBalance.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,
        ...(row.locationId ? { locationId: row.locationId } : {}),...(scope.mode==='SELECTED_SKUS' ? { inventoryKey: { in: scope.inventoryKeys } } : {}) } });
      if (balances.some(balance => !lines.some(line => line.inventoryKey===balance.inventoryKey && line.locationKey===balance.locationKey)))
        throw new AppError('STOCKTAKE_CONCURRENT_MOVEMENTS','New SKU/location stock appeared outside the frozen snapshot; count it in a new session.',409);
      if (lines.some(line => line.adjustmentDocumentLineId)) throw new AppError('STOCKTAKE_APPROVAL_REQUIRED','An adjustment proposal already exists.',409);
      for (const line of lines) {
        await lock(tx,actor.workspaceId,'inventory:stock:' + row.warehouseId + ':' + line.inventoryKey);
        const balance = balances.find(balance => balance.inventoryKey===line.inventoryKey && balance.locationKey===line.locationKey);
        const ledger = await tx.inventoryMovement.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: line.inventoryKey,locationId: line.locationId,ledgerSequence: { gt: row.baselineLedgerSequence } },select: { quantityDelta: true,ledgerSequence: true } });
        const expectedNow = exact(line.expectedQuantity).plus(ledger.reduce((sum,movement) => sum.plus(movement.quantityDelta),exact('0')));
        if (!expectedNow.eq(balance?.onHand ?? '0')) throw new AppError('STOCKTAKE_CONCURRENT_MOVEMENTS','Balance does not match the snapshot and interim ledger.',409);
        const expectedAtCount = exact(line.expectedQuantity).plus(ledger.filter(movement => movement.ledgerSequence<=line.countedLedgerSequence!).reduce((sum,movement) => sum.plus(movement.quantityDelta),exact('0')));
        const variance = exact(line.countedQuantity!).minus(expectedAtCount);
        await tx.inventoryStocktakeLine.update({ where: { id: line.id },data: { varianceQuantity: numeric24(variance),reconciledBalanceVersion: balance?.version ?? 0n,
          reconciliationQuantity: numeric24(expectedNow.plus(variance)),version: { increment: 1 } } });
      }
      const updated = await tx.inventoryStocktake.update({ where: { id },data: { status: 'RECONCILING',version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_STOCKTAKE',id,'STOCKTAKE_RECONCILED',{ lineCount: lines.length,version: updated.version.toString() }); return updated;
    },{ timeout: 60000 });
  }
  async cancel(actor: Principal,id: string,raw: unknown) {
    const input = parse(z.strictObject({ reason: z.string().trim().min(1).max(2000),expectedVersion: inventoryVersion.optional() }),raw);
    return this.db.$transaction(async tx => {
      const current = await this.locked(tx,actor,id,'INVENTORY.STOCKTAKE_MANAGE'); actor = current.actor; const row = current.row;
      if (input.expectedVersion) assertInventoryVersion(row.version,input.expectedVersion);
      if (['POSTED','CANCELLED'].includes(row.status)) throw new AppError('STOCKTAKE_INVALID_STATUS','Session is already closed.',409);
      const updated = await tx.inventoryStocktake.update({ where: { id },data: { status: 'CANCELLED',completedByUserId: actor.userId,version: { increment: 1 } } });
      await evidence(tx,actor,'INVENTORY_STOCKTAKE',id,'STOCKTAKE_CANCELLED',{ reason: input.reason,version: updated.version.toString() }); return updated;
    });
  }
  private async ready(tx: Tx,actor: Principal,row: InventoryStocktake) {
    if (row.status!=='RECONCILING') throw new AppError('STOCKTAKE_INVALID_STATUS','Reconcile the session before posting.',409);
    const lines = await tx.inventoryStocktakeLine.findMany({ where: { workspaceId: actor.workspaceId,sessionId: row.id },orderBy: [{ inventoryKey: 'asc' },{ locationKey: 'asc' }] });
    if (!lines.length || lines.some(line => line.countedQuantity===null || line.varianceQuantity===null || line.reconciledBalanceVersion===null))
      throw new AppError('STOCKTAKE_UNCOUNTED_LINES','Every count must have a reconciled variance.',409);
    for (const line of lines) {
      await lock(tx,actor.workspaceId,'inventory:stock:' + row.warehouseId + ':' + line.inventoryKey);
      const balance = await tx.inventoryBalance.findUnique({ where: { workspaceId_warehouseId_inventoryKey_locationKey: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: line.inventoryKey,locationKey: line.locationKey } } });
      if ((balance?.version ?? 0n)!==line.reconciledBalanceVersion || !exact(balance?.onHand ?? '0').plus(line.varianceQuantity!).eq(line.reconciliationQuantity!))
        throw new AppError('STOCKTAKE_CONCURRENT_MOVEMENTS','Stock or reservations changed after reconciliation.',409);
      if (exact(line.reconciliationQuantity!).lt(balance?.reserved ?? '0')) throw new AppError('STOCKTAKE_CONCURRENT_MOVEMENTS','The proposed adjustment would consume reserved stock.',409);
    }
    const scope = parse(scopeDto,row.scope);
    const balances = await tx.inventoryBalance.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,
      ...(row.locationId ? { locationId: row.locationId } : {}),...(scope.mode==='SELECTED_SKUS' ? { inventoryKey: { in: scope.inventoryKeys } } : {}) } });
    if (balances.some(balance => !lines.some(line => line.inventoryKey===balance.inventoryKey && line.locationKey===balance.locationKey)))
      throw new AppError('STOCKTAKE_CONCURRENT_MOVEMENTS','Stock appeared outside the reconciled snapshot.',409);
    return lines;
  }
  async validateDocument(tx: Tx,actor: Principal,document: InventoryDocument) {
    const documentLines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: document.id } });
    const bindings = await tx.inventoryStocktakeLine.findMany({ where: { workspaceId: actor.workspaceId,adjustmentDocumentLineId: { in: documentLines.map(line => line.id) } } });
    const sessionIds = [...new Set(bindings.map(line => line.sessionId))];
    if (sessionIds.length!==1 || bindings.length!==documentLines.length) throw new AppError('STOCKTAKE_INVALID_STATUS','Adjustment bindings are incomplete.',409);
    const current = await this.locked(tx,actor,sessionIds[0],'INVENTORY.STOCKTAKE_POST'); actor = current.actor;
    if (document.type!=='STOCK_ADJUSTMENT' || (document.sourceWarehouseId ?? document.destinationWarehouseId)!==current.row.warehouseId)
      throw new AppError('STOCKTAKE_INVALID_STATUS','Adjustment warehouse does not match the stocktake.',409);
    const lines = await this.ready(tx,actor,current.row),changed = lines.filter(line => !exact(line.varianceQuantity!).eq(0));
    if (changed.length!==bindings.length) throw new AppError('STOCKTAKE_INVALID_STATUS','Every variance must be bound to this adjustment.',409);
    for (const binding of changed) {
      const line = documentLines.find(line => line.id===binding.adjustmentDocumentLineId);
      if (!line || line.inventoryKey!==binding.inventoryKey || !exact(line.quantity).eq(exact(binding.varianceQuantity!).abs())
        || line.adjustmentDirection!==(exact(binding.varianceQuantity!).gt(0) ? 'IN' : 'OUT')
        || (document.sourceWarehouseId ? line.sourceLocationId : line.targetLocationId)!==binding.locationId)
        throw new AppError('STOCKTAKE_INVALID_STATUS','Adjustment lines no longer match reconciled variances.',409);
    }
  }
  async completeDocument(tx: Tx,actor: Principal,document: InventoryDocument) {
    const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: document.id },select: { id: true } });
    const binding = await tx.inventoryStocktakeLine.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,adjustmentDocumentLineId: { in: lines.map(line => line.id) } } });
    const row = await tx.inventoryStocktake.update({ where: { id: binding.sessionId },data: { status: 'POSTED',completedByUserId: actor.userId,version: { increment: 1 } } });
    await evidence(tx,actor,'INVENTORY_STOCKTAKE',row.id,'STOCKTAKE_POSTED',{ documentId: document.id,version: row.version.toString() });
  }
  async post(actor: Principal,id: string,raw: unknown,key: string | null) {
    const input = parse(z.strictObject({ expectedVersion: inventoryVersion,currency: currency.optional() }),raw);
    return this.db.$transaction(async tx => {
      const current = await this.locked(tx,actor,id,'INVENTORY.STOCKTAKE_POST'); actor = current.actor; const row = current.row;
      return command(tx,actor,'INVENTORY.STOCKTAKE_POST:' + id,key,input,async () => {
        assertInventoryVersion(row.version,input.expectedVersion);
        if (row.status==='POSTED') throw new AppError('STOCKTAKE_ALREADY_POSTED','Session was already posted.',409);
        const lines = await this.ready(tx,actor,row),changed = lines.filter(line => !exact(line.varianceQuantity!).eq(0));
        if (!changed.length) {
          const updated = await tx.inventoryStocktake.update({ where: { id },data: { status: 'POSTED',completedByUserId: actor.userId,version: { increment: 1 } } });
          await evidence(tx,actor,'INVENTORY_STOCKTAKE',id,'STOCKTAKE_POSTED',{ documentId: null,version: updated.version.toString(),zeroVariance: true });
          return { id,status: 'POSTED',version: updated.version.toString(),documentId: null,approvalRequired: false };
        }
        let document: InventoryDocument;
        const bound = changed.filter(line => line.adjustmentDocumentLineId);
        if (bound.length) {
          if (bound.length!==changed.length) throw new AppError('STOCKTAKE_INVALID_STATUS','Adjustment bindings are incomplete.',409);
          const documentLines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,id: { in: bound.map(line => line.adjustmentDocumentLineId!) } } });
          const documentIds = [...new Set(documentLines.map(line => line.documentId))];
          if (documentIds.length!==1) throw new AppError('STOCKTAKE_INVALID_STATUS','Adjustment bindings are inconsistent.',409);
          document = await this.documents.document(tx,actor,documentIds[0],'INVENTORY.DOCUMENT_PROCESS');
          if (document.status==='PENDING_APPROVAL') throw new AppError('STOCKTAKE_APPROVAL_REQUIRED','Approve the linked adjustment before posting.',409);
        } else {
          const currencies = await tx.inventoryMovement.groupBy({ by: ['currency'],where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: { in: changed.map(line => line.inventoryKey) } } });
          const denomination = input.currency ?? (currencies.length===1 ? currencies[0].currency : undefined);
          if (!denomination || currencies.some(value => value.currency!==denomination)) throw new AppError('COSTING_CURRENCY_INVALID','Use a single supported valuation currency for this session.',422);
          document = await this.documents.createInTransaction(tx,actor,{ documentType: 'STOCK_ADJUSTMENT',warehouseIds: { source: row.warehouseId },currency: denomination });
          const settings = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId },update: {} });
          for (const line of changed) {
            const last = await tx.inventoryMovement.findFirst({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: line.inventoryKey,currency: denomination,quantityDelta: { gt: 0 } },orderBy: { ledgerSequence: 'desc' } });
            const average = await tx.inventoryAverageCost.findFirst({ where: { workspaceId: actor.workspaceId,warehouseId: row.warehouseId,inventoryKey: line.inventoryKey,currency: denomination,generation: settings.valuationGeneration } });
            const cost = settings.costingMethod==='AVERAGE' && average ? average.averageCost : last?.unitCost;
            const proposal = await this.documents.addLineInTransaction(tx,actor,document.id,{ productId: line.productId,variantId: line.variantId ?? undefined,
              quantity: numeric24(exact(line.varianceQuantity!).abs()),unitCost: cost?.toFixed(6) ?? '0',locationId: line.locationId ?? undefined,
              adjustmentDirection: exact(line.varianceQuantity!).gt(0) ? 'IN' : 'OUT' });
            await tx.inventoryStocktakeLine.update({ where: { id: line.id },data: { adjustmentDocumentLineId: proposal.id,version: { increment: 1 } } });
          }
          document = await tx.inventoryDocument.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: document.id } });
          // Submission uses the owning document policy and the caller's separate submission authority.
          document = await this.documents.approvalInTransaction(tx,actor,document.id,{ expectedVersion: document.version.toString() },true);
          if (document.status==='PENDING_APPROVAL') {
            const updated = await tx.inventoryStocktake.update({ where: { id },data: { version: { increment: 1 } } });
            await evidence(tx,actor,'INVENTORY_STOCKTAKE',id,'STOCKTAKE_ADJUSTMENT_PROPOSED',{ documentId: document.id,version: updated.version.toString() });
            return { id,status: updated.status,version: updated.version.toString(),documentId: document.id,approvalRequired: true };
          }
        }
        await this.documents.processInTransaction(tx,actor,document.id,{ expectedVersion: document.version.toString() },key);
        const updated = await tx.inventoryStocktake.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id } });
        return { id,status: updated.status,version: updated.version.toString(),documentId: document.id,approvalRequired: false };
      });
    },{ timeout: 60000 });
  }
}
