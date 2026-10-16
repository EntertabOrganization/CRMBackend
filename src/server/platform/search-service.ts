import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { filterVisible, hasResolver, visibleIds } from './access';
import { registerConsumer, registerJob, enqueueJob } from './events-service';
import { audit, emitEvent, notFound, pageQuery, paged, type Tx } from './kernel';

/**
 * Search source: owning module loads the CURRENT source document (or null when withdrawn/deleted).
 * `list` enumerates ids for reindex. Search rows are a rebuildable projection, never authority.
 */
export type SearchSource = { entityType: string; aggregateTypes: string[]; classification?: string;
  load(tx: Tx, workspaceId: string, id: string): Promise<{ title: string; text: string; version: number; classification?: string } | null>;
  list(tx: Tx, workspaceId: string, cursor: string | null, take: number): Promise<string[]> };
const sources = new Map<string, SearchSource>();
export function registerSearchSource(source: SearchSource) { sources.set(source.entityType, source); }
const CONFIDENTIAL = new Set(['CONFIDENTIAL', 'RESTRICTED']);

/** Upsert/withdraw with version guard: an older event never overrides a newer projection. */
export async function projectSearchDocument(tx: Tx, workspaceId: string, entityType: string, id: string) {
  const source = sources.get(entityType); if (!source) return 'SKIPPED';
  const doc = await source.load(tx, workspaceId, id);
  const existing = await tx.searchDocument.findUnique({ where: { workspaceId_sourceModule_sourceId: { workspaceId, sourceModule: entityType, sourceId: id } } });
  if (!doc) { if (existing && existing.state !== 'WITHDRAWN') await tx.searchDocument.update({ where: { id: existing.id }, data: { state: 'WITHDRAWN', searchableText: '', title: '' } }); return 'WITHDRAWN'; }
  if (existing && existing.sourceVersion > doc.version) return 'STALE';
  const data = { title: doc.title.slice(0, 300), searchableText: doc.text.slice(0, 100000), sourceVersion: doc.version, classification: doc.classification ?? source.classification ?? 'INTERNAL', state: 'INDEXED', indexedAt: new Date() };
  await tx.searchDocument.upsert({ where: { workspaceId_sourceModule_sourceId: { workspaceId, sourceModule: entityType, sourceId: id } }, create: { workspaceId, sourceModule: entityType, sourceId: id, ...data }, update: data });
  return 'INDEXED';
}

registerConsumer({ id: 'platform.search.projector', handlerVersion: 1, eventTypes: '*', async handle(tx, event) {
  if (!event.workspaceId) return;
  const source = [...sources.values()].find(s => s.aggregateTypes.includes(event.aggregateType));
  if (!source) return;
  return projectSearchDocument(tx, event.workspaceId, source.entityType, event.aggregateId);
} });

registerJob({ type: 'platform.search.reindex', ownerModule: 'platform', maxAttempts: 5, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const jobId = String(ctx.payload.reindexJobId);
  const job = await prisma.searchReindexJob.findUnique({ where: { id: jobId } }); if (!job || ['COMPLETED', 'FAILED'].includes(job.state)) return { skipped: true };
  await prisma.searchReindexJob.update({ where: { id: jobId }, data: { state: 'RUNNING' } });
  let indexed = 0, withdrawn = 0;
  const types = (job.sourceTypes as string[]).length ? job.sourceTypes as string[] : [...sources.keys()];
  for (const type of types) {
    const source = sources.get(type); if (!source) continue;
    let cursor: string | null = null;
    for (;;) {
      const ids: string[] = await prisma.$transaction(tx => source.list(tx, job.workspaceId, cursor, 200));
      if (!ids.length) break;
      for (const id of ids) { const r = await prisma.$transaction(tx => projectSearchDocument(tx, job.workspaceId, type, id)); if (r === 'INDEXED') indexed++; }
      cursor = ids[ids.length - 1];
      await prisma.searchReindexJob.update({ where: { id: jobId }, data: { sourceCursor: `${type}:${cursor}` } });
    }
    // Reconciliation: documents whose source no longer exists are withdrawn.
    const docs = await prisma.searchDocument.findMany({ where: { workspaceId: job.workspaceId, sourceModule: type, state: 'INDEXED' }, select: { sourceId: true } });
    for (const d of docs) if (await prisma.$transaction(tx => projectSearchDocument(tx, job.workspaceId, type, d.sourceId)) === 'WITHDRAWN') withdrawn++;
  }
  await prisma.$transaction(async tx => {
    await tx.searchReindexJob.update({ where: { id: jobId }, data: { state: 'COMPLETED', indexed, withdrawn, finishedAt: new Date() } });
    await emitEvent(tx, { workspaceId: job.workspaceId, eventType: 'SEARCH_REINDEX_FINISHED', aggregateType: 'SearchReindexJob', aggregateId: jobId, actorType: 'SERVICE', payload: { indexed, withdrawn } });
  });
  return { indexed, withdrawn };
} });

