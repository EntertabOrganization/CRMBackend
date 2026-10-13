import { Prisma,PrismaClient } from '@prisma/client';
import { createHmac,randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommerceRefundService } from '../src/server/commerce/refund-service';
import { CommercePaymentCallbackService } from '../src/server/commerce/payment-callback-service';
import { CommercePaymentQueryService } from '../src/server/commerce/payment-query-service';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { AppError } from '../src/server/errors';
import { resetRateLimits } from '../src/server/rate-limit';
import { PaymentProviderAuthority } from '../src/server/commercial/payment-provider-authority';
import type { PaymentProviderAdapter } from '../src/server/commercial/payment-providers';
import { CommerceShipmentService } from '../src/server/commerce/shipment-service';
import { CommerceReturnService } from '../src/server/commerce/return-service';

jest.setTimeout(120000);let db:PrismaClient;
const secretsByWorkspace=new Map<string,Map<string,string>>(),providersByConnection=new Map<string,PaymentProviderAdapter>();
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_refunds_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});beforeEach(()=>resetRateLimits());
async function fixture(policy:Prisma.InputJsonObject={},snapshot:Prisma.InputJsonValue={}){
  const f=await paymentCommandFixture(db,snapshot);secretsByWorkspace.set(f.workspace.id,f.secrets);providersByConnection.set(f.connection.id,f.provider);
  // The global inbox worker may process receipts from earlier test Workspaces.
  // Its sandbox credential authority must support every owned fixture, just as
  // the production shared SecretPort does, without borrowing the newest fixture.
  const authority=new PaymentProviderAuthority({resolve:(ws,ref)=>secretsByWorkspace.get(ws)?.get(ref)??null},method=>providersByConnection.get(method.connectionId)!);
  const callbacks=new CommercePaymentCallbackService(db,undefined,authority),refunds=new CommerceRefundService(db,undefined,authority);
  await db.commerceStore.update({where:{id:f.store.id},data:{settings:{...f.store.settings as object,refundPolicy:policy}}});
  const payment=await f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'100',mode:'SALE'},randomUUID());await f.service.process(payment.commandId);
  const record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:payment.paymentId}}),transactionId=(record.data as {providerTransactionId:string}).providerTransactionId;
  f.provider.settle(transactionId,'SUCCEEDED');
  const approverUser=await db.user.create({data:{firstName:'Finance',lastName:'Approver',email:randomUUID()+'@example.test',status:'ACTIVE'}});await db.workspaceMembership.create({data:{workspaceId:f.workspace.id,userId:approverUser.id,roleId:f.role.id}});
  const approver=await resolvePrincipal(db,f.workspace.id,approverUser.id),at=Math.floor(Date.now()/1000);
  const result={...f,callbacks,refunds,payment,transactionId,approver,approverUser,at};
  await deliver(result,{id:'evt_'+randomUUID(),created:at,account:'merchant-test',type:'payment_intent.succeeded',data:{object:{id:transactionId,object:'payment_intent',status:'succeeded',amount:10000,amount_received:10000,amount_capturable:0,currency:'egp'}}});
  return result;
}
type F=Awaited<ReturnType<typeof fixture>>;
function proof(f:{connection:{id:string};secrets:Map<string,string>},raw:string){const at=Math.floor(Date.now()/1000),secret=JSON.parse(f.secrets.get('test-payment-bundle')!).webhookSecret;return new Headers({'x-payment-connection-id':f.connection.id,'stripe-signature':'t='+at+',v1='+createHmac('sha256',secret).update(at+'.'+raw).digest('hex')});}
async function deliver(f:{callbacks:CommercePaymentCallbackService;connection:{id:string};secrets:Map<string,string>},event:unknown){const raw=JSON.stringify(event),ack=await f.callbacks.receive('stripe',proof(f,raw),raw);await db.sharedPaymentProviderEvent.update({where:{id:ack.eventId},data:{nextAttemptAt:new Date(Date.now()-1000)}});await f.callbacks.tick();return ack;}
const create=(f:F,amount='25',key=randomUUID(),extra:object={})=>f.refunds.create(f.actor,f.order.id,{paymentId:f.payment.paymentId,amount,reason:'Customer refund',...extra},key);
async function approved(f:F,amount='25'){const refund=await create(f,amount);return f.refunds.approve(f.approver,refund.id,{expectedVersion:refund.version,decision:'APPROVE',reason:'Verified captured funds'});}
async function queued(f:F,amount='25'){const refund=await approved(f,amount),ack=await f.refunds.process(f.actor,refund.id,{expectedVersion:refund.version},randomUUID());return{refund,ack};}
function refundEvent(f:F,r:{id:string;amount:string},commandId:string,status='succeeded',externalId?:string,at=f.at){
  const effect=f.provider.refundEffects.get('refund-command:'+commandId);
  return{id:'evt_'+randomUUID(),created:at,account:'merchant-test',type:status==='failed'?'refund.failed':'refund.updated',request:{idempotency_key:'refund-command:'+commandId},data:{object:{id:externalId??effect?.refundId??'re_external_'+commandId,object:'refund',payment_intent:f.transactionId,amount:Number(r.amount)*100,currency:'egp',status,metadata:{truecrm_refund_id:r.id}}}};
}
async function revoke(f:F,key:string){const p=await db.permission.findUniqueOrThrow({where:{key}});await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:{isDeleted:true}});}
describe('Commerce refunds and owning shared financial lifecycle',()=>{
  it('permits money settlement under physical-Return-required policy only after real receipt and Inventory inspection',async()=>{
    const productId=randomUUID(),lineId=randomUUID(),f=await fixture({allowWithoutReturn:false},{lines:[{itemId:lineId,productId,variantId:null,inventoryKey:productId,quantity:'1',name:'Merchandise',stockable:true}]}),shipments=new CommerceShipmentService(db);
    const unit=await db.catalogUnit.create({data:{workspaceId:f.workspace.id,code:'EA',name:'Each',precision:0}});
    await db.catalogProduct.create({data:{id:productId,workspaceId:f.workspace.id,catalogId:f.store.catalogId,type:'SIMPLE_PRODUCT',name:'Merchandise',sku:'SKU',skuKey:'sku',primaryUnitId:unit.id}});
    const warehouse=await shipments.warehouses.create(f.actor,{name:'Main',code:'MAIN',type:'PHYSICAL',timezone:'Africa/Cairo'});
    const receipt=await shipments.documents.create(f.actor,{documentType:'STOCK_RECEIPT',warehouseIds:{destination:warehouse.id},currency:'EGP'}),line=await shipments.documents.line(f.actor,receipt.id,{productId,quantity:'1',unitCost:'2'}) as {documentVersion:string};
    await shipments.documents.process(f.actor,receipt.id,{expectedVersion:line.documentVersion},randomUUID());
    const current=await db.commerceStore.findUniqueOrThrow({where:{id:f.store.id}});await db.commerceStore.update({where:{id:f.store.id},data:{defaultWarehouseId:warehouse.id,settings:{...current.settings as object,inventoryPrincipalUserId:f.user.id}}});
    const reservation=await shipments.reservations.create(f.actor,{sourceType:'ORDER',sourceId:f.order.id,productId,quantity:'1',warehouseId:warehouse.id},randomUUID());
    await db.commerceOrderLineReservation.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,orderLineId:lineId,reservationId:reservation.id,inventoryKey:productId,quantity:'1'}});
    const delivery=await shipments.deliveryServices(f.actor,f.store.id,{type:'PICKUP',rates:[{price:'0',currency:'EGP',estimatedDaysMin:0,estimatedDaysMax:0}]}) as {id:string};
    const shipment=await shipments.create(f.actor,f.order.id,{warehouseId:warehouse.id,deliveryServiceId:delivery.id,items:[{orderLineId:lineId,quantity:'1'}]},randomUUID());await shipments.transition(f.actor,shipment.id,{expectedVersion:shipment.version.toString()},randomUUID(),'SHIP');await shipments.transition(f.actor,shipment.id,{trackingEvidence:{reference:'Delivered',deliveredAt:new Date().toISOString()}},randomUUID(),'DELIVER');
    const returns=new CommerceReturnService(db),returned=await returns.create(f.actor,f.order.id,{items:[{orderLineId:lineId,quantity:'1'}],reason:'Returned item'},randomUUID());
    await expect(create(f,'25',randomUUID(),{returnId:returned.id})).rejects.toMatchObject({code:'REFUND_APPROVAL_REQUIRED'});
    await returns.approve(f.actor,returned.id,{expectedVersion:'1',decision:'APPROVE'});await returns.receive(f.actor,returned.id,{receivedLines:[{orderLineId:lineId,quantity:'1'}]},randomUUID());await returns.inspect(f.actor,returned.id,{dispositions:[{orderLineId:lineId,disposition:'SELLABLE',warehouseId:warehouse.id}]},randomUUID());
    const requested=await create(f,'100',randomUUID(),{returnId:returned.id}),approved=await f.refunds.approve(f.approver,requested.id,{expectedVersion:requested.version,decision:'APPROVE',reason:'Returned merchandise'}),ack=await f.refunds.process(f.actor,approved.id,{expectedVersion:approved.version},randomUUID());
    await f.refunds.processCommand(ack.jobId);await deliver(f,refundEvent(f,approved,ack.jobId));expect((await f.refunds.get(f.actor,approved.id)).status).toBe('SUCCEEDED');
    expect(await db.commerceOrder.findUnique({where:{id:f.order.id}})).toMatchObject({fulfillmentStatus:'RETURNED',paymentStatus:'REFUNDED',status:'PROCESSING'});
    expect((await db.inventoryBalance.findFirstOrThrow({where:{workspaceId:f.workspace.id,warehouseId:warehouse.id}})).onHand.eq(1)).toBe(true);
  });
  it('serves all four actual Nest routes plus Next dispatch with strict DTOs and durable financial effects',async()=>{
    const f=await fixture(),{Module}=await import('@nestjs/common'),{NestFactory}=await import('@nestjs/core'),{PackRouter}=await import('../src/server/process-platform/http'),{nestControllers,configurePackBodyParsing}=await import('../src/server/process-platform/nest-adapter'),{signAccessToken}=await import('../src/server/security');
    const router=new PackRouter().add('POST','/api/v1/commerce/orders/:orderId/refunds','CommerceRefundsController',c=>f.refunds.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),201).add('GET','/api/v1/commerce/refunds/:refundId','CommerceRefundsController',c=>f.refunds.get(c.actor,c.params.refundId)).add('POST','/api/v1/commerce/refunds/:refundId/approve','CommerceRefundsController',c=>f.refunds.approve(c.actor,c.params.refundId,c.body)).add('POST','/api/v1/commerce/refunds/:refundId/process','CommerceRefundsController',c=>f.refunds.process(c.actor,c.params.refundId,c.body,c.request.headers.get('idempotency-key')),202);
    class RefundHttpModule{}Module({controllers:nestControllers(router)})(RefundHttpModule);const app=await NestFactory.create(RefundHttpModule,{logger:false,bodyParser:false});configurePackBodyParsing(app as never);
    const auth={authorization:'Bearer '+await signAccessToken(f.user.id),'x-workspace-id':f.workspace.id,'content-type':'application/json'},approverAuth={...auth,authorization:'Bearer '+await signAccessToken(f.approverUser.id)};let refundId='';
    try{await app.listen(0,'127.0.0.1');const base=await app.getUrl(),createPath=base+'/api/v1/commerce/orders/'+f.order.id+'/refunds';
      expect((await fetch(createPath,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
      expect((await fetch(createPath,{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({paymentId:f.payment.paymentId,amount:'25',reason:'Refund',status:'SUCCEEDED'})})).status).toBe(400);
      const created=await fetch(createPath,{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({paymentId:f.payment.paymentId,amount:'25',reason:'Refund'})});expect(created.status).toBe(201);const r=(await created.json()).data;refundId=r.id;
      const path=base+'/api/v1/commerce/refunds/'+r.id;expect((await fetch(path,{headers:auth})).status).toBe(200);
      expect((await fetch(path+'/approve',{method:'POST',headers:auth,body:JSON.stringify({expectedVersion:r.version,decision:'APPROVE',reason:'Self'})})).status).toBe(403);
      const approved=await fetch(path+'/approve',{method:'POST',headers:approverAuth,body:JSON.stringify({expectedVersion:r.version,decision:'APPROVE',reason:'Financial review'})});expect(approved.status).toBe(200);const a=(await approved.json()).data;
      const processed=await fetch(path+'/process',{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({expectedVersion:a.version})});expect(processed.status).toBe(202);const ack=(await processed.json()).data;
      expect(ack.status).toBe('QUEUED');await f.refunds.processCommand(ack.jobId);await deliver(f,refundEvent(f,a,ack.jobId));expect((await f.refunds.get(f.actor,r.id)).status).toBe('SUCCEEDED');
    }finally{await app.close();}
    const {NextRequest}=await import('next/server'),{commerceRouter,commerceRefunds}=await import('../src/server/commerce/routes'),spy=jest.spyOn(commerceRefunds,'get').mockImplementation((...args)=>f.refunds.get(...args));
    try{expect((await commerceRouter.dispatch(new NextRequest('http://local.test/api/v1/commerce/refunds/'+refundId,{headers:auth}))).status).toBe(200);}finally{spy.mockRestore();}
    const {processCommercePaths}=await import('../src/server/openapi-process-commerce');for(const path of ['/commerce/orders/{orderId}/refunds','/commerce/refunds/{refundId}','/commerce/refunds/{refundId}/approve','/commerce/refunds/{refundId}/process'])expect(processCommercePaths()[path]).toBeDefined();
  });
  it('reserves pending funds durably and permits exactly one concurrent request for remaining funds',async()=>{
    const f=await fixture(),key=randomUUID(),r=await create(f,'60',key);expect(r.status).toBe('PENDING_APPROVAL');expect(await create(f,'60',key)).toEqual(r);
    await expect(create(f,'61',key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
    const race=await Promise.allSettled([create(f,'40'),create(f,'40')]);expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(race.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'REFUND_AMOUNT_EXCEEDED'}});
    expect(await db.commercialPackRecord.count({where:{workspaceId:f.workspace.id,collection:'refunds'}})).toBe(2);
    expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'REFUND_REQUESTED'}})).toBe(2);
    await db.idempotencyRecord.deleteMany({where:{workspaceId:f.workspace.id}});expect(await create(f,'60',key)).toEqual(r);
  });
  it('requires separate default approval, refuses self-approval and enforces optimistic concurrency',async()=>{
    const f=await fixture(),r=await create(f);
    await expect(f.refunds.approve(f.actor,r.id,{expectedVersion:r.version,decision:'APPROVE',reason:'Self'})).rejects.toMatchObject({code:'REFUND_APPROVAL_REQUIRED',status:403});
    await expect(f.refunds.process(f.actor,r.id,{expectedVersion:r.version},randomUUID())).rejects.toMatchObject({code:'REFUND_APPROVAL_REQUIRED'});
    await expect(f.refunds.approve(f.approver,r.id,{expectedVersion:'2',decision:'APPROVE',reason:'Stale'})).rejects.toMatchObject({code:'RESOURCE_VERSION_CONFLICT'});
    await revoke(f,'COMMERCE.REFUND_APPROVE');await expect(f.refunds.approve(f.approver,r.id,{expectedVersion:r.version,decision:'APPROVE',reason:'Denied'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(await db.commerceRefundApproval.count({where:{refundId:r.id}})).toBe(0);expect(await db.sharedRefundCommand.count({where:{refundId:r.id}})).toBe(0);
  });
  it('pins configurable thresholds and rejection releases the financial hold without provider effects',async()=>{
    const f=await fixture({approvalThreshold:'30'}),small=await create(f,'25');expect(small.status).toBe('APPROVED');expect(small.requiresApproval).toBe(false);
    const large=await create(f,'75');expect(large.status).toBe('PENDING_APPROVAL');
    await db.commerceStore.update({where:{id:f.store.id},data:{settings:{...f.store.settings as object,refundPolicy:{allowSelfApproval:true,approvalThreshold:'100'}}}});
    await expect(f.refunds.approve(f.actor,large.id,{expectedVersion:large.version,decision:'APPROVE',reason:'Changed policy'})).rejects.toMatchObject({code:'REFUND_APPROVAL_REQUIRED'});
    expect((await f.refunds.approve(f.approver,large.id,{expectedVersion:large.version,decision:'REJECT',reason:'Financial review rejected'})).status).toBe('CANCELLED');
    expect((await create(f,'75')).status).toBe('APPROVED');expect(f.provider.refundEffects.size).toBe(0);
  });
  it('confirms a partial Refund exactly once without rewriting the original Payment or Inventory',async()=>{
    const f=await fixture(),before=await db.commercialPackRecord.findUniqueOrThrow({where:{id:f.payment.paymentId}}),{refund,ack}=await queued(f,'25');
    const race=await Promise.all([f.refunds.processCommand(ack.jobId),f.refunds.processCommand(ack.jobId)]);expect(race.filter(Boolean)).toHaveLength(1);expect(f.provider.refundEffects.size).toBe(1);
    expect((await f.refunds.get(f.actor,refund.id)).status).toBe('PROCESSING');
    const event=refundEvent(f,refund,ack.jobId),receipt=await deliver(f,event);expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:receipt.eventId}})).status).toBe('SUCCEEDED');
    expect((await deliver(f,event)).duplicate).toBe(true);await deliver(f,{...event,id:'evt_'+randomUUID()});
    const result=await f.refunds.get(f.actor,refund.id);expect(result).toMatchObject({status:'SUCCEEDED',amount:'25.000000',command:{status:'SUCCEEDED',uncertain:false}});
    const after=await db.commercialPackRecord.findUniqueOrThrow({where:{id:f.payment.paymentId}});expect(after.data).toEqual(before.data);
    expect(await db.commerceOrder.findUnique({where:{id:f.order.id}})).toMatchObject({paymentStatus:'PARTIALLY_REFUNDED',paidAmount:expect.anything(),refundedAmount:expect.anything()});
    const order=await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}});expect(order.paidAmount.toFixed(6)).toBe('75.000000');expect(order.refundedAmount.toFixed(6)).toBe('25.000000');
    expect((await new CommercePaymentQueryService(db).get(f.actor,f.payment.paymentId)).netSettledAmount).toBe('75.000000');
    expect(await db.outboxEvent.count({where:{entityId:refund.id,eventType:'REFUND_COMPLETED'}})).toBe(1);expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id}})).toBe(0);
    expect(await f.refunds.processCommand(ack.jobId)).toBe(false);expect(f.provider.refundEffects.size).toBe(1);
  });
  it('full Refund updates net Order projection and leaves the snapshot and captured Payment immutable',async()=>{
    const f=await fixture(),snapshot=f.order.snapshot,{refund,ack}=await queued(f,'100');await f.refunds.processCommand(ack.jobId);await deliver(f,refundEvent(f,refund,ack.jobId));
    const order=await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}});expect(order.paymentStatus).toBe('REFUNDED');expect(order.paidAmount.eq(0)).toBe(true);expect(order.snapshot).toEqual(snapshot);
    await expect(create(f,'0.01')).rejects.toMatchObject({code:'REFUND_AMOUNT_EXCEEDED'});
    expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:f.payment.paymentId}})).data).toMatchObject({capturedAmount:'100.000000',amount:'100.000000'});
  });
  it('supports pending/requires_action facts and rejects mismatched proof without financial mutation',async()=>{
    const f=await fixture(),{refund,ack}=await queued(f);await f.refunds.processCommand(ack.jobId);
    const pending=await deliver(f,refundEvent(f,refund,ack.jobId,'requires_action'));expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:pending.eventId}})).status).toBe('SUCCEEDED');expect((await f.refunds.get(f.actor,refund.id)).status).toBe('PROCESSING');
    const bad=refundEvent(f,refund,ack.jobId);bad.data.object.amount=3000;const receipt=await deliver(f,bad);expect(await db.sharedPaymentProviderEvent.findUnique({where:{id:receipt.eventId}})).toMatchObject({status:'QUEUED',errorCode:'PAYMENT_PROVIDER_TRANSACTION_MISMATCH'});
    expect((await f.refunds.get(f.actor,refund.id)).status).toBe('PROCESSING');expect((await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).paidAmount.eq(100)).toBe(true);
  });
  it('recovers a lost acknowledgment using signed correlation without resending completed money effects',async()=>{
    const f=await fixture(),{refund,ack}=await queued(f),original=f.provider.refund.bind(f.provider);
    const spy=jest.spyOn(f.provider,'refund').mockImplementation(async input=>{await original(input);throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Lost acknowledgment',503);});
    expect(await f.refunds.processCommand(ack.jobId)).toBe(false);spy.mockRestore();expect(await db.sharedRefundCommand.findUnique({where:{id:ack.jobId}})).toMatchObject({status:'QUEUED',uncertain:true});expect((await f.refunds.get(f.actor,refund.id)).providerRefundId).toBeNull();
    await deliver(f,refundEvent(f,refund,ack.jobId));expect((await f.refunds.get(f.actor,refund.id)).status).toBe('SUCCEEDED');expect(await f.refunds.processCommand(ack.jobId)).toBe(false);expect(f.provider.refundEffects.size).toBe(1);
  });
  it('keeps exhausted ambiguous requests held and accepts eventual signed terminal facts',async()=>{
    const f=await fixture(),{refund,ack}=await queued(f,'80'),original=f.provider.refund.bind(f.provider),spy=jest.spyOn(f.provider,'refund').mockImplementation(async input=>{await original(input);throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Timeout',503);});
    for(let i=0;i<5;i++){await db.sharedRefundCommand.update({where:{id:ack.jobId},data:{nextAttemptAt:new Date(Date.now()-1000)}});expect(await f.refunds.processCommand(ack.jobId)).toBe(false);}spy.mockRestore();
    expect(await db.sharedRefundCommand.findUnique({where:{id:ack.jobId}})).toMatchObject({status:'FAILED',uncertain:true,attempts:5});expect(f.provider.refundEffects.size).toBe(1);
    await expect(create(f,'21')).rejects.toMatchObject({code:'REFUND_AMOUNT_EXCEEDED'});await deliver(f,refundEvent(f,refund,ack.jobId));expect((await f.refunds.get(f.actor,refund.id)).status).toBe('SUCCEEDED');
  });
  it('verified failure releases its hold, while stale failure cannot downgrade verified success',async()=>{
    const f=await fixture(),{refund,ack}=await queued(f,'100');await f.refunds.processCommand(ack.jobId);await deliver(f,refundEvent(f,refund,ack.jobId,'failed'));
    expect((await f.refunds.get(f.actor,refund.id)).status).toBe('FAILED');expect((await create(f,'100')).status).toBe('PENDING_APPROVAL');
    const g=await fixture(),q=await queued(g);await g.refunds.processCommand(q.ack.jobId);await deliver(g,refundEvent(g,q.refund,q.ack.jobId));await deliver(g,refundEvent(g,q.refund,q.ack.jobId,'failed',undefined,g.at+1));
    expect((await g.refunds.get(g.actor,q.refund.id)).status).toBe('SUCCEEDED');
  });
  it('enforces policy requiring a physical Return and tenant/Store/Payment authorization',async()=>{
    const f=await fixture({allowWithoutReturn:false});await expect(create(f)).rejects.toMatchObject({code:'REFUND_APPROVAL_REQUIRED'});
    const g=await fixture(),h=await fixture(),r=await create(g);await expect(h.refunds.get(h.actor,r.id)).rejects.toMatchObject({code:'REFUND_NOT_FOUND'});
    await expect(g.refunds.create(g.actor,g.order.id,{paymentId:h.payment.paymentId,amount:'1',reason:'Foreign'},randomUUID())).rejects.toMatchObject({code:'PAYMENT_NOT_FOUND'});
    await expect(g.refunds.create(g.actor,g.order.id,{paymentId:g.payment.paymentId,amount:'1',reason:'Privileged',workspaceId:g.workspace.id},randomUUID())).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
    await revoke(g,'COMMERCE.REFUND_VIEW');await expect(g.refunds.get(g.actor,r.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await revoke(g,'payment.refund');await expect(create(g,'1')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('rechecks worker grants, current memberships and exact provider binding before external effects',async()=>{
    const f=await fixture(),{refund,ack}=await queued(f);await revoke(f,'COMMERCE.REFUND_PROCESS');expect(await f.refunds.processCommand(ack.jobId)).toBe(false);expect(f.provider.refundEffects.size).toBe(0);expect((await f.refunds.get(f.actor,refund.id)).status).toBe('FAILED');
    const g=await fixture(),q=await queued(g);await db.workspaceMembership.updateMany({where:{workspaceId:g.workspace.id,userId:g.user.id},data:{isDeleted:true}});expect(await g.refunds.processCommand(q.ack.jobId)).toBe(false);expect(g.provider.refundEffects.size).toBe(0);
  });
  it('durably replays processing keys and rejects stale versions or duplicate commands',async()=>{
    const f=await fixture(),r=await approved(f),key=randomUUID(),input={expectedVersion:r.version};
    const ack=await f.refunds.process(f.actor,r.id,input,key);expect(await f.refunds.process(f.actor,r.id,input,key)).toEqual(ack);
    await expect(f.refunds.process(f.actor,r.id,{expectedVersion:'1'},key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
    await expect(f.refunds.process(f.actor,r.id,input,randomUUID())).rejects.toMatchObject({code:'RESOURCE_VERSION_CONFLICT'});expect(await db.sharedRefundCommand.count({where:{refundId:r.id}})).toBe(1);
  });
  it('enforces database financial limits and immutable amount, binding, approval and request evidence',async()=>{
    const f=await fixture(),r=await approved(f,'80'),record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:r.id}});
    await expect(db.commercialPackRecord.update({where:{id:r.id},data:{data:{...record.data as object,amount:'81'}}})).rejects.toThrow();
    await expect(db.commerceRefundApproval.deleteMany({where:{refundId:r.id}})).rejects.toThrow();await expect(db.commerceRefundRequest.deleteMany({where:{workspaceId:f.workspace.id}})).rejects.toThrow();
    const id=randomUUID();await expect(db.commercialPackRecord.create({data:{id,workspaceId:f.workspace.id,collection:'refunds',data:{...record.data as object,id,amount:'21',status:'PENDING_APPROVAL'}}})).rejects.toThrow();
    expect(await db.commercialPackRecord.count({where:{workspaceId:f.workspace.id,collection:'refunds'}})).toBe(1);
    const safe=await f.refunds.get(f.actor,r.id);expect(JSON.stringify(safe)).not.toMatch(/apiKey|webhookSecret|providerPayload|clientSecret|requestedByUserId/);
  });
});
