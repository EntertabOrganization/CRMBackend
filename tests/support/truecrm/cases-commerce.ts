import { createHmac, randomUUID } from 'node:crypto';
import type { Generic, Probe } from './probe';

type Line = { itemId: string; productId: string; quantity: string; stockable: boolean; unitPrice: string; name: string };
const C = '/api/v1/commerce';
const c = (p: Probe) => p.x.c as Awaited<ReturnType<typeof import('./fixtures')['commerceWorld']>>;
async function lines(p: Probe, orderId: string) { return ((await p.q(db => db.commerceOrder.findUniqueOrThrow({ where: { id: orderId } }))).snapshot as { lines: Line[] }).lines; }
async function orderRow(p: Probe, id: string) { return p.q(db => db.commerceOrder.findUniqueOrThrow({ where: { id } })); }
async function deliveryService(p: Probe) {
  const res = await p.req('owner', 'POST', `${C}/stores/${c(p).store.id}/delivery-services`, { type: 'PICKUP', rates: [{ price: '0', currency: 'EGP', estimatedDaysMin: 0, estimatedDaysMax: 0 }] });
  p.ok('delivery service configured', res); return res.body.data?.id as string;
}
async function shipment(p: Probe, orderId: string, lineId: string, quantity: string, deliveryServiceId: string) {
  const res = await p.req('owner', 'POST', `${C}/orders/${orderId}/shipments`, { warehouseId: c(p).warehouse.id, deliveryServiceId, items: [{ orderLineId: lineId, quantity }] }, { 'Idempotency-Key': p.key('ship') });
  p.ok('shipment created through the owning shipment service', res); return res.body.data as { id: string; version: string };
}
async function dispatch(p: Probe, row: { id: string; version: string }) {
  const res = await p.req('owner', 'POST', `${C}/shipments/${row.id}/ship`, { expectedVersion: String(row.version) }, { 'Idempotency-Key': p.key('dispatch') });
  p.ok('shipment dispatched (inventory issue posted)', res); return res.body.data as { id: string; version: string; status: string };
}
const confirm = (p: Probe, session: { sessionId: string; token: string }, key: string, body: Record<string, unknown> = {}) =>
  p.req('guest', 'POST', `/api/v1/public/checkout-sessions/${session.sessionId}/confirm`, { acceptedQuoteVersion: 1, paymentMethodId: 'OFFLINE', ...body }, { 'Idempotency-Key': key, 'x-checkout-token': session.token });
async function moreStock(p: Probe, productId: string, quantity: string) { await p.call(() => c(p).receive(productId, quantity)); }
async function guestSession(p: Probe, orderId: string) {
  const link = await p.req('owner', 'POST', `${C}/orders/${orderId}/guest-access-links`, {});
  p.ok('staff issued a one-time guest order link', link);
  const exchanged = await p.req('guest', 'POST', '/api/v1/public/order-access/exchange', { token: link.body.data?.token });
  p.ok('guest link exchanged for an order-scoped session', exchanged);
  return exchanged.body.data?.accessToken as string;
}

export const commerceGeneric: Generic = {
  scenario: 'commerce_checkout',
  async foreign(p) { return { actor: 'owner', path: `${C}/orders/${p.ids.foreignOrderId}` }; },
  async mutation(p) {
    const slug = 'store-' + randomUUID().slice(0, 8);
    return { actor: 'owner', deniedActor: 'employee', req: { method: 'POST', path: `${C}/stores`, body: { name: 'Second store', slug, defaultCurrency: 'EGP', timezone: 'Africa/Cairo', catalogId: c(p).catalog.id } },
      count: () => p.q(db => db.commerceStore.count({ where: { workspaceId: p.f.workspaceId } })), resourceId: res => res.body.data?.id };
  },
  async idempotent(p) {
    const s = await c(p).session([{ productId: c(p).service.id, qty: '1' }]);
    return { actor: 'guest', req: { method: 'POST', path: `/api/v1/public/checkout-sessions/${s.sessionId}/confirm`, body: { acceptedQuoteVersion: 1, paymentMethodId: 'OFFLINE' }, headers: { 'x-checkout-token': s.token } },
      count: () => p.q(db => db.commerceOrder.count({ where: { workspaceId: p.f.workspaceId, checkoutSessionId: s.sessionId } })), id: res => res.body.data?.id };
  },
};

