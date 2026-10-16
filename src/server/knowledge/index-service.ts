import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { registerAccess } from '../platform/access';
import { enqueueJob, registerConsumer, registerJob } from '../platform/events-service';
import { registerSearchSource } from '../platform/search-service';
import { assertServiceIdentity } from '../billing/support';
import { audit, emitEvent, notFound, paged } from '../platform/kernel';
import { aclChanged, articleLevel, LEVELS, loadArticle, loadSpace, sha, type Content, type Tx } from './support';

const CHUNK_CHARS = 1200;
export const CLASSIFICATION_ORDER = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
const rank = (c: string) => Math.max(0, CLASSIFICATION_ORDER.indexOf(c as (typeof CLASSIFICATION_ORDER)[number]));
/** Searchable text excludes file blocks/captions so attachment names never surface in snippets (05 rule 5). */
function searchText(content: Content) {
  return content.blocks.filter(b => !('fileId' in b)).map(b => 'text' in b ? b.text : 'items' in b ? (b.items as Array<string | { text: string }>).map(i => typeof i === 'string' ? i : i.text).join('\n') : 'rows' in b ? b.rows.map(r => r.join(' ')).join('\n') : '').join('\n');
}
function chunks(content: Content) {
  const out: Array<{ anchor: string | null; text: string }> = []; let anchor: string | null = null, buf = '';
  const flush = () => { if (buf.trim()) out.push({ anchor, text: buf.trim() }); buf = ''; };
  for (const b of content.blocks) {
    if ('fileId' in b) continue;
    if (b.type === 'heading') { flush(); anchor = b.anchor ?? null; buf = b.text + '\n'; continue; }
    const t = 'text' in b ? b.text : 'items' in b ? (b.items as Array<string | { text: string }>).map(i => typeof i === 'string' ? i : i.text).join('\n') : 'rows' in b ? b.rows.map(r => r.join(' | ')).join('\n') : '';
    for (const part of t.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}`, 'g')) ?? []) { if (buf.length + part.length > CHUNK_CHARS) flush(); buf += part + '\n'; }
  }
  flush();
  return out;
}

/**
 * Indexes exactly the CURRENT published revision when the article is published/live and its space allows AI; otherwise
 * withdraws every chunk. An older job can't overwrite a newer revision because only `publishedRevisionId` is ever indexed (05 AC04).
 */
export async function indexArticle(tx: Tx, articleId: string) {
  const article = await tx.knowledgeArticle.findUnique({ where: { id: articleId } }); if (!article) return 'MISSING';
  const space = await tx.knowledgeSpace.findUnique({ where: { id: article.spaceId } });
  const eligible = article.status === 'PUBLISHED' && !!article.publishedRevisionId && space?.status === 'ACTIVE' && space.aiIndexing;
  const stale = await tx.knowledgeAiChunk.updateMany({ where: { articleId, indexingStatus: 'ACTIVE', ...(eligible ? { revisionId: { not: article.publishedRevisionId! } } : {}) }, data: { indexingStatus: 'WITHDRAWN' } });
  if (!eligible) {
    if (stale.count) await emitEvent(tx, { workspaceId: article.workspaceId, eventType: 'KNOWLEDGE_INDEX_REMOVED', aggregateType: 'KnowledgeIndex', aggregateId: article.id, actorType: 'SERVICE', payload: { withdrawn: stale.count } });
    return 'WITHDRAWN';
  }
  if (await tx.knowledgeAiChunk.count({ where: { revisionId: article.publishedRevisionId!, indexingStatus: 'ACTIVE' } })) return 'CURRENT';
  const rev = await tx.knowledgeRevision.findUniqueOrThrow({ where: { id: article.publishedRevisionId! } });
  await tx.knowledgeAiChunk.deleteMany({ where: { revisionId: rev.id } });
  let n = 0;
  for (const c of chunks(rev.contentJson as Content)) await tx.knowledgeAiChunk.create({ data: { workspaceId: article.workspaceId, articleId, revisionId: rev.id, chunkNumber: n++, anchor: c.anchor, content: c.text, contentHash: sha(c.text), classification: space!.contentClassification } });
  await emitEvent(tx, { workspaceId: article.workspaceId, eventType: 'KNOWLEDGE_INDEX_COMPLETED', aggregateType: 'KnowledgeIndex', aggregateId: article.id, actorType: 'SERVICE', payload: { revisionId: rev.id, chunks: n } });
  return 'INDEXED';
}

registerSearchSource({ entityType: 'knowledge.article', aggregateTypes: ['KnowledgeArticle'],
  async load(tx, workspaceId, id) {
    const a = await tx.knowledgeArticle.findFirst({ where: { workspaceId, id, status: 'PUBLISHED' } });
    const space = a ? await tx.knowledgeSpace.findUnique({ where: { id: a.spaceId } }) : null;
    if (!a?.publishedRevisionId || space?.status !== 'ACTIVE') return null;
    const rev = await tx.knowledgeRevision.findUniqueOrThrow({ where: { id: a.publishedRevisionId } });
    return { title: rev.title, text: searchText(rev.contentJson as Content), version: a.version, classification: space.contentClassification };
  },
  async list(tx, workspaceId, cursor, take) { return (await tx.knowledgeArticle.findMany({ where: { workspaceId, status: 'PUBLISHED', ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take, select: { id: true } })).map(r => r.id); } });
/** Live resolver for global search, favorites, recents, notifications and realtime: never trusts derived rows. */
registerAccess('knowledge.article', async (tx, actor, ids) => {
  const rows = await tx.knowledgeArticle.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids }, status: { in: ['PUBLISHED', 'ARCHIVED', 'DRAFT'] } } });
  const out = new Set<string>(); for (const a of rows) if (await articleLevel(tx, actor, a) >= LEVELS.VIEW) out.add(a.id);
  return out;
});
registerConsumer({ id: 'knowledge.ai.indexer', handlerVersion: 1, eventTypes: '*', async handle(tx, event) {
  if (event.aggregateType === 'KnowledgeArticle') return indexArticle(tx, event.aggregateId);
  return null;
} });
registerJob({ type: 'knowledge.reindex', ownerModule: 'knowledge', maxAttempts: 5, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  return prisma.$transaction(tx => indexArticle(tx, String(ctx.payload.articleId)), { timeout: 60000 });
} });

export type RetrievedSnippet = { articleId: string; revisionId: string; anchor: string | null; snippet: string; title: string; citation: { sourceType: 'knowledge.article'; sourceId: string; version: string; anchor: string | null } };
/**
 * KnowledgeRetrieval.retrieve (shared contract 05/08): FTS candidates from the chunk read model, then LIVE re-evaluation of the
 * user's ACL, current published revision, space AI policy and classification before any byte is returned (05 rule 2, AC01-AC03).
 */
export async function retrieveKnowledge(db: PrismaClient, actor: Principal, query: string, opts: { limit: number; maxClassification?: string }) {
  if (!actor.grants.has('knowledge.search')) return [];
  const q = query.trim().slice(0, 500); if (!q) return [];
  const candidates = await db.$queryRaw<{ id: string; article_id: string; revision_id: string; anchor: string | null; content: string; classification: string }[]>`
    SELECT id, article_id, revision_id, anchor, content, classification FROM knowledge_ai_chunks
    WHERE workspace_id = ${actor.workspaceId}::uuid AND indexing_status = 'ACTIVE' AND to_tsvector('simple', content) @@ plainto_tsquery('simple', ${q})
    ORDER BY ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', ${q})) DESC, id LIMIT 200`;
  const max = rank(opts.maxClassification ?? 'INTERNAL'), out: RetrievedSnippet[] = [], decided = new Map<string, { ok: boolean; title: string }>();
  for (const c of candidates) {
    if (out.length >= opts.limit) break;
    if (rank(c.classification) > max) continue;
    let d = decided.get(c.article_id);
    if (!d) {
      d = await db.$transaction(async tx => {
        const a = await tx.knowledgeArticle.findUnique({ where: { id: c.article_id } });
        const s = a ? await tx.knowledgeSpace.findUnique({ where: { id: a.spaceId } }) : null;
        const ok = !!a && !!s && a.workspaceId === actor.workspaceId && a.status === 'PUBLISHED' && a.publishedRevisionId === c.revision_id && s.status === 'ACTIVE' && s.aiIndexing
          && rank(s.contentClassification) <= max && await articleLevel(tx, actor, a, s) >= LEVELS.VIEW;
        return { ok, title: ok ? (await tx.knowledgeRevision.findUnique({ where: { id: c.revision_id }, select: { title: true } }))?.title ?? '' : '' };
      });
      decided.set(c.article_id, d);
    }
    if (!d.ok) continue;
    out.push({ articleId: c.article_id, revisionId: c.revision_id, anchor: c.anchor, snippet: c.content.slice(0, 600), title: d.title, citation: { sourceType: 'knowledge.article', sourceId: c.article_id, version: c.revision_id, anchor: c.anchor } });
  }
  return out;
}

/** Knowledge search, AI indexing policy, reindex, retrieval and citations (28/05). */
export class KnowledgeIndexService {
  constructor(private readonly db: PrismaClient) {}
  /** Live-ACL filtered search; unauthorized hits are never counted (05 rule: empty results, no hit counts). */
  async search(actor: Principal, raw: unknown) {
    requirePermission(actor, 'knowledge.search');
    const q = z.object({ search: z.string().trim().min(1).max(500), spaceId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(raw);
    const rows = await this.db.$queryRaw<{ source_id: string; title: string; searchable_text: string }[]>`
      SELECT source_id, title, searchable_text FROM search_documents WHERE workspace_id = ${actor.workspaceId}::uuid AND source_module = 'knowledge.article' AND state = 'INDEXED'
        AND to_tsvector('simple', title || ' ' || searchable_text) @@ plainto_tsquery('simple', ${q.search})
      ORDER BY ts_rank(to_tsvector('simple', title || ' ' || searchable_text), plainto_tsquery('simple', ${q.search})) DESC, id LIMIT 500`;
    const allowed = [];
    for (const r of rows) {
      const a = await this.db.knowledgeArticle.findUnique({ where: { id: r.source_id } });
      if (!a || q.spaceId && a.spaceId !== q.spaceId || a.status !== 'PUBLISHED') continue;
      if (await this.db.$transaction(tx => articleLevel(tx, actor, a)) < LEVELS.VIEW) continue;
      const idx = r.searchable_text.toLowerCase().indexOf(q.search.toLowerCase().split(/\s+/)[0] ?? '');
      allowed.push({ articleId: a.id, spaceId: a.spaceId, title: r.title, snippet: r.searchable_text.slice(Math.max(0, idx - 80), Math.max(0, idx) + 200) });
    }
    return paged(allowed.slice((q.page - 1) * q.limit, q.page * q.limit), allowed.length, q.page, q.limit);
  }
  /** Turning AI off withdraws all chunks immediately; retrieval also checks the live flag (05 AC03). */
  async setAiIndexing(actor: Principal, spaceId: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ enabled: z.boolean(), contentClassification: z.enum(CLASSIFICATION_ORDER) }).parse(raw);
    return this.db.$transaction(async tx => {
      const { space } = await loadSpace(tx, actor, spaceId, 'MANAGE', 'knowledge.aiIndex.manage');
      const updated = await tx.knowledgeSpace.update({ where: { id: space.id }, data: { aiIndexing: input.enabled, contentClassification: input.contentClassification, aiPolicyApprovedBy: actor.userId, aiPolicyApprovedAt: new Date(), version: { increment: 1 } } });
      if (!input.enabled) await tx.knowledgeAiChunk.updateMany({ where: { workspaceId: actor.workspaceId, indexingStatus: 'ACTIVE', articleId: { in: (await tx.knowledgeArticle.findMany({ where: { spaceId: space.id }, select: { id: true } })).map(a => a.id) } }, data: { indexingStatus: 'WITHDRAWN' } });
      else await tx.knowledgeAiChunk.updateMany({ where: { articleId: { in: (await tx.knowledgeArticle.findMany({ where: { spaceId: space.id }, select: { id: true } })).map(a => a.id) }, indexingStatus: 'ACTIVE' }, data: { classification: input.contentClassification } });
      await aclChanged(tx, actor.workspaceId, (await tx.knowledgeArticle.findMany({ where: { spaceId: space.id, status: 'PUBLISHED' }, select: { id: true } })).map(a => a.id), input.enabled ? 'AI_ENABLED' : 'AI_DISABLED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_AI_POLICY_CHANGED', resourceType: 'KnowledgeSpace', resourceId: space.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'KNOWLEDGE_INDEX_REQUESTED', aggregateType: 'KnowledgeSpace', aggregateId: space.id, aggregateVersion: updated.version, actorId: actor.userId, payload: { enabled: input.enabled } });
      return updated;
    });
  }
  async reindex(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'EDIT', 'knowledge.aiIndex.manage');
      const job = await enqueueJob(tx, { type: 'knowledge.reindex', ownerModule: 'knowledge', workspaceId: actor.workspaceId, payload: { articleId: article.id }, idempotencyKey: `reindex:${article.id}:${article.version}:${article.publishedRevisionId ?? 'none'}` });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'KNOWLEDGE_INDEX_REQUESTED', aggregateType: 'KnowledgeIndex', aggregateId: article.id, actorId: actor.userId, payload: {} });
      return { queued: true, jobId: (job as { id?: string } | null)?.id ?? null };
    });
  }
  /** Internal retrieval for the AI module: delegated user context, never an AI superuser (05 authorization). */
  async internalRetrieve(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ userContext: z.strictObject({ workspaceId: z.uuid(), userId: z.uuid() }), query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).default(5), scenarioId: z.string().max(120), maxClassification: z.enum(CLASSIFICATION_ORDER).default('INTERNAL') }).parse(raw);
    const actor = await resolvePrincipal(this.db, input.userContext.workspaceId, input.userContext.userId);
    return { scenarioId: input.scenarioId, results: await retrieveKnowledge(this.db, actor, input.query, { limit: input.limit, maxClassification: input.maxClassification }) };
  }
  /** Stable citation for an exact revision; every click re-checks access (05 rule 3, AC05). */
  async citation(actor: Principal, id: string, raw: unknown) {
    const q = z.object({ revisionId: z.uuid(), anchor: z.string().max(80).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'VIEW');
      const rev = await tx.knowledgeRevision.findFirst({ where: { id: q.revisionId, articleId: article.id, state: 'PUBLISHED' } });
      if (!rev) throw notFound('Revision');
      if (q.anchor && !await tx.knowledgeSection.findUnique({ where: { revisionId_anchor: { revisionId: rev.id, anchor: q.anchor } } })) throw notFound('Section');
      return { articleId: article.id, revisionId: rev.id, versionNumber: rev.versionNumber, title: rev.title, anchor: q.anchor ?? null, current: rev.id === article.publishedRevisionId, path: `/knowledge/articles/${article.id}?revision=${rev.id}${q.anchor ? '#' + q.anchor : ''}` };
    });
  }
}
