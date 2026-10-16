import { randomUUID } from 'node:crypto';
import type { Principal } from '../../../src/server/process-platform/context';
import { createWorld, type Fixture, type World } from './world';

export type Seeded = { world: World; fixture: Fixture; extra: Record<string, any> };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export function nextWeekday(fromDays = 1) { const d = new Date(Date.now() + fromDays * 86400000); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return ymd(d); }

// ---------------------------------------------------------------- Commerce
export async function commerceWorld(world: World, options: { backorders?: boolean; portal?: boolean } = {}) {
  const db = world.db, owner = await world.principal('owner'), ws = world.a.id;
  const { InventoryDocumentService } = await import('../../../src/server/inventory/document-service');
  const { CommerceCartService } = await import('../../../src/server/commerce/cart-service');
  const { CommerceCheckoutService } = await import('../../../src/server/commerce/checkout-service');
  const { CommerceOrderService } = await import('../../../src/server/commerce/order-service');
  const suffix = randomUUID().slice(0, 6);
  const catalog = await db.catalog.create({ data: { workspaceId: ws, code: 'CAT', name: 'Catalog ' + suffix, normalizedName: 'catalog ' + suffix } });
  const priceType = await db.catalogPriceType.create({ data: { workspaceId: ws, code: 'RETAIL', name: 'Retail' } });
  const unit = await db.catalogUnit.create({ data: { workspaceId: ws, name: 'Each', code: 'EA' + suffix.slice(0, 3).toUpperCase(), precision: 0 } });
  const product = async (name: string, type: 'SIMPLE_PRODUCT' | 'SERVICE', amount: string) => {
    const p = await db.catalogProduct.create({ data: { workspaceId: ws, catalogId: catalog.id, type, name, ...(type === 'SIMPLE_PRODUCT' ? { sku: name.toUpperCase() + suffix, skuKey: name.toLowerCase() + suffix, primaryUnitId: unit.id } : {}) } });
    const price = await db.catalogProductPrice.create({ data: { workspaceId: ws, productId: p.id, priceTypeId: priceType.id, amount, currency: 'EGP' } });
    return { ...p, price };
  };
  const stock = await product('Widget', 'SIMPLE_PRODUCT', '100'), race = await product('Race', 'SIMPLE_PRODUCT', '40'), late = await product('Late', 'SIMPLE_PRODUCT', '30'), service = await product('Setup', 'SERVICE', '50');
  const documents = new InventoryDocumentService(db);
  const warehouse = await documents.warehouses.create(owner, { name: 'Main ' + suffix, code: 'WH_' + suffix.toUpperCase(), type: 'PHYSICAL', timezone: 'Africa/Cairo' });
  const receive = async (productId: string, quantity: string) => {
    const receipt = await documents.create(owner, { documentType: 'STOCK_RECEIPT', warehouseIds: { destination: warehouse.id }, currency: 'EGP' });
    const line = await documents.line(owner, receipt.id, { productId, quantity, unitCost: '10' }) as { documentVersion: string };
    await documents.process(owner, receipt.id, { expectedVersion: line.documentVersion }, randomUUID());
  };
  await receive(stock.id, '2'); await receive(race.id, '1'); await receive(late.id, '1');
  if (options.backorders) await db.inventorySettings.update({ where: { workspaceId: ws }, data: { allowBackorderReservations: false } });
  const store = await db.commerceStore.create({ data: { workspaceId: ws, code: 'STORE_' + suffix.toUpperCase(), name: 'North Store', catalogId: catalog.id, priceTypeId: priceType.id, defaultCurrency: 'EGP', timezone: 'Africa/Cairo',
    defaultWarehouseId: warehouse.id, dealCreationPolicy: 'NEVER', createdByUserId: world.users.owner.id, status: 'ACTIVE',
    settings: { paymentMethods: ['OFFLINE', 'COD'], deliveryPolicy: 'PICKUP', inventoryPrincipalUserId: world.users.owner.id, returnPolicy: { enabled: true, windowDays: 30 }, refundPolicy: { allowWithoutReturn: true, approvalThreshold: '100000' } } } });
  const slug = 'north-' + suffix;
  await db.commerceStoreProfile.create({ data: { storeId: store.id, workspaceId: ws, slug, reservationTtlSeconds: 1800, retentionConfigured: true, portalEnabled: options.portal ?? true, backordersEnabled: options.backorders ?? false, allowedReturnHosts: ['shop.example.test'], digitalAccessPolicy: { downloadLimit: 2, accessDays: 7, revokeOnRefund: true } } });
  await db.commerceTaxRule.create({ data: { workspaceId: ws, storeId: store.id, region: '*', rate: '0', priceBasis: 'EXCLUSIVE', effectiveFrom: new Date(Date.now() - 86400000) } });
  const front = await db.commerceStorefront.create({ data: { workspaceId: ws, storeId: store.id, type: 'WEB', slug, status: 'PUBLISHED', publishedAt: new Date() } });
  const publications: Record<string, string> = {};
  for (const p of [stock, race, late, service]) publications[p.id] = (await db.commerceProductPublication.create({ data: { workspaceId: ws, storeId: store.id, productId: p.id, inventoryKey: p.id, seoSlug: p.name.toLowerCase() + '-' + suffix, published: true, createdByUserId: world.users.owner.id } })).id;
  const carts = new CommerceCartService(db), checkout = new CommerceCheckoutService(db, carts), orders = new CommerceOrderService(db);
  const { resetRateLimits } = await import('../../../src/server/rate-limit');
  const session = async (lines: { productId: string; qty: string }[], email = 'buyer@example.test', opts: { paymentMethodId?: string; couponCodes?: string[] } = {}) => {
    resetRateLimits();
    const cart = await carts.create(slug, {}, randomUUID());
    for (const l of lines) await carts.mutate(slug, cart.cartToken, { productId: l.productId, quantity: l.qty }, 'ADD');
    const created = await checkout.create(slug, { cartToken: cart.cartToken, customerInfo: { name: 'Fixture Buyer', email }, shippingInfo: { country: 'EG', region: 'EG-C', city: 'Cairo', line1: '1 Nile St' }, payerType: 'PERSON' });
    const quote = await checkout.quote(slug, created.id, created.checkoutSessionToken, { paymentMethodId: opts.paymentMethodId ?? 'OFFLINE', ...(opts.couponCodes ? { couponCodes: opts.couponCodes } : {}) }) as { quoteHash: string; total: string; lines: { itemId: string; productId: string }[] };
    return { sessionId: created.id, token: created.checkoutSessionToken, quoteHash: quote.quoteHash, cartToken: cart.cartToken, total: quote.total, lines: quote.lines };
  };
  const order = async (lines: { productId: string; qty: string }[], email?: string, opts: { paymentMethodId?: string; couponCodes?: string[] } = {}) => {
    const s = await session(lines, email, opts);
    const placed = await checkout.place(slug, s.sessionId, s.token, { quoteHash: s.quoteHash, consents: [{ kind: 'TERMS', version: '1', accepted: true }, { kind: 'PRIVACY', version: '1', accepted: true }] }, 'fixture-' + randomUUID()) as { orderId: string };
    return { ...s, orderId: placed.orderId };
  };
  /** Shared Payments truth: a settled payment record allocated to the Order, projected by the owning Order service. */
  const pay = async (orderId: string, amount?: string, eventId = 'evt-' + randomUUID()) => {
    const row = await db.commerceOrder.findUniqueOrThrow({ where: { id: orderId } }), value = amount ?? row.total.toFixed(6), id = randomUUID();
    await db.commercialPackRecord.create({ data: { id, workspaceId: ws, collection: 'payments', data: { id, workspaceId: ws, amount: value, currencyCode: 'EGP', settlementStatus: 'SUCCEEDED', responsibleUserId: world.users.owner.id, methodType: 'MANUAL' } } });
    await db.commerceOrderPaymentBinding.create({ data: { workspaceId: ws, storeId: store.id, orderId, paymentId: id, amount: value } });
    await db.$transaction(tx => orders.refreshPaymentProjection(tx, owner, orderId, eventId), { timeout: 60000 });
    return id;
  };
  return { catalog, priceType, unit, stock, race, late, service, warehouse, store, front, slug, publications, carts, checkout, orders, session, order, pay, receive, documents, owner };
}

