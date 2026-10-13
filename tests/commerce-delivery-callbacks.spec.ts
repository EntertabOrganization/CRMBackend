import { PrismaClient } from '@prisma/client';
import { randomUUID,createHmac } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { InMemorySecretPort } from '../src/server/ports';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { PackRouter } from '../src/server/process-platform/http';
import { nestControllers,configurePackBodyParsing } from '../src/server/process-platform/nest-adapter';
import { CommerceShipmentService } from '../src/server/commerce/shipment-service';
import { CommerceDeliveryCallbackService } from '../src/server/commerce/delivery-callback-service';
import { CommerceCartService } from '../src/server/commerce/cart-service';
import { CommerceCheckoutService } from '../src/server/commerce/checkout-service';
import { resetRateLimits } from '../src/server/rate-limit';

jest.setTimeout(120000);
let db: PrismaClient,shipments: CommerceShipmentService,callbacks: CommerceDeliveryCallbackService;
const secrets = new InMemorySecretPort(),key = 'test-delivery-secret-'+randomUUID();
beforeAll(async () => {
  const url = await prepareProcessPlatformDatabase('truecrm_delivery_test');
  db = new PrismaClient({ datasources: { db: { url } } }); shipments = new CommerceShipmentService(db); callbacks = new CommerceDeliveryCallbackService(db,shipments,secrets);
},300000);
afterAll(async () => { await db?.$disconnect(); });
beforeEach(() => resetRateLimits());

async function fixture(dispatch = true) {
  const user = await db.user.create({ data: { firstName: 'Delivery',lastName: 'Test',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Delivery',slug: randomUUID(),ownerUserId: user.id } });
  const role = await db.role.create({ data: { workspaceId: workspace.id,name: 'Delivery agent' } });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id,userId: user.id,roleId: role.id } });
  await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(p => ({ roleId: role.id,permissionId: p.id,scope: 'WORKSPACE' as const })) });
  const actor = await resolvePrincipal(db,workspace.id,user.id),warehouse = await shipments.warehouses.create(actor,{ name: 'Warehouse',code: 'WAREHOUSE',type: 'PHYSICAL',timezone: 'Africa/Cairo' });
  const catalog = await db.catalog.create({ data: { workspaceId: workspace.id,name: 'Catalog',normalizedName: 'catalog' } });
  const product = await db.catalogProduct.create({ data: { workspaceId: workspace.id,catalogId: catalog.id,type: 'SERVICE',name: 'Digital service' } });
  const priceType = await db.catalogPriceType.create({ data: { workspaceId: workspace.id,code: 'RETAIL',name: 'Retail' } });
  await db.catalogProductPrice.create({ data: { workspaceId: workspace.id,productId: product.id,priceTypeId: priceType.id,currency: 'EGP',amount: '10' } });
  const store = await db.commerceStore.create({ data: { workspaceId: workspace.id,name: 'Store',code: 'STORE',status: 'ACTIVE',catalogId: catalog.id,priceTypeId: priceType.id,defaultCurrency: 'EGP',timezone: 'Africa/Cairo',createdByUserId: user.id,
    settings: { paymentMethods: ['COD'],deliveryPolicy: 'PICKUP',deliveryPrincipalUserId: user.id } } });
  const front = await db.commerceStorefront.create({ data: { workspaceId: workspace.id,storeId: store.id,type: 'WEB',status: 'PUBLISHED',publishedAt: new Date(),slug: 'delivery-'+randomUUID() } });
  await db.commerceProductPublication.create({ data: { workspaceId: workspace.id,storeId: store.id,productId: product.id,inventoryKey: product.id,published: true,seoSlug: 'service',createdByUserId: user.id } });
  const carts = new CommerceCartService(db),checkout = new CommerceCheckoutService(db,carts),cart = await carts.create(front.slug,{},randomUUID());
  await carts.mutate(front.slug,cart.cartToken,{ productId: product.id,quantity: '1' },'ADD');
  const session = await checkout.create(front.slug,{ cartToken: cart.cartToken,customerInfo: { name: 'Buyer',email: 'buyer@example.test' },shippingInfo: { country: 'EG',region: 'EG',city: 'Cairo',line1: 'Street' },payerType: 'PERSON' });
  const quote = await checkout.quote(front.slug,session.id,session.checkoutSessionToken,{ paymentMethodId: 'COD' });
  await checkout.place(front.slug,session.id,session.checkoutSessionToken,{ quoteHash: quote.quoteHash,consents: [{ kind: 'TERMS',version: '1',accepted: true },{ kind: 'PRIVACY',version: '1',accepted: true }] },randomUUID());
  const order = await db.commerceOrder.findUniqueOrThrow({ where: { cartId: cart.id } });
  const connection = await db.integrationOutboundConnection.create({ data: { workspaceId: workspace.id,name: 'Delivery provider',baseUrl: 'https://delivery.example.test',allowedHosts: ['delivery.example.test'],secretReference: 'delivery-key',createdByUserId: user.id } });
  secrets.set(workspace.id,'delivery-key',key);
  const delivery = await shipments.deliveryServices(actor,store.id,{ type: 'DIGITAL',providerConnectionId: connection.id,rates: [{ price: '0',currency: 'EGP',estimatedDaysMin: 0,estimatedDaysMax: 0 }] }) as { id: string };
  const created = await shipments.create(actor,order.id,{ warehouseId: warehouse.id,deliveryServiceId: delivery.id,items: [{ orderLineId: quote.lines[0].itemId,quantity: '1' }] },randomUUID());
  const updated = await shipments.update(actor,created.id,{ expectedVersion: created.version.toString(),trackingInfo: { trackingNumber: 'TRACK',externalShipmentId: 'external-'+randomUUID() } });
  const shipment = dispatch ? await shipments.transition(actor,updated.id,{ expectedVersion: updated.version.toString() },randomUUID(),'SHIP') : updated;
  return { actor,workspace,role,store,order,connection,shipment };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function event(f: Fixture,status = 'DELIVERED',occurredAt = new Date().toISOString(),eventId = randomUUID()) {
  return { eventId,externalShipmentId: f.shipment.externalShipmentId!,status,providerStatus: 'Carrier '+status,occurredAt };
}
function headers(f: Fixture,body: string,timestamp = String(Math.floor(Date.now()/1000))) {
  return new Headers({ 'content-type': 'application/json','x-delivery-connection-id': f.connection.id,'x-delivery-timestamp': timestamp,
    'x-delivery-signature': createHmac('sha256',key).update(timestamp+'.'+body).digest('hex') });
}
function router() { return new PackRouter().addSignedPublic('/api/v1/commerce/delivery-providers/:providerCode/webhook','CommerceDeliveryController',c => callbacks.receive(c.params.providerCode,c.request.headers,c.rawBody!)); }

