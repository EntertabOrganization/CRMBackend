import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { paymentCommandFixture } from './support/payment-command-fixture';
import { CommerceShipmentService } from '../src/server/commerce/shipment-service';
import { CommerceCartService } from '../src/server/commerce/cart-service';
import { CommerceCheckoutService } from '../src/server/commerce/checkout-service';
import { CommerceReturnService } from '../src/server/commerce/return-service';
import { resetRateLimits } from '../src/server/rate-limit';
import { InventoryStockService } from '../src/server/inventory/stock-service';

jest.setTimeout(120000);let db:PrismaClient;
beforeAll(async()=>{const url=await prepareProcessPlatformDatabase('truecrm_returns_test');db=new PrismaClient({datasources:{db:{url}}});},300000);
afterAll(async()=>{await db?.$disconnect();});beforeEach(()=>resetRateLimits());
async function fixture(delivered=true){
  const f=await paymentCommandFixture(db),shipments=new CommerceShipmentService(db),returns=new CommerceReturnService(db);
  const unit=await db.catalogUnit.create({data:{workspaceId:f.workspace.id,code:'EA',name:'Each',precision:0}}),priceType=await db.catalogPriceType.create({data:{workspaceId:f.workspace.id,code:'RETAIL',name:'Retail'}});
  const product=await db.catalogProduct.create({data:{workspaceId:f.workspace.id,catalogId:f.store.catalogId,type:'SIMPLE_PRODUCT',name:'Merchandise',sku:'SKU',skuKey:'sku',primaryUnitId:unit.id}});
  await db.catalogProductPrice.create({data:{workspaceId:f.workspace.id,productId:product.id,priceTypeId:priceType.id,currency:'EGP',amount:'10'}});
  const warehouse=await shipments.warehouses.create(f.actor,{name:'Main',code:'MAIN',type:'PHYSICAL',timezone:'Africa/Cairo'});
  const receipt=await shipments.documents.create(f.actor,{documentType:'STOCK_RECEIPT',warehouseIds:{destination:warehouse.id},currency:'EGP'});
  const receiptLine=await shipments.documents.line(f.actor,receipt.id,{productId:product.id,quantity:'5',unitCost:'2'}) as {documentVersion:string};
  await shipments.documents.process(f.actor,receipt.id,{expectedVersion:receiptLine.documentVersion},randomUUID());
  await db.commerceStore.update({where:{id:f.store.id},data:{priceTypeId:priceType.id,defaultWarehouseId:warehouse.id,settings:{paymentMethods:['COD'],deliveryPolicy:'PICKUP',inventoryPrincipalUserId:f.user.id}}});
  const front=await db.commerceStorefront.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,type:'WEB',slug:'returns-'+randomUUID(),status:'PUBLISHED',publishedAt:new Date()}});
  await db.commerceProductPublication.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,productId:product.id,inventoryKey:product.id,seoSlug:'item',published:true,createdByUserId:f.user.id}});
  const carts=new CommerceCartService(db),checkout=new CommerceCheckoutService(db,carts),cart=await carts.create(front.slug,{},randomUUID());await carts.mutate(front.slug,cart.cartToken,{productId:product.id,quantity:'5'},'ADD');
  const session=await checkout.create(front.slug,{cartToken:cart.cartToken,customerInfo:{name:'Buyer',email:'buyer@example.test'},shippingInfo:{country:'EG',region:'EG',city:'Cairo',line1:'Street'},payerType:'PERSON'});
  const quote=await checkout.quote(front.slug,session.id,session.checkoutSessionToken,{paymentMethodId:'COD'});
  const placed=await checkout.place(front.slug,session.id,session.checkoutSessionToken,{quoteHash:quote.quoteHash,consents:[{kind:'TERMS',version:'1',accepted:true},{kind:'PRIVACY',version:'1',accepted:true}]},randomUUID()) as {orderId:string};
  const order=await db.commerceOrder.findUniqueOrThrow({where:{id:placed.orderId}});
  const delivery=await shipments.deliveryServices(f.actor,f.store.id,{type:'PICKUP',rates:[{price:'0',currency:'EGP',estimatedDaysMin:0,estimatedDaysMax:0}]}) as {id:string};
  const shipment=await shipments.create(f.actor,order.id,{warehouseId:warehouse.id,deliveryServiceId:delivery.id,items:[{orderLineId:quote.lines[0].itemId,quantity:'5'}]},randomUUID());
  await shipments.transition(f.actor,shipment.id,{expectedVersion:shipment.version.toString()},randomUUID(),'SHIP');
  if(delivered)await shipments.transition(f.actor,shipment.id,{trackingEvidence:{reference:'Delivered',deliveredAt:new Date().toISOString()}},randomUUID(),'DELIVER');
  return{...f,order,product,warehouse,shipments,returns,shipment,lineId:quote.lines[0].itemId};
}
type F=Awaited<ReturnType<typeof fixture>>;
const request=(f:F,quantity='2',key=randomUUID())=>f.returns.create(f.actor,f.order.id,{items:[{orderLineId:f.lineId,quantity}],reason:'Wrong size'},key);
async function grant(f:F,key:string){const p=await db.permission.findUniqueOrThrow({where:{key}});await db.rolePermission.update({where:{roleId_permissionId:{roleId:f.role.id,permissionId:p.id}},data:{isDeleted:true}});}
describe('Commerce Return intake, approval and physical receipt',()=>{
  it('fences tampered approval plans even when posted directly through the Inventory API',async()=>{
    const f=await fixture(),r=await request(f,'1');await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'APPROVE'});await f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'1'}]},randomUUID());
    await db.inventorySettings.update({where:{workspaceId:f.workspace.id},data:{approvalPolicies:{CUSTOMER_RETURN:{requiresApproval:true,allowSelfApproval:true,requiredApprovals:1,actions:{}}}}});
    const input={dispositions:[{orderLineId:f.lineId,disposition:'SELLABLE',warehouseId:f.warehouse.id}]},pending=await f.returns.inspect(f.actor,r.id,input,randomUUID());
    const line=await db.inventoryDocumentLine.findUniqueOrThrow({where:{id:pending.lines[0].inventoryDocumentLineId!}});
    // Inventory can edit drafts, but it cannot post changed Commerce-owned plans.
    await db.inventoryDocumentLine.update({where:{id:line.id},data:{quantity:'2'}});
    const document=await db.inventoryDocument.findUniqueOrThrow({where:{id:line.documentId}});
    await f.shipments.documents.approval(f.actor,document.id,{expectedVersion:document.version.toString(),decision:'APPROVE'});
    const approved=await db.inventoryDocument.findUniqueOrThrow({where:{id:line.documentId}});
    await expect(f.shipments.documents.process(f.actor,document.id,{expectedVersion:approved.version.toString()},randomUUID())).rejects.toMatchObject({code:'RETURN_INVALID_TRANSITION'});
    expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id,type:'CUSTOMER_RETURN_IN'}})).toBe(0);
    await expect(f.returns.inspect(f.actor,r.id,input,randomUUID())).rejects.toMatchObject({code:'RETURN_INVALID_TRANSITION'});
  });
  it('posts sellable returns at original Inventory cost exactly once, independent of catalog sale price and Refund',async()=>{
    const f=await fixture(),r=await request(f,'2');await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'APPROVE'});await f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'2'}]},randomUUID());
    const key=randomUUID(),input={dispositions:[{orderLineId:f.lineId,disposition:'SELLABLE',warehouseId:f.warehouse.id}]};
    const result=await f.returns.inspect(f.actor,r.id,input,key);expect(result.status).toBe('COMPLETED');expect(await f.returns.inspect(f.actor,r.id,input,key)).toEqual(result);
    const movement=await db.inventoryMovement.findFirstOrThrow({where:{workspaceId:f.workspace.id,type:'CUSTOMER_RETURN_IN'}});expect(movement.quantityDelta.toFixed(6)).toBe('2.000000');expect(movement.unitCost.toFixed(6)).toBe('2.000000');expect(movement.totalCost.toFixed(6)).toBe('4.000000');
    expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id,type:'CUSTOMER_RETURN_IN'}})).toBe(1);expect(await db.outboxEvent.count({where:{entityId:r.id,eventType:'RETURN_COMPLETED'}})).toBe(1);
    const document=await db.inventoryDocument.findUniqueOrThrow({where:{id:movement.documentId}});await expect(f.shipments.documents.reverse(f.actor,document.id,{expectedVersion:document.version.toString(),reason:'Bypass Return'},randomUUID())).rejects.toMatchObject({code:'INVENTORY_DOCUMENT_REVERSAL_BLOCKED'});
    expect(await db.commercialPackRecord.count({where:{workspaceId:f.workspace.id,collection:'refunds'}})).toBe(0);
  });
  it('segregates damaged returns and rolls back attempts to add them to sellable stock',async()=>{
    const f=await fixture(),r=await request(f,'1');await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'APPROVE'});await f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'1'}]},randomUUID());
    const before=await db.inventoryDocument.count({where:{workspaceId:f.workspace.id}});
    await expect(f.returns.inspect(f.actor,r.id,{dispositions:[{orderLineId:f.lineId,disposition:'DAMAGED',warehouseId:f.warehouse.id}]},randomUUID())).rejects.toMatchObject({code:'RETURN_NOT_ELIGIBLE'});expect(await db.inventoryDocument.count({where:{workspaceId:f.workspace.id}})).toBe(before);
    const damaged=await f.shipments.warehouses.create(f.actor,{name:'Damaged',code:'DAMAGED',type:'DAMAGED',timezone:'Africa/Cairo'});
    expect((await f.returns.inspect(f.actor,r.id,{dispositions:[{orderLineId:f.lineId,disposition:'DAMAGED',warehouseId:damaged.id}]},randomUUID())).status).toBe('COMPLETED');
    expect((await db.inventoryBalance.findFirstOrThrow({where:{workspaceId:f.workspace.id,warehouseId:f.warehouse.id}})).onHand.eq(0)).toBe(true);
    expect((await db.inventoryBalance.findFirstOrThrow({where:{workspaceId:f.workspace.id,warehouseId:damaged.id}})).onHand.eq(1)).toBe(true);
    expect(await db.$transaction(tx=>new InventoryStockService(db).publicSellability(tx,f.workspace.id,f.product.id))).toMatchObject({available:false});
  });
  it('holds Inventory approval checkpoints and resumes pinned plans without replaying posted effects',async()=>{
    const f=await fixture(),r=await request(f,'1');await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'APPROVE'});await f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'1'}]},randomUUID());
    await db.inventorySettings.update({where:{workspaceId:f.workspace.id},data:{approvalPolicies:{CUSTOMER_RETURN:{requiresApproval:true,allowSelfApproval:true,requiredApprovals:1,actions:{}}}}});
    const input={dispositions:[{orderLineId:f.lineId,disposition:'SELLABLE',warehouseId:f.warehouse.id}]},key=randomUUID(),pending=await f.returns.inspect(f.actor,r.id,input,key);expect(pending.status).toBe('INSPECTING');
    const line=await db.inventoryDocumentLine.findUniqueOrThrow({where:{id:pending.lines[0].inventoryDocumentLineId!}}),document=await db.inventoryDocument.findUniqueOrThrow({where:{id:line.documentId}});expect(document.status).toBe('PENDING_APPROVAL');
    await expect(f.returns.inspect(f.actor,r.id,{dispositions:[{orderLineId:f.lineId,disposition:'REJECT'}]},randomUUID())).rejects.toMatchObject({code:'RETURN_INVALID_TRANSITION'});
    await f.shipments.documents.approval(f.actor,document.id,{expectedVersion:document.version.toString(),decision:'APPROVE'});
    expect(await f.returns.inspect(f.actor,r.id,input,key)).toEqual(pending);
    expect((await f.returns.inspect(f.actor,r.id,input,randomUUID())).status).toBe('COMPLETED');expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id,type:'CUSTOMER_RETURN_IN'}})).toBe(1);
  });
  it('reject disposition closes received merchandise without creating any stock',async()=>{
    const f=await fixture(),r=await request(f,'1');await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'APPROVE'});await f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'1'}]},randomUUID());
    expect((await f.returns.inspect(f.actor,r.id,{dispositions:[{orderLineId:f.lineId,disposition:'REJECT'}]},randomUUID())).status).toBe('COMPLETED');expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id,type:'CUSTOMER_RETURN_IN'}})).toBe(0);
  });
  it('claims only delivered cumulative quantities, fences concurrent over-claims and retries once',async()=>{
    const f=await fixture(),key=randomUUID(),a=await request(f,'2',key);
    expect(await request(f,'2',key)).toEqual(a);await expect(request(f,'3',key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
    const race=await Promise.allSettled([request(f,'3'),request(f,'3')]);expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(race.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'RETURN_QUANTITY_EXCEEDED'}});
    expect(await db.commerceReturn.count({where:{orderId:f.order.id}})).toBe(2);expect(await db.outboxEvent.count({where:{workspaceId:f.workspace.id,eventType:'RETURN_REQUESTED'}})).toBe(2);
    await db.idempotencyRecord.deleteMany({where:{workspaceId:f.workspace.id}});expect(await request(f,'2',key)).toEqual(a);
  });
  it('requires delivered merchandise and obeys disabled/window Store policy without partial writes',async()=>{
    const f=await fixture(false);await expect(request(f)).rejects.toMatchObject({code:'RETURN_QUANTITY_EXCEEDED'});expect(await db.commerceReturn.count({where:{orderId:f.order.id}})).toBe(0);
    const g=await fixture();await db.commerceStore.update({where:{id:g.store.id},data:{settings:{...g.store.settings as object,returnPolicy:{enabled:false,windowDays:30}}}});
    await expect(request(g)).rejects.toMatchObject({code:'RETURN_NOT_ELIGIBLE'});
    await db.commerceStore.update({where:{id:g.store.id},data:{settings:{returnPolicy:{enabled:true,windowDays:1}}}});
    const clock=jest.spyOn(Date,'now').mockReturnValue(Date.now()+2*86400000);
    try{await expect(request(g)).rejects.toMatchObject({code:'RETURN_QUANTITY_EXCEEDED'});}finally{clock.mockRestore();}
    expect(await db.commerceReturnCommand.count({where:{workspaceId:g.workspace.id}})).toBe(0);
  });
  it('rejects stale approval and releases rejected merchandise claims for a new request',async()=>{
    const f=await fixture(),r=await request(f,'5');await expect(f.returns.approve(f.actor,r.id,{expectedVersion:'2',decision:'APPROVE'})).rejects.toMatchObject({code:'RESOURCE_VERSION_CONFLICT'});
    const rejected=await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'REJECT',reason:'Not eligible'});expect(rejected.status).toBe('REJECTED');expect((await request(f,'5')).status).toBe('REQUESTED');
    await expect(f.returns.approve(f.actor,r.id,{expectedVersion:rejected.version,decision:'APPROVE'})).rejects.toMatchObject({code:'RETURN_INVALID_TRANSITION'});
  });
  it('records partial receipts once without adding sellable stock or creating a financial refund',async()=>{
    const f=await fixture(),r=await request(f,'3'),before=await db.inventoryMovement.count({where:{workspaceId:f.workspace.id}});
    const input={receivedLines:[{orderLineId:f.lineId,quantity:'1'}]},key=randomUUID();
    await expect(f.returns.receive(f.actor,r.id,input,key)).rejects.toMatchObject({code:'RETURN_INVALID_TRANSITION'});
    await f.returns.approve(f.actor,r.id,{expectedVersion:r.version,decision:'APPROVE'});
    const received=await f.returns.receive(f.actor,r.id,input,key);expect(received.lines[0].receivedQuantity).toBe('1.000000');expect(await f.returns.receive(f.actor,r.id,input,key)).toEqual(received);
    await expect(f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'3'}]},randomUUID())).rejects.toMatchObject({code:'RETURN_QUANTITY_EXCEEDED'});
    const full=await f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'2'}]},randomUUID());expect(full.lines[0].receivedQuantity).toBe('3.000000');expect(full.status).toBe('RECEIVED');
    expect(await db.inventoryMovement.count({where:{workspaceId:f.workspace.id}})).toBe(before);expect(await db.commercialPackRecord.count({where:{workspaceId:f.workspace.id,collection:'refunds'}})).toBe(0);
    expect(await db.commerceReturnEvent.count({where:{returnId:r.id,action:'RETURN_RECEIVED'}})).toBe(2);
    const balance=await db.inventoryBalance.findFirstOrThrow({where:{workspaceId:f.workspace.id,inventoryKey:f.product.id}});expect(balance.onHand.toFixed()).toBe('0');
  });
  it('rejects tenant IDs, revoked permissions, privileged fields and invalid receipt lines',async()=>{
    const f=await fixture(),g=await fixture(),r=await request(f);
    await expect(g.returns.get(g.actor,r.id)).rejects.toMatchObject({code:'RETURN_NOT_FOUND'});
    await expect(g.returns.create(g.actor,f.order.id,{items:[{orderLineId:f.lineId,quantity:'1'}],reason:'Return'},randomUUID())).rejects.toMatchObject({code:'COMMERCE_ORDER_NOT_FOUND'});
    await expect(f.returns.create(f.actor,f.order.id,{items:[{orderLineId:f.lineId,quantity:'1'}],reason:'Return',workspaceId:f.workspace.id},randomUUID())).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
    await f.returns.approve(f.actor,r.id,{expectedVersion:'1',decision:'APPROVE'});await expect(f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:randomUUID(),quantity:'1'}]},randomUUID())).rejects.toMatchObject({code:'RETURN_QUANTITY_EXCEEDED'});
    await grant(f,'COMMERCE.RETURN_RECEIVE');await expect(f.returns.receive(f.actor,r.id,{receivedLines:[{orderLineId:f.lineId,quantity:'1'}]},randomUUID())).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await grant(f,'COMMERCE.RETURN_VIEW');await expect(f.returns.list(f.actor,{})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(f.returns.get(f.actor,r.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('enforces PostgreSQL cumulative quantities, parent isolation and immutable receipt evidence',async()=>{
    const f=await fixture(),g=await fixture(),r=await request(f,'5');
    await expect(db.commerceReturnLine.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:f.order.id,returnId:r.id,orderLineId:randomUUID(),quantity:'1'}})).rejects.toThrow();
    await expect(db.commerceReturn.create({data:{workspaceId:g.workspace.id,storeId:g.store.id,orderId:f.order.id,reason:'Foreign',policySnapshot:{},requestedByUserId:g.user.id}})).rejects.toMatchObject({code:'P2003'});
    await expect(db.commerceReturnEvent.deleteMany({where:{returnId:r.id}})).rejects.toThrow();
    await expect(db.commerceReturnLine.update({where:{id:r.lines[0].id},data:{quantity:'6'}})).rejects.toThrow();
  });
  it('serves all five actual Nest routes and Next dispatch with persisted history and OpenAPI',async()=>{
    const f=await fixture(),{Module}=await import('@nestjs/common'),{NestFactory}=await import('@nestjs/core'),{PackRouter}=await import('../src/server/process-platform/http'),{nestControllers,configurePackBodyParsing}=await import('../src/server/process-platform/nest-adapter'),{signAccessToken}=await import('../src/server/security');
    const router=new PackRouter().add('POST','/api/v1/commerce/orders/:orderId/returns','CommerceReturnsController',c=>f.returns.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),201).add('GET','/api/v1/commerce/returns','CommerceReturnsController',c=>f.returns.list(c.actor,c.query)).add('GET','/api/v1/commerce/returns/:returnId','CommerceReturnsController',c=>f.returns.get(c.actor,c.params.returnId)).add('POST','/api/v1/commerce/returns/:returnId/approve','CommerceReturnsController',c=>f.returns.approve(c.actor,c.params.returnId,c.body)).add('POST','/api/v1/commerce/returns/:returnId/receive','CommerceReturnsController',c=>f.returns.receive(c.actor,c.params.returnId,c.body,c.request.headers.get('idempotency-key')));
    router.add('POST','/api/v1/commerce/returns/:returnId/inspect','CommerceReturnsController',c=>f.returns.inspect(c.actor,c.params.returnId,c.body,c.request.headers.get('idempotency-key')));
    class ReturnTestModule{}Module({controllers:nestControllers(router)})(ReturnTestModule);const app=await NestFactory.create(ReturnTestModule,{logger:false,bodyParser:false});configurePackBodyParsing(app as never);
    const auth={authorization:'Bearer '+await signAccessToken(f.user.id),'x-workspace-id':f.workspace.id,'content-type':'application/json'};
    try{await app.listen(0,'127.0.0.1');const base=await app.getUrl(),path=base+'/api/v1/commerce/orders/'+f.order.id+'/returns';
      expect((await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
      const created=await fetch(path,{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({items:[{orderLineId:f.lineId,quantity:'1'}],reason:'Return'})});expect(created.status).toBe(201);const r=(await created.json()).data;
      expect((await fetch(base+'/api/v1/commerce/returns?limit=1',{headers:auth})).status).toBe(200);
      const returnPath=base+'/api/v1/commerce/returns/'+r.id;
      expect((await fetch(returnPath+'/approve',{method:'POST',headers:auth,body:JSON.stringify({expectedVersion:r.version,decision:'APPROVE'})})).status).toBe(200);
      expect((await fetch(returnPath+'/receive',{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({receivedLines:[{orderLineId:f.lineId,quantity:'1'}]})})).status).toBe(200);
      const get=await fetch(returnPath,{headers:auth});expect(get.status).toBe(200);expect((await get.json()).data.history).toHaveLength(3);
      expect((await fetch(returnPath+'/inspect',{method:'POST',headers:{...auth,'idempotency-key':randomUUID()},body:JSON.stringify({dispositions:[{orderLineId:f.lineId,disposition:'REJECT'}]})})).status).toBe(200);
    }finally{await app.close();}
    const {NextRequest}=await import('next/server'),{commerceRouter,commerceReturns}=await import('../src/server/commerce/routes'),spy=jest.spyOn(commerceReturns,'list').mockImplementation((...args)=>f.returns.list(...args));
    try{expect((await commerceRouter.dispatch(new NextRequest('http://local.test/api/v1/commerce/returns',{headers:auth}))).status).toBe(200);}finally{spy.mockRestore();}
    const {processCommercePaths}=await import('../src/server/openapi-process-commerce');for(const path of ['/commerce/orders/{orderId}/returns','/commerce/returns','/commerce/returns/{returnId}','/commerce/returns/{returnId}/approve','/commerce/returns/{returnId}/receive'])expect(processCommercePaths()[path]).toBeDefined();
  });
});
