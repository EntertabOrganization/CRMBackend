import { AppError } from '../errors';
import { exact } from '../inventory/decimal';
import type { Principal, Tx } from '../process-platform/context';
import { requirePermission } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { decimal, parse } from '../process-platform/dto';

/** Read authority belongs to shared Payments. Commerce binds an amount, never copies payment truth. */
export class OrderPaymentCoverage {
  async summary(tx:Tx,actor:Principal,orderId:string,currency:string){
    const paid=await this.paid(tx,actor,orderId,currency);
    const bindings=await tx.commerceOrderPaymentBinding.findMany({where:{workspaceId:actor.workspaceId,orderId}});let refunded=exact(0);
    for(const binding of bindings){const rows=await tx.commercialPackRecord.findMany({where:{workspaceId:actor.workspaceId,collection:'refunds',data:{path:['paymentId'],equals:binding.paymentId}}});
      for(const row of rows){const r=row.data as {amount:unknown;status:string;orderId?:string;flow?:string};if(r.status==='SUCCEEDED'&&r.flow==='COMMERCE'&&r.orderId===orderId)refunded=refunded.plus(parse(decimal,r.amount));}
    }
    return{paid,refunded:refunded.toFixed(6)};
  }
  async paid(tx: Tx,actor: Principal,orderId: string,currency: string) {
    const bindings = await tx.commerceOrderPaymentBinding.findMany({ where: { workspaceId: actor.workspaceId,orderId } });
    if (!bindings.length) return '0';
    requirePermission(actor,'payment.read'); let paid = exact(0);
    for (const binding of bindings) {
      const record = await tx.commercialPackRecord.findFirst({ where: { workspaceId: actor.workspaceId,id: binding.paymentId,collection: 'payments' } });
      if (!record) throw new AppError('SHIPMENT_PAYMENT_BLOCKED','Shared Payment is unavailable.',409);
      const payment = record.data as { amount: unknown;currencyCode: string;settlementStatus: string;responsibleUserId?: string };
      if (!(payment.responsibleUserId ? await ownerVisible(tx,actor,payment.responsibleUserId,'payment.read') : actor.grants.get('payment.read')==='WORKSPACE')) throw new AppError('PERMISSION_DENIED','Shared Payment is outside the principal scope.',403);
      if (payment.currencyCode!==currency) throw new AppError('SHIPMENT_PAYMENT_BLOCKED','Payment currency does not match the Order.',409);
      if (payment.settlementStatus!=='SUCCEEDED') continue;
      const amount = exact(parse(decimal,payment.amount));
      const refunds = await tx.commercialPackRecord.findMany({ where: { workspaceId: actor.workspaceId,collection: 'refunds',data: { path: ['paymentId'],equals: binding.paymentId } } });
      const refunded = refunds.reduce((sum,row) => {
        const refund = row.data as { amount: unknown;status: string }; return refund.status==='SUCCEEDED' ? sum.plus(parse(decimal,refund.amount)) : sum;
      },exact(0));
      // All allocations must fit the owning payment's remaining settled funds.
      const orderTotal = await tx.commerceOrderPaymentBinding.aggregate({ where: { workspaceId: actor.workspaceId,paymentId: binding.paymentId },_sum: { amount: true } });
      const invoices = await tx.commercialPackRecord.findMany({ where: { workspaceId: actor.workspaceId,collection: 'paymentAllocations',data: { path: ['paymentId'],equals: binding.paymentId } } });
      const invoiceTotal = invoices.reduce((sum,row) => { const a = row.data as { amount: unknown;status: string }; return a.status==='ACTIVE' ? sum.plus(parse(decimal,a.amount)) : sum; },exact(0));
      if (exact(orderTotal._sum.amount ?? 0).plus(invoiceTotal).plus(refunded).gt(amount)) throw new AppError('SHIPMENT_PAYMENT_BLOCKED','Payment allocations require reconciliation.',409);
      paid = paid.plus(binding.amount);
    }
    return paid.toFixed(6);
  }
}
