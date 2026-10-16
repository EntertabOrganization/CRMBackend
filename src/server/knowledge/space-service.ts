import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { assertVersion, audit, emitEvent, paged } from '../platform/kernel';
import { aclChanged, articleEvent, articleLevel, articleSlug, assertKnowledgeWrite, LEVELS, listQuery, loadArticle, loadSpace, MAX_DEPTH, rebuildPaths, spaceLevel, subtreeIds, type Tx } from './support';

const binding = z.strictObject({ targetType: z.enum(['COMPANY', 'DEPARTMENT', 'PROJECT']), targetId: z.uuid().optional() });
async function validateBindings(tx: Tx, workspaceId: string, bindings: z.infer<typeof binding>[]) {
  for (const b of bindings) {
    if (b.targetType === 'COMPANY') continue;
    if (!b.targetId) throw new AppError('VALIDATION_FAILED', 'targetId is required for department/project bindings.', 400);
    const ok = b.targetType === 'DEPARTMENT' ? await tx.department.findFirst({ where: { id: b.targetId, workspaceId, isDeleted: false } }) : await tx.project.findFirst({ where: { id: b.targetId, workspaceId, isDeleted: false } });
    if (!ok) throw new AppError('VALIDATION_FAILED', 'Binding target must belong to this Workspace.', 400, { fields: [{ field: 'bindings.targetId', reason: 'NOT_IN_WORKSPACE' }] });
  }
}
const SPACE_MACHINE: Record<string, Record<string, string>> = { archive: { ACTIVE: 'ARCHIVED' }, restore: { ARCHIVED: 'ACTIVE', RECYCLED: '*' }, recycle: { ACTIVE: 'RECYCLED', ARCHIVED: 'RECYCLED' } };

/** Spaces and article hierarchy (28/01). */
export class KnowledgeSpaceService {
  constructor(private readonly db: PrismaClient) {}

