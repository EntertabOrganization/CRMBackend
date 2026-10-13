import { PrismaClient } from '@prisma/client';
import { randomUUID,createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { resetRateLimits } from '../src/server/rate-limit';
import { signAccessToken } from '../src/server/security';
import { CommerceShipmentService } from '../src/server/commerce/shipment-service';
import { CommerceCartService } from '../src/server/commerce/cart-service';
import { CommerceCheckoutService } from '../src/server/commerce/checkout-service';
import { CommerceStoreService } from '../src/server/commerce/store-service';

jest.setTimeout(120000);
let db: PrismaClient,shipments: CommerceShipmentService;
const consents = [{ kind: 'TERMS',version: '1',accepted: true },{ kind: 'PRIVACY',version: '1',accepted: true }];

beforeAll(async () => {
  const databaseUrl = await prepareProcessPlatformDatabase('truecrm_shipments_test'); db = new PrismaClient({ datasources: { db: { url: databaseUrl } } }); shipments = new CommerceShipmentService(db);
},300000);
afterAll(async () => { await db?.$disconnect(); const { prisma } = await import('../src/server/prisma-client'); await prisma.$disconnect(); });
beforeEach(() => resetRateLimits());

async function fixture(quantity = '10',method: 'COD'|'OFFLINE' = 'COD') {
  const user = await db.user.create({ data: { firstName: 'Shipment',lastName: 'Test',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Shipments',slug: randomUUID(),ownerUserId: user.id } });
  const role = await db.role.create({ data: { workspaceId: workspace.id,name: 'Operator' } });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id,userId: user.id,roleId: role.id } });
  await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(permission => ({ roleId: role.id,permissionId: permission.id,scope: 'WORKSPACE' as const })) });
  const actor = await resolvePrincipal(db,workspace.id,user.id);
  const catalog = await db.catalog.create({ data: { workspaceId: workspace.id,name: 'Catalog',normalizedName: 'catalog' } });
  const unit = await db.catalogUnit.create({ data: { workspaceId: workspace.id,name: 'Each',code: 'EA',precision: 0 } });
  const priceType = await db.catalogPriceType.create({ data: { workspaceId: workspace.id,name: 'Retail',code: 'RETAIL' } });
  const product = await db.catalogProduct.create({ data: { workspaceId: workspace.id,catalogId: catalog.id,type: 'SIMPLE_PRODUCT',name: 'Product',sku: 'TEST',skuKey: 'test',primaryUnitId: unit.id } });
  await db.catalogProductPrice.create({ data: { workspaceId: workspace.id,productId: product.id,priceTypeId: priceType.id,currency: 'EGP',amount: '10' } });
  const warehouses = [];
  for (const [code,stock] of [['FIRST','6'],['SECOND','4']]) {
    const warehouse = await shipments.warehouses.create(actor,{ name: code,code,type: 'PHYSICAL',timezone: 'Africa/Cairo' });
    const receipt = await shipments.documents.create(actor,{ documentType: 'STOCK_RECEIPT',warehouseIds: { destination: warehouse.id },currency: 'EGP' });
    const line = await shipments.documents.line(actor,receipt.id,{ productId: product.id,quantity: stock,unitCost: '2' }) as { documentVersion: string };
    await shipments.documents.process(actor,receipt.id,{ expectedVersion: line.documentVersion },randomUUID()); warehouses.push(warehouse);
  }
  await db.inventorySettings.update({ where: { workspaceId: workspace.id },data: { defaultAllocationStrategy: 'MOST_AVAILABLE' } });
  const store = await db.commerceStore.create({ data: { workspaceId: workspace.id,name: 'Store',code: 'STORE',catalogId: catalog.id,priceTypeId: priceType.id,defaultCurrency: 'EGP',timezone: 'Africa/Cairo',createdByUserId: user.id,
    settings: { paymentMethods: ['COD','OFFLINE'],deliveryPolicy: 'PICKUP',inventoryPrincipalUserId: user.id } } });
  const front = await db.commerceStorefront.create({ data: { workspaceId: workspace.id,storeId: store.id,type: 'WEB',slug: 'shipment-'+randomUUID() } });
  await db.commerceProductPublication.create({ data: { workspaceId: workspace.id,storeId: store.id,productId: product.id,inventoryKey: product.id,seoSlug: 'product',published: true,createdByUserId: user.id } });
  const stores = new CommerceStoreService(db); await stores.activate(actor,store.id,{ expectedVersion: '1' }); await stores.publishStorefront(actor,front.id,{ expectedVersion: '1' });
  const carts = new CommerceCartService(db),checkout = new CommerceCheckoutService(db,carts),cart = await carts.create(front.slug,{},randomUUID());
  await carts.mutate(front.slug,cart.cartToken,{ productId: product.id,quantity },'ADD');
  const session = await checkout.create(front.slug,{ cartToken: cart.cartToken,customerInfo: { name: 'Buyer',email: 'buyer@example.test' },shippingInfo: { country: 'EG',region: 'EG',city: 'Cairo',line1: 'Street' },payerType: 'PERSON' });
  const quote = await checkout.quote(front.slug,session.id,session.checkoutSessionToken,{ paymentMethodId: method });
  await checkout.place(front.slug,session.id,session.checkoutSessionToken,{ quoteHash: quote.quoteHash,consents },randomUUID());
  const order = await db.commerceOrder.findUniqueOrThrow({ where: { cartId: cart.id } });
  const delivery = await shipments.deliveryServices(actor,store.id,{ type: 'PICKUP',rates: [{ price: '0',currency: 'EGP',estimatedDaysMin: 0,estimatedDaysMax: 0 }] }) as { id: string };
  return { actor,user,workspace,role,store,order,product,warehouses,delivery,lineId: quote.lines[0].itemId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function create(f: Fixture,warehouse: number,quantity: string,key = randomUUID()) {
  return shipments.create(f.actor,f.order.id,{ warehouseId: f.warehouses[warehouse].id,deliveryServiceId: f.delivery.id,items: [{ orderLineId: f.lineId,quantity }] },key);
}
async function paid(f: Fixture,amount = f.order.total.toFixed(6)) {
  const id = randomUUID();
  // Existing shared payment truth is a fixture; the Shipment does not manufacture settlement.
  await db.commercialPackRecord.create({ data: { id,workspaceId: f.workspace.id,collection: 'payments',data: { id,workspaceId: f.workspace.id,amount,currencyCode: 'EGP',settlementStatus: 'SUCCEEDED',methodType: 'MANUAL',responsibleUserId: f.user.id } } });
  await db.commerceOrderPaymentBinding.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,orderId: f.order.id,paymentId: id,amount } }); return id;
}
async function ship(f: Fixture,row: { id: string;version: bigint|string },key = randomUUID()) { return shipments.transition(f.actor,row.id,{ expectedVersion: row.version.toString() },key,'SHIP'); }
async function deliver(f: Fixture,id: string) { return shipments.transition(f.actor,id,{ trackingEvidence: { reference: 'Proof of delivery',deliveredAt: new Date().toISOString() } },randomUUID(),'DELIVER'); }

