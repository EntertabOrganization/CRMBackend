import { PrismaClient } from '@prisma/client';
import { createHmac,randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommercePaymentCallbackService } from '../src/server/commerce/payment-callback-service';
import { CommercePaymentQueryService } from '../src/server/commerce/payment-query-service';
import { InventoryWarehouseService } from '../src/server/inventory/warehouse-service';
import { AppError } from '../src/server/errors';

jest.setTimeout(120000);let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_payment_callbacks_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});afterEach(()=>jest.restoreAllMocks());
async function fixture(snapshot:Record<string,unknown>={}){const f=await paymentCommandFixture(db,snapshot as never);return{...f,callbacks:new CommercePaymentCallbackService(db,undefined,f.authority),at:Math.floor(Date.now()/1000)-30};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function pending(f:Fixture,amount='100',mode:'SALE'|'AUTHORIZE'='AUTHORIZE'){
 const command=await f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount,mode},randomUUID());await f.service.process(command.commandId);
 const record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}});return{...command,transactionId:(record.data as {providerTransactionId:string}).providerTransactionId};
}
function event(f:Fixture,id:string,captured=0,remaining=100,options:{eventId?:string;at?:number;amount?:number;status?:string;type?:string;key?:string;metadata?:unknown}={}){
 return{id:options.eventId??'evt_'+randomUUID(),created:options.at??f.at,account:'merchant-test',type:options.type??(captured===remaining&&remaining===0?'payment_intent.canceled':remaining>0?'payment_intent.amount_capturable_updated':'payment_intent.succeeded'),
  request:options.key?{idempotency_key:'payment-command:'+options.key}:null,data:{object:{id,currency:'egp',amount:(options.amount??100)*100,amount_received:captured*100,amount_capturable:remaining*100,status:options.status??(remaining>0?'requires_capture':captured>0?'succeeded':'canceled'),metadata:options.metadata??{}}}};
}
function headers(f:Fixture,raw:string,timestamp=Math.floor(Date.now()/1000)){
 const secret=JSON.parse(f.secrets.get('test-payment-bundle')!).webhookSecret as string,signature=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
 return new Headers({'x-payment-connection-id':f.connection.id,'stripe-signature':'t='+timestamp+',v1='+signature});
}
async function receive(f:Fixture,payload:unknown){const raw=JSON.stringify(payload,null,2),ack=await f.callbacks.receive('stripe',headers(f,raw),raw);await due(ack.eventId);return ack;}
async function authorize(f:Fixture){const payment=await pending(f);f.provider.authorize(payment.transactionId);await receive(f,event(f,payment.transactionId));await f.callbacks.tick();return payment;}
async function due(eventId:string){await db.sharedPaymentProviderEvent.update({where:{id:eventId},data:{nextAttemptAt:new Date(Date.now()-1000)}});}

