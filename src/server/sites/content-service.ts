import { Prisma, type PrismaClient, type SitePage } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { assertNoExecutable, expectedVersion, inTx, notFound, safeUrl } from '../suite/kernel';
import { BLOCK_DEFINITIONS, contentHash, loadSite, locale, pageSlug, validateBlockTree } from './support';

const pathSchema = z.string().max(500).regex(/^\/[^\s?#]*$/);
const TEMPLATES: Record<string, { name: string; pages: { slug: string; title: string; blocks: unknown[] }[] }> = {
  LANDING_BASIC: { name: 'Basic landing page', pages: [{ slug: '', title: 'Home', blocks: [{ type: 'headline', text: 'Welcome', level: 1 }, { type: 'text', text: 'Describe your offer here.' }, { type: 'button', label: 'Contact us', href: '/contact' }] }] },
  COMPANY_SITE: { name: 'Company site', pages: [{ slug: '', title: 'Home', blocks: [{ type: 'headline', text: 'Our company', level: 1 }] }, { slug: 'about', title: 'About', blocks: [{ type: 'text', text: 'About us.' }] }, { slug: 'contact', title: 'Contact', blocks: [{ type: 'headline', text: 'Contact', level: 2 }] }] },
};

/** Pages, folders, navigation, redirects, CMS entries, revisions, blocks, shared blocks and themes (Sites/02, /03, /04). */
export class SitesContentService {
  constructor(private readonly db: PrismaClient) {}

  async page(tx: Tx, actor: Principal, id: string, permission: string, includeDeleted = false) {
    const page = await tx.sitePage.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
    if (!page || page.deletedAt && !includeDeleted) throw notFound('Page');
    const site = await loadSite(tx, actor, page.siteId, permission);
    return { page, site };
  }
  private async parentKey(tx: Tx, siteId: string, folderId?: string | null) {
    if (!folderId) return '';
    const names: string[] = []; let current: string | null = folderId; const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) throw new AppError('VALIDATION_FAILED', 'Folder hierarchy contains a cycle.', 400);
      seen.add(current);
      const folder: { id: string; slug: string; parentId: string | null } | null = await tx.siteFolder.findFirst({ where: { siteId, id: current }, select: { id: true, slug: true, parentId: true } });
      if (!folder) throw notFound('Folder');
      names.unshift(folder.slug); current = folder.parentId;
    }
    return names.join('/');
  }
  static path(page: Pick<SitePage, 'parentKey' | 'slug'>) { return '/' + [page.parentKey, page.slug].filter(Boolean).join('/'); }

  async createPage(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ slug: pageSlug, title: z.string().trim().min(1).max(200), type: z.enum(['STANDARD', 'BLOG_LIST', 'BLOG_ARTICLE', 'PRODUCT', 'CHECKOUT']).default('STANDARD'), locale: locale.optional(), parentFolderId: uuid.optional(), sortRank: z.number().int().min(0).default(0), blockTreeJson: z.unknown().optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.create');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.create');
      const pageLocale = input.locale ?? site.defaultLocale;
      if (!await tx.siteLanguage.findFirst({ where: { siteId: site.id, locale: pageLocale } })) throw new AppError('POLICY_NOT_CONFIGURED', 'Add the language to the site first.', 409);
      const parentKey = await this.parentKey(tx, site.id, input.parentFolderId);
      if (await tx.sitePage.findFirst({ where: { siteId: site.id, locale: pageLocale, parentKey, slug: input.slug } })) throw new AppError('ROUTE_COLLISION', 'A page with this route already exists for the locale.', 409);
      const page = await tx.sitePage.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, parentFolderId: input.parentFolderId, parentKey, slug: input.slug, type: input.type, locale: pageLocale, title: input.title, sortRank: input.sortRank, createdByUserId: actor.userId } });
      const tree = await validateBlockTree(tx, actor, input.blockTreeJson ?? { blocks: [] });
      await this.newRevision(tx, actor, page, tree, {});
      await evidence(tx, actor, 'SITE', site.id, 'SITE_PAGE_CREATED', { pageId: page.id, path: SitesContentService.path(page), locale: pageLocale });
      return tx.sitePage.findUniqueOrThrow({ where: { id: page.id } });
    });
  }
  async listPages(actor: Principal, siteId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.read');
      const pages = await tx.sitePage.findMany({ where: { siteId: site.id, deletedAt: null }, orderBy: [{ locale: 'asc' }, { sortRank: 'asc' }, { slug: 'asc' }] });
      return pages.map(p => ({ ...p, path: SitesContentService.path(p) }));
    });
  }
  async patchPage(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ slug: pageSlug.optional(), title: z.string().trim().min(1).max(200).optional(), parentFolderId: uuid.nullable().optional(), sortRank: z.number().int().min(0).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const { page, site } = await this.page(tx, actor, id, 'sites.page.edit');
      const parentKey = input.parentFolderId !== undefined ? await this.parentKey(tx, site.id, input.parentFolderId) : page.parentKey;
      const slug = input.slug ?? page.slug;
      if ((slug !== page.slug || parentKey !== page.parentKey) && await tx.sitePage.findFirst({ where: { siteId: site.id, locale: page.locale, parentKey, slug, id: { not: page.id } } })) throw new AppError('ROUTE_COLLISION', 'A page with this route already exists for the locale.', 409);
      const updated = await tx.sitePage.update({ where: { id: page.id }, data: { slug, parentKey, title: input.title, sortRank: input.sortRank, ...(input.parentFolderId !== undefined ? { parentFolderId: input.parentFolderId } : {}) } });
      if (slug !== page.slug || parentKey !== page.parentKey) await evidence(tx, actor, 'SITE', site.id, 'PAGE_ROUTE_CHANGED', { pageId: page.id, from: SitesContentService.path(page), to: SitesContentService.path(updated) });
      return { ...updated, path: SitesContentService.path(updated), note: 'Route changes take effect with the next release.' };
    });
  }
  async folder(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ slug: pageSlug.refine(v => v.length > 0), name: z.string().trim().min(1).max(160), parentId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.create');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.create');
      if (input.parentId) await this.parentKey(tx, site.id, input.parentId);
      if (await tx.siteFolder.findFirst({ where: { siteId: site.id, parentId: input.parentId ?? null, slug: input.slug } })) throw new AppError('ROUTE_COLLISION', 'Folder already exists.', 409);
      return tx.siteFolder.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, ...input } });
    });
  }
  /** Navigation items target same-site pages or allowlisted external https URLs. */
  async navigation(actor: Principal, siteId: string, raw: unknown) {
    const item: z.ZodType<{ label: string; pageId?: string; externalUrl?: string; children?: unknown[] }> = z.lazy(() => z.strictObject({ label: z.string().trim().min(1).max(120), pageId: uuid.optional(), externalUrl: z.string().max(2000).optional(), children: z.array(item).max(30).optional() }));
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(60), locale, items: z.array(item).max(50) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const check = async (items: { label: string; pageId?: string; externalUrl?: string; children?: unknown[] }[]): Promise<void> => {
        for (const i of items) {
          assertNoExecutable(i.label, 'items.label');
          if (!!i.pageId === !!i.externalUrl) throw new AppError('VALIDATION_FAILED', 'Each item targets exactly one page or external URL.', 400);
          if (i.pageId && !await tx.sitePage.findFirst({ where: { siteId: site.id, id: i.pageId, deletedAt: null } })) throw notFound('Navigation page');
          if (i.externalUrl) safeUrl(i.externalUrl, false);
          if (i.children) await check(i.children as typeof items);
        }
      };
      await check(input.items);
      const existing = await tx.siteNavigationMenu.findUnique({ where: { siteId_name_locale: { siteId: site.id, name: input.name, locale: input.locale } } });
      const row = existing ? await tx.siteNavigationMenu.update({ where: { id: existing.id }, data: { items: input.items as Prisma.InputJsonValue, revision: { increment: 1 } } })
        : await tx.siteNavigationMenu.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, name: input.name, locale: input.locale, items: input.items as Prisma.InputJsonValue } });
      await evidence(tx, actor, 'SITE', site.id, 'NAVIGATION_CHANGED', { menu: row.name, locale: row.locale, revision: row.revision });
      return row;
    });
  }
  /** Replaces redirects; chains and cycles rejected; external targets must be safe absolute URLs (no open redirect to arbitrary input). */
  async redirects(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ redirects: z.array(z.strictObject({ fromPath: pathSchema, toPath: z.string().max(2000), statusCode: z.union([z.literal(301), z.literal(302)]) })).max(1000) }), raw);
    const map = new Map(input.redirects.map(r => [r.fromPath, r.toPath]));
    if (map.size !== input.redirects.length) throw new AppError('VALIDATION_FAILED', 'Duplicate redirect sources.', 400);
    for (const [from, to] of map) {
      if (!to.startsWith('/')) safeUrl(to, false); else if (!pathSchema.safeParse(to).success) throw new AppError('VALIDATION_FAILED', 'Invalid redirect target.', 400);
      let hops = 0, cursor = to;
      while (map.has(cursor)) { cursor = map.get(cursor)!; if (cursor === from || ++hops > 0) throw new AppError('REDIRECT_LOOP', 'Redirect chains and loops are not allowed.', 409, { fromPath: from }); }
      if (to === from) throw new AppError('REDIRECT_LOOP', 'Redirect points to itself.', 409, { fromPath: from });
    }
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      await tx.siteRedirect.deleteMany({ where: { siteId: site.id, reason: 'MANUAL' } });
      for (const r of input.redirects) await tx.siteRedirect.upsert({ where: { siteId_fromPath: { siteId: site.id, fromPath: r.fromPath } }, create: { workspaceId: actor.workspaceId, siteId: site.id, ...r }, update: { toPath: r.toPath, statusCode: r.statusCode, reason: 'MANUAL' } });
      await evidence(tx, actor, 'SITE', site.id, 'REDIRECT_CHANGED', { count: input.redirects.length });
      return tx.siteRedirect.findMany({ where: { siteId: site.id } });
    });
  }
  async contentEntry(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ kind: z.enum(['ARTICLE', 'NEWS']), slug: pageSlug.refine(v => v.length > 0), locale, category: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(300), body: z.unknown(), publish: z.boolean().default(false) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const body = await validateBlockTree(tx, actor, input.body);
      if (input.publish) requirePermission(actor, 'sites.content.publish');
      const existing = await tx.siteContentEntry.findUnique({ where: { siteId_kind_locale_slug: { siteId: site.id, kind: input.kind, locale: input.locale, slug: input.slug } } });
      const data = { category: input.category, title: input.title, body: body as unknown as Prisma.InputJsonValue, publicationState: input.publish ? 'PUBLISHED' : 'DRAFT' };
      const row = existing ? await tx.siteContentEntry.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } } })
        : await tx.siteContentEntry.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, kind: input.kind, slug: input.slug, locale: input.locale, authorUserId: actor.userId, ...data } });
      await evidence(tx, actor, 'SITE', site.id, input.publish ? 'CONTENT_ENTRY_PUBLISHED' : 'CONTENT_ENTRY_SAVED', { entryId: row.id, revision: row.revision });
      return row;
    });
  }

  // ------------------------------------------------------------------ revisions & blocks
  private async newRevision(tx: Tx, actor: Principal, page: SitePage, tree: { blocks: unknown[] }, seo: Record<string, unknown>, origin = 'EDITOR') {
    const revision = page.latestRevision + 1;
    const row = await tx.sitePageRevision.create({ data: { workspaceId: actor.workspaceId, siteId: page.siteId, pageId: page.id, locale: page.locale, revision, blockTree: tree as Prisma.InputJsonValue, seo: seo as Prisma.InputJsonValue, contentHash: contentHash({ tree, seo }), origin, createdByUserId: actor.userId } });
    await tx.sitePage.update({ where: { id: page.id }, data: { latestRevision: revision } });
    await evidence(tx, actor, 'SITE', page.siteId, 'PAGE_REVISION_CREATED', { pageId: page.id, revision, origin });
    return row;
  }
  async latest(tx: Tx, pageId: string) { return tx.sitePageRevision.findFirst({ where: { pageId }, orderBy: { revision: 'desc' } }); }
  /** Draft save always creates a new revision; the ACTIVE release and public content are untouched. */
  async createRevision(actor: Principal, pageId: string, raw: unknown) {
    const input = parse(z.strictObject({ blockTreeJson: z.unknown(), expectedDraftRevision: z.number().int().min(0).optional(), seo: z.record(z.string(), z.unknown()).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'sites:page:' + pageId);
      if (!actor.grants.has('sites.page.edit')) requirePermission(actor, 'sites.block.edit');
      const { page } = await this.page(tx, actor, pageId, actor.grants.has('sites.page.edit') ? 'sites.page.edit' : 'sites.block.edit');
      if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== page.latestRevision) throw new AppError('VERSION_CONFLICT', 'A newer draft exists; reload to avoid overwriting edits.', 409, { currentRevision: page.latestRevision });
      const tree = await validateBlockTree(tx, actor, input.blockTreeJson);
      const previous = await this.latest(tx, page.id);
      return this.newRevision(tx, actor, page, tree, input.seo ?? (previous?.seo as Record<string, unknown>) ?? {});
    });
  }
  async addBlock(actor: Principal, pageId: string, raw: unknown, blockKey?: string) {
    const input = parse(z.strictObject({ block: z.record(z.string(), z.unknown()), position: z.number().int().min(0).optional(), expectedDraftRevision: z.number().int().min(0) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.block.edit'); await lock(tx, actor.workspaceId, 'sites:page:' + pageId);
      const { page } = await this.page(tx, actor, pageId, 'sites.block.edit');
      if (input.expectedDraftRevision !== page.latestRevision) throw new AppError('VERSION_CONFLICT', 'A newer draft exists; reload.', 409, { currentRevision: page.latestRevision });
      const previous = await this.latest(tx, page.id), blocks = [...(((previous?.blockTree as { blocks?: Record<string, unknown>[] })?.blocks) ?? [])];
      if (blockKey) {
        const index = blocks.findIndex(b => b.key === blockKey);
        if (index < 0) throw notFound('Block');
        blocks[index] = { ...input.block, key: blockKey, type: blocks[index].type };
      } else blocks.splice(input.position ?? blocks.length, 0, input.block);
      const tree = await validateBlockTree(tx, actor, { blocks });
      const revision = await this.newRevision(tx, actor, page, tree, (previous?.seo as Record<string, unknown>) ?? {});
      await evidence(tx, actor, 'SITE', page.siteId, 'BLOCK_CHANGED', { pageId: page.id, revision: revision.revision });
      return revision;
    });
  }
  blockCatalog() {
    return Object.entries(BLOCK_DEFINITIONS).map(([kind, d]) => ({ kind, version: d.version, status: 'ACTIVE', capabilities: d.capabilities, schema: z.toJSONSchema(d.schema as z.ZodType, { io: 'input' }) }));
  }
  async createSharedBlock(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(160), kind: z.string(), ownerSiteId: uuid.optional(), propsJson: z.record(z.string(), z.unknown()) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.block.edit');
      if (input.ownerSiteId) await loadSite(tx, actor, input.ownerSiteId, 'sites.block.edit');
      if (input.kind === 'shared') throw new AppError('VALIDATION_FAILED', 'Shared blocks cannot nest shared blocks.', 400);
      const { blocks } = await validateBlockTree(tx, actor, { blocks: [{ type: input.kind, props: input.propsJson }] });
      const row = await tx.siteSharedBlock.create({ data: { workspaceId: actor.workspaceId, ownerSiteId: input.ownerSiteId, name: input.name, kind: input.kind, latestRevision: 1 } });
      await tx.siteSharedBlockRevision.create({ data: { workspaceId: actor.workspaceId, sharedBlockId: row.id, revision: 1, props: blocks[0].props as Prisma.InputJsonValue, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'SITE_SHARED_BLOCK', row.id, 'SHARED_BLOCK_VERSION_CREATED', { revision: 1 });
      return row;
    });
  }
  /** Shared-block edits create drafts only; live pages change after a publish of the shared block AND a site release. */
  async sharedBlockRevision(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ propsJson: z.record(z.string(), z.unknown()), publish: z.boolean().default(false) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.block.edit'); await lock(tx, actor.workspaceId, 'sites:shared:' + id);
      const block = await tx.siteSharedBlock.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!block) throw notFound('Shared block');
      if (block.ownerSiteId) await loadSite(tx, actor, block.ownerSiteId, 'sites.block.edit');
      const { blocks } = await validateBlockTree(tx, actor, { blocks: [{ type: block.kind, props: input.propsJson }] });
      const revision = block.latestRevision + 1;
      const row = await tx.siteSharedBlockRevision.create({ data: { workspaceId: actor.workspaceId, sharedBlockId: block.id, revision, props: blocks[0].props as Prisma.InputJsonValue, createdByUserId: actor.userId, status: input.publish ? 'APPROVED' : 'DRAFT' } });
      if (input.publish) requirePermission(actor, 'sites.sharedblock.publish');
      await tx.siteSharedBlock.update({ where: { id: block.id }, data: { latestRevision: revision, ...(input.publish ? { publishedRevision: revision } : {}) } });
      await evidence(tx, actor, 'SITE_SHARED_BLOCK', block.id, 'SHARED_BLOCK_VERSION_CREATED', { revision, approved: input.publish });
      return row;
    });
  }
  async publishSharedBlock(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ revision: z.number().int().positive() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.sharedblock.publish');
      const block = await tx.siteSharedBlock.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!block) throw notFound('Shared block');
      const rev = await tx.siteSharedBlockRevision.findUnique({ where: { sharedBlockId_revision: { sharedBlockId: block.id, revision: input.revision } } });
      if (!rev) throw notFound('Shared block revision');
      await tx.siteSharedBlockRevision.update({ where: { id: rev.id }, data: { status: 'APPROVED' } });
      const updated = await tx.siteSharedBlock.update({ where: { id: block.id }, data: { publishedRevision: input.revision } });
      await evidence(tx, actor, 'SITE_SHARED_BLOCK', block.id, 'SHARED_BLOCK_APPROVED', { revision: input.revision, note: 'Pinned into sites on their next release.' });
      return updated;
    });
  }
  async theme(actor: Principal, siteId: string, raw: unknown) {
    const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
    const input = parse(z.strictObject({ tokens: z.strictObject({ primaryColor: color, textColor: color, backgroundColor: color, fontFamily: z.enum(['system', 'serif', 'sans', 'mono', 'arabic']), radius: z.enum(['none', 'sm', 'md', 'lg']) }),
      breakpoints: z.strictObject({ mobile: z.number().int().min(240).max(800), tablet: z.number().int().min(600).max(1400), desktop: z.number().int().min(1000).max(2560) }) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.site.edit');
      const last = await tx.siteTheme.findFirst({ where: { siteId: site.id }, orderBy: { revision: 'desc' } });
      const row = await tx.siteTheme.create({ data: { workspaceId: actor.workspaceId, siteId: site.id, revision: (last?.revision ?? 0) + 1, tokens: input.tokens, breakpoints: input.breakpoints } });
      await evidence(tx, actor, 'SITE', site.id, 'THEME_VERSION_CHANGED', { revision: row.revision, note: 'Previewable; released with the next site release.' });
      return row;
    });
  }
  async fromTemplate(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ templateKey: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]) }), raw);
    const template = TEMPLATES[input.templateKey];
    const created = [];
    for (const p of template.pages) created.push(await this.createPage(actor, siteId, { slug: p.slug, title: p.title, blockTreeJson: { blocks: p.blocks } }));
    return { templateKey: input.templateKey, pages: created.map(p => p.id) };
  }
  templates() { return Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, pages: t.pages.length, license: 'TrueCRM built-in' })); }

  // ------------------------------------------------------------------ trash & recovery
  async archivePage(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ redirectTo: z.string().max(2000).optional(), statusCode: z.union([z.literal(301), z.literal(302)]).default(301), reason: z.string().trim().min(1).max(500) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.delete');
      const { page, site } = await this.page(tx, actor, id, 'sites.page.delete');
      const path = SitesContentService.path(page);
      const live = site.activeReleaseId ? ((await tx.siteRelease.findUnique({ where: { id: site.activeReleaseId } }))?.manifest as { pages?: { pageId: string }[] })?.pages?.some(p => p.pageId === page.id) : false;
      if (input.redirectTo) {
        if (!input.redirectTo.startsWith('/')) safeUrl(input.redirectTo, false);
        await tx.siteRedirect.upsert({ where: { siteId_fromPath: { siteId: site.id, fromPath: path } }, create: { workspaceId: actor.workspaceId, siteId: site.id, fromPath: path, toPath: input.redirectTo, statusCode: input.statusCode, reason: 'DELETED_PAGE' }, update: { toPath: input.redirectTo, statusCode: input.statusCode } });
      }
      const updated = await tx.sitePage.update({ where: { id: page.id }, data: { deletedAt: new Date(), deletedByUserId: actor.userId, status: 'ARCHIVED' } });
      await evidence(tx, actor, 'SITE', site.id, 'PAGE_ARCHIVED', { pageId: page.id, path, live: Boolean(live), redirect: input.redirectTo ?? null, reason: input.reason });
      return { ...updated, note: live ? 'Route stays live until the next release; it then returns the configured redirect or 410.' : undefined };
    });
  }
  async restorePage(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.site.restore');
      const { page, site } = await this.page(tx, actor, id, 'sites.page.edit', true);
      if (!page.deletedAt) throw new AppError('INVALID_STATE_TRANSITION', 'Page is not archived.', 409);
      if (await tx.sitePage.findFirst({ where: { siteId: site.id, locale: page.locale, parentKey: page.parentKey, slug: page.slug, id: { not: page.id }, deletedAt: null } })) throw new AppError('ROUTE_COLLISION', 'Route is now used by another page.', 409);
      const updated = await tx.sitePage.update({ where: { id: page.id }, data: { deletedAt: null, deletedByUserId: null, status: 'DRAFT' } });
      await evidence(tx, actor, 'SITE', site.id, 'PAGE_RESTORED', { pageId: page.id });
      return updated;
    });
  }
  async redirectsFromDeleted(actor: Principal, siteId: string, raw: unknown) {
    const input = parse(z.strictObject({ targetPath: pathSchema, statusCode: z.union([z.literal(301), z.literal(302)]).default(301) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'sites.page.edit');
      const site = await loadSite(tx, actor, parse(uuid, siteId), 'sites.page.edit');
      const deleted = await tx.sitePage.findMany({ where: { siteId: site.id, deletedAt: { not: null } } });
      let created = 0;
      for (const p of deleted) { const from = SitesContentService.path(p); if (from === input.targetPath) continue; await tx.siteRedirect.upsert({ where: { siteId_fromPath: { siteId: site.id, fromPath: from } }, create: { workspaceId: actor.workspaceId, siteId: site.id, fromPath: from, toPath: input.targetPath, statusCode: input.statusCode, reason: 'DELETED_PAGE' }, update: {} }); created++; }
      await evidence(tx, actor, 'SITE', site.id, 'REDIRECT_CHANGED', { fromDeleted: created });
      return { created };
    });
  }
}
