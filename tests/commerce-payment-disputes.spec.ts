import { PrismaClient,Prisma } from '@prisma/client';
import { createHmac,randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommercePaymentCallbackService } from '../src/server/commerce/payment-callback-service';
import { CommercePaymentDisputeService } from '../src/server/commerce/payment-dispute-service';
import { StripePaymentAdapter } from '../src/server/commercial/payment-providers';
import { signAccessToken } from '../src/server/security';

jest.setTimeout(120000);let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_payment_disputes_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});afterEach(()=>jest.restoreAllMocks());
async function fixture(){
 const f=await paymentCommandFixture(db),callbacks=new CommercePaymentCallbackService(db,undefined,f.authority),queries=new CommercePaymentDisputeService(db),at=Math.floor(Date.now()/1000)-40;
 const command=await f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'100',mode:'SALE'},randomUUID());await f.service.process(command.commandId);
 const transactionId=((await db.commercialPackRecord.findUniqueOrThrow({where:{id:command.paymentId}})).data as {providerTransactionId:string}).providerTransactionId;
 const result={...f,callbacks,queries,at,paymentId:command.paymentId,transactionId};
 await receive(result,{id:'evt_'+randomUUID(),created:at,account:'merchant-test',type:'payment_intent.succeeded',data:{object:{id:transactionId,currency:'egp',amount:10000,amount_received:10000,amount_capturable:0,status:'succeeded'}}});await callbacks.tick();return result;
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function headers(f:Pick<Fixture,'secrets'|'connection'>,raw:string){const timestamp=Math.floor(Date.now()/1000),secret=JSON.parse(f.secrets.get('test-payment-bundle')!).webhookSecret;return new Headers({'x-payment-connection-id':f.connection.id,'stripe-signature':'t='+timestamp+',v1='+createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex')});}
async function receive(f:Pick<Fixture,'callbacks'|'secrets'|'connection'>,payload:unknown){const raw=JSON.stringify(payload),ack=await f.callbacks.receive('stripe',headers(f,raw),raw);await due(ack.eventId);return ack;}
function event(f:Fixture,options:{disputeId?:string;eventId?:string;at?:number;status?:string;type?:string;transactionId?:string;currency?:string;amount?:number;submissionCount?:number}={}){
 return{id:options.eventId??'evt_'+randomUUID(),created:options.at??f.at+1,account:'merchant-test',type:options.type??'charge.dispute.created',data:{object:{id:options.disputeId??'du_'+randomUUID(),object:'dispute',payment_intent:options.transactionId??f.transactionId,charge:'ch_test',created:f.at+1,amount:options.amount??4000,currency:options.currency??'egp',reason:'fraudulent',status:options.status??'needs_response',
 evidence_details:{has_evidence:Boolean(options.submissionCount),past_due:false,submission_count:options.submissionCount??0,due_by:f.at+86400},evidence:{customer_email_address:'secret-private-evidence@example.test',uncategorized_text:'4242424242424242 CVV 123'},metadata:{pan:'4242424242424242',apiKey:'secret-never-persist'}}}};
}
async function open(f:Fixture,options:Parameters<typeof event>[1]={}){const payload=event(f,options),ack=await receive(f,payload);await f.callbacks.tick();expect(await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:ack.eventId},select:{status:true,errorCode:true}})).toEqual({status:'SUCCEEDED',errorCode:null});const row=await db.commercePaymentDispute.findFirstOrThrow({where:{workspaceId:f.workspace.id,providerDisputeId:payload.data.object.id}});return{row,ack,payload};}
async function due(id:string){await db.sharedPaymentProviderEvent.update({where:{id},data:{nextAttemptAt:new Date(Date.now()-1000)}});}
async function grant(f:Fixture,key:string,scope?:'OWN'|'WORKSPACE'){const p=await db.permission.findUniqueOrThrow({where:{key}});await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:scope?{scope,isDeleted:false}:{isDeleted:true}});}

