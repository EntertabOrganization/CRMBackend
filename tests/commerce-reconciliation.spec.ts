import { PrismaClient,Prisma } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommerceReconciliationService } from '../src/server/commerce/reconciliation-service';
import { CommerceIntegrationInspectionService } from '../src/server/commerce/integration-inspection-service';
import { CommerceShipmentService } from '../src/server/commerce/shipment-service';
import { AppError } from '../src/server/errors';
import { signAccessToken } from '../src/server/security';

jest.setTimeout(120000);let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_commerce_reconciliation_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});afterEach(()=>jest.restoreAllMocks());
async function fixture(snapshot:Record<string,unknown>={}){const f=await paymentCommandFixture(db,snapshot as never);await db.commerceStore.update({where:{id:f.store.id},data:{dealCreationPolicy:'NEVER'}});return{...f,jobs:new CommerceReconciliationService(db),inspection:new CommerceIntegrationInspectionService(db)};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function due(id:string){await db.commerceReconciliationJob.update({where:{id},data:{nextAttemptAt:new Date(Date.now()-1000)}});}
async function queue(f:Fixture,key=randomUUID()){const ack=await f.jobs.create(f.actor,f.order.id,{},key);await due(ack.jobId);return ack;}
async function run(f:Fixture){const ack=await queue(f);expect(await f.jobs.process(ack.jobId)).toBe(true);return{ack,job:await f.jobs.get(f.actor,ack.jobId)};}
async function grant(f:Fixture,key:string,scope?:'OWN'|'WORKSPACE'){const p=await db.permission.findUniqueOrThrow({where:{key}});await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:scope?{scope,isDeleted:false}:{isDeleted:true}});}
async function order(f:Fixture){const hash=()=>createHash('sha256').update(randomUUID()).digest('hex'),cart=await db.commerceCart.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,tokenHash:hash(),currency:'EGP',expiresAt:new Date(Date.now()+3600000)}}),session=await db.commerceCheckoutSession.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,cartId:cart.id,tokenHash:hash(),customerSnapshot:{},addressSnapshot:{},payerType:'PERSON',expiresAt:new Date(Date.now()+3600000)}});return db.commerceOrder.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,cartId:cart.id,checkoutSessionId:session.id,currency:'EGP',total:'100',snapshot:{},consents:[]}});}
async function payment(f:Fixture,amount='100',allocated='40',status='SUCCEEDED'){
 const id=randomUUID();await db.commercialPackRecord.create({data:{id,workspaceId:f.workspace.id,collection:'payments',data:{id,workspaceId:f.workspace.id,amount,currencyCode:'EGP',methodType:'MANUAL',settlementStatus:status,responsibleUserId:f.user.id}}});await db.commerceOrderPaymentBinding.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,paymentId:id,amount:allocated}});return id;
}
async function contact(f:Fixture){return db.crmContact.create({data:{workspaceId:f.workspace.id,firstName:'PrivateCustomer',lastName:'SecretPII',displayName:'PrivateCustomer SecretPII',responsibleUserId:f.user.id}});}
async function link(f:Fixture,id:string){return db.commerceCrmBinding.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,entityType:'CONTACT',targetId:id,linkPolicy:'NEVER',status:'LINKED'}});}
async function stockFixture(){
 const productId=randomUUID(),lineId=randomUUID(),f=await fixture({paymentMethodId:'COD',lines:[{itemId:lineId,productId,variantId:null,inventoryKey:productId,quantity:'5',stockable:true,name:'Stock'}]}),shipments=new CommerceShipmentService(db);
 const unit=await db.catalogUnit.create({data:{workspaceId:f.workspace.id,name:'Each',code:'EA',precision:0}});
 await db.catalogProduct.create({data:{id:productId,workspaceId:f.workspace.id,catalogId:f.store.catalogId,type:'SIMPLE_PRODUCT',name:'Stock',sku:'TEST',skuKey:'test',primaryUnitId:unit.id}});
 const warehouse=await shipments.warehouses.create(f.actor,{name:'Stock',code:'STOCK',type:'PHYSICAL',timezone:'Africa/Cairo'}),receipt=await shipments.documents.create(f.actor,{documentType:'STOCK_RECEIPT',warehouseIds:{destination:warehouse.id},currency:'EGP'}),line=await shipments.documents.line(f.actor,receipt.id,{productId,quantity:'10',unitCost:'2'}) as {documentVersion:string};
 await shipments.documents.process(f.actor,receipt.id,{expectedVersion:line.documentVersion},randomUUID());const reservation=await shipments.reservations.create(f.actor,{sourceType:'ORDER',sourceId:f.order.id,productId,quantity:'5',warehouseId:warehouse.id},randomUUID());
 await db.commerceStore.update({where:{id:f.store.id},data:{settings:{...f.store.settings as object,inventoryPrincipalUserId:f.user.id}}});
 return{...f,shipments,warehouse,reservation,productId,lineId};
}
async function facts(f:Fixture){return{order:await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}}),payments:await db.commercialPackRecord.findMany({where:{workspaceId:f.workspace.id},orderBy:{id:'asc'}}),balances:await db.inventoryBalance.findMany({where:{workspaceId:f.workspace.id},orderBy:{id:'asc'}}),movements:await db.inventoryMovement.findMany({where:{workspaceId:f.workspace.id},orderBy:{id:'asc'}}),bindings:await db.commerceCrmBinding.findMany({where:{workspaceId:f.workspace.id},orderBy:{id:'asc'}})};}

