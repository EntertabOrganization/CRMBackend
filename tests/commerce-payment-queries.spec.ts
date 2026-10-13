import { PrismaClient } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { CommercePaymentQueryService } from '../src/server/commerce/payment-query-service';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { signAccessToken } from '../src/server/security';
import { Module,Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

jest.setTimeout(120000);
let db: PrismaClient,queries: CommercePaymentQueryService;
beforeAll(async () => {
  const url = await prepareProcessPlatformDatabase('truecrm_payment_queries_test');
  db = new PrismaClient({ datasources: { db: { url } } }); queries = new CommercePaymentQueryService(db);
},300000);
afterAll(async () => { await db?.$disconnect(); });
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
async function fixture() {
  const user = await db.user.create({ data: { firstName: 'Payment',lastName: 'Reader',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Payments',slug: randomUUID(),ownerUserId: user.id } });
  const role = await db.role.create({ data: { workspaceId: workspace.id,name: 'Reader',isOwnerRole: true } });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id,userId: user.id,roleId: role.id } });
  await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(p => ({ roleId: role.id,permissionId: p.id,scope: 'WORKSPACE' as const })) });
  const actor = await resolvePrincipal(db,workspace.id,user.id);
  const catalog = await db.catalog.create({ data: { workspaceId: workspace.id,name: 'Catalog',normalizedName: 'catalog' } });
  const store = await db.commerceStore.create({ data: { workspaceId: workspace.id,name: 'Store',code: 'PAYMENTS',defaultCurrency: 'EGP',timezone: 'Africa/Cairo',catalogId: catalog.id,createdByUserId: user.id } });
  const cart = await db.commerceCart.create({ data: { workspaceId: workspace.id,storeId: store.id,tokenHash: hash(),currency: 'EGP',expiresAt: new Date(Date.now()+3600000) } });
  const session = await db.commerceCheckoutSession.create({ data: { workspaceId: workspace.id,storeId: store.id,cartId: cart.id,tokenHash: hash(),customerSnapshot: {},addressSnapshot: {},payerType: 'PERSON',expiresAt: new Date(Date.now()+3600000) } });
  const order = await db.commerceOrder.create({ data: { workspaceId: workspace.id,storeId: store.id,cartId: cart.id,checkoutSessionId: session.id,currency: 'EGP',total: '10000',snapshot: {},consents: [] } });
  return { user,workspace,role,actor,store,order };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function payment(f: Fixture,amount: string,status = 'SUCCEEDED',allocated = amount) {
  const id = randomUUID();
  await db.commercialPackRecord.create({ data: { id,workspaceId: f.workspace.id,collection: 'payments',data: { id,workspaceId: f.workspace.id,amount,currencyCode: 'EGP',settlementStatus: status,methodType: 'PROVIDER',providerKey: 'sandbox',responsibleUserId: f.user.id,pan: 'secret-pan-marker',cvv: 'secret-cvv-marker',providerCredential: 'secret-credential-marker' } } });
  await db.commerceOrderPaymentBinding.create({ data: { workspaceId: f.workspace.id,storeId: f.store.id,orderId: f.order.id,paymentId: id,amount: allocated } });
  return id;
}
async function permission(f: Fixture,key: string,scope?: 'OWN'|'WORKSPACE') {
  const p = await db.permission.findUniqueOrThrow({ where: { key } });
  await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: p.id } },data: scope ? { scope } : { isDeleted: true } });
}

