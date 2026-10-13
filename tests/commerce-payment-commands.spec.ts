import { paymentCommandFixture } from './support/payment-command-fixture';
import { PrismaClient } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { AppError } from '../src/server/errors';
import { CommercePaymentCommandService } from '../src/server/commerce/payment-command-service';
import { CommercePaymentQueryService } from '../src/server/commerce/payment-query-service';
import { PaymentProviderAuthority } from '../src/server/commercial/payment-provider-authority';
import { DeterministicLifecyclePaymentAdapter } from '../src/server/commercial/payment-providers';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { signAccessToken } from '../src/server/security';
import { InMemoryStore } from '../src/server/store';
import { hydrateState } from '../src/server/persistence';
import { AccessService } from '../src/server/access-service';
import { RequisiteService } from '../src/server/commercial/requisite-service';
import { CommerceService } from '../src/server/commercial/commerce-service';
import { PaymentProviderRegistry } from '../src/server/commercial/payment-providers';

jest.setTimeout(120000);
let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_payment_commands_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});
afterEach(()=>jest.restoreAllMocks());
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
async function fixture(){return paymentCommandFixture(db);}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const create=(f:Fixture,amount='100',mode:'SALE'|'AUTHORIZE'='AUTHORIZE',key=randomUUID())=>f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount,mode},key);
async function authorized(f:Fixture){
 const command=await create(f);await f.service.process(command.commandId);
 const record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}}),data=record.data as {providerTransactionId:string};f.provider.authorize(data.providerTransactionId);
 // Confirmation is an owning financial fixture; the changed command worker never invents authorization.
 await db.commercialPackRecord.update({where:{id:command.paymentId},data:{data:{...record.data as object,authorizedAmount:'100',financialState:'AUTHORIZED'}}});
 return{...command,transactionId:data.providerTransactionId};
}
async function due(commandId:string){await db.sharedPaymentCommand.update({where:{id:commandId},data:{nextAttemptAt:new Date(Date.now()-1000)}});}
async function counts(f:Fixture){return{payments:await db.commercialPackRecord.count({where:{workspaceId:f.workspace.id,collection:'payments'}}),commands:await db.sharedPaymentCommand.count({where:{workspaceId:f.workspace.id}}),bindings:await db.commerceOrderPaymentBinding.count({where:{workspaceId:f.workspace.id}}),audit:await db.auditLog.count({where:{workspaceId:f.workspace.id}}),outbox:await db.outboxEvent.count({where:{workspaceId:f.workspace.id}})};}