describe('Changed read-only Commerce consistency jobs and integration projections',()=>{
 it('queues one durable job for concurrent replay and rejects key reuse for another Order after HTTP dedupe expiry',async()=>{
  const f=await fixture(),key=randomUUID(),[a,b]=await Promise.all([queue(f,key),queue(f,key)]);expect(a.jobId).toBe(b.jobId);
  await db.idempotencyRecord.deleteMany({where:{workspaceId:f.workspace.id}});expect((await queue(f,key)).jobId).toBe(a.jobId);
  const other=await order(f);await expect(f.jobs.create(f.actor,other.id,{},key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
  expect(await f.jobs.process(a.jobId)).toBe(true);expect(await f.jobs.create(f.actor,f.order.id,{},key)).toEqual(a);
  expect(await db.commerceReconciliationJob.count({where:{workspaceId:f.workspace.id}})).toBe(1);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_RECONCILIATION_QUEUED'}})).toBe(1);
 });
 it('consumes a coherent job once concurrently without changing source facts or exposing private worker fields',async()=>{
  const f=await fixture(),before=await facts(f),ack=await queue(f),[a,b]=await Promise.all([f.jobs.process(ack.jobId),f.jobs.process(ack.jobId)]);expect(Number(a)+Number(b)).toBe(1);
  const result=await f.jobs.get(f.actor,ack.jobId);expect(result).toMatchObject({status:'SUCCEEDED',attemptCount:1,result:{consistent:true,mismatches:[]}});expect(result.result).not.toHaveProperty('references');expect(result).not.toHaveProperty('claimToken');
  expect(await facts(f)).toEqual(before);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_RECONCILIATION_COMPLETED'}})).toBe(1);
  const count=await db.auditLog.count({where:{workspaceId:f.workspace.id}});await f.jobs.get(f.actor,ack.jobId);await f.inspection.integrations(f.actor,f.order.id);expect(await db.auditLog.count({where:{workspaceId:f.workspace.id}})).toBe(count);
 });
 it('reports payment allocation/projection drift and unallocated funds without repairing financial truth',async()=>{
  const f=await fixture(),id=await payment(f),before=await facts(f),{job}=await run(f);
  expect(job.result?.mismatches).toEqual(expect.arrayContaining([{code:'PAYMENT_UNALLOCATED_FUNDS',entityId:id,actual:'60.000000'},{code:'ORDER_PAYMENT_PROJECTION_MISMATCH',expected:'40.000000',actual:'0.000000'}]));expect(await facts(f)).toEqual(before);
  await grant(f,'payment.read');await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('keeps invalid legacy payment ledgers observable while independently rechecking financial visibility',async()=>{
  const f=await fixture(),id=await payment(f,'30','40'),{job}=await run(f);expect(job.result?.mismatches).toEqual(expect.arrayContaining([{code:'PAYMENT_ALLOCATION_EXCEEDS_SETTLED',entityId:id},{code:'PAYMENT_LEDGER_INVALID'}]));
  expect((await f.jobs.get(f.actor,job.jobId)).status).toBe('SUCCEEDED');
  const person=await db.user.create({data:{firstName:'Other',lastName:'Owner',email:randomUUID()+'@example.test',status:'ACTIVE'}});await db.workspaceMembership.create({data:{workspaceId:f.workspace.id,userId:person.id,roleId:f.role.id}});
  const record=await db.commercialPackRecord.findUniqueOrThrow({where:{id}});await db.commercialPackRecord.update({where:{id},data:{data:{...record.data as object,responsibleUserId:person.id}}});await grant(f,'payment.read','OWN');await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'PAYMENT_NOT_FOUND'});
 });
 it('observes uncertain commands without retrying a provider or manufacturing settlement',async()=>{
  const f=await fixture(),command=await f.service.create(f.actor,f.order.id,{methodId:f.method.id,amount:'100',mode:'SALE'},randomUUID());
  jest.spyOn(f.provider,'createPaymentAttempt').mockRejectedValueOnce(new AppError('PAYMENT_PROVIDER_UNAVAILABLE','Sandbox timeout',503));await f.service.process(command.commandId);
  const create=jest.spyOn(f.provider,'createPaymentAttempt'),capture=jest.spyOn(f.provider,'capture'),before=await facts(f),{job}=await run(f);
  expect(job.result?.mismatches).toContainEqual({code:'PAYMENT_COMMAND_UNCERTAIN',entityId:command.paymentId});expect(create).toHaveBeenCalledTimes(1);expect(capture).not.toHaveBeenCalled();expect(await facts(f)).toEqual(before);
 });
 it('reports real stock and reservation projection drift without rewriting ledgers or quantities',async()=>{
  const f=await stockFixture();expect((await run(f)).job.result?.consistent).toBe(true);
  const balance=await db.inventoryBalance.findFirstOrThrow({where:{workspaceId:f.workspace.id}});await db.inventoryBalance.update({where:{id:balance.id},data:{onHand:'9',reserved:'4'}});
  const before=await facts(f),{job}=await run(f);expect(job.result?.mismatches).toEqual(expect.arrayContaining([{code:'STOCK_ON_HAND_MISMATCH',entityId:f.productId,expected:'10.000000',actual:'9.000000'},{code:'STOCK_RESERVED_MISMATCH',entityId:f.productId,expected:'5.000000',actual:'4.000000'}]));expect(await facts(f)).toEqual(before);
  await grant(f,'INVENTORY.STOCK_READ');await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('inspects released historical reservations on cancelled Orders while enforcing current warehouse access',async()=>{
  const f=await stockFixture();await f.shipments.reservations.release(f.actor,f.reservation.id,{reason:'Cancel'},randomUUID());await db.commerceOrder.update({where:{id:f.order.id},data:{status:'CANCELLED'}});
  const {job}=await run(f);expect(job.result?.consistent).toBe(true);expect(job.result?.checked.reservations).toBe(1);
  await db.inventoryWarehousePermission.update({where:{workspaceId_warehouseId_roleId_action:{workspaceId:f.workspace.id,warehouseId:f.warehouse.id,roleId:f.role.id,action:'INVENTORY.RESERVATION_READ'}},data:{scope:'NONE'}});await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'WAREHOUSE_NOT_FOUND'});
  await db.workspace.update({where:{id:f.workspace.id},data:{settings:{entitlements:{commerce:false}}}});await expect(db.$transaction(tx=>f.shipments.reservations.inspectOrderReservation(tx,f.actor,f.reservation.id,f.order.id))).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('checks shipped inventory Sales through the owning document service and never adds physical returns',async()=>{
  const f=await stockFixture(),delivery=await f.shipments.deliveryServices(f.actor,f.store.id,{type:'PICKUP',rates:[{price:'0',currency:'EGP',estimatedDaysMin:0,estimatedDaysMax:0}]}) as {id:string};
  const shipment=await f.shipments.create(f.actor,f.order.id,{warehouseId:f.warehouse.id,deliveryServiceId:delivery.id,items:[{orderLineId:f.lineId,quantity:'5'}]},randomUUID());await f.shipments.transition(f.actor,shipment.id,{expectedVersion:shipment.version.toString()},randomUUID(),'SHIP');
  const before=await facts(f),{job}=await run(f);expect(job.result?.consistent).toBe(true);expect(job.result?.checked.shipments).toBe(1);expect(await facts(f)).toEqual(before);
  await grant(f,'INVENTORY.DOCUMENT_READ');await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('projects sanitized CRM bindings, reports pending/failed/missing links and redacts inaccessible references',async()=>{
  const f=await fixture(),person=await contact(f),binding=await link(f,person.id),before=await facts(f),{job}=await run(f);expect(job.result?.consistent).toBe(true);
  expect(JSON.stringify(await f.inspection.integrations(f.actor,f.order.id))).not.toMatch(/PrivateCustomer|SecretPII|apiKey|paymentPrincipalUserId/);expect(await facts(f)).toEqual(before);
  await db.crmContact.update({where:{id:person.id},data:{isDeleted:true}});expect((await run(f)).job.result?.mismatches).toContainEqual({code:'CRM_REFERENCE_UNAVAILABLE',entityId:binding.id});
  await db.commerceStore.update({where:{id:f.store.id},data:{dealCreationPolicy:'ALWAYS'}});await db.commerceCrmBinding.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,entityType:'DEAL',linkPolicy:'ALWAYS',status:'FAILED',lastErrorCode:'COMMERCE_CRM_SYNC_FAILED'}});
  const result=(await run(f)).job.result;expect(result?.mismatches.map(m=>m.code)).toEqual(expect.arrayContaining(['CRM_BINDING_MISSING','CRM_SYNC_FAILED']));
  await grant(f,'crm.contact.read');expect((await f.inspection.integrations(f.actor,f.order.id)).crm).toEqual({status:'REDACTED',data:null});await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('rejects cross-Workspace CRM targets, Orders, principals and jobs without leaking data',async()=>{
  const f=await fixture(),other=await fixture(),person=await contact(other),ack=await queue(f);
  await expect(link(f,person.id)).rejects.toThrow();await expect(other.jobs.get(other.actor,ack.jobId)).rejects.toMatchObject({code:'COMMERCE_RECONCILIATION_NOT_FOUND'});await expect(f.inspection.integrations(f.actor,other.order.id)).rejects.toMatchObject({code:'COMMERCE_ORDER_NOT_FOUND'});
  await expect(f.jobs.create(f.actor,other.order.id,{},randomUUID())).rejects.toMatchObject({code:'COMMERCE_ORDER_NOT_FOUND'});
  await expect(db.commerceReconciliationJob.update({where:{id:ack.jobId},data:{requestedByUserId:other.user.id}})).rejects.toThrow();
 });
 it('validates strict queue requests and current permissions despite owner role, with bounded observable failures',async()=>{
  const f=await fixture();for(const input of [{workspaceId:f.workspace.id},{repair:true},{paymentId:randomUUID()}])await expect(f.jobs.create(f.actor,f.order.id,input,randomUUID())).rejects.toMatchObject({code:'INVALID_ARGUMENT'});await expect(f.jobs.create(f.actor,f.order.id,{},null)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  const ack=await queue(f);await grant(f,'COMMERCE.ORDER_MANAGE');for(let i=0;i<5;i++){await due(ack.jobId);expect(await f.jobs.process(ack.jobId)).toBe(false);}
  expect(await db.commerceReconciliationJob.findUniqueOrThrow({where:{id:ack.jobId}})).toMatchObject({status:'FAILED',attempts:5,errorCode:'PERMISSION_DENIED',result:null});await expect(f.jobs.get(f.actor,ack.jobId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_RECONCILIATION_COMPLETED'}})).toBe(0);
 });
 it('rolls back result and completion outbox together, sanitizes errors and retries without altering facts',async()=>{
  const f=await fixture(),before=await facts(f),ack=await queue(f),original=CommerceIntegrationInspectionService.prototype.inspect,spy=jest.spyOn(CommerceIntegrationInspectionService.prototype,'inspect');
  spy.mockImplementationOnce(async function(this:CommerceIntegrationInspectionService,...args){await original.apply(this,args);throw new Error('secret-private-failure');});expect(await f.jobs.process(ack.jobId)).toBe(false);
  expect(await db.commerceReconciliationJob.findUniqueOrThrow({where:{id:ack.jobId}})).toMatchObject({status:'QUEUED',attempts:1,errorCode:'COMMERCE_RECONCILIATION_FAILED',result:null});expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_RECONCILIATION_COMPLETED'}})).toBe(0);
  spy.mockRestore();await due(ack.jobId);expect(await f.jobs.process(ack.jobId)).toBe(true);expect(await facts(f)).toEqual(before);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_RECONCILIATION_COMPLETED'}})).toBe(1);
 });
 it('recovers expired leases while refusing a live claim and protecting terminal job evidence',async()=>{
  const f=await fixture(),ack=await queue(f),token=randomUUID();await db.commerceReconciliationJob.update({where:{id:ack.jobId},data:{status:'RUNNING',claimToken:token,leaseExpiresAt:new Date(Date.now()+60000),attempts:1}});expect(await f.jobs.process(ack.jobId)).toBe(false);
  await db.commerceReconciliationJob.update({where:{id:ack.jobId},data:{leaseExpiresAt:new Date(Date.now()-1000)}});expect(await f.jobs.process(ack.jobId)).toBe(true);expect(await db.commerceReconciliationJob.findUniqueOrThrow({where:{id:ack.jobId}})).toMatchObject({status:'SUCCEEDED',attempts:2,claimToken:null});
  await expect(db.commerceReconciliationJob.update({where:{id:ack.jobId},data:{status:'QUEUED',result:Prisma.DbNull,completedAt:null}})).rejects.toThrow();await expect(db.commerceReconciliationJob.delete({where:{id:ack.jobId}})).rejects.toThrow();
  await expect(db.commerceReconciliationJob.update({where:{id:ack.jobId},data:{orderId:(await order(f)).id}})).rejects.toThrow();
 });
 it('does not declare a completed Order coherent without actual delivered lines and payment coverage',async()=>{
  const f=await fixture();await db.commerceOrder.update({where:{id:f.order.id},data:{status:'COMPLETED'}});const {job}=await run(f);expect(job.result?.mismatches).toContainEqual({code:'ORDER_COMPLETION_MISMATCH'});
  await db.workspace.update({where:{id:f.workspace.id},data:{settings:{entitlements:{commerce:false}}}});await expect(f.jobs.get(f.actor,job.jobId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('runs only the three changed Nest routes and actual Next registrations with authentication, strict payloads and tenant isolation',async()=>{
  const f=await fixture(),other=await fixture(),token=await signAccessToken(f.user.id),foreignToken=await signAccessToken(other.user.id),auth={authorization:'Bearer '+token,'x-workspace-id':f.workspace.id};
  jest.resetModules();(globalThis as typeof globalThis&{__trueAgentPrisma?:PrismaClient}).__trueAgentPrisma=db;
  const {GET,POST}=await import('../app/api/v1/commerce/[[...path]]/route'),path='/api/v1/commerce/orders/'+f.order.id;
  expect((await GET(new NextRequest('http://localhost'+path+'/integrations',{headers:auth}))).status).toBe(200);expect((await GET(new NextRequest('http://localhost'+path+'/integrations'))).status).toBe(401);
  const create=await POST(new NextRequest('http://localhost'+path+'/reconcile',{method:'POST',headers:{...auth,'content-type':'application/json','idempotency-key':randomUUID()},body:'{}'}));expect(create.status).toBe(202);const jobId=(await create.json()).data.jobId as string;
  expect((await GET(new NextRequest('http://localhost/api/v1/commerce/reconciliation-jobs/'+jobId,{headers:auth}))).status).toBe(200);
  const {PackRouter}=await import('../src/server/process-platform/http'),{nestControllers,configurePackBodyParsing}=await import('../src/server/process-platform/nest-adapter');
  const router=new PackRouter().add('GET','/api/v1/commerce/orders/:orderId/integrations','CommerceIntegrationsController',c=>f.inspection.integrations(c.actor,c.params.orderId)).add('POST','/api/v1/commerce/orders/:orderId/reconcile','CommerceIntegrationsController',c=>f.jobs.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),202).add('GET','/api/v1/commerce/reconciliation-jobs/:jobId','CommerceIntegrationsController',c=>f.jobs.get(c.actor,c.params.jobId));
  class ReconciliationTestModule{}Module({controllers:nestControllers(router)})(ReconciliationTestModule);const app=await NestFactory.create<NestExpressApplication>(ReconciliationTestModule,{logger:false,bodyParser:false});configurePackBodyParsing(app);
  try{await app.listen(0,'127.0.0.1');const base=await app.getUrl();for(const p of [path+'/integrations','/api/v1/commerce/reconciliation-jobs/'+jobId]){expect((await fetch(base+p,{headers:auth})).status).toBe(200);expect((await fetch(base+p)).status).toBe(401);expect((await fetch(base+p,{headers:{authorization:'Bearer '+foreignToken,'x-workspace-id':other.workspace.id}})).status).toBe(404);}
   const response=await fetch(base+path+'/reconcile',{method:'POST',headers:{...auth,'content-type':'application/json','idempotency-key':randomUUID()},body:'{}'});expect(response.status).toBe(202);expect((await response.json()).data.jobId).toBeTruthy();expect((await fetch(base+path+'/reconcile',{method:'POST',headers:{...auth,'content-type':'application/json','idempotency-key':randomUUID()},body:'{"repair":true}'})).status).toBe(400);
  }finally{await app.close();}
 });
});
