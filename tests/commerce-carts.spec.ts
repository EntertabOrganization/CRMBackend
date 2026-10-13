import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CommerceCartService, hashCartToken } from '../src/server/commerce/cart-service';
import { resetRateLimits } from '../src/server/rate-limit';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { CommerceCheckoutService } from '../src/server/commerce/checkout-service';
import { CommerceStoreService } from '../src/server/commerce/store-service';
import { CommerceOrderService } from '../src/server/commerce/order-service';
import { couponHash } from '../src/server/commerce/pricing-policy-service';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { NextRequest } from 'next/server';
import { CommerceCartWorker } from '../src/server/commerce/cart-worker';

jest.setTimeout(120000);
let db: PrismaClient;
let carts: CommerceCartService;
let checkout: CommerceCheckoutService;
let fixture: Awaited<ReturnType<typeof storeFixture>>;

async function storeFixture() {
  const user = await db.user.create({ data: { firstName: 'Cart',lastName: 'Test',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Cart workspace',slug: randomUUID(),ownerUserId: user.id } });
  const role = await db.role.create({ data: { workspaceId: workspace.id,name: 'Commerce operator' } });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id,userId: user.id,roleId: role.id } });
  const permissions = await db.permission.findMany();
  await db.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: role.id,permissionId: permission.id,scope: 'WORKSPACE' as const })) });
  const catalog = await db.catalog.create({ data: { workspaceId: workspace.id,code: 'CATALOG',name: 'Catalog',normalizedName: 'catalog' } });
  const priceType = await db.catalogPriceType.create({ data: { workspaceId: workspace.id,code: 'RETAIL',name: 'Retail' } });
  const product = await db.catalogProduct.create({ data: { workspaceId: workspace.id,catalogId: catalog.id,type: 'SERVICE',name: 'Service' } });
  const price = await db.catalogProductPrice.create({ data: { workspaceId: workspace.id,productId: product.id,priceTypeId: priceType.id,amount: '12.34',currency: 'EGP' } });
  const store = await db.commerceStore.create({ data: { workspaceId: workspace.id,code: 'STORE',name: 'Store',catalogId: catalog.id,priceTypeId: priceType.id,
    defaultCurrency: 'EGP',timezone: 'Africa/Cairo',createdByUserId: user.id,status: 'ACTIVE',settings: { paymentMethods: ['OFFLINE'],deliveryPolicy: 'PICKUP' } } });
  const front = await db.commerceStorefront.create({ data: { workspaceId: workspace.id,storeId: store.id,type: 'WEB',slug: 'cart-'+randomUUID(),status: 'PUBLISHED',publishedAt: new Date() } });
  await db.commerceProductPublication.create({ data: { workspaceId: workspace.id,storeId: store.id,productId: product.id,inventoryKey: product.id,seoSlug: 'service',published: true,createdByUserId: user.id } });
  return { user,workspace,role,product,price,store,front };
}

beforeAll(async () => {
  // Separate disposable database: this does not run the endpoint audit or any existing application tests.
  const databaseUrl = await prepareProcessPlatformDatabase('truecrm_implementation_test');
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } }); carts = new CommerceCartService(db); checkout = new CommerceCheckoutService(db,carts); fixture = await storeFixture();
},300000);
afterAll(async () => { await db?.$disconnect(); const { prisma } = await import('../src/server/prisma-client'); await prisma.$disconnect(); });
beforeEach(() => resetRateLimits());

