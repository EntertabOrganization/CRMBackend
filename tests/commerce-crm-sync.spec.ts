import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommerceCrmSyncService,enqueueOrderCrmSync } from '../src/server/commerce/crm-sync-service';
import { CommerceIntegrationInspectionService } from '../src/server/commerce/integration-inspection-service';

jest.setTimeout(120000);let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_commerce_crm_sync_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});
async function fixture(policy='ALWAYS',payerType='PERSON',email=randomUUID()+'@example.test'){
 const f=await paymentCommandFixture(db,{payerType,customer:{name:'Customer',email,phone:'+20 123 456 789'}});
 const store=await db.commerceStore.update({where:{id:f.store.id},data:{dealCreationPolicy:policy,settings:{...f.store.settings as object,crmPrincipalUserId:f.user.id}}});
 const pipeline=await db.crmPipeline.create({data:{workspaceId:f.workspace.id,entityType:'DEAL',name:'Sales',normalizedName:'sales',isDefault:true}});
 const stage=await db.crmStage.create({data:{workspaceId:f.workspace.id,pipelineId:pipeline.id,name:'New',position:1,semanticType:'PROGRESS',isDefault:true}});
 return{...f,store,pipeline,stage,email,sync:new CommerceCrmSyncService(db)};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function queue(f:F,key=randomUUID()){return await f.sync.create(f.actor,f.order.id,{},key) as {syncId:string;status:string};}
async function run(f:F){const a=await queue(f);expect(await f.sync.process(a.syncId)).toBe(true);return db.commerceCrmSync.findUniqueOrThrow({where:{id:a.syncId}});}
async function grant(f:F,key:string,scope?:'OWN'|'WORKSPACE'){const p=await db.permission.findUniqueOrThrow({where:{key}});await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:scope?{scope,isDeleted:false}:{isDeleted:true}});}
async function contact(f:F,email=f.email){const c=await db.crmContact.create({data:{workspaceId:f.workspace.id,firstName:'Known',lastName:'Customer',displayName:'Known Customer',responsibleUserId:f.user.id}});await db.crmContactCommunication.create({data:{workspaceId:f.workspace.id,contactId:c.id,type:'EMAIL',value:email,normalizedValue:email.trim().toLowerCase()}});return c;}
describe('Changed Commerce CRM owning synchronization',()=>{
 it('creates a single-name Contact and one Deal atomically, preserving Order facts and exact money',async()=>{
  const f=await fixture(),before=await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}}),key=randomUUID(),a=await queue(f,key);
  const results=await Promise.all([f.sync.process(a.syncId),f.sync.process(a.syncId)]);expect(results.filter(Boolean)).toHaveLength(1);
  expect(await queue(f,key)).toEqual(a);expect(await f.sync.process(a.syncId)).toBe(false);
  expect(await db.crmContact.findFirst({where:{workspaceId:f.workspace.id}})).toMatchObject({firstName:'Customer',lastName:''});
  expect(await db.crmDeal.findFirst({where:{workspaceId:f.workspace.id}})).toMatchObject({originSystem:'COMMERCE',originExternalId:f.order.id,amount:null,currencyCode:'EGP'});
  expect(await db.crmDeal.count({where:{workspaceId:f.workspace.id}})).toBe(1);expect(await db.commerceCrmBinding.count({where:{workspaceId:f.workspace.id,status:'LINKED'}})).toBe(2);
  expect(await db.commerceOrder.findUniqueOrThrow({where:{id:f.order.id}})).toEqual(before);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'ORDER_CRM_LINKED'}})).toBe(1);
 });
 it('uses normalized identity without changing existing customer data, and NEVER omits Deal creation',async()=>{
  const f=await fixture('NEVER'),c=await contact(f);const result=await run(f);expect(result).toMatchObject({customerWasNew:false,dealCreated:false});
  expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(1);expect(await db.crmContact.findUnique({where:{id:c.id}})).toEqual(c);expect(await db.crmDeal.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('creates Companies through the owner and honors ONLY_NEW_CUSTOMER',async()=>{
  const f=await fixture('ONLY_NEW_CUSTOMER','COMPANY'),result=await run(f);expect(result).toMatchObject({customerWasNew:true,dealCreated:true});expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(0);
  const g=await fixture('ONLY_NEW_CUSTOMER');await contact(g);expect(await run(g)).toMatchObject({customerWasNew:false,dealCreated:false});
 });
 it('pins Deal policy when automatic intent is created and uses the configured principal',async()=>{
  const f=await fixture('NEVER'),job=await db.$transaction(tx=>enqueueOrderCrmSync(tx,f.order,f.store));
  await db.commerceStore.update({where:{id:f.store.id},data:{dealCreationPolicy:'ALWAYS'}});expect(await f.sync.process(job.id)).toBe(true);expect(await db.crmDeal.count({where:{workspaceId:f.workspace.id}})).toBe(0);
  const projection=await new CommerceIntegrationInspectionService(db).integrations(f.actor,f.order.id);expect(projection.crmSync).toMatchObject({status:'SUCCEEDED',dealPolicy:'NEVER'});expect(JSON.stringify(projection)).not.toContain(f.email);
 });
 it('holds MANUAL_REVIEW automatic intent until an authorized manual request',async()=>{
  const f=await fixture('MANUAL_REVIEW'),job=await db.$transaction(tx=>enqueueOrderCrmSync(tx,f.order,f.store));expect(job.status).toBe('REVIEW_REQUIRED');expect(await f.sync.process(job.id)).toBe(false);
  await grant(f,'COMMERCE.CUSTOMER_MANAGE');await expect(queue(f)).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(0);
  await grant(f,'COMMERCE.CUSTOMER_MANAGE','WORKSPACE');expect(await run(f)).toMatchObject({dealCreated:true});
 });
 it('does not borrow the Workspace owner when an automatic principal is absent',async()=>{
  const f=await fixture(),store=await db.commerceStore.update({where:{id:f.store.id},data:{settings:{}}}),job=await db.$transaction(tx=>enqueueOrderCrmSync(tx,f.order,store));expect(await f.sync.process(job.id)).toBe(false);
  expect(await db.commerceCrmSync.findUnique({where:{id:job.id}})).toMatchObject({status:'QUEUED',errorCode:'COMMERCE_CRM_PRINCIPAL_UNAVAILABLE'});expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('fails ambiguous email and phone matches without creating or silently merging customers',async()=>{
  const f=await fixture(),c=await contact(f),other=await contact(f,'other@example.test');await db.crmContactCommunication.create({data:{workspaceId:f.workspace.id,contactId:other.id,type:'PHONE',value:'+20 123 456 789',normalizedValue:'+20123456789'}});
  const a=await queue(f);expect(await f.sync.process(a.syncId)).toBe(false);expect(await db.commerceCrmSync.findUnique({where:{id:a.syncId}})).toMatchObject({errorCode:'COMMERCE_CRM_IDENTITY_AMBIGUOUS'});expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(2);expect(await db.crmDeal.count({where:{workspaceId:f.workspace.id}})).toBe(0);expect(await db.crmContact.findUnique({where:{id:c.id}})).toEqual(c);
 });
 it('enforces current explicit CRM permissions and rolls back the new customer when Deal creation is denied',async()=>{
  const f=await fixture();await grant(f,'crm.deal.create');const a=await queue(f);expect(await f.sync.process(a.syncId)).toBe(false);expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(0);expect(await db.commerceCrmBinding.count({where:{workspaceId:f.workspace.id}})).toBe(0);
  expect(await db.commerceCrmSync.findUnique({where:{id:a.syncId}})).toMatchObject({errorCode:'PERMISSION_DENIED'});
 });
 it('honors stage denial even for an owner role and does not persist partial CRM effects',async()=>{
  const f=await fixture();await db.crmRoleStagePermission.create({data:{workspaceId:f.workspace.id,roleId:f.role.id,stageId:f.stage.id,canEnter:false}});const a=await queue(f);expect(await f.sync.process(a.syncId)).toBe(false);expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('applies owning mandatory fields before committing customer or Deal records',async()=>{
  const f=await fixture();await db.crmFieldRequirement.create({data:{workspaceId:f.workspace.id,entityType:'CONTACT',targetKind:'SYSTEM',targetSystemFieldKey:'lastName'}});const a=await queue(f);expect(await f.sync.process(a.syncId)).toBe(false);expect(await db.commerceCrmSync.findUnique({where:{id:a.syncId}})).toMatchObject({errorCode:'FIELD_VALIDATION_FAILED'});expect(await db.crmContact.count({where:{workspaceId:f.workspace.id}})).toBe(0);expect(await db.crmDeal.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 it('keeps permanent request identities, source tenant constraints and terminal effects immutable',async()=>{
  const f=await fixture(),g=await fixture(),key=randomUUID(),a=await queue(f,key);await f.sync.process(a.syncId);await db.idempotencyRecord.deleteMany({where:{workspaceId:f.workspace.id}});expect(await queue(f,key)).toEqual(a);
  await expect(f.sync.create(f.actor,g.order.id,{},key)).rejects.toMatchObject({code:'COMMERCE_ORDER_NOT_FOUND'});
  await expect(db.commerceCrmSync.update({where:{id:a.syncId},data:{status:'QUEUED',version:{increment:1}}})).rejects.toThrow();
  await expect(db.crmDeal.create({data:{workspaceId:f.workspace.id,title:'Foreign',status:'OPEN',responsibleUserId:f.user.id,pipelineId:f.pipeline.id,stageId:f.stage.id,originSystem:'COMMERCE',originExternalId:g.order.id}})).rejects.toMatchObject({code:'P2003'});
  expect(await db.crmDeal.count({where:{workspaceId:f.workspace.id,originSystem:'COMMERCE',originExternalId:g.order.id}})).toBe(0);
 });
 it('follows shared merge redirects and rejects hidden matches instead of duplicating them',async()=>{
  const f=await fixture('NEVER'),old=await contact(f),survivor=await contact(f,'survivor@example.test');await db.crmContact.update({where:{id:old.id},data:{isDeleted:true}});
  const id=randomUUID();await db.commercialPackRecord.create({data:{id,workspaceId:f.workspace.id,collection:'mergeRedirects',data:{id,workspaceId:f.workspace.id,entityType:'CONTACT',oldEntityId:old.id,survivorEntityId:survivor.id,createdAt:new Date().toISOString()}}});
  expect(await run(f)).toMatchObject({customerWasNew:false});expect(await db.commerceCrmBinding.findFirst({where:{workspaceId:f.workspace.id,entityType:'CONTACT'}})).toMatchObject({targetId:survivor.id});
  const g=await fixture('NEVER'),c=await contact(g),user=await db.user.create({data:{firstName:'Other',lastName:'Owner',email:randomUUID()+'@example.test',status:'ACTIVE'}});await db.workspaceMembership.create({data:{workspaceId:g.workspace.id,userId:user.id,roleId:g.role.id}});await db.crmContact.update({where:{id:c.id},data:{responsibleUserId:user.id}});await grant(g,'crm.contact.read','OWN');const a=await queue(g);expect(await g.sync.process(a.syncId)).toBe(false);expect(await db.crmContact.count({where:{workspaceId:g.workspace.id}})).toBe(1);expect(await db.commerceCrmSync.findUnique({where:{id:a.syncId}})).toMatchObject({errorCode:'CRM_REFERENCE_NOT_FOUND'});
 });
 it('recovers expired claims, exhausts automatic retries and allows an explicit new-key recovery',async()=>{
  const f=await fixture(),a=await queue(f);await db.commerceCrmSync.update({where:{id:a.syncId},data:{status:'RUNNING',claimToken:randomUUID(),leaseExpiresAt:new Date(Date.now()+60000),version:{increment:1}}});expect(await f.sync.process(a.syncId)).toBe(false);
  await db.commerceCrmSync.update({where:{id:a.syncId},data:{leaseExpiresAt:new Date(Date.now()-1000),version:{increment:1}}});expect(await f.sync.process(a.syncId)).toBe(true);
  const g=await fixture(),key=randomUUID(),b=await queue(g,key);await grant(g,'crm.deal.create');for(let i=0;i<5;i++){await db.commerceCrmSync.update({where:{id:b.syncId},data:{nextAttemptAt:new Date(0),version:{increment:1}}});expect(await g.sync.process(b.syncId)).toBe(false);}
  expect(await db.commerceCrmSync.findUnique({where:{id:b.syncId}})).toMatchObject({status:'FAILED',attempts:5});expect(await queue(g,key)).toEqual(b);expect(await g.sync.process(b.syncId)).toBe(false);
  await grant(g,'crm.deal.create','WORKSPACE');const retry=await queue(g);expect(retry.syncId).toBe(b.syncId);expect(await g.sync.process(b.syncId)).toBe(true);expect(await db.commerceCrmSync.findUnique({where:{id:b.syncId}})).toMatchObject({status:'SUCCEEDED',attempts:6});expect(await db.crmDeal.count({where:{workspaceId:g.workspace.id}})).toBe(1);
 });
 it('serves the changed Nest and Next route with strict DTOs, authentication and tenant isolation',async()=>{
  const f=await fixture(),g=await fixture(),{signAccessToken}=await import('../src/server/security'),token=await signAccessToken(f.user.id),auth={authorization:'Bearer '+token,'x-workspace-id':f.workspace.id,'content-type':'application/json','idempotency-key':randomUUID()},path='/api/v1/commerce/orders/'+f.order.id+'/crm-sync';
  const {Module}=await import('@nestjs/common'),{NestFactory}=await import('@nestjs/core'),{PackRouter}=await import('../src/server/process-platform/http'),{nestControllers,configurePackBodyParsing}=await import('../src/server/process-platform/nest-adapter');
  const router=new PackRouter().add('POST','/api/v1/commerce/orders/:orderId/crm-sync','CommerceIntegrationsController',c=>f.sync.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),202);class CrmSyncTestModule{}Module({controllers:nestControllers(router)})(CrmSyncTestModule);
  const app=await NestFactory.create(CrmSyncTestModule,{logger:false,bodyParser:false});configurePackBodyParsing(app as never);
  try{await app.listen(0,'127.0.0.1');const base=await app.getUrl();expect((await fetch(base+path,{method:'POST',headers:auth,body:'{}'})).status).toBe(202);expect((await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);expect((await fetch(base+path,{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:'{"force":true}'})).status).toBe(400);expect((await fetch(base+path,{method:'POST',headers:{...auth,authorization:'Bearer '+await signAccessToken(g.user.id),'x-workspace-id':g.workspace.id},body:'{}'})).status).toBe(404);}finally{await app.close();}
  const {NextRequest}=await import('next/server'),{commerceRouter,commerceCrmSync}=await import('../src/server/commerce/routes'),spy=jest.spyOn(commerceCrmSync,'create').mockImplementation((...args)=>f.sync.create(...args));
  try{expect((await commerceRouter.dispatch(new NextRequest('http://local.test'+path,{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:'{}'}))).status).toBe(202);}finally{spy.mockRestore();}
  const {processCommercePaths}=await import('../src/server/openapi-process-commerce');expect(processCommercePaths()['/commerce/orders/{orderId}/crm-sync']).toBeDefined();
 });
});