describe('New signed Delivery callbacks and durable inbox', () => {
  it('queues once, processes once across workers and keeps unpaid COD Orders financially independent', async () => {
    const f = await fixture(),body = JSON.stringify(event(f),null,2),proof = headers(f,body);
    const received = await Promise.all([callbacks.receive('generic-hmac',proof,body),callbacks.receive('generic-hmac',proof,body)]);
    expect(received[0].eventId).toBe(received[1].eventId);
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('SHIPPED');
    await Promise.all([callbacks.tick(),callbacks.tick()]);
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('DELIVERED');
    expect((await db.commerceOrder.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('PROCESSING');
    expect(await db.outboxEvent.count({ where: { entityId: f.shipment.id,eventType: 'SHIPMENT_DELIVERED' } })).toBe(1);
    expect(await db.commerceDeliveryProviderEvent.count({ where: { shipmentId: f.shipment.id,status: 'SUCCEEDED' } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: received[0].eventId,action: 'DELIVERY_PROVIDER_EVENT_RECEIVED' } })).toBe(1);
  });

  it('rejects bad signatures, expired timestamps, payload changes and cross-Workspace shipment references', async () => {
    const f = await fixture(),other = await fixture(),data = event(f),body = JSON.stringify(data),proof = headers(f,body);
    const bad = new Headers(proof); bad.set('x-delivery-signature','0'.repeat(64));
    await expect(callbacks.receive('generic-hmac',bad,body)).rejects.toMatchObject({ code: 'DELIVERY_PROVIDER_SIGNATURE_INVALID' });
    await expect(callbacks.receive('generic-hmac',headers(f,body,String(Math.floor(Date.now()/1000)-301)),body)).rejects.toMatchObject({ code: 'DELIVERY_PROVIDER_SIGNATURE_INVALID' });
    await expect(callbacks.receive('generic-hmac',proof,body+' ')).rejects.toMatchObject({ code: 'DELIVERY_PROVIDER_SIGNATURE_INVALID' });
    const foreign = JSON.stringify({ ...data,externalShipmentId: other.shipment.externalShipmentId });
    await expect(callbacks.receive('generic-hmac',headers(f,foreign),foreign)).rejects.toMatchObject({ code: 'DELIVERY_PROVIDER_SIGNATURE_INVALID' });
    expect(await db.commerceDeliveryProviderEvent.count({ where: { shipmentId: f.shipment.id } })).toBe(0);
    await callbacks.receive('generic-hmac',proof,body);
    const reformatted = JSON.stringify(data,null,2);
    expect((await callbacks.receive('generic-hmac',headers(f,reformatted),reformatted)).duplicate).toBe(true);
    const changed = JSON.stringify({ ...data,status: 'FAILED' });
    await expect(callbacks.receive('generic-hmac',headers(f,changed),changed)).rejects.toMatchObject({ code: 'DELIVERY_PROVIDER_REPLAY_CONFLICT' });
  });

  it('ignores stale/regressive events and records returned logistics without stock or payment mutations', async () => {
    const f = await fixture();
    const transit = JSON.stringify(event(f,'IN_TRANSIT')); await callbacks.receive('generic-hmac',headers(f,transit),transit); await callbacks.tick();
    const deliveredAt = new Date().toISOString(),delivered = JSON.stringify(event(f,'DELIVERED',deliveredAt)); await callbacks.receive('generic-hmac',headers(f,delivered),delivered); await callbacks.tick();
    const stale = JSON.stringify(event(f,'IN_TRANSIT',new Date(new Date(f.shipment.shippedAt!).getTime()-1000).toISOString()));
    await callbacks.receive('generic-hmac',headers(f,stale),stale); await callbacks.tick();
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('DELIVERED');
    const returned = JSON.stringify(event(f,'RETURNED',deliveredAt)); await callbacks.receive('generic-hmac',headers(f,returned),returned); await callbacks.tick();
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('RETURNED');
    expect(await db.inventoryMovement.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await db.commerceOrderPaymentBinding.count({ where: { orderId: f.order.id } })).toBe(0);
  });

  it('rechecks current worker grants and bounds retries without advancing an unauthorized Shipment', async () => {
    const f = await fixture(),body = JSON.stringify(event(f)); await callbacks.receive('generic-hmac',headers(f,body),body);
    const permission = await db.permission.findUniqueOrThrow({ where: { key: 'COMMERCE.SHIPMENT_MANAGE' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: permission.id } },data: { isDeleted: true } });
    for (let i=0;i<5;i++) { await db.commerceDeliveryProviderEvent.updateMany({ where: { shipmentId: f.shipment.id,status: 'QUEUED' },data: { nextAttemptAt: new Date(0) } }); await callbacks.tick(); }
    const row = await db.commerceDeliveryProviderEvent.findFirstOrThrow({ where: { shipmentId: f.shipment.id } }); expect(row.status).toBe('FAILED'); expect(row.attempts).toBe(5); expect(row.errorCode).toBe('PERMISSION_DENIED');
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('SHIPPED');
    await expect(db.commerceDeliveryProviderEvent.update({ where: { id: row.id },data: { payloadHash: '0'.repeat(64) } })).rejects.toThrow('DELIVERY_EVENT_IMMUTABLE');
  });

  it('cannot use a provider event to dispatch an unposted Shipment', async () => {
    const f = await fixture(false),body = JSON.stringify(event(f)); await callbacks.receive('generic-hmac',headers(f,body),body); await callbacks.tick();
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('NEW');
    expect((await db.commerceDeliveryProviderEvent.findFirstOrThrow({ where: { shipmentId: f.shipment.id } })).errorCode).toBe('SHIPMENT_INVALID_STATE');
  });

  it('rechecks external shipment identity after receipt before applying delayed provider evidence', async () => {
    const f = await fixture(false),body = JSON.stringify(event(f)); await callbacks.receive('generic-hmac',headers(f,body),body);
    const updated = await shipments.update(f.actor,f.shipment.id,{ expectedVersion: f.shipment.version.toString(),trackingInfo: { trackingNumber: 'NEW',externalShipmentId: 'new-external-id' } });
    await shipments.transition(f.actor,updated.id,{ expectedVersion: updated.version.toString() },randomUUID(),'SHIP');
    await callbacks.tick();
    expect((await db.commerceShipment.findUniqueOrThrow({ where: { id: f.shipment.id } })).status).toBe('SHIPPED');
    expect((await db.commerceDeliveryProviderEvent.findFirstOrThrow({ where: { shipmentId: f.shipment.id } })).errorCode).toBe('DELIVERY_AUTHORITY_UNAVAILABLE');
  });

  it('preserves signed raw bytes and size limits through Next dispatch and real Nest HTTP', async () => {
    const f = await fixture(),body = JSON.stringify(event(f),null,2),proof = headers(f,body),pack = router();
    const path = '/api/v1/commerce/delivery-providers/generic-hmac/webhook';
    expect((await pack.dispatch(new NextRequest('http://localhost'+path,{ method: 'POST',headers: proof,body }))).status).toBe(202);
    const oversized = ' '.repeat(262145);
    expect((await pack.dispatch(new NextRequest('http://localhost'+path,{ method: 'POST',headers: headers(f,oversized),body: oversized }))).status).toBe(413);
    class DeliveryTestModule {} Module({ controllers: nestControllers(pack) })(DeliveryTestModule);
    const app = await NestFactory.create<NestExpressApplication>(DeliveryTestModule,{ rawBody: true,logger: false }); configurePackBodyParsing(app);
    try {
      await app.listen(0,'127.0.0.1');
      // >100KB tests the configured Nest parser limit; the signature includes original whitespace.
      const raw = ' '.repeat(110000)+JSON.stringify(event(f,'IN_TRANSIT'));
      const response = await fetch((await app.getUrl())+path,{ method: 'POST',headers: headers(f,raw),body: raw }); expect(response.status).toBe(202);
      expect((await response.json() as { success: boolean }).success).toBe(true);
    } finally { await app.close(); }
  });
});
