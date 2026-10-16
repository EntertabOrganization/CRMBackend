import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { checkRateLimit } from '../rate-limit';
import { hydrateState } from '../persistence';
import { allocate, assertAllocation, assertNoExecutable, inTx, notFound, safeUrl, sha256, systemEvent } from '../suite/kernel';
import { aiGateway } from '../suite/providers';
import { BLOCK_DEFINITIONS, contentHash, isRtl, loadSite, locale, validateBlockTree } from './support';
import { SitesContentService } from './content-service';
import { SitesPublishService } from './publish-service';
import { CommercePublicationService } from '../commerce/publication-service';

const CATEGORIES = ['NECESSARY', 'ANALYTICS', 'MARKETING', 'CUSTOM'] as const;
const FORBIDDEN_JS = [/\beval\s*\(/, /new\s+Function\s*\(/, /document\.cookie/, /localStorage|sessionStorage/, /indexedDB/, /XMLHttpRequest/, /\bimport\s*\(/, /importScripts/, /\.innerHTML\s*=/, /document\.write/, /Authorization|Bearer\s/i, /\/api\/v1\//, /postMessage\([^)]*\*\s*\)/];

/** Localization (05), SEO/performance (06), module bindings (07), cookies & scripts (08), experiments (09), AI drafts (10). */
export class SitesExperienceService {
  constructor(private readonly db: PrismaClient, readonly content = new SitesContentService(db), readonly publisher = new SitesPublishService(db)) {}

  // ------------------------------------------------------------------ localization
  async addLanguage(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ locale, fallbackPolicy: z.enum(['DEFAULT_LANGUAGE', 'NOT_FOUND']).default('DEFAULT_LANGUAGE'), enabled: z.boolean().default(false) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.localization.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.localization.edit');
      if (await tx.siteLanguage.findUnique({ where: { siteId_locale: { siteId: site.id, locale: input.locale } } })) throw new AppError('ROUTE_COLLISION', 'Language already exists.', 409);
      if (input.enabled) requirePermission(actor, 'sites.localization.publish');
      const row = await tx.siteLanguage.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, ...input, rtl: isRtl(input.locale) } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_LANGUAGE_CHANGED', { locale: row.locale, enabled: row.enabled }); return row;
    });
  }
  async patchLanguage(actor: Principal, siteId: string, code: string, raw: unknown) {
    const input = parse(z.strictObject({ enabled: z.boolean().optional(), fallbackPolicy: z.enum(['DEFAULT_LANGUAGE', 'NOT_FOUND']).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, input.enabled !== undefined ? 'sites.localization.publish' : 'sites.localization.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.localization.edit');
      const row = await tx.siteLanguage.findUnique({ where: { siteId_locale: { siteId: site.id, locale: parse(locale, code) } } });
      if (!row) throw notFound('Language');
      if (row.isDefault && input.enabled === false) throw new AppError('INVALID_STATE_TRANSITION', 'The default language cannot be disabled.', 409);
      const updated = await tx.siteLanguage.update({ where: { id: row.id }, data: input });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_LANGUAGE_CHANGED', { locale: row.locale, ...input }); return updated;
    });
  }
  /** Creates a translation DRAFT page revision (manual copy or AI); always review-required, never auto-published. */
  async translate(actor: Principal, pageId: string, raw: unknown) {
    const input = parse(z.strictObject({ targetLocale: locale, useAi: z.boolean().default(false), slug: z.string().max(120).optional() }), raw);
    let aiTree: unknown = null, aiUsage: { modelId: string; inputTokens: number; outputTokens: number; costMicros: number } | null = null;
    const source = await inTx(this.db, actor, async (tx, actor) => { requirePermission(actor, 'sites.localization.edit'); const { page, site } = await this.content.page(tx, actor, pageId, 'sites.localization.edit'); return { page, site, revision: await this.content.latest(tx, page.id) }; });
    if (!source.revision) throw new AppError('INVALID_STATE_TRANSITION', 'Source page has no revision.', 409);
    if (input.useAi) {
      requirePermission(actor, 'sites.ai.generate');
      const result = await aiGateway().runScenario({ scenario: 'SITE_TRANSLATE', workspaceId: actor.workspaceId, prompt: JSON.stringify({ targetLocale: input.targetLocale, blocks: source.revision.blockTree }), allowedBlocks: Object.keys(BLOCK_DEFINITIONS) });
      aiTree = result.output; aiUsage = result;
    }
    return inTx(this.db, actor, async (tx, actor) => {
      const site = source.site;
      if (!await tx.siteLanguage.findUnique({ where: { siteId_locale: { siteId: site.id, locale: input.targetLocale } } })) throw new AppError('POLICY_NOT_CONFIGURED', 'Add the target language first.', 409);
      let target = await tx.sitePage.findFirst({ where: { siteId: site.id, locale: input.targetLocale, parentKey: source.page.parentKey, slug: input.slug ?? source.page.slug } });
      if (!target) target = await tx.sitePage.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, parentFolderId: source.page.parentFolderId, parentKey: source.page.parentKey, slug: input.slug ?? source.page.slug, type: source.page.type, locale: input.targetLocale, title: source.page.title, createdByUserId: actor.userId } });
      const tree = await validateBlockTree(tx, actor, aiTree ?? source.revision!.blockTree);
      const revision = await tx.sitePageRevision.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, pageId: target.id, locale: input.targetLocale, revision: target.latestRevision + 1, blockTree: tree as unknown as Prisma.InputJsonValue, seo: source.revision!.seo as Prisma.InputJsonValue, contentHash: contentHash(tree), origin: aiTree ? 'AI_TRANSLATION' : 'TRANSLATION', createdByUserId: actor.userId } });
      await tx.sitePage.update({ where: { id: target.id }, data: { latestRevision: revision.revision } });
      let aiDraftId: string | null = null;
      if (aiUsage) aiDraftId = (await tx.siteAiDraft.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, pageId: target.id, scenario: 'SITE_TRANSLATE', status: 'PENDING_REVIEW', generatedRevisionId: revision.id, modelId: aiUsage.modelId, inputTokens: aiUsage.inputTokens, outputTokens: aiUsage.outputTokens, costMicros: BigInt(aiUsage.costMicros), usageKey: 'translate:' + revision.id, billed: true, requestedByUserId: actor.userId } })).id;
      const row = await tx.siteTranslation.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, sourcePageId: source.page.id, targetPageId: target.id, sourceRevisionId: source.revision!.id, draftRevisionId: revision.id, sourceLocale: source.page.locale, targetLocale: input.targetLocale, aiDraftId, status: 'IN_REVIEW' } });
      await evidence(tx, actor, 'SITE', site.id, 'TRANSLATION_DRAFTED', { translationId: row.id, ai: Boolean(aiUsage) });
      return row;
    });
  }
  async reviewTranslation(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ decision: z.enum(['APPROVE', 'REJECT']) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.localization.approve');
      const row = await tx.siteTranslation.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Translation');
      await loadSite(tx, actor, row.siteId, 'sites.localization.approve');
      if (row.status !== 'IN_REVIEW') throw new AppError('INVALID_STATE_TRANSITION', `Translation is ${row.status}.`, 409);
      const revision = await tx.sitePageRevision.findUniqueOrThrow({ where: { id: row.draftRevisionId } });
      if (revision.createdByUserId === actor.userId && revision.origin === 'AI_TRANSLATION') throw new AppError('PERMISSION_DENIED', 'A different reviewer must approve AI translations.', 403);
      await tx.sitePageRevision.update({ where: { id: revision.id }, data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' } });
      const updated = await tx.siteTranslation.update({ where: { id: row.id }, data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewedByUserId: actor.userId } });
      if (row.aiDraftId) await tx.siteAiDraft.update({ where: { id: row.aiDraftId }, data: { status: input.decision === 'APPROVE' ? 'ACCEPTED' : 'REJECTED' } });
      await evidence(tx, actor, 'SITE', row.siteId, input.decision === 'APPROVE' ? 'TRANSLATION_APPROVED' : 'TRANSLATION_REJECTED', { translationId: row.id });
      return updated;
    });
  }
  async coverage(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.read');
      const [languages, pages] = await Promise.all([tx.siteLanguage.findMany({ where: { siteId: site.id } }), tx.sitePage.findMany({ where: { siteId: site.id, deletedAt: null } })]);
      const paths = [...new Set(pages.map(p => SitesContentService.path(p)))];
      return { siteId: site.id, languages: languages.map(l => ({ locale: l.locale, enabled: l.enabled, isDefault: l.isDefault, rtl: l.rtl, fallbackPolicy: l.fallbackPolicy,
        translated: paths.filter(path => pages.some(p => p.locale === l.locale && SitesContentService.path(p) === path)).length, total: paths.length,
        missing: paths.filter(path => !pages.some(p => p.locale === l.locale && SitesContentService.path(p) === path)) })) };
    });
  }

  // ------------------------------------------------------------------ SEO & performance
  async pageSeo(actor: Principal, pageId: string, raw: unknown) {
    const input = parse(z.strictObject({ title: z.string().max(70), metaDescription: z.string().max(320).optional(), canonicalUrl: z.string().max(2000).optional(), og: z.strictObject({ title: z.string().max(120).optional(), description: z.string().max(320).optional(), imageFileId: uuid.optional() }).optional(), indexability: z.enum(['INDEX', 'NOINDEX']).default('INDEX') }), raw);
    assertNoExecutable(input, 'seo'); if (input.canonicalUrl) safeUrl(input.canonicalUrl, false);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.seo.manage'); await lock(tx, actor.workspaceId, 'sites:page:' + pageId);
      const { page } = await this.content.page(tx, actor, pageId, 'sites.seo.manage');
      const latest = await this.content.latest(tx, page.id);
      const tree = (latest?.blockTree ?? { blocks: [] }) as Prisma.InputJsonValue;
      const revision = await tx.sitePageRevision.create({ data: { workspaceId: actor.workspaceId, siteId: page.siteId, pageId: page.id, locale: page.locale, revision: page.latestRevision + 1, blockTree: tree, seo: input, contentHash: contentHash({ tree, input }), createdByUserId: actor.userId } });
      await tx.sitePage.update({ where: { id: page.id }, data: { latestRevision: revision.revision } });
      await evidence(tx, actor, 'SITE', page.siteId, 'SEO_SETTINGS_CHANGED', { pageId: page.id, revision: revision.revision });
      return revision;
    });
  }
  async siteSeo(actor: Principal, siteId: string, raw?: unknown) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), raw === undefined ? 'sites.site.read' : 'sites.seo.manage');
      if (raw === undefined) return tx.siteSeoSettings.findUnique({ where: { siteId: site.id } });
      const input = parse(z.strictObject({ robotsDefault: z.enum(['index,follow', 'noindex,nofollow', 'index,nofollow']).optional(), sitemapEnabled: z.boolean().optional(), defaultOgImageFileId: uuid.nullable().optional() }), raw);
      const row = await tx.siteSeoSettings.update({ where: { siteId: site.id }, data: { ...input, version: { increment: 1 } } });
      await evidence(tx, actor, 'SITE', site.id, 'SEO_SETTINGS_CHANGED', { ...input }); return row;
    });
  }
  async rebuildSitemap(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.seo.manage');
      if (!site.activeReleaseId) throw new AppError('INVALID_STATE_TRANSITION', 'Site has no active release.', 409);
      const release = await tx.siteRelease.findUniqueOrThrow({ where: { id: site.activeReleaseId } });
      const row = await tx.siteSitemapBuild.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, releaseId: release.id, status: 'READY', content: await this.publisher.sitemapXml(tx, site, release.manifest as never) } });
      await evidence(tx, actor, 'SITE', site.id, 'SITEMAP_REBUILT', { buildId: row.id }); return { id: row.id, status: row.status, generatedAt: row.generatedAt };
    });
  }
  async performance(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.read');
      const rows = await tx.sitePerformanceMetric.findMany({ where: { siteId: site.id }, orderBy: { measuredAt: 'desc' }, take: 500 });
      const avg = (k: 'lcp' | 'cls' | 'ttfb') => { const v = rows.map(r => r[k]).filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      return { siteId: site.id, samples: rows.length, lcp: avg('lcp'), cls: avg('cls'), ttfb: avg('ttfb'), thresholds: { lcp: 2500, cls: 0.1, ttfb: 800 } };
    });
  }
  async recordPerformance(raw: unknown, client: string) {
    const input = parse(z.strictObject({ siteId: uuid, pageId: uuid, releaseId: uuid, lcp: z.number().min(0).max(120000).optional(), cls: z.number().min(0).max(10).optional(), ttfb: z.number().min(0).max(120000).optional() }), raw);
    checkRateLimit(client, { scope: 'sites.perf', limit: 60, windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const site = await tx.site.findUnique({ where: { id: input.siteId } });
      if (!site || site.activeReleaseId !== input.releaseId) throw notFound('Site');
      await tx.sitePerformanceMetric.create({ data: { workspaceId: site.workspaceId, ...input } });
      if ((input.lcp ?? 0) > 4000) await systemEvent(tx, site.workspaceId, 'SITE', site.id, 'SITE_PERFORMANCE_THRESHOLD_BREACHED', { pageId: input.pageId, metric: 'LCP' }, false);
      return { recorded: true };
    });
  }

  // ------------------------------------------------------------------ module bindings
  private async checkResource(tx: Tx, actor: Principal, module: string, id: string) {
    if (module === 'FORM') {
      requirePermission(actor, 'form.read');
      const state = await hydrateState(tx), form = (state.crmForms as { id: string; workspaceId: string; status: string; publicKey: string }[]).find(f => f.id === id && f.workspaceId === actor.workspaceId);
      if (!form) throw notFound('Form');
      return form.status === 'PUBLISHED' ? { status: 'ACTIVE', publicSettings: { publicKey: form.publicKey, submitPath: `/api/v1/public/forms/${form.publicKey}/submissions` } } : { status: 'BROKEN', publicSettings: {} };
    }
    if (module === 'CONTACT_WIDGET') {
      const state = await hydrateState(tx), channel = (state.communicationChannels as { id: string; workspaceId: string; status?: string }[]).find(c => c.id === id && c.workspaceId === actor.workspaceId);
      if (!channel) throw notFound('Contact channel');
      return { status: channel.status && channel.status !== 'ACTIVE' ? 'BROKEN' : 'ACTIVE', publicSettings: { channelId: channel.id } };
    }
    if (module === 'PRODUCT') {
      const publication = await tx.commerceProductPublication.findFirst({ where: { workspaceId: actor.workspaceId, id } });
      if (!publication) throw notFound('Store listing');
      const front = await tx.commerceStorefront.findFirst({ where: { workspaceId: actor.workspaceId, storeId: publication.storeId, status: 'PUBLISHED' } });
      return { status: publication.published && front ? 'ACTIVE' : 'BROKEN', publicSettings: { storeSlug: front?.slug ?? null, productSlug: publication.seoSlug } };
    }
    const store = await tx.commerceStore.findFirst({ where: { workspaceId: actor.workspaceId, id } });
    if (!store) throw notFound('Store');
    const front = await tx.commerceStorefront.findFirst({ where: { workspaceId: actor.workspaceId, storeId: store.id, status: 'PUBLISHED' } });
    return { status: store.status === 'ACTIVE' && front ? 'ACTIVE' : 'BROKEN', publicSettings: { storeSlug: front?.slug ?? null } };
  }
  async bind(actor: Principal, pageId: string, raw: unknown) {
    const input = parse(z.strictObject({ blockKey: z.string().regex(/^[a-z0-9-]{1,40}$/), module: z.enum(['FORM', 'CONTACT_WIDGET', 'PRODUCT', 'CART', 'CHECKOUT']), externalResourceId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.integration.bind');
      const { page, site } = await this.content.page(tx, actor, pageId, 'sites.page.edit');
      const resolved = await this.checkResource(tx, actor, input.module, input.externalResourceId); // same workspace + originating permission
      const row = await tx.siteModuleBinding.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, pageId: page.id, blockKey: input.blockKey, module: input.module, externalResourceId: input.externalResourceId, publicSettings: resolved.publicSettings, status: resolved.status, lastCheckedAt: new Date() } });
      await evidence(tx, actor, 'SITE', site.id, resolved.status === 'ACTIVE' ? 'SITE_MODULE_CONNECTED' : 'SITE_MODULE_BROKEN', { bindingId: row.id, module: row.module });
      return row;
    });
  }
  async patchBinding(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ status: z.enum(['ACTIVE', 'DISABLED']).optional(), externalResourceId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.integration.bind');
      const row = await tx.siteModuleBinding.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Binding');
      await loadSite(tx, actor, row.siteId, 'sites.page.edit');
      const resolved = await this.checkResource(tx, actor, row.module, input.externalResourceId ?? row.externalResourceId);
      const updated = await tx.siteModuleBinding.update({ where: { id: row.id }, data: { externalResourceId: input.externalResourceId ?? row.externalResourceId, status: input.status === 'DISABLED' ? 'DISABLED' : resolved.status, publicSettings: resolved.publicSettings, lastCheckedAt: new Date(), version: { increment: 1 } } });
      await evidence(tx, actor, 'SITE', row.siteId, 'SITE_MODULE_CHANGED', { bindingId: row.id, status: updated.status }); return updated;
    });
  }
  async readiness(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.read');
      const rows = await tx.siteModuleBinding.findMany({ where: { siteId: site.id } }), out = [];
      for (const b of rows) {
        let status = b.status;
        if (b.status !== 'DISABLED') try { status = (await this.checkResource(tx, actor, b.module, b.externalResourceId)).status; } catch (e) { if (!isAppError(e)) throw e; status = 'BROKEN'; }
        if (status !== b.status) { await tx.siteModuleBinding.update({ where: { id: b.id }, data: { status, lastCheckedAt: new Date() } }); if (status === 'BROKEN') await evidence(tx, actor, 'SITE', site.id, 'SITE_MODULE_BROKEN', { bindingId: b.id, module: b.module }); }
        out.push({ id: b.id, module: b.module, blockKey: b.blockKey, status });
      }
      return { siteId: site.id, bindings: out, ready: out.every(b => b.status !== 'BROKEN') };
    });
  }
  /** Public commerce block: live permitted Commerce data or an honest unavailable state. Never caches private pricing. */
  async commerceBlock(siteSlug: string, bindingId: string) {
    const site = await this.db.site.findUnique({ where: { subdomain: siteSlug } });
    const binding = site && await this.db.siteModuleBinding.findFirst({ where: { siteId: site.id, id: parse(uuid, bindingId), module: { in: ['PRODUCT', 'CART', 'CHECKOUT'] } } });
    if (!site || !binding || site.status !== 'PUBLISHED') throw notFound('Block');
    const ws = await this.db.workspace.findUnique({ where: { id: site.workspaceId } });
    const ent = ((ws?.settings as { entitlements?: Record<string, unknown> })?.entitlements ?? {});
    const settings = binding.publicSettings as { storeSlug?: string; productSlug?: string };
    const unavailable = (reason: string) => ({ bindingId, module: binding.module, state: 'UNAVAILABLE', reason, message: 'This item is currently unavailable.' });
    if (binding.status !== 'ACTIVE' || !settings.storeSlug) return unavailable('BINDING_NOT_ACTIVE');
    if (ent.commerce === false || ent.commerceCheckout === false) return binding.module === 'PRODUCT' ? { ...unavailable('CHECKOUT_DISABLED'), checkout: 'DISABLED' } : unavailable('CHECKOUT_DISABLED');
    if (binding.module !== 'PRODUCT') return { bindingId, module: binding.module, state: 'AVAILABLE', storeSlug: settings.storeSlug, checkoutApi: '/api/v1/public/checkout-sessions/:id/confirm', note: 'Success is shown only after Commerce confirms the order.' };
    try { return { bindingId, module: 'PRODUCT', state: 'AVAILABLE', product: await new CommercePublicationService(this.db).products(settings.storeSlug, {}, settings.productSlug) }; }
    catch (e) { if (isAppError(e)) return unavailable(e.status >= 500 ? 'DEPENDENCY_UNAVAILABLE' : 'NOT_PUBLISHED'); throw e; }
  }

  // ------------------------------------------------------------------ cookies, consent and scripts
  async cookiePolicy(actor: Principal, siteId: string, raw?: unknown) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), raw === undefined ? 'sites.site.read' : 'sites.script.manage');
      if (raw === undefined) return tx.siteCookiePolicy.findUnique({ where: { siteId: site.id } });
      const input = parse(z.strictObject({ categories: z.array(z.strictObject({ key: z.enum(CATEGORIES), description: z.string().max(500), isOptional: z.boolean() })).min(1).max(4), jurisdictionRules: z.record(z.string().regex(/^[A-Z]{2}|DEFAULT$/), z.strictObject({ optInRequired: z.boolean() })).default({ DEFAULT: { optInRequired: true } }) }), raw);
      if (!input.categories.some(c => c.key === 'NECESSARY' && !c.isOptional) || input.categories.some(c => c.key !== 'NECESSARY' && !c.isOptional)) throw new AppError('VALIDATION_FAILED', 'Only NECESSARY may be non-optional and it must be present.', 400);
      const row = await tx.siteCookiePolicy.update({ where: { siteId: site.id }, data: { categories: input.categories, jurisdictionRules: input.jurisdictionRules, version: { increment: 1 } } });
      await evidence(tx, actor, 'SITE', site.id, 'COOKIE_POLICY_CHANGED', { version: row.version }); return row;
    });
  }
  /** Public consent capture: pseudonymous visitor key, policy version, categories; independent of CRM marketing consent. */
  async consent(siteId: string, raw: unknown, client: string) {
    const input = parse(z.strictObject({ visitorKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), acceptedCategories: z.array(z.enum(CATEGORIES)).max(4), policyVersion: z.number().int().positive() }), raw);
    checkRateLimit(client, { scope: 'sites.consent', limit: 60, windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const site = await tx.site.findUnique({ where: { id: parse(uuid, siteId) } });
      const policy = site && await tx.siteCookiePolicy.findUnique({ where: { siteId: site.id } });
      if (!site || site.status !== 'PUBLISHED' || !policy) throw notFound('Site');
      if (policy.version !== input.policyVersion) throw new AppError('VERSION_CONFLICT', 'Consent policy changed; reload the banner.', 409);
      const accepted = [...new Set(['NECESSARY', ...input.acceptedCategories])];
      await tx.siteConsentPreference.create({ data: { workspaceId: site.workspaceId, siteId: site.id, visitorKey: sha256(input.visitorKey), consentVersion: policy.version, acceptedCategories: accepted } });
      await systemEvent(tx, site.workspaceId, 'SITE', site.id, 'SITE_CONSENT_CHANGED', { categories: accepted, policyVersion: policy.version }, false);
      return { acceptedCategories: accepted, policyVersion: policy.version };
    });
  }
  /** Custom CSS is sanitized; custom JS is reviewed, allowlisted and sandboxed; executable credential access is rejected. */
  async createScript(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ kind: z.enum(['INTEGRATION', 'CUSTOM']), language: z.enum(['CSS', 'JS']), source: z.string().min(1).max(100000), allowedCategory: z.enum(CATEGORIES), originAllowlist: z.array(z.url()).max(20).default([]) }), raw);
    if (input.language === 'CSS' && /expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding|<\s*\/?\s*style/i.test(input.source)) throw new AppError('VALIDATION_FAILED', 'CSS contains executable or import constructs.', 400, { fields: [{ field: 'source', reason: 'UNSAFE_CSS' }] });
    if (input.language === 'JS' && FORBIDDEN_JS.some(r => r.test(input.source))) throw new AppError('VALIDATION_FAILED', 'Script uses forbidden capabilities (credentials, storage, dynamic code or internal APIs).', 400, { fields: [{ field: 'source', reason: 'UNSAFE_SCRIPT' }] });
    for (const origin of input.originAllowlist) safeUrl(origin, false);
    if (input.language === 'JS' && input.allowedCategory === 'NECESSARY' && input.kind === 'CUSTOM') throw new AppError('VALIDATION_FAILED', 'Custom scripts must be consent-gated.', 400);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.script.manage');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.script.manage');
      const row = await tx.siteScript.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, ...input, sourceHash: sha256(input.source), status: 'REVIEW', requestedByUserId: actor.userId } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_SCRIPT_SUBMITTED', { scriptId: row.id, language: row.language, category: row.allowedCategory });
      return { ...row, source: undefined };
    });
  }
  async decideScript(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ decision: z.enum(['APPROVE', 'REJECT', 'REVOKE']) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.script.approve');
      const row = await tx.siteScript.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Script');
      await loadSite(tx, actor, row.siteId, 'sites.script.approve');
      if (input.decision !== 'REVOKE' && row.requestedByUserId === actor.userId) throw new AppError('PERMISSION_DENIED', 'A separate approver is required.', 403);
      const to = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'REVOKED';
      if (input.decision === 'REVOKE' ? row.status !== 'APPROVED' : row.status !== 'REVIEW') throw new AppError('INVALID_STATE_TRANSITION', `Script is ${row.status}.`, 409);
      const updated = await tx.siteScript.update({ where: { id: row.id }, data: { status: to, approvedByUserId: input.decision === 'APPROVE' ? actor.userId : row.approvedByUserId } });
      await evidence(tx, actor, 'SITE', row.siteId, to === 'APPROVED' ? 'SITE_SCRIPT_APPROVED' : to === 'REVOKED' ? 'SITE_SCRIPT_REVOKED' : 'SITE_SCRIPT_REJECTED', { scriptId: row.id, note: 'Effective from the next release.' });
      return { ...updated, source: undefined };
    });
  }
  async securityPreview(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.read');
      const scripts = await tx.siteScript.findMany({ where: { siteId: site.id, status: 'APPROVED' } });
      const origins = [...new Set(scripts.flatMap(s => (s.originAllowlist as string[]).map(o => new URL(o).origin)))];
      const hashes = scripts.filter(s => s.language === 'JS').map(s => `'sha256-${Buffer.from(s.sourceHash, 'hex').toString('base64')}'`);
      return { siteId: site.id, csp: `default-src 'self'; script-src 'self' ${[...hashes, ...origins].join(' ')}; style-src 'self' 'unsafe-inline'; frame-src ${origins.join(' ') || "'none'"}; connect-src 'self' ${origins.join(' ')}; object-src 'none'; base-uri 'self'`,
        sandbox: 'Custom JS runs in a sandboxed iframe without same-origin access; tenant API credentials are never exposed.', approvedScripts: scripts.map(s => ({ id: s.id, language: s.language, category: s.allowedCategory })) };
    });
  }

  // ------------------------------------------------------------------ experiments
  async createExperiment(actor: Principal, pageId: string, raw: unknown) {
    const input = parse(z.strictObject({ metric: z.enum(['CONVERSION_RATE', 'CLICK_RATE']), goalEvent: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), attributionWindowHours: z.number().int().min(1).max(720).default(24), persistAssignments: z.boolean().default(true),
      variants: z.array(z.strictObject({ label: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/), pageRevisionId: uuid, trafficPercent: z.number().min(0.01).max(100) })).min(2).max(5) }), raw);
    assertAllocation(input.variants.map(v => v.trafficPercent));
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.experiment.manage');
      const { page, site } = await this.content.page(tx, actor, pageId, 'sites.experiment.manage');
      for (const v of input.variants) { const rev = await tx.sitePageRevision.findFirst({ where: { pageId: page.id, id: v.pageRevisionId, status: { in: ['APPROVED', 'ACTIVE'] } } }); if (!rev) throw new AppError('INVALID_STATE_TRANSITION', 'Variants must reference approved revisions of this page.', 409); }
      const row = await tx.siteExperiment.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, pageId: page.id, metric: input.metric, goalEvent: input.goalEvent, attributionWindowHours: input.attributionWindowHours, persistAssignments: input.persistAssignments, seed: sha256(page.id + Date.now()).slice(0, 16), status: 'READY' } });
      for (const v of input.variants) await tx.siteExperimentVariant.create({ data: { workspaceId: actor.workspaceId, experimentId: row.id, ...v } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_EXPERIMENT_CREATED', { experimentId: row.id });
      return row;
    });
  }
  async experimentState(actor: Principal, id: string, to: 'RUNNING' | 'STOPPED') {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.experiment.manage');
      const row = await tx.siteExperiment.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Experiment');
      await loadSite(tx, actor, row.siteId, 'sites.experiment.manage');
      if (to === 'RUNNING' ? row.status !== 'READY' : row.status !== 'RUNNING') throw new AppError('INVALID_STATE_TRANSITION', `Experiment is ${row.status}.`, 409);
      const updated = await tx.siteExperiment.update({ where: { id: row.id }, data: { status: to, ...(to === 'RUNNING' ? { startAt: new Date() } : { endAt: new Date() }), version: { increment: 1 } } });
      await evidence(tx, actor, 'SITE', row.siteId, to === 'RUNNING' ? 'SITE_EXPERIMENT_STARTED' : 'SITE_EXPERIMENT_STOPPED', { experimentId: row.id, note: to === 'STOPPED' ? 'Published baseline remains; a winner needs the normal publish flow.' : undefined });
      return updated;
    });
  }
  async experimentResults(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const row = await tx.siteExperiment.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Experiment');
      await loadSite(tx, actor, row.siteId, 'sites.site.read');
      const variants = await tx.siteExperimentVariant.findMany({ where: { experimentId: row.id } });
      const out = [];
      for (const v of variants) {
        const views = await tx.siteExperimentEvent.count({ where: { experimentId: row.id, variantId: v.id, eventType: 'view' } });
        const goals = await tx.siteExperimentEvent.count({ where: { experimentId: row.id, variantId: v.id, eventType: row.goalEvent } });
        out.push({ variantId: v.id, label: v.label, trafficPercent: Number(v.trafficPercent), visitors: views, conversions: goals, rate: views ? goals / views : 0 });
      }
      return { experimentId: row.id, status: row.status, metric: row.metric, goalEvent: row.goalEvent, persistAssignments: row.persistAssignments, measurementNote: row.persistAssignments ? null : 'Assignments are not persisted for privacy; repeat visits may be re-bucketed deterministically only.', variants: out };
    });
  }
  /** Public: stable deterministic arm per visitor; without analytics consent nothing is persisted (no tracking cookie). */
  async experimentEvent(siteId: string, raw: unknown, client: string) {
    const input = parse(z.strictObject({ experimentId: uuid, visitorKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), eventType: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), consent: z.enum(['GRANTED', 'DENIED']), preview: z.boolean().default(false) }), raw);
    checkRateLimit(client, { scope: 'sites.experiment-event', limit: 120, windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const row = await tx.siteExperiment.findFirst({ where: { id: input.experimentId, siteId: parse(uuid, siteId), status: 'RUNNING' } });
      if (!row) throw notFound('Experiment');
      const variants = await tx.siteExperimentVariant.findMany({ where: { experimentId: row.id } });
      const pseudo = sha256(row.seed + ':' + input.visitorKey);
      const variant = allocate(variants.map(v => ({ ...v, percent: Number(v.trafficPercent) })), row.seed, pseudo);
      if (input.consent === 'DENIED' || !row.persistAssignments || input.preview || /bot|crawler|spider/i.test(client)) return { variantId: variant.id, label: variant.label, persisted: false, setCookie: false };
      const existing = await tx.siteVisitorAssignment.findUnique({ where: { experimentId_visitorKey: { experimentId: row.id, visitorKey: pseudo } } });
      const assigned = existing ?? await tx.siteVisitorAssignment.create({ data: { workspaceId: row.workspaceId, experimentId: row.id, visitorKey: pseudo, variantId: variant.id } });
      const prior = await tx.siteExperimentEvent.findUnique({ where: { experimentId_visitorKey_eventType: { experimentId: row.id, visitorKey: pseudo, eventType: input.eventType } } });
      if (!prior) {
        await tx.siteExperimentEvent.create({ data: { workspaceId: row.workspaceId, experimentId: row.id, variantId: assigned.variantId, visitorKey: pseudo, eventType: input.eventType, consentState: input.consent } });
        if (input.eventType === row.goalEvent) await systemEvent(tx, row.workspaceId, 'SITE', row.siteId, 'SITE_EXPERIMENT_GOAL_RECORDED', { experimentId: row.id, variantId: assigned.variantId }, false);
      }
      return { variantId: assigned.variantId, label: variants.find(v => v.id === assigned.variantId)?.label, persisted: true, setCookie: true };
    });
  }

  // ------------------------------------------------------------------ AI drafts
  /** AI output is untrusted: validated against the block schema; saved as a DRAFT revision only; never published. */
  async generate(actor: Principal, siteId: string, raw: unknown, pageId?: string) {
    const input = parse(z.strictObject({ scenario: z.enum(['LANDING_PAGE', 'SECTION', 'REWRITE']).default(pageId ? 'REWRITE' : 'LANDING_PAGE'), brief: z.string().trim().min(5).max(4000), title: z.string().trim().max(200).optional(), requestKey: z.string().min(8).max(128) }), raw);
    const ctx = await inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.ai.generate'); requirePermission(actor, 'sites.page.edit');
      if (actor.entitlements?.ai === false) throw new AppError('PERMISSION_DENIED', 'AI is not included in the subscription.', 403);
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const prior = await tx.siteAiDraft.findUnique({ where: { usageKey: 'gen:' + actor.workspaceId + ':' + input.requestKey } });
      const page = pageId ? (await this.content.page(tx, actor, pageId, 'sites.page.edit')).page : null;
      const current = page ? await this.content.latest(tx, page.id) : null;
      return { site, prior, page, current };
    });
    if (ctx.prior) return ctx.prior;
    let result: Awaited<ReturnType<ReturnType<typeof aiGateway>['runScenario']>>;
    try { result = await aiGateway().runScenario({ scenario: 'SITE_' + input.scenario, workspaceId: actor.workspaceId, prompt: JSON.stringify({ brief: input.brief, current: ctx.current?.blockTree ?? null }), allowedBlocks: Object.keys(BLOCK_DEFINITIONS).filter(k => !['form', 'product', 'cart', 'checkout', 'contact_widget', 'shared'].includes(k)) }); }
    catch (e) {
      await this.db.$transaction(tx => tx.siteAiDraft.create({ data: { workspaceId: actor.workspaceId, siteId: ctx.site.id, pageId: ctx.page?.id, scenario: input.scenario, status: 'FAILED', usageKey: 'gen:' + actor.workspaceId + ':' + input.requestKey, errorCode: isAppError(e) ? e.code : 'AI_FAILED', requestedByUserId: actor.userId } }));
      throw e;
    }
    return inTx(this.db, actor, async (tx, actor) => {
      const draft = await tx.siteAiDraft.create({ data: { workspaceId: actor.workspaceId, siteId: ctx.site.id, pageId: ctx.page?.id, scenario: input.scenario, status: 'GENERATED', modelId: result.modelId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicros: BigInt(result.costMicros), usageKey: 'gen:' + actor.workspaceId + ':' + input.requestKey, billed: true, requestedByUserId: actor.userId } });
      let tree;
      try { tree = await validateBlockTree(tx, actor, result.output); }
      catch (e) { await tx.siteAiDraft.update({ where: { id: draft.id }, data: { status: 'FAILED', errorCode: 'AI_OUTPUT_REJECTED' } }); await evidence(tx, actor, 'SITE', ctx.site.id, 'SITE_AI_DRAFT_REJECTED', { draftId: draft.id, reason: 'VALIDATION' }); return { ...draft, status: 'FAILED', errorCode: 'AI_OUTPUT_REJECTED', detail: isAppError(e) ? e.details : null }; }
      let page = ctx.page;
      if (!page) page = await tx.sitePage.create({ data: { workspaceId: actor.workspaceId, siteId: ctx.site.id, slug: 'ai-draft-' + draft.id.slice(0, 8), type: 'STANDARD', locale: ctx.site.defaultLocale, title: input.title ?? 'AI draft', createdByUserId: actor.userId } });
      const current = await tx.sitePage.findUniqueOrThrow({ where: { id: page.id } });
      const revision = await tx.sitePageRevision.create({ data: { workspaceId: actor.workspaceId, siteId: ctx.site.id, pageId: page.id, locale: page.locale, revision: current.latestRevision + 1, blockTree: tree as unknown as Prisma.InputJsonValue, contentHash: contentHash(tree), origin: 'AI', createdByUserId: actor.userId } });
      await tx.sitePage.update({ where: { id: page.id }, data: { latestRevision: revision.revision } });
      const updated = await tx.siteAiDraft.update({ where: { id: draft.id }, data: { status: 'PENDING_REVIEW', generatedRevisionId: revision.id, pageId: page.id } });
      await evidence(tx, actor, 'SITE', ctx.site.id, 'SITE_AI_DRAFT_GENERATED', { draftId: draft.id, revisionId: revision.id, tokens: result.inputTokens + result.outputTokens });
      return updated;
    });
  }
  async decideDraft(actor: Principal, id: string, decision: 'ACCEPTED' | 'REJECTED') {
    return inTx(this.db, actor, async (tx, actor) => {
      const draft = await tx.siteAiDraft.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!draft) throw notFound('AI draft');
      await loadSite(tx, actor, draft.siteId, 'sites.page.edit');
      if (draft.status !== 'PENDING_REVIEW') throw new AppError('INVALID_STATE_TRANSITION', `Draft is ${draft.status}.`, 409);
      // Acceptance keeps a DRAFT revision for normal approval/publication; it never publishes.
      if (decision === 'REJECTED' && draft.generatedRevisionId) await tx.sitePageRevision.update({ where: { id: draft.generatedRevisionId }, data: { status: 'REJECTED' } });
      const updated = await tx.siteAiDraft.update({ where: { id: draft.id }, data: { status: decision } });
      await evidence(tx, actor, 'SITE', draft.siteId, decision === 'ACCEPTED' ? 'SITE_AI_DRAFT_APPROVED' : 'SITE_AI_DRAFT_REJECTED', { draftId: draft.id });
      return updated;
    });
  }
  async usage(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const draft = await tx.siteAiDraft.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!draft) throw notFound('AI draft');
      await loadSite(tx, actor, draft.siteId, 'sites.site.read');
      const all = await tx.siteAiDraft.aggregate({ where: { workspaceId: actor.workspaceId, billed: true }, _sum: { inputTokens: true, outputTokens: true, costMicros: true } });
      const mine = await tx.siteAiDraft.aggregate({ where: { workspaceId: actor.workspaceId, billed: true, requestedByUserId: draft.requestedByUserId, scenario: draft.scenario }, _sum: { costMicros: true } });
      return { draftId: draft.id, modelId: draft.modelId, scenario: draft.scenario, inputTokens: draft.inputTokens, outputTokens: draft.outputTokens, costMicros: draft.costMicros.toString(), billed: draft.billed,
        workspaceTotals: { inputTokens: all._sum.inputTokens ?? 0, outputTokens: all._sum.outputTokens ?? 0, costMicros: (all._sum.costMicros ?? 0n).toString() }, userScenarioCostMicros: (mine._sum.costMicros ?? 0n).toString() };
    });
  }
}
