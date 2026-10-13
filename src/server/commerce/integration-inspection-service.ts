import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { decimal,parse,uuid } from '../process-platform/dto';
import { requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { exact } from '../inventory/decimal';
import { InventoryReservationService } from '../inventory/reservation-service';
import { InventoryDocumentService } from '../inventory/document-service';
import { InventoryStockService } from '../inventory/stock-service';
import { SharedPaymentReadService } from '../commercial/payment-read-service';
import { OrderPaymentCoverage } from '../commercial/order-payment-coverage';
import { CrmReferenceReadService } from '../crm-reference-read-service';
import { CommerceOrderService } from './order-service';

const crmType=z.enum(['CONTACT','COMPANY','DEAL']);
export const inspectionReferences=z.strictObject({crm:z.array(z.strictObject({type:crmType,id:uuid})),payments:z.array(uuid),reservations:z.array(uuid),documents:z.array(uuid),stock:z.array(z.strictObject({warehouseId:uuid,inventoryKey:uuid})),shipments:z.boolean()});
const value=z.string().regex(/^(?:-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?|UNPAID|PARTIALLY_PAID|PAID)$/);
const mismatchCode=z.enum(['CRM_BINDING_MISSING','CRM_SYNC_PENDING','CRM_SYNC_FAILED','CRM_REFERENCE_UNAVAILABLE','RESERVATION_QUANTITY_MISMATCH','RESERVATION_EXPIRED','STOCK_RESERVATION_PENDING','STOCK_RESERVATION_FAILED','STOCK_ON_HAND_MISMATCH','STOCK_RESERVED_MISMATCH','SHIPMENT_WITHOUT_POSTED_SALE','SHIPMENT_SOURCE_MISMATCH','SHIPMENT_QUANTITY_EXCEEDS_ORDER','ORDER_COMPLETION_MISMATCH','PAYMENT_LEDGER_INVALID','PAYMENT_CURRENCY_MISMATCH','PAYMENT_ALLOCATION_EXCEEDS_SETTLED','PAYMENT_UNALLOCATED_FUNDS','PAYMENT_COMMAND_UNCERTAIN','PAYMENT_RECEIPT_FAILED','PAYMENT_RECEIPT_PENDING','ORDER_PAYMENT_PROJECTION_MISMATCH']);
export const inspectionResult=z.strictObject({orderId:uuid,orderVersion:z.string().regex(/^[1-9]\d*$/),observedAt:z.iso.datetime(),consistent:z.boolean(),mismatches:z.array(z.strictObject({code:mismatchCode,entityId:uuid.optional(),lineId:uuid.optional(),expected:value.optional(),actual:value.optional()})),checked:z.strictObject({crmBindings:z.number().int().nonnegative(),paymentBindings:z.number().int().nonnegative(),reservations:z.number().int().nonnegative(),shipments:z.number().int().nonnegative(),stockProjections:z.number().int().nonnegative()}),references:inspectionReferences});
type Reference=z.infer<typeof inspectionReferences>;
type Mismatch=z.infer<typeof inspectionResult>['mismatches'][number];
const linesDto=z.array(z.object({itemId:uuid,quantity:decimal,inventoryKey:uuid.optional(),stockable:z.boolean().default(false)})).refine(a=>new Set(a.map(l=>l.itemId)).size===a.length);

/** Read-only cross-domain inspection. Every private reference is checked through its owning service. */
export class CommerceIntegrationInspectionService {
  readonly reservations:InventoryReservationService;readonly documents:InventoryDocumentService;readonly stock:InventoryStockService;
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly payments=new SharedPaymentReadService(),readonly crm=new CrmReferenceReadService()){
    this.reservations=new InventoryReservationService(db);this.documents=new InventoryDocumentService(db);this.stock=new InventoryStockService(db);
  }
  async authorizeReferences(tx:Tx,actor:Principal,orderId:string,refs:Reference){
    if(refs.shipments)await this.orders.load(tx,actor,orderId,'COMMERCE.SHIPMENT_VIEW');
    for(const r of refs.crm)await this.crm.inspect(tx,actor,r.type,r.id);
    for(const id of refs.payments)await this.payments.authorizeReference(tx,actor,id);
    for(const id of refs.reservations)await this.reservations.inspectOrderReservation(tx,actor,id,orderId);
    for(const id of refs.documents)await this.documents.document(tx,actor,id,'INVENTORY.DOCUMENT_READ');
    for(const r of refs.stock){requirePermission(actor,'INVENTORY.MOVEMENT_READ');await this.stock.warehouses.warehouse(tx,actor,r.warehouseId,'INVENTORY.STOCK_READ');await this.stock.warehouses.warehouse(tx,actor,r.warehouseId,'INVENTORY.MOVEMENT_READ');}
  }
  private async crmBindings(tx:Tx,actor:Principal,orderId:string){
    const bindings=await tx.commerceCrmBinding.findMany({where:{workspaceId:actor.workspaceId,orderId},orderBy:{entityType:'asc'}});
    const projected=[];
    for(const row of bindings){if(row.targetId)await this.crm.inspect(tx,actor,parse(crmType,row.entityType),row.targetId);projected.push({id:row.id,type:row.entityType,targetId:row.targetId,policy:row.linkPolicy,status:row.status,errorCode:row.lastErrorCode,version:row.version.toString()});}
    return projected;
  }
  private async reservationProjection(tx:Tx,actor:Principal,orderId:string){
    requirePermission(actor,'INVENTORY.RESERVATION_READ');
    const rows=await tx.inventoryReservation.findMany({where:{workspaceId:actor.workspaceId,sourceType:'ORDER',sourceId:orderId},orderBy:{id:'asc'}});
    const projected=[];
    for(const r of rows){await this.reservations.inspectOrderReservation(tx,actor,r.id,orderId);projected.push({id:r.id,inventoryKey:r.inventoryKey,warehouseId:r.warehouseId,status:r.status,quantity:r.quantity.toFixed(6),fulfilledQuantity:r.fulfilledQuantity.toFixed(6),releasedQuantity:r.releasedQuantity.toFixed(6),expiresAt:r.expiresAt.toISOString()});}
    return projected;
  }
  async integrations(actor:Principal,orderId:string){
    parse(uuid,orderId);return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const order=await this.orders.load(tx,actor,orderId,'COMMERCE.ORDER_VIEW'),store=await tx.commerceStore.findFirstOrThrow({where:{workspaceId:actor.workspaceId,id:order.storeId}});
      const redact=async<T>(read:()=>Promise<T>)=>{try{return{status:'VISIBLE',data:await read()};}catch(error){if(isAppError(error)&&[403,404].includes(error.status))return{status:'REDACTED',data:null};throw error;}};
      const sync=await tx.commerceCrmSync.findUnique({where:{workspaceId_orderId:{workspaceId:actor.workspaceId,orderId}}});
      const reservationJob=await tx.commercePaidReservationJob.findUnique({where:{workspaceId_orderId:{workspaceId:actor.workspaceId,orderId}}});
      return{orderId,crm:await redact(()=>this.crmBindings(tx,actor,orderId)),crmSync:sync?{id:sync.id,status:sync.status,dealPolicy:sync.dealPolicy,attemptCount:sync.attempts,errorCode:sync.errorCode,customerWasNew:sync.customerWasNew,dealCreated:sync.dealCreated}:null,reservationJob:reservationJob?{id:reservationJob.id,status:reservationJob.status,policy:reservationJob.policy,correlationId:reservationJob.correlationId,attemptCount:reservationJob.attempts,errorCode:reservationJob.errorCode}:null,reservations:await redact(()=>this.reservationProjection(tx,actor,orderId)),automation:{dealCreationPolicy:store.dealCreationPolicy,reservationTiming:store.reservationTiming,abandonedAfterMinutes:store.abandonedAfterMinutes}};
    },{timeout:60000});
  }
  async inspect(tx:Tx,actor:Principal,orderId:string){
    const order=await this.orders.load(tx,actor,orderId,'COMMERCE.ORDER_MANAGE'),store=await tx.commerceStore.findFirstOrThrow({where:{workspaceId:actor.workspaceId,id:order.storeId}});
    const refs:Reference={crm:[],payments:[],reservations:[],documents:[],stock:[],shipments:false},mismatches:Mismatch[]=[];
    const lines=parse(linesDto,(order.snapshot as {lines?:unknown}).lines??[]);
    const crm=await this.crmBindings(tx,actor,orderId);
    const sync=await tx.commerceCrmSync.findUnique({where:{workspaceId_orderId:{workspaceId:actor.workspaceId,orderId}}});
    const reservationJob=await tx.commercePaidReservationJob.findUnique({where:{workspaceId_orderId:{workspaceId:actor.workspaceId,orderId}}});
    if(reservationJob&&['QUEUED','RUNNING','FAILED'].includes(reservationJob.status))mismatches.push({code:reservationJob.status==='FAILED'?'STOCK_RESERVATION_FAILED':'STOCK_RESERVATION_PENDING',entityId:reservationJob.id});
    if((sync?.dealPolicy??store.dealCreationPolicy)==='ALWAYS'&&!crm.some(b=>b.type==='DEAL'&&b.status==='LINKED'))mismatches.push({code:'CRM_BINDING_MISSING'});
    if(sync&&sync.status!=='SUCCEEDED')mismatches.push({code:sync.status==='FAILED'?'CRM_SYNC_FAILED':'CRM_SYNC_PENDING',entityId:sync.id});
    for(const b of crm){if(b.targetId){const type=parse(crmType,b.type);refs.crm.push({type,id:b.targetId});if(!(await this.crm.inspect(tx,actor,type,b.targetId)).available)mismatches.push({code:'CRM_REFERENCE_UNAVAILABLE',entityId:b.id});}
      if(b.status==='PENDING'||b.status==='FAILED')mismatches.push({code:b.status==='PENDING'?'CRM_SYNC_PENDING':'CRM_SYNC_FAILED',entityId:b.id});}
    const bindings=await tx.commerceOrderPaymentBinding.findMany({where:{workspaceId:actor.workspaceId,orderId},orderBy:{id:'asc'}});
    for(const b of bindings){refs.payments.push(b.paymentId);try{
      const p=await this.payments.reconcileProjection(tx,actor,b.paymentId);
      if(p.payment.currency!==order.currency)mismatches.push({code:'PAYMENT_CURRENCY_MISMATCH',entityId:b.paymentId});
      if(exact(p.unallocatedAmount).lt(0))mismatches.push({code:'PAYMENT_ALLOCATION_EXCEEDS_SETTLED',entityId:b.paymentId});
      else if(exact(p.unallocatedAmount).gt(0))mismatches.push({code:'PAYMENT_UNALLOCATED_FUNDS',entityId:b.paymentId,actual:p.unallocatedAmount});
      if(p.payment.commands.some(c=>c.uncertain))mismatches.push({code:'PAYMENT_COMMAND_UNCERTAIN',entityId:b.paymentId});
      for(const r of p.receipts)if(r.status==='FAILED'||r.status==='QUEUED')mismatches.push({code:r.status==='FAILED'?'PAYMENT_RECEIPT_FAILED':'PAYMENT_RECEIPT_PENDING',entityId:b.paymentId});
    }catch(error){if(!isAppError(error)||![400,409,422].includes(error.status))throw error;mismatches.push({code:'PAYMENT_LEDGER_INVALID',entityId:b.paymentId});}}
    let paid:string|null=null;
    try{paid=await new OrderPaymentCoverage().paid(tx,actor,orderId,order.currency);if(!order.paidAmount.eq(paid))mismatches.push({code:'ORDER_PAYMENT_PROJECTION_MISMATCH',expected:paid,actual:order.paidAmount.toFixed(6)});
      const status=exact(paid).eq(order.total)?'PAID':exact(paid).gt(0)?'PARTIALLY_PAID':'UNPAID';if(status!==order.paymentStatus)mismatches.push({code:'ORDER_PAYMENT_PROJECTION_MISMATCH',expected:status,actual:order.paymentStatus});
    }catch(error){if(!isAppError(error)||error.status!==409)throw error;mismatches.push({code:'PAYMENT_LEDGER_INVALID'});}
    const reservationRows=await tx.inventoryReservation.findMany({where:{workspaceId:actor.workspaceId,sourceType:'ORDER',sourceId:orderId}});
    const reservations=reservationRows.length?await this.reservationProjection(tx,actor,orderId):[];refs.reservations=reservations.map(r=>r.id);
    const warehouseIds=new Set(reservations.map(r=>r.warehouseId));
    for(const allocation of await tx.inventoryReservationAllocation.findMany({where:{workspaceId:actor.workspaceId,reservationId:{in:refs.reservations}}}))warehouseIds.add(allocation.warehouseId);
    for(const r of reservations)if(['ACTIVE','PARTIALLY_FULFILLED'].includes(r.status)&&new Date(r.expiresAt)<=new Date())mismatches.push({code:'RESERVATION_EXPIRED',entityId:r.id});
    const stockKeys=[...new Set(lines.filter(l=>l.stockable&&l.inventoryKey).map(l=>l.inventoryKey!))];
    for(const key of stockKeys){const matching=reservations.filter(r=>r.inventoryKey===key),planned=lines.filter(l=>l.stockable&&l.inventoryKey===key).reduce((s,l)=>s.plus(l.quantity),exact(0));
      const fulfilled=matching.reduce((s,r)=>s.plus(r.fulfilledQuantity),exact(0)),held=matching.filter(r=>['ACTIVE','PARTIALLY_FULFILLED'].includes(r.status)).reduce((s,r)=>s.plus(exact(r.quantity).minus(r.fulfilledQuantity).minus(r.releasedQuantity)),exact(0));
      const expected=order.status==='CANCELLED'?exact(0):planned.minus(fulfilled);
      if((reservationJob?reservationJob.status==='SUCCEEDED':store.reservationTiming==='ORDER_PLACED')&&!held.eq(expected))mismatches.push({code:'RESERVATION_QUANTITY_MISMATCH',entityId:key,expected:expected.toFixed(6),actual:held.toFixed(6)});
    }
    const shipments=await tx.commerceShipment.findMany({where:{workspaceId:actor.workspaceId,orderId},orderBy:{id:'asc'}});
    if(shipments.length){refs.shipments=true;await this.orders.load(tx,actor,orderId,'COMMERCE.SHIPMENT_VIEW');}
    for(const s of shipments){warehouseIds.add(s.warehouseId);if(s.inventoryDocumentId){refs.documents.push(s.inventoryDocumentId);const doc=await this.documents.document(tx,actor,s.inventoryDocumentId,'INVENTORY.DOCUMENT_READ');
      if(doc.type!=='SALES_ORDER'||doc.sourceEntityType!=='ORDER'||doc.sourceEntityId!==orderId)mismatches.push({code:'SHIPMENT_SOURCE_MISMATCH',entityId:s.id});
      if(s.shippedAt&&doc.status!=='PROCESSED')mismatches.push({code:'SHIPMENT_WITHOUT_POSTED_SALE',entityId:s.id});
    }else if(s.shippedAt&&await tx.commerceShipmentStockBinding.count({where:{workspaceId:actor.workspaceId,shipmentId:s.id}}))mismatches.push({code:'SHIPMENT_WITHOUT_POSTED_SALE',entityId:s.id});}
    const items=await tx.commerceShipmentItem.findMany({where:{workspaceId:actor.workspaceId,orderId,shipmentId:{in:shipments.filter(s=>s.status!=='CANCELLED').map(s=>s.id)}}});
    for(const line of lines){const allocated=items.filter(i=>i.orderLineId===line.itemId).reduce((s,i)=>s.plus(i.quantity),exact(0));if(allocated.gt(line.quantity))mismatches.push({code:'SHIPMENT_QUANTITY_EXCEEDS_ORDER',lineId:line.itemId,expected:exact(line.quantity).toFixed(6),actual:allocated.toFixed(6)});}
    const deliveredIds=new Set(shipments.filter(s=>s.status==='DELIVERED').map(s=>s.id));
    const fulfilled=Boolean(lines.length&&lines.every(l=>items.filter(i=>deliveredIds.has(i.shipmentId)&&i.orderLineId===l.itemId).reduce((s,i)=>s.plus(i.quantity),exact(0)).eq(l.quantity)));
    if(order.status==='COMPLETED'&&(!fulfilled||paid===null||exact(paid).lt(order.total)))mismatches.push({code:'ORDER_COMPLETION_MISMATCH'});
    if(stockKeys.length&&store.defaultWarehouseId)warehouseIds.add(store.defaultWarehouseId);
    const stock=stockKeys.length&&warehouseIds.size?await this.stock.reconcileProjection(tx,actor,[...warehouseIds],stockKeys):[];
    for(const warehouseId of warehouseIds)for(const inventoryKey of stockKeys)refs.stock.push({warehouseId,inventoryKey});
    for(const r of stock){if(!exact(r.onHand).eq(r.ledgerOnHand))mismatches.push({code:'STOCK_ON_HAND_MISMATCH',entityId:r.inventoryKey,expected:r.ledgerOnHand,actual:r.onHand});if(!exact(r.reserved).eq(r.ledgerReserved))mismatches.push({code:'STOCK_RESERVED_MISMATCH',entityId:r.inventoryKey,expected:r.ledgerReserved,actual:r.reserved});}
    return parse(inspectionResult,{orderId,orderVersion:order.version.toString(),observedAt:new Date().toISOString(),consistent:mismatches.length===0,mismatches,checked:{crmBindings:crm.length,paymentBindings:bindings.length,reservations:reservations.length,shipments:shipments.length,stockProjections:stock.length},references:refs});
  }
}