describe('New public Commerce carts', () => {
  it('stores only a token hash and returns no token on reads', async () => {
    const created = await carts.create(fixture.front.slug,{},'hash');
    const persisted = await db.commerceCart.findUniqueOrThrow({ where: { id: created.id } });
    expect(persisted.tokenHash).toBe(hashCartToken(created.cartToken));
    expect(JSON.stringify(persisted,(_,v) => typeof v==='bigint' ? String(v) : v)).not.toContain(created.cartToken);
    expect(await carts.get(fixture.front.slug,created.cartToken)).not.toHaveProperty('cartToken');
    expect(await db.outboxEvent.count({ where: { entityId: created.id,eventType: 'CART_CREATED' } })).toBe(1);
  });

  it('rejects token reuse across stores and expired tokens', async () => {
    const other = await storeFixture(),created = await carts.create(fixture.front.slug,{},'isolation');
    await expect(carts.get(other.front.slug,created.cartToken)).rejects.toMatchObject({ code: 'COMMERCE_CART_NOT_FOUND' });
    await db.commerceCart.update({ where: { id: created.id },data: { expiresAt: new Date(Date.now()-1),createdAt: new Date(Date.now()-10000) } });
    await expect(carts.get(fixture.front.slug,created.cartToken)).rejects.toMatchObject({ code: 'COMMERCE_CART_EXPIRED' });
  });

  it('rejects price tampering and recalculates using current Catalog prices', async () => {
    const created = await carts.create(fixture.front.slug,{},'prices');
    await expect(carts.mutate(fixture.front.slug,created.cartToken,{ productId: fixture.product.id,quantity: '2',unitPrice: '0.01' },'ADD')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const added = await carts.mutate(fixture.front.slug,created.cartToken,{ productId: fixture.product.id,quantity: '2' },'ADD');
    expect(added.subtotal).toBe('24.68');
    await db.catalogProductPrice.update({ where: { id: fixture.price.id },data: { amount: '15',version: { increment: 1 } } });
    expect((await carts.get(fixture.front.slug,created.cartToken)).subtotal).toBe('30');
    await db.catalogProductPrice.update({ where: { id: fixture.price.id },data: { amount: '12.34',version: { increment: 1 } } });
  });

  it('merges concurrent additions without losing quantity and rejects stale updates', async () => {
    const created = await carts.create(fixture.front.slug,{},'races');
    await Promise.all([1,2].map(() => carts.mutate(fixture.front.slug,created.cartToken,{ productId: fixture.product.id,quantity: '1' },'ADD')));
    const view = await carts.get(fixture.front.slug,created.cartToken);
    expect(view.items).toHaveLength(1); expect(view.items[0].quantity).toBe('2.000000');
    const results = await Promise.allSettled(['3','4'].map(quantity => carts.mutate(fixture.front.slug,created.cartToken,{ quantity,expectedVersion: view.items[0].version },'UPDATE',view.items[0].id)));
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status==='rejected')).toMatchObject({ reason: { code: 'RESOURCE_VERSION_CONFLICT' } });
  });

  it('cannot change or delete an item in another cart', async () => {
    const first = await carts.create(fixture.front.slug,{},'item-a'),second = await carts.create(fixture.front.slug,{},'item-b');
    const added = await carts.mutate(fixture.front.slug,first.cartToken,{ productId: fixture.product.id,quantity: '1' },'ADD');
    await expect(carts.mutate(fixture.front.slug,second.cartToken,{},'DELETE',added.items[0].id)).rejects.toMatchObject({ code: 'COMMERCE_CART_NOT_FOUND' });
    expect((await carts.get(fixture.front.slug,first.cartToken)).items).toHaveLength(1);
    expect((await carts.mutate(fixture.front.slug,first.cartToken,{},'DELETE',added.items[0].id)).items).toHaveLength(0);
  });

  it('rolls back additions when a product has been unpublished', async () => {
    const created = await carts.create(fixture.front.slug,{},'unpublished');
    await db.commerceProductPublication.updateMany({ where: { storeId: fixture.store.id },data: { published: false } });
    await expect(carts.mutate(fixture.front.slug,created.cartToken,{ productId: fixture.product.id,quantity: '1' },'ADD')).rejects.toMatchObject({ code: 'COMMERCE_ITEM_NOT_AVAILABLE' });
    expect(await db.commerceCartItem.count({ where: { cartId: created.id } })).toBe(0);
    expect((await db.commerceCart.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(1n);
    await db.commerceProductPublication.updateMany({ where: { storeId: fixture.store.id },data: { published: true } });
  });

  it('rate limits public cart creation', async () => {
    for (let i=0;i<20;i++) await carts.create(fixture.front.slug,{},'limited');
    await expect(carts.create(fixture.front.slug,{},'limited')).rejects.toMatchObject({ status: 429 });
  });

  it('abandons inactive carts once across workers and permits a holder to resume', async () => {
    const cart = await carts.create(fixture.front.slug,{},'abandoned');
    await db.commerceCart.update({ where: { id: cart.id },data: { lastActivityAt: new Date(Date.now()-3*3600000) } });
    const worker = new CommerceCartWorker(db);
    await Promise.all([worker.tick(),worker.tick()]);
    expect(await db.outboxEvent.count({ where: { entityId: cart.id,eventType: 'CART_ABANDONED' } })).toBe(1);
    expect((await carts.get(fixture.front.slug,cart.cartToken)).status).toBe('ABANDONED');
    expect((await carts.mutate(fixture.front.slug,cart.cartToken,{ productId: fixture.product.id,quantity: '1' },'ADD')).status).toBe('ACTIVE');
  });
});

const consents = [{ kind: 'TERMS',version: '1',accepted: true },{ kind: 'PRIVACY',version: '1',accepted: true }];
async function checkoutFixture(f = fixture) {
  const cart = await carts.create(f.front.slug,{},randomUUID());
  await carts.mutate(f.front.slug,cart.cartToken,{ productId: f.product.id,quantity: '1' },'ADD');
  const session = await checkout.create(f.front.slug,{ cartToken: cart.cartToken,customerInfo: { name: 'Buyer',email: 'buyer@example.test' },
    shippingInfo: { country: 'EG',region: 'EG',city: 'Cairo',line1: 'Test street' },payerType: 'PERSON' });
  const quote = await checkout.quote(f.front.slug,session.id,session.checkoutSessionToken,{ paymentMethodId: 'OFFLINE' });
  return { cart,session,quote };
}

describe('New Commerce checkout, pricing and Orders', () => {
  it('converts once under concurrent requests and replays only the same payload', async () => {
    const { cart,session,quote } = await checkoutFixture(),key = randomUUID(),input = { quoteHash: quote.quoteHash,consents };
    const responses = await Promise.all([1,2].map(() => checkout.place(fixture.front.slug,session.id,session.checkoutSessionToken,input,key)));
    expect(responses[0]).toEqual(responses[1]);
    expect(await db.commerceOrder.count({ where: { cartId: cart.id } })).toBe(1);
    const order = await db.commerceOrder.findUniqueOrThrow({ where: { cartId: cart.id } });
    expect(await db.commerceCrmSync.count({where:{workspaceId:order.workspaceId,orderId:order.id}})).toBe(1);
    expect(await db.commerceCrmSync.findUnique({where:{workspaceId_orderId:{workspaceId:order.workspaceId,orderId:order.id}}})).toMatchObject({mode:'AUTO',requestedByUserId:null,attempts:0});
    expect(order.total.toString()).toBe('12.34'); expect(order.consents).toHaveLength(2);
    expect(JSON.stringify(order.consents)).not.toContain('MARKETING');
    expect(await db.outboxEvent.count({ where: { entityId: order.id,eventType: 'ORDER_CREATED' } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: order.id,action: 'ORDER_CREATED' } })).toBe(1);
    await expect(checkout.place(fixture.front.slug,session.id,session.checkoutSessionToken,{ ...input,consents: [...consents,{ kind: 'MARKETING',version: '1',accepted: false }] },key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(checkout.place(fixture.front.slug,session.id,session.checkoutSessionToken,input,randomUUID())).rejects.toMatchObject({ code: 'COMMERCE_CHECKOUT_DUPLICATE' });
  });

  it('rejects stale prices and leaves the order, command and events uncommitted', async () => {
    const { cart,session,quote } = await checkoutFixture();
    await db.catalogProductPrice.update({ where: { id: fixture.price.id },data: { amount: '20',version: { increment: 1 } } });
    await expect(checkout.place(fixture.front.slug,session.id,session.checkoutSessionToken,{ quoteHash: quote.quoteHash,consents },randomUUID())).rejects.toMatchObject({ code: 'COMMERCE_CHECKOUT_REQUOTE_REQUIRED' });
    expect(await db.commerceOrder.count({ where: { cartId: cart.id } })).toBe(0);
    expect(await db.commerceCheckoutCommand.count({ where: { sessionId: session.id } })).toBe(0);
    await db.catalogProductPrice.update({ where: { id: fixture.price.id },data: { amount: '12.34',version: { increment: 1 } } });
  });

  it('requires mandatory consents and binds checkout tokens to their exact session and Store', async () => {
    const one = await checkoutFixture(),two = await checkoutFixture(),other = await storeFixture();
    await expect(checkout.status(fixture.front.slug,one.session.id,two.session.checkoutSessionToken)).rejects.toMatchObject({ status: 404 });
    await expect(checkout.status(other.front.slug,one.session.id,one.session.checkoutSessionToken)).rejects.toMatchObject({ status: 404 });
    await expect(checkout.place(fixture.front.slug,one.session.id,one.session.checkoutSessionToken,{ quoteHash: one.quote.quoteHash,consents: [] },randomUUID())).rejects.toMatchObject({ code: 'COMMERCE_CHECKOUT_INVALID' });
  });

  it('calculates inclusive and exclusive tax and preserves historical snapshots', async () => {
    const f = await storeFixture();
    await db.catalogProductPrice.update({ where: { id: f.price.id },data: { amount: '100' } });
    const tax = await db.commerceTaxRule.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,region: 'EG',rate: '10',priceBasis: 'EXCLUSIVE',effectiveFrom: new Date(Date.now()-1000) } });
    const a = await checkoutFixture(f); expect(a.quote.tax).toBe('10'); expect(a.quote.total).toBe('110');
    await checkout.place(f.front.slug,a.session.id,a.session.checkoutSessionToken,{ quoteHash: a.quote.quoteHash,consents },randomUUID());
    const nextPeriod = new Date(Date.now()+1000);
    await db.commerceTaxRule.update({ where: { id: tax.id },data: { effectiveTo: nextPeriod,version: { increment: 1 } } });
    await db.commerceTaxRule.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,region: 'EG',rate: '10',priceBasis: 'INCLUSIVE',effectiveFrom: nextPeriod } });
    await new Promise(resolve => setTimeout(resolve,1100));
    const b = await checkoutFixture(f); expect(b.quote.tax).toBe('9.09'); expect(b.quote.total).toBe('100');
    const old = await db.commerceOrder.findUniqueOrThrow({ where: { cartId: a.cart.id } }); expect(old.total.toString()).toBe('110');
    await expect(db.commerceOrder.update({ where: { id: old.id },data: { total: '0' } })).rejects.toThrow('COMMERCE_ORDER_IMMUTABLE');
  });

  it('redeems the last-use coupon once and does not overspend across checkouts', async () => {
    const f = await storeFixture();
    const rule = await db.commerceDiscountRule.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,code: 'LAST',name: 'Last use',kind: 'PERCENT',value: '50',eligibility: { customerKind: 'ANY' } } });
    const coupon = await db.commerceCoupon.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,ruleId: rule.id,codeHash: couponHash(f.store.id,'LAST'),usageLimit: 1 } });
    const a = await checkoutFixture(f),b = await checkoutFixture(f);
    const quote = await Promise.all([a,b].map(c => checkout.quote(f.front.slug,c.session.id,c.session.checkoutSessionToken,{ paymentMethodId: 'OFFLINE',couponCodes: ['LAST'] })));
    expect(quote[0].total).toBe('6.17');
    const results = await Promise.allSettled([a,b].map((c,index) => checkout.place(f.front.slug,c.session.id,c.session.checkoutSessionToken,{ quoteHash: quote[index].quoteHash,consents },randomUUID())));
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status==='rejected')).toMatchObject({ reason: { code: 'COMMERCE_COUPON_EXHAUSTED' } });
    expect(await db.commerceDiscountRedemption.count({ where: { couponId: coupon.id } })).toBe(1);
  });

  it('reserves the last stock unit once and rolls back the losing Order', async () => {
    const f = await storeFixture();
    const unit = await db.catalogUnit.create({ data: { workspaceId: f.workspace.id,code: 'EA',name: 'Each',precision: 0 } });
    await db.catalogProduct.update({ where: { id: f.product.id },data: { type: 'SIMPLE_PRODUCT',primaryUnitId: unit.id,sku: 'STOCK-1',skuKey: 'stock-1' } });
    const warehouse = await db.inventoryWarehouse.create({ data: { workspaceId: f.workspace.id,code: 'TEST',name: 'Test',type: 'PHYSICAL',timezone: 'Africa/Cairo',createdByUserId: f.user.id } });
    await db.inventoryWarehousePermission.createMany({ data: ['INVENTORY.RESERVATION_CREATE','INVENTORY.RESERVATION_MANAGE'].map(action => ({ workspaceId: f.workspace.id,warehouseId: warehouse.id,roleId: f.role.id,action,scope: 'ALL' })) });
    await db.inventorySettings.create({ data: { workspaceId: f.workspace.id,defaultWarehouseId: warehouse.id } });
    await db.inventoryBalance.create({ data: { workspaceId: f.workspace.id,warehouseId: warehouse.id,productId: f.product.id,inventoryKey: f.product.id,locationKey: '',onHand: '1' } });
    await db.commerceStore.update({ where: { id: f.store.id },data: { defaultWarehouseId: warehouse.id,settings: { paymentMethods: ['OFFLINE'],deliveryPolicy: 'PICKUP',inventoryPrincipalUserId: f.user.id } } });
    const a = await checkoutFixture(f),b = await checkoutFixture(f);
    const results = await Promise.allSettled([a,b].map(c => checkout.place(f.front.slug,c.session.id,c.session.checkoutSessionToken,{ quoteHash: c.quote.quoteHash,consents },randomUUID())));
    expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status==='rejected')).toMatchObject({ reason: { code: 'COMMERCE_STOCK_RESERVATION_FAILED' } });
    expect(await db.commerceOrder.count({ where: { storeId: f.store.id } })).toBe(1);
    expect(await db.inventoryReservation.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect((await db.inventoryBalance.findFirstOrThrow({ where: { workspaceId: f.workspace.id } })).reserved.toString()).toBe('1');
    const order = await db.commerceOrder.findFirstOrThrow({ where: { storeId: f.store.id } });
    const reservation=await db.inventoryReservation.findFirstOrThrow({where:{workspaceId:f.workspace.id}}),binding=await db.commerceOrderLineReservation.findFirstOrThrow({where:{workspaceId:f.workspace.id,orderId:order.id}});
    expect(binding).toMatchObject({storeId:f.store.id,inventoryKey:f.product.id,reservationId:reservation.id,orderLineId:(order.snapshot as {lines:{itemId:string}[]}).lines[0].itemId});
    expect(binding.quantity.toString()).toBe('1');expect(await db.commerceOrderLineReservation.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    await expect(db.commerceOrderLineReservation.update({where:{id:binding.id},data:{orderLineId:randomUUID()}})).rejects.toThrow('COMMERCE_LINE_RESERVATION_IMMUTABLE');
    await expect(db.inventoryReservation.update({where:{id:reservation.id},data:{quantity:'2'}})).rejects.toThrow('COMMERCE_LINE_RESERVATION_IMMUTABLE');
    await expect(db.commerceOrderLineReservation.create({data:{workspaceId:f.workspace.id,storeId:f.store.id,orderId:order.id,orderLineId:randomUUID(),reservationId:reservation.id,inventoryKey:f.product.id,quantity:'1'}})).rejects.toMatchObject({code:'P2003'});
    const actor = await resolvePrincipal(db,f.workspace.id,f.user.id);
    await new CommerceOrderService(db).update(actor,order.id,{ expectedVersion: '1',reason: 'Buyer cancelled' },'CANCEL');
    expect((await db.inventoryBalance.findFirstOrThrow({ where: { workspaceId: f.workspace.id } })).reserved.toString()).toBe('0');
    expect((await db.inventoryReservation.findFirstOrThrow({ where: { workspaceId: f.workspace.id } })).status).toBe('RELEASED');
    expect(await db.commerceOrderLineReservation.findUnique({where:{id:binding.id}})).toEqual(binding);
  });

  it('guards activation and publication, and scopes Order mutation permissions', async () => {
    const f = await storeFixture(),stores = new CommerceStoreService(db),orders = new CommerceOrderService(db),actor = await resolvePrincipal(db,f.workspace.id,f.user.id);
    await db.commerceStore.update({ where: { id: f.store.id },data: { status: 'DRAFT',settings: {} } });
    await expect(stores.activate(actor,f.store.id,{ expectedVersion: '1' })).rejects.toMatchObject({ code: 'COMMERCE_STORE_NOT_READY' });
    await db.commerceStore.update({ where: { id: f.store.id },data: { settings: { paymentMethods: ['OFFLINE'],deliveryPolicy: 'PICKUP' } } });
    const active = await stores.activate(actor,f.store.id,{ expectedVersion: '1' }); expect(active.status).toBe('ACTIVE');
    await db.commerceStorefront.update({ where: { id: f.front.id },data: { status: 'DRAFT' } });
    expect((await stores.publishStorefront(actor,f.front.id,{ expectedVersion: '1' })).status).toBe('PUBLISHED');
    const c = await checkoutFixture(f); await checkout.place(f.front.slug,c.session.id,c.session.checkoutSessionToken,{ quoteHash: c.quote.quoteHash,consents },randomUUID());
    const order = await db.commerceOrder.findUniqueOrThrow({ where: { cartId: c.cart.id } });
    const activeStore = await db.commerceStore.findUniqueOrThrow({ where: { id: f.store.id } });
    await stores.update(actor,f.store.id,{ expectedVersion: activeStore.version.toString() },true);
    await expect(carts.create(f.front.slug,{},'suspended')).rejects.toMatchObject({ code: 'COMMERCE_STORE_NOT_FOUND' });
    expect((await orders.get(actor,order.id) as { id: string }).id).toBe(order.id);
    await expect(orders.get({ ...actor,grants: new Map() },order.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // Revocation is tested against current DB grants, not a stale in-memory principal.
    const permission = await db.permission.findUniqueOrThrow({ where: { key: 'COMMERCE.ORDER_UPDATE' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: permission.id } },data: { isDeleted: true } });
    await expect(orders.update(actor,order.id,{ expectedVersion: '1',businessMetadata: { note: 'Bad' } },'UPDATE')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const cancelled = await orders.update(actor,order.id,{ expectedVersion: '1',reason: 'Buyer requested cancellation' },'CANCEL');
    expect(cancelled.status).toBe('CANCELLED');
    const archived = await orders.update(actor,order.id,{ expectedVersion: cancelled.version.toString() },'ARCHIVE'); expect(archived.archivedAt).not.toBeNull();
  });

  it('routes public cart and checkout HTTP requests with safe response envelopes', async () => {
    const { commerceRouter } = await import('../src/server/commerce/routes');
    const request = (path: string,method: string,body?: unknown,headers: Record<string,string> = {}) => commerceRouter.dispatch(new NextRequest('http://localhost'+path,{ method,headers: { 'content-type': 'application/json',...headers },body: body===undefined ? undefined : JSON.stringify(body) }));
    const root = '/api/v1/storefront/'+fixture.front.slug;
    const created = await request(root+'/carts','POST',{}); expect(created.status).toBe(201); const cart = (await created.json()).data;
    expect((await request(root+'/carts/'+cart.cartToken+'/items','POST',{ productId: fixture.product.id,quantity: '1' })).status).toBe(201);
    const view = await request(root+'/carts/'+cart.cartToken,'GET'); expect(view.status).toBe(200); expect((await view.json()).data).not.toHaveProperty('tokenHash');
    const started = await request(root+'/checkout-sessions','POST',{ cartToken: cart.cartToken,customerInfo: { name: 'Buyer',email: 'http@example.test' },shippingInfo: { country: 'EG',region: 'EG',city: 'Cairo',line1: 'Street' },payerType: 'PERSON' });
    expect(started.status).toBe(201); const session = (await started.json()).data;
    const path = root+'/checkout-sessions/'+session.id;
    expect((await request(path+'/status','GET')).status).toBe(400);
    const quoted = await request(path+'/quote','POST',{ paymentMethodId: 'OFFLINE' },{ 'x-checkout-token': session.checkoutSessionToken }); expect(quoted.status).toBe(200);
    const quote = (await quoted.json()).data;
    const placed = await request(path+'/place-order','POST',{ quoteHash: quote.quoteHash,consents },{ 'x-checkout-token': session.checkoutSessionToken,'idempotency-key': randomUUID() }); expect(placed.status).toBe(201);
    const result = (await placed.json()).data; expect(result.paymentStatus).toBe('UNPAID'); expect(result).not.toHaveProperty('customer');
  });

  it('returns only coupon eligibility and rate limits probing', async () => {
    const c = await checkoutFixture();
    for (let i=0;i<10;i++) expect(await checkout.validateCoupon(fixture.front.slug,{ checkoutSessionToken: c.session.checkoutSessionToken,code: 'UNKNOWN' })).toEqual({ eligible: false });
    await expect(checkout.validateCoupon(fixture.front.slug,{ checkoutSessionToken: c.session.checkoutSessionToken,code: 'UNKNOWN' })).rejects.toMatchObject({ status: 429 });
  });
});
