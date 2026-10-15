import { Prisma,type PrismaClient,type InventoryDocument,type InventoryDocumentLine,type InventorySettings } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { command,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { canonical,parse,uuid,currency,pageQuery } from '../process-platform/dto';
import { inventoryVersion,assertInventoryVersion,documentType,positiveQuantity,quantity } from './dto';
import { exact,numeric24 } from './decimal';
import { InventoryWarehouseService } from './warehouse-service';
import { inventoryCatalogPort } from './catalog-port';
import { InventorySourceAuthority } from './source-port';
import { InventoryCostBook } from './cost-book';
import { observeReorder } from './reorder-service';
import { commerceReturnPosting } from '../commerce/order-authority';

const warehousesDto = z.strictObject({ source: uuid.optional(),destination: uuid.optional() });
const sourceDto = z.strictObject({ entityType: z.enum(['DEAL','ORDER','INVOICE','SPA_ITEM']),entityId: uuid });
export const createInventoryDocument = z.strictObject({ documentType,warehouseIds: warehousesDto,currency,sourceRef: sourceDto.optional() });
export const inventoryLineInput = z.strictObject({ productId: uuid,variantId: uuid.optional(),quantity: positiveQuantity,unitCost: quantity,
  locationId: uuid.optional(),sourceLocationId: uuid.optional(),targetLocationId: uuid.optional(),adjustmentDirection: z.enum(['IN','OUT']).optional(),
  writeOffReason: z.string().trim().min(1).max(2000).optional(),reservationId: uuid.optional(),
  serialIds: z.array(uuid).min(1).max(1000).refine(ids => new Set(ids).size===ids.length,'Serial numbers must be distinct').optional(),
  batches: z.array(z.strictObject({ batchId: uuid,quantity: positiveQuantity })).min(1).max(100).refine(rows => new Set(rows.map(r => r.batchId)).size===rows.length,'Batches must be distinct').optional() });
type Sku = { inventoryKey: string;tracking: 'NONE'|'SERIAL'|'BATCH';enforceBatchExpiry: boolean };
/** Serial lifecycle effect of a posted line; receipts and incoming adjustments register serials afterwards. */
function serialEffect(type: string,direction: string | null): { leg: 'ISSUE'|'TRANSFER'|'RETURN'|null;status?: string } {
  if (type==='TRANSFER') return { leg: 'TRANSFER' };
  if (type==='SALES_ORDER') return { leg: 'ISSUE',status: 'SOLD' };
  if (['WRITE_OFF','SUPPLIER_RETURN'].includes(type) || type==='STOCK_ADJUSTMENT' && direction==='OUT') return { leg: 'ISSUE',status: 'WRITTEN_OFF' };
  if (type==='CUSTOMER_RETURN') return { leg: 'RETURN',status: 'RETURNED' };
  return { leg: null };
}
function batchLegs(document: InventoryDocument,line: { adjustmentDirection: string | null }) {
  const source = document.sourceWarehouseId,destination = document.destinationWarehouseId;
  if (document.type==='TRANSFER') return [{ warehouseId: source!,delta: -1 },{ warehouseId: destination!,delta: 1 }];
  if (document.type==='STOCK_ADJUSTMENT') return [{ warehouseId: (source ?? destination)!,delta: line.adjustmentDirection==='IN' ? 1 : -1 }];
  return destination ? [{ warehouseId: destination,delta: 1 }] : [{ warehouseId: source!,delta: -1 }];
}
export const inventoryDocumentPolicy = z.strictObject({ requiresApproval: z.boolean().default(false),minimumValue: quantity.optional(),currency: currency.optional(),
  approverRoleIds: z.array(uuid).min(1).max(100).optional(),requiredApprovals: z.number().int().min(1).max(10).default(1),allowSelfApproval: z.boolean().default(false),
  actions: z.record(z.string().regex(/^INVENTORY\.DOCUMENT_[A-Z_]+$/),z.array(uuid).max(100)).default({}) });
export interface ReservationPostingPort {
  consumeForPosting(tx: Tx,actor: Principal,reservationId: string,line: InventoryDocumentLine,document: InventoryDocument): Promise<void>;
}
export interface StocktakePostingPort {
  validateDocument(tx: Tx,actor: Principal,document: InventoryDocument): Promise<void>;
  completeDocument(tx: Tx,actor: Principal,document: InventoryDocument): Promise<void>;
}

export class InventoryDocumentService {
  readonly sources: InventorySourceAuthority;
  readonly costs = new InventoryCostBook();
  private reservations?: ReservationPostingPort;
  private stocktakes?: StocktakePostingPort;
  constructor(private readonly db: PrismaClient,readonly warehouses = new InventoryWarehouseService(db),sources?: InventorySourceAuthority) {
    this.sources = sources ?? new InventorySourceAuthority(db);
  }
  setReservationPort(port: ReservationPostingPort) { this.reservations = port; }
  setStocktakePort(port: StocktakePostingPort) { this.stocktakes = port; }
  private policy(settings: InventorySettings | null,type: string) {
    const policies = (settings?.approvalPolicies ?? {}) as Record<string,unknown>;
    return parse(inventoryDocumentPolicy,policies[type] ?? {});
  }
  async document(tx: Tx,actor: Principal,id: string,permission: string) {
    parse(uuid,id); requirePermission(actor,permission);
    const row = await tx.inventoryDocument.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row || !await ownerVisible(tx,actor,row.createdByUserId,permission)) throw new AppError('INVENTORY_DOCUMENT_NOT_FOUND','Document was not found.',404);
    const settings = await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } });
    const roles = this.policy(settings,row.type).actions[permission];
    if (roles && !roles.includes(actor.roleId)) throw new AppError('INVENTORY_DOCUMENT_NOT_FOUND','Document was not found.',404);
    for (const warehouseId of [row.sourceWarehouseId,row.destinationWarehouseId].filter((id): id is string => Boolean(id)))
      await this.warehouses.warehouse(tx,actor,warehouseId,permission);
    if (row.sourceEntityType && row.sourceEntityId) await this.sources.read(tx,actor,{ entityType: row.sourceEntityType,entityId: row.sourceEntityId });
    return row;
  }
  private async binding(tx: Tx,actor: Principal,type: string,ids: z.infer<typeof warehousesDto>,permission: string) {
    const incoming = ['STOCK_RECEIPT','CUSTOMER_RETURN'].includes(type),outgoing = ['SALES_ORDER','SUPPLIER_RETURN','WRITE_OFF'].includes(type);
    if (incoming && (!ids.destination || ids.source) || outgoing && (!ids.source || ids.destination) || type==='TRANSFER' && (!ids.source || !ids.destination || ids.source===ids.destination)
      || type==='STOCK_ADJUSTMENT' && (Boolean(ids.source)===Boolean(ids.destination))) throw new AppError('INVENTORY_LINE_INVALID','Warehouse legs do not match document type.',422);
    for (const id of [...new Set([ids.source,ids.destination].filter((id): id is string => Boolean(id)))].sort()) {
      await lock(tx,actor.workspaceId,'inventory:warehouse:' + id); await this.warehouses.warehouse(tx,actor,id,permission,true);
    }
  }
  private async number(tx: Tx,actor: Principal,type: string) {
    const where = { workspaceId_documentType: { workspaceId: actor.workspaceId,documentType: type } };
    const scheme = await tx.inventoryNumberingScheme.upsert({ where,create: { workspaceId: actor.workspaceId,documentType: type,prefixTemplate: type + '-{YYYY}-' },update: {} });
    const now = new Date(),year = String(now.getUTCFullYear()),month = String(now.getUTCMonth()+1).padStart(2,'0');
    const period = scheme.resetPolicy==='YEARLY' ? year : scheme.resetPolicy==='MONTHLY' ? year+month : '';
    const value = period===scheme.periodKey ? scheme.nextValue : 1n;
    const prefix = scheme.prefixTemplate.replaceAll('{YYYY}',year).replaceAll('{MM}',month).replaceAll('{TYPE}',type);
    await tx.inventoryNumberingScheme.update({ where: { id: scheme.id },data: { nextValue: value+1n,periodKey: period,version: { increment: 1 } } });
    return prefix + value.toString().padStart(scheme.padding,'0');
  }
  private async history(tx: Tx,actor: Principal,row: InventoryDocument,action: string,metadata: Prisma.InputJsonObject = {}) {
    await tx.inventoryDocumentHistory.create({ data: { workspaceId: actor.workspaceId,documentId: row.id,actorUserId: actor.userId,action,metadata } });
    await evidence(tx,actor,'INVENTORY_DOCUMENT',row.id,action,{ ...metadata,documentType: row.type,version: row.version.toString() });
  }
  async createInTransaction(tx: Tx,actor: Principal,raw: unknown) {
    const input = parse(createInventoryDocument,raw); requirePermission(actor,'INVENTORY.DOCUMENT_CREATE');
    const settings = await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } });
    if (settings?.isEnabled===false) throw new AppError('PERMISSION_DENIED','Inventory is disabled.',403);
    const roles = this.policy(settings,input.documentType).actions['INVENTORY.DOCUMENT_CREATE'];
    if (roles && !roles.includes(actor.roleId)) throw new AppError('PERMISSION_DENIED','Document type is unavailable.',403);
    await this.binding(tx,actor,input.documentType,input.warehouseIds,'INVENTORY.DOCUMENT_CREATE');
    if (input.sourceRef) await this.sources.read(tx,actor,input.sourceRef);
    const row = await tx.inventoryDocument.create({ data: { workspaceId: actor.workspaceId,number: await this.number(tx,actor,input.documentType),type: input.documentType,
      sourceWarehouseId: input.warehouseIds.source,destinationWarehouseId: input.warehouseIds.destination,currency: input.currency,
      sourceEntityType: input.sourceRef?.entityType,sourceEntityId: input.sourceRef?.entityId,createdByUserId: actor.userId } });
    await this.history(tx,actor,row,'INVENTORY_DOCUMENT_CREATED'); return row;
  }
  async create(actor: Principal,raw: unknown) {
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      return this.createInTransaction(tx,actor,raw);
    },{ timeout: 60000 });
  }
  async createControlledAdjustmentInTransaction(tx: Tx,actor: Principal,raw: unknown,jobId: string) {
    requirePermission(actor,'INVENTORY.RESET');
    const job = await tx.inventoryJob.findFirst({ where: { workspaceId: actor.workspaceId,id: jobId,type: 'RESET_APPLY',status: 'RUNNING',requestedByUserId: actor.userId } });
    if (!job) throw new AppError('INVENTORY_RESET_BLOCKED','A running controlled reset job is required.',409);
    const row = await this.createInTransaction(tx,actor,raw);
    if (row.type!=='STOCK_ADJUSTMENT') throw new AppError('INVENTORY_LINE_INVALID','Controlled reset creates only adjustment documents.',422);
    await this.history(tx,actor,row,'INVENTORY_CONTROLLED_DOCUMENT_CREATED',{ jobId }); return row;
  }
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'INVENTORY.DOCUMENT_READ'); const query = parse(pageQuery.extend({ documentType: documentType.optional(),status: z.enum(['DRAFT','PENDING_APPROVAL','APPROVED','PROCESSED','CANCELLED']).optional(),warehouseId: uuid.optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.inventoryDocument.findMany({ where: { workspaceId: actor.workspaceId,type: query.documentType,status: query.status,
        ...(query.warehouseId ? { OR: [{ sourceWarehouseId: query.warehouseId },{ destinationWarehouseId: query.warehouseId }] } : {}),
        ...(query.search ? { number: { contains: query.search,mode: 'insensitive' } } : {}) },orderBy: [{ createdAt: 'desc' },{ id: 'asc' }] });
      const visible = [];
      for (const row of rows) try { await this.document(tx,actor,row.id,'INVENTORY.DOCUMENT_READ'); visible.push(row); }
      catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async get(actor: Principal,id: string) {
    return this.db.$transaction(async tx => {
      const row = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_READ');
      const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: id },orderBy: { lineNumber: 'asc' } });
      const financiallyVisible = await this.financiallyVisible(tx,actor,row);
      return { ...row,lines: lines.map(line => financiallyVisible ? line : (({ unitCost,...rest }) => rest)(line)) };
    });
  }
  private async financiallyVisible(tx: Tx,actor: Principal,row: InventoryDocument) {
    for (const id of [row.sourceWarehouseId,row.destinationWarehouseId].filter((v): v is string => Boolean(v))) {
      const warehouse = await tx.inventoryWarehouse.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id } });
      if (!await this.warehouses.allowed(tx,actor,warehouse,'INVENTORY.COSTING_VIEW') && !await this.warehouses.allowed(tx,actor,warehouse,'INVENTORY.VALUATION_VIEW')) return false;
    }
    return true;
  }
  private editable(row: InventoryDocument) {
    if (!['DRAFT','APPROVED'].includes(row.status)) throw new AppError('INVENTORY_DOCUMENT_NOT_DRAFT','Only a draft or approved revision can be edited.',409);
  }
  async update(actor: Principal,id: string,raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: inventoryVersion,editableFields: z.strictObject({ warehouseIds: warehousesDto.optional(),currency: currency.optional(),sourceRef: sourceDto.nullable().optional() }) }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_EDIT'); assertInventoryVersion(row.version,input.expectedVersion); this.editable(row);
      const values = input.editableFields;
      if (values.warehouseIds) {
        if (await tx.inventoryDocumentLine.count({ where: { workspaceId: actor.workspaceId,documentId: id } })) throw new AppError('INVENTORY_LINE_INVALID','Remove lines before changing warehouse legs.',409);
        await this.binding(tx,actor,row.type,values.warehouseIds,'INVENTORY.DOCUMENT_EDIT');
      }
      if (values.sourceRef) await this.sources.read(tx,actor,values.sourceRef);
      const updated = await tx.inventoryDocument.update({ where: { id },data: { ...(values.warehouseIds ? { sourceWarehouseId: values.warehouseIds.source ?? null,destinationWarehouseId: values.warehouseIds.destination ?? null } : {}),
        currency: values.currency,...(values.sourceRef!==undefined ? { sourceEntityType: values.sourceRef?.entityType ?? null,sourceEntityId: values.sourceRef?.entityId ?? null } : {}),
        status: 'DRAFT',approvalRevision: null,version: { increment: 1 } } });
      await this.history(tx,actor,updated,'INVENTORY_DOCUMENT_UPDATED'); return updated;
    });
  }
  private async lineLocations(tx: Tx,actor: Principal,document: InventoryDocument,source?: string,target?: string) {
    for (const [id,warehouseId] of [[source,document.sourceWarehouseId],[target,document.destinationWarehouseId]]) if (id) {
      if (!warehouseId || !await tx.inventoryLocation.findFirst({ where: { workspaceId: actor.workspaceId,warehouseId,id,status: 'ACTIVE' } }))
        throw new AppError('INVENTORY_LINE_INVALID','Location is unavailable for this warehouse leg.',422);
    }
  }
  /** Serial/batch selections required by the Catalog SKU policy; stocktake and controlled reset adjustments are quantity-only (Phase 2 traceability). */
  private async selections(tx: Tx,actor: Principal,row: InventoryDocument,sku: Sku,input: z.infer<typeof inventoryLineInput>,exempt: boolean) {
    const invalid = (message: string) => new AppError('INVENTORY_LINE_INVALID',message,422);
    if (sku.tracking==='NONE' || exempt) {
      if (input.serialIds || input.batches) throw invalid('Serial or batch selection does not apply to this line.');
      return [];
    }
    if (sku.tracking==='SERIAL') {
      if (input.batches) throw invalid('This SKU is serial-tracked.');
      if (!exact(input.quantity).isInteger()) throw invalid('Serial-tracked quantities must be whole units.');
      if (!serialEffect(row.type,input.adjustmentDirection ?? null).leg) {
        if (input.serialIds) throw invalid('Register serial numbers after the receipt is processed.');
        return [];
      }
      if (!input.serialIds || input.serialIds.length!==Number(input.quantity)) throw invalid('Select exactly one serial number per unit.');
      const found = await tx.inventorySerialNumber.count({ where: { workspaceId: actor.workspaceId,id: { in: input.serialIds },inventoryKey: sku.inventoryKey } });
      if (found!==input.serialIds.length) throw invalid('Serial number is unavailable for this SKU.');
      return input.serialIds.map(serialId => ({ serialId,quantity: '1' }));
    }
    if (input.serialIds) throw invalid('This SKU is batch-tracked.');
    if (!input.batches || !input.batches.reduce((sum,b) => sum.plus(b.quantity),exact('0')).eq(input.quantity)) throw invalid('Select batches covering the line quantity.');
    const found = await tx.inventoryBatch.count({ where: { workspaceId: actor.workspaceId,id: { in: input.batches.map(b => b.batchId) },inventoryKey: sku.inventoryKey,status: 'ACTIVE' } });
    if (found!==input.batches.length) throw invalid('Batch is unavailable for this SKU.');
    return input.batches.map(b => ({ batchId: b.batchId,quantity: b.quantity }));
  }
  async addLineInTransaction(tx: Tx,actor: Principal,id: string,raw: unknown,options: { trackingExempt?: boolean } = {}) {
    const input = parse(inventoryLineInput,raw),row = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_EDIT'); this.editable(row);
    const sku = (await inventoryCatalogPort(tx,actor)).sku(input.productId,input.variantId);
    if (exact(input.quantity).decimalPlaces()>sku.unitPrecision) throw new AppError('INVENTORY_LINE_INVALID','Quantity exceeds the Catalog unit precision.',422);
    if (input.locationId && (input.sourceLocationId || input.targetLocationId)) throw new AppError('INVENTORY_LINE_INVALID','Use one location addressing form.',422);
    const source = input.sourceLocationId ?? (row.sourceWarehouseId ? input.locationId : undefined),target = input.targetLocationId ?? (!row.sourceWarehouseId ? input.locationId : undefined);
    await this.lineLocations(tx,actor,row,source,target);
    if (row.type==='STOCK_ADJUSTMENT' && !input.adjustmentDirection || row.type!=='STOCK_ADJUSTMENT' && input.adjustmentDirection)
      throw new AppError('INVENTORY_LINE_INVALID','Adjustment direction does not match the document.',422);
    if (row.type==='WRITE_OFF' && !input.writeOffReason) throw new AppError('INVENTORY_LINE_INVALID','Write-off reason is required.',422);
    const selections = await this.selections(tx,actor,row,sku,input,Boolean(options.trackingExempt));
    const last = await tx.inventoryDocumentLine.findFirst({ where: { workspaceId: actor.workspaceId,documentId: id },orderBy: { lineNumber: 'desc' } });
    const line = await tx.inventoryDocumentLine.create({ data: { workspaceId: actor.workspaceId,documentId: id,productId: sku.productId,variantId: sku.variantId,inventoryKey: sku.inventoryKey,
      quantity: input.quantity,unitCost: input.unitCost,sourceLocationId: source,targetLocationId: target,adjustmentDirection: input.adjustmentDirection,writeOffReason: input.writeOffReason,reservationId: input.reservationId,lineNumber: (last?.lineNumber ?? 0)+1 } });
    if (selections.length) await tx.inventoryDocumentLineTracking.createMany({ data: selections.map(selection => ({ workspaceId: actor.workspaceId,documentId: id,documentLineId: line.id,...selection })) });
    const updated = await tx.inventoryDocument.update({ where: { id },data: { status: 'DRAFT',approvalRevision: null,version: { increment: 1 } } });
    await this.history(tx,actor,updated,'INVENTORY_DOCUMENT_LINE_ADDED',{ lineId: line.id,selections: selections.length }); return { ...line,documentVersion: updated.version.toString(),selections };
  }
  async line(actor: Principal,id: string,raw: unknown,lineId?: string,remove = false) {
    const input = remove ? parse(z.strictObject({}),raw) : lineId ? parse(z.strictObject({ expectedVersion: inventoryVersion,quantity: positiveQuantity.optional(),unitCost: quantity.optional() }),raw) : parse(inventoryLineInput,raw);
    if (lineId) parse(uuid,lineId);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      if (!lineId) return this.addLineInTransaction(tx,actor,id,input);
      const document = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_EDIT'); this.editable(document);
      const existing = await tx.inventoryDocumentLine.findFirst({ where: { workspaceId: actor.workspaceId,documentId: id,id: lineId } });
      if (!existing) throw new AppError('INVENTORY_LINE_INVALID','Line was not found.',404);
      if ('expectedVersion' in input) assertInventoryVersion(existing.version,String(input.expectedVersion));
      const sku = (await inventoryCatalogPort(tx,actor)).sku(existing.productId,existing.variantId ?? undefined);
      const newQty = 'quantity' in input && typeof input.quantity==='string' ? input.quantity : existing.quantity.toFixed(6);
      if (exact(newQty).decimalPlaces()>sku.unitPrecision) throw new AppError('INVENTORY_LINE_INVALID','Quantity exceeds unit precision.',422);
      if (!remove && !exact(newQty).eq(existing.quantity) && await tx.inventoryDocumentLineTracking.count({ where: { workspaceId: actor.workspaceId,documentLineId: lineId } }))
        throw new AppError('INVENTORY_LINE_INVALID','Remove and re-add a serial/batch line to change its quantity.',422);
      let result: unknown;
      if (remove) { await tx.inventoryDocumentLine.delete({ where: { id: lineId } }); result = { deleted: true,id: lineId }; }
      else result = await tx.inventoryDocumentLine.update({ where: { id: lineId },data: { quantity: newQty,...('unitCost' in input && typeof input.unitCost==='string' ? { unitCost: input.unitCost } : {}),version: { increment: 1 } } });
      const updated = await tx.inventoryDocument.update({ where: { id },data: { status: 'DRAFT',approvalRevision: null,version: { increment: 1 } } });
      await this.history(tx,actor,updated,remove ? 'INVENTORY_DOCUMENT_LINE_REMOVED' : 'INVENTORY_DOCUMENT_LINE_UPDATED',{ lineId });
      if (!remove && !await this.financiallyVisible(tx,actor,updated) && typeof result==='object' && result!==null && 'unitCost' in result) {
        const { unitCost,...visible } = result; result = visible;
      }
      return { line: result,documentVersion: updated.version.toString() };
    },{ timeout: 60000 });
  }
  private async requiresApproval(tx: Tx,row: InventoryDocument,settings: InventorySettings | null) {
    const policy = this.policy(settings,row.type);
    if (!policy.requiresApproval) return { required: false,policy };
    if (policy.currency && policy.currency!==row.currency) throw new AppError('COSTING_CURRENCY_INVALID','Approval threshold currency does not match document.',422);
    const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: row.workspaceId,documentId: row.id } });
    let total = exact('0'); const outgoing = new Map<string,{ warehouseId: string;inventoryKey: string;quantity: string }>();
    for (const line of lines) {
      const issue = row.type==='STOCK_ADJUSTMENT' ? line.adjustmentDirection==='OUT' : Boolean(row.sourceWarehouseId);
      if (!issue) { total = total.plus(exact(line.quantity).mul(line.unitCost)); continue; }
      const warehouseId = row.sourceWarehouseId ?? row.destinationWarehouseId!,key = warehouseId + ':' + line.inventoryKey;
      const group = outgoing.get(key) ?? { warehouseId,inventoryKey: line.inventoryKey,quantity: '0' };
      group.quantity = numeric24(exact(group.quantity).plus(line.quantity)); outgoing.set(key,group);
    }
    for (const group of outgoing.values()) total = total.plus(await this.costs.previewIssue(tx,{ workspaceId: row.workspaceId,warehouseId: group.warehouseId,
      inventoryKey: group.inventoryKey,currency: row.currency,generation: settings?.valuationGeneration ?? 1 },settings?.costingMethod ?? 'FIFO',group.quantity,settings?.allowNegativeStock ?? false));
    return { required: !policy.minimumValue || total.gte(policy.minimumValue),policy };
  }
  async approval(actor: Principal,id: string,raw: unknown,submit = false) {
    return this.db.$transaction(tx => this.approvalInTransaction(tx,actor,id,raw,submit));
  }
  async approvalInTransaction(tx: Tx,actor: Principal,id: string,raw: unknown,submit = false) {
    const input = submit ? parse(z.strictObject({ expectedVersion: inventoryVersion }),raw) : parse(z.strictObject({ expectedVersion: inventoryVersion,decision: z.enum(['APPROVE','REJECT']),comment: z.string().max(2000).optional() }),raw);
      await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.document(tx,actor,id,submit ? 'INVENTORY.DOCUMENT_SUBMIT' : 'INVENTORY.DOCUMENT_APPROVE'); assertInventoryVersion(row.version,input.expectedVersion);
      const { required,policy } = await this.requiresApproval(tx,row,await tx.inventorySettings.findUnique({ where: { workspaceId: actor.workspaceId } }));
      let status: string,revision: bigint | null;
      if (submit) {
        if (row.status!=='DRAFT' || !await tx.inventoryDocumentLine.count({ where: { workspaceId: actor.workspaceId,documentId: id } })) throw new AppError('INVENTORY_DOCUMENT_NOT_DRAFT','Submit a nonempty draft.',409);
        status = required ? 'PENDING_APPROVAL' : 'APPROVED'; revision = row.version+1n;
      } else {
        if (row.status!=='PENDING_APPROVAL' || !row.approvalRevision || !('decision' in input)) throw new AppError('INVENTORY_APPROVAL_REQUIRED','Document is not awaiting approval.',409);
        if (!policy.allowSelfApproval && row.createdByUserId===actor.userId || policy.approverRoleIds && !policy.approverRoleIds.includes(actor.roleId)) throw new AppError('PERMISSION_DENIED','This actor cannot approve the document.',403);
        const decision = String(input.decision);
        if (await tx.inventoryDocumentApproval.count({ where: { workspaceId: actor.workspaceId,documentId: id,documentVersion: row.approvalRevision,actorUserId: actor.userId } })) throw new AppError('INVENTORY_APPROVAL_REQUIRED','Actor already decided this revision.',409);
        await tx.inventoryDocumentApproval.create({ data: { workspaceId: actor.workspaceId,documentId: id,documentVersion: row.approvalRevision,actorUserId: actor.userId,decision,
          comment: 'comment' in input && typeof input.comment==='string' ? input.comment : undefined,policySnapshot: policy as Prisma.InputJsonValue } });
        const approvals = await tx.inventoryDocumentApproval.count({ where: { workspaceId: actor.workspaceId,documentId: id,documentVersion: row.approvalRevision,decision: 'APPROVE' } });
        status = decision==='REJECT' ? 'DRAFT' : approvals>=policy.requiredApprovals ? 'APPROVED' : 'PENDING_APPROVAL'; revision = decision==='REJECT' ? null : row.approvalRevision;
      }
      const updated = await tx.inventoryDocument.update({ where: { id },data: { status,approvalRevision: revision,version: { increment: 1 } } });
      await this.history(tx,actor,updated,submit ? 'INVENTORY_DOCUMENT_APPROVAL_REQUESTED' : 'INVENTORY_DOCUMENT_APPROVAL_DECIDED',{ status }); return updated;
  }
  async historyList(actor: Principal,id: string,raw: unknown) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.document(tx,actor,id,'INVENTORY.DOCUMENT_READ'); const where = { workspaceId: actor.workspaceId,documentId: id };
      const [rows,total] = await Promise.all([tx.inventoryDocumentHistory.findMany({ where,orderBy: [{ occurredAt: 'desc' },{ id: 'desc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.inventoryDocumentHistory.count({ where })]);
      return { data: rows,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  private async stockLocks(tx: Tx,actor: Principal,document: InventoryDocument,lines: InventoryDocumentLine[]) {
    const warehouseIds = [...new Set([document.sourceWarehouseId,document.destinationWarehouseId].filter((id): id is string => Boolean(id)))].sort();
    for (const id of warehouseIds) await lock(tx,actor.workspaceId,'inventory:warehouse:' + id);
    const keys = [...new Set(warehouseIds.flatMap(id => lines.map(line => id + ':' + line.inventoryKey)))].sort();
    for (const key of keys) await lock(tx,actor.workspaceId,'inventory:stock:' + key);
  }
  private async changeBalance(tx: Tx,actor: Principal,warehouseId: string,line: InventoryDocumentLine,locationId: string | null,delta: string,allowNegative: boolean) {
    const key = { workspaceId: actor.workspaceId,warehouseId,inventoryKey: line.inventoryKey,locationKey: locationId ?? '' };
    const row = await tx.inventoryBalance.upsert({ where: { workspaceId_warehouseId_inventoryKey_locationKey: key },create: { ...key,locationId,productId: line.productId,variantId: line.variantId },update: {} });
    const next = exact(row.onHand).plus(delta);
    if (exact(delta).lt(0) && !allowNegative && (next.lt(0) || next.minus(row.reserved).lt(0))) throw new AppError('STOCK_INSUFFICIENT','Unreserved stock does not cover this movement.',409);
    const updated = await tx.inventoryBalance.update({ where: { id: row.id },data: { onHand: numeric24(next),version: { increment: 1 } } });
    await evidence(tx,actor,'INVENTORY_STOCK',row.id,'STOCK_CHANGED',{ warehouseId,productId: line.productId,variantId: line.variantId,
      inventoryKey: line.inventoryKey,locationId,quantityDelta: delta,onHand: numeric24(next),available: numeric24(next.minus(updated.reserved)),version: updated.version.toString() },false);
    if (exact(row.onHand).minus(row.reserved).gt(0) && next.minus(updated.reserved).lte(0)) await evidence(tx,actor,'INVENTORY_STOCK',row.id,'STOCK_OUT_OF_STOCK',{
      warehouseId,productId: line.productId,variantId: line.variantId,inventoryKey: line.inventoryKey },false);
  }
  private async move(tx: Tx,actor: Principal,document: InventoryDocument,line: InventoryDocumentLine,warehouseId: string,locationId: string | null,
    settings: InventorySettings,input: { incoming: boolean;type: string;cost?: { unitCost: string;totalCost: string;allocations?: { quantity: string;unitCost: string;totalCost: string }[] } }) {
    const movementId = randomUUID(),qty = line.quantity.toFixed(6),scope = { workspaceId: actor.workspaceId,warehouseId,inventoryKey: line.inventoryKey,currency: document.currency,generation: settings.valuationGeneration };
    // Physical availability is validated before valuation so a shortage reports STOCK_INSUFFICIENT.
    const quantityDelta = numeric24(input.incoming ? qty : exact(qty).neg());
    await this.changeBalance(tx,actor,warehouseId,line,locationId,quantityDelta,settings.allowNegativeStock);
    const costs = input.incoming ? input.cost ?? { unitCost: line.unitCost.toFixed(6),totalCost: numeric24(exact(line.quantity).mul(line.unitCost)) }
      : await this.costs.issue(tx,scope,settings.costingMethod,qty,movementId,settings.allowNegativeStock);
    const totalCost = numeric24(input.incoming ? costs.totalCost : exact(costs.totalCost).neg());
    await tx.inventoryMovement.create({ data: { id: movementId,workspaceId: actor.workspaceId,warehouseId,locationId,productId: line.productId,variantId: line.variantId,inventoryKey: line.inventoryKey,
      documentId: document.id,documentLineId: line.id,sourceType: document.sourceEntityType ?? 'INVENTORY_DOCUMENT',sourceId: document.sourceEntityId ?? document.id,
      quantityDelta,unitCost: costs.unitCost,totalCost,currency: document.currency,type: input.type,postingKey: document.id + ':' + line.id + ':' + input.type,
      costingMethod: settings.costingMethod,valuationGeneration: settings.valuationGeneration,occurredAt: new Date() } });
    if (input.incoming) await this.costs.receipt(tx,scope,settings.costingMethod,{ quantity: qty,unitCost: costs.unitCost,totalCost: costs.totalCost,movementId,documentLineId: line.id,
      occurredAt: new Date(),parts: costs.allocations });
    return costs;
  }
  private async applyTracking(tx: Tx,actor: Principal,document: InventoryDocument,line: InventoryDocumentLine,sku: Sku,exempt: boolean) {
    const rows = await tx.inventoryDocumentLineTracking.findMany({ where: { workspaceId: actor.workspaceId,documentLineId: line.id },orderBy: { id: 'asc' } });
    const effect = serialEffect(document.type,line.adjustmentDirection);
    if (!rows.length) {
      if (exempt || sku.tracking==='NONE' || sku.tracking==='SERIAL' && !effect.leg) return;
      throw new AppError('INVENTORY_LINE_INVALID','Tracked SKU line requires serial or batch selection.',422);
    }
    if (sku.tracking==='NONE' || rows.some(r => r.serialId ? sku.tracking!=='SERIAL' : sku.tracking!=='BATCH'))
      throw new AppError('INVENTORY_LINE_INVALID','SKU tracking policy changed; re-create the line.',422);
    const now = new Date();
    for (const tracking of rows) {
      if (tracking.serialId) {
        await lock(tx,actor.workspaceId,'inventory:serial:' + tracking.serialId);
        const serial = await tx.inventorySerialNumber.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: tracking.serialId } });
        let next: { status: string;warehouseId: string };
        if (effect.leg==='RETURN') {
          if (serial.status!=='SOLD') throw new AppError('SERIAL_NOT_AVAILABLE','Only a sold serial unit can be returned.',409);
          next = { status: 'RETURNED',warehouseId: document.destinationWarehouseId! };
        } else {
          if (!['IN_STOCK','RETURNED'].includes(serial.status) || serial.warehouseId!==document.sourceWarehouseId)
            throw new AppError('SERIAL_NOT_AVAILABLE','Serial unit is not in stock at the source warehouse.',409);
          next = effect.leg==='TRANSFER' ? { status: serial.status,warehouseId: document.destinationWarehouseId! } : { status: effect.status!,warehouseId: serial.warehouseId };
        }
        await tx.inventoryDocumentLineTracking.update({ where: { id: tracking.id },data: { priorStatus: serial.status,priorWarehouseId: serial.warehouseId } });
        await tx.inventorySerialNumber.update({ where: { id: serial.id },data: next });
        continue;
      }
      const batch = await tx.inventoryBatch.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: tracking.batchId! } });
      for (const leg of batchLegs(document,line)) {
        if (leg.delta<0 && sku.enforceBatchExpiry && batch.expiresAt && batch.expiresAt<=now && ['SALES_ORDER','TRANSFER'].includes(document.type))
          throw new AppError('BATCH_EXPIRED','An expired batch cannot be issued for sale.',409);
        await this.batchBalance(tx,actor,leg.warehouseId,batch.id,batch.inventoryKey,exact(tracking.quantity).mul(leg.delta),'STOCK_INSUFFICIENT');
      }
    }
  }
  private async batchBalance(tx: Tx,actor: Principal,warehouseId: string,batchId: string,inventoryKey: string,delta: Prisma.Decimal,shortage: string) {
    const key = { workspaceId_warehouseId_batchId: { workspaceId: actor.workspaceId,warehouseId,batchId } };
    const row = await tx.inventoryBatchBalance.upsert({ where: key,create: { workspaceId: actor.workspaceId,warehouseId,batchId,inventoryKey },update: {} });
    const next = exact(row.onHand).plus(delta);
    if (next.lt(0)) throw new AppError(shortage,'Batch quantity does not cover this movement.',409);
    await tx.inventoryBatchBalance.update({ where: { id: row.id },data: { onHand: numeric24(next),version: { increment: 1 } } });
  }
  private async reverseTracking(tx: Tx,actor: Principal,document: InventoryDocument,lines: InventoryDocumentLine[]) {
    for (const line of lines) {
      const effect = serialEffect(document.type,line.adjustmentDirection);
      for (const tracking of await tx.inventoryDocumentLineTracking.findMany({ where: { workspaceId: actor.workspaceId,documentLineId: line.id },orderBy: { id: 'asc' } })) {
        if (tracking.serialId) {
          if (!tracking.priorStatus || !tracking.priorWarehouseId) continue;
          await lock(tx,actor.workspaceId,'inventory:serial:' + tracking.serialId);
          const serial = await tx.inventorySerialNumber.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: tracking.serialId } });
          const expected = effect.leg==='RETURN' ? { status: 'RETURNED',warehouseId: document.destinationWarehouseId }
            : effect.leg==='TRANSFER' ? { status: tracking.priorStatus,warehouseId: document.destinationWarehouseId } : { status: effect.status,warehouseId: tracking.priorWarehouseId };
          if (serial.status!==expected.status || serial.warehouseId!==expected.warehouseId)
            throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','A serial unit changed after posting; reverse dependent documents first.',409);
          await tx.inventorySerialNumber.update({ where: { id: serial.id },data: { status: tracking.priorStatus,warehouseId: tracking.priorWarehouseId } });
        } else {
          const batch = await tx.inventoryBatch.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: tracking.batchId! } });
          for (const leg of batchLegs(document,line)) await this.batchBalance(tx,actor,leg.warehouseId,batch.id,batch.inventoryKey,exact(tracking.quantity).mul(-leg.delta),'INVENTORY_DOCUMENT_REVERSAL_BLOCKED');
        }
      }
    }
  }
  async processInTransaction(tx: Tx,actor: Principal,id: string,raw: unknown,key: string | null,context?: { controlledJobId: string }) {
    const input = parse(z.strictObject({ expectedVersion: inventoryVersion }),raw);
    await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:' + id);
    actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
    const row = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_PROCESS');
    const origin = await tx.inventoryDocumentHistory.findFirst({ where: { workspaceId: actor.workspaceId,documentId: id,action: 'INVENTORY_CONTROLLED_DOCUMENT_CREATED' } });
    if (origin) {
      const jobId = (origin.metadata as { jobId?: string }).jobId;
      if (!jobId || jobId!==context?.controlledJobId || !await tx.inventoryJob.count({ where: { workspaceId: actor.workspaceId,id: jobId,type: 'RESET_APPLY',status: 'RUNNING',requestedByUserId: actor.userId } }))
        throw new AppError('INVENTORY_RESET_BLOCKED','This adjustment must be processed by its controlled reset job.',409);
      requirePermission(actor,'INVENTORY.RESET');
    }
    return command(tx,actor,'INVENTORY.DOCUMENT_PROCESS:' + id,key,input,async () => {
      assertInventoryVersion(row.version,input.expectedVersion);
      if (row.status==='PROCESSED') throw new AppError('INVENTORY_DOCUMENT_ALREADY_PROCESSED','Document was already processed.',409);
      if (!['DRAFT','APPROVED'].includes(row.status)) throw new AppError('INVENTORY_DOCUMENT_NOT_DRAFT','Document cannot be processed in its current state.',409);
      const settings = await tx.inventorySettings.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId },update: {} });
      if (!settings.isEnabled) throw new AppError('PERMISSION_DENIED','Inventory is disabled.',403);
      const { required,policy } = await this.requiresApproval(tx,row,settings);
      if (required) {
        if (row.status!=='APPROVED' || !row.approvalRevision) throw new AppError('INVENTORY_APPROVAL_REQUIRED','Document requires approval.',409);
        const approvals = await tx.inventoryDocumentApproval.findMany({ where: { workspaceId: actor.workspaceId,documentId: id,documentVersion: row.approvalRevision,decision: 'APPROVE' } });
        if (approvals.filter(a => canonical(a.policySnapshot)===canonical(policy)).length<policy.requiredApprovals)
          throw new AppError('INVENTORY_APPROVAL_REQUIRED','Approval policy changed; submit a new revision.',409);
      }
      const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: id },orderBy: { lineNumber: 'asc' } });
      if (!lines.length || lines.length>1000) throw new AppError('INVENTORY_LINE_INVALID','Posting requires 1 to 1000 lines.',422);
      if(row.type==='CUSTOMER_RETURN')await commerceReturnPosting(tx,actor,id);
      await this.binding(tx,actor,row.type,{ source: row.sourceWarehouseId ?? undefined,destination: row.destinationWarehouseId ?? undefined },'INVENTORY.DOCUMENT_PROCESS');
      await this.stockLocks(tx,actor,row,lines);
      const catalog = await inventoryCatalogPort(tx,actor);
      const bound = await tx.inventoryStocktakeLine.findMany({ where: { workspaceId: actor.workspaceId,adjustmentDocumentLineId: { in: lines.map(line => line.id) } },select: { adjustmentDocumentLineId: true } });
      const boundCount = bound.length,stocktakeLines = new Set(bound.map(b => b.adjustmentDocumentLineId));
      if (boundCount && !this.stocktakes) throw new AppError('STOCKTAKE_INVALID_STATUS','Stocktake posting authority is unavailable.',503);
      if (boundCount) await this.stocktakes!.validateDocument(tx,actor,row);
      for (const line of lines) {
        const sku = catalog.sku(line.productId,line.variantId ?? undefined);
        if (exact(line.quantity).decimalPlaces()>sku.unitPrecision) throw new AppError('INVENTORY_LINE_INVALID','Quantity exceeds current unit precision.',422);
        await this.lineLocations(tx,actor,row,line.sourceLocationId ?? undefined,line.targetLocationId ?? undefined);
        if (line.reservationId) {
          if (row.type!=='SALES_ORDER' || !this.reservations) throw new AppError('RESERVATION_SOURCE_INVALID','Reservation posting adapter is unavailable for this document.',503);
          await this.reservations.consumeForPosting(tx,actor,line.reservationId,line,row);
        }
        if (row.type==='TRANSFER') {
          const cost = await this.move(tx,actor,row,line,row.sourceWarehouseId!,line.sourceLocationId,settings,{ incoming: false,type: 'TRANSFER_OUT' });
          await this.move(tx,actor,row,line,row.destinationWarehouseId!,line.targetLocationId,settings,{ incoming: true,type: 'TRANSFER_IN',cost });
        } else if (row.type==='STOCK_ADJUSTMENT') {
          const incoming = line.adjustmentDirection==='IN',warehouseId = row.sourceWarehouseId ?? row.destinationWarehouseId!;
          await this.move(tx,actor,row,line,warehouseId,row.sourceWarehouseId ? line.sourceLocationId : line.targetLocationId,settings,{ incoming,type: row.type + (incoming ? '_IN' : '_OUT') });
        } else if (row.destinationWarehouseId) await this.move(tx,actor,row,line,row.destinationWarehouseId,line.targetLocationId,settings,{ incoming: true,type: row.type + '_IN' });
        else await this.move(tx,actor,row,line,row.sourceWarehouseId!,line.sourceLocationId,settings,{ incoming: false,type: row.type + '_OUT' });
        await this.applyTracking(tx,actor,row,line,sku,Boolean(origin) || stocktakeLines.has(line.id));
      }
      await tx.inventorySettings.update({ where: { workspaceId: actor.workspaceId },data: { costingLocked: true } });
      const updated = await tx.inventoryDocument.update({ where: { id },data: { status: 'PROCESSED',processedAt: new Date(),processedByUserId: actor.userId,version: { increment: 1 } } });
      await this.history(tx,actor,updated,'INVENTORY_DOCUMENT_PROCESSED',{ lineCount: lines.length });
      if (boundCount) await this.stocktakes!.completeDocument(tx,actor,updated);
      for (const warehouseId of [...new Set([row.sourceWarehouseId,row.destinationWarehouseId].filter((v): v is string => Boolean(v)))])
        for (const inventoryKey of [...new Set(lines.map(line => line.inventoryKey))]) await observeReorder(tx,actor,warehouseId,inventoryKey);
      return { id,status: updated.status,version: updated.version.toString(),processedAt: updated.processedAt?.toISOString() };
    });
  }
  async process(actor: Principal,id: string,raw: unknown,key: string | null) {
    return this.db.$transaction(tx => this.processInTransaction(tx,actor,id,raw,key),{ timeout: 60000 });
  }
  async cancelForShipment(tx: Tx,actor: Principal,id: string) {
    await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:'+id);
    actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
    const row = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_EDIT');
    if (row.type!=='SALES_ORDER' || row.sourceEntityType!=='ORDER' || row.status==='PROCESSED') throw new AppError('INVENTORY_DOCUMENT_NOT_DRAFT','A posted shipment document cannot be cancelled.',409);
    if (row.status==='CANCELLED') return row;
    const updated = await tx.inventoryDocument.update({ where: { id },data: { status: 'CANCELLED',version: { increment: 1 } } });
    await this.history(tx,actor,updated,'INVENTORY_DOCUMENT_CANCELLED',{ reason: 'Shipment cancellation' }); return updated;
  }
  async shipmentPlan(tx: Tx,actor: Principal,id: string) {
    await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:'+id);
    const document = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_READ');
    const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: id },orderBy: { id: 'asc' } });
    return { document,lines: lines.map(({ id,inventoryKey,quantity,reservationId,sourceLocationId }) => ({ id,inventoryKey,quantity: quantity.toFixed(6),reservationId,sourceLocationId })) };
  }
  async reverseInTransaction(tx: Tx,actor: Principal,id: string,raw: unknown,key: string | null) {
    const input = parse(z.strictObject({ expectedVersion: inventoryVersion,reason: z.string().trim().min(1).max(2000) }),raw);
    await lock(tx,actor.workspaceId,'inventory:configuration'); await lock(tx,actor.workspaceId,'inventory:document:' + id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
    const document = await this.document(tx,actor,id,'INVENTORY.DOCUMENT_REVERSE');
    return command(tx,actor,'INVENTORY.DOCUMENT_REVERSE:' + id,key,input,async () => {
      assertInventoryVersion(document.version,input.expectedVersion);
      if (document.status!=='PROCESSED' || document.reversedAt) throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Only an unreversed processed document can be reversed.',409);
      if (document.sourceEntityType && document.sourceEntityId) await this.sources.reversible(tx,actor,{ entityType: document.sourceEntityType,entityId: document.sourceEntityId },document.id);
      const settings = await tx.inventorySettings.findUniqueOrThrow({ where: { workspaceId: actor.workspaceId } });
      const lines = await tx.inventoryDocumentLine.findMany({ where: { workspaceId: actor.workspaceId,documentId: id },orderBy: { lineNumber: 'asc' } });
      await this.stockLocks(tx,actor,document,lines);
      const movements = await tx.inventoryMovement.findMany({ where: { workspaceId: actor.workspaceId,documentId: id,reversesMovementId: null },orderBy: [{ quantityDelta: 'desc' },{ id: 'asc' }] });
      if (!movements.length) throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Original movements are unavailable.',409);
      for (const movement of movements) {
        await this.warehouses.warehouse(tx,actor,movement.warehouseId,'INVENTORY.DOCUMENT_REVERSE',true);
        const line = lines.find(l => l.id===movement.documentLineId)!;
        const delta = numeric24(exact(movement.quantityDelta).neg()),reversalId = randomUUID();
        // Reversal never forces a negative balance, even where ordinary issue policy permits it.
        await this.changeBalance(tx,actor,movement.warehouseId,line,movement.locationId,delta,false);
        await this.costs.reverse(tx,{ workspaceId: actor.workspaceId,warehouseId: movement.warehouseId,inventoryKey: movement.inventoryKey,currency: movement.currency,generation: settings.valuationGeneration },
          settings.costingMethod,movement,reversalId);
        await tx.inventoryMovement.create({ data: { id: reversalId,workspaceId: actor.workspaceId,warehouseId: movement.warehouseId,locationId: movement.locationId,
          productId: movement.productId,variantId: movement.variantId,inventoryKey: movement.inventoryKey,documentId: id,documentLineId: movement.documentLineId,
          sourceType: 'INVENTORY_REVERSAL',sourceId: id,quantityDelta: delta,unitCost: movement.unitCost,totalCost: numeric24(exact(movement.totalCost).neg()),currency: movement.currency,
          type: 'REVERSAL',postingKey: 'REVERSE:' + movement.id,reversesMovementId: movement.id,costingMethod: settings.costingMethod,valuationGeneration: settings.valuationGeneration,occurredAt: new Date() } });
      }
      await this.reverseTracking(tx,actor,document,lines);
      const row = await tx.inventoryDocument.update({ where: { id },data: { reversedAt: new Date(),reversalReason: input.reason,version: { increment: 1 } } });
      await this.history(tx,actor,row,'INVENTORY_DOCUMENT_REVERSED',{ reason: input.reason,movementCount: movements.length });
      for (const movement of movements) await observeReorder(tx,actor,movement.warehouseId,movement.inventoryKey);
      return { id,status: row.status,version: row.version.toString(),reversedAt: row.reversedAt?.toISOString() };
    });
  }
  async reverse(actor: Principal,id: string,raw: unknown,key: string | null) {
    return this.db.$transaction(tx => this.reverseInTransaction(tx,actor,id,raw,key),{ timeout: 60000 });
  }
}
