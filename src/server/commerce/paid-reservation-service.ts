import { type PrismaClient,type CommerceOrder,type CommerceStore } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { lock,evidence,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { OrderPaymentCoverage } from '../commercial/order-payment-coverage';
import { InventoryReservationService } from '../inventory/reservation-service';
import { exact } from '../inventory/decimal';
import { commerceOrderRead } from './order-authority';

const linesDto=z.array(z.object({itemId:uuid,productId:uuid,variantId:uuid.nullable(),inventoryKey:uuid,quantity:z.string(),stockable:z.boolean()})).max(100).refine(rows=>new Set(rows.map(r=>r.itemId)).size===rows.length);
/** Persist intent before payment. The Store timing is pinned and never read back to reinterpret an Order. */
export async function preparePaidReservations(tx:Tx,order:CommerceOrder,store:CommerceStore){
  if(store.reservationTiming!=='PAYMENT_PAID')return;
  return tx.commercePaidReservationJob.create({data:{workspaceId:order.workspaceId,storeId:order.storeId,orderId:order.id,status:order.total.eq(0)?'QUEUED':'WAITING'}});
}
/** Called only after shared Payments calculates authoritative net settled coverage. */
export async function queuePaidReservations(tx:Tx,actor:Principal,order:CommerceOrder,paid:string){
  if(['CANCELLED','COMPLETED','ARCHIVED'].includes(order.status)||order.archivedAt||exact(paid).lt(order.total))return;
  const job=await tx.commercePaidReservationJob.findUnique({where:{workspaceId_orderId:{workspaceId:actor.workspaceId,orderId:order.id}}});
  if(!job||job.status!=='WAITING')return;
  await tx.commercePaidReservationJob.update({where:{id:job.id},data:{status:'QUEUED',nextAttemptAt:new Date(),version:{increment:1}}});
  await evidence(tx,actor,'COMMERCE_ORDER',order.id,'ORDER_STOCK_RESERVATION_QUEUED',{jobId:job.id,correlationId:job.correlationId,policy:job.policy});
}

/** Entire Inventory effect commits under a fenced database lease; provider settlement is independent. */
export class CommercePaidReservationService {
  constructor(private readonly db:PrismaClient,readonly inventory=new InventoryReservationService(db),readonly payments=new OrderPaymentCoverage()){}
  private async claim(id:string){
    const found=await this.db.commercePaidReservationJob.findUnique({where:{id}});if(!found)return null;
    return this.db.$transaction(async tx=>{
      await lock(tx,found.workspaceId,'commerce:paid-reservation:'+id);const row=await tx.commercePaidReservationJob.findUniqueOrThrow({where:{id}}),now=new Date();
      if(row.status==='QUEUED'?row.nextAttemptAt>now:row.status!=='RUNNING'||row.leaseExpiresAt!>now)return null;
      if(row.attempts>=5){await tx.commercePaidReservationJob.update({where:{id},data:{status:'FAILED',claimToken:null,leaseExpiresAt:null,errorCode:'COMMERCE_STOCK_RESERVATION_FAILED',completedAt:now,version:{increment:1}}});return null;}
      const token=randomUUID();await tx.commercePaidReservationJob.update({where:{id},data:{status:'RUNNING',claimToken:token,leaseExpiresAt:new Date(Date.now()+60000),attempts:{increment:1},errorCode:null,version:{increment:1}}});return{row,token};
    },{timeout:60000});
  }
  async process(id:string){
    const claim=await this.claim(id);if(!claim)return false;
    try{return await this.db.$transaction(async tx=>{
      await lock(tx,claim.row.workspaceId,'commerce:configuration');await lock(tx,claim.row.workspaceId,'commerce:order:'+claim.row.orderId);await lock(tx,claim.row.workspaceId,'commerce:paid-reservation:'+id);
      const job=await tx.commercePaidReservationJob.findUniqueOrThrow({where:{id}});if(job.status!=='RUNNING'||job.claimToken!==claim.token)return false;
      const store=await tx.commerceStore.findFirstOrThrow({where:{workspaceId:job.workspaceId,id:job.storeId}}),userId=(store.settings as {inventoryPrincipalUserId?:string}).inventoryPrincipalUserId;
      if(!userId)throw new AppError('COMMERCE_STOCK_RESERVATION_FAILED','Inventory service principal is unavailable.',409);
      const actor=await resolvePrincipal(tx,job.workspaceId,userId);requirePermission(actor,'INVENTORY.RESERVATION_CREATE');
      const order=await commerceOrderRead(tx,actor,job.orderId);
      if(order.archivedAt||['CANCELLED','COMPLETED','ARCHIVED'].includes(order.status))throw new AppError('RESERVATION_SOURCE_INVALID','Order is closed.',409);
      if(exact(await this.payments.paid(tx,actor,order.id,order.currency)).lt(order.total)){
        await tx.commercePaidReservationJob.update({where:{id},data:{status:'WAITING',claimToken:null,leaseExpiresAt:null,version:{increment:1}}});return false;
      }
      const lines=parse(linesDto,(order.snapshot as {lines?:unknown}).lines??[]).filter(l=>l.stockable).sort((a,b)=>a.inventoryKey.localeCompare(b.inventoryKey)||a.itemId.localeCompare(b.itemId));
      for(const line of lines){
        const existing=await tx.commerceOrderLineReservation.count({where:{workspaceId:job.workspaceId,orderId:order.id,orderLineId:line.itemId}});
        if(existing)throw new AppError('COMMERCE_STOCK_RESERVATION_FAILED','Existing line reservations require reconciliation.',409);
        const reservation=await this.inventory.createInTransaction(tx,actor,{sourceType:'ORDER',sourceId:order.id,productId:line.productId,variantId:line.variantId??undefined,quantity:line.quantity,warehouseId:store.defaultWarehouseId??undefined},'paid-reservation:'+id+':'+line.itemId);
        await tx.commerceOrderLineReservation.create({data:{workspaceId:job.workspaceId,storeId:job.storeId,orderId:order.id,orderLineId:line.itemId,reservationId:reservation.id,inventoryKey:line.inventoryKey,quantity:line.quantity}});
      }
      await tx.commercePaidReservationJob.update({where:{id},data:{status:'SUCCEEDED',claimToken:null,leaseExpiresAt:null,completedAt:new Date(),version:{increment:1}}});
      await tx.commerceOrderHistory.create({data:{workspaceId:job.workspaceId,storeId:job.storeId,orderId:job.orderId,actorUserId:actor.userId,action:'STOCK_RESERVED',details:{jobId:id,policy:job.policy,lineCount:lines.length}}});
      await evidence(tx,actor,'COMMERCE_ORDER',order.id,'ORDER_STOCK_RESERVED',{jobId:id,correlationId:job.correlationId,lineCount:lines.length});return true;
    },{timeout:60000});}
    catch(error){await this.db.$transaction(async tx=>{
      await lock(tx,claim.row.workspaceId,'commerce:paid-reservation:'+id);const job=await tx.commercePaidReservationJob.findUniqueOrThrow({where:{id}});if(job.status!=='RUNNING'||job.claimToken!==claim.token)return;
      const failed=job.attempts>=5,errorCode=isAppError(error)&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)?error.code:'COMMERCE_STOCK_RESERVATION_FAILED';
      await tx.commercePaidReservationJob.update({where:{id},data:{status:failed?'FAILED':'QUEUED',claimToken:null,leaseExpiresAt:null,errorCode,completedAt:failed?new Date():null,nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**job.attempts)),version:{increment:1}}});
      await tx.commerceOrderHistory.create({data:{workspaceId:job.workspaceId,storeId:job.storeId,orderId:job.orderId,action:failed?'STOCK_RESERVATION_FAILED':'STOCK_RESERVATION_RETRY',details:{jobId:id,errorCode,attemptCount:job.attempts}}});
    },{timeout:60000});return false;}
  }
  async tick(limit=10){const now=new Date(),rows=await this.db.commercePaidReservationJob.findMany({where:{OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},{status:'RUNNING',leaseExpiresAt:{lte:now}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit});let processed=0;for(const row of rows)if(await this.process(row.id))processed++;return{processed};}
}