describe('Changed Commerce shared payment queries', () => {
  it('reads split allocations and sanitized attempts without changing financial truth', async () => {
    const f = await fixture(),first = await payment(f,'2000'),second = await payment(f,'8000');
    const attemptId = randomUUID();
    await db.commercialPackRecord.create({ data: { id: attemptId,workspaceId: f.workspace.id,collection: 'paymentAttempts',data: { paymentId: first,status: 'SUCCEEDED',requestedAmount: '2000',currencyCode: 'EGP',providerKey: 'sandbox',invoiceIds: ['hidden-invoice'],merchantId: 'secret-merchant-marker',providerTransactionId: 'secret-transaction-marker',publicData: { clientSecret: 'secret-client-marker' } } } });
    const before = { records: await db.commercialPackRecord.count(),audit: await db.auditLog.count(),outbox: await db.outboxEvent.count() };
    const ledger = await queries.list(f.actor,f.order.id);
    expect(ledger.map(row => row.allocatedAmount).sort()).toEqual(['2000.000000','8000.000000']);
    expect(ledger.every(row => row.status==='PAID')).toBe(true);
    const detail = await queries.get(f.actor,first);
    expect(detail.attempts).toEqual([{ id: attemptId,status: 'SUCCEEDED',requestedAmount: '2000',currencyCode: 'EGP',providerKey: 'sandbox' }]);
    expect(JSON.stringify(detail)).not.toMatch(/secret-|hidden-invoice/);
    expect((await queries.get(f.actor,second)).netSettledAmount).toBe('8000.000000');
    expect({ records: await db.commercialPackRecord.count(),audit: await db.auditLog.count(),outbox: await db.outboxEvent.count() }).toEqual(before);
  });
  it('derives refunds and pending status from shared settlement rather than browser state', async () => {
    const f = await fixture(),id = await payment(f,'10000');
    for (const [amount,status] of [['1500','SUCCEEDED'],['500','PENDING'],['100','FAILED']]) {
      await db.commercialPackRecord.create({ data: { id: randomUUID(),workspaceId: f.workspace.id,collection: 'refunds',data: { paymentId: id,amount,currencyCode: 'EGP',status,providerRefundId: 'secret-refund-marker' } } });
    }
    expect(await queries.get(f.actor,id)).toMatchObject({ status: 'PARTIALLY_REFUNDED',capturedAmount: '10000.000000',refundedAmount: '1500.000000',netSettledAmount: '8500.000000' });
    const pending = await payment(f,'1','PENDING');
    expect(await queries.get(f.actor,pending)).toMatchObject({ status: 'PENDING',capturedAmount: '0.000000' });
    await db.commercialPackRecord.create({ data: { id: randomUUID(),workspaceId: f.workspace.id,collection: 'refunds',data: { paymentId: id,amount: '8500',currencyCode: 'EGP',status: 'SUCCEEDED' } } });
    expect((await queries.get(f.actor,id)).status).toBe('REFUNDED');
  });
  it('hides foreign/unbound IDs and requires explicit grants even for owners', async () => {
    const f = await fixture(),other = await fixture(),id = await payment(f,'10');
    await expect(queries.get(other.actor,id)).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND',status: 404 });
    await expect(queries.list(other.actor,f.order.id)).rejects.toMatchObject({ code: 'COMMERCE_ORDER_NOT_FOUND',status: 404 });
    await expect(queries.get(f.actor,randomUUID())).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND',status: 404 });
    await permission(f,'COMMERCE.PAYMENT_VIEW');
    await expect(queries.get(f.actor,id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(queries.list(f.actor,f.order.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('intersects Store and shared payment owner scopes and detects current revocation', async () => {
    const f = await fixture(),id = await payment(f,'10');
    await permission(f,'payment.read');
    await expect(queries.get(f.actor,id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const p = await db.permission.findUniqueOrThrow({ where: { key: 'payment.read' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id,permissionId: p.id } },data: { isDeleted: false,scope: 'OWN' } });
    const owner = await db.user.create({ data: { firstName: 'Other',lastName: 'Owner',email: randomUUID()+'@example.test',status: 'ACTIVE' } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id,userId: owner.id,roleId: f.role.id } });
    const record = await db.commercialPackRecord.findUniqueOrThrow({ where: { id } });
    await db.commercialPackRecord.update({ where: { id },data: { data: { ...record.data as object,responsibleUserId: owner.id } } });
    await expect(queries.get(f.actor,id)).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
    await permission(f,'COMMERCE.PAYMENT_VIEW','OWN');
    await db.commerceStore.update({ where: { id: f.store.id },data: { createdByUserId: owner.id } });
    await expect(queries.get(f.actor,id)).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
    await expect(queries.list(f.actor,f.order.id)).rejects.toMatchObject({ code: 'COMMERCE_STORE_NOT_FOUND' });
  });
  it('fails closed on currency drift, invalid refund totals and disabled entitlement', async () => {
    const f = await fixture(),id = await payment(f,'10');
    await db.commercialPackRecord.create({ data: { id: randomUUID(),workspaceId: f.workspace.id,collection: 'refunds',data: { paymentId: id,amount: '11',currencyCode: 'EGP',status: 'SUCCEEDED' } } });
    await expect(queries.get(f.actor,id)).rejects.toMatchObject({ code: 'PAYMENT_INVALID_STATE' });
    const foreign = await payment(f,'10');
    const record = await db.commercialPackRecord.findUniqueOrThrow({ where: { id: foreign } });
    await db.commercialPackRecord.update({ where: { id: foreign },data: { data: { ...record.data as object,currencyCode: 'USD' } } });
    await expect(queries.get(f.actor,foreign)).rejects.toMatchObject({ code: 'PAYMENT_CURRENCY_MISMATCH' });
    await expect(queries.list(f.actor,f.order.id)).rejects.toMatchObject({ code: 'PAYMENT_INVALID_STATE' });
    await db.workspace.update({ where: { id: f.workspace.id },data: { settings: { entitlements: { commerce: false } } } });
    await expect(queries.list(f.actor,f.order.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(queries.get(f.actor,foreign)).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
  });
  it('serves both changed authenticated HTTP routes with sanitized envelopes', async () => {
    const f = await fixture(),id = await payment(f,'10'),token = await signAccessToken(f.user.id);
    jest.resetModules(); (globalThis as typeof globalThis & { __trueAgentPrisma?: PrismaClient }).__trueAgentPrisma = db;
    const { GET } = await import('../app/api/v1/commerce/[[...path]]/route');
    for (const path of ['/api/v1/commerce/orders/'+f.order.id+'/payments','/api/v1/commerce/payments/'+id]) {
      const response = await GET(new NextRequest('http://localhost'+path,{ headers: { authorization: 'Bearer '+token,'x-workspace-id': f.workspace.id } }));
      expect(response.status).toBe(200); const body = await response.json(); expect(body.success).toBe(true); expect(JSON.stringify(body)).not.toMatch(/secret-/);
      expect((await GET(new NextRequest('http://localhost'+path))).status).toBe(401);
    }
  });
  it('runs only the changed Nest payment controllers over real HTTP', async () => {
    const f = await fixture(),other = await fixture(),id = await payment(f,'10'),token = await signAccessToken(f.user.id),foreignToken = await signAccessToken(other.user.id);
    const { PackRouter } = await import('../src/server/process-platform/http');
    const { nestControllers } = await import('../src/server/process-platform/nest-adapter');
    const router = new PackRouter()
      .add('GET','/api/v1/commerce/orders/:orderId/payments','CommercePaymentsController',c => queries.list(c.actor,c.params.orderId))
      .add('GET','/api/v1/commerce/payments/:paymentId','CommercePaymentsController',c => queries.get(c.actor,c.params.paymentId));
    class PaymentTestModule {}
    Module({ controllers: nestControllers(router) })(PaymentTestModule);
    Logger.overrideLogger(false);
    const app = await NestFactory.create(PaymentTestModule,{ logger: false });
    try {
      await app.listen(0,'127.0.0.1'); const base = await app.getUrl();
      for (const path of ['/api/v1/commerce/orders/'+f.order.id+'/payments','/api/v1/commerce/payments/'+id]) {
        const response = await fetch(base+path,{ headers: { authorization: 'Bearer '+token,'x-workspace-id': f.workspace.id } });
        expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toMatch(/secret-/);
        expect((await fetch(base+path)).status).toBe(401);
        expect((await fetch(base+path,{ headers: { authorization: 'Bearer '+foreignToken,'x-workspace-id': other.workspace.id } })).status).toBe(404);
      }
    } finally { await app.close(); }
  });
});