export async function seedCommerce(): Promise<Seeded> {
  const { database } = await import('./world');
  const world = await createWorld(await database()), db = world.db;
  const c = await commerceWorld(world);
  const owner = await world.principal('owner');
  const main = await c.session([{ productId: c.stock.id, qty: '1' }]);
  const raceA = await c.session([{ productId: c.race.id, qty: '1' }], 'test@example.test'), raceB = await c.session([{ productId: c.race.id, qty: '1' }], 'test@example.test');
  const pending = await c.order([{ productId: c.stock.id, qty: '1' }], 'pending@example.test');
  // Late payment: reservation released (expired), the last unit sold to another order, then a verified settlement arrives.
  const late = await c.order([{ productId: c.late.id, qty: '1' }], 'late@example.test');
  const { InventoryReservationService } = await import('../../../src/server/inventory/reservation-service');
  const reservations = new InventoryReservationService(db);
  for (const r of await db.inventoryReservation.findMany({ where: { workspaceId: world.a.id, sourceId: late.orderId } })) await reservations.release(owner, r.id, { reason: 'Reservation TTL expired' }, randomUUID());
  await c.order([{ productId: c.late.id, qty: '1' }], 'other@example.test');
  await c.pay(late.orderId);
  const foreignOrder = await db.commerceOrder.create({ data: { workspaceId: world.b.id, storeId: randomUUID(), cartId: randomUUID(), checkoutSessionId: randomUUID(), currency: 'EGP', total: '10', snapshot: { lines: [] }, consents: [] } });
  return { world, extra: { c, main, raceA, raceB, pending, late }, fixture: { workspaceId: world.a.id, otherWorkspaceId: world.b.id, tokens: {},
    metadata: { checkoutToken: main.token, sessionTokens: { [main.sessionId]: main.token, [raceA.sessionId]: raceA.token, [raceB.sessionId]: raceB.token } },
    ids: { checkoutSessionId: main.sessionId, cartId: main.cartToken, variantId: c.stock.id, paymentMethodId: 'OFFLINE', deliveryMethodId: 'PICKUP', storeSlug: c.slug, storeId: c.store.id,
      foreignOrderId: foreignOrder.id, pendingOrderId: pending.orderId, orderId: pending.orderId, latePaidOrderId: late.orderId, orderWithCrmOutageId: pending.orderId,
      stockRaceSessionA: raceA.sessionId, stockRaceSessionB: raceB.sessionId, raceVariantId: c.race.id, paymentWebhookConnection: randomUUID() } } };
}
/** Guest-confirm helper: each race session uses its own checkout token. */
export function sessionTokens(seeded: Seeded): Record<string, string> {
  const e = seeded.extra; return { [e.main.sessionId]: e.main.token, [e.raceA.sessionId]: e.raceA.token, [e.raceB.sessionId]: e.raceB.token };
}

