import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { emitEvent, paged } from '../platform/kernel';
import { articleLevel, LEVELS, loadArticle, loadSpace, sha } from './support';

const READ_DEDUPE_HOURS = () => Number(process.env.KNOWLEDGE_READ_DEDUPE_HOURS ?? 24);

/** Favorites/recents/read analytics/review admin (28/08). Every list re-evaluates visibility at query time (AC01/AC05). */
export class KnowledgeInsightService {
  constructor(private readonly db: PrismaClient) {}
  private async visibleOnly<T extends { articleId: string }>(actor: Principal, rows: T[]) {
    const out: Array<T & { title: string }> = [];
    for (const r of rows) {
      const a = await this.db.knowledgeArticle.findFirst({ where: { id: r.articleId, workspaceId: actor.workspaceId } });
      if (a && await this.db.$transaction(tx => articleLevel(tx, actor, a)) >= LEVELS.VIEW) out.push({ ...r, title: a.title });
    }
    return out;
  }
  async favorites(actor: Principal) {
    requirePermission(actor, 'knowledge.space.read');
    return this.visibleOnly(actor, await this.db.knowledgeFavorite.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: { favoritedAt: 'desc' }, take: 500 }));
  }
  async favorite(actor: Principal, articleId: string, on: boolean) {
    return this.db.$transaction(async tx => {
      if (on) {
        const { article } = await loadArticle(tx, actor, articleId, 'VIEW');
        const existing = await tx.knowledgeFavorite.findUnique({ where: { workspaceId_userId_articleId: { workspaceId: actor.workspaceId, userId: actor.userId, articleId: article.id } } });
        if (!existing) {
          await tx.knowledgeFavorite.create({ data: { workspaceId: actor.workspaceId, userId: actor.userId, articleId: article.id } });
          await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'KNOWLEDGE_FAVORITE_ADDED', aggregateType: 'KnowledgeFavorite', aggregateId: article.id, actorId: actor.userId, payload: {} });
        }
      } else await tx.knowledgeFavorite.deleteMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, articleId: z.uuid().parse(articleId) } });
      return { articleId, favorite: on };
    });
  }
  /** Read event, deduplicated per reader+revision+window; feeds recents and aggregate analytics. */
  async recordRead(actor: Principal, articleId: string) {
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, articleId, 'VIEW');
      if (!article.publishedRevisionId) return { recorded: false };
      const bucket = Math.floor(Date.now() / (READ_DEDUPE_HOURS() * 3600000));
      const dedupeKey = sha(`${actor.workspaceId}:${article.id}:${article.publishedRevisionId}:${actor.userId}:${bucket}`);
      const exists = await tx.knowledgeReadEvent.findUnique({ where: { dedupeKey } });
      if (exists) { await tx.knowledgeReadEvent.update({ where: { id: exists.id }, data: { occurredAt: new Date() } }); return { recorded: false, deduplicated: true }; }
      await tx.knowledgeReadEvent.create({ data: { workspaceId: actor.workspaceId, articleId: article.id, revisionId: article.publishedRevisionId, readerId: actor.userId, dedupeKey } });
      return { recorded: true };
    });
  }
  async recent(actor: Principal) {
    requirePermission(actor, 'knowledge.space.read');
    const rows = await this.db.knowledgeReadEvent.findMany({ where: { workspaceId: actor.workspaceId, readerId: actor.userId }, orderBy: { occurredAt: 'desc' }, take: 200, distinct: ['articleId'], select: { articleId: true, occurredAt: true } });
    return (await this.visibleOnly(actor, rows)).slice(0, 50);
  }
  /**
   * Aggregates only over articles the caller can see; reader identities are never returned (08 rule 3). `reads` = deduplicated
   * read events (one per reader per published revision per window); period boundaries are UTC days.
   */
  async analytics(actor: Principal, raw: unknown) {
    requirePermission(actor, 'knowledge.analytics.read');
    const q = z.object({ spaceId: z.uuid().optional(), period: z.enum(['7d', '30d', '90d']).default('30d') }).strict().parse(raw);
    if (q.spaceId) await this.db.$transaction(tx => loadSpace(tx, actor, q.spaceId!, 'VIEW'));
    const since = new Date(Date.now() - Number(q.period.slice(0, -1)) * 86400000);
    const grouped = await this.db.knowledgeReadEvent.groupBy({ by: ['articleId'], where: { workspaceId: actor.workspaceId, occurredAt: { gte: since } }, _count: true });
    const scope = actor.grants.get('knowledge.analytics.read');
    const rows = [];
    for (const g of grouped) {
      const a = await this.db.knowledgeArticle.findFirst({ where: { id: g.articleId, workspaceId: actor.workspaceId, ...(q.spaceId ? { spaceId: q.spaceId } : {}) } });
      if (!a || await this.db.$transaction(tx => articleLevel(tx, actor, a)) < LEVELS.VIEW) continue;
      if (scope === 'OWN' && a.ownerUserId !== actor.userId) continue;
      rows.push({ articleId: a.id, title: a.title, reads: g._count });
    }
    rows.sort((x, y) => y.reads - x.reads);
    const definitions = { reads: `Deduplicated per reader, published revision and ${READ_DEDUPE_HOURS()}h window`, period: `Last ${q.period} (UTC)`, denominator: 'Articles visible to you' };
    return { period: q.period, totalReads: rows.reduce((s, r) => s + r.reads, 0), articles: rows.slice(0, 100), definitions };
  }
  async reviewQueue(actor: Principal, raw: unknown) {
    requirePermission(actor, 'knowledge.article.approve');
    const q = z.object({ status: z.enum(['OVERDUE', 'PENDING_APPROVAL']).default('OVERDUE'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(raw);
    const items: Array<Record<string, unknown>> = [];
    if (q.status === 'OVERDUE') {
      const rows = await this.db.knowledgeReviewAssignment.findMany({ where: { workspaceId: actor.workspaceId, currentState: 'OPEN' }, orderBy: { dueAt: 'asc' }, take: 1000 });
      for (const r of await this.visibleOnly(actor, rows)) items.push({ articleId: r.articleId, title: r.title, dueAt: r.dueAt, escalated: !!r.escalatedAt, reviewerUserId: r.reviewerUserId });
    } else {
      const rows = await this.db.knowledgePublicationRequest.findMany({ where: { workspaceId: actor.workspaceId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 1000 });
      for (const r of await this.visibleOnly(actor, rows)) items.push({ requestId: r.id, articleId: r.articleId, title: r.title, draftRevisionId: r.draftRevisionId, requestedAt: r.createdAt, requestorId: r.requestorId });
    }
    return paged(items.slice((q.page - 1) * q.limit, q.page * q.limit), items.length, q.page, q.limit);
  }
  async completeReview(actor: Principal, articleId: string, raw: unknown) {
    const input = z.strictObject({ nextReviewDays: z.number().int().min(1).max(3650) }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, articleId, 'EDIT', 'knowledge.article.edit');
      if (!article.reviewDueAt) throw new AppError('INVALID_STATE_TRANSITION', 'No review is due.', 409);
      await tx.knowledgeReviewAssignment.updateMany({ where: { articleId: article.id, currentState: 'OPEN' }, data: { currentState: 'DONE' } });
      return tx.knowledgeArticle.update({ where: { id: article.id }, data: { reviewDueAt: new Date(Date.now() + input.nextReviewDays * 86400000) } });
    });
  }
}
