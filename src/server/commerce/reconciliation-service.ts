import { Prisma,type PrismaClient,type CommerceReconciliationJob } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { canonical,parse,uuid } from '../process-platform/dto';
import { evidence,lock,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { CommerceOrderService } from './order-service';
import { CommerceIntegrationInspectionService,inspectionResult } from './integration-inspection-service';

const ack=(r:CommerceReconciliationJob)=>({jobId:r.id,status:r.status,correlationId:r.correlationId});
const queueAck=(r:CommerceReconciliationJob)=>({...ack(r),status:'QUEUED' as const});
/** Durable, leased consistency jobs. Reports never repair ledgers or retry provider effects. */
export class CommerceReconciliationService {
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly inspection=new CommerceIntegrationInspectionService(db,orders)){}
  async create(actor:Principal,orderId:string,raw:unknown,key:string|null){
    parse(uuid,orderId);parse(z.strictObject({}),raw);
    if(!key||key.length<8||key.length>128)throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    const hash=createHash('sha256').update(canonical({orderId})).digest('hex');
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const order=await this.orders.load(tx,actor,orderId,'COMMERCE.ORDER_MANAGE');
      await lock(tx,actor.workspaceId,'commerce:reconciliation-request:'+actor.userId+':'+key);
      const identity={workspaceId:actor.workspaceId,requestedByUserId:actor.userId,idempotencyKey:key};
      const prior=await tx.commerceReconciliationJob.findUnique({where:{workspaceId_requestedByUserId_idempotencyKey:identity}});
      if(prior){if(prior.requestHash!==hash)throw new AppError('IDEMPOTENCY_KEY_REUSED','Key was used for another consistency request.',409);return queueAck(prior);}
      const job=await tx.commerceReconciliationJob.create({data:{...identity,orderId,storeId:order.storeId,requestHash:hash}});
      await evidence(tx,actor,'COMMERCE_RECONCILIATION_JOB',job.id,'ORDER_RECONCILIATION_QUEUED',{orderId,correlationId:job.correlationId});return queueAck(job);
    },{timeout:60000});
  }
  async get(actor:Principal,id:string){
    parse(uuid,id);return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const job=await tx.commerceReconciliationJob.findFirst({where:{workspaceId:actor.workspaceId,id}});
      if(!job)throw new AppError('COMMERCE_RECONCILIATION_NOT_FOUND','Consistency job was not found.',404);
      await this.orders.load(tx,actor,job.orderId,'COMMERCE.ORDER_MANAGE');
      if(!await ownerVisible(tx,actor,job.requestedByUserId,'COMMERCE.ORDER_MANAGE'))throw new AppError('COMMERCE_RECONCILIATION_NOT_FOUND','Consistency job was not found.',404);
      const result=job.result?parse(inspectionResult,job.result):null;
      if(result)await this.inspection.authorizeReferences(tx,actor,job.orderId,result.references);
      return{...ack(job),orderId:job.orderId,attemptCount:job.attempts,errorCode:job.errorCode,result:result?(({references,...safe})=>safe)(result):null,createdAt:job.createdAt,completedAt:job.completedAt};
    },{timeout:60000});
  }
  private async claim(id:string){
    const found=await this.db.commerceReconciliationJob.findUnique({where:{id}});if(!found)return null;
    return this.db.$transaction(async tx=>{
      await lock(tx,found.workspaceId,'commerce:reconciliation-job:'+id);
      const row=await tx.commerceReconciliationJob.findUniqueOrThrow({where:{id}}),now=new Date();
      if(row.status==='QUEUED'?row.nextAttemptAt>now:row.status!=='RUNNING'||row.leaseExpiresAt!>now)return null;
      if(row.attempts>=5){await tx.commerceReconciliationJob.update({where:{id},data:{status:'FAILED',claimToken:null,leaseExpiresAt:null,completedAt:now,errorCode:'COMMERCE_RECONCILIATION_FAILED'}});return null;}
      const token=randomUUID();await tx.commerceReconciliationJob.update({where:{id},data:{status:'RUNNING',claimToken:token,leaseExpiresAt:new Date(Date.now()+60000),attempts:{increment:1},errorCode:null}});return{row,token};
    },{timeout:60000});
  }
  async process(id:string){
    const claim=await this.claim(id);if(!claim)return false;
    try{return await this.db.$transaction(async tx=>{
      await lock(tx,claim.row.workspaceId,'commerce:configuration');await lock(tx,claim.row.workspaceId,'commerce:order:'+claim.row.orderId);await lock(tx,claim.row.workspaceId,'commerce:reconciliation-job:'+id);
      const job=await tx.commerceReconciliationJob.findUniqueOrThrow({where:{id}});if(job.status!=='RUNNING'||job.claimToken!==claim.token)return false;
      const actor=await resolvePrincipal(tx,job.workspaceId,job.requestedByUserId),result=await this.inspection.inspect(tx,actor,job.orderId);
      await tx.commerceReconciliationJob.update({where:{id},data:{status:'SUCCEEDED',result,claimToken:null,leaseExpiresAt:null,completedAt:new Date(),errorCode:null}});
      await evidence(tx,actor,'COMMERCE_ORDER',job.orderId,'ORDER_RECONCILIATION_COMPLETED',{jobId:id,correlationId:job.correlationId,consistent:result.consistent,mismatchCount:result.mismatches.length,orderVersion:result.orderVersion});return true;
    },{timeout:60000,isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});}
    catch(error){await this.db.$transaction(async tx=>{
      await lock(tx,claim.row.workspaceId,'commerce:reconciliation-job:'+id);const job=await tx.commerceReconciliationJob.findUniqueOrThrow({where:{id}});
      if(job.status!=='RUNNING'||job.claimToken!==claim.token)return;
      const failed=job.attempts>=5;await tx.commerceReconciliationJob.update({where:{id},data:{status:failed?'FAILED':'QUEUED',claimToken:null,leaseExpiresAt:null,completedAt:failed?new Date():null,errorCode:isAppError(error)&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)?error.code:'COMMERCE_RECONCILIATION_FAILED',nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**job.attempts))}});
    },{timeout:60000});return false;}
  }
  async tick(limit=10){
    const now=new Date(),rows=await this.db.commerceReconciliationJob.findMany({where:{OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},{status:'RUNNING',leaseExpiresAt:{lte:now}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit});let processed=0;
    for(const row of rows)if(await this.process(row.id))processed++;return{processed};
  }
}