// ---------------------------------------------------------------- Marketing
export async function marketingWorld(world: World) {
  const db = world.db, marketer = await world.principal('marketer'), owner = await world.principal('owner'), ws = world.a.id;
  const { marketingAudiences, marketingConsent, marketingChannels, marketingCampaigns } = await import('../../../src/server/marketing/routes');
  await marketingConsent.policy(marketer, { jurisdiction: 'DEFAULT', channel: 'EMAIL', purpose: 'MARKETING', consentRequired: true });
  await marketingConsent.policy(marketer, { jurisdiction: 'DEFAULT', channel: 'EMAIL', purpose: 'ADVERTISING', consentRequired: true });
  const connection = await marketingChannels.connect(marketer, { provider: 'SANDBOX', channel: 'EMAIL', ownership: 'WORKSPACE', credentialSecretRef: 'env:SANDBOX_PROVIDER', webhookSecretRef: 'env:SANDBOX_WEBHOOK' }) as { id: string };
  process.env.SANDBOX_WEBHOOK ??= 'sandbox-webhook-secret';
  const sender = await marketingChannels.createSender(marketer, { channel: 'EMAIL', displayName: 'News', address: 'news@sender.example.test', providerConnectionId: connection.id }) as { id: string; verificationChallenge: string };
  await marketingChannels.verifySender(marketer, sender.id, { challenge: sender.verificationChallenge });
  const template = await marketingChannels.createTemplate(marketer, { channel: 'EMAIL', name: 'Promo' });
  const v1 = await marketingChannels.createVersion(marketer, template.id, { subject: 'Hello {{firstName}}', bodyText: 'Hi {{firstName}}, see our offer. {{unsubscribeUrl}}', variableSchema: { firstName: { required: true, fallback: 'there' } } });
  await marketingChannels.approveVersion(owner, template.id, String(v1.versionNo));
  const contact = async (email: string, consent = true) => {
    const row = await db.crmContact.create({ data: { workspaceId: ws, firstName: 'Recipient', lastName: email.split('@')[0], displayName: 'Recipient ' + email, responsibleUserId: world.users.owner.id } });
    await db.crmContactCommunication.create({ data: { workspaceId: ws, contactId: row.id, type: 'EMAIL', value: email, normalizedValue: email, isPrimary: true } });
    if (consent) await marketingConsent.record(marketer, { subject: { destination: email, subjectRef: 'CONTACT:' + row.id }, channel: 'EMAIL', purpose: 'MARKETING', lawfulBasis: 'CONSENT', source: 'WEB_FORM', jurisdiction: 'DEFAULT' });
    return row;
  };
  const segment = async (contactIds: string[]) => {
    const s = await marketingAudiences.createSegment(marketer, { name: 'Static ' + randomUUID().slice(0, 4), kind: 'STATIC', channel: 'EMAIL' });
    if (contactIds.length) await marketingAudiences.members(marketer, s.id, { contactIds }, 'ADD');
    return s;
  };
  /** Submitted by the marketer, approved by a separate approver (separation of duties). */
  const approvedCampaign = async (segmentId: string, templateVersionId = v1.id) => {
    const created = await marketingCampaigns.create(marketer, { name: 'Campaign ' + randomUUID().slice(0, 4), channel: 'EMAIL', segmentId, senderIdentityId: sender.id, templateVersionId });
    const submitted = await marketingCampaigns.submitApproval(marketer, created.id, { expectedVersion: created.version });
    const approved = await marketingCampaigns.approve(owner, created.id, { expectedVersion: submitted.version, revision: submitted.revision });
    return approved;
  };
  return { marketer, owner, connection, sender, template, v1, contact, segment, approvedCampaign };
}

