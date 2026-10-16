import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import type { Principal } from '../process-platform/context';
import { decrypt } from '../suite/kernel';
import { articleLevel, LEVELS } from './support';

const vectorOutput = z.strictObject({ modelId: z.string(), vector: z.array(z.number().finite()).min(1).max(4096) });
export function readEmbedding(outputSealed: string | null) {
  try {
    const output = JSON.parse(decrypt(outputSealed) ?? '{}');
    return vectorOutput.parse(JSON.parse(output.text));
  } catch { return null; }
}

/** Uses the AI owner for routing, classification, budgets, immutable usage and Billing credit reservations. */
export async function createKnowledgeEmbedding(db: PrismaClient, actor: Principal, text: string, classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED', key: string) {
  const { AiRunService, executeRun } = await import('../ai/run-service');
  const service = new AiRunService(db);
  const run = await service.create(actor, { scenarioId: 'knowledge.embedding', input: { prompt: text }, classification, idempotencyKey: key });
  await executeRun(db, run.id);
  const stored = await db.aiRun.findUniqueOrThrow({ where: { id: run.id } });
  if (['QUEUED', 'RUNNING'].includes(stored.status)) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Embedding is still running.', 503);
  if (stored.status !== 'SUCCEEDED') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Approved embedding run did not succeed.', 503);
  const value = readEmbedding(stored.outputSealed);
  if (!value) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Embedding output is unavailable or invalid.', 503);
  return { ...value, runId: run.id };
}

export async function semanticCandidates(db: PrismaClient, actor: Principal, query: string, classifications: string[]) {
  const routes = await db.aiRoute.findMany({ where: { scenarioCode: 'knowledge.embedding', enabled: true, OR: [{ workspaceId: actor.workspaceId }, { workspaceId: null }] }, select: { id: true, version: true }, orderBy: { id: 'asc' } });
  if (!routes.length || !actor.grants.has('ai.run.create') || actor.entitlements?.ai === false) return [];
  const rows = await db.knowledgeAiChunk.findMany({ where: { workspaceId: actor.workspaceId, indexingStatus: 'ACTIVE', embeddingRef: { not: null }, classification: { in: classifications } }, orderBy: { id: 'asc' }, take: 5000 });
  if (!rows.length) return [];
  // Filter live policy/ACL before interpreting any derived vector or returning candidate content.
  const allowed = [];
  for (const row of rows) {
    const article = await db.knowledgeArticle.findFirst({ where: { id: row.articleId, workspaceId: actor.workspaceId, status: 'PUBLISHED', publishedRevisionId: row.revisionId } });
    const space = article ? await db.knowledgeSpace.findUnique({ where: { id: article.spaceId } }) : null;
    if (article && space?.status === 'ACTIVE' && space.aiIndexing && classifications.includes(space.contentClassification) && await db.$transaction(tx => articleLevel(tx, actor, article, space)) >= LEVELS.VIEW) allowed.push(row);
  }
  if (!allowed.length) return [];
  const hash = createHash('sha256').update(JSON.stringify([query, routes, classifications, Math.floor(Date.now() / 60000)])).digest('hex');
  // Query disclosure follows the caller's allowed classification, never a broader global connection.
  const queryClass = classifications[classifications.length - 1] as 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  const embedded = await createKnowledgeEmbedding(db, actor, query, queryClass, 'kb-query:' + hash);
  const runs = await db.aiRun.findMany({ where: { id: { in: allowed.map(r => r.embeddingRef!) }, workspaceId: actor.workspaceId, status: 'SUCCEEDED', outputValid: true }, select: { id: true, outputSealed: true } });
  const vectors = new Map(runs.map(r => [r.id, readEmbedding(r.outputSealed)]));
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, n) => s + n * n, 0));
  const qNorm = norm(embedded.vector);
  return allowed.map(row => {
    const value = vectors.get(row.embeddingRef!);
    const score = !qNorm || !value || value.modelId !== embedded.modelId || value.vector.length !== embedded.vector.length ? 0
      : value.vector.reduce((s, n, i) => s + n * embedded.vector[i], 0) / (norm(value.vector) * qNorm || 1);
    return { row, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id)).slice(0, 200).map(({ row }) => ({ id: row.id, article_id: row.articleId, revision_id: row.revisionId, anchor: row.anchor, content: row.content, classification: row.classification }));
}
