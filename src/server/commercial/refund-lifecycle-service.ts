import { Prisma,type PrismaClient,type SharedRefundCommand } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { parse,uuid,decimal } from '../process-platform/dto';
import { evidence,lock,type Principal,type Tx } from '../process-platform/context';
import { exact } from '../inventory/decimal';
import { SharedPaymentCommandService } from './payment-command-service';
import { positiveProviderAmount,type PaymentProviderAdapter,type ProviderRefundEvent } from './payment-providers';

export const managedRefundData=z.object({id:uuid,workspaceId:uuid,flow:z.literal('COMMERCE'),orderId:uuid,paymentId:uuid,amount:decimal,currencyCode:z.string().regex(/^[A-Z]{3}$/),
  status:z.enum(['PENDING_APPROVAL','APPROVED','PROCESSING','SUCCEEDED','FAILED','CANCELLED']),version:z.string().regex(/^[1-9]\d*$/),reasonText:z.string(),requestedByUserId:uuid,requestedAt:z.string(),providerRefundId:z.string().nullable(),settledAt:z.string().nullable(),lastProviderAt:z.string().optional()});
export type ManagedRefund=z.infer<typeof managedRefundData>;
/** Shared Payments owns all refund records and outbound financial effects. */
export class SharedRefundLifecycleService {
  readonly payments:SharedPaymentCommandService;
  constructor(private readonly db:PrismaClient){this.payments=new SharedPaymentCommandService(db);}
  async load(tx:Tx,actor:Principal,id:string,permission='payment.read'){
    const record=await tx.commercialPackRecord.findFirst({where:{workspaceId:actor.workspaceId,id,collection:'refunds'}});
    if(!record)throw new AppError('REFUND_NOT_FOUND','Refund was not found.',404);
    const refund=parse(managedRefundData,record.data);await this.payments.load(tx,actor,refund.paymentId,permission);return refund;
  }
  async available(tx:Tx,actor:Principal,paymentId:string){
    const payment=await this.payments.load(tx,actor,paymentId,'payment.refund');
    const refunds=await tx.commercialPackRecord.findMany({where:{workspaceId:actor.workspaceId,collection:'refunds',data:{path:['paymentId'],equals:paymentId}}});
    const held=refunds.reduce((sum,row)=>{const r=parse(z.object({amount:decimal,status:z.string()}),row.data);return ['FAILED','CANCELLED'].includes(r.status)?sum:sum.plus(r.amount);},exact(0));
    const invoices=await tx.commercialPackRecord.findMany({where:{workspaceId:actor.workspaceId,collection:'paymentAllocations',data:{path:['paymentId'],equals:paymentId}}});
    const invoiced=invoices.reduce((sum,row)=>{const a=parse(z.object({amount:decimal,status:z.string()}),row.data);return a.status==='ACTIVE'?sum.plus(a.amount):sum;},exact(0));
    return{payment,available:exact(payment.capturedAmount).minus(held).minus(invoiced)};
  }
  async create(tx:Tx,actor:Principal,input:{paymentId:string;orderId:string;amount:string;currency:string;reason:string;requiresApproval:boolean}){
    await lock(tx,actor.workspaceId,'shared:payment:'+input.paymentId);
    const {payment,available}=await this.available(tx,actor,input.paymentId),amount=positiveProviderAmount(input.amount,input.currency);
    if(payment.sourceOrderId!==input.orderId||payment.currencyCode!==input.currency||payment.settlementStatus!=='SUCCEEDED'||!payment.providerTransactionId||exact(amount).gt(available))throw new AppError('REFUND_AMOUNT_EXCEEDED','Refund exceeds the remaining captured funds.',409);
    const id=randomUUID(),refund:ManagedRefund={id,workspaceId:actor.workspaceId,flow:'COMMERCE',orderId:input.orderId,paymentId:input.paymentId,amount:exact(amount).toFixed(6),currencyCode:input.currency,status:input.requiresApproval?'PENDING_APPROVAL':'APPROVED',version:'1',reasonText:input.reason,requestedByUserId:actor.userId,requestedAt:new Date().toISOString(),providerRefundId:null,settledAt:null};
    await tx.commercialPackRecord.create({data:{id,workspaceId:actor.workspaceId,collection:'refunds',data:refund}});
    await evidence(tx,actor,'REFUND',id,'REFUND_REQUESTED',{orderId:input.orderId,paymentId:input.paymentId,amount:refund.amount,status:refund.status});
    if(!input.requiresApproval)await evidence(tx,actor,'REFUND',id,'REFUND_APPROVED',{approval:'BELOW_THRESHOLD',amount:refund.amount});
    return refund;
  }
  async decide(tx:Tx,actor:Principal,refund:ManagedRefund,decision:'APPROVE'|'REJECT'){
    await this.payments.load(tx,actor,refund.paymentId,'payment.refund');
    if(refund.status!=='PENDING_APPROVAL')throw new AppError('REFUND_APPROVAL_REQUIRED','Refund is not pending approval.',409);
    const next={...refund,status:decision==='APPROVE'?'APPROVED' as const:'CANCELLED' as const,version:(BigInt(refund.version)+1n).toString()};
    await tx.commercialPackRecord.update({where:{id:refund.id},data:{data:next}});
    await evidence(tx,actor,'REFUND',refund.id,decision==='APPROVE'?'REFUND_APPROVED':'REFUND_REJECTED',{amount:refund.amount});return next;
  }
  async enqueue(tx:Tx,actor:Principal,refund:ManagedRefund){
    await this.payments.load(tx,actor,refund.paymentId,'payment.refund');
    const prior=await tx.sharedRefundCommand.findUnique({where:{refundId:refund.id}});
    if(prior){if(refund.status!=='PROCESSING')throw new AppError('REFUND_APPROVAL_REQUIRED','Refund has already reached a terminal provider outcome.',409);return prior;}
    if(refund.status!=='APPROVED')throw new AppError('REFUND_APPROVAL_REQUIRED','Approve the Refund before provider processing.',409);
    const command=await tx.sharedRefundCommand.create({data:{workspaceId:actor.workspaceId,refundId:refund.id,paymentId:refund.paymentId,actorUserId:actor.userId}});
    await tx.commercialPackRecord.update({where:{id:refund.id},data:{data:{...refund,status:'PROCESSING',version:(BigInt(refund.version)+1n).toString()}}});
    await evidence(tx,actor,'REFUND',refund.id,'REFUND_PROCESSING_QUEUED',{commandId:command.id});return command;
  }
  async process(id:string,authorize:(tx:Tx,row:SharedRefundCommand)=>Promise<{actor:Principal;adapter:PaymentProviderAdapter}>){
    let prepared:{row:SharedRefundCommand;actor:Principal;adapter:PaymentProviderAdapter;transactionId:string;refund:ManagedRefund;token:string}|null;
    try{prepared=await this.db.$transaction(async tx=>{
      const initial=await tx.sharedRefundCommand.findUnique({where:{id}});if(!initial)return null;
      const authority=await authorize(tx,initial);await lock(tx,initial.workspaceId,'shared:payment:'+initial.paymentId);
      const row=await tx.sharedRefundCommand.findUniqueOrThrow({where:{id}}),now=new Date();
      if(!['QUEUED','RUNNING'].includes(row.status)||row.nextAttemptAt>now||row.status==='RUNNING'&&row.leaseExpiresAt!>now)return null;
      if(row.attempts>=5){await tx.sharedRefundCommand.update({where:{id},data:{status:'FAILED',claimToken:null,leaseExpiresAt:null,lastErrorCode:'REFUND_PROVIDER_FAILURE'}});return null;}
      const refund=await this.load(tx,authority.actor,row.refundId,'payment.refund'),payment=await this.payments.load(tx,authority.actor,row.paymentId,'payment.refund');
      if(refund.status!=='PROCESSING'||!payment.providerTransactionId||!authority.adapter.capabilities().refunds)throw new AppError('REFUND_PROVIDER_FAILURE','Refund provider binding is unavailable.',409);
      const token=randomUUID();await tx.sharedRefundCommand.update({where:{id},data:{status:'RUNNING',claimToken:token,leaseExpiresAt:new Date(Date.now()+60000),attempts:{increment:1},uncertain:true}});
      return{row,refund,token,transactionId:payment.providerTransactionId,...authority};
    },{timeout:60000});}catch(error){await this.fail(id,null,error);return false;}
    if(!prepared)return false;
    try{
      const {row,refund,adapter,actor,transactionId,token}=prepared;
      const result=await adapter.refund({transactionId,amount:refund.amount,currencyCode:refund.currencyCode,idempotencyKey:'refund-command:'+row.id,refundReference:refund.id});
      const providerRefundId=parse(z.string().min(1).max(160),result.refundId);
      await this.db.$transaction(async tx=>{
        await lock(tx,row.workspaceId,'shared:payment:'+row.paymentId);
        const current=await tx.sharedRefundCommand.findUniqueOrThrow({where:{id}});if(current.status!=='RUNNING'||current.claimToken!==token)return;
        const r=await this.load(tx,actor,row.refundId,'payment.refund');
        if(r.providerRefundId&&r.providerRefundId!==providerRefundId)throw new AppError('REFUND_PROVIDER_FAILURE','Refund provider identity requires reconciliation.',409);
        await tx.commercialPackRecord.update({where:{id:r.id},data:{data:{...r,providerRefundId,version:(BigInt(r.version)+1n).toString()}}});
        await tx.sharedRefundCommand.update({where:{id},data:{status:'WAITING_CONFIRMATION',claimToken:null,leaseExpiresAt:null,lastErrorCode:null,uncertain:true}});
        await evidence(tx,actor,'REFUND',r.id,'REFUND_PROVIDER_REQUEST_SENT',{commandId:row.id});
      },{timeout:60000});return true;
    }catch(error){await this.fail(id,prepared.token,error);return false;}
  }
  private async fail(id:string,token:string|null,error:unknown){
    await this.db.$transaction(async tx=>{
      const initial=await tx.sharedRefundCommand.findUnique({where:{id}});if(!initial)return;await lock(tx,initial.workspaceId,'shared:payment:'+initial.paymentId);
      const row=await tx.sharedRefundCommand.findUniqueOrThrow({where:{id}});
      if(token?row.status!=='RUNNING'||row.claimToken!==token:row.status!=='QUEUED'&&!(row.status==='RUNNING'&&row.leaseExpiresAt!<=new Date()))return;
      const code=isAppError(error)?error.code:'REFUND_PROVIDER_FAILURE',attempts=token?row.attempts:Math.min(5,row.attempts+1);
      const providerStatus=isAppError(error)&&error.code==='PAYMENT_PROVIDER_REJECTED'?Number((error.details as {providerStatus?:number}|null)?.providerStatus):null;
      const rejected=providerStatus!==null&&providerStatus>=400&&providerStatus<500&&providerStatus!==429;
      const terminal=rejected||isAppError(error)&&[400,401,403,404,409,422].includes(error.status)||attempts>=5;
      const uncertain=row.uncertain&&!(token&&attempts===1&&rejected);
      await tx.sharedRefundCommand.update({where:{id},data:{status:terminal?'FAILED':'QUEUED',attempts,uncertain,claimToken:null,leaseExpiresAt:null,lastErrorCode:code,nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**attempts))}});
      if(terminal&&!uncertain){const record=await tx.commercialPackRecord.findUniqueOrThrow({where:{id:row.refundId}}),r=parse(managedRefundData,record.data);await tx.commercialPackRecord.update({where:{id:r.id},data:{data:{...r,status:'FAILED',version:(BigInt(r.version)+1n).toString()}}});}
      await tx.auditLog.create({data:{workspaceId:row.workspaceId,actorUserId:row.actorUserId,entityType:'REFUND',entityId:row.refundId,action:'REFUND_COMMAND_FAILED',metadata:{commandId:id,code,uncertain}}});
    },{timeout:60000});
  }
  async apply(tx:Tx,actor:Principal,paymentId:string,event:ProviderRefundEvent){
    await lock(tx,actor.workspaceId,'shared:payment:'+paymentId);
    const payment=await this.payments.load(tx,actor,paymentId,'payment.provider_confirm');
    if(payment.providerTransactionId!==event.transactionId||payment.merchantId!==event.merchantId||payment.currencyCode!==event.currencyCode)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Refund payment identity is invalid.',409);
    const records=await tx.commercialPackRecord.findMany({where:{workspaceId:actor.workspaceId,collection:'refunds',data:{path:['paymentId'],equals:paymentId}}});
    const refunds=records.map(r=>parse(managedRefundData,r.data));
    const commands=await tx.sharedRefundCommand.findMany({where:{workspaceId:actor.workspaceId,paymentId}});
    const matches=refunds.filter(r=>r.providerRefundId===event.refundId||event.refundReference===r.id||commands.some(c=>c.refundId===r.id&&event.operationKey==='refund-command:'+c.id));
    if(matches.length!==1)throw new AppError('REFUND_NOT_FOUND','Refund provider mapping requires reconciliation.',404);
    const refund=matches[0],command=commands.find(c=>c.refundId===refund.id);
    if(!command||command.attempts<1||!exact(refund.amount).eq(event.amount)||refund.providerRefundId&&refund.providerRefundId!==event.refundId||event.refundReference&&event.refundReference!==refund.id||event.operationKey&&event.operationKey!=='refund-command:'+command.id)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Refund provider proof does not match its request.',409);
    if(refund.status==='SUCCEEDED')return event.status==='SUCCEEDED'?'UNCHANGED' as const:'IGNORED' as const;
    if(refund.lastProviderAt&&event.occurredAt<refund.lastProviderAt)return'IGNORED' as const;
    if(['FAILED','CANCELLED'].includes(refund.status))return event.status===refund.status?'UNCHANGED' as const:'IGNORED' as const;
    if(refund.status!=='PROCESSING')throw new AppError('REFUND_APPROVAL_REQUIRED','Refund was not approved for processing.',409);
    const status=event.status==='PENDING'?'PROCESSING':event.status;
    const changed=status!==refund.status||refund.providerRefundId!==event.refundId;
    await tx.commercialPackRecord.update({where:{id:refund.id},data:{data:{...refund,status,providerRefundId:event.refundId,lastProviderAt:event.occurredAt,settledAt:status==='SUCCEEDED'?event.occurredAt:null,version:(BigInt(refund.version)+BigInt(changed)).toString()}}});
    if(status!=='PROCESSING')await tx.sharedRefundCommand.update({where:{id:command.id},data:{status:status==='SUCCEEDED'?'SUCCEEDED':'FAILED',uncertain:false,claimToken:null,leaseExpiresAt:null,lastErrorCode:status==='SUCCEEDED'?null:'REFUND_PROVIDER_FAILURE'}});
    // A pending proof also ends an expired/active send lease: never replay a
    // confirmed accepted request merely because the HTTP acknowledgment was lost.
    else await tx.sharedRefundCommand.update({where:{id:command.id},data:{status:'WAITING_CONFIRMATION',uncertain:true,claimToken:null,leaseExpiresAt:null,lastErrorCode:null}});
    if(changed)await evidence(tx,actor,'REFUND',refund.id,status==='SUCCEEDED'?'REFUND_COMPLETED':status==='PROCESSING'?'REFUND_PROVIDER_PENDING':'REFUND_FAILED',{providerEventId:event.eventId,paymentId,amount:refund.amount,status});
    return changed?'APPLIED' as const:'UNCHANGED' as const;
  }
}
