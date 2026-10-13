import { Prisma,type PrismaClient,type SharedPaymentCommand } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { exact } from '../inventory/decimal';
import { canonical,decimal,parse,uuid } from '../process-platform/dto';
import { evidence,lock,requirePermission,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { positiveProviderAmount,type PaymentProviderAdapter } from './payment-providers';

export const managedPaymentData=z.object({ id:uuid,workspaceId:uuid,flow:z.literal('COMMERCE'),currencyCode:z.string(),amount:decimal,
  sourceOrderId:uuid,
  requestedAmount:decimal,authorizedAmount:decimal,capturedAmount:decimal,financialState:z.enum(['CREATED','PENDING','AUTHORIZED','PARTIALLY_CAPTURED','PAID','VOIDED','FAILED']),
  settlementStatus:z.enum(['PENDING','SUCCEEDED','FAILED','CANCELLED']),responsibleUserId:uuid,providerKey:z.string(),merchantId:z.string(),methodId:uuid,connectionId:uuid,providerTransactionId:z.string().nullish() });
export type ManagedPayment=z.infer<typeof managedPaymentData>;
type Identity={ scope:string;key:string;hash:string };
type ProviderBinding={ connectionId:string;methodId:string;providerKey:string;merchantId:string };
export const paymentCommandAck=(row:SharedPaymentCommand)=>({paymentId:row.paymentId,commandId:row.id,status:'QUEUED' as const});
export const paymentCommandPermission=(kind:string)=>kind==='CAPTURE'?'payment.capture':kind==='VOID'?'payment.void':'payment.create_attempt';
const activeHold={ OR:[{status:{in:['QUEUED','RUNNING','WAITING_CONFIRMATION']}},{status:'FAILED',uncertain:true}] };
/** All payment/attempt effects below are owned by shared Payments and join the caller's transaction. */
export class SharedPaymentCommandService {
  constructor(private readonly db:PrismaClient){}
  identity(scope:string,key:string|null,input:unknown):Identity{
    if(!key||key.length<8||key.length>128)throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    return{scope,key,hash:createHash('sha256').update(canonical(input)).digest('hex')};
  }
  async replay(tx:Tx,actor:Principal,identity:Identity){
    const row=await tx.sharedPaymentCommand.findUnique({where:{workspaceId_actorUserId_requestScope_requestKey:{workspaceId:actor.workspaceId,actorUserId:actor.userId,requestScope:identity.scope,requestKey:identity.key}}});
    if(row&&row.requestHash!==identity.hash)throw new AppError('IDEMPOTENCY_CONFLICT','Key was used for a different payment command.',409);return row;
  }
  async load(tx:Tx,actor:Principal,id:string,permission:string){
    requirePermission(actor,permission);
    const row=await tx.commercialPackRecord.findFirst({where:{workspaceId:actor.workspaceId,id,collection:'payments'}});
    if(!row)throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
    const parsed=managedPaymentData.safeParse(row.data);if(!parsed.success)throw new AppError('PAYMENT_INVALID_STATE','Payment does not support Commerce provider commands.',409);
    if(!await ownerVisible(tx,actor,parsed.data.responsibleUserId,permission))throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
    return parsed.data;
  }
  private async enqueue(tx:Tx,actor:Principal,paymentId:string,kind:string,amount:string,currency:string,identity:Identity,binding:ProviderBinding,reason?:string,baseline='0'){
    const row=await tx.sharedPaymentCommand.create({data:{workspaceId:actor.workspaceId,paymentId,actorUserId:actor.userId,...binding,kind,amount,currency,reason,baselineCapturedAmount:baseline,requestScope:identity.scope,requestKey:identity.key,requestHash:identity.hash}});
    await tx.commercialPackRecord.create({data:{id:row.id,workspaceId:actor.workspaceId,collection:'paymentAttempts',data:{id:row.id,workspaceId:actor.workspaceId,paymentId,providerKey:binding.providerKey,merchantId:binding.merchantId,kind,lifecycleControlled:true,status:'CREATED',requestedAmount:amount,currencyCode:currency,invoiceIds:[]}}});
    await evidence(tx,actor,'PAYMENT',paymentId,'PAYMENT_COMMAND_QUEUED',{commandId:row.id,kind,amount});return row;
  }
  async create(tx:Tx,actor:Principal,input:{amount:string;currency:string;mode:'SALE'|'AUTHORIZE';sourceOrderId:string},identity:Identity,binding:ProviderBinding){
    requirePermission(actor,'payment.create_attempt');const amount=positiveProviderAmount(input.amount,input.currency),id=randomUUID();
    await tx.commercialPackRecord.create({data:{id,workspaceId:actor.workspaceId,collection:'payments',data:{id,workspaceId:actor.workspaceId,flow:'COMMERCE',sourceOrderId:input.sourceOrderId,currencyCode:input.currency,amount,requestedAmount:amount,authorizedAmount:'0',capturedAmount:'0',financialState:'CREATED',settlementStatus:'PENDING',methodType:'PROVIDER',responsibleUserId:actor.userId,providerTransactionId:null,...binding}}});
    const row=await this.enqueue(tx,actor,id,input.mode,amount,input.currency,identity,binding);
    await evidence(tx,actor,'PAYMENT',id,'PAYMENT_CREATED',{commandId:row.id,amount,currency:input.currency});return row;
  }
  async change(tx:Tx,actor:Principal,payment:ManagedPayment,kind:'CAPTURE'|'VOID',input:{amount?:string;reason?:string},identity:Identity,binding:ProviderBinding,multicapture:boolean){
    requirePermission(actor,paymentCommandPermission(kind));
    if(!payment.providerTransactionId||!['PENDING','AUTHORIZED','PARTIALLY_CAPTURED'].includes(payment.financialState))throw new AppError('PAYMENT_INVALID_STATE','Payment is not ready for this command.',409);
    const pending=await tx.sharedPaymentCommand.findMany({where:{workspaceId:actor.workspaceId,paymentId:payment.id,...activeHold}});
    if(kind==='VOID'){
      if(exact(payment.capturedAmount).gt(0)||pending.length)throw new AppError('PAYMENT_INVALID_STATE','Void requires uncaptured funds and no pending command.',409);
      return this.enqueue(tx,actor,payment.id,kind,'0',payment.currencyCode,identity,binding,input.reason);
    }
    if(pending.some(row=>row.kind!=='CAPTURE')||!multicapture&&pending.length)throw new AppError('PAYMENT_INVALID_STATE','Another provider command is pending.',409);
    const amount=positiveProviderAmount(input.amount!,payment.currencyCode),held=pending.reduce((sum,row)=>sum.plus(row.amount),exact(0));
    if(exact(amount).gt(exact(payment.authorizedAmount).minus(payment.capturedAmount).minus(held)))throw new AppError('PAYMENT_CAPTURE_EXCEEDS_AUTHORIZATION','Capture exceeds remaining authorized funds.',409);
    return this.enqueue(tx,actor,payment.id,kind,amount,payment.currencyCode,identity,binding,undefined,exact(payment.capturedAmount).plus(held).toFixed(6));
  }
  async process(id:string,authorize:(tx:Tx,row:SharedPaymentCommand)=>Promise<{actor:Principal;adapter:PaymentProviderAdapter}>){
    let prepared:{row:SharedPaymentCommand;actor:Principal;adapter:PaymentProviderAdapter;payment:ManagedPayment;token:string}|null;
    try{prepared=await this.db.$transaction(async tx=>{
      const original=await tx.sharedPaymentCommand.findUnique({where:{id}});if(!original)return null;
      const permission=await authorize(tx,original);await lock(tx,original.workspaceId,'shared:payment:'+original.paymentId);
      const row=await tx.sharedPaymentCommand.findUniqueOrThrow({where:{id}}),now=new Date();
      if(!['QUEUED','RUNNING'].includes(row.status)||row.nextAttemptAt>now||row.status==='RUNNING'&&row.leaseExpiresAt!>now)return null;
      if(row.attempts>=5){await tx.sharedPaymentCommand.update({where:{id},data:{status:'FAILED',claimToken:null,leaseExpiresAt:null,lastErrorCode:'PAYMENT_PROVIDER_UNAVAILABLE'}});return null;}
      if(await tx.sharedPaymentCommand.count({where:{workspaceId:row.workspaceId,paymentId:row.paymentId,id:{not:id},OR:[{status:'RUNNING',leaseExpiresAt:{gt:now}},{status:'WAITING_CONFIRMATION'}]}}))return null;
      const payment=await this.load(tx,permission.actor,row.paymentId,paymentCommandPermission(row.kind)),token=randomUUID();
      await tx.sharedPaymentCommand.update({where:{id},data:{status:'RUNNING',claimToken:token,leaseExpiresAt:new Date(Date.now()+60000),attempts:{increment:1},uncertain:true}});
      return{row,token,payment,...permission};
    },{timeout:60000});}catch(error){await this.failure(id,null,error);return false;}
    if(!prepared)return false;
    const {row,actor,adapter,payment,token}=prepared,key='payment-command:'+row.id;
    try{
      let transactionId=payment.providerTransactionId??null;
      if(['SALE','AUTHORIZE'].includes(row.kind)){
        const result=await adapter.createPaymentAttempt({amount:row.amount.toFixed(6),currencyCode:row.currency,idempotencyKey:key,mode:row.kind as 'SALE'|'AUTHORIZE'});
        transactionId=parse(z.string().min(1).max(160),result.transactionId);
      }else{
        const state=row.kind==='CAPTURE'?await adapter.capture!({transactionId:transactionId!,amount:row.amount.toFixed(6),currencyCode:row.currency,idempotencyKey:key}):await adapter.void!({transactionId:transactionId!,idempotencyKey:key});
        if(state.transactionId!==transactionId||state.merchantId!==row.merchantId||state.currencyCode!==row.currency||!exact(state.amount).eq(payment.requestedAmount)||exact(state.capturedAmount).lt(payment.capturedAmount)||exact(state.capturedAmount).gt(payment.requestedAmount))throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Provider response requires reconciliation.',409);
      }
      await this.db.$transaction(async tx=>{
        await lock(tx,row.workspaceId,'shared:payment:'+row.paymentId);const current=await tx.sharedPaymentCommand.findUniqueOrThrow({where:{id}});
        if(current.status!=='RUNNING'||current.claimToken!==token)return;
        const creation=['SALE','AUTHORIZE'].includes(row.kind);
        if(creation){const record=await tx.commercialPackRecord.findUniqueOrThrow({where:{id:row.paymentId}});await tx.commercialPackRecord.update({where:{id:row.paymentId},data:{data:{...record.data as Prisma.JsonObject,providerTransactionId:transactionId,financialState:'PENDING'}}});}
        const attempt=await tx.commercialPackRecord.findUniqueOrThrow({where:{id:row.id}});
        await tx.commercialPackRecord.update({where:{id:row.id},data:{data:{...attempt.data as Prisma.JsonObject,providerTransactionId:transactionId,status:'PENDING'}}});
        await tx.sharedPaymentCommand.update({where:{id},data:{status:creation?'SUCCEEDED':'WAITING_CONFIRMATION',claimToken:null,leaseExpiresAt:null,uncertain:!creation,lastErrorCode:null}});
        await evidence(tx,actor,'PAYMENT',row.paymentId,'PAYMENT_PROVIDER_REQUEST_SENT',{commandId:row.id,kind:row.kind});
      },{timeout:60000});return true;
    }catch(error){await this.failure(id,token,error);return false;}
  }
  private async failure(id:string,token:string|null,error:unknown){
    const code=isAppError(error)?error.code:'PAYMENT_PROVIDER_UNAVAILABLE';
    await this.db.$transaction(async tx=>{
      const initial=await tx.sharedPaymentCommand.findUnique({where:{id}});if(!initial)return;await lock(tx,initial.workspaceId,'shared:payment:'+initial.paymentId);
      const row=await tx.sharedPaymentCommand.findUniqueOrThrow({where:{id}});
      if(token?row.status!=='RUNNING'||row.claimToken!==token:row.status!=='QUEUED'&&!(row.status==='RUNNING'&&row.leaseExpiresAt!<=new Date()))return;
      const attempts=token?row.attempts:Math.min(5,row.attempts+1),terminal=isAppError(error)&&[400,401,403,404,409,422].includes(error.status);
      const rejected=code==='PAYMENT_PROVIDER_REJECTED'&&isAppError(error)&&typeof error.details==='object'&&error.details!==null&&Number((error.details as {providerStatus?:number}).providerStatus)<500&&Number((error.details as {providerStatus?:number}).providerStatus)!==429;
      const uncertain=row.uncertain&&!(token&&attempts===1&&rejected);
      const status=terminal||rejected||attempts>=5?'FAILED':'QUEUED';
      await tx.sharedPaymentCommand.update({where:{id},data:{status,attempts,uncertain,claimToken:null,leaseExpiresAt:null,lastErrorCode:code,nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**attempts))}});
      if(status==='FAILED'&&!uncertain&&['SALE','AUTHORIZE'].includes(row.kind)){
        const record=await tx.commercialPackRecord.findUniqueOrThrow({where:{id:row.paymentId}});await tx.commercialPackRecord.update({where:{id:row.paymentId},data:{data:{...record.data as Prisma.JsonObject,financialState:'FAILED',settlementStatus:'FAILED'}}});
      }
      await tx.auditLog.create({data:{workspaceId:row.workspaceId,actorUserId:row.actorUserId,entityType:'PAYMENT',entityId:row.paymentId,action:'PAYMENT_COMMAND_FAILED',metadata:{commandId:id,code,status,uncertain}}});
    },{timeout:60000});
  }
}