export async function seedMarketing(): Promise<Seeded> {
  const { database } = await import('./world');
  const world = await createWorld(await database()), db = world.db;
  const m = await marketingWorld(world);
  const { destinationHash } = await import('../../../src/server/suite/kernel');
  const { MarketingConsentService } = await import('../../../src/server/marketing/consent-service');
  const { marketingChannels } = await import('../../../src/server/marketing/routes');
  const recipient = await m.contact('alice@example.test'), optedOut = await m.contact('bob@example.test');
  const hash = destinationHash('EMAIL', 'alice@example.test'), optedHash = destinationHash('EMAIL', 'bob@example.test');
  const segment = await m.segment([recipient.id, optedOut.id]);
  await db.$transaction(tx => MarketingConsentService.withdrawInTx(tx, world.a.id, optedHash, 'EMAIL', 'MARKETING', 'UNSUBSCRIBE_LINK'));
  const campaign = await m.approvedCampaign(segment.id), approvedCampaign = await m.approvedCampaign(segment.id);
  const optoutToken = await db.$transaction(tx => MarketingConsentService.issueOptout(tx, world.a.id, hash, 'EMAIL', campaign.id));
  const v2 = await marketingChannels.createVersion(m.marketer, m.template.id, { subject: 'Hello again', bodyText: 'New content {{unsubscribeUrl}}' });
  const outsider = await world.principal('outsider');
  const { marketingAudiences } = await import('../../../src/server/marketing/routes');
  const foreignSegment = await marketingAudiences.createSegment(outsider, { name: 'Foreign', kind: 'STATIC', channel: 'EMAIL' });
  const { sha256 } = await import('../../../src/server/suite/kernel');
  return { world, extra: { m, recipient, optedOut }, fixture: { workspaceId: world.a.id, otherWorkspaceId: world.b.id, tokens: {},
    metadata: { campaignVersion: campaign.version, approvedRevision: campaign.approvedRevision },
    ids: { campaignId: campaign.id, approvedCampaignId: approvedCampaign.id, segmentId: segment.id, foreignSegmentId: foreignSegment.id, recipientKey: sha256(campaign.id + ':' + hash), optoutToken,
      optedOutDestinationHash: optedHash, senderId: m.sender.id, templateId: m.template.id, newTemplateVersionId: v2.id, providerConnectionId: m.connection.id } } };
}

