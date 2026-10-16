import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { entitled } from '../suite/kernel';
import { bumpCacheVersion, emitEvent, notFound, type Tx } from '../platform/kernel';

export type { Tx };
export const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export const LEVELS = { NONE: 0, VIEW: 1, COMMENT: 2, EDIT: 3, MANAGE: 4 } as const;
export type Level = keyof typeof LEVELS;
export const levelName = (n: number) => (Object.keys(LEVELS) as Level[]).find(k => LEVELS[k] === n) ?? 'NONE';
export type Space = Prisma.KnowledgeSpaceGetPayload<object>;
export type Article = Prisma.KnowledgeArticleGetPayload<object>;
export const MAX_DEPTH = 12, RECYCLE_DAYS_DEFAULT = 30;

// ------------------------------------------------------------------ content schema (whitelist; plain text only, never HTML)
const text = (max: number) => z.string().max(max).transform(v => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));
const safeUrl = z.string().max(2000).refine(u => /^https:\/\//i.test(u) || /^\/[^/]/.test(u), 'Links must be https:// or a relative app path.');
const anchor = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const link = z.strictObject({ text: text(300), href: safeUrl });
export const BLOCK = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('heading'), level: z.number().int().min(1).max(4), text: text(300).pipe(z.string().min(1)), anchor: anchor.optional() }),
  z.strictObject({ type: z.literal('paragraph'), text: text(20000), links: z.array(link).max(50).default([]) }),
  z.strictObject({ type: z.literal('list'), ordered: z.boolean().default(false), items: z.array(text(2000)).min(1).max(500) }),
  z.strictObject({ type: z.literal('checklist'), items: z.array(z.strictObject({ text: text(2000), checked: z.boolean().default(false) })).min(1).max(500) }),
  z.strictObject({ type: z.literal('quote'), text: text(5000) }),
  z.strictObject({ type: z.literal('table'), header: z.array(text(300)).max(30).default([]), rows: z.array(z.array(text(2000)).max(30)).max(500) }),
  z.strictObject({ type: z.literal('code'), language: z.string().regex(/^[a-z0-9+#-]{0,30}$/).default(''), text: text(50000) }),
  z.strictObject({ type: z.enum(['image', 'video', 'file']), fileId: z.uuid(), caption: text(500).default('') }),
  z.strictObject({ type: z.literal('callout'), tone: z.enum(['info', 'warning', 'success', 'danger']).default('info'), text: text(5000) }),
]);
export type Block = z.infer<typeof BLOCK>;
export const CONTENT = z.strictObject({ blocks: z.array(BLOCK).max(5000) });
export type Content = z.infer<typeof CONTENT>;
const SCRIPTISH = /<\s*\/?\s*(script|iframe|object|embed|style)\b|javascript:|on[a-z]+\s*=/i;
/** Structural sanitization: content is plain text blocks; markup-looking text is kept inert but flagged for the safety scan. */
export function normalizeContent(raw: unknown, maxBytes: number): { content: Content; hash: string; safety: 'PASSED' | 'FLAGGED'; size: number } {
  const content = CONTENT.parse(raw);
  const json = JSON.stringify(content);
  if (Buffer.byteLength(json) > maxBytes) throw new AppError('INSUFFICIENT_QUOTA', 'Article content exceeds the plan size limit.', 422, { maxBytes });
  return { content, hash: sha(json), safety: SCRIPTISH.test(json) ? 'FLAGGED' : 'PASSED', size: Buffer.byteLength(json) };
}
const slugify = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section';
export const articleSlug = (title: string) => slugify(title).slice(0, 120);
/** Stable anchors: kept when supplied, else reused from the previous revision for an unchanged heading, else derived. */
export function assignAnchors(content: Content, previous: Array<{ anchor: string; title: string }>) {
  const used = new Set<string>(), sections: Array<{ anchor: string; level: number; order: number; title: string }> = [];
  let order = 0;
  for (const block of content.blocks) if (block.type === 'heading') {
    let a = block.anchor ?? previous.find(p => p.title === block.text && !used.has(p.anchor))?.anchor ?? (slugify(block.text).replace(/[^a-z0-9-]/g, '') || 'section');
    if (used.has(a)) { let i = 2; while (used.has(`${a}-${i}`)) i++; a = `${a}-${i}`; }
    used.add(a); block.anchor = a; sections.push({ anchor: a, level: block.level, order: order++, title: block.text });
  }
  return sections;
}
export function plainText(content: Content) {
  return content.blocks.map(b => 'text' in b ? b.text : 'items' in b ? (b.items as Array<string | { text: string }>).map(i => typeof i === 'string' ? i : i.text).join('\n') : 'rows' in b ? [b.header.join(' | '), ...b.rows.map(r => r.join(' | '))].join('\n') : 'caption' in b ? b.caption : '').join('\n\n');
}
export const fileIdsOf = (content: Content) => content.blocks.flatMap(b => 'fileId' in b ? [{ fileId: b.fileId, kind: b.type === 'file' ? 'ATTACHMENT' : 'EMBED' }] : []);

// ------------------------------------------------------------------ authorization
/** Knowledge is a premium capability: new writes need the entitlement; existing readers keep read/export (continuity). */
export function assertKnowledgeWrite(actor: Principal) { entitled(actor, 'knowledge'); }
type Keys = { users: string[]; departments: string[]; projects: string[] };
const keyCache = new WeakMap<Principal, Promise<Keys>>();
async function principalKeys(tx: Tx, actor: Principal): Promise<Keys> {
  const cached = keyCache.get(actor); if (cached) return cached;
  const p = (async () => {
    const direct = await tx.departmentMember.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, isDeleted: false }, select: { departmentId: true } });
    // Department tree: a binding to a department includes members of its sub-departments.
    const all = await tx.department.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false }, select: { id: true, parentDepartmentId: true } });
    const parent = new Map(all.map(d => [d.id, d.parentDepartmentId]));
    const departments = new Set<string>();
    for (const d of direct) { let cur: string | null | undefined = d.departmentId, guard = 0; while (cur && guard++ < 50) { departments.add(cur); cur = parent.get(cur); } }
    const projects = await tx.projectMember.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, status: 'ACTIVE' }, select: { projectId: true } });
    return { users: [actor.userId], departments: [...departments], projects: projects.map(p => p.projectId) };
  })();
  keyCache.set(actor, p); return p;
}
const matches = (keys: Keys, e: { principalType: string; principalId: string }) =>
  e.principalType === 'USER' ? keys.users.includes(e.principalId) : e.principalType === 'DEPARTMENT' ? keys.departments.includes(e.principalId) : e.principalType === 'PROJECT' ? keys.projects.includes(e.principalId) : false;
