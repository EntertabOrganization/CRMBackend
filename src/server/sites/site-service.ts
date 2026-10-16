import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal } from '../process-platform/context';
import { assertVersion, expectedVersion, inTx, listQuery, newToken, notFound, paged, safeEqual, sha256 } from '../suite/kernel';
import { currentDnsVerifier } from '../suite/providers';
import { hostname, loadSite, locale, PLATFORM_DOMAIN } from './support';

const GLOBAL = '00000000-0000-0000-0000-000000000000';
const subdomain = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])$/);
const RESERVED = new Set(['www', 'api', 'admin', 'app', 'mail', 'store', 'static', 'cdn', 'assets']);

/** Sites, managed subdomains, verified custom domains, hosting state, archive/restore, export, entitlement (Sites/01, /11). */
export class SitesSiteService {
  constructor(private readonly db: PrismaClient) {}

  async create(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(160), type: z.enum(['SITE', 'LANDING', 'STORE']), subdomain, defaultLocale: locale, requiresApproval: z.boolean().default(false), storeId: uuid.optional() }), raw);
    if (RESERVED.has(input.subdomain)) throw new AppError('VALIDATION_FAILED', 'Subdomain is reserved.', 400, { fields: [{ field: 'subdomain', reason: 'RESERVED' }] });
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.create');
      await lock(tx, GLOBAL, 'sites:hostnames');
      const limit = actor.entitlements?.sitesLimit;
      if (typeof limit === 'number' && await tx.site.count({ where: { workspaceId: actor.workspaceId, archivedAt: null } }) >= limit) throw new AppError('PLAN_LIMIT_REACHED', 'Site quota reached.', 403);
      if (await tx.site.findUnique({ where: { subdomain: input.subdomain } }) || await tx.commerceStorefront.findUnique({ where: { slug: input.subdomain } })) throw new AppError('ROUTE_COLLISION', 'Subdomain is already in use.', 409);
      if (input.storeId && !await tx.commerceStore.findFirst({ where: { workspaceId: actor.workspaceId, id: input.storeId } })) throw notFound('Store');
      const site = await tx.site.create({ data: { workspaceId: actor.workspaceId, ...input, createdByUserId: actor.userId } });
      await tx.siteLanguage.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, locale: input.defaultLocale, isDefault: true, rtl: ['ar', 'he', 'fa', 'ur'].includes(input.defaultLocale.split('-')[0]) } });
      await tx.siteHostRoute.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, hostname: `${input.subdomain}.${PLATFORM_DOMAIN}`, pathPrefix: '/' } });
      await tx.siteSeoSettings.create({ data: { siteId: site.id, workspaceId: actor.workspaceId } });
      await tx.siteCookiePolicy.create({ data: { siteId: site.id, workspaceId: actor.workspaceId, categories: [{ key: 'NECESSARY', isOptional: false, description: 'Required for the site to work.' }] } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_CREATED', { type: site.type, subdomain: site.subdomain });
      return site;
    });
  }
  async list(actor: Principal, raw: unknown) {
    const q = parse(listQuery.extend({ archived: z.enum(['true', 'false']).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.read');
      const rows = await tx.site.findMany({ where: { workspaceId: actor.workspaceId, archivedAt: q.archived === 'true' ? { not: null } : null, ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      const visible = []; for (const r of rows) try { visible.push(await loadSite(tx, actor, r.id, 'sites.site.read', true)); } catch { /* scope */ }
      return paged(visible.slice((q.page - 1) * q.limit, q.page * q.limit), visible.length, q.page, q.limit);
    });
  }
  async get(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.read', true);
      const [domains, languages, release] = await Promise.all([tx.siteDomain.findMany({ where: { siteId: site.id }, select: { id: true, hostname: true, verificationState: true, certificateState: true, isPrimary: true, verifiedAt: true } }),
        tx.siteLanguage.findMany({ where: { siteId: site.id } }), site.activeReleaseId ? tx.siteRelease.findUnique({ where: { id: site.activeReleaseId }, select: { id: true, releaseNumber: true, activatedAt: true } }) : null]);
      return { ...site, domains, languages, activeRelease: release };
    });
  }
  async patch(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedSiteVersion: expectedVersion, name: z.string().trim().min(1).max(160).optional(), requiresApproval: z.boolean().optional(), defaultLocale: locale.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'sites:site:' + id);
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.edit'); assertVersion(site.siteVersion, input.expectedSiteVersion);
      if (input.defaultLocale && input.defaultLocale !== site.defaultLocale) {
        // Changing the default locale requires the language to exist; routes keep their locale and redirects are reviewed separately.
        if (!await tx.siteLanguage.findFirst({ where: { siteId: site.id, locale: input.defaultLocale, enabled: true } })) throw new AppError('POLICY_NOT_CONFIGURED', 'Add and enable the language first.', 409);
        await tx.siteLanguage.updateMany({ where: { siteId: site.id }, data: { isDefault: false } }); await tx.siteLanguage.updateMany({ where: { siteId: site.id, locale: input.defaultLocale }, data: { isDefault: true } });
      }
      const { expectedSiteVersion: _v, ...data } = input; void _v;
      const updated = await tx.site.update({ where: { id: site.id }, data: { ...data, siteVersion: { increment: 1 } } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_CHANGED', { fields: Object.keys(data) }); return updated;
    });
  }

  /** Adds a PENDING custom domain: unique across the platform (takeover-safe); public routing waits for verification. */
  async addDomain(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ hostname, isPrimary: z.boolean().default(false) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.domain.manage');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.domain.manage');
      await lock(tx, GLOBAL, 'sites:hostnames');
      if (input.hostname === PLATFORM_DOMAIN || input.hostname.endsWith('.' + PLATFORM_DOMAIN)) throw new AppError('VALIDATION_FAILED', 'Platform subdomains are assigned automatically.', 400, { fields: [{ field: 'hostname', reason: 'PLATFORM_NAMESPACE' }] });
      if (await tx.siteDomain.findUnique({ where: { hostname: input.hostname } }) || await tx.siteHostRoute.findFirst({ where: { hostname: input.hostname } }) || await tx.commerceStorefront.findUnique({ where: { domain: input.hostname } }))
        throw new AppError('DOMAIN_CONFLICT', 'Hostname is already registered.', 409);
      const token = newToken('truecrm-verify-');
      const row = await tx.siteDomain.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, hostname: input.hostname, verificationTokenHash: sha256(token), isPrimary: input.isPrimary } });
      await evidence(tx, actor, 'SITE', site.id, 'DOMAIN_ADDED', { domainId: row.id, hostname: row.hostname });
      return { id: row.id, hostname: row.hostname, verificationState: row.verificationState, dnsChallenge: { type: 'TXT', name: '_truecrm-verify.' + row.hostname, value: token } };
    });
  }
  async verifyDomain(actor: Principal, domainId: string) {
    const domain = await this.db.siteDomain.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, domainId) } });
    if (!domain) throw notFound('Domain');
    const records = await currentDnsVerifier().txtRecords(domain.hostname);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.domain.manage');
      const row = await tx.siteDomain.findFirstOrThrow({ where: { id: domain.id, workspaceId: actor.workspaceId } });
      await loadSite(tx, actor, row.siteId, 'sites.site.domain.manage');
      await lock(tx, GLOBAL, 'sites:hostnames');
      const verified = records.some(r => safeEqual(sha256(r), row.verificationTokenHash));
      if (!verified) {
        await tx.siteDomain.update({ where: { id: row.id }, data: { verificationState: 'FAILED' } });
        await evidence(tx, actor, 'SITE', row.siteId, 'DOMAIN_VERIFICATION_FAILED', { domainId: row.id });
        throw new AppError('DOMAIN_NOT_VERIFIED', 'DNS challenge was not found.', 409);
      }
      if (await tx.siteHostRoute.findFirst({ where: { hostname: row.hostname, pathPrefix: '/', siteId: { not: row.siteId } } })) throw new AppError('ROUTE_COLLISION', 'Hostname route is owned by another site.', 409);
      await tx.siteDomain.update({ where: { id: row.id }, data: { verificationState: 'VERIFIED', verifiedAt: new Date(), certificateState: 'PENDING' } });
      await tx.siteHostRoute.upsert({ where: { hostname_pathPrefix: { hostname: row.hostname, pathPrefix: '/' } }, create: { workspaceId: actor.workspaceId, siteId: row.siteId, domainId: row.id, hostname: row.hostname, pathPrefix: '/' }, update: { status: 'ACTIVE' } });
      await evidence(tx, actor, 'SITE', row.siteId, 'DOMAIN_VERIFIED', { domainId: row.id, hostname: row.hostname });
      return { id: row.id, hostname: row.hostname, verificationState: 'VERIFIED', certificateState: 'PENDING' };
    });
  }
  async hostingStatus(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.read', true);
      const [domains, routes] = await Promise.all([tx.siteDomain.findMany({ where: { siteId: site.id } }), tx.siteHostRoute.findMany({ where: { siteId: site.id } })]);
      return { siteId: site.id, status: site.status, activeReleaseId: site.activeReleaseId, platformHost: `${site.subdomain}.${PLATFORM_DOMAIN}`,
        domains: domains.map(d => ({ hostname: d.hostname, verificationState: d.verificationState, certificateState: d.certificateState, serving: d.verificationState === 'VERIFIED' && site.status === 'PUBLISHED' })),
        routes: routes.map(r => ({ hostname: r.hostname, pathPrefix: r.pathPrefix, status: r.status })), tlsProvider: process.env.SITES_TLS_PROVIDER ? 'CONFIGURED' : 'NOT_CONFIGURED' };
    });
  }
  async unpublish(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedSiteVersion: expectedVersion, reason: z.string().trim().min(1).max(500) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'sites:site:' + id);
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.publish'); assertVersion(site.siteVersion, input.expectedSiteVersion);
      if (site.status !== 'PUBLISHED') throw new AppError('INVALID_STATE_TRANSITION', 'Site is not published.', 409);
      const updated = await tx.site.update({ where: { id: site.id }, data: { status: 'UNPUBLISHED', siteVersion: { increment: 1 } } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_UNPUBLISHED', { reason: input.reason });
      await evidence(tx, actor, 'SITE', site.id, 'CDN_INVALIDATION_REQUESTED', { scope: 'ALL' }, false);
      return updated;
    });
  }
  async archive(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedSiteVersion: expectedVersion, reason: z.string().trim().min(1).max(500), recoverDays: z.number().int().min(1).max(365).default(30) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'sites:site:' + id);
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.delete'); assertVersion(site.siteVersion, input.expectedSiteVersion);
      if (site.status === 'PUBLISHED') throw new AppError('INVALID_STATE_TRANSITION', 'Unpublish the live site (or configure redirects) before archiving.', 409);
      const updated = await tx.site.update({ where: { id: site.id }, data: { status: 'ARCHIVED', archivedAt: new Date(), recoverBefore: new Date(Date.now() + input.recoverDays * 86400000), siteVersion: { increment: 1 } } });
      await tx.siteHostRoute.updateMany({ where: { siteId: site.id }, data: { status: 'DISABLED' } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_ARCHIVED', { reason: input.reason, recoverBefore: updated.recoverBefore });
      return updated;
    });
  }
  async restore(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.restore', true);
      if (!site.archivedAt) throw new AppError('INVALID_STATE_TRANSITION', 'Site is not archived.', 409);
      if (site.recoverBefore && site.recoverBefore < new Date()) throw new AppError('RESOURCE_EXPIRED', 'Recovery window has passed.', 410);
      const updated = await tx.site.update({ where: { id: site.id }, data: { status: site.activeReleaseId ? 'UNPUBLISHED' : 'DRAFT', archivedAt: null, recoverBefore: null, siteVersion: { increment: 1 } } });
      await tx.siteHostRoute.updateMany({ where: { siteId: site.id }, data: { status: 'ACTIVE' } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_RESTORED', {});
      return updated;
    });
  }
  /** Content/config portability export (no secrets, no runtime). Download via signed expiring token. */
  async exportSite(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ releaseId: uuid.optional(), format: z.literal('JSON').default('JSON') }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.export', true);
      const release = input.releaseId ? await tx.siteRelease.findFirst({ where: { siteId: site.id, id: input.releaseId } }) : site.activeReleaseId ? await tx.siteRelease.findUnique({ where: { id: site.activeReleaseId } }) : null;
      if (input.releaseId && !release) throw notFound('Release');
      const revisions = release ? await tx.sitePageRevision.findMany({ where: { id: { in: ((release.manifest as { pages?: { revisionId: string }[] }).pages ?? []).map(p => p.revisionId) } } }) : [];
      const [languages, menus, seo, cookie] = await Promise.all([tx.siteLanguage.findMany({ where: { siteId: site.id } }), tx.siteNavigationMenu.findMany({ where: { siteId: site.id } }), tx.siteSeoSettings.findUnique({ where: { siteId: site.id } }), tx.siteCookiePolicy.findUnique({ where: { siteId: site.id } })]);
      const content = { format: 'TRUECRM_SITE_EXPORT_V1', exportedAt: new Date(), site: { name: site.name, type: site.type, defaultLocale: site.defaultLocale }, release: release ? { releaseNumber: release.releaseNumber, manifest: release.manifest } : null,
        pages: revisions.map(r => ({ pageId: r.pageId, locale: r.locale, revision: r.revision, blockTree: r.blockTree, seo: r.seo })), languages: languages.map(l => ({ locale: l.locale, isDefault: l.isDefault, rtl: l.rtl, fallbackPolicy: l.fallbackPolicy })),
        navigation: menus.map(m => ({ name: m.name, locale: m.locale, items: m.items })), seo: seo ? { robotsDefault: seo.robotsDefault, sitemapEnabled: seo.sitemapEnabled } : null, cookiePolicy: cookie ? { categories: cookie.categories, version: cookie.version } : null,
        excluded: ['provider credentials', 'script secrets', 'domain verification tokens', 'visitor data', 'standalone runtime (managed hosting only)'] };
      const token = newToken('sx_');
      const job = await tx.siteExportJob.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, releaseId: release?.id, format: 'JSON', status: 'READY', content: JSON.parse(JSON.stringify(content)), downloadTokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600000), requestedByUserId: actor.userId } });
      await evidence(tx, actor, 'SITE', site.id, 'SITE_EXPORT_READY', { jobId: job.id });
      return { jobId: job.id, status: job.status, downloadPath: `/api/v1/public/sites/exports/${job.id}?token=${token}`, expiresAt: job.expiresAt };
    });
  }
  async downloadExport(jobId: string, token: string) {
    const job = await this.db.siteExportJob.findUnique({ where: { id: parse(uuid, jobId) } });
    if (!job || !job.downloadTokenHash || !safeEqual(job.downloadTokenHash, sha256(token))) throw notFound('Export');
    if (job.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Export link expired.', 410);
    return job.content;
  }
  /** Entitlement capability set (no plan-name checks): 15-day configurable grace; published sites may stay read-only; new publish/checkout blocked. */
  async entitlementImpact(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, id), 'sites.site.read', true);
      return SitesSiteService.capabilities(actor.entitlements ?? {}, site.id);
    });
  }
  static capabilities(ent: Record<string, unknown>, siteId: string) {
    const graceDays = typeof ent.sitesGraceDays === 'number' ? ent.sitesGraceDays : 15;
    const expiredAt = typeof ent.sitesExpiredAt === 'string' ? new Date(ent.sitesExpiredAt) : null;
    const graceEndsAt = expiredAt ? new Date(expiredAt.getTime() + graceDays * 86400000) : null;
    const state = ent.sites === false ? (graceEndsAt && graceEndsAt > new Date() ? 'GRACE' : 'READ_ONLY') : 'STANDARD';
    return { siteId, capabilityState: state, graceDays, graceEndsAt, publish: state === 'STANDARD' || state === 'GRACE' ? 'ALLOWED' : 'BLOCKED',
      publicContent: state === 'READ_ONLY' && ent.sitesPublicAfterGrace === false ? 'OFFLINE' : 'SERVED_READ_ONLY', checkoutBlocks: ent.commerce === false || ent.commerceCheckout === false ? 'DISABLED' : 'ENABLED' };
  }
}