// ---------------------------------------------------------------- HR
export async function hrWorld(world: World) {
  const hr = await world.principal('hr'), owner = await world.principal('owner');
  const { hrPeople, hrSchedules, hrLeave } = await import('../../../src/server/hr/routes');
  const employee = await hrPeople.create(hr, { employeeNumber: 'E-' + randomUUID().slice(0, 6), displayName: 'Employee One', userId: world.users.employee.id, departmentId: world.department.id, timezone: 'Africa/Cairo', startDate: '2026-01-01', privateData: { phone: '+201000000001', salaryBand: 'B3', notes: 'confidential' } });
  const manager = await hrPeople.create(hr, { employeeNumber: 'M-' + randomUUID().slice(0, 6), displayName: 'Manager One', userId: world.users.manager.id, departmentId: world.department.id, timezone: 'Africa/Cairo', startDate: '2026-01-01' });
  for (const e of [employee, manager]) await hrPeople.activate(hr, e.id, { expectedVersion: e.version });
  await hrPeople.patch(hr, employee.id, { expectedVersion: employee.version + 1, managerEmployeeId: manager.id });
  const schedule = await hrSchedules.create(hr, { name: 'Office ' + randomUUID().slice(0, 4), type: 'FIXED', timezone: 'Africa/Cairo' });
  const windows = Object.fromEntries(['1', '2', '3', '4', '5'].map(d => [d, [{ start: '09:00', end: '17:00' }]]));
  const version = await hrSchedules.addVersion(hr, schedule.id, { effectiveFrom: '2026-01-01', rules: { windows, unpaidBreakMinutes: 60, restDays: [0, 6] } });
  for (const e of [employee, manager]) await hrSchedules.assign(hr, e.id, { scheduleVersionId: version.id, effectiveFrom: '2026-01-01' });
  const annual = await hrLeave.createType(hr, { name: 'Annual ' + randomUUID().slice(0, 4), unit: 'DAY', paid: true, requiresBalance: true, approvalChain: ['MANAGER'] });
  await hrLeave.createPolicy(hr, { leaveTypeId: annual.id, accrualRule: { frequency: 'NONE', units: '0' }, carryOverRule: { maxUnits: '0' }, effectiveFrom: '2026-01-01' });
  return { hr, owner, employee, manager, schedule, version, annual };
}