const live = (e: { expiresAt: Date | null }) => !e.expiresAt || e.expiresAt > new Date();

export async function spaceLevel(tx: Tx, actor: Principal, space: Space): Promise<number> {
  if (!actor.grants.has('knowledge.space.read') || space.workspaceId !== actor.workspaceId) return 0;
  const keys = await principalKeys(tx, actor);
  const entries = (await tx.knowledgeAclEntry.findMany({ where: { workspaceId: actor.workspaceId, resourceType: 'SPACE', resourceId: space.id } })).filter(e => live(e) && matches(keys, e));
  if (entries.some(e => e.effect === 'DENY')) return 0;
  let level = space.ownerUserId === actor.userId ? LEVELS.MANAGE : 0;
  for (const e of entries) level = Math.max(level, LEVELS[e.level as Level] ?? 0);
  if (space.visibility === 'SCOPED') {
    const bindings = await tx.knowledgeSpaceBinding.findMany({ where: { spaceId: space.id, active: true } });
    const inAudience = bindings.some(b => b.targetType === 'COMPANY' || b.targetType === 'DEPARTMENT' && keys.departments.includes(b.targetId!) || b.targetType === 'PROJECT' && keys.projects.includes(b.targetId!));
    if (inAudience) level = Math.max(level, actor.grants.has('knowledge.article.edit') ? LEVELS.EDIT : LEVELS.VIEW);
  }
  if (space.status === 'RECYCLED' && level < LEVELS.MANAGE) return 0;
  return level;
}
/**
 * Effective article level = space level, narrowed by article ALLOW entries (if any exist), removed by any DENY, raised only by
 * explicit shares/owner. Drafts need EDIT; recycled items need MANAGE. Evaluated live on every read (no cached ACL authority).
 */
