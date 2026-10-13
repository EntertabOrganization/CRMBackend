import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { pageQuery, parse, uuid } from '../process-platform/dto';
import { InventoryReservationService } from '../inventory/reservation-service';
import { CommerceStoreService } from './store-service';
import { assertCommerceVersion, commerceVersion } from './dto';
import { OrderPaymentCoverage } from '../commercial/order-payment-coverage';
import { exact } from '../inventory/decimal';
import { queuePaidReservations } from './paid-reservation-service';

export class CommerceOrderService {
  constructor(private readonly db: PrismaClient, readonly stores = new CommerceStoreService(db),readonly reservations = new InventoryReservationService(db)) {}
  async refreshPaymentProjection(tx:Tx,actor:Principal,orderId:string,providerEventId:string){
    await lock(tx,actor.workspaceId,'commerce:configuration');await lock(tx,actor.workspaceId,'commerce:order:'+orderId);
    actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
    const row=await this.load(tx,actor,orderId,'COMMERCE.PAYMENT_MANAGE'),summary=await new OrderPaymentCoverage().summary(tx,actor,orderId,row.currency),paid=exact(summary.paid),refunded=exact(summary.refunded);
    if(paid.gt(row.total))throw new AppError('PAYMENT_INVALID_STATE','Order allocations exceed its total.',409);
    await queuePaidReservations(tx,actor,row,paid.toFixed(6));
    const paymentStatus=paid.eq(row.total)?'PAID':refunded.gt(0)?paid.gt(0)?'PARTIALLY_REFUNDED':'REFUNDED':paid.gt(0)?'PARTIALLY_PAID':'UNPAID';
    const lines=(row.snapshot as {lines?:{itemId:string;quantity:string}[]}).lines;
    const delivered=await tx.commerceShipmentItem.findMany({where:{workspaceId:actor.workspaceId,orderId,shipmentId:{in:(await tx.commerceShipment.findMany({where:{workspaceId:actor.workspaceId,orderId,deliveredAt:{not:null}},select:{id:true}})).map(s=>s.id)}}});
    const returnIds=(await tx.commerceReturn.findMany({where:{workspaceId:actor.workspaceId,orderId,status:'COMPLETED'},select:{id:true}})).map(r=>r.id);
    const returned=await tx.commerceReturnLine.count({where:{workspaceId:actor.workspaceId,orderId,returnId:{in:returnIds},disposition:{not:'REJECT'},receivedQuantity:{gt:0}}});
    const fulfilled=Boolean(!returned&&lines?.length&&lines.every(line=>delivered.filter(i=>i.orderLineId===line.itemId).reduce((sum,i)=>sum.plus(i.quantity),exact(0)).eq(line.quantity)));
    const status=row.status!=='CANCELLED'&&fulfilled&&paymentStatus==='PAID'?'COMPLETED':row.status==='COMPLETED'&&paymentStatus!=='PAID'?'PROCESSING':row.status;
    if(row.paidAmount.eq(paid)&&row.refundedAmount.eq(refunded)&&row.paymentStatus===paymentStatus&&row.status===status)return;
    const updated=await tx.commerceOrder.update({where:{id:row.id},data:{paidAmount:paid.toFixed(6),refundedAmount:refunded.toFixed(6),paymentStatus,status,version:{increment:1}}});
    await tx.commerceOrderHistory.create({data:{workspaceId:actor.workspaceId,storeId:row.storeId,orderId,actorUserId:actor.userId,action:'PAYMENT_UPDATED',details:{providerEventId,paidAmount:paid.toFixed(6),refundedAmount:refunded.toFixed(6),paymentStatus,status,version:updated.version.toString()}}});
    await evidence(tx,actor,'COMMERCE_ORDER',orderId,'ORDER_PAYMENT_UPDATED',{providerEventId,paidAmount:paid.toFixed(6),refundedAmount:refunded.toFixed(6),paymentStatus,status});
    if(paymentStatus==='PAID'&&row.paymentStatus!=='PAID')await evidence(tx,actor,'COMMERCE_ORDER',orderId,'ORDER_PAID',{providerEventId,paidAmount:paid.toFixed(6)});
  }
  async refreshFulfillmentProjection(tx:Tx,actor:Principal,orderId:string,permission:string){
    const row=await this.load(tx,actor,orderId,permission);
    const lines=(row.snapshot as {lines?:{itemId:string;quantity:string}[]}).lines??[];
    const deliveries=(await tx.commerceShipment.findMany({where:{workspaceId:actor.workspaceId,orderId,deliveredAt:{not:null}},select:{id:true}})).map(s=>s.id);
    const delivered=await tx.commerceShipmentItem.findMany({where:{workspaceId:actor.workspaceId,orderId,shipmentId:{in:deliveries}}});
    const returns=(await tx.commerceReturn.findMany({where:{workspaceId:actor.workspaceId,orderId,status:'COMPLETED'},select:{id:true}})).map(r=>r.id);
    const returned=await tx.commerceReturnLine.findMany({where:{workspaceId:actor.workspaceId,orderId,returnId:{in:returns},disposition:{not:'REJECT'}}});
    const anyReturn=returned.some(l=>l.receivedQuantity.gt(0)),allReturned=Boolean(lines.length&&lines.every(l=>returned.filter(r=>r.orderLineId===l.itemId).reduce((sum,r)=>sum.plus(r.receivedQuantity),exact(0)).eq(l.quantity)));
    const allDelivered=Boolean(lines.length&&lines.every(l=>delivered.filter(d=>d.orderLineId===l.itemId).reduce((sum,d)=>sum.plus(d.quantity),exact(0)).eq(l.quantity)));
    const fulfillmentStatus=anyReturn?allReturned?'RETURNED':'PARTIALLY_RETURNED':allDelivered?'FULFILLED':delivered.length?'PARTIALLY_FULFILLED':'UNFULFILLED';
    const status=anyReturn&&row.status==='COMPLETED'?'PROCESSING':row.status;
    if(row.fulfillmentStatus===fulfillmentStatus&&row.status===status)return;
    const updated=await tx.commerceOrder.update({where:{id:orderId},data:{fulfillmentStatus,status,version:{increment:1}}});
    await tx.commerceOrderHistory.create({data:{workspaceId:actor.workspaceId,storeId:row.storeId,orderId,actorUserId:actor.userId,action:'FULFILLMENT_PROJECTED',details:{fulfillmentStatus,status,version:updated.version.toString()}}});
    await evidence(tx,actor,'COMMERCE_ORDER',orderId,'ORDER_FULFILLMENT_PROJECTED',{fulfillmentStatus,status});
  }
  async load(tx: Tx,actor: Principal,id: string,permission: string) {
    parse(uuid,id);
    const row = await tx.commerceOrder.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row) throw new AppError('COMMERCE_ORDER_NOT_FOUND','Order was not found.',404);
    await this.stores.store(tx,actor,row.storeId,permission); return row;
  }
  async list(actor: Principal,raw: unknown) {
    const query = parse(pageQuery.extend({ storeId: uuid.optional(),status: z.enum(['NEW','CONFIRMED','PROCESSING','COMPLETED','CANCELLED']).optional() }),raw);
    return this.db.$transaction(async tx => {
      const stores = await tx.commerceStore.findMany({ where: { workspaceId: actor.workspaceId,id: query.storeId } }),ids = [];
      for (const store of stores) try { await this.stores.store(tx,actor,store.id,'COMMERCE.ORDER_VIEW'); ids.push(store.id); }
      catch (error) { if (!(error instanceof AppError) || ![403,404].includes(error.status)) throw error; }
      // Permission is still required when there are no stores.
      requirePermission(actor,'COMMERCE.ORDER_VIEW');
      const rows = await tx.commerceOrder.findMany({ where: { workspaceId: actor.workspaceId,storeId: { in: ids },status: query.status },orderBy: [{ createdAt: 'desc' },{ id: 'asc' }] });
      const visible = query.search ? rows.filter(row => row.id.includes(query.search!) || JSON.stringify(row.businessMetadata).toLowerCase().includes(query.search!.toLowerCase())) : rows;
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async get(actor: Principal,id: string,historyOnly = false) {
    return this.db.$transaction(async tx => {
      const row = await this.load(tx,actor,id,'COMMERCE.ORDER_VIEW');
      const history = await tx.commerceOrderHistory.findMany({ where: { workspaceId: actor.workspaceId,orderId: id },orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }] });
      return historyOnly ? history : { ...row,history };
    });
  }
  async update(actor: Principal,id: string,raw: unknown,action: 'UPDATE'|'CANCEL'|'ARCHIVE') {
    const input = action==='UPDATE' ? parse(z.strictObject({ expectedVersion: commerceVersion,businessMetadata: z.strictObject({ note: z.string().trim().max(2000).optional(),externalReference: z.string().trim().max(160).optional() }) }),raw)
      : action==='CANCEL' ? parse(z.strictObject({ expectedVersion: commerceVersion,reason: z.string().trim().min(1).max(2000) }),raw) : parse(z.strictObject({ expectedVersion: commerceVersion }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); await lock(tx,actor.workspaceId,'commerce:order:'+id);
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.load(tx,actor,id,action==='UPDATE' ? 'COMMERCE.ORDER_UPDATE' : action==='CANCEL' ? 'COMMERCE.ORDER_CANCEL' : 'COMMERCE.ORDER_MANAGE');
      assertCommerceVersion(row.version,input.expectedVersion);
      if (row.archivedAt) throw new AppError('COMMERCE_ORDER_INVALID_STATUS','Order is archived.',409);
      if (action==='CANCEL') {
        if (!['NEW','CONFIRMED'].includes(row.status)) throw new AppError('COMMERCE_ORDER_INVALID_STATUS','Order cannot be cancelled.',409);
        if (await tx.commerceShipment.count({ where: { workspaceId: actor.workspaceId,orderId: id,status: { not: 'CANCELLED' } } })) throw new AppError('COMMERCE_ORDER_INVALID_STATUS','Cancel active shipment allocations before cancelling the Order.',409);
        if (await tx.commerceOrderPaymentBinding.count({ where: { workspaceId: actor.workspaceId,orderId: id } })) throw new AppError('COMMERCE_ORDER_INVALID_STATUS','Reconcile payment allocations before cancelling the Order.',409);
        const allReservations = await tx.inventoryReservation.findMany({ where: { workspaceId: actor.workspaceId,sourceType: 'ORDER',sourceId: id },orderBy: { id: 'asc' } });
        if (allReservations.some(r => r.fulfilledQuantity.gt(0))) throw new AppError('COMMERCE_ORDER_INVALID_STATUS','Fulfilled stock requires a Return.',409);
        const reservations = allReservations.filter(r => ['ACTIVE','PARTIALLY_FULFILLED'].includes(r.status));
        if (reservations.length) {
          const store = await this.stores.store(tx,actor,row.storeId,'COMMERCE.ORDER_CANCEL');
          const userId = (store.settings as { inventoryPrincipalUserId?: string }).inventoryPrincipalUserId;
          if (!userId) throw new AppError('COMMERCE_STOCK_RESERVATION_FAILED','Inventory service principal is unavailable.',409);
          const inventoryActor = await resolvePrincipal(tx,actor.workspaceId,userId);
          for (const reservation of reservations) await this.reservations.releaseInTransaction(tx,inventoryActor,reservation.id,{ reason: 'Order cancellation' },'cancel:'+id+':'+reservation.id);
        }
      }
      if (action==='ARCHIVE' && !['COMPLETED','CANCELLED'].includes(row.status)) throw new AppError('COMMERCE_ORDER_INVALID_STATUS','Only terminal Orders may be archived.',409);
      const updated = await tx.commerceOrder.update({ where: { id },data: { ...('businessMetadata' in input ? { businessMetadata: input.businessMetadata as Prisma.InputJsonValue } : {}),
        ...(action==='CANCEL' ? { status: 'CANCELLED' } : {}),...(action==='ARCHIVE' ? { archivedAt: new Date() } : {}),version: { increment: 1 } } });
      await tx.commerceOrderHistory.create({ data: { workspaceId: actor.workspaceId,storeId: row.storeId,orderId: id,actorUserId: actor.userId,action,
        details: { version: updated.version.toString(),...('reason' in input && typeof input.reason==='string' ? { reason: input.reason } : {}) } } });
      await evidence(tx,actor,'COMMERCE_ORDER',id,'ORDER_'+action,{ version: updated.version.toString() }); return updated;
    },{ timeout: 60000 });
  }
}
