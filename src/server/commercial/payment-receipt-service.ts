import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { exact } from '../inventory/decimal';
import { decimal,parse } from '../process-platform/dto';
import { evidence,lock,type Principal,type Tx } from '../process-platform/context';
import { SharedPaymentCommandService,managedPaymentData } from './payment-command-service';
import type { ProviderLifecycleEvent } from './payment-providers';

/** Verified provider facts update shared financial truth; callers project owning Order allocations separately. */
export class SharedPaymentReceiptService {
  constructor(private readonly commands:SharedPaymentCommandService){}
  async apply(tx:Tx,actor:Principal,paymentId:string,event:ProviderLifecycleEvent){
    await lock(tx,actor.workspaceId,'shared:payment:'+paymentId);
    const payment=await this.commands.load(tx,actor,paymentId,'payment.provider_confirm');
    if(payment.providerTransactionId!==event.transactionId||payment.merchantId!==event.merchantId||payment.currencyCode!==event.currencyCode||!exact(payment.requestedAmount).eq(event.amount))throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Provider payment binding mismatch.',409);
    const captured=exact(parse(decimal,event.capturedAmount)),authorized=exact(parse(decimal,event.authorizedAmount));
    if(captured.gt(payment.requestedAmount)||authorized.gt(payment.requestedAmount)||authorized.lt(captured))throw new AppError('PAYMENT_INVALID_STATE','Provider amounts exceed the owning payment.',409);
    const record=await tx.commercialPackRecord.findUniqueOrThrow({where:{id:paymentId}}),data=record.data as Prisma.JsonObject,lastAt=typeof data.lastProviderAt==='string'?data.lastProviderAt:null;
    const rank:Record<string,number>={CREATED:0,PENDING:1,AUTHORIZED:2,PARTIALLY_CAPTURED:3,PAID:4,FAILED:5,VOIDED:6};
    if(captured.lt(payment.capturedAmount)||captured.eq(payment.capturedAmount)&&(lastAt&&event.occurredAt<lastAt||lastAt===event.occurredAt&&rank[event.status]<rank[payment.financialState]||payment.financialState==='VOIDED'&&captured.eq(0)&&event.status!=='VOIDED'))return{outcome:'IGNORED' as const,capturedAmount:payment.capturedAmount};
    const changed=event.status!==payment.financialState||!captured.eq(payment.capturedAmount)||!authorized.eq(payment.authorizedAmount);
    const next={...data,financialState:event.status,authorizedAmount:authorized.toFixed(6),capturedAmount:captured.toFixed(6),
      amount:captured.gt(0)?captured.toFixed(6):payment.amount,
      settlementStatus:captured.gt(0)?'SUCCEEDED':event.status==='VOIDED'?'CANCELLED':event.status==='FAILED'?'FAILED':'PENDING',
      lastProviderAt:lastAt&&lastAt>event.occurredAt?lastAt:event.occurredAt,version:Number(data.version??0)+Number(changed)};
    parse(managedPaymentData,next);
    await tx.commercialPackRecord.update({where:{id:paymentId},data:{data:next}});
    const rows=await tx.sharedPaymentCommand.findMany({where:{workspaceId:actor.workspaceId,paymentId,attempts:{gt:0}},orderBy:[{createdAt:'asc'},{id:'asc'}]});
    for(const row of rows){
      const correlated=event.operationKey==='payment-command:'+row.id;
      let attemptStatus:string|undefined,commandStatus:string|undefined;
      if(['SALE','AUTHORIZE'].includes(row.kind)){
        if(captured.gt(0)||row.kind==='AUTHORIZE'&&authorized.gt(0))attemptStatus='SUCCEEDED';
        else if(event.status==='VOIDED')attemptStatus='CANCELLED';else if(event.status==='FAILED')attemptStatus='FAILED';
        if(attemptStatus)commandStatus=attemptStatus==='SUCCEEDED'?'SUCCEEDED':'FAILED';
      }else if(['RUNNING','WAITING_CONFIRMATION'].includes(row.status)||['QUEUED','FAILED'].includes(row.status)&&row.uncertain){
        if(row.kind==='CAPTURE'&&captured.gte(exact(row.baselineCapturedAmount).plus(row.amount))||row.kind==='VOID'&&event.status==='VOIDED'){attemptStatus='SUCCEEDED';commandStatus='SUCCEEDED';}
        else if(correlated&&event.failed||['FAILED','VOIDED'].includes(event.status)&&captured.eq(0)){attemptStatus='FAILED';commandStatus='FAILED';}
      }
      if(attemptStatus&&commandStatus){
        const attempt=await tx.commercialPackRecord.findUniqueOrThrow({where:{id:row.id}});
        await tx.commercialPackRecord.update({where:{id:row.id},data:{data:{...attempt.data as Prisma.JsonObject,status:attemptStatus}}});
        await tx.sharedPaymentCommand.update({where:{id:row.id},data:{status:commandStatus,uncertain:false,claimToken:null,leaseExpiresAt:null,lastErrorCode:commandStatus==='FAILED'?'PAYMENT_PROVIDER_REJECTED':null}});
      }
    }
    if(changed)await evidence(tx,actor,'PAYMENT',paymentId,event.status==='AUTHORIZED'?'PAYMENT_AUTHORIZED':event.status==='FAILED'?'PAYMENT_FAILED':'PAYMENT_STATE_UPDATED',{providerEventId:event.eventId,status:event.status,authorizedAmount:authorized.toFixed(6),capturedAmount:captured.toFixed(6)});
    return{outcome:changed?'APPLIED' as const:'UNCHANGED' as const,capturedAmount:captured.toFixed(6)};
  }
  async netCaptured(tx:Tx,workspaceId:string,paymentId:string,capturedAmount:string){
    const refunds=await tx.commercialPackRecord.findMany({where:{workspaceId,collection:'refunds',data:{path:['paymentId'],equals:paymentId}}});
    const refunded=refunds.reduce((sum,row)=>{const data=parse(z.object({amount:decimal,status:z.string()}),row.data);return data.status==='SUCCEEDED'?sum.plus(data.amount):sum;},exact(0));
    const invoices=await tx.commercialPackRecord.findMany({where:{workspaceId,collection:'paymentAllocations',data:{path:['paymentId'],equals:paymentId}}});
    const invoiced=invoices.reduce((sum,row)=>{const data=parse(z.object({amount:decimal,status:z.string()}),row.data);return data.status==='ACTIVE'?sum.plus(data.amount):sum;},exact(0));
    if(refunded.plus(invoiced).gt(capturedAmount))throw new AppError('PAYMENT_INVALID_STATE','Shared allocations require reconciliation.',409);return exact(capturedAmount).minus(refunded).minus(invoiced).toFixed(6);
  }
}