export async function seedHr(): Promise<Seeded> {
  const { database } = await import('./world');
  const world = await createWorld(await database());
  const h = await hrWorld(world);
  const { hrWorktime, hrTimesheets, hrLeave, hrPeople } = await import('../../../src/server/hr/routes');
  const employeeActor = await world.principal('employee'), managerActor = await world.principal('manager');
  const leaveDateA = nextWeekday(2);
  await hrLeave.adjust(h.hr, { employeeId: h.employee.id, leaveTypeId: h.annual.id, period: leaveDateA.slice(0, 4), units: '1', kind: 'ALLOCATION', note: 'Fixture allocation' }, 'alloc-' + randomUUID());
  const opened = await hrWorktime.clock(employeeActor, 'CLOCK_IN', { source: 'WEB' }, 'fixture-in-' + randomUUID(), '');
  await hrWorktime.clock(employeeActor, 'CLOCK_OUT', { source: 'WEB' }, 'fixture-out-' + randomUUID(), '');
  const sheet = await hrTimesheets.compile(employeeActor, { periodStart: '2026-02-02', periodEnd: '2026-02-06' });
  const submitted = await hrTimesheets.submit(employeeActor, sheet.id, { expectedVersion: sheet.version });
  const approved = await hrTimesheets.review(managerActor, sheet.id, { expectedVersion: submitted.version }, 'APPROVED');
  const locked = await hrTimesheets.review(managerActor, sheet.id, { expectedVersion: approved.version }, 'LOCKED');
  // Terminated employee with retained attendance evidence.
  const admin = await world.principal('admin');
  const leaver = await hrPeople.create(h.hr, { employeeNumber: 'T-' + randomUUID().slice(0, 6), displayName: 'Leaver', userId: world.users.admin.id, departmentId: world.otherDepartment.id, timezone: 'Africa/Cairo', startDate: '2026-01-01' });
  await hrPeople.activate(h.hr, leaver.id, { expectedVersion: leaver.version });
  await hrWorktime.clock(admin, 'CLOCK_IN', {}, 'leaver-in-' + randomUUID(), ''); await hrWorktime.clock(admin, 'CLOCK_OUT', {}, 'leaver-out-' + randomUUID(), '');
  await hrPeople.terminate(h.hr, leaver.id, { expectedVersion: leaver.version + 1, endDate: ymd(new Date()), reason: 'Contract ended' });
  const outsider = await world.principal('outsider');
  const foreign = await hrPeople.create(outsider, { employeeNumber: 'F-1', displayName: 'Foreign', timezone: 'UTC', startDate: '2026-01-01' });
  return { world, extra: { h, sheet: locked }, fixture: { workspaceId: world.a.id, otherWorkspaceId: world.b.id, tokens: {}, ids: { employeeId: h.employee.id, managerEmployeeId: h.manager.id, workSessionId: opened.id,
    correctedClockOutAt: new Date(Date.now() - 60000).toISOString(), lockedTimesheetId: locked.id, leaveTypeId: h.annual.id, leaveDateA, foreignEmployeeId: foreign.id, terminatedEmployeeId: leaver.id } } };
}