describe('New Commerce delivery and Shipment implementation', () => {
  it('uses durable line bindings so equal-SKU lines cannot borrow each other\'s warehouse reservation',async()=>{
    const f=await fixture('1'),hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
    const cart=await db.commerceCart.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,tokenHash:hash(),currency:'EGP',expiresAt:new Date(Date.now()+3600000)}}),session=await db.commerceCheckoutSession.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,cartId:cart.id,tokenHash:hash(),customerSnapshot:{},addressSnapshot:{},payerType:'PERSON',expiresAt:new Date(Date.now()+3600000)}});
    const original=f.order.snapshot as {lines:Record<string,unknown>[]},lineIds=[randomUUID(),randomUUID()],lines=lineIds.map(itemId=>({...original.lines[0],itemId,quantity:'3',subtotal:'30',total:'30'}));
    const order=await db.commerceOrder.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,cartId:cart.id,checkoutSessionId:session.id,currency:'EGP',total:'60',snapshot:{...original,lines,subtotal:'60',total:'60'},consents:[]}}),reservations=[];
    for(let i=0;i<2;i++){
      const reservation=await shipments.reservations.create(f.actor,{sourceType:'ORDER',sourceId:order.id,productId:f.product.id,warehouseId:f.warehouses[i].id,quantity:'3'},randomUUID());reservations.push(reservation);
      await db.commerceOrderLineReservation.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:order.id,orderLineId:lineIds[i],reservationId:reservation.id,inventoryKey:f.product.id,quantity:'3'}});
    }
    const request=(line:number,warehouse:number)=>shipments.create(f.actor,order.id,{warehouseId:f.warehouses[warehouse].id,deliveryServiceId:f.delivery.id,items:[{orderLineId:lineIds[line],quantity:'3'}]},randomUUID());
    await expect(request(1,0)).rejects.toMatchObject({code:'SHIPMENT_QUANTITY_EXCEEDED'});expect(await db.commerceShipment.count({where:{orderId:order.id}})).toBe(0);
    for(let i=0;i<2;i++){const shipment=await request(i,i);expect(await db.commerceShipmentStockBinding.findFirst({where:{shipmentId:shipment.id}})).toMatchObject({reservationId:reservations[i].id});}
    expect(await db.commerceShipment.count({where:{orderId:order.id}})).toBe(2);
    const legacyCart=await db.commerceCart.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,tokenHash:hash(),currency:'EGP',expiresAt:new Date(Date.now()+3600000)}}),legacySession=await db.commerceCheckoutSession.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,cartId:legacyCart.id,tokenHash:hash(),customerSnapshot:{},addressSnapshot:{},payerType:'PERSON',expiresAt:new Date(Date.now()+3600000)}});
    const unbound=await db.commerceOrder.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,cartId:legacyCart.id,checkoutSessionId:legacySession.id,currency:'EGP',total:'60',snapshot:{...original,lines,subtotal:'60',total:'60'},consents:[]}});
    await expect(shipments.create(f.actor,unbound.id,{warehouseId:f.warehouses[0].id,deliveryServiceId:f.delivery.id,items:[{orderLineId:lineIds[0],quantity:'1'}]},randomUUID())).rejects.toMatchObject({code:'SHIPMENT_RESERVATION_BINDING_REQUIRED'});
  });
  it('ships 6+4 across two warehouses once, and completes only after both deliveries and payment', async () => {
    const f = await fixture(); await paid(f);
    const a = await create(f,0,'6'),b = await create(f,1,'4'),key = randomUUID();
    const [one,two] = await Promise.all([ship(f,a,key),ship(f,a,key)]); expect(one.id).toBe(two.id); expect(one.status).toBe('SHIPPED');
    await ship(f,b);
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id,type: 'SALES_ORDER_OUT' } })).toBe(2);
    const balances = await db.inventoryBalance.findMany({ where: { workspaceId: f.workspace.id } }); expect(balances.every(b => b.onHand.eq(0) && b.reserved.eq(0))).toBe(true);
    await deliver(f,a.id); expect((await db.commerceOrder.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('PROCESSING');
    await deliver(f,b.id); expect((await db.commerceOrder.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('COMPLETED');
    expect(await db.outboxEvent.count({ where: { entityId: a.id,eventType: 'SHIPMENT_SHIPPED' } })).toBe(1);
    const document = await db.inventoryDocument.findUniqueOrThrow({ where: { id: one.inventoryDocumentId! } });
    await expect(shipments.documents.reverse(f.actor,document.id,{ expectedVersion: document.version.toString(),reason: 'Bypass return' },randomUUID())).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_REVERSAL_BLOCKED' });
  });

  it('rejects over-allocation races without inserting losing items or events', async () => {
    const f = await fixture('6');
    await expect(create(f,0,'0.5')).rejects.toMatchObject({ code: 'SHIPMENT_QUANTITY_EXCEEDED' });
    const results = await Promise.allSettled([1,2].map(() => create(f,0,'4')));
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1); expect(results.find(r => r.status==='rejected')).toMatchObject({ reason: { code: 'SHIPMENT_QUANTITY_EXCEEDED' } });
    expect(await db.commerceShipment.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id,eventType: 'SHIPMENT_CREATED' } })).toBe(1);
  });

  it('blocks unpaid offline shipping and permits COD dispatch without pretending payment succeeded', async () => {
    const unpaid = await fixture('1','OFFLINE'),blocked = await create(unpaid,0,'1');
    await expect(ship(unpaid,blocked)).rejects.toMatchObject({ code: 'SHIPMENT_PAYMENT_BLOCKED' });
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: blocked.id } })).status).toBe('NEW');
    const cod = await fixture('1'),allowed = await create(cod,0,'1'); expect((await ship(cod,allowed)).status).toBe('SHIPPED');
    await deliver(cod,allowed.id); expect((await db.commerceOrder.findUniqueOrThrow({ where: { id: cod.order.id } })).status).toBe('PROCESSING');
  });

  it('rolls back Inventory failure, and pre-dispatch cancellation releases only the selected leg', async () => {
    const f = await fixture(),a = await create(f,0,'6'),b = await create(f,1,'4');
    const before = await db.inventoryBalance.findFirstOrThrow({ where: { workspaceId: f.workspace.id,warehouseId: f.warehouses[0].id } });
    // Inject a physical projection outage; posting must fail rather than mark shipped.
    await db.inventoryBalance.update({ where: { id: before.id },data: { onHand: '0' } });
    await expect(ship(f,a)).rejects.toMatchObject({ code: 'SHIPMENT_INVENTORY_POST_FAILED' });
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('NEW');
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id,type: 'SALES_ORDER_OUT' } })).toBe(0);
    await db.inventoryBalance.update({ where: { id: before.id },data: { onHand: '6' } });
    await shipments.transition(f.actor,b.id,{ reason: 'Cancel second leg' },randomUUID(),'CANCEL');
    const balances = await db.inventoryBalance.findMany({ where: { workspaceId: f.workspace.id } });
    expect(balances.find(b => b.warehouseId===f.warehouses[0].id)!.reserved.toString()).toBe('6');
    expect(balances.find(b => b.warehouseId===f.warehouses[1].id)!.reserved.toString()).toBe('0');
    const dispatched = await ship(f,a); await expect(shipments.transition(f.actor,dispatched.id,{ reason: 'Too late' },randomUUID(),'CANCEL')).rejects.toMatchObject({ code: 'SHIPMENT_INVALID_STATE' });
  });

  it('retains approval checkpoints and posts only after current Inventory approval', async () => {
    const f = await fixture('1');
    await db.inventorySettings.update({ where: { workspaceId: f.workspace.id },data: { approvalPolicies: { SALES_ORDER: { requiresApproval: true,allowSelfApproval: true,requiredApprovals: 1,actions: {} } } } });
    const row = await create(f,0,'1'),waiting = await ship(f,row);
    expect(waiting.status).toBe('PROCESSING'); expect(waiting.inventoryDocumentId).not.toBeNull();
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id,type: 'SALES_ORDER_OUT' } })).toBe(0);
    const document = await db.inventoryDocument.findUniqueOrThrow({ where: { id: waiting.inventoryDocumentId! } });
    await shipments.documents.approval(f.actor,document.id,{ expectedVersion: document.version.toString(),decision: 'APPROVE' });
    expect((await ship(f,waiting)).status).toBe('SHIPPED');
  });

  it('rejects edited linked Inventory plans before deducting stock', async () => {
    const f = await fixture('2');
    await db.inventorySettings.update({ where: { workspaceId: f.workspace.id },data: { approvalPolicies: { SALES_ORDER: { requiresApproval: true,allowSelfApproval: true,requiredApprovals: 1,actions: {} } } } });
    const row = await create(f,0,'2'),waiting = await ship(f,row);
    const doc = await db.inventoryDocument.findUniqueOrThrow({ where: { id: waiting.inventoryDocumentId! } });
    await shipments.documents.approval(f.actor,doc.id,{ expectedVersion: doc.version.toString(),decision: 'REJECT' });
    const line = await db.inventoryDocumentLine.findFirstOrThrow({ where: { documentId: doc.id } });
    await shipments.documents.line(f.actor,doc.id,{ expectedVersion: line.version.toString(),quantity: '1' },line.id);
    await expect(ship(f,waiting)).rejects.toMatchObject({ code: 'SHIPMENT_INVENTORY_POST_FAILED' });
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id,type: 'SALES_ORDER_OUT' } })).toBe(0);
  });

  it('checks current permissions, tenant boundaries, versions, and DB shipment quantity constraints', async () => {
    const f = await fixture('1'),other = await fixture('1'),row = await create(f,0,'1');
    await expect(shipments.get(other.actor,row.id)).rejects.toMatchObject({ code: 'SHIPMENT_NOT_FOUND' });
    await expect(shipments.update(f.actor,row.id,{ expectedVersion: '2',trackingInfo: { trackingNumber: 'Stale' } })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: 'COMMERCE.SHIPMENT_SHIP' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: permission.id } },data: { isDeleted: true } });
    await expect(ship(f,row)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(db.commerceShipmentItem.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,orderId: f.order.id,shipmentId: row.id,orderLineId: randomUUID(),quantity: '1' } })).rejects.toMatchObject({ code: 'P2003' });
    const extra = await db.commerceShipment.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,orderId: f.order.id,warehouseId: f.warehouses[0].id,deliveryServiceId: f.delivery.id } });
    await expect(db.commerceShipmentItem.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,orderId: f.order.id,shipmentId: extra.id,orderLineId: f.lineId,quantity: '2' } })).rejects.toThrow('SHIPMENT_QUANTITY_EXCEEDED');
    expect(await db.commerceShipmentItem.count({ where: { shipmentId: extra.id } })).toBe(0);
  });

  it('requires full settled payment coverage and blocks refunded or oversubscribed shared funds', async () => {
    const f = await fixture('1','OFFLINE'),row = await create(f,0,'1'),first = await paid(f,'5');
    await expect(ship(f,row)).rejects.toMatchObject({ code: 'SHIPMENT_PAYMENT_BLOCKED' });
    await paid(f,'5');
    const refundId = randomUUID();
    await db.commercialPackRecord.create({ data: { id: refundId,workspaceId: f.workspace.id,collection: 'refunds',data: { id: refundId,paymentId: first,amount: '1',status: 'SUCCEEDED' } } });
    await expect(ship(f,row)).rejects.toMatchObject({ code: 'SHIPMENT_PAYMENT_BLOCKED' });
    await db.commercialPackRecord.update({ where: { id: refundId },data: { data: { id: refundId,paymentId: first,amount: '1',status: 'FAILED' } } });
    expect((await ship(f,row)).status).toBe('SHIPPED');
  });

  it('keeps dispatched stock protected after a provider marks logistics FAILED', async () => {
    const f = await fixture('1'),row = await create(f,0,'1'),dispatched = await ship(f,row);
    await db.$transaction(tx => shipments.applyDeliveryEvent(tx,f.actor,row.id,{ status: 'FAILED',occurredAt: new Date().toISOString(),providerStatus: 'Carrier exception',externalEventId: randomUUID() }),{ timeout: 60000 });
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED');
    const document = await db.inventoryDocument.findUniqueOrThrow({ where: { id: dispatched.inventoryDocumentId! } });
    await expect(shipments.documents.reverse(f.actor,document.id,{ expectedVersion: document.version.toString(),reason: 'Bypass Return' },randomUUID())).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_REVERSAL_BLOCKED' });
    await expect(db.commerceShipment.update({ where: { id: row.id },data: { status: 'NEW' } })).rejects.toThrow('SHIPMENT_INVALID_STATE');
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id,type: 'SALES_ORDER_OUT' } })).toBe(1);
  });

  it('exercises all new shipment HTTP handlers through tenant authentication', async () => {
    const f = await fixture('1'),{ commerceRouter } = await import('../src/server/commerce/routes'),token = await signAccessToken(f.user.id);
    const request = async (method: string,path: string,body?: unknown,key?: string) => commerceRouter.dispatch(new NextRequest('http://localhost/api/v1/commerce'+path,{ method,headers: { authorization: 'Bearer '+token,'x-workspace-id': f.workspace.id,'content-type': 'application/json',...(key ? { 'idempotency-key': key } : {}) },body: body===undefined ? undefined : JSON.stringify(body) }));
    expect((await request('GET','/stores/'+f.store.id+'/delivery-services')).status).toBe(200);
    const created = await request('POST','/orders/'+f.order.id+'/shipments',{ warehouseId: f.warehouses[0].id,deliveryServiceId: f.delivery.id,items: [{ orderLineId: f.lineId,quantity: '1' }] },randomUUID()); expect(created.status).toBe(201);
    const row = (await created.json()).data;
    expect((await request('GET','/orders/'+f.order.id+'/shipments')).status).toBe(200);
    expect((await request('GET','/shipments/'+row.id)).status).toBe(200);
    const updated = await request('PATCH','/shipments/'+row.id,{ expectedVersion: row.version,trackingInfo: { trackingNumber: 'TRACK-1' } }); expect(updated.status).toBe(200); const revision = (await updated.json()).data.version;
    expect((await request('POST','/shipments/'+row.id+'/ship',{ expectedVersion: revision },randomUUID())).status).toBe(200);
    expect((await request('POST','/shipments/'+row.id+'/deliver',{ trackingEvidence: { reference: 'Proof',deliveredAt: new Date().toISOString() } },randomUUID())).status).toBe(200);
    expect((await request('POST','/shipments/'+row.id+'/cancel',{ reason: 'Delivered' },randomUUID())).status).toBe(409);
  });
});
