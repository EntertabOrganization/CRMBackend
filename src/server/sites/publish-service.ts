import { Prisma, type PrismaClient, type Site, type SiteRelease } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { command, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { hashSecret, verifyHash } from '../security';
import { checkRateLimit } from '../rate-limit';
import { expectedVersion, inTx, newToken, notFound, sha256, systemEvent } from '../suite/kernel';
import { isRtl, loadSite, PLATFORM_DOMAIN } from './support';
import { SitesContentService } from './content-service';

type Manifest = { pages: { pageId: string; locale: string; path: string; revisionId: string; revision: number; contentHash: string; type: string; indexable: boolean }[]; navigation: { name: string; locale: string; revision: number; items: unknown }[];
  sharedBlocks: Record<string, number>; themeRevision: number | null; redirects: { fromPath: string; toPath: string; statusCode: number }[]; gone: string[]; scripts: string[]; languages: { locale: string; isDefault: boolean; rtl: boolean; fallbackPolicy: string; enabled: boolean }[]; cookiePolicyVersion: number; seo: { robotsDefault: string; sitemapEnabled: boolean } };

/** Release compilation, previews, approval, atomic publish, scheduling, rollback and public delivery (Sites/04, /05, /06). */
export class SitesPublishService {
  constructor(private readonly db: PrismaClient) {}

  /** Compiles current approved (or latest when no approval is required) revisions into an immutable manifest. */
  async compile(tx: Tx, site: Site): Promise<Manifest> {
    const pages = await tx.sitePage.findMany({ where: { siteId: site.id, deletedAt: null } });
    const languages = await tx.siteLanguage.findMany({ where: { siteId: site.id } });
    if (!languages.some(l => l.isDefault && l.enabled)) throw new AppError('POLICY_NOT_CONFIGURED', 'An enabled default language is required before publication.', 409);
    const manifest: Manifest = { pages: [], navigation: [], sharedBlocks: {}, themeRevision: null, redirects: [], gone: [], scripts: [], languages: languages.map(l => ({ locale: l.locale, isDefault: l.isDefault, rtl: l.rtl, fallbackPolicy: l.fallbackPolicy, enabled: l.enabled })), cookiePolicyVersion: 1, seo: { robotsDefault: 'index,follow', sitemapEnabled: true } };
    const failures: string[] = [];
    for (const page of pages) {
      const language = languages.find(l => l.locale === page.locale);
      if (!language?.enabled) continue;
      const candidates = await tx.sitePageRevision.findMany({ where: { pageId: page.id }, orderBy: { revision: 'desc' } });
      // Unreviewed AI/translation drafts never reach public; approval-gated sites need an APPROVED revision.
      const revision = candidates.find(r => site.requiresApproval || r.origin !== 'EDITOR' ? ['APPROVED', 'ACTIVE'].includes(r.status) : r.status !== 'REJECTED');
      if (!revision) { if (site.requiresApproval) failures.push(`Page ${page.id} has no approved revision`); continue; }
      for (const block of (revision.blockTree as { blocks?: { type: string; props: Record<string, unknown> }[] }).blocks ?? []) if (block.type === 'shared') {
        const shared = await tx.siteSharedBlock.findUnique({ where: { id: String(block.props.sharedBlockId) } });
        if (!shared?.publishedRevision) failures.push(`Shared block ${String(block.props.sharedBlockId)} has no published revision`);
        else manifest.sharedBlocks[shared.id] = shared.publishedRevision;
      }
      const seo = revision.seo as { indexability?: string };
      manifest.pages.push({ pageId: page.id, locale: page.locale, path: SitesContentService.path(page), revisionId: revision.id, revision: revision.revision, contentHash: revision.contentHash, type: page.type, indexable: seo.indexability !== 'NOINDEX' && !['CHECKOUT'].includes(page.type) });
    }
    if (failures.length) throw new AppError('RELEASE_VALIDATION_FAILED', 'Release cannot be compiled.', 409, { failures });
    if (!manifest.pages.length) throw new AppError('RELEASE_VALIDATION_FAILED', 'Release has no publishable pages.', 409);
    manifest.navigation = (await tx.siteNavigationMenu.findMany({ where: { siteId: site.id } })).map(m => ({ name: m.name, locale: m.locale, revision: m.revision, items: m.items }));
    manifest.themeRevision = (await tx.siteTheme.findFirst({ where: { siteId: site.id }, orderBy: { revision: 'desc' } }))?.revision ?? null;
    manifest.redirects = (await tx.siteRedirect.findMany({ where: { siteId: site.id } })).map(r => ({ fromPath: r.fromPath, toPath: r.toPath, statusCode: r.statusCode }));
    manifest.gone = (await tx.sitePage.findMany({ where: { siteId: site.id, deletedAt: { not: null } } })).map(p => SitesContentService.path(p)).filter(p => !manifest.redirects.some(r => r.fromPath === p));
    manifest.scripts = (await tx.siteScript.findMany({ where: { siteId: site.id, status: 'APPROVED' } })).map(s => s.id); // revoked/unreviewed scripts are omitted
    manifest.cookiePolicyVersion = (await tx.siteCookiePolicy.findUnique({ where: { siteId: site.id } }))?.version ?? 1;
    const seo = await tx.siteSeoSettings.findUnique({ where: { siteId: site.id } });
    if (seo) manifest.seo = { robotsDefault: seo.robotsDefault, sitemapEnabled: seo.sitemapEnabled };
    return manifest;
  }
  private async nextNumber(tx: Tx, siteId: string) { return ((await tx.siteRelease.findFirst({ where: { siteId }, orderBy: { releaseNumber: 'desc' } }))?.releaseNumber ?? 0) + 1; }

  async previewRelease(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'sites:releases:' + siteId);
      if (!actor.grants.has('sites.page.edit')) requirePermission(actor, 'sites.site.publish');
      const site = await loadSite(tx, actor, parse(uuid, siteId), actor.grants.has('sites.page.edit') ? 'sites.page.edit' : 'sites.site.publish');
      const manifest = await this.compile(tx, site);
      const release = await tx.siteRelease.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, releaseNumber: await this.nextNumber(tx, site.id), manifest: manifest as unknown as Prisma.InputJsonValue, approvalState: site.requiresApproval ? 'PENDING' : 'NOT_REQUIRED', createdByUserId: actor.userId } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_RELEASE_CANDIDATE_CREATED', { releaseId: release.id, releaseNumber: release.releaseNumber, pages: manifest.pages.length });
      return release;
    });
  }
  async submitApproval(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ releaseId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const release = await tx.siteRelease.findFirst({ where: { siteId: site.id, id: input.releaseId, status: 'DRAFT' } });
      if (!release) throw notFound('Release');
      const updated = await tx.siteRelease.update({ where: { id: release.id }, data: { approvalState: 'PENDING' } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_RELEASE_APPROVAL_REQUESTED', { releaseId: release.id });
      return updated;
    });
  }
  async approve(actor: Principal, siteId: string, releaseId: string, raw: unknown) {
    const input = parse(z.strictObject({ decision: z.enum(['APPROVE', 'REJECT']).default('APPROVE'), comment: z.string().max(1000).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.publish');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.publish');
      const release = await tx.siteRelease.findFirst({ where: { siteId: site.id, id: parse(uuid, releaseId), status: { in: ['DRAFT', 'SCHEDULED'] } } });
      if (!release) throw notFound('Release');
      if (release.createdByUserId === actor.userId && site.requiresApproval) throw new AppError('PERMISSION_DENIED', 'Release author cannot approve their own release.', 403);
      const updated = await tx.siteRelease.update({ where: { id: release.id }, data: { approvalState: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', approvedByUserId: actor.userId } });
      if (input.decision === 'APPROVE') await tx.sitePageRevision.updateMany({ where: { id: { in: (release.manifest as unknown as Manifest).pages.map(p => p.revisionId) }, status: 'DRAFT' }, data: { status: 'APPROVED' } });
      await evidence(tx, actor, 'SITE', site.id, input.decision === 'APPROVE' ? 'SITE_RELEASE_APPROVED' : 'SITE_RELEASE_REJECTED', { releaseId: release.id });
      return updated;
    });
  }
  /** Revision-level approval used when a site requires approved revisions before compiling. */
  async approveRevision(actor: Principal, revisionId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.content.publish');
      const revision = await tx.sitePageRevision.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, revisionId) } });
      if (!revision) throw notFound('Revision');
      await loadSite(tx, actor, revision.siteId, 'sites.content.publish');
      if (revision.createdByUserId === actor.userId && revision.origin !== 'EDITOR') throw new AppError('PERMISSION_DENIED', 'Generated content needs a different reviewer.', 403);
      if (revision.status !== 'DRAFT') throw new AppError('INVALID_STATE_TRANSITION', `Revision is ${revision.status}.`, 409);
      const updated = await tx.sitePageRevision.update({ where: { id: revision.id }, data: { status: 'APPROVED' } });
      await evidence(tx, actor, 'SITE', revision.siteId, 'PAGE_REVISION_APPROVED', { revisionId: revision.id });
      return updated;
    });
  }

  /** Atomic activation: single locked pointer swap; failure leaves the previous release live. Edit permission never implies publish. */
  async activateInTx(tx: Tx, actor: Principal, site: Site, release: SiteRelease, event: string) {
    if (site.requiresApproval && release.approvalState !== 'APPROVED') throw new AppError('INVALID_STATE_TRANSITION', 'Release requires approval before publication.', 409);
    const ent = actor.entitlements ?? {};
    if (ent.sites === false && !(typeof ent.sitesExpiredAt === 'string' && new Date(ent.sitesExpiredAt).getTime() + (typeof ent.sitesGraceDays === 'number' ? ent.sitesGraceDays : 15) * 86400000 > Date.now()))
      throw new AppError('PERMISSION_DENIED', 'Publishing is unavailable for this subscription; published content stays read-only.', 403);
    const manifest = release.manifest as unknown as Manifest;
    for (const p of manifest.pages) if (!await tx.sitePageRevision.findUnique({ where: { id: p.revisionId } })) throw new AppError('RELEASE_VALIDATION_FAILED', 'Release references missing revisions.', 409);
    const previous = site.activeReleaseId ? await tx.siteRelease.findUnique({ where: { id: site.activeReleaseId } }) : null;
    if (previous) {
      await tx.siteRelease.update({ where: { id: previous.id }, data: { status: event === 'SITE_RELEASE_ROLLED_BACK' ? 'ROLLED_BACK' : 'SUPERSEDED' } });
      await tx.sitePageRevision.updateMany({ where: { id: { in: (previous.manifest as unknown as Manifest).pages.map(p => p.revisionId) }, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
    }
    await tx.sitePageRevision.updateMany({ where: { id: { in: manifest.pages.map(p => p.revisionId) } }, data: { status: 'ACTIVE' } });
    const activated = await tx.siteRelease.update({ where: { id: release.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
    await tx.site.update({ where: { id: site.id }, data: { activeReleaseId: release.id, status: 'PUBLISHED', siteVersion: { increment: 1 } } });
    for (const p of manifest.pages) await tx.sitePage.update({ where: { id: p.pageId }, data: { status: 'PUBLISHED' } });
    await tx.siteSitemapBuild.create({ data: { workspaceId: site.workspaceId, siteId: site.id, releaseId: release.id, status: 'READY', content: await this.sitemapXml(tx, site, manifest) } });
    await evidence(tx, actor, 'SITE', site.id, event, { releaseId: release.id, releaseNumber: release.releaseNumber, previousReleaseId: previous?.id ?? null });
    await evidence(tx, actor, 'SITE', site.id, 'CDN_INVALIDATION_REQUESTED', { cacheKey: release.id }, false);
    return activated;
  }
  async publish(actor: Principal, siteId: string, raw: unknown, key: string | null) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.publish'); // permission precedes payload validation
      const input = parse(z.strictObject({ releaseId: uuid, expectedSiteVersion: expectedVersion }), raw);
      await lock(tx, actor.workspaceId, 'sites:releases:' + siteId);
      return command(tx, actor, 'sites.release.publish:' + siteId, key, input, async () => {
        const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.publish');
        if (site.siteVersion !== input.expectedSiteVersion) throw new AppError('VERSION_CONFLICT', 'Site changed; reload.', 409, { currentVersion: site.siteVersion });
        const release = await tx.siteRelease.findFirst({ where: { siteId: site.id, id: input.releaseId, status: { in: ['DRAFT', 'SCHEDULED'] } } });
        if (!release) throw notFound('Release');
        return this.activateInTx(tx, actor, site, release, 'SITE_RELEASE_ACTIVATED');
      });
    });
  }
  async schedule(actor: Principal, siteId: string, raw: unknown, key: string | null) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.publish');
      const input = parse(z.strictObject({ releaseId: uuid, scheduledAt: z.iso.datetime({ offset: true }), timezone: z.string().max(64) }), raw);
      return command(tx, actor, 'sites.release.schedule:' + siteId, key, input, async () => {
        const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.publish');
        const release = await tx.siteRelease.findFirst({ where: { siteId: site.id, id: input.releaseId, status: 'DRAFT' } });
        if (!release) throw notFound('Release');
        if (new Date(input.scheduledAt) <= new Date()) throw new AppError('VALIDATION_FAILED', 'Schedule must be in the future.', 400);
        const updated = await tx.siteRelease.update({ where: { id: release.id }, data: { status: 'SCHEDULED', scheduledAt: new Date(input.scheduledAt) } });
        await evidence(tx, actor, 'SITE', site.id, 'SITE_RELEASE_SCHEDULED', { releaseId: release.id, scheduledAt: input.scheduledAt, timezone: input.timezone });
        return updated;
      });
    });
  }
  /** Rollback re-activates a prior immutable manifest as a NEW audited release; history is never rewritten. */
  async rollback(actor: Principal, siteId: string, releaseId: string, key: string | null) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.publish'); await lock(tx, actor.workspaceId, 'sites:releases:' + siteId);
      return command(tx, actor, 'sites.release.rollback:' + siteId, key ?? 'rollback:' + releaseId, { releaseId }, async () => {
        const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.publish');
        const target = await tx.siteRelease.findFirst({ where: { siteId: site.id, id: parse(uuid, releaseId), status: { in: ['SUPERSEDED', 'ROLLED_BACK'] } } });
        if (!target) throw notFound('Release');
        const copy = await tx.siteRelease.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, releaseNumber: await this.nextNumber(tx, site.id), manifest: target.manifest as Prisma.InputJsonValue, approvalState: 'APPROVED', approvedByUserId: actor.userId, createdByUserId: actor.userId } });
        return this.activateInTx(tx, actor, site, copy, 'SITE_RELEASE_ROLLED_BACK');
      });
    });
  }
  async releases(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.read');
      return tx.siteRelease.findMany({ where: { siteId: site.id }, orderBy: { releaseNumber: 'desc' }, select: { id: true, releaseNumber: true, status: true, approvalState: true, scheduledAt: true, activatedAt: true, createdAt: true } });
    });
  }

  // ------------------------------------------------------------------ previews
  async previewLink(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ releaseId: uuid, expiresInMinutes: z.number().int().min(5).max(10080), audienceScope: z.enum(['INTERNAL', 'LINK_HOLDERS']).default('LINK_HOLDERS'), password: z.string().min(8).max(128).optional() }), raw);
    const passwordHash = input.password ? await hashSecret(input.password) : null;
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const release = await tx.siteRelease.findFirst({ where: { siteId: site.id, id: input.releaseId } });
      if (!release) throw notFound('Release');
      const token = newToken('pv_');
      const row = await tx.sitePreviewToken.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, releaseId: release.id, tokenHash: sha256(token), passwordHash, audienceScope: input.audienceScope, expiresAt: new Date(Date.now() + input.expiresInMinutes * 60000), createdByUserId: actor.userId } });
      await evidence(tx, actor, 'SITE', site.id, 'PREVIEW_LINK_CREATED', { previewId: row.id, expiresAt: row.expiresAt });
      return { id: row.id, token, previewPath: `/api/v1/sites/${site.id}/previews/${token}`, expiresAt: row.expiresAt };
    });
  }
  async revokePreview(actor: Principal, siteId: string, previewId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const row = await tx.sitePreviewToken.findFirst({ where: { siteId: site.id, id: parse(uuid, previewId) } });
      if (!row) throw notFound('Preview');
      await tx.sitePreviewToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
      await evidence(tx, actor, 'SITE', site.id, 'PREVIEW_LINK_REVOKED', { previewId: row.id });
      return { id: row.id, revoked: true };
    });
  }
  /** Public preview: read-only, noindex, analytics-excluded; never authorizes editor writes. */
  async preview(siteId: string, token: string, password: string | null, client: string) {
    checkRateLimit(client, { scope: 'sites.preview', limit: 120, windowMs: 60000 });
    const row = await this.db.sitePreviewToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.siteId !== siteId) throw notFound('Preview');
    if (row.revokedAt || row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Preview link expired or was revoked.', 410);
    if (row.passwordHash && !(password && await verifyHash(row.passwordHash, password))) throw new AppError('UNAUTHENTICATED', 'Preview password required.', 401);
    return this.db.$transaction(async tx => ({ ...(await this.renderRelease(tx, row.releaseId, null, null, true)), robots: 'noindex,nofollow', analytics: 'DISABLED' }));
  }

  // ------------------------------------------------------------------ public delivery
  async resolveHost(tx: Tx, host: string) {
    const clean = host.toLowerCase().split(':')[0];
    const route = await tx.siteHostRoute.findFirst({ where: { hostname: clean, status: 'ACTIVE', pathPrefix: '/' } });
    if (!route) throw notFound('Site');
    if (route.domainId) { const d = await tx.siteDomain.findUnique({ where: { id: route.domainId } }); if (!d || !['VERIFIED', 'CERT_ISSUED'].includes(d.verificationState)) throw notFound('Site'); }
    const site = await tx.site.findUnique({ where: { id: route.siteId } });
    if (!site || site.status !== 'PUBLISHED' || !site.activeReleaseId || site.archivedAt) throw notFound('Site');
    const workspace = await tx.workspace.findUnique({ where: { id: site.workspaceId } });
    const ent = ((workspace?.settings as { entitlements?: Record<string, unknown> })?.entitlements ?? {});
    if (ent.sites === false && ent.sitesPublicAfterGrace === false) throw notFound('Site');
    return { site, host: clean };
  }
  /** Renders a release page with lang/dir, canonical/hreflang and consent-gated scripts. Missing translations follow the language fallback policy. */
  async renderRelease(tx: Tx, releaseId: string, path: string | null, requestedLocale: string | null, preview = false, host?: string, consent: string[] = []) {
    const release = await tx.siteRelease.findUniqueOrThrow({ where: { id: releaseId } });
    const manifest = release.manifest as unknown as Manifest, site = await tx.site.findUniqueOrThrow({ where: { id: release.siteId } });
    const defaultLanguage = manifest.languages.find(l => l.isDefault)!;
    const locale = requestedLocale && manifest.languages.some(l => l.locale === requestedLocale && l.enabled) ? requestedLocale : defaultLanguage.locale;
    const wanted = path ?? '/';
    const redirect = manifest.redirects.find(r => r.fromPath === wanted);
    if (redirect) return { redirect: { location: redirect.toPath, statusCode: redirect.statusCode } };
    let page = manifest.pages.find(p => p.path === wanted && p.locale === locale), fallback = false;
    if (!page) {
      const language = manifest.languages.find(l => l.locale === locale);
      if (language?.fallbackPolicy === 'DEFAULT_LANGUAGE') { page = manifest.pages.find(p => p.path === wanted && p.locale === defaultLanguage.locale); fallback = Boolean(page); }
    }
    if (!page) { if (manifest.gone.includes(wanted)) throw new AppError('RESOURCE_EXPIRED', 'Page was removed.', 410); throw notFound('Page'); }
    const revision = await tx.sitePageRevision.findUniqueOrThrow({ where: { id: page.revisionId } });
    const blocks = [];
    for (const block of (revision.blockTree as { blocks: { key: string; type: string; props: Record<string, unknown> }[] }).blocks) {
      if (block.type === 'shared') {
        const sharedId = String(block.props.sharedBlockId), rev = manifest.sharedBlocks[sharedId];
        const shared = await tx.siteSharedBlockRevision.findUnique({ where: { sharedBlockId_revision: { sharedBlockId: sharedId, revision: rev } } });
        const def = await tx.siteSharedBlock.findUnique({ where: { id: sharedId } });
        blocks.push(shared && def ? { key: block.key, type: def.kind, props: shared.props, sharedBlockId: sharedId, sharedRevision: rev } : { key: block.key, type: 'unavailable', props: {} });
      } else blocks.push(block);
    }
    const baseHost = host ?? (await tx.siteDomain.findFirst({ where: { siteId: site.id, isPrimary: true, verificationState: { in: ['VERIFIED', 'CERT_ISSUED'] } } }))?.hostname ?? `${site.subdomain}.${PLATFORM_DOMAIN}`;
    const alternates = manifest.pages.filter(p => p.path === page!.path).map(p => ({ hreflang: p.locale, href: `https://${baseHost}${p.path === '/' ? '' : p.path}?lang=${p.locale}` }));
    const scripts = preview ? [] : await tx.siteScript.findMany({ where: { id: { in: manifest.scripts }, status: 'APPROVED' } });
    const servedLocale = fallback ? defaultLanguage.locale : locale;
    return { siteId: site.id, releaseId: release.id, releaseNumber: release.releaseNumber, cacheKey: `${site.id}:${release.id}:${page.path}:${servedLocale}`,
      html: { lang: servedLocale, dir: isRtl(servedLocale) ? 'rtl' : 'ltr' }, requestedLocale: locale, translationFallback: fallback, cookiePolicyVersion: manifest.cookiePolicyVersion,
      seo: { title: (revision.seo as { title?: string }).title ?? null, description: (revision.seo as { metaDescription?: string }).metaDescription ?? null, canonical: `https://${baseHost}${page.path === '/' ? '' : page.path}${fallback ? '' : `?lang=${servedLocale}`}`, robots: preview || !page.indexable ? 'noindex' : manifest.seo.robotsDefault, alternates: fallback ? [] : alternates },
      navigation: manifest.navigation.filter(n => n.locale === servedLocale), blocks,
      // Optional scripts load only for consented categories; NECESSARY is core delivery.
      scripts: scripts.filter(s => s.allowedCategory === 'NECESSARY' || consent.includes(s.allowedCategory)).map(s => ({ id: s.id, kind: s.kind, language: s.language, sourceHash: s.sourceHash, category: s.allowedCategory })) };
  }
  async renderPublic(raw: Record<string, string>, hostHeader: string | null, client: string) {
    checkRateLimit(client, { scope: 'sites.public', limit: 1200, windowMs: 60000 });
    const host = raw.host ?? hostHeader ?? '';
    return this.db.$transaction(async tx => {
      const { site, host: resolved } = await this.resolveHost(tx, host);
      const consent = (raw.consent ?? '').split(',').filter(Boolean);
      return this.renderRelease(tx, site.activeReleaseId!, raw.path ?? '/', raw.lang ?? null, false, resolved, consent);
    });
  }
  async sitemapXml(tx: Tx, site: Site, manifest: Manifest) {
    const host = (await tx.siteDomain.findFirst({ where: { siteId: site.id, isPrimary: true, verificationState: { in: ['VERIFIED', 'CERT_ISSUED'] } } }))?.hostname ?? `${site.subdomain}.${PLATFORM_DOMAIN}`;
    const esc = (v: string) => v.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
    const urls = manifest.seo.sitemapEnabled ? manifest.pages.filter(p => p.indexable).map(p => `<url><loc>${esc(`https://${host}${p.path === '/' ? '' : p.path}?lang=${p.locale}`)}</loc></url>`) : [];
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`;
  }
  async publicSitemap(hostHeader: string | null, raw: Record<string, string>) {
    return this.db.$transaction(async tx => {
      const { site } = await this.resolveHost(tx, raw.host ?? hostHeader ?? '');
      const build = await tx.siteSitemapBuild.findFirst({ where: { siteId: site.id, releaseId: site.activeReleaseId!, status: 'READY' }, orderBy: { generatedAt: 'desc' } });
      return { contentType: 'application/xml', body: build?.content ?? await this.sitemapXml(tx, site, (await tx.siteRelease.findUniqueOrThrow({ where: { id: site.activeReleaseId! } })).manifest as unknown as Manifest) };
    });
  }
  async publicRobots(hostHeader: string | null, raw: Record<string, string>) {
    return this.db.$transaction(async tx => {
      const { site, host } = await this.resolveHost(tx, raw.host ?? hostHeader ?? '');
      const manifest = (await tx.siteRelease.findUniqueOrThrow({ where: { id: site.activeReleaseId! } })).manifest as unknown as Manifest;
      const disallow = manifest.pages.filter(p => !p.indexable).map(p => `Disallow: ${p.path}`);
      return { contentType: 'text/plain', body: ['User-agent: *', ...(manifest.seo.robotsDefault.includes('noindex') ? ['Disallow: /'] : disallow), `Sitemap: https://${host}/sitemap.xml`].join('\n') };
    });
  }
  async tickScheduled(limit = 10) {
    const due = await this.db.siteRelease.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } }, take: limit });
    let activated = 0;
    for (const release of due) try {
      await this.db.$transaction(async tx => {
        await lock(tx, release.workspaceId, 'sites:releases:' + release.siteId);
        const current = await tx.siteRelease.findUniqueOrThrow({ where: { id: release.id } });
        if (current.status !== 'SCHEDULED') return;
        const site = await tx.site.findUniqueOrThrow({ where: { id: release.siteId } });
        const { resolvePrincipal } = await import('../process-platform/context');
        const actor = await resolvePrincipal(tx, release.workspaceId, release.approvedByUserId ?? release.createdByUserId);
        requirePermission(actor, 'sites.site.publish');
        await this.activateInTx(tx, actor, site, current, 'SITE_RELEASE_ACTIVATED');
        activated++;
      });
    } catch { await this.db.$transaction(tx => systemEvent(tx, release.workspaceId, 'SITE', release.siteId, 'SITE_RELEASE_SCHEDULE_FAILED', { releaseId: release.id })); await this.db.siteRelease.update({ where: { id: release.id }, data: { status: 'DRAFT' } }); }
    return { activated };
  }
}