describe('Changed signed payment receipts and atomic confirmation',()=>{
 it('rejects tampering, expired signatures, unknown connections and merchant mismatch before storing receipts',async()=>{
  const f=await fixture(),p=await pending(f),raw=JSON.stringify(event(f,p.transactionId));
  await expect(f.callbacks.receive('stripe',headers(f,raw),raw+' ')).rejects.toMatchObject({code:'PAYMENT_PROVIDER_SIGNATURE_INVALID'});
  await expect(f.callbacks.receive('stripe',headers(f,raw,Math.floor(Date.now()/1000)-301),raw)).rejects.toMatchObject({code:'PAYMENT_PROVIDER_SIGNATURE_INVALID'});
  const unknown=headers(f,raw);unknown.set('x-payment-connection-id',randomUUID());await expect(f.callbacks.receive('stripe',unknown,raw)).rejects.toMatchObject({code:'PAYMENT_PROVIDER_SIGNATURE_INVALID'});
  const wrong={...event(f,p.transactionId),account:'wrong-merchant'};await expect(receive(f,wrong)).rejects.toMatchObject({code:'PAYMENT_PROVIDER_SIGNATURE_INVALID'});
  expect(await db.sharedPaymentProviderEvent.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('deduplicates reformatted signed retries, rejects payload conflicts and consumes one receipt concurrently',async()=>{
  const f=await fixture(),p=await pending(f),payload=event(f,p.transactionId),a=await receive(f,payload),raw=JSON.stringify(payload);
  expect(await f.callbacks.receive('stripe',headers(f,raw),raw)).toMatchObject({eventId:a.eventId,duplicate:true});
  await expect(receive(f,{...payload,data:{object:{...payload.data.object,metadata:{changed:true}}}})).rejects.toMatchObject({code:'PAYMENT_DUPLICATE_EVENT'});
  const [x,y]=await Promise.all([f.callbacks.tick(),f.callbacks.tick()]);expect(x.processed+y.processed).toBe(1);
  expect(await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:a.eventId}})).toMatchObject({status:'SUCCEEDED',attempts:1,outcome:'APPLIED',paymentId:p.paymentId});
  expect((await new CommercePaymentQueryService(db).get(f.actor,p.paymentId)).status).toBe('AUTHORIZED');
  expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'PAYMENT_AUTHORIZED'}})).toBe(1);
 });
 it('confirms two partial captures, clears exact commands and publishes ORDER_PAID once',async()=>{
  const f=await fixture(),p=await authorize(f),first=await f.service.change(f.actor,p.paymentId,'CAPTURE',{amount:'60'},randomUUID());await f.service.process(first.commandId);
  await receive(f,event(f,p.transactionId,60,40,{at:f.at+1,key:first.commandId}));await f.callbacks.tick();
  expect(await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:first.commandId}})).toMatchObject({status:'SUCCEEDED',uncertain:false});
  expect(await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).toMatchObject({paymentStatus:'PARTIALLY_PAID',paidAmount:expect.anything(),status:'NEW'});
  const second=await f.service.change(f.actor,p.paymentId,'CAPTURE',{amount:'40'},randomUUID());await f.service.process(second.commandId);await receive(f,event(f,p.transactionId,100,0,{at:f.at+2,key:second.commandId}));await f.callbacks.tick();
  const order=await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}});expect(order.paymentStatus).toBe('PAID');expect(order.paidAmount.toFixed(6)).toBe('100.000000');expect(order.status).toBe('NEW');
  expect((await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:second.commandId}})).baselineCapturedAmount.toFixed(6)).toBe('60.000000');
  await receive(f,event(f,p.transactionId,100,0,{at:f.at+3}));await f.callbacks.tick();expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_PAID'}})).toBe(1);
 });
 it('derives split payment coverage without creating stock movements',async()=>{
  const f=await fixture(),a=await pending(f,'20','SALE'),b=await pending(f,'80','SALE');
  f.provider.settle(a.transactionId,'SUCCEEDED');await receive(f,event(f,a.transactionId,20,0,{amount:20}));await f.callbacks.tick();
  expect((await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).paidAmount.toFixed(6)).toBe('20.000000');
  f.provider.settle(b.transactionId,'SUCCEEDED');await receive(f,event(f,b.transactionId,80,0,{amount:80}));await f.callbacks.tick();
  expect((await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).paymentStatus).toBe('PAID');expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('completes previously delivered fulfillment after payment and never invents fulfillment',async()=>{
  const lineId=randomUUID(),f=await fixture({lines:[{itemId:lineId,quantity:'1',stockable:false}],paymentMethodId:'COD'}),p=await pending(f,'100','SALE');
  const warehouse=await new InventoryWarehouseService(db).create(f.actor,{name:'Existing delivery',code:'DELIVERED',type:'PHYSICAL',timezone:'Africa/Cairo'});
  const delivery=await db.commerceDeliveryService.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,type:'DIGITAL'}});
  const shipment=await db.commerceShipment.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,warehouseId:warehouse.id,deliveryServiceId:delivery.id,status:'DELIVERED',shippedAt:new Date(Date.now()-1000),deliveredAt:new Date()}});
  await db.commerceShipmentItem.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,shipmentId:shipment.id,orderLineId:lineId,quantity:'1'}});
  await receive(f,event(f,p.transactionId,100,0));await f.callbacks.tick();expect((await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).status).toBe('COMPLETED');
 });
 it('ignores old/regressive facts while retaining captured funds and receipt evidence',async()=>{
  const f=await fixture(),p=await authorize(f);await receive(f,event(f,p.transactionId,60,40,{at:f.at+2}));await f.callbacks.tick();
  const stale=await receive(f,event(f,p.transactionId,0,100,{at:f.at+1}));await f.callbacks.tick();expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:stale.eventId}})).outcome).toBe('IGNORED');
  const failed=await receive(f,event(f,p.transactionId,0,0,{at:f.at+3,status:'requires_payment_method',type:'payment_intent.payment_failed'}));await f.callbacks.tick();expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:failed.eventId}})).outcome).toBe('IGNORED');
  expect((await new CommercePaymentQueryService(db).get(f.actor,p.paymentId)).capturedAmount).toBe('60.000000');
 });
 it('confirms void without fabricating paid funds and blocks late authorization resurrection',async()=>{
  const f=await fixture(),p=await authorize(f),voided=await f.service.change(f.actor,p.paymentId,'VOID',{reason:'Cancel'},randomUUID());await f.service.process(voided.commandId);
  await receive(f,event(f,p.transactionId,0,0,{at:f.at+1,key:voided.commandId}));await f.callbacks.tick();expect((await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:voided.commandId}})).status).toBe('SUCCEEDED');
  expect((await new CommercePaymentQueryService(db).get(f.actor,p.paymentId)).status).toBe('VOIDED');
  const late=await receive(f,event(f,p.transactionId,0,100,{at:f.at+2}));await f.callbacks.tick();expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:late.eventId}})).outcome).toBe('IGNORED');
 });
 it('records payment failure without paid allocation and permits a new attempt',async()=>{
  const f=await fixture(),p=await pending(f),failed=await receive(f,event(f,p.transactionId,0,0,{status:'requires_payment_method',type:'payment_intent.payment_failed'}));await f.callbacks.tick();
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:failed.eventId}})).status).toBe('SUCCEEDED');expect((await new CommercePaymentQueryService(db).get(f.actor,p.paymentId)).status).toBe('FAILED');
  expect((await f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'100',mode:'SALE'},randomUUID())).paymentId).not.toBe(p.paymentId);
 });
 it('rechecks explicit service-principal grants with bounded failures despite owner role',async()=>{
  const f=await fixture(),p=await pending(f),received=await receive(f,event(f,p.transactionId,100,0)),permission=await db.permission.findUniqueOrThrow({where:{key:'payment.provider_confirm'}});
  await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:permission.id}},data:{isDeleted:true}});
  for(let i=0;i<5;i++){await due(received.eventId);await f.callbacks.tick();}
  expect(await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:received.eventId}})).toMatchObject({status:'FAILED',attempts:5,errorCode:'PERMISSION_DENIED'});
  expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:p.paymentId}})).data).toMatchObject({capturedAmount:'0',financialState:'PENDING'});
 });
 it('keeps unknown transaction receipts durable for mapping recovery and tenant isolated',async()=>{
  const f=await fixture(),p=await pending(f),original=await db.commercialPackRecord.findUniqueOrThrow({where:{id:p.paymentId}});
  const other=await fixture(),wrong=await receive(other,event(other,p.transactionId,100,0));for(let i=0;i<5;i++){await due(wrong.eventId);await other.callbacks.tick();}
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:wrong.eventId}})).errorCode).toBe('PAYMENT_NOT_FOUND');expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:p.paymentId}})).data).toEqual(original.data);
 });
 it('recovers a signed receipt received before a lost create response was mapped locally',async()=>{
  const f=await fixture(),command=await f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'100',mode:'SALE'},randomUUID()),native=f.provider.createPaymentAttempt.bind(f.provider);
  jest.spyOn(f.provider,'createPaymentAttempt').mockImplementationOnce(async input=>{await native(input);throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Lost response.',503);});await f.service.process(command.commandId);
  const transactionId='stripe_payment-command:'+command.commandId;f.provider.settle(transactionId,'SUCCEEDED');const received=await receive(f,event(f,transactionId,100,0));await f.callbacks.tick();
  expect(await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:received.eventId}})).toMatchObject({status:'QUEUED',errorCode:'PAYMENT_NOT_FOUND'});
  await db.sharedPaymentCommand.update({where:{id:command.commandId},data:{nextAttemptAt:new Date(Date.now()-1000)}});await f.service.process(command.commandId);await due(received.eventId);await f.callbacks.tick();
  expect(await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:received.eventId}})).toMatchObject({status:'SUCCEEDED',attempts:2,paymentId:command.paymentId});
  expect((await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).paymentStatus).toBe('PAID');
 });
 it('retains earlier captured funds when a correlated later capture fails',async()=>{
  const f=await fixture(),p=await authorize(f),a=await f.service.change(f.actor,p.paymentId,'CAPTURE',{amount:'60'},randomUUID());await f.service.process(a.commandId);await receive(f,event(f,p.transactionId,60,40,{at:f.at+1,key:a.commandId}));await f.callbacks.tick();
  const b=await f.service.change(f.actor,p.paymentId,'CAPTURE',{amount:'40'},randomUUID());jest.spyOn(f.provider,'capture').mockRejectedValueOnce(new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Uncertain capture response.',503));await f.service.process(b.commandId);
  await receive(f,event(f,p.transactionId,60,0,{at:f.at+2,key:b.commandId,type:'payment_intent.payment_failed',status:'requires_payment_method'}));await f.callbacks.tick();
  expect(await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:b.commandId}})).toMatchObject({status:'FAILED',uncertain:false});expect((await new CommercePaymentQueryService(db).get(f.actor,p.paymentId)).capturedAmount).toBe('60.000000');
 });
 it('records late real capture after replacement payment without overallocating the Order',async()=>{
  const f=await fixture(),old=await pending(f,'100','SALE');await receive(f,event(f,old.transactionId,0,0,{type:'payment_intent.payment_failed',status:'requires_payment_method'}));await f.callbacks.tick();
  const replacement=await pending(f,'100','SALE');await receive(f,event(f,replacement.transactionId,100,0,{at:f.at+1}));await f.callbacks.tick();
  await receive(f,event(f,old.transactionId,100,0,{at:f.at+2}));await f.callbacks.tick();
  expect((await new CommercePaymentQueryService(db).get(f.actor,old.paymentId)).capturedAmount).toBe('100.000000');
  expect((await db.commerceOrderPaymentBinding.findFirstOrThrow({where:{paymentId:old.paymentId}})).amount.toFixed(6)).toBe('0.000000');expect((await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).paidAmount.toFixed(6)).toBe('100.000000');
  expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'PAYMENT_UNALLOCATED_FUNDS'}})).toBe(1);
 });
 it('rolls back financial, allocation, command, history and outbox effects on projection failure',async()=>{
  const f=await fixture(),p=await pending(f),received=await receive(f,event(f,p.transactionId,100,0)),before=await db.outboxEvent.count({where:{workspaceId:f.workspace.id}});
  jest.spyOn(f.callbacks.orders,'refreshPaymentProjection').mockRejectedValueOnce(new Error('rollback-private-marker'));await f.callbacks.tick();
  expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:p.paymentId}})).data).toMatchObject({capturedAmount:'0'});expect((await db.commerceOrderPaymentBinding.findFirstOrThrow({where:{paymentId:p.paymentId}})).amount.toFixed(6)).toBe('0.000000');expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id}})).toBe(before);
  await due(received.eventId);await f.callbacks.tick();expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:received.eventId}})).status).toBe('SUCCEEDED');
 });
 it('enforces immutable receipts and prevents invoice/refund overallocation in PostgreSQL',async()=>{
  const f=await fixture(),p=await pending(f),received=await receive(f,event(f,p.transactionId,100,0));await f.callbacks.tick();
  await expect(db.sharedPaymentProviderEvent.update({where:{id:received.eventId},data:{normalized:{tampered:true}}})).rejects.toThrow();
  for(const collection of ['paymentAllocations','refunds'])await expect(db.commercialPackRecord.create({data:{id:randomUUID(),workspaceId:f.workspace.id,collection,data:{paymentId:p.paymentId,amount:'1',status:collection==='refunds'?'SUCCEEDED':'ACTIVE'}}})).rejects.toThrow();
 });
 it('accepts rotating signatures and never persists raw card/provider payload fields',async()=>{
  const f=await fixture(),p=await pending(f),raw=JSON.stringify(event(f,p.transactionId,100,0,{metadata:{pan:'secret-card-marker',cvv:'secret-cvv-marker'}})),proof=headers(f,raw);proof.set('stripe-signature',proof.get('stripe-signature')+',v1='+'0'.repeat(64));
  const received=await f.callbacks.receive('stripe',proof,raw);await f.callbacks.tick();const stored=await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:received.eventId}});expect(JSON.stringify(stored)).not.toMatch(/secret-card-marker|secret-cvv-marker/);
 });
 it('preserves signed whitespace over real Nest HTTP and enforces request limits',async()=>{
  const f=await fixture(),p=await pending(f);jest.resetModules();(globalThis as typeof globalThis&{__trueAgentPrisma?:PrismaClient}).__trueAgentPrisma=db;
  const {PackRouter}=await import('../src/server/process-platform/http'),{nestControllers,configurePackBodyParsing}=await import('../src/server/process-platform/nest-adapter');
  const router=new PackRouter().addSignedPublic('/api/v1/commerce/payment-providers/:providerCode/webhook','CommercePaymentsController',c=>f.callbacks.receive(c.params.providerCode,c.request.headers,c.rawBody!));class TestModule{}Module({controllers:nestControllers(router)})(TestModule);
  const app=await NestFactory.create<NestExpressApplication>(TestModule,{logger:false,rawBody:true});configurePackBodyParsing(app);
  try{await app.listen(0,'127.0.0.1');const url=(await app.getUrl())+'/api/v1/commerce/payment-providers/stripe/webhook',raw=JSON.stringify(event(f,p.transactionId,100,0,{metadata:{padding:'x'.repeat(120000)}}),null,2),proof=headers(f,raw);proof.set('content-type','application/json');
   const response=await fetch(url,{method:'POST',headers:proof,body:raw});expect(response.status).toBe(202);expect((await response.json()).data.accepted).toBe(true);
   expect((await fetch(url,{method:'POST',headers:proof,body:raw+' '})).status).toBe(401);
   const large=JSON.stringify(event(f,p.transactionId,100,0,{metadata:{padding:'x'.repeat(263000)}})),largeProof=headers(f,large);largeProof.set('content-type','application/json');expect((await fetch(url,{method:'POST',headers:largeProof,body:large})).status).toBe(413);
  }finally{await app.close();}
 });
});