export async function articleLevel(tx: Tx, actor: Principal, article: Article, space?: Space | null): Promise<number> {
  if (article.workspaceId !== actor.workspaceId || !actor.grants.has('knowledge.space.read')) return 0;
  const s = space ?? await tx.knowledgeSpace.findUnique({ where: { id: article.spaceId } });
  if (!s) return 0;
  const keys = await principalKeys(tx, actor);
  const ancestors = (await tx.knowledgeArticlePath.findMany({ where: { descendantId: article.id }, select: { ancestorId: true } })).map(a => a.ancestorId);
  const entries = (await tx.knowledgeAclEntry.findMany({ where: { workspaceId: actor.workspaceId, resourceType: 'ARTICLE', resourceId: { in: [article.id, ...ancestors] } } })).filter(live);
  const mine = entries.filter(e => matches(keys, e));
  if (mine.some(e => e.effect === 'DENY')) return 0;
  let level = await spaceLevel(tx, actor, s);
  // Restrictive entries on this article or an ancestor narrow inherited access (never widened by moving/parent sharing).
  for (const resourceId of [article.id, ...ancestors]) {
    const allows = entries.filter(e => e.resourceId === resourceId && e.effect === 'ALLOW');
    if (allows.length) level = Math.min(level, Math.max(0, ...allows.filter(e => matches(keys, e)).map(e => LEVELS[e.level as Level] ?? 0)));
  }
  if (article.ownerUserId === actor.userId && level > 0) level = LEVELS.MANAGE;
  const shares = await tx.knowledgeShare.findMany({ where: { articleId: article.id, sharedWithUserId: actor.userId, revokedAt: null } });
  for (const sh of shares.filter(live)) level = Math.max(level, LEVELS[sh.level as Level] ?? 0);
  if (article.status === 'RECYCLED' || article.status === 'PURGED') return level >= LEVELS.MANAGE ? level : 0;
  if (!article.publishedRevisionId && level < LEVELS.EDIT) return 0; // draft-only
  return level;
}
/** Loads an article for a minimum level; invisible articles are 404 so titles never leak (01 rule 4). */
export async function loadArticle(tx: Tx, actor: Principal, id: string, min: Level, permission?: string) {
  if (permission) requirePermission(actor, permission);
  const article = await tx.knowledgeArticle.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, status: { not: 'PURGED' } } });
  if (!article) throw notFound('Article');
  const level = await articleLevel(tx, actor, article);
  if (level < LEVELS[min]) { if (level >= LEVELS.VIEW) throw new AppError('PERMISSION_DENIED', `${min} access to this article is required.`, 403); throw notFound('Article'); }
  return { article, level };
}
export async function loadSpace(tx: Tx, actor: Principal, id: string, min: Level, permission?: string) {
  if (permission) requirePermission(actor, permission);
  const space = await tx.knowledgeSpace.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } });
  if (!space) throw notFound('Space');
  const level = await spaceLevel(tx, actor, space);
  if (level < LEVELS[min]) { if (level >= LEVELS.VIEW) throw new AppError('PERMISSION_DENIED', `${min} access to this space is required.`, 403); throw notFound('Space'); }
  return { space, level };
}
/** ACL change: bump versions, invalidate derived caches and enqueue reindex, all in the caller's transaction (03 rule 4). */
export async function aclChanged(tx: Tx, workspaceId: string, articleIds: string[], cause: string, actorId: string | null) {
  if (articleIds.length) await tx.knowledgeArticle.updateMany({ where: { id: { in: articleIds } }, data: { aclVersion: { increment: 1 } } });
  await bumpCacheVersion(tx, 'knowledge.acl', workspaceId);
  for (const id of articleIds) await emitEvent(tx, { workspaceId, eventType: 'KNOWLEDGE_PERMISSIONS_REEVALUATED', aggregateType: 'KnowledgeArticle', aggregateId: id, actorId, payload: { cause } });
}
export async function subtreeIds(tx: Tx, articleId: string) {
  return [articleId, ...(await tx.knowledgeArticlePath.findMany({ where: { ancestorId: articleId, depth: { gt: 0 } }, select: { descendantId: true } })).map(r => r.descendantId)];
}
/** Rebuilds closure rows for a moved subtree from the canonical parent relation. */
export async function rebuildPaths(tx: Tx, rootId: string) {
  const ids = await subtreeIds(tx, rootId);
  await tx.knowledgeArticlePath.deleteMany({ where: { descendantId: { in: ids } } });
  for (const id of ids) {
    let cur: string | null = id, depth = 0;
    while (cur && depth <= MAX_DEPTH + 1) {
      await tx.knowledgeArticlePath.create({ data: { ancestorId: cur, descendantId: id, depth } });
      cur = (await tx.knowledgeArticle.findUnique({ where: { id: cur }, select: { parentArticleId: true } }))?.parentArticleId ?? null; depth++;
    }
  }
}
export const articleEvent = (tx: Tx, a: { id: string; workspaceId: string; version: number }, eventType: string, actorId: string | null, payload: Record<string, unknown> = {}) =>
  emitEvent(tx, { workspaceId: a.workspaceId, eventType, aggregateType: 'KnowledgeArticle', aggregateId: a.id, aggregateVersion: a.version, actorId, payload });
export const listQuery = (sortable: readonly [string, ...string[]]) => z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(500).optional(), sortBy: z.enum(sortable).default(sortable[0]), sortDir: z.enum(['asc', 'desc']).default('asc') });
