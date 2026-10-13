import { type PrismaClient,type CommerceOrder,type CommerceStore,type CommerceCrmSync } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { canonical,parse,uuid } from '../process-platform/dto';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { CrmCommerceOwnerService } from '../crm-commerce-owner-service';
import { CommerceOrderService } from './order-service';

/** Checkout persists intent only. CRM effects execute atomically under a current employee principal. */
export async function enqueueOrderCrmSync(tx:Tx,order:CommerceOrder,store:CommerceStore){
  const row=await tx.commerceCrmSync.create({data:{workspaceId:order.workspaceId,storeId:order.storeId,orderId:order.id,dealPolicy:store.dealCreationPolicy,status:store.dealCreationPolicy==='MANUAL_REVIEW'?'REVIEW_REQUIRED':'QUEUED'}});
  await tx.commerceCrmSyncHistory.create({data:{workspaceId:order.workspaceId,syncId:row.id,action:row.status,attempt:0}});return row;
}
const ack=(row:CommerceCrmSync)=>({syncId:row.id,orderId:row.orderId,status:row.status,dealPolicy:row.dealPolicy});
export class CommerceCrmSyncService {
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly crm=new CrmCommerceOwnerService()){}
  async create(actor:Principal,orderId:string,raw:unknown,key:string|null){
    parse(uuid,orderId);parse(z.strictObject({}),raw);
    if(!key||key.length<8||key.length>128)throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    const requestHash=createHash('sha256').update(canonical({orderId})).digest('hex');
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const order=await this.orders.load(tx,actor,orderId,'COMMERCE.ORDER_MANAGE');
      await lock(tx,actor.workspaceId,'commerce:crm-request:'+actor.userId+':'+key);
      const identity={workspaceId:actor.workspaceId,actorUserId:actor.userId,requestKey:key},prior=await tx.commerceCrmSyncRequest.findUnique({where:{workspaceId_actorUserId_requestKey:identity}});
      if(prior){if(prior.requestHash!==requestHash)throw new AppError('IDEMPOTENCY_KEY_REUSED','Key was used for another CRM sync request.',409);return prior.response;}
      await lock(tx,actor.workspaceId,'commerce:crm-order:'+orderId);
      let row=await tx.commerceCrmSync.findUnique({where:{workspaceId_orderId:{workspaceId:actor.workspaceId,orderId}}});
      const store=await tx.commerceStore.findUniqueOrThrow({where:{id:order.storeId}});
      if((row?.dealPolicy??store.dealCreationPolicy)==='MANUAL_REVIEW')requirePermission(actor,'COMMERCE.CUSTOMER_MANAGE');
      if(!row)row=await tx.commerceCrmSync.create({data:{workspaceId:actor.workspaceId,storeId:order.storeId,orderId,dealPolicy:store.dealCreationPolicy,mode:'MANUAL',requestedByUserId:actor.userId}});
      else if(['FAILED','REVIEW_REQUIRED'].includes(row.status))row=await tx.commerceCrmSync.update({where:{id:row.id},data:{status:'QUEUED',mode:'MANUAL',requestedByUserId:actor.userId,cycleAttempts:0,errorCode:null,completedAt:null,nextAttemptAt:new Date(),version:{increment:1}}});
      const response=ack(row);await tx.commerceCrmSyncRequest.create({data:{...identity,syncId:row.id,requestHash,response}});
      if(row.status==='QUEUED')await tx.commerceCrmSyncHistory.create({data:{workspaceId:actor.workspaceId,syncId:row.id,action:'QUEUED',actorUserId:actor.userId,attempt:row.attempts}});
      await evidence(tx,actor,'COMMERCE_ORDER',orderId,'ORDER_CRM_SYNC_REQUESTED',{syncId:row.id,status:row.status});return response;
    },{timeout:60000});
  }
  private async claim(id:string){
    const found=await this.db.commerceCrmSync.findUnique({where:{id}});if(!found)return null;
    return this.db.$transaction(async tx=>{
      await lock(tx,found.workspaceId,'commerce:crm-order:'+found.orderId);
      const row=await tx.commerceCrmSync.findUniqueOrThrow({where:{id}}),now=new Date();
      if(row.status==='QUEUED'?row.nextAttemptAt>now:row.status!=='RUNNING'||row.leaseExpiresAt!>now)return null;
      if(row.cycleAttempts>=5){await tx.commerceCrmSync.update({where:{id},data:{status:'FAILED',claimToken:null,leaseExpiresAt:null,completedAt:now,errorCode:'COMMERCE_CRM_SYNC_FAILED',version:{increment:1}}});return null;}
      const token=randomUUID(),claimed=await tx.commerceCrmSync.update({where:{id},data:{status:'RUNNING',claimToken:token,leaseExpiresAt:new Date(Date.now()+60000),attempts:{increment:1},cycleAttempts:{increment:1},version:{increment:1},errorCode:null}});
      await tx.commerceCrmSyncHistory.create({data:{workspaceId:row.workspaceId,syncId:id,action:'CLAIMED',attempt:claimed.attempts}});return{row:claimed,token};
    },{timeout:60000});
  }
  async process(id:string){
    const claim=await this.claim(id);if(!claim)return false;
    try{return await this.db.$transaction(async tx=>{
      await lock(tx,claim.row.workspaceId,'commerce:configuration');await lock(tx,claim.row.workspaceId,'commerce:crm-order:'+claim.row.orderId);
      const row=await tx.commerceCrmSync.findUniqueOrThrow({where:{id}});if(row.status!=='RUNNING'||row.claimToken!==claim.token)return false;
      const store=await tx.commerceStore.findUniqueOrThrow({where:{id:row.storeId}}),settings=store.settings as {crmPrincipalUserId?:string;crmPipelineId?:string};
      const userId=row.mode==='MANUAL'?row.requestedByUserId:settings.crmPrincipalUserId;
      if(!userId)throw new AppError('COMMERCE_CRM_PRINCIPAL_UNAVAILABLE','CRM principal is unavailable.',409);
      const actor=await resolvePrincipal(tx,row.workspaceId,userId),order=await this.orders.load(tx,actor,row.orderId,'COMMERCE.ORDER_MANAGE');
      if(row.dealPolicy==='MANUAL_REVIEW')requirePermission(actor,'COMMERCE.CUSTOMER_MANAGE');
      await lock(tx,row.workspaceId,'crm:commerce-identities');
      const result=await this.crm.sync(tx,actor,order,row.dealPolicy,settings.crmPipelineId);
      for(const [entityType,targetId] of [[result.customerType,result.customerId],...(result.dealId?[['DEAL',result.dealId]]:[])] as [string,string][]){
        await tx.commerceCrmBinding.upsert({where:{workspaceId_orderId_entityType:{workspaceId:row.workspaceId,orderId:row.orderId,entityType}},create:{workspaceId:row.workspaceId,storeId:row.storeId,orderId:row.orderId,entityType,targetId,linkPolicy:row.dealPolicy,status:'LINKED'},update:{targetId,status:'LINKED',lastErrorCode:null,version:{increment:1}}});
      }
      await tx.commerceCrmSync.update({where:{id},data:{status:'SUCCEEDED',customerWasNew:result.customerWasNew,dealCreated:result.dealCreated,claimToken:null,leaseExpiresAt:null,errorCode:null,completedAt:new Date(),version:{increment:1}}});
      await tx.commerceCrmSyncHistory.create({data:{workspaceId:row.workspaceId,syncId:id,action:'SUCCEEDED',actorUserId:actor.userId,attempt:row.attempts}});
      await evidence(tx,actor,'COMMERCE_ORDER',row.orderId,'ORDER_CRM_LINKED',{syncId:id,customerType:result.customerType,customerId:result.customerId,dealId:result.dealId});return true;
    },{timeout:60000});}
    catch(error){
      await this.db.$transaction(async tx=>{
        await lock(tx,claim.row.workspaceId,'commerce:crm-order:'+claim.row.orderId);const row=await tx.commerceCrmSync.findUniqueOrThrow({where:{id}});if(row.status!=='RUNNING'||row.claimToken!==claim.token)return;
        const errorCode=isAppError(error)&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)?error.code:'COMMERCE_CRM_SYNC_FAILED',failed=row.cycleAttempts>=5;
        await tx.commerceCrmSync.update({where:{id},data:{status:failed?'FAILED':'QUEUED',errorCode,claimToken:null,leaseExpiresAt:null,completedAt:failed?new Date():null,nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**row.cycleAttempts)),version:{increment:1}}});
        await tx.commerceCrmSyncHistory.create({data:{workspaceId:row.workspaceId,syncId:id,action:failed?'FAILED':'RETRY',errorCode,attempt:row.attempts}});
      },{timeout:60000});return false;
    }
  }
  async tick(limit=10){const now=new Date(),rows=await this.db.commerceCrmSync.findMany({where:{OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},{status:'RUNNING',leaseExpiresAt:{lte:now}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit});let processed=0;for(const row of rows)if(await this.process(row.id))processed++;return{processed};}
}