export const commerceCases: Record<string, (p: Probe) => Promise<void>> = {
  // ------------------------------------------------------------ 01 store administration
  async '01-store-administration::AC01'(p) {
    const make = (currency: string) => p.req('owner', 'POST', `${C}/stores`, { name: 'Store ' + currency, slug: 'store-' + currency.toLowerCase() + '-' + randomUUID().slice(0, 6), defaultCurrency: currency, timezone: 'Africa/Cairo', catalogId: c(p).catalog.id });
    const egp = await make('EGP'), usd = await make('USD');
    p.ok('first store created', egp); p.ok('second store with another currency created', usd);
    const rows = await p.q(db => db.commerceStore.findMany({ where: { workspaceId: p.f.workspaceId, id: { in: [egp.body.data?.id, usd.body.data?.id].filter(Boolean) } } }));
    p.check('both stores persist independently with their own currency', new Set(rows.map(r => r.defaultCurrency)).size === 2 && rows.length === 2, rows.map(r => r.defaultCurrency));
  },
  async '01-store-administration::AC02'(p) {
    const prefix = '/shop-' + randomUUID().slice(0, 6);
    const first = await p.req('owner', 'POST', `${C}/stores/${c(p).store.id}/channels`, { routePrefix: prefix });
    p.ok('first channel route registered', first);
    const second = await p.req('owner', 'POST', `${C}/stores/${c(p).store.id}/channels`, { routePrefix: prefix + '/sub' });
    p.status('colliding route rejected with 409', second, [409]); p.code('collision code', second, ['ROUTE_COLLISION']);
    p.check('only one channel persisted', (await p.q(db => db.commerceStoreChannel.count({ where: { storeId: c(p).store.id } }))) === 1);
  },
  async '01-store-administration::AC03'(p) {
    const res = await p.req('outsider', 'GET', `${C}/stores/${c(p).store.id}`);
    p.status('store from another workspace is concealed', res, [403, 404]);
    p.check('no store data exposed', res.body.data === undefined && !JSON.stringify(res.body).includes(c(p).store.name));
    p.check('store still exists in its own workspace', Boolean(await p.q(db => db.commerceStore.findUnique({ where: { id: c(p).store.id } }))));
  },
  async '01-store-administration::AC04'(p) {
    const store = await p.q(db => db.commerceStore.findUniqueOrThrow({ where: { id: c(p).store.id } }));
    const suspended = await p.req('owner', 'POST', `${C}/stores/${store.id}/suspend`, { expectedVersion: store.version.toString() });
    p.ok('store suspended', suspended);
    const blocked = await confirm(p, p.x.main, p.key('suspended'));
    p.status('new checkout is denied for a suspended store', blocked, [409]); p.code('checkout blocked code', blocked, ['CHECKOUT_BLOCKED']);
    const existing = await p.req('owner', 'GET', `${C}/orders/${p.ids.pendingOrderId}`);
    p.ok('existing order obligations remain accessible', existing);
    p.check('no order was created for the blocked session', (await p.q(db => db.commerceOrder.count({ where: { checkoutSessionId: p.x.main.sessionId } }))) === 0);
  },
  // ------------------------------------------------------------ 02 publication & pricing
  async '02-product-publication-and-pricing::AC01'(p) {
    const list = () => p.req('guest', 'GET', `/api/v1/public/stores/${c(p).slug}/products`);
    const before = await list(); p.ok('public catalog readable', before);
    p.check('published product listed', JSON.stringify(before.body.data).includes(c(p).stock.id));
    const pub = await p.q(db => db.commerceProductPublication.findUniqueOrThrow({ where: { id: c(p).publications[c(p).stock.id] } }));
    const res = await p.req('owner', 'PUT', `${C}/stores/${c(p).store.id}/publications/${c(p).stock.id}`, { published: false, seoSlug: pub.seoSlug, expectedVersion: pub.version.toString() });
    p.ok('product unpublished', res);
    const after = await list();
    p.check('unpublished product no longer exposed publicly', !JSON.stringify(after.body.data ?? {}).includes(c(p).stock.id), after.status);
  },
  async '02-product-publication-and-pricing::AC02'(p) {
    const before = await orderRow(p, p.ids.pendingOrderId), snapshot = JSON.stringify(before.snapshot);
    const res = await p.req('owner', 'PATCH', `${C}/listings/${c(p).publications[c(p).stock.id]}`, { price: { amount: '999', currency: 'EGP' } });
    p.ok('store price changed', res);
    const preview = await p.req('owner', 'GET', `${C}/stores/${c(p).store.id}/price-preview?productId=${c(p).stock.id}`);
    p.check('new price is effective for new quotes', preview.body.data?.unitPrice?.startsWith('999'), preview.body.data);
    const after = await orderRow(p, p.ids.pendingOrderId);
    p.check('historical order total unchanged', after.total.equals(before.total), { before: before.total.toFixed(6), after: after.total.toFixed(6) });
    p.check('historical order snapshot unchanged', JSON.stringify(after.snapshot) === snapshot);
  },
  async '02-product-publication-and-pricing::AC03'(p) {
    const wrongVariant = await p.req('owner', 'GET', `${C}/stores/${c(p).store.id}/price-preview?productId=${c(p).stock.id}&variantId=${randomUUID()}`);
    p.status('variant not belonging to the product is rejected', wrongVariant, [400, 404, 422]);
    const lookup = await p.req('employee', 'GET', `${C}/orders/${p.ids.pendingOrderId}/availability`);
    p.status('warehouse/stock lookup requires order authority', lookup, [403, 404]);
    const allowed = await p.req('owner', 'GET', `${C}/orders/${p.ids.pendingOrderId}/availability`);
    p.ok('authorized availability lookup succeeds', allowed);
    p.check('availability is computed from Inventory reservations', Array.isArray(allowed.body.data?.lines) && allowed.body.data.lines.length > 0);
    p.check('reservation rows exist for the order', (await p.obs('inventory_reservations', { orderId: p.ids.pendingOrderId })).length > 0);
  },
  // ------------------------------------------------------------ 03 customers
  async '03-customer-identities-and-portal::AC01'(p) {
    const token = await guestSession(p, p.ids.pendingOrderId);
    const own = await p.req('guest', 'GET', `/api/v1/customer/orders/${p.ids.pendingOrderId}`, undefined, { authorization: 'Bearer ' + token });
    p.ok('guest reads the order bound to the token', own);
    const other = await p.req('guest', 'GET', `/api/v1/customer/orders/${p.ids.latePaidOrderId}`, undefined, { authorization: 'Bearer ' + token });
    p.status('guest token cannot read another order', other, [403, 404]);
    p.check('token persisted hashed and order-scoped', (await p.q(db => db.commerceCustomerToken.count({ where: { orderId: p.ids.pendingOrderId, purpose: 'GUEST_ORDER_SESSION' } }))) === 1);
  },
  async '03-customer-identities-and-portal::AC02'(p) {
    const link = await p.req('owner', 'POST', `${C}/orders/${p.ids.pendingOrderId}/guest-access-links`, {});
    p.ok('link issued', link);
    await p.q(db => db.commerceCustomerToken.updateMany({ where: { orderId: p.ids.pendingOrderId, purpose: 'GUEST_ORDER_LINK' }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    const res = await p.req('guest', 'POST', '/api/v1/public/order-access/exchange', { token: link.body.data?.token });
    p.status('expired order-access token denied', res, [401, 404, 410]);
    p.check('no order session issued', (await p.q(db => db.commerceCustomerToken.count({ where: { orderId: p.ids.pendingOrderId, purpose: 'GUEST_ORDER_SESSION' } }))) === 0);
  },
  async '03-customer-identities-and-portal::AC03'(p) {
    const res = await p.req('guest', 'GET', '/api/v1/customer/orders', undefined, { authorization: 'Bearer ' + p.w.tokens.owner });
    p.status('workspace credential is not a storefront customer credential', res, [401]);
    p.check('no customer identity auto-created', (await p.q(db => db.commerceCustomerIdentity.count({ where: { workspaceId: p.f.workspaceId } }))) === 0);
  },
  // ------------------------------------------------------------ 04 carts & checkout
  async '04-carts-and-checkout::AC01'(p) {
    const key = p.key('five'), ids = [];
    for (let i = 0; i < 5; i++) { const r = await confirm(p, p.x.main, key); ids.push(r.body.data?.id); p.ok('retry ' + (i + 1) + ' accepted', r); }
    p.check('all retries return the same order', new Set(ids).size === 1 && Boolean(ids[0]), ids);
    p.check('exactly one order persisted', (await p.q(db => db.commerceOrder.count({ where: { checkoutSessionId: p.x.main.sessionId } }))) === 1);
    p.check('exactly one ORDER_CREATED event', (await p.obs('outbox_events', { resourceId: ids[0], eventType: 'ORDER_CREATED' })).length === 1);
  },
  async '04-carts-and-checkout::AC02'(p) {
    const key = p.key('payload');
    const a = await confirm(p, p.x.main, key, { buyer: { type: 'INDIVIDUAL', name: 'Fixture Buyer', email: 'buyer@example.test' } });
    p.ok('first payload accepted', a);
    const b = await confirm(p, p.x.main, key, { buyer: { type: 'INDIVIDUAL', name: 'Different Name', email: 'buyer@example.test' } });
    p.status('different payload with the same key returns 409', b, [409]); p.code('key reuse code', b, ['IDEMPOTENCY_KEY_REUSED']);
    p.check('still one order', (await p.q(db => db.commerceOrder.count({ where: { checkoutSessionId: p.x.main.sessionId } }))) === 1);
  },
  async '04-carts-and-checkout::AC03'(p) {
    const s = await c(p).session([{ productId: c(p).service.id, qty: '1' }]);
    const change = await p.req('owner', 'PATCH', `${C}/listings/${c(p).publications[c(p).service.id]}`, { price: { amount: '75', currency: 'EGP' } });
    p.ok('server price changed after quote', change);
    const res = await confirm(p, s, p.key('stale'));
    p.status('stale quote requires a refreshed quote', res, [409]); p.code('quote expired code', res, ['QUOTE_EXPIRED']);
    p.check('no order created from the stale quote', (await p.q(db => db.commerceOrder.count({ where: { checkoutSessionId: s.sessionId } }))) === 0);
  },
  async '04-carts-and-checkout::AC04'(p) {
    const [a, b] = await Promise.all([confirm(p, p.x.raceA, p.key('race-a')), confirm(p, p.x.raceB, p.key('race-b'))]);
    p.check('at most one checkout wins the final unit', [a, b].filter(r => r.status < 300).length <= 1, [a.status, b.status]);
    p.check('loser receives INSUFFICIENT_STOCK', [a, b].some(r => r.body.error?.code === 'INSUFFICIENT_STOCK'), [a.body.error, b.body.error]);
    const active = await p.obs('inventory_reservations', { variantId: c(p).race.id, status: 'ACTIVE' });
    p.check('reserved quantity never exceeds stock', active.reduce((s, r) => s + Number(r.quantity), 0) <= 1, active.length);
  },
  // ------------------------------------------------------------ 05 orders & amendments
  async '05-orders-and-amendments::AC01'(p) {
    const before = await lines(p, p.ids.pendingOrderId);
    await p.req('owner', 'PATCH', `${C}/listings/${c(p).publications[c(p).stock.id]}`, { price: { amount: '555', currency: 'EGP' } });
    await p.q(db => db.catalogProduct.update({ where: { id: c(p).stock.id }, data: { name: 'Renamed in catalog' } }));
    const res = await p.req('owner', 'GET', `${C}/orders/${p.ids.pendingOrderId}`);
    p.ok('order readable', res);
    const after = await lines(p, p.ids.pendingOrderId);
    p.check('line snapshot keeps the purchased name and price', after[0].name === before[0].name && after[0].unitPrice === before[0].unitPrice, { before: before[0], after: after[0] });
  },
  async '05-orders-and-amendments::AC02'(p) {
    const [line] = await lines(p, p.ids.pendingOrderId), service = await deliveryService(p);
    await shipment(p, p.ids.pendingOrderId, line.itemId, '1', service);
    const order = await orderRow(p, p.ids.pendingOrderId);
    const res = await p.req('owner', 'POST', `${C}/orders/${p.ids.pendingOrderId}/amend`, { expectedVersion: order.version.toString(), reason: 'Reduce', lines: [{ orderLineId: line.itemId, quantity: '0' }] }, { 'Idempotency-Key': p.key('amend') });
    p.status('shipped/allocated line cannot be rewritten', res, [409]);
    p.check('no amendment persisted', (await p.q(db => db.commerceOrderAmendment.count({ where: { orderId: p.ids.pendingOrderId } }))) === 0);
    p.check('order total unchanged', (await orderRow(p, p.ids.pendingOrderId)).total.equals(order.total));
  },
  async '05-orders-and-amendments::AC03'(p) {
    const order = await orderRow(p, p.ids.pendingOrderId), key = p.key('transition'), body = { expectedVersion: order.version.toString(), to: 'CONFIRMED' };
    const a = await p.req('owner', 'POST', `${C}/orders/${order.id}/transition`, body, { 'Idempotency-Key': key });
    const b = await p.req('owner', 'POST', `${C}/orders/${order.id}/transition`, body, { 'Idempotency-Key': key });
    p.ok('transition applied', a); p.ok('repeat returns stored result', b);
    p.check('single status event', (await p.obs('outbox_events', { resourceId: order.id, eventType: 'ORDER_STATUS_CHANGED' })).length === 1);
    p.check('order version advanced once', (await orderRow(p, order.id)).version === order.version + 1n);
  },
  async '05-orders-and-amendments::AC04'(p) {
    await p.call(() => c(p).pay(p.ids.pendingOrderId));
    const order = await orderRow(p, p.ids.pendingOrderId);
    const res = await p.req('owner', 'POST', `${C}/orders/${order.id}/transition`, { expectedVersion: order.version.toString(), to: 'CANCELLED' });
    p.status('cancel is not a status shortcut for paid orders', res, [409]);
    const after = await orderRow(p, order.id);
    p.check('paid funds preserved (no implicit refund)', after.paymentStatus === 'PAID' && after.refundedAmount.equals(0) && after.status !== 'CANCELLED', { status: after.status, paymentStatus: after.paymentStatus });
    p.check('no refund created by cancellation', (await p.obs('refunds', { orderId: order.id })).length === 0);
  },
  // ------------------------------------------------------------ 06 payments
  async '06-payments-and-reconciliation::AC01'(p) {
    const { paymentCommandFixture } = await import('../payment-command-fixture');
    const { CommercePaymentCallbackService } = await import('../../../src/server/commerce/payment-callback-service');
    const f = await paymentCommandFixture(p.db), callbacks = new CommercePaymentCallbackService(p.db, undefined, f.authority);
    const command = await f.service.create(f.actor, f.order.id, { methodId: f.method.id, amount: '100', mode: 'SALE' }, randomUUID());
    await f.service.process(command.commandId);
    const record = await p.q(db => db.commercialPackRecord.findUniqueOrThrow({ where: { id: command.paymentId } })), transactionId = (record.data as { providerTransactionId: string }).providerTransactionId;
    f.provider.settle(transactionId, 'SUCCEEDED');
    const event = { id: 'evt_' + randomUUID(), created: Math.floor(Date.now() / 1000), account: 'merchant-test', type: 'payment_intent.succeeded', data: { object: { id: transactionId, object: 'payment_intent', status: 'succeeded', amount: 10000, amount_received: 10000, amount_capturable: 0, currency: 'egp' } } };
    const raw = JSON.stringify(event), secret = JSON.parse(f.secrets.get('test-payment-bundle')!).webhookSecret as string;
    const headers = () => { const at = Math.floor(Date.now() / 1000); return new Headers({ 'x-payment-connection-id': f.connection.id, 'stripe-signature': 't=' + at + ',v1=' + createHmac('sha256', secret).update(at + '.' + raw).digest('hex') }); };
    const first = await p.call(() => callbacks.receive('stripe', headers(), raw));
    if (first.ok) { await p.q(db => db.sharedPaymentProviderEvent.update({ where: { id: (first.value as { eventId: string }).eventId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })); await p.call(() => callbacks.tick()); }
    const replay = await p.call(() => callbacks.receive('stripe', headers(), raw)); await p.call(() => callbacks.tick());
    p.check('verified callback accepted', first.ok, first.ok ? undefined : first.code);
    p.check('replay recognised as the same provider event', replay.ok && (replay.value as { eventId: string }).eventId === (first.value as { eventId?: string } | undefined)?.eventId, replay.ok ? replay.value : replay.code);
    p.check('exactly one payment allocation for the order', (await p.q(db => db.commerceOrderPaymentBinding.count({ where: { orderId: f.order.id } }))) === 1);
  },
  async '06-payments-and-reconciliation::AC02'(p) {
    const before = await p.obs('payment_allocations', { orderId: p.ids.pendingOrderId });
    const res = await p.req('guest', 'POST', '/api/v1/integrations/payments/stripe/webhook', { id: 'spoofed', type: 'payment_intent.succeeded' }, { 'X-Test-Signature': 'invalid' });
    p.status('unsigned/spoofed event rejected', res, [400, 401, 403]);
    p.check('no allocation created', (await p.obs('payment_allocations', { orderId: p.ids.pendingOrderId })).length === before.length);
  },
  async '06-payments-and-reconciliation::AC03'(p) {
    const res = await p.req('guest', 'GET', `/api/v1/public/stores/${c(p).slug}/payment-return?orderId=${p.ids.pendingOrderId}&success=true`);
    p.ok('return page answered from server projection', res);
    p.check('browser redirect does not confirm payment', res.body.data?.confirmed === false);
    p.check('order remains unpaid', (await orderRow(p, p.ids.pendingOrderId)).paymentStatus !== 'PAID');
  },
  async '06-payments-and-reconciliation::AC04'(p) {
    const [row] = await p.obs('orders', { id: p.ids.latePaidOrderId });
    const res = await p.req('owner', 'GET', `${C}/orders/${p.ids.latePaidOrderId}`);
    p.ok('late-paid order readable', res);
    p.check('captured payment preserved', row?.paymentStatus === 'PAID', row?.paymentStatus);
    p.check('fulfillment exception recorded', row?.fulfillmentStatus === 'EXCEPTION', row?.fulfillmentStatus);
    p.check('exception row opened', (await p.q(db => db.commerceFulfillmentException.count({ where: { orderId: p.ids.latePaidOrderId, status: 'OPEN' } }))) === 1);
    p.check('allocation retained', (await p.obs('payment_allocations', { orderId: p.ids.latePaidOrderId })).length > 0);
  },
  // ------------------------------------------------------------ 07 inventory reservations
  async '07-inventory-reservations::AC01'(p) {
    const [a, b] = await Promise.all([confirm(p, p.x.raceA, p.key('paid-a')), confirm(p, p.x.raceB, p.key('paid-b'))]);
    const winners = [a, b].filter(r => r.status < 300);
    p.check('only one checkout reserves the final unit', winners.length <= 1, [a.status, b.status]);
    for (const w of winners) await p.call(() => c(p).pay(w.body.data.id));
    const active = await p.obs('inventory_reservations', { variantId: c(p).race.id, status: 'ACTIVE' });
    p.check('active reservations never exceed one unit', active.reduce((s, r) => s + Number(r.quantity), 0) <= 1);
  },
  async '07-inventory-reservations::AC02'(p) {
    await moreStock(p, c(p).stock.id, '2');
    const placed = await c(p).order([{ productId: c(p).stock.id, qty: '2' }], 'partial@example.test');
    await p.call(() => c(p).pay(placed.orderId));
    const [line] = await lines(p, placed.orderId), service = await deliveryService(p);
    await dispatch(p, await shipment(p, placed.orderId, line.itemId, '1', service));
    const reservations = await p.obs('inventory_reservations', { orderId: placed.orderId });
    p.check('reservation keeps the consumed unit (not released)', reservations.some(r => Number(r.fulfilledQuantity) === 1) && reservations.every(r => r.status !== 'RELEASED'), reservations.map(r => [r.status, String(r.fulfilledQuantity)]));
    p.check('remaining unit still reserved', reservations.some(r => ['ACTIVE', 'PARTIALLY_FULFILLED'].includes(r.status)));
  },
  async '07-inventory-reservations::AC03'(p) {
    const store = await p.q(db => db.commerceStoreProfile.findUniqueOrThrow({ where: { storeId: c(p).store.id } }));
    p.ok('backorders enabled by policy', await p.req('owner', 'PATCH', `${C}/stores/${c(p).store.id}/policy`, { expectedPolicyVersion: store.policyVersion, backordersEnabled: true }));
    const placed = await p.call(() => c(p).order([{ productId: c(p).late.id, qty: '1' }], 'backorder@example.test'));
    p.check('order accepted as backorder', placed.ok, placed.ok ? undefined : placed.code);
    if (!placed.ok) return;
    const active = await p.obs('inventory_reservations', { orderId: placed.value.orderId, status: 'ACTIVE' });
    p.check('no fake ACTIVE reservation for unavailable stock', active.length === 0);
    p.check('explicit backorder line recorded', (await p.q(db => db.commerceBackorderLine.count({ where: { orderId: placed.value.orderId } }))) > 0);
  },
  // ------------------------------------------------------------ 08 shipping
  async '08-shipping-and-fulfillment::AC01'(p) {
    await moreStock(p, c(p).stock.id, '2');
    const placed = await c(p).order([{ productId: c(p).stock.id, qty: '2' }], 'split@example.test');
    const [line] = await lines(p, placed.orderId), service = await deliveryService(p);
    await shipment(p, placed.orderId, line.itemId, '1', service);
    const pickup = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/fulfillments`, { type: 'PICKUP', warehouseId: c(p).warehouse.id, lines: [{ orderLineId: line.itemId, quantity: '1' }] }, { 'Idempotency-Key': p.key('pickup') });
    p.ok('remaining quantity is still available for another fulfillment', pickup);
    p.check('two fulfillment records cover the order', (await p.q(db => db.commerceShipment.count({ where: { orderId: placed.orderId } }))) === 1 && (await p.q(db => db.commerceFulfillment.count({ where: { orderId: placed.orderId } }))) >= 1);
  },
  async '08-shipping-and-fulfillment::AC02'(p) {
    const [line] = await lines(p, p.ids.pendingOrderId);
    const res = await p.req('owner', 'POST', `${C}/orders/${p.ids.pendingOrderId}/fulfillments`, { type: 'PICKUP', warehouseId: c(p).warehouse.id, lines: [{ orderLineId: line.itemId, quantity: '3' }] }, { 'Idempotency-Key': p.key('over') });
    p.status('quantity above remaining rejected', res, [400, 409, 422]);
    p.check('no fulfillment persisted', (await p.q(db => db.commerceFulfillment.count({ where: { orderId: p.ids.pendingOrderId } }))) === 0);
  },
  async '08-shipping-and-fulfillment::AC03'(p) {
    await p.call(() => c(p).pay(p.ids.pendingOrderId));
    const [line] = await lines(p, p.ids.pendingOrderId), service = await deliveryService(p);
    const shipped = await dispatch(p, await shipment(p, p.ids.pendingOrderId, line.itemId, '1', service));
    const { CommerceShipmentService } = await import('../../../src/server/commerce/shipment-service');
    const owner = await p.w.principal('owner'), shipments = new CommerceShipmentService(p.db), externalEventId = 'trk-' + randomUUID();
    const apply = (status: 'IN_TRANSIT' | 'DELIVERED', at: Date, id = externalEventId) => p.call(() => p.db.$transaction(tx => shipments.applyDeliveryEvent(tx, owner, shipped.id, { status, occurredAt: at.toISOString(), providerStatus: status, externalEventId: id }), { timeout: 60000 }));
    await apply('DELIVERED', new Date()); await apply('DELIVERED', new Date());
    await apply('IN_TRANSIT', new Date(Date.now() - 3600000), 'older-' + randomUUID());
    const row = await p.q(db => db.commerceShipment.findUniqueOrThrow({ where: { id: shipped.id } }));
    p.check('status does not regress after replay/older event', row.status === 'DELIVERED', row.status);
    const events = await p.q(db => db.outboxEvent.count({ where: { entityId: shipped.id, eventType: { contains: 'DELIVERED' } } }));
    p.check('delivery notification emitted once', events <= 1, events);
    p.ok('shipment readable', await p.req('owner', 'GET', `${C}/shipments/${shipped.id}`));
  },
  // ------------------------------------------------------------ 09 returns & refunds
  async '09-returns-and-refunds::AC01'(p) {
    await moreStock(p, c(p).stock.id, '3');
    const placed = await c(p).order([{ productId: c(p).stock.id, qty: '3' }], 'returns@example.test');
    await p.call(() => c(p).pay(placed.orderId));
    const [line] = await lines(p, placed.orderId), service = await deliveryService(p);
    const shipped = await dispatch(p, await shipment(p, placed.orderId, line.itemId, '3', service));
    p.ok('delivered', await p.req('owner', 'POST', `${C}/shipments/${shipped.id}/deliver`, { trackingEvidence: { reference: 'POD', deliveredAt: new Date().toISOString() } }, { 'Idempotency-Key': p.key('deliver') }));
    const one = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/returns`, { items: [{ orderLineId: line.itemId, quantity: '1' }], reason: 'One unit' }, { 'Idempotency-Key': p.key('ret') });
    p.ok('partial return of 1/3 accepted', one);
    const over = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/returns`, { items: [{ orderLineId: line.itemId, quantity: '3' }], reason: 'Too many' }, { 'Idempotency-Key': p.key('ret') });
    p.status('return beyond remaining delivered quantity rejected', over, [409, 422]);
    p.check('no refund issued automatically', (await p.obs('refunds', { orderId: placed.orderId })).length === 0);
  },
  async '09-returns-and-refunds::AC02'(p) {
    await moreStock(p, c(p).stock.id, '1');
    const placed = await c(p).order([{ productId: c(p).stock.id, qty: '1' }], 'damaged@example.test');
    await p.call(() => c(p).pay(placed.orderId));
    const [line] = await lines(p, placed.orderId), service = await deliveryService(p);
    const shipped = await dispatch(p, await shipment(p, placed.orderId, line.itemId, '1', service));
    await p.req('owner', 'POST', `${C}/shipments/${shipped.id}/deliver`, { trackingEvidence: { reference: 'POD', deliveredAt: new Date().toISOString() } }, { 'Idempotency-Key': p.key('deliver') });
    const ret = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/returns`, { items: [{ orderLineId: line.itemId, quantity: '1' }], reason: 'Damaged' }, { 'Idempotency-Key': p.key('ret') });
    const id = ret.body.data?.id as string;
    await p.req('owner', 'POST', `${C}/returns/${id}/approve`, { expectedVersion: '1', decision: 'APPROVE' });
    await p.req('owner', 'POST', `${C}/returns/${id}/receive`, { receivedLines: [{ orderLineId: line.itemId, quantity: '1' }] }, { 'Idempotency-Key': p.key('recv') });
    const balance = () => p.q(db => db.inventoryBalance.findMany({ where: { workspaceId: p.f.workspaceId, warehouseId: c(p).warehouse.id } }));
    const before = (await balance()).map(b => b.onHand.toFixed(6)).join();
    const inspected = await p.req('owner', 'POST', `${C}/returns/${id}/inspect`, { dispositions: [{ orderLineId: line.itemId, disposition: 'DAMAGED' }] }, { 'Idempotency-Key': p.key('inspect') });
    p.ok('damaged disposition recorded', inspected);
    p.check('sellable stock unchanged (NO_RESTOCK)', (await balance()).map(b => b.onHand.toFixed(6)).join() === before);
    p.check('no CUSTOMER_RETURN_IN movement posted', (await p.q(db => db.inventoryMovement.count({ where: { workspaceId: p.f.workspaceId, type: 'CUSTOMER_RETURN_IN' } }))) === 0);
  },
  async '09-returns-and-refunds::AC03'(p) {
    const { paymentCommandFixture } = await import('../payment-command-fixture');
    const { CommercePaymentCallbackService } = await import('../../../src/server/commerce/payment-callback-service');
    const { CommerceRefundService } = await import('../../../src/server/commerce/refund-service');
    const { resolvePrincipal } = await import('../../../src/server/process-platform/context');
    const f = await paymentCommandFixture(p.db), callbacks = new CommercePaymentCallbackService(p.db, undefined, f.authority), refunds = new CommerceRefundService(p.db, undefined, f.authority);
    const secret = JSON.parse(f.secrets.get('test-payment-bundle')!).webhookSecret as string;
    const deliver = async (event: unknown) => {
      const raw = JSON.stringify(event), at = Math.floor(Date.now() / 1000);
      const ack = await p.call(() => callbacks.receive('stripe', new Headers({ 'x-payment-connection-id': f.connection.id, 'stripe-signature': 't=' + at + ',v1=' + createHmac('sha256', secret).update(at + '.' + raw).digest('hex') }), raw));
      if (ack.ok) { await p.q(db => db.sharedPaymentProviderEvent.update({ where: { id: (ack.value as { eventId: string }).eventId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })); await p.call(() => callbacks.tick()); }
      return ack;
    };
    const payment = await f.service.create(f.actor, f.order.id, { methodId: f.method.id, amount: '100', mode: 'SALE' }, randomUUID()); await f.service.process(payment.commandId);
    const tx = ((await p.q(db => db.commercialPackRecord.findUniqueOrThrow({ where: { id: payment.paymentId } }))).data as { providerTransactionId: string }).providerTransactionId;
    f.provider.settle(tx, 'SUCCEEDED');
    await deliver({ id: 'evt_' + randomUUID(), created: Math.floor(Date.now() / 1000), account: 'merchant-test', type: 'payment_intent.succeeded', data: { object: { id: tx, object: 'payment_intent', status: 'succeeded', amount: 10000, amount_received: 10000, amount_capturable: 0, currency: 'egp' } } });
    const approverUser = await p.q(db => db.user.create({ data: { firstName: 'Finance', lastName: 'Approver', email: randomUUID() + '@example.test', status: 'ACTIVE' } }));
    await p.q(db => db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: approverUser.id, roleId: f.role.id } }));
    const approver = await resolvePrincipal(p.db, f.workspace.id, approverUser.id);
    const refund = await refunds.create(f.actor, f.order.id, { paymentId: payment.paymentId, amount: '25', reason: 'Customer refund' }, randomUUID());
    const approved = await refunds.approve(approver, refund.id, { expectedVersion: refund.version, decision: 'APPROVE', reason: 'Verified' });
    const ack = await refunds.process(f.actor, approved.id, { expectedVersion: approved.version }, randomUUID()) as { jobId: string };
    await p.call(() => refunds.processCommand(ack.jobId));
    const effect = f.provider.refundEffects.get('refund-command:' + ack.jobId);
    const event = { id: 'evt_' + randomUUID(), created: Math.floor(Date.now() / 1000), account: 'merchant-test', type: 'refund.updated', request: { idempotency_key: 'refund-command:' + ack.jobId }, data: { object: { id: effect?.refundId ?? 're_' + ack.jobId, object: 'refund', payment_intent: tx, amount: 2500, currency: 'egp', status: 'succeeded', metadata: { truecrm_refund_id: refund.id } } } };
    const first = await deliver(event), replay = await deliver(event);
    p.check('refund callback accepted once', first.ok, first.ok ? undefined : first.code);
    p.check('replay flagged duplicate', replay.ok && (replay.value as { duplicate?: boolean }).duplicate === true, replay.ok ? replay.value : replay.code);
    p.check('provider refund executed once', f.provider.refundEffects.size === 1);
    const order = await p.q(db => db.commerceOrder.findUniqueOrThrow({ where: { id: f.order.id } }));
    p.check('order refunded exactly 25 once', order.refundedAmount.toFixed(2) === '25.00', order.refundedAmount.toFixed(6));
  },
  // ------------------------------------------------------------ 10 promotions, taxes, delivery
  async '10-promotions-taxes-and-delivery::AC01'(p) {
    const { couponHash } = await import('../../../src/server/commerce/pricing-policy-service');
    const rule = await p.q(db => db.commerceDiscountRule.create({ data: { workspaceId: p.f.workspaceId, storeId: c(p).store.id, code: 'ONCE', name: 'Single use', kind: 'PERCENT', value: '50', eligibility: { customerKind: 'ANY' } } }));
    const coupon = await p.q(db => db.commerceCoupon.create({ data: { workspaceId: p.f.workspaceId, storeId: c(p).store.id, ruleId: rule.id, codeHash: couponHash(c(p).store.id, 'ONCE'), usageLimit: 1 } }));
    const a = await c(p).session([{ productId: c(p).service.id, qty: '1' }], 'test@example.test', { couponCodes: ['ONCE'] });
    const b = await c(p).session([{ productId: c(p).service.id, qty: '1' }], 'test@example.test', { couponCodes: ['ONCE'] });
    const results = await Promise.all([confirm(p, a, p.key('coupon-a')), confirm(p, b, p.key('coupon-b'))]);
    p.check('exactly one checkout redeems the last coupon use', results.filter(r => r.status < 300).length === 1, results.map(r => r.status));
    p.check('single redemption persisted', (await p.q(db => db.commerceDiscountRedemption.count({ where: { couponId: coupon.id } }))) === 1);
  },
  async '10-promotions-taxes-and-delivery::AC02'(p) {
    const s = await c(p).session([{ productId: c(p).service.id, qty: '2' }, { productId: c(p).stock.id, qty: '1' }]);
    const quote = () => p.req('guest', 'POST', `/api/v1/public/checkout-sessions/${s.sessionId}/quote`, { paymentMethodId: 'OFFLINE' }, { 'x-checkout-token': s.token });
    const a = await quote(), b = await quote();
    p.ok('first quote', a); p.ok('second quote', b);
    p.check('server-side totals are reproducible', a.body.data?.total === b.body.data?.total && a.body.data?.tax === b.body.data?.tax && a.body.data?.quoteHash === b.body.data?.quoteHash, [a.body.data?.total, b.body.data?.total]);
    const session = await p.q(db => db.commerceCheckoutSession.findUniqueOrThrow({ where: { id: s.sessionId } }));
    p.check('quote persisted on the checkout session', session.quoteHash === a.body.data?.quoteHash);
  },
  async '10-promotions-taxes-and-delivery::AC03'(p) {
    const before = await orderRow(p, p.ids.pendingOrderId);
    const created = await p.req('owner', 'POST', `${C}/stores/${c(p).store.id}/tax-rules`, { region: 'EG', rate: '14', priceBasis: 'EXCLUSIVE', effectiveFrom: new Date().toISOString() });
    p.ok('new tax rate configured', created);
    const after = await orderRow(p, p.ids.pendingOrderId);
    p.check('historic order total unchanged', after.total.equals(before.total) && JSON.stringify(after.snapshot) === JSON.stringify(before.snapshot));
  },
  // ------------------------------------------------------------ 11 CRM links
  async '11-crm-sales-links::AC01'(p) {
    const second = await c(p).order([{ productId: c(p).service.id, qty: '1' }], 'pending@example.test');
    const { CommerceCrmSyncService } = await import('../../../src/server/commerce/crm-sync-service');
    const sync = new CommerceCrmSyncService(p.db);
    for (const id of [p.ids.pendingOrderId, second.orderId]) await p.req('owner', 'POST', `${C}/orders/${id}/crm-sync`, {}, { 'Idempotency-Key': p.key('crm') });
    await p.call(() => sync.tick(20));
    const bindings = await p.q(db => db.commerceCrmBinding.findMany({ where: { workspaceId: p.f.workspaceId, orderId: { in: [p.ids.pendingOrderId, second.orderId] }, entityType: 'CONTACT' } }));
    const contacts = new Set(bindings.map(b => b.targetId));
    p.check('both orders linked to one customer Contact', bindings.length === 2 && contacts.size === 1, bindings.map(b => b.targetId));
    if (contacts.size !== 1) return;
    const res = await p.req('owner', 'GET', `/api/v1/crm/contacts/${[...contacts][0]}/commerce/orders`);
    p.ok('contact order list readable', res);
    p.check('contact shows multiple orders with optional (absent) deals', Array.isArray(res.body.data) && res.body.data.length === 2 && res.body.data.every((o: { dealId: string | null; orderId: string }) => o.dealId !== o.orderId));
  },
  async '11-crm-sales-links::AC02'(p) {
    const requested = await p.req('owner', 'POST', `${C}/orders/${p.ids.orderWithCrmOutageId}/crm-sync`, {}, { 'Idempotency-Key': p.key('crm') });
    p.ok('sync requested', requested);
    const row = await p.q(db => db.commerceCrmSync.findFirstOrThrow({ where: { orderId: p.ids.orderWithCrmOutageId } }));
    // CRM outage: the integration attempt failed; the order must survive and the failure must be retryable.
    await p.q(db => db.commerceCrmSync.update({ where: { id: row.id }, data: { status: 'FAILED', errorCode: 'CRM_UNAVAILABLE' } }));
    const failures = await p.req('owner', 'GET', `${C}/sync/failures`);
    p.check('failure is visible to operators', JSON.stringify(failures.body.data ?? []).includes(row.id));
    const retry = await p.req('owner', 'POST', `${C}/sync/retry/${row.id}`, {});
    p.ok('retry queued', retry);
    p.check('order preserved', (await p.obs('orders', { id: p.ids.orderWithCrmOutageId })).length === 1);
    p.check('sync re-queued', (await p.q(db => db.commerceCrmSync.findUniqueOrThrow({ where: { id: row.id } }))).status === 'QUEUED');
  },
  async '11-crm-sales-links::AC03'(p) {
    const res = await p.req('employee', 'POST', `${C}/conversations/${randomUUID()}/payment-links`, {});
    p.status('agent without permissions denied', res, [403, 404]);
    p.check('no checkout link created', (await p.q(db => db.commerceCheckoutLink.count({ where: { workspaceId: p.f.workspaceId } }))) === 0);
  },
  // ------------------------------------------------------------ 12 reports & lifecycle
  async '12-commerce-reports-and-lifecycle::AC01'(p) {
    await p.call(() => c(p).pay(p.ids.pendingOrderId));
    const res = await p.req('owner', 'GET', `${C}/reports/revenue?storeId=${c(p).store.id}`);
    p.ok('revenue report', res);
    const orders = await p.q(db => db.commerceOrder.findMany({ where: { workspaceId: p.f.workspaceId, storeId: c(p).store.id } }));
    const paid = orders.reduce((s, o) => s + Number(o.paidAmount), 0), refunded = orders.reduce((s, o) => s + Number(o.refundedAmount), 0);
    const egp = (res.body.data?.totals ?? []).find((t: { currency: string }) => t.currency === 'EGP');
    p.check('net paid reconciles with the payment/refund projection', egp && Math.abs(Number(egp.netPaid) - paid) < 0.0001 && Math.abs(Number(egp.refundedAmount) - refunded) < 0.0001, { report: egp, paid, refunded });
  },
  async '12-commerce-reports-and-lifecycle::AC02'(p) {
    const ws = await p.q(db => db.workspace.findUniqueOrThrow({ where: { id: p.f.workspaceId } }));
    await p.q(db => db.workspace.update({ where: { id: ws.id }, data: { settings: { ...(ws.settings as object), entitlements: { commerceCheckout: false } } } }));
    const blocked = await confirm(p, p.x.main, p.key('downgrade'));
    p.status('new checkout blocked after downgrade', blocked, [403, 409]);
    p.ok('existing order still readable', await p.req('owner', 'GET', `${C}/orders/${p.ids.pendingOrderId}`));
    p.check('existing order preserved', (await p.obs('orders', { id: p.ids.pendingOrderId })).length === 1);
  },
  async '12-commerce-reports-and-lifecycle::AC03'(p) {
    const res = await p.req('employee', 'GET', `${C}/reports/revenue`);
    p.status('revenue report denied without permission', res, [403]);
    p.check('denial audited nothing as exported', (await p.q(db => db.auditLog.count({ where: { workspaceId: p.f.workspaceId, action: { contains: 'EXPORT' } } }))) === 0);
  },
  // ------------------------------------------------------------ 13 digital goods & services
  async '13-digital-goods-and-service-fulfillment::AC01'(p) {
    const placed = await c(p).order([{ productId: c(p).service.id, qty: '1' }], 'digital@example.test');
    await p.call(() => c(p).pay(placed.orderId));
    const [line] = await lines(p, placed.orderId);
    const granted = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/digital-fulfillment`, { items: [{ orderLineId: line.itemId, licenseReference: 'LIC-' + randomUUID().slice(0, 8) }] });
    p.ok('digital access granted after payment', granted);
    const deliveryId = granted.body.data?.[0]?.id as string, session = await guestSession(p, placed.orderId), auth = { authorization: 'Bearer ' + session };
    const download = async () => { const t = await p.req('guest', 'POST', `/api/v1/public/digital-deliveries/${deliveryId}/token`, {}, auth); return p.req('guest', 'GET', `/api/v1/public/digital-deliveries/${deliveryId}/download?token=${t.body.data?.token}`); };
    p.ok('first download allowed', await download()); p.ok('second download allowed', await download());
    const third = await download();
    p.status('download limit enforced', third, [410]);
    p.check('download count bounded', (await p.q(db => db.commerceDigitalDelivery.findUniqueOrThrow({ where: { id: deliveryId } }))).downloadCount === 2);
  },
  async '13-digital-goods-and-service-fulfillment::AC02'(p) {
    await moreStock(p, c(p).stock.id, '1');
    const placed = await c(p).order([{ productId: c(p).stock.id, qty: '1' }, { productId: c(p).service.id, qty: '1' }], 'mixed@example.test');
    await p.call(() => c(p).pay(placed.orderId));
    const all = await lines(p, placed.orderId), physical = all.find(l => l.stockable)!, digital = all.find(l => !l.stockable)!;
    const wrong = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/digital-fulfillment`, { items: [{ orderLineId: physical.itemId, licenseReference: 'X' }] });
    p.status('stock-managed line cannot be delivered digitally', wrong, [400]);
    const service = await deliveryService(p);
    const shipNonStock = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/shipments`, { warehouseId: c(p).warehouse.id, deliveryServiceId: service, items: [{ orderLineId: digital.itemId, quantity: '1' }] }, { 'Idempotency-Key': p.key('ship') });
    p.status('non-physical line is not shipped', shipNonStock, [400, 409, 422]);
    await shipment(p, placed.orderId, physical.itemId, '1', service);
    const items = await p.q(db => db.commerceShipmentItem.findMany({ where: { orderId: placed.orderId } }));
    p.check('shipment contains only the physical line', items.length === 1 && items[0].orderLineId === physical.itemId);
  },
  async '13-digital-goods-and-service-fulfillment::AC03'(p) {
    const placed = await c(p).order([{ productId: c(p).service.id, qty: '1' }], 'refund-digital@example.test');
    await p.call(() => c(p).pay(placed.orderId));
    const [line] = await lines(p, placed.orderId);
    const granted = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/digital-fulfillment`, { items: [{ orderLineId: line.itemId, licenseReference: 'LIC-R' }] });
    const early = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/digital-revoke`, { reason: 'Not refunded yet' });
    p.status('revocation follows a refund only', early, [409]);
    await p.q(db => db.commerceOrder.update({ where: { id: placed.orderId }, data: { paymentStatus: 'REFUNDED' } }).catch(() => null));
    const revoked = await p.req('owner', 'POST', `${C}/orders/${placed.orderId}/digital-revoke`, { reason: 'Refunded' });
    p.ok('configured policy (revokeOnRefund) revokes future access', revoked);
    const row = await p.q(db => db.commerceDigitalDelivery.findUniqueOrThrow({ where: { id: granted.body.data?.[0]?.id } }));
    p.check('access revoked while delivery history is kept', row.accessState === 'REVOKED' && row.revokedAt !== null);
  },
};
