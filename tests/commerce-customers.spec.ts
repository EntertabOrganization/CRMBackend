import { PrismaClient } from '@prisma/client';
import { randomUUID,createHmac } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommerceCustomerService,checkoutCustomer } from '../src/server/commerce/customer-service';
import { CommerceCheckoutService } from '../src/server/commerce/checkout-service';
import { CommerceCartService } from '../src/server/commerce/cart-service';
import { signAccessToken } from '../src/server/security';
import { resetRateLimits } from '../src/server/rate-limit';

jest.setTimeout(120000);let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_customers_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});
beforeEach(()=>resetRateLimits());
async function fixture(){
  const f=await paymentCommandFixture(db);
  const front=await db.commerceStorefront.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,type:'WEB',slug:'customers-'+randomUUID(),status:'PUBLISHED',publishedAt:new Date()}});
  // This customer has no employee membership in any Workspace.
  const identity=await db.user.create({data:{firstName:'Customer',lastName:'Identity',email:randomUUID()+'@example.test',status:'ACTIVE',emailVerifiedAt:new Date()}});
  const authorization='Bearer '+await signAccessToken(identity.id);
  const account=await db.$transaction(tx=>checkoutCustomer(tx,f.store,authorization,identity.email));
  if(!account)throw new Error('Fixture account missing');
  const carts=new CommerceCartService(db),checkout=new CommerceCheckoutService(db,carts),customers=new CommerceCustomerService(db);
  return{...f,front,identity,authorization,account,carts,checkout,customers};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function grant(f:F,key:string,scope?:'OWN'|'WORKSPACE'){
  const p=await db.permission.findUniqueOrThrow({where:{key}});
  await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:scope?{scope,isDeleted:false}:{isDeleted:true}});
}
async function placed(f:F,authenticated=true){
  const priceType=await db.catalogPriceType.create({data:{workspaceId:f.workspace.id,code:'PRICE_'+randomUUID().slice(0,8),name:'Retail'}});
  const product=await db.catalogProduct.create({data:{workspaceId:f.workspace.id,catalogId:f.store.catalogId,type:'SERVICE',name:'Service'}});
  const price=await db.catalogProductPrice.create({data:{workspaceId:f.workspace.id,productId:product.id,priceTypeId:priceType.id,amount:'12.34',currency:'EGP'}});
  await db.commerceStore.update({where:{id:f.store.id},data:{priceTypeId:priceType.id}});
  await db.commerceProductPublication.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,productId:product.id,inventoryKey:product.id,seoSlug:'product-'+randomUUID(),published:true,createdByUserId:f.user.id}});
  const cart=await f.carts.create(f.front.slug,{},randomUUID());await f.carts.mutate(f.front.slug,cart.cartToken,{productId:product.id,quantity:'2'},'ADD');
  const session=await f.checkout.create(f.front.slug,{cartToken:cart.cartToken,customerInfo:{name:'Customer',email:f.identity.email},shippingInfo:{country:'EG',region:'EG',city:'Cairo',line1:'Private address'},payerType:'PERSON'},authenticated?f.authorization:null);
  const quote=await f.checkout.quote(f.front.slug,session.id,session.checkoutSessionToken,{paymentMethodId:'OFFLINE'});
  const input={quoteHash:quote.quoteHash,consents:[{kind:'TERMS',version:'1',accepted:true},{kind:'PRIVACY',version:'1',accepted:true}]};
  const result=await f.checkout.place(f.front.slug,session.id,session.checkoutSessionToken,input,randomUUID()) as {orderId:string};
  return{result,session,product,price};
}
describe('Commerce customer accounts and purchase history',()=>{
  it('reorders using current prices and options without changing historical snapshots',async()=>{
    const f=await fixture(),p=await placed(f),before=await db.commerceOrder.findUniqueOrThrow({where:{id:p.result.orderId}});
    await db.catalogProductPrice.update({where:{id:p.price.id},data:{amount:'19.99',version:{increment:1}}});
    const cart=await f.customers.reorder(f.front.slug,p.result.orderId,f.authorization,{});
    expect(cart.subtotal).toBe('39.98');expect(cart.items).toHaveLength(1);expect(cart.items[0]).toMatchObject({productId:p.product.id,quantity:'2.000000',unitPrice:'19.99'});
    expect((await f.carts.get(f.front.slug,cart.cartToken)).subtotal).toBe('39.98');expect(await db.commerceOrder.findUnique({where:{id:p.result.orderId}})).toEqual(before);
    expect(await db.outboxEvent.count({where:{entityId:cart.id,eventType:'CART_CREATED'}})).toBe(1);
  });
  it('rejects reordered foreign or guest Orders and rolls back an unpublished product Cart',async()=>{
    const f=await fixture(),g=await fixture(),p=await placed(f),guest=await placed(f,false);
    await expect(f.customers.reorder(f.front.slug,p.result.orderId,g.authorization,{})).rejects.toMatchObject({status:403});
    await expect(f.customers.reorder(f.front.slug,guest.result.orderId,f.authorization,{})).rejects.toMatchObject({code:'COMMERCE_ORDER_NOT_FOUND'});
    const count=await db.commerceCart.count({where:{storeId:f.store.id}}),events=await db.outboxEvent.count({where:{workspaceId:f.workspace.id}});
    await db.commerceProductPublication.updateMany({where:{storeId:f.store.id,productId:p.product.id},data:{published:false}});
    await expect(f.customers.reorder(f.front.slug,p.result.orderId,f.authorization,{})).rejects.toMatchObject({code:'COMMERCE_ITEM_NOT_AVAILABLE'});
    expect(await db.commerceCart.count({where:{storeId:f.store.id}})).toBe(count);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id}})).toBe(events);
    await expect(f.customers.reorder(f.front.slug,p.result.orderId,f.authorization,{unitPrice:'1'})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  });
  it('links normalized shared CRM matches exactly once with audited resolution and no Order rewrite',async()=>{
    const f=await fixture(),order=await placed(f),before=await db.commerceOrder.findUniqueOrThrow({where:{id:order.result.orderId}});
    const contact=await db.crmContact.create({data:{workspaceId:f.workspace.id,firstName:'Known',lastName:'Customer',displayName:'Known Customer',responsibleUserId:f.user.id}});
    await db.crmContactCommunication.create({data:{workspaceId:f.workspace.id,contactId:contact.id,type:'EMAIL',value:f.identity.email.toUpperCase(),normalizedValue:f.identity.email}});
    const input={resolutionReason:'Verified account match'},linked=await f.customers.link(f.actor,f.account.id,input);
    expect(linked.bindings).toEqual([{type:'CONTACT',targetId:contact.id,version:'1'}]);expect(await f.customers.link(f.actor,f.account.id,input)).toEqual(linked);
    expect(await db.commerceCustomerBinding.count({where:{customerAccountId:f.account.id}})).toBe(1);
    expect(await db.outboxEvent.count({where:{entityId:f.account.id,eventType:'COMMERCE_CUSTOMER_LINKED'}})).toBe(1);
    expect(await db.auditLog.findFirst({where:{entityId:f.account.id,action:'COMMERCE_CUSTOMER_LINKED'}})).toMatchObject({actorUserId:f.user.id,afterData:{resolutionReason:input.resolutionReason,targetId:contact.id}});
    expect(await db.commerceOrder.findUnique({where:{id:order.result.orderId}})).toEqual(before);
  });
  it('requires explicit resolution for ambiguous identities and honors shared merge redirects',async()=>{
    const f=await fixture(),create=async(email:string)=>{const c=await db.crmContact.create({data:{workspaceId:f.workspace.id,firstName:'Contact',lastName:'',displayName:'Contact',responsibleUserId:f.user.id}});await db.crmContactCommunication.create({data:{workspaceId:f.workspace.id,contactId:c.id,type:'EMAIL',value:email,normalizedValue:email}});return c;};
    const a=await create(f.identity.email),b=await create(f.identity.email);
    await expect(f.customers.link(f.actor,f.account.id,{resolutionReason:'Ambiguous'})).rejects.toMatchObject({code:'COMMERCE_CRM_IDENTITY_AMBIGUOUS'});
    expect(await db.commerceCustomerBinding.count({where:{customerAccountId:f.account.id}})).toBe(0);
    const chosen=await f.customers.link(f.actor,f.account.id,{contactId:b.id,resolutionReason:'Operator reviewed duplicate candidates'});expect(chosen.bindings[0].targetId).toBe(b.id);
    await db.crmContact.update({where:{id:b.id},data:{isDeleted:true}});const redirect=randomUUID();await db.commercialPackRecord.create({data:{id:redirect,workspaceId:f.workspace.id,collection:'mergeRedirects',data:{id:redirect,workspaceId:f.workspace.id,entityType:'CONTACT',oldEntityId:b.id,survivorEntityId:a.id,createdAt:new Date().toISOString()}}});
    expect((await f.customers.link(f.actor,f.account.id,{contactId:b.id,resolutionReason:'Follow merge survivor'})).bindings[0]).toMatchObject({targetId:a.id,version:'2'});
  });
  it('rolls back all bindings and events when the second CRM reference is inaccessible',async()=>{
    const f=await fixture(),g=await fixture(),contact=await db.crmContact.create({data:{workspaceId:f.workspace.id,firstName:'Local',lastName:'Contact',displayName:'Local Contact',responsibleUserId:f.user.id}}),company=await db.crmCompany.create({data:{workspaceId:g.workspace.id,name:'Foreign',responsibleUserId:g.user.id}});
    await expect(f.customers.link(f.actor,f.account.id,{contactId:contact.id,companyId:company.id,resolutionReason:'Manual'})).rejects.toMatchObject({code:'CRM_REFERENCE_NOT_FOUND'});
    expect(await db.commerceCustomerBinding.count({where:{customerAccountId:f.account.id}})).toBe(0);expect(await db.outboxEvent.count({where:{entityId:f.account.id}})).toBe(0);
    await grant(f,'COMMERCE.CUSTOMER_MANAGE');await expect(f.customers.link(f.actor,f.account.id,{contactId:contact.id,resolutionReason:'Manual'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await grant(f,'COMMERCE.CUSTOMER_MANAGE','WORKSPACE');await grant(f,'crm.contact.read');await expect(f.customers.link(f.actor,f.account.id,{contactId:contact.id,resolutionReason:'Manual'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(f.customers.link(f.actor,f.account.id,{contactId:contact.id,resolutionReason:'',workspaceId:f.workspace.id})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  });
  it('associates authenticated checkout once and does not claim guest Orders by email',async()=>{
    const f=await fixture(),own=await placed(f),guest=await placed(f,false);
    expect(await db.commerceCustomerAccount.count({where:{storeId:f.store.id}})).toBe(1);
    expect(await db.commerceOrder.findUnique({where:{id:own.result.orderId}})).toMatchObject({customerAccountId:f.account.id});
    expect(await db.commerceOrder.findUnique({where:{id:guest.result.orderId}})).toMatchObject({customerAccountId:null});
    const view=await f.customers.ownOrders(f.front.slug,f.authorization,{});
    expect(view.data.map(o=>o.id)).toEqual([own.result.orderId]);expect(view.data[0].total).toBe('24.680000');
    expect(JSON.stringify(view)).not.toContain('Private address');expect(view.data[0]).not.toHaveProperty('snapshot');
    expect(await db.workspaceMembership.count({where:{userId:f.identity.id}})).toBe(0);
  });
  it('lists only scoped customer fields and paginates without leaking Auth or address data',async()=>{
    const f=await fixture(),g=await fixture();await placed(f);
    const view=await f.customers.list(f.actor,{search:f.identity.email,limit:1});
    expect(view.meta).toMatchObject({page:1,limit:1,total:1,totalPages:1});expect(view.data[0]).toMatchObject({id:f.account.id,emailNormalized:f.identity.email});
    expect(view.data[0]).not.toHaveProperty('identityAuthId');expect(JSON.stringify(view)).not.toContain(g.identity.email);
    expect((await f.customers.orders(f.actor,f.account.id,{})).data).toHaveLength(1);
    await expect(f.customers.orders(f.actor,g.account.id,{})).rejects.toMatchObject({code:'COMMERCE_CUSTOMER_NOT_FOUND'});
    await grant(f,'COMMERCE.CUSTOMER_VIEW');await expect(f.customers.list(f.actor,{})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(f.customers.orders(f.actor,f.account.id,{})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('enforces Store OWN scope, current membership and Commerce entitlement',async()=>{
    const f=await fixture(),other=await db.user.create({data:{firstName:'Other',lastName:'Owner',email:randomUUID()+'@example.test',status:'ACTIVE'}});
    await db.workspaceMembership.create({data:{workspaceId:f.workspace.id,userId:other.id,roleId:f.role.id}});
    await db.commerceStore.update({where:{id:f.store.id},data:{createdByUserId:other.id}});await grant(f,'COMMERCE.CUSTOMER_VIEW','OWN');
    expect((await f.customers.list(f.actor,{})).data).toEqual([]);await expect(f.customers.orders(f.actor,f.account.id,{})).rejects.toMatchObject({status:404});
    await db.workspaceMembership.updateMany({where:{workspaceId:f.workspace.id,userId:f.user.id},data:{isDeleted:true}});
    await expect(f.customers.list(f.actor,{})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    const g=await fixture();await db.workspace.update({where:{id:g.workspace.id},data:{settings:{entitlements:{commerce:false}}}});
    await expect(g.customers.ownOrders(g.front.slug,g.authorization,{})).rejects.toMatchObject({status:404});
  });
  it('rejects missing, forged, expired, disabled and unverified customer identities',async()=>{
    const f=await fixture();await expect(f.customers.ownOrders(f.front.slug,null,{})).rejects.toMatchObject({status:401});
    const expiredBody=Buffer.from(JSON.stringify({sub:f.identity.id,typ:'access',exp:Math.floor(Date.now()/1000)-60})).toString('base64url'),expiredSignature=createHmac('sha256',process.env.JWT_ACCESS_SECRET??'test-access-secret-minimum-32-chars').update(expiredBody).digest('base64url');
    await expect(f.customers.ownOrders(f.front.slug,'Bearer '+expiredBody+'.'+expiredSignature,{})).rejects.toMatchObject({status:401});
    await expect(f.customers.ownOrders(f.front.slug,'Bearer invalid',{})).rejects.toMatchObject({status:401});
    await db.user.update({where:{id:f.identity.id},data:{emailVerifiedAt:null}});await expect(f.customers.ownOrders(f.front.slug,f.authorization,{})).rejects.toMatchObject({status:401});
    await db.user.update({where:{id:f.identity.id},data:{emailVerifiedAt:new Date(),isDeleted:true}});await expect(f.customers.ownOrders(f.front.slug,f.authorization,{})).rejects.toMatchObject({status:401});
    await db.user.update({where:{id:f.identity.id},data:{isDeleted:false}});await db.commerceCustomerAccount.update({where:{id:f.account.id},data:{status:'DISABLED'}});await expect(f.customers.ownOrders(f.front.slug,f.authorization,{})).rejects.toMatchObject({status:403});
  });
  it('rejects another Store account and mismatched checkout identity with no account mutation',async()=>{
    const f=await fixture(),g=await fixture();await expect(f.customers.ownOrders(g.front.slug,f.authorization,{})).rejects.toMatchObject({status:403});
    await expect(db.$transaction(tx=>checkoutCustomer(tx,f.store,f.authorization,g.identity.email))).rejects.toMatchObject({code:'COMMERCE_CUSTOMER_ACCESS_DENIED'});
    expect(await db.commerceCustomerAccount.count({where:{storeId:f.store.id}})).toBe(1);
    await expect(f.customers.list(f.actor,{sortBy:'identityAuthId'})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
    await expect(f.customers.ownOrders(f.front.slug,f.authorization,{search:'private'})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  });
  it('enforces tenant/Store foreign keys and immutable historical Order identity in PostgreSQL',async()=>{
    const f=await fixture(),g=await fixture(),order=await placed(f);
    await expect(db.commerceCheckoutSession.update({where:{id:order.session.id},data:{customerAccountId:g.account.id}})).rejects.toMatchObject({code:'P2003'});
    await expect(db.commerceOrder.update({where:{id:order.result.orderId},data:{customerAccountId:null}})).rejects.toThrow();
    expect(await db.commerceOrder.findUnique({where:{id:order.result.orderId}})).toMatchObject({customerAccountId:f.account.id});
  });
  it('serves actual Nest routes and Next dispatch with authentication, pagination and strict DTOs',async()=>{
    const f=await fixture(),p=await placed(f),contact=await db.crmContact.create({data:{workspaceId:f.workspace.id,firstName:'Known',lastName:'',displayName:'Known',responsibleUserId:f.user.id}});
    const {Module}=await import('@nestjs/common'),{NestFactory}=await import('@nestjs/core'),{PackRouter}=await import('../src/server/process-platform/http'),{nestControllers,configurePackBodyParsing}=await import('../src/server/process-platform/nest-adapter');
    const router=new PackRouter().add('GET','/api/v1/commerce/customers','CommerceCustomersController',c=>f.customers.list(c.actor,c.query)).add('GET','/api/v1/commerce/customers/:customerId/orders','CommerceOrdersController',c=>f.customers.orders(c.actor,c.params.customerId,c.query)).addPublic('GET','/api/v1/storefront/:storeSlug/account/orders','CommerceCustomersController',c=>f.customers.ownOrders(c.params.storeSlug,c.request.headers.get('authorization'),c.query));
    router.add('POST','/api/v1/commerce/customers/:customerId/crm-link','CommerceCustomersController',c=>f.customers.link(c.actor,c.params.customerId,c.body)).addPublic('POST','/api/v1/storefront/:storeSlug/orders/:orderId/reorder','CommerceOrdersController',c=>f.customers.reorder(c.params.storeSlug,c.params.orderId,c.request.headers.get('authorization'),c.body),201);
    class CustomerTestModule{}Module({controllers:nestControllers(router)})(CustomerTestModule);
    const app=await NestFactory.create(CustomerTestModule,{logger:false,bodyParser:false});configurePackBodyParsing(app as never);
    const auth={authorization:'Bearer '+await signAccessToken(f.user.id),'x-workspace-id':f.workspace.id};
    try{await app.listen(0,'127.0.0.1');const base=await app.getUrl();
      expect((await fetch(base+'/api/v1/commerce/customers')).status).toBe(401);
      const admin=await fetch(base+'/api/v1/commerce/customers?limit=1',{headers:auth});expect(admin.status).toBe(200);expect(await admin.json()).toMatchObject({success:true,meta:{total:1}});
      expect((await fetch(base+'/api/v1/commerce/customers/'+f.account.id+'/orders',{headers:auth})).status).toBe(200);
      const linkPath=base+'/api/v1/commerce/customers/'+f.account.id+'/crm-link',linkBody=JSON.stringify({contactId:contact.id,resolutionReason:'Reviewed'});
      expect((await fetch(linkPath,{method:'POST',headers:{...auth,'content-type':'application/json'},body:linkBody})).status).toBe(200);
      expect((await fetch(linkPath,{method:'POST',headers:{'content-type':'application/json'},body:linkBody})).status).toBe(401);
      const reorderPath=base+'/api/v1/storefront/'+f.front.slug+'/orders/'+p.result.orderId+'/reorder';
      expect((await fetch(reorderPath,{method:'POST',headers:{authorization:f.authorization,'content-type':'application/json'},body:'{}'})).status).toBe(201);
      expect((await fetch(reorderPath,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
      const own=await fetch(base+'/api/v1/storefront/'+f.front.slug+'/account/orders',{headers:{authorization:f.authorization}});expect(own.status).toBe(200);expect(await own.json()).toMatchObject({success:true,meta:{total:1}});
      expect((await fetch(base+'/api/v1/storefront/'+f.front.slug+'/account/orders?workspaceId='+f.workspace.id,{headers:{authorization:f.authorization}})).status).toBe(400);
    }finally{await app.close();}
    const {NextRequest}=await import('next/server'),{commerceRouter,commerceCustomers}=await import('../src/server/commerce/routes');
    const spy=jest.spyOn(commerceCustomers,'ownOrders').mockImplementation((...args)=>f.customers.ownOrders(...args));
    try{expect((await commerceRouter.dispatch(new NextRequest('http://local.test/api/v1/storefront/'+f.front.slug+'/account/orders',{headers:{authorization:f.authorization}}))).status).toBe(200);}finally{spy.mockRestore();}
    const {processCommercePaths}=await import('../src/server/openapi-process-commerce');
    for(const path of ['/commerce/customers','/commerce/customers/{customerId}/orders','/commerce/customers/{customerId}/crm-link','/storefront/{storeSlug}/account/orders','/storefront/{storeSlug}/orders/{orderId}/reorder'])expect(processCommercePaths()[path]).toBeDefined();
  });
});