// ---------------------------------------------------------------- Sites
export async function sitesWorld(world: World) {
  const publisher = await world.principal('publisher'), owner = await world.principal('owner');
  const { sitesSites, sitesContent, sitesPublisher } = await import('../../../src/server/sites/routes');
  const { setDnsVerifier } = await import('../../../src/server/suite/providers');
  const site = await sitesSites.create(publisher, { name: 'Brand site', type: 'SITE', subdomain: 'brand-' + randomUUID().slice(0, 8), defaultLocale: 'en' });
  const page = await sitesContent.createPage(publisher, site.id, { slug: '', title: 'Home', blockTreeJson: { blocks: [{ type: 'headline', text: 'Live headline' }] } });
  const shared = await sitesContent.createSharedBlock(publisher, { name: 'Header', kind: 'headline', ownerSiteId: site.id, propsJson: { text: 'Header v1' } });
  await sitesContent.publishSharedBlock(publisher, shared.id, { revision: 1 });
  await sitesContent.createRevision(publisher, page.id, { blockTreeJson: { blocks: [{ type: 'shared', key: 'header', props: { sharedBlockId: shared.id } }, { type: 'headline', text: 'Live headline' }] } });
  const host = 'www-' + randomUUID().slice(0, 8) + '.example.test';
  const domain = await sitesSites.addDomain(publisher, site.id, { hostname: host, isPrimary: true }) as { id: string; dnsChallenge: { value: string } };
  setDnsVerifier({ txtRecords: async name => name === host ? [domain.dnsChallenge.value] : [] });
  await sitesSites.verifyDomain(publisher, domain.id);
  const publish = async () => {
    const release = await sitesPublisher.previewRelease(publisher, site.id);
    const current = await world.db.site.findUniqueOrThrow({ where: { id: site.id } });
    await sitesPublisher.publish(publisher, site.id, { releaseId: release.id, expectedSiteVersion: current.siteVersion }, 'pub-' + randomUUID());
    return release;
  };
  const live = await publish();
  return { publisher, owner, site, page, shared, host, domain, live, publish };
}

export async function seedSites(): Promise<Seeded> {
  const { database } = await import('./world');
  const world = await createWorld(await database()), db = world.db;
  const s = await sitesWorld(world);
  const { sitesContent, sitesPublisher, sitesSites } = await import('../../../src/server/sites/routes');
  await sitesContent.createRevision(s.publisher, s.page.id, { blockTreeJson: { blocks: [{ type: 'headline', text: 'Unpublished draft' }] } });
  const draft = await sitesPublisher.previewRelease(s.publisher, s.site.id);
  const preview = await sitesPublisher.previewLink(s.publisher, s.site.id, { releaseId: draft.id, expiresInMinutes: 5 });
  await sitesPublisher.revokePreview(s.publisher, s.site.id, preview.id);
  const outsider = await world.principal('outsider');
  const foreign = await sitesSites.create(outsider, { name: 'Foreign', type: 'SITE', subdomain: 'foreign-' + randomUUID().slice(0, 8), defaultLocale: 'en' });
  const foreignDomain = 'taken-' + randomUUID().slice(0, 8) + '.example.test';
  await sitesSites.addDomain(outsider, foreign.id, { hostname: foreignDomain });
  // A checkout session belonging to a suspended store: the Commerce block must never claim success.
  const store = await db.commerceStore.create({ data: { workspaceId: world.a.id, code: 'SUSP_' + randomUUID().slice(0, 6).toUpperCase(), name: 'Suspended', defaultCurrency: 'EGP', timezone: 'Africa/Cairo', catalogId: randomUUID(), createdByUserId: world.users.owner.id, status: 'SUSPENDED' } });
  const session = await db.commerceCheckoutSession.create({ data: { workspaceId: world.a.id, storeId: store.id, cartId: randomUUID(), tokenHash: randomUUID(), customerSnapshot: {}, addressSnapshot: {}, payerType: 'PERSON', expiresAt: new Date(Date.now() + 3600000) } });
  return { world, extra: { s, draft }, fixture: { workspaceId: world.a.id, otherWorkspaceId: world.b.id, tokens: {}, publicHost: s.host,
    ids: { siteId: s.site.id, pageId: s.page.id, releaseId: s.live.id, draftReleaseId: draft.id, foreignSiteId: foreign.id, sharedBlockId: s.shared.id, previewToken: preview.token, expiredPreviewToken: preview.token, foreignDomain, unavailableCheckoutSessionId: session.id } } };
}

export const seeders: Record<string, () => Promise<Seeded>> = { commerce_checkout: seedCommerce, marketing_campaign: seedMarketing, hr_attendance: seedHr, sites_publication: seedSites };
export type { Principal };
