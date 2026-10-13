import { Prisma,type PrismaClient,type SharedRefundCommand } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { canonical,decimal,parse,uuid } from '../process-platform/dto';
import { lock,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { exact } from '../inventory/decimal';
import { commerceVersion,assertCommerceVersion } from './dto';
import { commerceRefundPolicy } from './refund-policy';
import { CommerceOrderService } from './order-service';
import { CommerceReturnService } from './return-service';
import { PaymentProviderAuthority } from '../commercial/payment-provider-authority';
import { SharedRefundLifecycleService,type ManagedRefund } from '../commercial/refund-lifecycle-service';

export class CommerceRefundService {
  readonly shared:SharedRefundLifecycleService;
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly providers=new PaymentProviderAuthority()){this.shared=new SharedRefundLifecycleService(db);}
  private async load(tx:Tx,actor:Principal,id:string,permission:string){
    parse(uuid,id);const binding=await tx.commerceRefundBinding.findFirst({where:{workspaceId:actor.workspaceId,refundId:id}});
    if(!binding)throw new AppError('REFUND_NOT_FOUND','Refund was not found.',404);
    const order=await this.orders.load(tx,actor,binding.orderId,permission),refund=await this.shared.load(tx,actor,id,permission==='COMMERCE.REFUND_VIEW'?'payment.read':'payment.refund');
    return{binding,order,refund};
  }
  private async projection(tx:Tx,refund:ManagedRefund){
    const binding=await tx.commerceRefundBinding.findUniqueOrThrow({where:{refundId:refund.id}});
    const approval=await tx.commerceRefundApproval.findUnique({where:{workspaceId_refundId:{workspaceId:refund.workspaceId,refundId:refund.id}}});
    const command=await tx.sharedRefundCommand.findUnique({where:{refundId:refund.id},select:{id:true,status:true,attempts:true,uncertain:true,lastErrorCode:true}});
    return{id:refund.id,orderId:refund.orderId,paymentId:refund.paymentId,returnId:binding.returnId,amount:refund.amount,currency:refund.currencyCode,status:refund.status,version:refund.version,reason:refund.reasonText,requestedAt:refund.requestedAt,settledAt:refund.settledAt,providerRefundId:refund.providerRefundId,requiresApproval:binding.requiresApproval,approval:approval?{decision:approval.decision,reason:approval.reason,decidedAt:approval.decidedAt}:null,command};
  }
  private async request<T>(tx:Tx,actor:Principal,operation:string,key:string|null,input:unknown,effect:()=>Promise<T>):Promise<T>{
    if(!key||key.length<8||key.length>128)throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    const identity={workspaceId:actor.workspaceId,actorUserId:actor.userId,operation,key},requestHash=createHash('sha256').update(canonical(input)).digest('hex');
    await lock(tx,actor.workspaceId,'commerce:refund-request:'+actor.userId+':'+operation+':'+key);
    const prior=await tx.commerceRefundRequest.findUnique({where:{workspaceId_actorUserId_operation_key:identity}});
    if(prior){if(prior.requestHash!==requestHash)throw new AppError('IDEMPOTENCY_KEY_REUSED','Key was used with another Refund request.',409);return prior.response as T;}
    const result=await effect(),response=JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
    await tx.commerceRefundRequest.create({data:{...identity,requestHash,response}});return response as T;
  }
  async create(actor:Principal,orderId:string,raw:unknown,key:string|null){
    parse(uuid,orderId);const input=parse(z.strictObject({paymentId:uuid,amount:decimal,reason:z.string().trim().min(1).max(2000),returnId:uuid.optional()}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');await lock(tx,actor.workspaceId,'commerce:order:'+orderId);await lock(tx,actor.workspaceId,'shared:payment:'+input.paymentId);
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);const order=await this.orders.load(tx,actor,orderId,'COMMERCE.REFUND_CREATE');
      const paymentBinding=await tx.commerceOrderPaymentBinding.findFirst({where:{workspaceId:actor.workspaceId,orderId,paymentId:input.paymentId}});
      if(!paymentBinding)throw new AppError('PAYMENT_NOT_FOUND','Payment is unavailable for this Order.',404);
      await this.shared.payments.load(tx,actor,input.paymentId,'payment.refund');
      return this.request(tx,actor,'CREATE:'+orderId,key,input,async()=>{
        const store=await this.orders.stores.store(tx,actor,order.storeId,'COMMERCE.REFUND_CREATE'),policy=parse(commerceRefundPolicy,(store.settings as {refundPolicy?:unknown}).refundPolicy??{});
        let returned:null|{status:string}=null;
        if(input.returnId){returned=await new CommerceReturnService(this.db,this.orders).load(tx,actor,input.returnId,'COMMERCE.RETURN_VIEW');if((returned as {orderId?:string}).orderId!==orderId||['REJECTED','CANCELLED'].includes(returned.status))throw new AppError('RETURN_NOT_FOUND','Return is unavailable for this Order.',404);}
        if(!policy.allowWithoutReturn&&returned?.status!=='COMPLETED')throw new AppError('REFUND_APPROVAL_REQUIRED','Store policy requires a completed physical Return.',409);
        const requiresApproval=exact(input.amount).gt(policy.approvalThreshold);
        const refund=await this.shared.create(tx,actor,{paymentId:input.paymentId,orderId,amount:input.amount,currency:order.currency,reason:input.reason,requiresApproval});
        await tx.commerceRefundBinding.create({data:{workspaceId:actor.workspaceId,storeId:order.storeId,orderId,paymentId:input.paymentId,refundId:refund.id,returnId:input.returnId,requestedByUserId:actor.userId,policySnapshot:policy,requiresApproval}});
        await tx.commerceOrderHistory.create({data:{workspaceId:actor.workspaceId,storeId:order.storeId,orderId,actorUserId:actor.userId,action:'REFUND_REQUESTED',details:{refundId:refund.id,amount:refund.amount}}});
        return this.projection(tx,refund);
      });
    },{timeout:60000});
  }
  async get(actor:Principal,id:string){return this.db.$transaction(async tx=>{actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);return this.projection(tx,(await this.load(tx,actor,id,'COMMERCE.REFUND_VIEW')).refund);});}
  async approve(actor:Principal,id:string,raw:unknown){
    const input=parse(z.strictObject({expectedVersion:commerceVersion,decision:z.enum(['APPROVE','REJECT']),reason:z.string().trim().min(1).max(2000)}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const initial=await this.load(tx,actor,id,'COMMERCE.REFUND_APPROVE');await lock(tx,actor.workspaceId,'commerce:order:'+initial.order.id);await lock(tx,actor.workspaceId,'shared:payment:'+initial.refund.paymentId);
      const {refund,binding}=await this.load(tx,actor,id,'COMMERCE.REFUND_APPROVE');assertCommerceVersion(BigInt(refund.version),input.expectedVersion);
      const policy=parse(commerceRefundPolicy,binding.policySnapshot);
      if(!policy.allowSelfApproval&&binding.requestedByUserId===actor.userId)throw new AppError('REFUND_APPROVAL_REQUIRED','Another authorized financial approver is required.',403);
      const updated=await this.shared.decide(tx,actor,refund,input.decision);
      await tx.commerceRefundApproval.create({data:{workspaceId:actor.workspaceId,refundId:id,decidedByUserId:actor.userId,decision:input.decision,reason:input.reason,policySnapshot:policy}});
      return this.projection(tx,updated);
    },{timeout:60000});
  }
  async process(actor:Principal,id:string,raw:unknown,key:string|null){
    const input=parse(z.strictObject({expectedVersion:commerceVersion}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const initial=await this.load(tx,actor,id,'COMMERCE.REFUND_PROCESS');await lock(tx,actor.workspaceId,'commerce:order:'+initial.order.id);await lock(tx,actor.workspaceId,'shared:payment:'+initial.refund.paymentId);
      const {refund,order}=await this.load(tx,actor,id,'COMMERCE.REFUND_PROCESS');
      return this.request(tx,actor,'PROCESS:'+id,key,input,async()=>{
        assertCommerceVersion(BigInt(refund.version),input.expectedVersion);
        await this.provider(tx,actor,order.storeId,refund.paymentId,'COMMERCE.REFUND_PROCESS');
        const command=await this.shared.enqueue(tx,actor,refund);return{refundId:id,jobId:command.id,status:'QUEUED' as const};
      });
    },{timeout:60000});
  }
  private async provider(tx:Tx,actor:Principal,storeId:string,paymentId:string,permission:string){
    const payment=await this.shared.payments.load(tx,actor,paymentId,'payment.refund'),store=await this.orders.stores.store(tx,actor,storeId,permission);
    const method=this.providers.methods(store.settings).find(m=>m.id===payment.methodId);
    if(!method||method.connectionId!==payment.connectionId||method.provider!==payment.providerKey)throw new AppError('REFUND_PROVIDER_FAILURE','Refund payment method is unavailable.',409);
    const config=await this.providers.resolve(tx,actor,method);
    if(config.merchantId!==payment.merchantId||!config.adapter.capabilities().refunds)throw new AppError('REFUND_PROVIDER_FAILURE','Refund provider identity or capability changed.',409);return config;
  }
  private async authorize(tx:Tx,command:SharedRefundCommand){
    await lock(tx,command.workspaceId,'commerce:configuration');
    const binding=await tx.commerceRefundBinding.findFirst({where:{workspaceId:command.workspaceId,refundId:command.refundId}});
    if(!binding||binding.paymentId!==command.paymentId)throw new AppError('REFUND_NOT_FOUND','Refund command binding is unavailable.',404);
    await lock(tx,command.workspaceId,'commerce:order:'+binding.orderId);
    const actor=await resolvePrincipal(tx,command.workspaceId,command.actorUserId);await this.orders.load(tx,actor,binding.orderId,'COMMERCE.REFUND_PROCESS');
    return{actor,...await this.provider(tx,actor,binding.storeId,command.paymentId,'COMMERCE.REFUND_PROCESS')};
  }
  processCommand(id:string){return this.shared.process(id,(tx,row)=>this.authorize(tx,row));}
  async tick(limit=20){const now=new Date(),rows=await this.db.sharedRefundCommand.findMany({where:{OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},{status:'RUNNING',leaseExpiresAt:{lte:now}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:limit});let processed=0;for(const row of rows)if(await this.processCommand(row.id))processed++;return{scanned:rows.length,processed};}
}