/** Global search, recents, favorites (30-Platform-Services/05). Scope filtering happens before pagination/counts. */
export class PlatformSearchService {
  constructor(private readonly db: PrismaClient) {}
  async search(actor: Principal, raw: unknown) {
    requirePermission(actor, 'search.global');
    const q = pageQuery.extend({ search: z.string().trim().min(1).max(500), types: z.string().max(500).optional() }).parse(raw);
    const types = q.types ? q.types.split(',').filter(t => sources.has(t)) : [...sources.keys()];
    if (!types.length) return paged([], 0, q.page, q.limit);
    const candidates = await this.db.$queryRaw<{ id: string; source_module: string; source_id: string; title: string; classification: string; searchable_text: string; rank: number }[]>`
      SELECT id, source_module, source_id, title, classification, searchable_text, ts_rank(to_tsvector('simple', title || ' ' || searchable_text), plainto_tsquery('simple', ${q.search})) AS rank
      FROM search_documents WHERE workspace_id = ${actor.workspaceId}::uuid AND state = 'INDEXED' AND source_module = ANY(${types})
        AND to_tsvector('simple', title || ' ' || searchable_text) @@ plainto_tsquery('simple', ${q.search})
      ORDER BY rank DESC, id LIMIT 500`;
    const confidentialAllowed = actor.grants.has('search.confidential');
    const allowed = await this.db.$transaction(tx => filterVisible(tx, actor, candidates.filter(c => confidentialAllowed || !CONFIDENTIAL.has(c.classification)).map(c => ({ ...c, entityType: c.source_module, entityId: c.source_id }))));
    const terms = q.search.toLowerCase().split(/\s+/).filter(Boolean);
    const data = allowed.slice((q.page - 1) * q.limit, q.page * q.limit).map(c => {
      const text = c.searchable_text, at = Math.max(0, terms.map(t => text.toLowerCase().indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0);
      return { type: c.source_module, id: c.source_id, title: c.title, snippet: text.slice(Math.max(0, at - 60), at + 160) };
    });
    return paged(data, allowed.length, q.page, q.limit); // total counts only authorized hits
  }
  async reindex(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'search.admin');
    const input = z.strictObject({ types: z.array(z.string().max(60)).max(20).default([]) }).parse(raw);
    for (const t of input.types) if (!sources.has(t)) throw new AppError('VALIDATION_FAILED', `Unknown search source ${t}.`, 400);
    return this.db.$transaction(async tx => {
      const job = await tx.searchReindexJob.create({ data: { workspaceId: actor.workspaceId, sourceTypes: input.types, requestedBy: actor.userId } });
      await enqueueJob(tx, { type: 'platform.search.reindex', ownerModule: 'platform', workspaceId: actor.workspaceId, payload: { reindexJobId: job.id }, idempotencyKey: 'reindex:' + job.id });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'SEARCH_REINDEX_REQUESTED', resourceType: 'SearchReindexJob', resourceId: job.id, after: { types: input.types }, requestId });
      return { jobId: job.id, state: job.state };
    });
  }
  async reindexStatus(actor: Principal, id: string) {
    requirePermission(actor, 'search.admin');
    const job = await this.db.searchReindexJob.findFirst({ where: { workspaceId: actor.workspaceId, id: z.uuid().parse(id) } });
    if (!job) throw notFound('Reindex job'); return job;
  }
  /** Records a view only after the owning module confirms live access. */
  async touchRecent(actor: Principal, raw: unknown) {
    const input = z.strictObject({ entityType: z.string().max(60), entityId: z.uuid() }).parse(raw);
    if (!(await this.db.$transaction(tx => visibleIds(tx, actor, input.entityType, [input.entityId]))).has(input.entityId)) throw notFound('Resource');
    await this.db.recentItem.upsert({ where: { workspaceId_userId_entityType_entityId: { workspaceId: actor.workspaceId, userId: actor.userId, ...input } }, create: { workspaceId: actor.workspaceId, userId: actor.userId, ...input }, update: { lastSeenAt: new Date() } });
    return { recorded: true };
  }
  async recents(actor: Principal) {
    const rows = await this.db.recentItem.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: { lastSeenAt: 'desc' }, take: 100 });
    return this.db.$transaction(tx => filterVisible(tx, actor, rows)).then(r => r.slice(0, 50).map(x => ({ entityType: x.entityType, entityId: x.entityId, lastSeenAt: x.lastSeenAt })));
  }
  async favorites(actor: Principal) {
    const rows = await this.db.favorite.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: { createdAt: 'desc' }, take: 500 });
    return this.db.$transaction(tx => filterVisible(tx, actor, rows)).then(r => r.map(x => ({ entityType: x.entityType, entityId: x.entityId, createdAt: x.createdAt })));
  }
  async favorite(actor: Principal, entityType: string, entityId: string, on: boolean) {
    const id = z.uuid().parse(entityId);
    if (!hasResolver(entityType)) throw new AppError('VALIDATION_FAILED', 'Unsupported favorite type.', 400);
    return this.db.$transaction(async tx => {
      if (on) {
        if (!(await visibleIds(tx, actor, entityType, [id])).has(id)) throw notFound('Resource');
        await tx.favorite.upsert({ where: { workspaceId_userId_entityType_entityId: { workspaceId: actor.workspaceId, userId: actor.userId, entityType, entityId: id } }, create: { workspaceId: actor.workspaceId, userId: actor.userId, entityType, entityId: id }, update: {} });
      } else await tx.favorite.deleteMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, entityType, entityId: id } });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'FAVORITE_CHANGED', aggregateType: 'Favorite', aggregateId: id, actorId: actor.userId, payload: { entityType, on } });
      return { entityType, entityId: id, favorite: on };
    });
  }
  static async principalFor(db: PrismaClient, workspaceId: string, userId: string) { return resolvePrincipal(db, workspaceId, userId); }
}