  async create(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'knowledge.space.create'); assertKnowledgeWrite(actor);
    const input = z.strictObject({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(2000).default(''), visibility: z.enum(['PRIVATE', 'SCOPED']).default('PRIVATE'), bindings: z.array(binding).max(50).default([]) }).parse(raw);
    return this.db.$transaction(async tx => {
      await validateBindings(tx, actor.workspaceId, input.bindings);
      let slug = articleSlug(input.name) || 'space', i = 1;
      while (await tx.knowledgeSpace.findUnique({ where: { workspaceId_slug: { workspaceId: actor.workspaceId, slug } } })) slug = `${articleSlug(input.name)}-${++i}`;
      const space = await tx.knowledgeSpace.create({ data: { workspaceId: actor.workspaceId, name: input.name, slug, description: input.description, ownerUserId: actor.userId, visibility: input.visibility } });
      for (const b of input.bindings) await tx.knowledgeSpaceBinding.create({ data: { workspaceId: actor.workspaceId, spaceId: space.id, targetType: b.targetType, targetId: b.targetId ?? null } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_SPACE_CREATED', resourceType: 'KnowledgeSpace', resourceId: space.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'KNOWLEDGE_SPACE_CREATED', aggregateType: 'KnowledgeSpace', aggregateId: space.id, aggregateVersion: 1, actorId: actor.userId, payload: { visibility: space.visibility } });
      return space;
    });
  }
  /** Scope filtering happens before pagination/counts (only spaces the caller can see are counted). */
  async list(actor: Principal, raw: unknown) {
    requirePermission(actor, 'knowledge.space.read');
    const q = listQuery(['name', 'createdAt', 'updatedAt']).extend({ status: z.enum(['ACTIVE', 'ARCHIVED', 'RECYCLED']).default('ACTIVE') }).strict().parse(raw);
    const rows = await this.db.knowledgeSpace.findMany({ where: { workspaceId: actor.workspaceId, status: q.status, ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}) }, orderBy: [{ [q.sortBy]: q.sortDir }, { id: 'asc' }], take: 2000 });
    const visible = [];
    for (const s of rows) { const level = await this.db.$transaction(tx => spaceLevel(tx, actor, s)); if (level >= LEVELS.VIEW) visible.push({ ...s, myLevel: Object.keys(LEVELS)[level] }); }
    return paged(visible.slice((q.page - 1) * q.limit, q.page * q.limit), visible.length, q.page, q.limit);
  }
  async get(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const { space, level } = await loadSpace(tx, actor, id, 'VIEW');
      const bindings = level >= LEVELS.MANAGE ? await tx.knowledgeSpaceBinding.findMany({ where: { spaceId: space.id, active: true } }) : [];
      return { ...space, bindings, myLevel: Object.keys(LEVELS)[level] };
    });
  }
  async update(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ name: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(2000).optional(), visibility: z.enum(['PRIVATE', 'SCOPED']).optional(), bindings: z.array(binding).max(50).optional(), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { space } = await loadSpace(tx, actor, id, 'MANAGE', 'knowledge.space.update'); assertKnowledgeWrite(actor);
      assertVersion(space.version, input.expectedVersion);
      const { expectedVersion: _v, bindings, ...change } = input;
      const updated = await tx.knowledgeSpace.update({ where: { id: space.id }, data: { ...change, version: { increment: 1 }, ...(bindings || change.visibility ? { aclVersion: { increment: 1 } } : {}) } });
      if (bindings) {
        await validateBindings(tx, actor.workspaceId, bindings);
        await tx.knowledgeSpaceBinding.updateMany({ where: { spaceId: space.id }, data: { active: false } });
        for (const b of bindings) await tx.knowledgeSpaceBinding.create({ data: { workspaceId: actor.workspaceId, spaceId: space.id, targetType: b.targetType, targetId: b.targetId ?? null } });
      }
      if (bindings || change.visibility) await aclChanged(tx, actor.workspaceId, (await tx.knowledgeArticle.findMany({ where: { spaceId: space.id }, select: { id: true } })).map(a => a.id), 'SPACE_ACCESS_CHANGED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_SPACE_UPDATED', resourceType: 'KnowledgeSpace', resourceId: space.id, before: { name: space.name, visibility: space.visibility }, after: input, requestId });
      return updated;
    });
  }
  async lifecycle(actor: Principal, id: string, command: 'archive' | 'restore' | 'recycle', requestId: string) {
    return this.db.$transaction(async tx => {
      const { space } = await loadSpace(tx, actor, id, 'MANAGE', 'knowledge.space.archive');
      const to = SPACE_MACHINE[command][space.status];
      if (!to) throw new AppError('INVALID_STATE_TRANSITION', `Space is ${space.status}.`, 409);
      const next = to === '*' ? space.statusBeforeRecycle ?? 'ACTIVE' : to;
      const updated = await tx.knowledgeSpace.update({ where: { id: space.id }, data: { status: next, statusBeforeRecycle: command === 'recycle' ? space.status : null, version: { increment: 1 }, aclVersion: { increment: 1 } } });
      // Archived/recycled spaces leave search and AI immediately (projectors re-evaluate every article).
      await aclChanged(tx, actor.workspaceId, (await tx.knowledgeArticle.findMany({ where: { spaceId: space.id }, select: { id: true } })).map(a => a.id), 'SPACE_' + next, actor.userId);
      const eventType = next === 'ARCHIVED' ? 'KNOWLEDGE_SPACE_ARCHIVED' : next === 'RECYCLED' ? 'KNOWLEDGE_SPACE_RECYCLED' : 'KNOWLEDGE_SPACE_RESTORED';
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: eventType, resourceType: 'KnowledgeSpace', resourceId: space.id, before: { status: space.status }, after: { status: next }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType, aggregateType: 'KnowledgeSpace', aggregateId: space.id, aggregateVersion: updated.version, actorId: actor.userId, payload: { status: next } });
      return updated;
    });
  }
  /**
   * Accessible tree with deterministic sibling order (sortOrder, title, id). Hidden nodes are omitted; visible descendants
   * attach to their nearest visible ancestor so names never leak via structure (01 rule 4).
   */
  async tree(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const { space } = await loadSpace(tx, actor, id, 'VIEW');
      const articles = await tx.knowledgeArticle.findMany({ where: { spaceId: space.id, status: { in: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] } }, orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }, { id: 'asc' }] });
      const byId = new Map(articles.map(a => [a.id, a])), visible = new Map<string, number>();
      for (const a of articles) { const l = await articleLevel(tx, actor, a, space); if (l >= LEVELS.VIEW) visible.set(a.id, l); }
      type Node = { id: string; title: string; status: string; slug: string; level: string; children: Node[] };
      const nodes = new Map<string, Node>(), roots: Node[] = [];
      for (const a of articles) if (visible.has(a.id)) nodes.set(a.id, { id: a.id, title: a.title, status: a.status, slug: a.slug, level: Object.keys(LEVELS)[visible.get(a.id)!], children: [] });
      for (const a of articles) {
        const node = nodes.get(a.id); if (!node) continue;
        let parent = a.parentArticleId, guard = 0;
        while (parent && !nodes.has(parent) && guard++ < MAX_DEPTH + 2) parent = byId.get(parent)?.parentArticleId ?? null;
        (parent ? nodes.get(parent)!.children : roots).push(node);
      }
      return { space: { id: space.id, name: space.name, status: space.status }, tree: roots };
    });
  }
  /**
   * Move with optimistic version + graph lock: rejects cycles (409 HIERARCHY_CYCLE), recomputes ACL-derived state for the
   * whole subtree (moving never widens access) and keeps the logical article id (01 rules 2-4, AC02/AC04/AC05).
   */
  async move(actor: Principal, articleId: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ targetSpaceId: z.uuid(), parentArticleId: z.uuid().nullable().optional(), sortOrder: z.number().int().min(0).max(1000000).optional(), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'knowledge-tree:' + actor.workspaceId}))`;
      const { article } = await loadArticle(tx, actor, articleId, 'MANAGE', 'knowledge.article.move'); assertKnowledgeWrite(actor);
      assertVersion(article.version, input.expectedVersion);
      if (['RECYCLED', 'PURGED'].includes(article.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Deleted articles cannot be moved.', 409);
      const { space: target } = await loadSpace(tx, actor, input.targetSpaceId, 'EDIT');
      if (target.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Target space is not active.', 409);
      const subtree = await subtreeIds(tx, article.id);
      let depth = 0;
      if (input.parentArticleId) {
        if (subtree.includes(input.parentArticleId)) throw new AppError('HIERARCHY_CYCLE', 'An article cannot move under itself or its descendants.', 409);
        const { article: parent } = await loadArticle(tx, actor, input.parentArticleId, 'EDIT');
        if (parent.spaceId !== target.id || ['RECYCLED', 'PURGED'].includes(parent.status)) throw new AppError('VALIDATION_FAILED', 'Parent must be a live article in the target space.', 400);
        depth = (await tx.knowledgeArticlePath.count({ where: { descendantId: parent.id } }));
      }
      const subDepth = Math.max(0, ...(await tx.knowledgeArticlePath.findMany({ where: { ancestorId: article.id }, select: { depth: true } })).map(r => r.depth));
      if (depth + subDepth + 1 > MAX_DEPTH) throw new AppError('VALIDATION_FAILED', `Hierarchy depth is limited to ${MAX_DEPTH}.`, 400);
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { spaceId: target.id, parentArticleId: input.parentArticleId ?? null, ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}), version: { increment: 1 } } });
      if (target.id !== article.spaceId) await tx.knowledgeArticle.updateMany({ where: { id: { in: subtree.filter(x => x !== article.id) } }, data: { spaceId: target.id } });
      await rebuildPaths(tx, article.id);
      await aclChanged(tx, actor.workspaceId, subtree, 'MOVED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ARTICLE_MOVED', resourceType: 'KnowledgeArticle', resourceId: article.id, before: { spaceId: article.spaceId, parentArticleId: article.parentArticleId }, after: { spaceId: target.id, parentArticleId: input.parentArticleId ?? null, subtree: subtree.length }, requestId });
      await articleEvent(tx, updated, 'KNOWLEDGE_ARTICLE_MOVED', actor.userId, { fromSpaceId: article.spaceId, toSpaceId: target.id });
      return updated;
    });
  }
}
