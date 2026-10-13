import type { PrismaClient,SharedPaymentProviderEvent } from '@prisma/client';
import { AppError } from '../errors';
import { evidence,lock,requirePermission,resolvePrincipal,type Tx } from '../process-platform/context';
import { exact } from '../inventory/decimal';
import { managedPaymentData,SharedPaymentCommandService } from '../commercial/payment-command-service';
import { SharedPaymentReceiptService } from '../commercial/payment-receipt-service';
import { SharedPaymentCallbackService } from '../commercial/payment-callback-service';
import { PaymentProviderAuthority } from '../commercial/payment-provider-authority';
import type { ProviderCommerceEvent } from '../commercial/payment-providers';
import { CommerceOrderService } from './order-service';
import { CommercePaymentDisputeService } from './payment-dispute-service';
import { SharedRefundLifecycleService } from '../commercial/refund-lifecycle-service';

export class CommercePaymentCallbackService {
  readonly inbox:SharedPaymentCallbackService;
  readonly receipts:SharedPaymentReceiptService;
  constructor(private readonly db:PrismaClient,readonly orders=new CommerceOrderService(db),readonly providers=new PaymentProviderAuthority()){
    this.inbox=new SharedPaymentCallbackService(db,providers);this.receipts=new SharedPaymentReceiptService(new SharedPaymentCommandService(db));
  }
  receive(providerCode:string,headers:Headers,rawBody:string){return this.inbox.receive(providerCode,headers,rawBody);}
  private async apply(tx:Tx,row:SharedPaymentProviderEvent,event:ProviderCommerceEvent){
    const records=await tx.commercialPackRecord.findMany({where:{workspaceId:row.workspaceId,collection:'payments',data:{path:['providerTransactionId'],equals:event.transactionId}}});
    const matched=records.filter(record=>{const parsed=managedPaymentData.safeParse(record.data);return parsed.success&&parsed.data.connectionId===row.connectionId&&parsed.data.providerKey===row.providerCode;});
    if(matched.length!==1)throw new AppError('PAYMENT_NOT_FOUND','Provider transaction mapping is unavailable.',404);
    const payment=managedPaymentData.parse(matched[0].data);if(row.paymentId&&row.paymentId!==payment.id)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Provider receipt mapping changed.',409);
    await lock(tx,row.workspaceId,'commerce:order:'+payment.sourceOrderId);
    const order=await tx.commerceOrder.findFirst({where:{workspaceId:row.workspaceId,id:payment.sourceOrderId}});
    if(!order)throw new AppError('COMMERCE_ORDER_NOT_FOUND','Payment source Order is unavailable.',404);
    const store=await tx.commerceStore.findFirst({where:{workspaceId:row.workspaceId,id:order.storeId}});
    const principalId=(store?.settings as {paymentPrincipalUserId?:string}|undefined)?.paymentPrincipalUserId;
    if(!store||!principalId)throw new AppError('PAYMENT_AUTHORITY_UNAVAILABLE','Payment service principal is unavailable.',403);
    const actor=await resolvePrincipal(tx,row.workspaceId,principalId);requirePermission(actor,'payment.read');await this.orders.load(tx,actor,payment.sourceOrderId,'COMMERCE.PAYMENT_MANAGE');
    const method=this.providers.methods(store.settings).find(m=>m.id===payment.methodId);
    if(!method||method.connectionId!==row.connectionId||method.provider!==row.providerCode)throw new AppError('PAYMENT_AUTHORITY_UNAVAILABLE','Payment method binding changed after receipt.',403);
    const current=await this.providers.resolve(tx,actor,method);
    if(current.merchantId!==event.merchantId)throw new AppError('PAYMENT_PROVIDER_TRANSACTION_MISMATCH','Provider merchant binding changed.',409);
    if(await tx.commerceOrderPaymentBinding.count({where:{workspaceId:row.workspaceId,paymentId:payment.id,orderId:payment.sourceOrderId}})!==1)throw new AppError('PAYMENT_INVALID_STATE','Payment Order allocation is unavailable.',409);
    await this.inbox.bindPayment(tx,row,payment.id);
    if('kind' in event&&event.kind==='DISPUTE')return new CommercePaymentDisputeService(this.db,this.orders).applyInTransaction(tx,actor,payment.id,row,event);
    const result='kind' in event&&event.kind==='REFUND'
      ?{outcome:await new SharedRefundLifecycleService(this.db).apply(tx,actor,payment.id,event),capturedAmount:payment.capturedAmount}
      :await this.receipts.apply(tx,actor,payment.id,event);
    if(result.outcome!=='IGNORED'){
      const net=await this.receipts.netCaptured(tx,row.workspaceId,payment.id,result.capturedAmount);
      const others=await tx.commerceOrderPaymentBinding.aggregate({where:{workspaceId:row.workspaceId,orderId:order.id,paymentId:{not:payment.id}},_sum:{amount:true}});
      const remaining=exact(order.total).minus(others._sum.amount??0),allocated=exact(net).lt(remaining)?exact(net):remaining;
      if(allocated.lt(0))throw new AppError('PAYMENT_INVALID_STATE','Existing Order allocations require reconciliation.',409);
      await tx.commerceOrderPaymentBinding.updateMany({where:{workspaceId:row.workspaceId,paymentId:payment.id,orderId:payment.sourceOrderId},data:{amount:allocated.toFixed(6)}});
      if(result.outcome==='APPLIED'&&exact(net).gt(allocated))await evidence(tx,actor,'PAYMENT',payment.id,'PAYMENT_UNALLOCATED_FUNDS',{providerEventId:event.eventId,unallocatedAmount:exact(net).minus(allocated).toFixed(6),orderId:order.id});
      await this.orders.refreshPaymentProjection(tx,actor,payment.sourceOrderId,event.eventId);
    }
    return result.outcome;
  }
  tick(limit=20){return this.inbox.tick((tx,row,event)=>this.apply(tx,row,event),limit);}
}