describe('Changed durable Commerce/shared payment commands',()=>{
 it('rejects card/server fields, missing keys, zero and imprecise money before any write',async()=>{
  const f=await fixture(),before=await counts(f);
  for(const extra of [{cardNumber:'secret-pan-marker'},{cvv:'123'},{workspaceId:randomUUID()}])await expect(f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'1',mode:'SALE',...extra},randomUUID())).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  await expect(f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'1',mode:'SALE'},null)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  await expect(create(f,'0')).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});await expect(create(f,'0.001')).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});expect(await counts(f)).toEqual(before);
 });
 it('commits one shared payment, zero settled allocation and durable retry identity under concurrency',async()=>{
  const f=await fixture(),key=randomUUID(),[a,b]=await Promise.all([create(f,'100','AUTHORIZE',key),create(f,'100','AUTHORIZE',key)]);expect(a).toEqual(b);
  expect(await counts(f)).toMatchObject({payments:1,commands:1,bindings:1});
  expect((await db.commerceOrderPaymentBinding.findFirstOrThrow({where:{paymentId:a.paymentId}})).amount.toFixed(6)).toBe('0.000000');
  await expect(create(f,'99','AUTHORIZE',key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const spy=jest.spyOn(f.provider,'createPaymentAttempt');await Promise.all([f.service.process(a.commandId),f.service.process(a.commandId)]);expect(spy).toHaveBeenCalledTimes(1);
  const detail=await new CommercePaymentQueryService(db).get(f.actor,a.paymentId);expect(detail).toMatchObject({status:'PENDING',capturedAmount:'0.000000',authorizedAmount:'0.000000'});expect(detail.commands[0].status).toBe('SUCCEEDED');
  expect(await create(f,'100','AUTHORIZE',key)).toEqual(a);
 });
 it('serializes split payment capacity and does not treat browser/provider creation as settlement',async()=>{
  const f=await fixture();await Promise.all([create(f,'20','SALE'),create(f,'80','SALE')]);await expect(create(f,'1','SALE')).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
  expect((await f.service.tick()).processed).toBe(2);
  const ledger=await new CommercePaymentQueryService(db).list(f.actor,f.order.id);expect(ledger.every(p=>p.status==='PENDING'&&p.capturedAmount==='0.000000'&&p.allocatedAmount==='0.000000')).toBe(true);
  expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_PAID'}})).toBe(0);
 });
 it('recovers a lost provider response with the same effect key and retains uncertain capacity',async()=>{
  const f=await fixture(),command=await create(f),native=f.provider.createPaymentAttempt.bind(f.provider);
  const spy=jest.spyOn(f.provider,'createPaymentAttempt').mockImplementationOnce(async input=>{await native(input);throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Lost response.',503);});
  expect(await f.service.process(command.commandId)).toBe(false);expect(await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:command.commandId}})).toMatchObject({status:'QUEUED',attempts:1,uncertain:true});
  await expect(create(f,'1')).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
  await due(command.commandId);expect(await f.service.process(command.commandId)).toBe(true);expect(spy).toHaveBeenCalledTimes(2);expect(spy.mock.calls[0][0].idempotencyKey).toBe(spy.mock.calls[1][0].idempotencyKey);
  expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}})).data).toMatchObject({financialState:'PENDING',capturedAmount:'0'});
 });
 it('makes explicit first-attempt rejection visible and permits a new payment without false settlement',async()=>{
  const f=await fixture(),command=await create(f);jest.spyOn(f.provider,'createPaymentAttempt').mockRejectedValueOnce(new AppError('PAYMENT_PROVIDER_REJECTED','Rejected.',502,{providerStatus:400}));
  await f.service.process(command.commandId);expect(await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:command.commandId}})).toMatchObject({status:'FAILED',uncertain:false,lastErrorCode:'PAYMENT_PROVIDER_REJECTED'});
  expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}})).data).toMatchObject({financialState:'FAILED',settlementStatus:'FAILED'});expect((await create(f)).paymentId).not.toBe(command.paymentId);
 });
 it('caps concurrent pending captures and leaves money unchanged until provider confirmation',async()=>{
  const f=await fixture(),payment=await authorized(f),key=randomUUID(),input={amount:'60'};
  const [a,b]=await Promise.all([f.service.change(f.actor,payment.paymentId,'CAPTURE',input,key),f.service.change(f.actor,payment.paymentId,'CAPTURE',input,key)]);expect(a).toEqual(b);
  await expect(f.service.change(f.actor,payment.paymentId,'CAPTURE',{amount:'50'},randomUUID())).rejects.toMatchObject({code:'PAYMENT_CAPTURE_EXCEEDS_AUTHORIZATION'});
  const spy=jest.spyOn(f.provider,'capture');await Promise.all([f.service.process(a.commandId),f.service.process(a.commandId)]);expect(spy).toHaveBeenCalledTimes(1);
  expect((await f.provider.retrieveLifecycle(payment.transactionId)).capturedAmount).toBe('60');expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:payment.paymentId}})).data).toMatchObject({capturedAmount:'0',financialState:'AUTHORIZED'});
  expect((await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:a.commandId}})).status).toBe('WAITING_CONFIRMATION');expect(await f.service.change(f.actor,payment.paymentId,'CAPTURE',input,key)).toEqual(a);
  await expect(f.service.change(f.actor,payment.paymentId,'VOID',{reason:'Cancel'},randomUUID())).rejects.toMatchObject({code:'PAYMENT_INVALID_STATE'});
 });
 it('queues retry-safe void only for uncaptured authorizations and waits for confirmation',async()=>{
  const f=await fixture(),payment=await authorized(f),key=randomUUID(),a=await f.service.change(f.actor,payment.paymentId,'VOID',{reason:'Customer cancellation'},key);
  expect(await f.service.change(f.actor,payment.paymentId,'VOID',{reason:'Customer cancellation'},key)).toEqual(a);
  await expect(f.service.change(f.actor,payment.paymentId,'VOID',{reason:'Different'},key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const spy=jest.spyOn(f.provider,'void');await Promise.all([f.service.process(a.commandId),f.service.process(a.commandId)]);expect(spy).toHaveBeenCalledTimes(1);
  expect((await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:a.commandId}})).status).toBe('WAITING_CONFIRMATION');expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:payment.paymentId}})).data).toMatchObject({financialState:'AUTHORIZED',settlementStatus:'PENDING'});
 });
 it('checks current explicit grants and Workspace bindings before provider effects',async()=>{
  const f=await fixture(),other=await fixture(),command=await create(f),spy=jest.spyOn(f.provider,'createPaymentAttempt');
  await expect(other.service.change(other.actor,command.paymentId,'VOID',{reason:'Foreign'},randomUUID())).rejects.toMatchObject({code:'PAYMENT_NOT_FOUND'});
  const permission=await db.permission.findUniqueOrThrow({where:{key:'COMMERCE.PAYMENT_MANAGE'}});await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:permission.id}},data:{isDeleted:true}});
  expect(await f.service.process(command.commandId)).toBe(false);expect(spy).not.toHaveBeenCalled();expect((await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:command.commandId}})).lastErrorCode).toBe('PERMISSION_DENIED');
  await expect(create(f)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('bounds credential failures and does not persist provider payloads or secrets',async()=>{
  const f=await fixture(),command=await create(f);f.secrets.delete('test-payment-bundle');const spy=jest.spyOn(f.provider,'createPaymentAttempt');
  for(let i=0;i<5;i++){await due(command.commandId);await f.service.process(command.commandId);}
  expect(spy).not.toHaveBeenCalled();expect(await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:command.commandId}})).toMatchObject({status:'FAILED',attempts:5,uncertain:false,lastErrorCode:'PAYMENT_PROVIDER_NOT_CONFIGURED'});
  const serialized=JSON.stringify(await db.commercialPackRecord.findMany({where:{workspaceId:f.workspace.id}}));expect(serialized).not.toMatch(/test-only-api-key-marker|test-only-webhook-marker/);
 });
 it('requires the dedicated shared capture grant and rejects invalid provider configuration without writes',async()=>{
  const f=await fixture(),payment=await authorized(f),p=await db.permission.findUniqueOrThrow({where:{key:'payment.capture'}});
  await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:{isDeleted:true}});
  await expect(f.service.change(f.actor,payment.paymentId,'CAPTURE',{amount:'1'},randomUUID())).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  const fresh=await fixture(),before=await counts(fresh);await db.integrationOutboundConnection.update({where:{id:fresh.connection.id},data:{baseUrl:'invalid-provider-url'}});
  await expect(create(fresh)).rejects.toMatchObject({code:'PAYMENT_PROVIDER_NOT_CONFIGURED'});expect(await counts(fresh)).toEqual(before);
 });
 it('rolls back shared payment, attempt, binding and evidence together',async()=>{
  const f=await fixture(),native=f.service.shared.create.bind(f.service.shared),before=await counts(f);
  jest.spyOn(f.service.shared,'create').mockImplementationOnce(async(...args)=>{await native(...args);throw new AppError('TEST_FAILURE','Rollback probe.',409);});
  await expect(create(f)).rejects.toMatchObject({code:'TEST_FAILURE'});expect(await counts(f)).toEqual(before);
 });
 it('excludes managed attempts from the legacy full-payment webhook processor',async()=>{
  const f=await fixture(),command=await create(f);await f.service.process(command.commandId);
  const record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}}),transactionId=(record.data as {providerTransactionId:string}).providerTransactionId;
  const store=new InMemoryStore(await hydrateState(db)),access=new AccessService(store),legacy=new CommerceService(store,access,new RequisiteService(store,access),new PaymentProviderRegistry().register(f.provider));
  const raw=JSON.stringify({eventId:randomUUID(),eventType:'PAYMENT_SUCCEEDED',transactionId,status:'SUCCEEDED',amount:'100',currencyCode:'EGP',merchantId:'merchant-test'});
  await expect(legacy.handleProviderWebhook('stripe','legacy-connection',{'x-provider-signature':f.provider.sign(raw)},raw)).rejects.toMatchObject({code:'PAYMENT_PROVIDER_TRANSACTION_MISMATCH'});
  expect(store.state.payments.find(p=>p.id===command.paymentId)?.settlementStatus).toBe('PENDING');
 });
 it('permits replacement funding after authoritative final partial capture releases authorization',async()=>{
  const f=await fixture(),payment=await authorized(f),record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:payment.paymentId}});
  await db.commercialPackRecord.update({where:{id:payment.paymentId},data:{data:{...record.data as object,amount:'20',authorizedAmount:'20',capturedAmount:'20',financialState:'PARTIALLY_CAPTURED',settlementStatus:'SUCCEEDED'}}});
  await db.commerceOrderPaymentBinding.updateMany({where:{paymentId:payment.paymentId},data:{amount:'20'}});
  expect((await create(f,'80','SALE')).paymentId).not.toBe(payment.paymentId);await expect(create(f,'1','SALE')).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
 });
 it('enforces immutable command identities, tenant FKs and managed payment secret guards in PostgreSQL',async()=>{
  const f=await fixture(),other=await fixture(),command=await create(f),row=await db.sharedPaymentCommand.findUniqueOrThrow({where:{id:command.commandId}});
  await expect(db.sharedPaymentCommand.update({where:{id:row.id},data:{amount:'99'}})).rejects.toThrow();
  await expect(db.sharedPaymentCommand.create({data:{...row,id:randomUUID(),workspaceId:other.workspace.id,actorUserId:other.user.id,connectionId:other.connection.id,requestKey:randomUUID()}})).rejects.toThrow();
  const payment=await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}});await expect(db.commercialPackRecord.update({where:{id:payment.id},data:{data:{...payment.data as object,cvv:'private-card-marker'}}})).rejects.toThrow();
  await expect(db.commercialPackRecord.update({where:{id:payment.id},data:{data:{...payment.data as object,financialState:null}}})).rejects.toThrow();
  await expect(db.commerceOrderPaymentBinding.updateMany({where:{paymentId:payment.id},data:{amount:'1'}})).rejects.toThrow();
 });
 it('serves the three changed commands through authenticated Nest HTTP only',async()=>{
  const f=await fixture(),other=await fixture();jest.resetModules();(globalThis as typeof globalThis&{__trueAgentPrisma?:PrismaClient}).__trueAgentPrisma=db;
  const {PackRouter}=await import('../src/server/process-platform/http'),{nestControllers}=await import('../src/server/process-platform/nest-adapter');
  const router=new PackRouter().add('POST','/api/v1/commerce/orders/:orderId/payments','CommercePaymentsController',c=>f.service.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),202)
   .add('POST','/api/v1/commerce/payments/:paymentId/capture','CommercePaymentsController',c=>f.service.change(c.actor,c.params.paymentId,'CAPTURE',c.body,c.request.headers.get('idempotency-key')),202)
   .add('POST','/api/v1/commerce/payments/:paymentId/void','CommercePaymentsController',c=>f.service.change(c.actor,c.params.paymentId,'VOID',c.body,c.request.headers.get('idempotency-key')),202);
  class TestModule{}Module({controllers:nestControllers(router)})(TestModule);const app=await NestFactory.create(TestModule,{logger:false});
  try{
   await app.listen(0,'127.0.0.1');const base=await app.getUrl(),token=await signAccessToken(f.user.id),foreignToken=await signAccessToken(other.user.id);
   const post=(path:string,body:unknown,foreign=false)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+(foreign?foreignToken:token),'x-workspace-id':foreign?other.workspace.id:f.workspace.id,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(body)});
   const path='/api/v1/commerce/orders/'+f.order.id+'/payments';expect((await fetch(base+path,{method:'POST',body:'{}'})).status).toBe(401);
   expect((await post(path,{methodId:f.method.id,amount:'100',mode:'AUTHORIZE'},true)).status).toBe(404);
   const response=await post(path,{methodId:f.method.id,amount:'50',mode:'AUTHORIZE'});expect(response.status).toBe(202);const payment=(await response.json()).data;
   await f.service.process(payment.commandId);const record=await db.commercialPackRecord.findUniqueOrThrow({where:{id:payment.paymentId}});f.provider.authorize((record.data as {providerTransactionId:string}).providerTransactionId);await db.commercialPackRecord.update({where:{id:payment.paymentId},data:{data:{...record.data as object,financialState:'AUTHORIZED',authorizedAmount:'50'}}});
   expect((await post('/api/v1/commerce/payments/'+payment.paymentId+'/capture',{amount:'20'})).status).toBe(202);
   expect((await post('/api/v1/commerce/payments/'+payment.paymentId+'/capture',{amount:'20'},true)).status).toBe(404);
   expect((await post('/api/v1/commerce/payments/'+payment.paymentId+'/void',{reason:'Cancel'},true)).status).toBe(404);
   const voidPayment=await create(f,'50');await f.service.process(voidPayment.commandId);const voidRecord=await db.commercialPackRecord.findUniqueOrThrow({where:{id:voidPayment.paymentId}});f.provider.authorize((voidRecord.data as {providerTransactionId:string}).providerTransactionId);await db.commercialPackRecord.update({where:{id:voidPayment.paymentId},data:{data:{...voidRecord.data as object,financialState:'AUTHORIZED',authorizedAmount:'50'}}});
   expect((await post('/api/v1/commerce/payments/'+voidPayment.paymentId+'/void',{reason:'Cancel'})).status).toBe(202);
  }finally{await app.close();}
 });
});
