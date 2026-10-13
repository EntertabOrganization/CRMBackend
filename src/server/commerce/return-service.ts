import { Prisma,type PrismaClient,type CommerceReturn } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { canonical,parse,uuid,pageQuery } from '../process-platform/dto';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { CommerceOrderService } from './order-service';
import { commerceVersion,assertCommerceVersion } from './dto';
import { cartQuantity } from './cart-service';
import { exact } from '../inventory/decimal';

import { commerceReturnPolicy } from './return-policy';
import { InventoryCommerceReturnPort,type ReturnPostingPlan } from '../inventory/commerce-return-port';
const item=z.strictObject({orderLineId:uuid,quantity:cartQuantity});
const items=z.array(item).min(1).max(100).refine(v=>new Set(v.map(i=>i.orderLineId)).size===v.length);
const states=z.enum(['REQUESTED','APPROVED','REJECTED','IN_TRANSIT','RECEIVED','INSPECTING','COMPLETED','CANCELLED']);
/** Return intake owns merchandise claims only. Receipt cannot create stock or money. */
export class CommerceReturnService {
  readonly inventory:InventoryCommerceReturnPort;
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db)){this.inventory=new InventoryCommerceReturnPort(db);}
  async load(tx:Tx,actor:Principal,id:string,permission:string){
    parse(uuid,id);requirePermission(actor,permission);
    const row=await tx.commerceReturn.findFirst({where:{workspaceId:actor.workspaceId,id}});
    if(!row)throw new AppError('RETURN_NOT_FOUND','Return was not found.',404);
    await this.orders.load(tx,actor,row.orderId,permission);return row;
  }
  private async projection(tx:Tx,row:CommerceReturn){
    const lines=await tx.commerceReturnLine.findMany({where:{workspaceId:row.workspaceId,returnId:row.id},orderBy:{id:'asc'}});
    return{id:row.id,orderId:row.orderId,storeId:row.storeId,status:row.status,reason:row.reason,policy:row.policySnapshot,version:row.version.toString(),receivedAt:row.receivedAt,createdAt:row.createdAt,lines:lines.map(l=>({id:l.id,orderLineId:l.orderLineId,quantity:l.quantity.toFixed(6),receivedQuantity:l.receivedQuantity.toFixed(6),disposition:l.disposition,inventoryDocumentLineId:l.inventoryDocumentLineId}))};
  }
  private async event(tx:Tx,actor:Principal,row:CommerceReturn,action:string,details:Prisma.InputJsonObject={}){
    await tx.commerceReturnEvent.create({data:{workspaceId:actor.workspaceId,returnId:row.id,actorUserId:actor.userId,action,details}});
    await evidence(tx,actor,'COMMERCE_RETURN',row.id,action,{orderId:row.orderId,version:row.version.toString(),...details});
  }
  private async command<T>(tx:Tx,actor:Principal,operation:string,key:string|null,input:unknown,effect:()=>Promise<T>):Promise<T>{
    if(!key||key.length<8||key.length>128)throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    const identity={workspaceId:actor.workspaceId,actorUserId:actor.userId,operation,key},requestHash=createHash('sha256').update(canonical(input)).digest('hex');
    await lock(tx,actor.workspaceId,'commerce:return-command:'+actor.userId+':'+operation+':'+key);
    const prior=await tx.commerceReturnCommand.findUnique({where:{workspaceId_actorUserId_operation_key:identity}});
    if(prior){if(prior.requestHash!==requestHash)throw new AppError('IDEMPOTENCY_KEY_REUSED','Key was used with another return request.',409);return prior.response as T;}
    const result=await effect(),response=JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
    await tx.commerceReturnCommand.create({data:{...identity,requestHash,response}});return response as T;
  }
  async create(actor:Principal,orderId:string,raw:unknown,key:string|null){
    parse(uuid,orderId);const input=parse(z.strictObject({items,reason:z.string().trim().min(1).max(2000)}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');await lock(tx,actor.workspaceId,'commerce:order:'+orderId);actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const order=await this.orders.load(tx,actor,orderId,'COMMERCE.RETURN_CREATE');
      return this.command(tx,actor,'CREATE:'+orderId,key,input,async()=>{
        const store=await this.orders.stores.store(tx,actor,order.storeId,'COMMERCE.RETURN_CREATE'),policy=parse(commerceReturnPolicy,(store.settings as {returnPolicy?:unknown}).returnPolicy??{});
        if(!policy.enabled||order.status==='CANCELLED')throw new AppError('RETURN_NOT_ELIGIBLE','Order is not eligible for a Return.',409);
        const snapshot=z.object({lines:z.array(z.object({itemId:uuid,stockable:z.boolean(),quantity:cartQuantity}))}).safeParse(order.snapshot);
        if(!snapshot.success)throw new AppError('RETURN_NOT_ELIGIBLE','Historical Order lines are unavailable.',409);
        const deliveries=await tx.commerceShipment.findMany({where:{workspaceId:actor.workspaceId,orderId,deliveredAt:{not:null}},select:{id:true,deliveredAt:true}});
        const delivered=await tx.commerceShipmentItem.findMany({where:{workspaceId:actor.workspaceId,orderId,shipmentId:{in:deliveries.map(s=>s.id)}}});
        for(const requested of input.items){
          if(!snapshot.data.lines.some(l=>l.itemId===requested.orderLineId&&l.stockable))throw new AppError('RETURN_NOT_ELIGIBLE','Line is not returnable physical merchandise.',422);
          const eligible=delivered.filter(l=>l.orderLineId===requested.orderLineId&&deliveries.some(s=>s.id===l.shipmentId&&s.deliveredAt&&s.deliveredAt.getTime()+policy.windowDays*86400000>=Date.now())).reduce((sum,l)=>sum.plus(l.quantity),exact(0));
          const claims=await tx.commerceReturnLine.findMany({where:{workspaceId:actor.workspaceId,orderId,orderLineId:requested.orderLineId,returnId:{in:(await tx.commerceReturn.findMany({where:{workspaceId:actor.workspaceId,orderId,status:{notIn:['REJECTED','CANCELLED']}},select:{id:true}})).map(r=>r.id)}}});
          if(exact(requested.quantity).plus(claims.reduce((sum,l)=>sum.plus(l.quantity),exact(0))).gt(eligible))throw new AppError('RETURN_QUANTITY_EXCEEDED','Quantity exceeds delivered unreturned merchandise within the return window.',409);
        }
        const row=await tx.commerceReturn.create({data:{workspaceId:actor.workspaceId,storeId:order.storeId,orderId,reason:input.reason,policySnapshot:policy,requestedByUserId:actor.userId}});
        await tx.commerceReturnLine.createMany({data:input.items.map(i=>({workspaceId:actor.workspaceId,storeId:order.storeId,orderId,returnId:row.id,...i}))});
        await this.event(tx,actor,row,'RETURN_REQUESTED',{lineCount:input.items.length});return this.projection(tx,row);
      });
    },{timeout:60000});
  }
  async list(actor:Principal,raw:unknown){
    const query=parse(pageQuery.omit({search:true}).extend({storeId:uuid.optional(),status:states.optional()}),raw);
    return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);requirePermission(actor,'COMMERCE.RETURN_VIEW');
      const stores=await tx.commerceStore.findMany({where:{workspaceId:actor.workspaceId,id:query.storeId}}),ids:string[]=[];
      for(const store of stores)try{await this.orders.stores.store(tx,actor,store.id,'COMMERCE.RETURN_VIEW');ids.push(store.id);}catch(error){if(!(error instanceof AppError)||![403,404].includes(error.status))throw error;}
      const where={workspaceId:actor.workspaceId,storeId:{in:ids},status:query.status};
      const [rows,total]=await Promise.all([tx.commerceReturn.findMany({where,orderBy:[{createdAt:'desc'},{id:'asc'}],skip:(query.page-1)*query.limit,take:query.limit}),tx.commerceReturn.count({where})]);
      return{data:await Promise.all(rows.map(row=>this.projection(tx,row))),meta:{page:query.page,limit:query.limit,total,totalPages:Math.ceil(total/query.limit)}};
    });
  }
  async get(actor:Principal,id:string){
    return this.db.$transaction(async tx=>{actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const row=await this.load(tx,actor,id,'COMMERCE.RETURN_VIEW');return{...await this.projection(tx,row),history:await tx.commerceReturnEvent.findMany({where:{workspaceId:actor.workspaceId,returnId:id},select:{id:true,action:true,details:true,occurredAt:true},orderBy:[{occurredAt:'asc'},{id:'asc'}]})};});
  }
  async approve(actor:Principal,id:string,raw:unknown){
    const input=parse(z.strictObject({expectedVersion:commerceVersion,decision:z.enum(['APPROVE','REJECT']),reason:z.string().trim().min(1).max(2000).optional()}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const initial=await this.load(tx,actor,id,'COMMERCE.RETURN_APPROVE');await lock(tx,actor.workspaceId,'commerce:order:'+initial.orderId);
      const row=await this.load(tx,actor,id,'COMMERCE.RETURN_APPROVE');assertCommerceVersion(row.version,input.expectedVersion);
      if(row.status!=='REQUESTED')throw new AppError('RETURN_INVALID_TRANSITION','Only requested Returns may be approved or rejected.',409);
      const updated=await tx.commerceReturn.update({where:{id},data:{status:input.decision==='APPROVE'?'APPROVED':'REJECTED',approvedByUserId:actor.userId,version:{increment:1}}});
      await this.event(tx,actor,updated,input.decision==='APPROVE'?'RETURN_APPROVED':'RETURN_REJECTED',{reason:input.reason??null});return this.projection(tx,updated);
    },{timeout:60000});
  }
  async receive(actor:Principal,id:string,raw:unknown,key:string|null){
    const input=parse(z.strictObject({receivedLines:items}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const initial=await this.load(tx,actor,id,'COMMERCE.RETURN_RECEIVE');await lock(tx,actor.workspaceId,'commerce:order:'+initial.orderId);
      const row=await this.load(tx,actor,id,'COMMERCE.RETURN_RECEIVE');
      return this.command(tx,actor,'RECEIVE:'+id,key,input,async()=>{
        if(!['APPROVED','IN_TRANSIT','RECEIVED'].includes(row.status))throw new AppError('RETURN_INVALID_TRANSITION','Return must be approved before receipt.',409);
        const lines=await tx.commerceReturnLine.findMany({where:{workspaceId:actor.workspaceId,returnId:id}});
        for(const requested of input.receivedLines){const line=lines.find(l=>l.orderLineId===requested.orderLineId);if(!line||line.receivedQuantity.plus(requested.quantity).gt(line.quantity))throw new AppError('RETURN_QUANTITY_EXCEEDED','Receipt exceeds the approved return quantity.',409);}
        for(const received of input.receivedLines){const line=lines.find(l=>l.orderLineId===received.orderLineId)!;await tx.commerceReturnLine.update({where:{id:line.id},data:{receivedQuantity:{increment:received.quantity}}});}
        const updated=await tx.commerceReturn.update({where:{id},data:{status:'RECEIVED',receivedAt:new Date(),version:{increment:1}}});
        await this.event(tx,actor,updated,'RETURN_RECEIVED',{receivedLines:input.receivedLines});return this.projection(tx,updated);
      });
    },{timeout:60000});
  }
  async inspect(actor:Principal,id:string,raw:unknown,key:string|null){
    const input=parse(z.strictObject({dispositions:z.array(z.strictObject({orderLineId:uuid,disposition:z.enum(['SELLABLE','DAMAGED','REPAIR','REJECT']),warehouseId:uuid.optional()})).min(1).max(100).refine(v=>new Set(v.map(i=>i.orderLineId)).size===v.length)}),raw);
    const hash=createHash('sha256').update(canonical(input)).digest('hex');
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const initial=await this.load(tx,actor,id,'COMMERCE.RETURN_INSPECT');await lock(tx,actor.workspaceId,'commerce:order:'+initial.orderId);
      const row=await this.load(tx,actor,id,'COMMERCE.RETURN_INSPECT'),order=await this.orders.load(tx,actor,row.orderId,'COMMERCE.RETURN_INSPECT');
      return this.command(tx,actor,'INSPECT:'+id,key,input,async()=>{
        if(!['RECEIVED','INSPECTING'].includes(row.status))throw new AppError('RETURN_INVALID_TRANSITION','Receive merchandise before inspection.',409);
        const lines=await tx.commerceReturnLine.findMany({where:{workspaceId:actor.workspaceId,returnId:id}});
        if(lines.length!==input.dispositions.length||lines.some(l=>!l.receivedQuantity.eq(l.quantity)||!input.dispositions.some(d=>d.orderLineId===l.orderLineId)))throw new AppError('RETURN_INVALID_TRANSITION','All approved quantities require receipt and disposition.',409);
        const store=await this.orders.stores.store(tx,actor,order.storeId,'COMMERCE.RETURN_INSPECT'),userId=(store.settings as {inventoryPrincipalUserId?:string}).inventoryPrincipalUserId;
        const inventoryActor=userId?await resolvePrincipal(tx,actor.workspaceId,userId):null;
        if(input.dispositions.some(d=>d.disposition!=='REJECT')&&!inventoryActor)throw new AppError('RETURN_NOT_ELIGIBLE','Inventory service principal is unavailable.',409);
        await lock(tx,actor.workspaceId,'inventory:configuration');
        let plan=row.inspectionPlan as {hash:string;postings:{returnLineId:string;plan:ReturnPostingPlan}[]}|null;
        if(plan&&plan.hash!==hash)throw new AppError('RETURN_INVALID_TRANSITION','Inspection dispositions are already pinned.',409);
        if(!plan){
          plan={hash,postings:[]};
          const snapshot=parse(z.object({lines:z.array(z.object({itemId:uuid,productId:uuid,variantId:uuid.nullable()}))}),order.snapshot);
          for(const disposition of input.dispositions){
            const line=lines.find(l=>l.orderLineId===disposition.orderLineId)!,source=snapshot.lines.find(l=>l.itemId===line.orderLineId);
            if(!source)throw new AppError('RETURN_NOT_ELIGIBLE','Historical product is unavailable.',409);
            if(disposition.disposition==='REJECT'){if(disposition.warehouseId)throw new AppError('INVALID_ARGUMENT','Rejected merchandise cannot create warehouse stock.',400);await tx.commerceReturnLine.update({where:{id:line.id},data:{disposition:'REJECT'}});continue;}
            if(!disposition.warehouseId)throw new AppError('INVALID_ARGUMENT','Disposition requires its target Warehouse.',400);
            const deliveredIds=(await tx.commerceShipment.findMany({where:{workspaceId:actor.workspaceId,orderId:order.id,deliveredAt:{not:null}},select:{id:true}})).map(s=>s.id);
            const itemIds=(await tx.commerceShipmentItem.findMany({where:{workspaceId:actor.workspaceId,orderId:order.id,orderLineId:line.orderLineId,shipmentId:{in:deliveredIds}},select:{id:true}})).map(i=>i.id);
            const sourceLineIds=(await tx.commerceShipmentStockBinding.findMany({where:{workspaceId:actor.workspaceId,itemId:{in:itemIds}},select:{inventoryDocumentLineId:true}})).map(b=>b.inventoryDocumentLineId).filter((v):v is string=>!!v);
            const posting=await this.inventory.prepare(tx,inventoryActor!,{orderId:order.id,productId:source.productId,variantId:source.variantId,sourceLineIds,quantity:line.receivedQuantity.toFixed(6),warehouseId:disposition.warehouseId,currency:order.currency,disposition:disposition.disposition});
            plan.postings.push({returnLineId:line.id,plan:posting});
            await tx.commerceReturnLine.update({where:{id:line.id},data:{disposition:disposition.disposition,inventoryDocumentLineId:posting.lineId}});
          }
          await tx.commerceReturn.update({where:{id},data:{inspectionPlan:plan as unknown as Prisma.InputJsonValue}});
        }
        let complete=true;
        for(const posting of plan.postings)if(!await this.inventory.process(tx,inventoryActor!,posting.plan))complete=false;
        const updated=await tx.commerceReturn.update({where:{id},data:{status:complete?'COMPLETED':'INSPECTING',version:{increment:1}}});
        await this.event(tx,actor,updated,complete?'RETURN_COMPLETED':'RETURN_INSPECTION_PENDING',{documentIds:plan.postings.map(p=>p.plan.documentId)});
        if(complete)await this.orders.refreshFulfillmentProjection(tx,actor,order.id,'COMMERCE.RETURN_INSPECT');
        return this.projection(tx,updated);
      });
    },{timeout:60000});
  }
}