describe('Changed Commerce dispute ingestion, history and authorized reads',()=>{
 it('opens a separate financial dispute without changing captured funds, Order payment or inventory',async()=>{
  const f=await fixture(),before=await db.commercialPackRecord.findUniqueOrThrow({where:{id:f.paymentId}}),order=await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}}),d=await open(f);
  expect(d.row.status).toBe('EVIDENCE_REQUIRED');expect(d.row.amount.toFixed(6)).toBe('40.000000');expect(d.row.resolvedAt).toBeNull();
  expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:f.paymentId}})).data).toEqual(before.data);expect(await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).toEqual(order);
  expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id}})).toBe(0);expect(await db.commercialPackRecord.count({where:{workspaceId:f.workspace.id,collection:'refunds'}})).toBe(0);
  const effects=async()=>[await db.outboxEvent.count({where:{workspaceId:f.workspace.id}}),await db.auditLog.count({where:{workspaceId:f.workspace.id}}),await db.commercePaymentDisputeHistory.count({where:{workspaceId:f.workspace.id}})];
  const beforeReads=await effects(),receipt=await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:d.ack.eventId}}),read=await f.queries.get(f.actor,d.row.id);await f.queries.list(f.actor,{});expect(await effects()).toEqual(beforeReads);
  expect(receipt).toMatchObject({status:'SUCCEEDED',paymentId:f.paymentId,outcome:'APPLIED'});expect(read.history).toHaveLength(1);
  expect(JSON.stringify([d.row,receipt,read],(_key,value)=>typeof value==='bigint'?value.toString():value)).not.toMatch(/4242424242424242|CVV|secret-private|secret-never/);
  expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'PAYMENT_DISPUTE_OPENED'}})).toBe(1);
 });
 it('deduplicates reformatting and concurrent workers, while changed provider event payloads conflict',async()=>{
  const f=await fixture(),payload=event(f),ack=await receive(f,payload),raw=JSON.stringify(payload,null,2);
  expect(await f.callbacks.receive('stripe',headers(f,raw),raw)).toMatchObject({eventId:ack.eventId,duplicate:true});
  await expect(receive(f,{...payload,data:{object:{...payload.data.object,amount:5000}}})).rejects.toMatchObject({code:'PAYMENT_DUPLICATE_EVENT'});
  const [a,b]=await Promise.all([f.callbacks.tick(),f.callbacks.tick()]);expect(a.processed+b.processed).toBe(1);
  expect(await db.commercePaymentDispute.count({where:{workspaceId:f.workspace.id}})).toBe(1);expect(await db.commercePaymentDisputeHistory.count({where:{workspaceId:f.workspace.id}})).toBe(1);
 });
 it('tracks submitted evidence and terminal outcomes, retains ignored history and advances identical-state watermarks',async()=>{
  const f=await fixture(),d=await open(f),id=d.row.providerDisputeId;
  await receive(f,event(f,{disputeId:id,at:f.at+3,type:'charge.dispute.updated',status:'under_review',submissionCount:1}));await f.callbacks.tick();
  await receive(f,event(f,{disputeId:id,at:f.at+5,type:'charge.dispute.updated',status:'under_review',submissionCount:1}));await f.callbacks.tick();
  const stale=await receive(f,event(f,{disputeId:id,at:f.at+4,type:'charge.dispute.updated'}));await f.callbacks.tick();
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:stale.eventId}})).outcome).toBe('IGNORED');
  await receive(f,event(f,{disputeId:id,at:f.at+6,type:'charge.dispute.closed',status:'lost',submissionCount:1}));await f.callbacks.tick();
  const late=await receive(f,event(f,{disputeId:id,at:f.at+7,status:'won',type:'charge.dispute.closed',submissionCount:1}));await f.callbacks.tick();
  const read=await f.queries.get(f.actor,d.row.id);expect(read.status).toBe('LOST');expect(read.resolvedAt?.toISOString()).toBe(new Date((f.at+6)*1000).toISOString());expect(read.history).toHaveLength(6);
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:late.eventId}})).outcome).toBe('IGNORED');expect(read.evidence).toMatchObject({hasEvidence:true,submissionCount:1});
  expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'PAYMENT_DISPUTE_UPDATED'}})).toBe(3);
 });
 it('validates signed payloads, original bytes, expanded references, inquiry closure and currency precision',async()=>{
  const f=await fixture(),p=event(f),raw=JSON.stringify(p),adapter=new StripePaymentAdapter('test-only-api-key-marker','test-only-webhook-marker','merchant-test');
  await expect(f.callbacks.receive('stripe',headers(f,raw),raw+' ')).rejects.toMatchObject({code:'PAYMENT_PROVIDER_SIGNATURE_INVALID'});
  await expect(receive(f,{...p,data:{object:{...p.data.object,payment_intent:null}}})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  await expect(receive(f,{...p,type:'charge.dispute.closed'})).rejects.toMatchObject({code:'PAYMENT_DISPUTE_INVALID'});
  const expanded={...p,type:'charge.dispute.closed',data:{object:{...p.data.object,payment_intent:{id:f.transactionId,metadata:{secret:'ignored'}},charge:{id:'ch_test'},status:'warning_closed',currency:'kwd',amount:1234}}},body=JSON.stringify(expanded);
  expect(adapter.verifyCommerceWebhook(headers(f,body),body)).toMatchObject({kind:'DISPUTE',amount:'1.234',status:'WON',providerStatus:'warning_closed'});
  const yen={...expanded,data:{object:{...expanded.data.object,currency:'jpy',amount:1234}}},yenRaw=JSON.stringify(yen);expect(adapter.verifyCommerceWebhook(headers(f,yenRaw),yenRaw)).toMatchObject({amount:'1234'});
 });
 it('retains evidence on equal-timestamp regressions and records provider dispute amounts independently of captured totals',async()=>{
  const f=await fixture(),d=await open(f,{amount:15000,status:'under_review',submissionCount:1});
  const tied=await receive(f,event(f,{disputeId:d.row.providerDisputeId,amount:15000,status:'under_review',submissionCount:0}));await f.callbacks.tick();
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:tied.eventId}})).outcome).toBe('IGNORED');
  expect(await f.queries.get(f.actor,d.row.id)).toMatchObject({amount:'150.000000',evidence:{hasEvidence:true,submissionCount:1}});
  expect((await db.commercialPackRecord.findUniqueOrThrow({where:{id:f.paymentId}})).data).toMatchObject({capturedAmount:'100.000000',financialState:'PAID'});
 });
 it('fails closed on currency and immutable amount drift without partial history or outbox writes',async()=>{
  const f=await fixture(),bad=await receive(f,event(f,{currency:'usd'}));await f.callbacks.tick();expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:bad.eventId}})).errorCode).toBe('PAYMENT_DISPUTE_INVALID');
  expect(await db.commercePaymentDispute.count({where:{workspaceId:f.workspace.id}})).toBe(0);
  const d=await open(f),changed=await receive(f,event(f,{disputeId:d.row.providerDisputeId,amount:5000,at:f.at+2}));await f.callbacks.tick();
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:changed.eventId}})).errorCode).toBe('PAYMENT_DISPUTE_INVALID');expect((await f.queries.get(f.actor,d.row.id)).history).toHaveLength(1);
 });
 it('keeps foreign provider transactions inaccessible through durable inbox and read endpoints',async()=>{
  const f=await fixture(),other=await fixture(),foreign=await open(other),ack=await receive(f,event(f,{transactionId:other.transactionId}));await f.callbacks.tick();
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:ack.eventId}})).errorCode).toBe('PAYMENT_NOT_FOUND');expect(await db.commercePaymentDispute.count({where:{workspaceId:f.workspace.id}})).toBe(0);
  await expect(f.queries.get(f.actor,foreign.row.id)).rejects.toMatchObject({code:'PAYMENT_DISPUTE_NOT_FOUND'});
  expect((await f.queries.list(f.actor,{})).meta.total).toBe(0);
 });
 it('rechecks service-principal permissions and keeps bounded failures free of financial and dispute effects',async()=>{
  const f=await fixture(),ack=await receive(f,event(f));await grant(f,'payment.provider_confirm');
  for(let i=0;i<5;i++){await due(ack.eventId);await f.callbacks.tick();}
  expect(await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:ack.eventId}})).toMatchObject({status:'FAILED',attempts:5,errorCode:'PERMISSION_DENIED'});expect(await db.commercePaymentDispute.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('filters scope before pagination, denies current grants and validates list DTOs',async()=>{
  const f=await fixture(),d=await open(f);await open(f,{status:'under_review',submissionCount:1});
  expect(await f.queries.list(f.actor,{status:'EVIDENCE_REQUIRED',page:'1',limit:'1'})).toMatchObject({data:[{id:d.row.id}],meta:{total:1,limit:1}});
  for(const input of [{status:'PRIVATE'}, {limit:101},{workspaceId:f.workspace.id},{sort:'evidence'}])await expect(f.queries.list(f.actor,input)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  await grant(f,'COMMERCE.DISPUTE_VIEW');await expect(f.queries.get(f.actor,d.row.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});await grant(f,'COMMERCE.DISPUTE_VIEW','OWN');
  const owner=await db.user.create({data:{firstName:'Other',lastName:'Owner',email:randomUUID()+'@example.test',status:'ACTIVE'}});await db.workspaceMembership.create({data:{workspaceId:f.workspace.id,userId:owner.id,roleId:f.role.id}});
  await db.commerceStore.update({where:{id:f.store.id},data:{createdByUserId:owner.id}});expect((await f.queries.list(f.actor,{limit:1})).meta.total).toBe(0);await expect(f.queries.get(f.actor,d.row.id)).rejects.toMatchObject({code:'PAYMENT_DISPUTE_NOT_FOUND'});
  await grant(f,'COMMERCE.DISPUTE_VIEW','WORKSPACE');await grant(f,'payment.read','OWN');const otherActor={...f.actor,userId:owner.id};
  expect((await f.queries.list(otherActor,{})).meta.total).toBe(0);await expect(f.queries.get(otherActor,d.row.id)).rejects.toMatchObject({code:'PAYMENT_DISPUTE_NOT_FOUND'});
  await grant(f,'payment.read');await expect(f.queries.list(f.actor,{})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('rolls back dispute, history, audit and outbox together then retries exactly once',async()=>{
  const f=await fixture(),payload=event(f),ack=await receive(f,payload),original=CommercePaymentDisputeService.prototype.applyInTransaction,spy=jest.spyOn(CommercePaymentDisputeService.prototype,'applyInTransaction');
  spy.mockImplementationOnce(async function(this:CommercePaymentDisputeService,...args){await original.apply(this,args);throw new Error('injected precommit failure');});
  await f.callbacks.tick();expect(await db.commercePaymentDispute.count({where:{workspaceId:f.workspace.id}})).toBe(0);expect(await db.commercePaymentDisputeHistory.count({where:{workspaceId:f.workspace.id}})).toBe(0);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'PAYMENT_DISPUTE_OPENED'}})).toBe(0);
  expect((await db.sharedPaymentProviderEvent.findUniqueOrThrow({where:{id:ack.eventId}})).paymentId).toBeNull();spy.mockRestore();await due(ack.eventId);await f.callbacks.tick();expect(await db.commercePaymentDisputeHistory.count({where:{workspaceId:f.workspace.id}})).toBe(1);
 });
 it('enforces immutable identity, sanitized evidence, terminal state and tenant-bound receipt history in PostgreSQL',async()=>{
  const f=await fixture(),d=await open(f),other=await fixture(),h=await db.commercePaymentDisputeHistory.findFirstOrThrow({where:{disputeId:d.row.id}});
  await expect(db.commercePaymentDispute.update({where:{id:d.row.id},data:{paymentId:other.paymentId,version:{increment:1}}})).rejects.toThrow();
  await expect(db.commercePaymentDispute.update({where:{id:d.row.id},data:{evidence:{hasEvidence:false,pastDue:false,submissionCount:0,dueAt:null,pan:'4242424242424242'},version:{increment:1}}})).rejects.toThrow();
  await expect(db.commercePaymentDisputeHistory.update({where:{id:h.id},data:{outcome:'IGNORED'}})).rejects.toThrow();await expect(db.commercePaymentDisputeHistory.delete({where:{id:h.id}})).rejects.toThrow();
  await expect(db.commercePaymentDisputeHistory.create({data:{...h,id:randomUUID(),workspaceId:other.workspace.id,evidence:h.evidence as Prisma.InputJsonObject}})).rejects.toThrow();
  await receive(f,event(f,{disputeId:d.row.providerDisputeId,status:'won',at:f.at+2,type:'charge.dispute.closed'}));await f.callbacks.tick();await expect(db.commercePaymentDispute.update({where:{id:d.row.id},data:{status:'LOST',version:{increment:1}}})).rejects.toThrow();
  await db.workspace.update({where:{id:f.workspace.id},data:{settings:{entitlements:{commerce:false}}}});await expect(f.queries.list(f.actor,{})).rejects.toMatchObject({code:'PERMISSION_DENIED'});await expect(f.queries.get(f.actor,d.row.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('serves only the two changed Nest dispute routes and actual Next registrations with authentication and tenant isolation',async()=>{
  const f=await fixture(),other=await fixture(),d=await open(f),token=await signAccessToken(f.user.id),foreignToken=await signAccessToken(other.user.id);
  jest.resetModules();(globalThis as typeof globalThis&{__trueAgentPrisma?:PrismaClient}).__trueAgentPrisma=db;
  const {GET}=await import('../app/api/v1/commerce/[[...path]]/route'),{commerceRouter}=await import('../src/server/commerce/routes');
  const entries=commerceRouter.entries.filter(e=>e.controller==='CommerceDisputesController');expect(entries.map(e=>e.path)).toEqual(['/api/v1/commerce/payment-disputes','/api/v1/commerce/payment-disputes/:disputeId']);
  const paths=['/api/v1/commerce/payment-disputes','/api/v1/commerce/payment-disputes/'+d.row.id],auth={authorization:'Bearer '+token,'x-workspace-id':f.workspace.id};
  for(const path of paths){const response=await GET(new NextRequest('http://localhost'+path,{headers:auth}));expect(response.status).toBe(200);expect((await response.json()).success).toBe(true);expect((await GET(new NextRequest('http://localhost'+path))).status).toBe(401);}
  const {PackRouter}=await import('../src/server/process-platform/http'),{nestControllers}=await import('../src/server/process-platform/nest-adapter');
  const router=new PackRouter().add('GET',entries[0].path,'CommerceDisputesController',c=>f.queries.list(c.actor,c.query)).add('GET',entries[1].path,'CommerceDisputesController',c=>f.queries.get(c.actor,c.params.disputeId));
  class DisputeTestModule{}Module({controllers:nestControllers(router)})(DisputeTestModule);const app=await NestFactory.create(DisputeTestModule,{logger:false});
  try{await app.listen(0,'127.0.0.1');const base=await app.getUrl();for(const path of paths){const response=await fetch(base+path,{headers:auth});expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toMatch(/4242424242424242|CVV|secret-private/);expect((await fetch(base+path)).status).toBe(401);}
   expect((await fetch(base+paths[1],{headers:{authorization:'Bearer '+foreignToken,'x-workspace-id':other.workspace.id}})).status).toBe(404);
  }finally{await app.close();}
 });
});
