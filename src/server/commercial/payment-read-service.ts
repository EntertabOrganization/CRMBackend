import { z } from 'zod';
import { AppError } from '../errors';
import { decimal,parse,uuid } from '../process-platform/dto';
import { requirePermission,type Principal,type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { exact } from '../inventory/decimal';
import { managedPaymentData } from './payment-command-service';

const paymentData = z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/),amount: decimal,
  settlementStatus: z.enum(['PENDING','SUCCEEDED','FAILED','CANCELLED']),methodType: z.enum(['MANUAL','PROVIDER']),
  responsibleUserId: uuid.nullish(),providerKey: z.string().max(80).nullish() });
const attemptData = z.object({ paymentId: uuid,status: z.enum(['CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED']),
  requestedAmount: decimal,currencyCode: z.string().regex(/^[A-Z]{3}$/),providerKey: z.string().max(80),kind:z.enum(['SALE','AUTHORIZE','CAPTURE','VOID']).optional() });
const refundData = z.object({ paymentId: uuid,amount: decimal,currencyCode: z.string().regex(/^[A-Z]{3}$/),status: z.enum(['PENDING','PENDING_APPROVAL','APPROVED','PROCESSING','SUCCEEDED','FAILED','CANCELLED']) });

/** Shared Payments owns this projection. Never return provider payloads, credentials or card fields. */
export class SharedPaymentReadService {
  async authorizeReference(tx:Tx,actor:Principal,id:string){
    requirePermission(actor,'payment.read');
    const record=await tx.commercialPackRecord.findFirst({where:{workspaceId:actor.workspaceId,id,collection:'payments'}});
    if(!record)throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
    const owner=parse(z.object({responsibleUserId:uuid.nullish()}),record.data).responsibleUserId;
    if(!(owner?await ownerVisible(tx,actor,owner,'payment.read'):actor.grants.get('payment.read')==='WORKSPACE'))throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
  }
  async reconcileProjection(tx:Tx,actor:Principal,id:string){
    const payment=await this.read(tx,actor,id);
    const orders=await tx.commerceOrderPaymentBinding.aggregate({where:{workspaceId:actor.workspaceId,paymentId:id},_sum:{amount:true}});
    const invoices=await tx.commercialPackRecord.findMany({where:{workspaceId:actor.workspaceId,collection:'paymentAllocations',data:{path:['paymentId'],equals:id}}});
    const invoiceAllocated=invoices.reduce((sum,row)=>{const data=row.data as {status:string;amount:unknown};return data.status==='ACTIVE'?sum.plus(parse(decimal,data.amount)):sum;},exact(0));
    const unallocated=exact(payment.netSettledAmount).minus(orders._sum.amount??0).minus(invoiceAllocated);
    const receipts=await tx.sharedPaymentProviderEvent.groupBy({by:['status'],where:{workspaceId:actor.workspaceId,paymentId:id},_count:true});
    return{payment,orderAllocatedAmount:exact(orders._sum.amount??0).toFixed(6),invoiceAllocatedAmount:invoiceAllocated.toFixed(6),unallocatedAmount:unallocated.toFixed(6),receipts:receipts.map(row=>({status:row.status,count:row._count}))};
  }
  async read(tx: Tx,actor: Principal,id: string) {
    parse(uuid,id); requirePermission(actor,'payment.read');
    const record = await tx.commercialPackRecord.findFirst({ where: { workspaceId: actor.workspaceId,id,collection: 'payments' } });
    if (!record) throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
    const payment = parse(paymentData,record.data);
    const managed=(record.data as {flow?:string}).flow==='COMMERCE'?parse(managedPaymentData,record.data):null;
    if (!(payment.responsibleUserId ? await ownerVisible(tx,actor,payment.responsibleUserId,'payment.read') : actor.grants.get('payment.read')==='WORKSPACE'))
      throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
    const attempts = await tx.commercialPackRecord.findMany({ where: { workspaceId: actor.workspaceId,collection: 'paymentAttempts',data: { path: ['paymentId'],equals: id } },orderBy: { id: 'asc' } });
    const refunds = await tx.commercialPackRecord.findMany({ where: { workspaceId: actor.workspaceId,collection: 'refunds',data: { path: ['paymentId'],equals: id } },orderBy: { id: 'asc' } });
    const safeAttempts = attempts.map(row => ({ id: row.id,...parse(attemptData,row.data) }));
    const safeRefunds = refunds.map(row => ({ id: row.id,...parse(refundData,row.data) }));
    if ([...safeAttempts,...safeRefunds].some(row => row.currencyCode!==payment.currencyCode)) throw new AppError('PAYMENT_CURRENCY_MISMATCH','Shared payment requires reconciliation.',409);
    const refunded = safeRefunds.filter(row => row.status==='SUCCEEDED').reduce((sum,row) => sum.plus(row.amount),exact(0));
    const captured = managed?exact(managed.capturedAmount):payment.settlementStatus==='SUCCEEDED' ? exact(payment.amount) : exact(0);
    if (refunded.gt(captured)) throw new AppError('PAYMENT_INVALID_STATE','Shared payment requires reconciliation.',409);
    const status = refunded.gt(0) ? refunded.eq(captured) ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      : managed?managed.financialState:payment.settlementStatus==='SUCCEEDED' ? 'PAID' : payment.settlementStatus==='CANCELLED' ? 'VOIDED' : payment.settlementStatus;
    const commands=await tx.sharedPaymentCommand.findMany({where:{workspaceId:actor.workspaceId,paymentId:id},orderBy:[{createdAt:'asc'},{id:'asc'}],select:{id:true,kind:true,amount:true,currency:true,status:true,attempts:true,uncertain:true,lastErrorCode:true,createdAt:true}});
    return { id: record.id,currency: payment.currencyCode,amount: exact(payment.amount).toFixed(6),status,methodType: payment.methodType,
      provider: payment.providerKey ?? null,capturedAmount: captured.toFixed(6),refundedAmount: refunded.toFixed(6),netSettledAmount: captured.minus(refunded).toFixed(6),
      ...(managed?{requestedAmount:exact(managed.requestedAmount).toFixed(6),authorizedAmount:exact(managed.authorizedAmount).toFixed(6)}:{}),
      commands,attempts: safeAttempts.map(({ paymentId,...row }) => row),refunds: safeRefunds.map(({ paymentId,...row }) => row) };
  }
}
