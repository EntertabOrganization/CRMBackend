import type { CommercePaymentDispute,PrismaClient,SharedPaymentProviderEvent } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { canonical,pageQuery,parse,uuid } from '../process-platform/dto';
import { evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { SharedPaymentReadService } from '../commercial/payment-read-service';
import { SharedPaymentCommandService } from '../commercial/payment-command-service';
import type { ProviderDisputeEvent } from '../commercial/payment-providers';
import { exact } from '../inventory/decimal';
import { CommerceOrderService } from './order-service';

const statuses=z.enum(['OPEN','EVIDENCE_REQUIRED','SUBMITTED','WON','LOST']);
const rank:Record<string,number>={OPEN:0,EVIDENCE_REQUIRED:1,SUBMITTED:2,WON:3,LOST:3};
/** Commerce owns disputes and immutable evidence-status history independently of physical returns. */
export class CommercePaymentDisputeService {
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly payments=new SharedPaymentReadService()){}
  async applyInTransaction(tx:Tx,actor:Principal,paymentId:string,receipt:SharedPaymentProviderEvent,event:ProviderDisputeEvent){
    requirePermission(actor,'payment.provider_confirm');await this.payments.read(tx,actor,paymentId);
    const payment=await new SharedPaymentCommandService(this.db).load(tx,actor,paymentId,'payment.provider_confirm'),order=await this.orders.load(tx,actor,payment.sourceOrderId,'COMMERCE.PAYMENT_MANAGE');
    if(receipt.workspaceId!==actor.workspaceId||payment.connectionId!==receipt.connectionId||payment.providerKey!==receipt.providerCode||payment.providerTransactionId!==event.transactionId||payment.merchantId!==event.merchantId||payment.currencyCode!==event.currencyCode)
      throw new AppError('PAYMENT_DISPUTE_INVALID','Dispute does not match its owning Payment.',409);
    await lock(tx,actor.workspaceId,'commerce:dispute:'+receipt.connectionId+':'+event.disputeId);
    const identity={workspaceId:actor.workspaceId,connectionId:receipt.connectionId,providerCode:receipt.providerCode,providerDisputeId:event.disputeId};
    let row=await tx.commercePaymentDispute.findUnique({where:{workspaceId_connectionId_providerCode_providerDisputeId:identity}});
    const at=new Date(event.occurredAt),openedAt=new Date(event.openedAt);let outcome:'APPLIED'|'IGNORED'|'UNCHANGED'='APPLIED';
    if(row){
      if(row.paymentId!==paymentId||row.chargeId!==event.chargeId||!row.amount.eq(event.amount)||row.currency!==event.currencyCode||row.openedAt.getTime()!==openedAt.getTime())
        throw new AppError('PAYMENT_DISPUTE_INVALID','Provider dispute identity changed.',409);
      const terminal=['WON','LOST'].includes(row.status);
      const previous=row.evidence as {submissionCount:number;hasEvidence:boolean};
      const regressiveTie=at.getTime()===row.lastProviderAt.getTime()&&(rank[event.status]<rank[row.status]||event.evidence.submissionCount<previous.submissionCount||previous.hasEvidence&&!event.evidence.hasEvidence);
      if(at<row.lastProviderAt||terminal&&(event.status!==row.status||at<=row.lastProviderAt)||regressiveTie)outcome='IGNORED';
      else if(row.status===event.status&&row.providerStatus===event.providerStatus&&row.reason===event.reason&&canonical(row.evidence)===canonical(event.evidence))outcome='UNCHANGED';
      else row=await tx.commercePaymentDispute.update({where:{id:row.id},data:{status:event.status,providerStatus:event.providerStatus,reason:event.reason,evidence:event.evidence,lastProviderAt:at,version:{increment:1},resolvedAt:terminal?row.resolvedAt:['WON','LOST'].includes(event.status)?at:null}});
      if(outcome==='UNCHANGED'&&at>row.lastProviderAt)row=await tx.commercePaymentDispute.update({where:{id:row.id},data:{lastProviderAt:at,version:{increment:1}}});
    }else{
      row=await tx.commercePaymentDispute.create({data:{...identity,paymentId,storeId:order.storeId,orderId:order.id,chargeId:event.chargeId,amount:event.amount,currency:event.currencyCode,status:event.status,providerStatus:event.providerStatus,reason:event.reason,evidence:event.evidence,openedAt,lastProviderAt:at,resolvedAt:['WON','LOST'].includes(event.status)?at:null}});
      await evidence(tx,actor,'COMMERCE_PAYMENT_DISPUTE',row.id,'PAYMENT_DISPUTE_OPENED',{paymentId,orderId:order.id,providerEventId:event.eventId,status:event.status,amount:exact(event.amount).toFixed(6),currency:event.currencyCode});
    }
    await tx.commercePaymentDisputeHistory.create({data:{workspaceId:actor.workspaceId,disputeId:row.id,receiptId:receipt.id,providerEventId:event.eventId,status:event.status,providerStatus:event.providerStatus,evidence:event.evidence,outcome,occurredAt:at}});
    if(outcome==='APPLIED')await evidence(tx,actor,'COMMERCE_PAYMENT_DISPUTE',row.id,'PAYMENT_DISPUTE_UPDATED',{paymentId,orderId:order.id,providerEventId:event.eventId,status:row.status,providerStatus:row.providerStatus,version:row.version.toString()});
    return outcome;
  }
  private projection(row:CommercePaymentDispute){return{id:row.id,paymentId:row.paymentId,orderId:row.orderId,storeId:row.storeId,provider:row.providerCode,providerDisputeId:row.providerDisputeId,amount:row.amount.toFixed(6),currency:row.currency,status:row.status,providerStatus:row.providerStatus,reason:row.reason,evidence:row.evidence,openedAt:row.openedAt,resolvedAt:row.resolvedAt,version:row.version.toString()};}
  private async visible(tx:Tx,actor:Principal,row:CommercePaymentDispute){await this.orders.load(tx,actor,row.orderId,'COMMERCE.DISPUTE_VIEW');await this.payments.read(tx,actor,row.paymentId);}
  async list(actor:Principal,raw:unknown){
    const query=parse(pageQuery.omit({search:true}).extend({status:statuses.optional()}),raw);
    return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);requirePermission(actor,'COMMERCE.DISPUTE_VIEW');requirePermission(actor,'payment.read');
      const workspace=await tx.workspace.findUniqueOrThrow({where:{id:actor.workspaceId}});
      if((workspace.settings as {entitlements?:{commerce?:boolean}}).entitlements?.commerce===false)throw new AppError('PERMISSION_DENIED','Commerce is unavailable for this Workspace.',403);
      const rows=await tx.commercePaymentDispute.findMany({where:{workspaceId:actor.workspaceId,status:query.status},orderBy:[{openedAt:'desc'},{id:'asc'}]}),visible=[];
      for(const row of rows)try{await this.visible(tx,actor,row);visible.push(this.projection(row));}catch(error){if(!(error instanceof AppError)||![403,404].includes(error.status))throw error;}
      return{data:visible.slice((query.page-1)*query.limit,query.page*query.limit),meta:{page:query.page,limit:query.limit,total:visible.length,totalPages:Math.ceil(visible.length/query.limit)}};
    },{timeout:60000});
  }
  async get(actor:Principal,id:string){
    parse(uuid,id);return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);requirePermission(actor,'COMMERCE.DISPUTE_VIEW');requirePermission(actor,'payment.read');
      const row=await tx.commercePaymentDispute.findFirst({where:{workspaceId:actor.workspaceId,id}});
      if(!row)throw new AppError('PAYMENT_DISPUTE_NOT_FOUND','Dispute was not found.',404);
      try{await this.visible(tx,actor,row);}catch(error){if(error instanceof AppError&&error.status===404)throw new AppError('PAYMENT_DISPUTE_NOT_FOUND','Dispute was not found.',404);throw error;}
      const history=await tx.commercePaymentDisputeHistory.findMany({where:{workspaceId:actor.workspaceId,disputeId:id},orderBy:[{occurredAt:'asc'},{id:'asc'}],select:{id:true,providerEventId:true,status:true,providerStatus:true,evidence:true,outcome:true,occurredAt:true}});
      return{...this.projection(row),history};
    },{timeout:60000});
  }
}
