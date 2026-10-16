import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { cleanFile } from '../suite/files-port';
import { registerJob, registerSchedule } from '../platform/events-service';
import { PlatformConfigService } from '../platform/config-service';
import { PlatformNotificationService } from '../platform/notifications-service';
import { legalHoldActive } from '../platform/privacy-service';
import { assertVersion, audit, notFound, paged } from '../platform/kernel';
import { aclChanged, articleEvent, articleLevel, articleSlug, assertKnowledgeWrite, assignAnchors, fileIdsOf, LEVELS, listQuery, loadArticle, loadSpace, normalizeContent, rebuildPaths, subtreeIds, type Article, type Content, type Tx } from './support';

const AUDIT_BATCH_MS = 10 * 60000;
const maxBytes = (actor: Principal) => typeof actor.entitlements?.knowledgeArticleMaxBytes === 'number' ? actor.entitlements.knowledgeArticleMaxBytes as number : 1_000_000;
const recycleDays = (tx: Tx) => PlatformConfigService.platformSetting<number>(tx, 'knowledgeRecycleDays', 30);

async function uniqueSlug(tx: Tx, a: { workspaceId: string; spaceId: string; parentArticleId: string | null; id?: string }, title: string) {
  const base = articleSlug(title) || 'article'; let slug = base, i = 1;
  while (await tx.knowledgeArticle.findFirst({ where: { workspaceId: a.workspaceId, spaceId: a.spaceId, parentArticleId: a.parentArticleId, slug: { equals: slug, mode: 'insensitive' }, status: { notIn: ['RECYCLED', 'PURGED'] }, ...(a.id ? { id: { not: a.id } } : {}) } })) slug = `${base}-${++i}`;
  return slug;
}
/** File ACL ∩ article ACL: embedded files the viewer can't open are replaced with an unavailable placeholder (02 AC04). */
async function viewerContent(tx: Tx, actor: Principal, content: Content) {
  const blocks = [];
  for (const b of content.blocks) {
    if ('fileId' in b) { try { await cleanFile(tx, actor, b.fileId); blocks.push(b); } catch { blocks.push({ type: b.type, unavailable: true, caption: '' }); } }
    else blocks.push(b);
  }
  return { blocks };
}
async function writeRevision(tx: Tx, actor: Principal, article: Article, input: { content: unknown; title: string; sourceRevisionId?: string | null; idempotencyKey?: string | null }) {
  const { content, hash, safety } = normalizeContent(input.content, maxBytes(actor));
  const previous = article.currentDraftRevisionId ? await tx.knowledgeSection.findMany({ where: { revisionId: article.currentDraftRevisionId }, select: { anchor: true, title: true } }) : [];
  const sections = assignAnchors(content, previous);
  for (const f of fileIdsOf(content)) await cleanFile(tx, actor, f.fileId); // only scan-cleared files the author can read
  const last = await tx.knowledgeRevision.findFirst({ where: { articleId: article.id }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } });
  const revision = await tx.knowledgeRevision.create({ data: { workspaceId: article.workspaceId, articleId: article.id, versionNumber: (last?.versionNumber ?? 0) + 1, title: input.title, contentJson: content as Prisma.InputJsonValue, contentHash: hash,
    authorUserId: actor.userId, sourceRevisionId: input.sourceRevisionId ?? null, idempotencyKey: input.idempotencyKey ?? null, safetyScan: safety } });
  for (const s of sections) await tx.knowledgeSection.create({ data: { revisionId: revision.id, anchor: s.anchor, headingLevel: s.level, order: s.order, title: s.title } });
  for (const f of fileIdsOf(content)) await tx.knowledgeFileBinding.upsert({ where: { revisionId_fileId_usageKind: { revisionId: revision.id, fileId: f.fileId, usageKind: f.kind } }, create: { articleId: article.id, revisionId: revision.id, fileId: f.fileId, usageKind: f.kind }, update: {} });
  return revision;
}
async function lifecycleEvent(tx: Tx, a: Article, next: string, actorId: string, reason?: string) {
  await tx.knowledgeLifecycleEvent.create({ data: { workspaceId: a.workspaceId, articleId: a.id, priorStatus: a.status, nextStatus: next, actorId, reason } });
}

/** Article editor/revisions (28/02), review/publish/acknowledgement (28/04), archive/trash/retention (28/07). */
export class KnowledgeArticleService {
  constructor(private readonly db: PrismaClient) {}

  async create(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'knowledge.article.create'); assertKnowledgeWrite(actor);
    const input = z.strictObject({ spaceId: z.uuid(), parentArticleId: z.uuid().optional(), title: z.string().trim().min(1).max(200), templateId: z.uuid().optional(), sortOrder: z.number().int().min(0).max(1000000).default(0) }).parse(raw);
    return this.db.$transaction(async tx => {
      const { space } = await loadSpace(tx, actor, input.spaceId, 'EDIT');
      if (space.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Space is not active.', 409);
      if (input.parentArticleId) {
        const { article: parent } = await loadArticle(tx, actor, input.parentArticleId, 'EDIT');
        if (parent.spaceId !== space.id || ['RECYCLED', 'PURGED'].includes(parent.status)) throw new AppError('VALIDATION_FAILED', 'Parent must be a live article in the same space.', 400);
      }
      const template = input.templateId ? await tx.knowledgeTemplate.findFirst({ where: { id: input.templateId, workspaceId: actor.workspaceId } }) : null;
      if (input.templateId && !template) throw notFound('Template');
      const slug = await uniqueSlug(tx, { workspaceId: actor.workspaceId, spaceId: space.id, parentArticleId: input.parentArticleId ?? null }, input.title);
      const article = await tx.knowledgeArticle.create({ data: { workspaceId: actor.workspaceId, spaceId: space.id, parentArticleId: input.parentArticleId ?? null, title: input.title, slug, sortOrder: input.sortOrder, ownerUserId: actor.userId } });
      const revision = await writeRevision(tx, actor, article, { content: template?.contentSchema ?? { blocks: [] }, title: input.title });
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { currentDraftRevisionId: revision.id } });
      await rebuildPaths(tx, article.id);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ARTICLE_CREATED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { spaceId: space.id, title: input.title }, requestId });
      await articleEvent(tx, updated, 'KNOWLEDGE_ARTICLE_CREATED', actor.userId, { spaceId: space.id });
      return { ...updated, draftRevision: { id: revision.id, versionNumber: revision.versionNumber } };
    });
  }
  /** Readers get the published revision; editors may request the draft. Draft edits never change published content (02 AC02). */
  async get(actor: Principal, id: string, raw: unknown) {
    const q = z.object({ view: z.enum(['published', 'draft']).default('published') }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'VIEW');
      const wantDraft = q.view === 'draft' || !article.publishedRevisionId;
      if (wantDraft && level < LEVELS.EDIT) throw notFound('Article');
      const revisionId = wantDraft ? article.currentDraftRevisionId : article.publishedRevisionId;
      const revision = revisionId ? await tx.knowledgeRevision.findUnique({ where: { id: revisionId } }) : null;
      const sections = revision ? await tx.knowledgeSection.findMany({ where: { revisionId: revision.id }, orderBy: { order: 'asc' }, select: { anchor: true, headingLevel: true, title: true } }) : [];
      return { id: article.id, spaceId: article.spaceId, parentArticleId: article.parentArticleId, title: wantDraft ? article.title : revision?.title ?? article.title, slug: article.slug, status: article.status, version: article.version,
        myLevel: Object.keys(LEVELS)[level], publishedRevisionId: article.publishedRevisionId, currentDraftRevisionId: level >= LEVELS.EDIT ? article.currentDraftRevisionId : null,
        revision: revision && { id: revision.id, versionNumber: revision.versionNumber, state: revision.state, occurredAt: revision.occurredAt, content: await viewerContent(tx, actor, revision.contentJson as Content) }, sections };
    });
  }
  /**
   * Autosave/explicit save: stale baseRevisionId => 409 REVISION_CONFLICT with safe metadata; same Idempotency-Key returns the
   * same revision. Audit is batched per editor (no audit row per keystroke).
   */
  async saveDraft(actor: Principal, id: string, raw: unknown, key: string | null, requestId: string) {
    const input = z.strictObject({ content: z.unknown(), baseRevisionId: z.uuid(), expectedVersion: z.number().int().positive(), title: z.string().trim().min(1).max(200).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'knowledge-article:' + id}))`;
      const { article } = await loadArticle(tx, actor, id, 'EDIT', 'knowledge.article.edit'); assertKnowledgeWrite(actor);
      if (key) { const replay = await tx.knowledgeRevision.findUnique({ where: { articleId_idempotencyKey: { articleId: article.id, idempotencyKey: key } } }); if (replay) return { revisionId: replay.id, versionNumber: replay.versionNumber, version: article.version, replayed: true }; }
      if (['RECYCLED', 'PURGED'].includes(article.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Deleted articles cannot be edited.', 409);
      if (input.baseRevisionId !== article.currentDraftRevisionId) {
        const current = article.currentDraftRevisionId ? await tx.knowledgeRevision.findUnique({ where: { id: article.currentDraftRevisionId }, select: { id: true, versionNumber: true, authorUserId: true, occurredAt: true } }) : null;
        throw new AppError('REVISION_CONFLICT', 'The draft changed since you started editing; merge your changes with the latest revision.', 409, { currentRevisionId: current?.id, currentVersionNumber: current?.versionNumber, authorUserId: current?.authorUserId, savedAt: current?.occurredAt, articleVersion: article.version });
      }
      assertVersion(article.version, input.expectedVersion);
      const title = input.title ?? article.title;
      const revision = await writeRevision(tx, actor, article, { content: input.content, title, idempotencyKey: key });
      const slug = title !== article.title ? await uniqueSlug(tx, article, title) : article.slug;
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { currentDraftRevisionId: revision.id, title, slug, version: { increment: 1 } } });
      const session = await tx.knowledgeEditSession.findUnique({ where: { articleId_userId: { articleId: article.id, userId: actor.userId } } });
      if (!session || Date.now() - session.lastSeenAt.getTime() > AUDIT_BATCH_MS)
        await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_DRAFT_SAVED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { revisionId: revision.id, versionNumber: revision.versionNumber }, requestId });
      await tx.knowledgeEditSession.upsert({ where: { articleId_userId: { articleId: article.id, userId: actor.userId } }, create: { articleId: article.id, userId: actor.userId, baselineRevisionId: revision.id }, update: { baselineRevisionId: revision.id, lastSeenAt: new Date(), conflictState: null } });
      await articleEvent(tx, updated, 'KNOWLEDGE_DRAFT_SAVED', actor.userId, { revisionId: revision.id });
      return { revisionId: revision.id, versionNumber: revision.versionNumber, version: updated.version, safetyScan: revision.safetyScan, replayed: false };
    });
  }
  async revisions(actor: Principal, id: string, raw: unknown) {
    const q = listQuery(['versionNumber']).parse(raw);
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'VIEW');
      if (level < LEVELS.EDIT) requirePermission(actor, 'knowledge.article.readRevision');
      const where = { articleId: article.id, ...(level < LEVELS.EDIT ? { state: 'PUBLISHED' } : {}) };
      const [rows, total] = await Promise.all([tx.knowledgeRevision.findMany({ where, orderBy: { versionNumber: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, select: { id: true, versionNumber: true, title: true, state: true, authorUserId: true, sourceRevisionId: true, occurredAt: true, contentHash: true } }), tx.knowledgeRevision.count({ where })]);
      return paged(rows, total, q.page, q.limit);
    });
  }
  async revision(actor: Principal, id: string, revisionId: string) {
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'VIEW');
      const rev = await tx.knowledgeRevision.findFirst({ where: { id: z.uuid().parse(revisionId), articleId: article.id, workspaceId: actor.workspaceId } });
      if (!rev || rev.state !== 'PUBLISHED' && level < LEVELS.EDIT) throw notFound('Revision');
      if (rev.id !== article.publishedRevisionId && level < LEVELS.EDIT) requirePermission(actor, 'knowledge.article.readRevision');
      return { ...rev, contentJson: undefined, content: await viewerContent(tx, actor, rev.contentJson as Content) };
    });
  }
  /** Revert = NEW draft revision copied from the source; history stays untouched (02 AC05). */
  async revert(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ sourceRevisionId: z.uuid(), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'knowledge-article:' + id}))`;
      const { article } = await loadArticle(tx, actor, id, 'EDIT', 'knowledge.article.revert'); assertKnowledgeWrite(actor);
      assertVersion(article.version, input.expectedVersion);
      const source = await tx.knowledgeRevision.findFirst({ where: { id: input.sourceRevisionId, articleId: article.id } }); if (!source) throw notFound('Revision');
      const revision = await writeRevision(tx, actor, article, { content: source.contentJson, title: source.title, sourceRevisionId: source.id });
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { currentDraftRevisionId: revision.id, title: source.title, version: { increment: 1 } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_REVISION_RESTORED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { sourceRevisionId: source.id, newRevisionId: revision.id }, requestId });
      await articleEvent(tx, updated, 'KNOWLEDGE_REVISION_RESTORED', actor.userId, { sourceRevisionId: source.id, revisionId: revision.id });
      return { revisionId: revision.id, versionNumber: revision.versionNumber, version: updated.version };
    });
  }
  /** Access-preserving deep link: opening it re-checks the viewer's current authorization. */
  async sectionLink(actor: Principal, id: string, anchor: string) {
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'VIEW');
      const revisionId = article.publishedRevisionId ?? (level >= LEVELS.EDIT ? article.currentDraftRevisionId : null);
      const section = revisionId ? await tx.knowledgeSection.findUnique({ where: { revisionId_anchor: { revisionId, anchor } } }) : null;
      if (!section) throw notFound('Section');
      return { articleId: article.id, anchor: section.anchor, revisionId, path: `/knowledge/articles/${article.id}#${section.anchor}`, requiresAuthentication: true };
    });
  }

  // ------------------------------------------------------------------ 04 review, publish, acknowledgement
  async requestPublication(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ draftRevisionId: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'EDIT', 'knowledge.article.requestReview');
      if (article.currentDraftRevisionId !== input.draftRevisionId) throw new AppError('REVISION_CONFLICT', 'Only the current draft revision can be submitted.', 409);
      const rev = await tx.knowledgeRevision.findUniqueOrThrow({ where: { id: input.draftRevisionId } });
      await tx.knowledgePublicationRequest.updateMany({ where: { articleId: article.id, status: 'PENDING' }, data: { status: 'CANCELLED', decidedAt: new Date() } });
      const request = await tx.knowledgePublicationRequest.create({ data: { workspaceId: actor.workspaceId, articleId: article.id, draftRevisionId: rev.id, contentHash: rev.contentHash, requestorId: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_REVIEW_REQUESTED', resourceType: 'KnowledgePublicationRequest', resourceId: request.id, after: { revisionId: rev.id }, requestId });
      await articleEvent(tx, article, 'KNOWLEDGE_REVIEW_REQUESTED', actor.userId, { requestId: request.id, revisionId: rev.id });
      return request;
    });
  }
  /** Approval binds to the exact revision+content hash; a newer draft expires it (04 AC01). Two-person rule blocks self-approval. */
  async approve(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ requestId: z.uuid(), expectedRevisionId: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'VIEW', 'knowledge.article.approve');
      const req = await tx.knowledgePublicationRequest.findFirst({ where: { id: input.requestId, articleId: article.id } }); if (!req) throw notFound('Publication request');
      if (req.status !== 'PENDING') throw new AppError('INVALID_STATE_TRANSITION', `Request is ${req.status}.`, 409);
      const policy = await tx.knowledgeReviewPolicy.findUnique({ where: { spaceId: article.spaceId } });
      if ((policy?.twoPersonRule ?? true) && req.requestorId === actor.userId) throw new AppError('PERMISSION_DENIED', 'You cannot approve your own publication request.', 403);
      if (req.draftRevisionId !== input.expectedRevisionId || article.currentDraftRevisionId !== req.draftRevisionId) {
        await tx.knowledgePublicationRequest.update({ where: { id: req.id }, data: { status: 'CANCELLED', decisionReason: 'Draft changed after request', decidedAt: new Date() } });
        throw new AppError('REVISION_CONFLICT', 'The draft changed; the approval request expired.', 409);
      }
      const updated = await tx.knowledgePublicationRequest.update({ where: { id: req.id }, data: { status: 'APPROVED', reviewerId: actor.userId, decidedAt: new Date() } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_REVIEW_APPROVED', resourceType: 'KnowledgePublicationRequest', resourceId: req.id, after: { revisionId: req.draftRevisionId }, requestId });
      await articleEvent(tx, article, 'KNOWLEDGE_REVIEW_APPROVED', actor.userId, { requestId: req.id, revisionId: req.draftRevisionId });
      return updated;
    });
  }
  async reject(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ requestId: z.uuid(), reason: z.string().trim().min(3).max(1000) }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'VIEW', 'knowledge.article.approve');
      const r = await tx.knowledgePublicationRequest.updateMany({ where: { id: input.requestId, articleId: article.id, status: 'PENDING' }, data: { status: 'REJECTED', reviewerId: actor.userId, decisionReason: input.reason, decidedAt: new Date() } });
      if (!r.count) throw new AppError('INVALID_STATE_TRANSITION', 'Only pending requests can be rejected.', 409);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_REVIEW_REJECTED', resourceType: 'KnowledgePublicationRequest', resourceId: input.requestId, after: { reason: input.reason }, requestId });
      return { id: input.requestId, status: 'REJECTED' };
    });
  }
  /** Publish the exact draft revision (idempotent per revision). Requires passed safety scan, clean files, active space and entitlement. */
  async publish(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ approvedRequestId: z.uuid().optional(), draftRevisionId: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'knowledge-article:' + id}))`;
      const { article } = await loadArticle(tx, actor, id, 'EDIT', 'knowledge.article.publish'); assertKnowledgeWrite(actor);
      if (article.publishedRevisionId === input.draftRevisionId) return { articleId: article.id, publishedRevisionId: article.publishedRevisionId, replayed: true };
      if (article.currentDraftRevisionId !== input.draftRevisionId) throw new AppError('REVISION_CONFLICT', 'Only the current draft can be published.', 409);
      if (['RECYCLED', 'PURGED'].includes(article.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Deleted articles cannot be published.', 409);
      const space = await tx.knowledgeSpace.findUniqueOrThrow({ where: { id: article.spaceId } });
      if (space.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Space is not active.', 409);
      const policy = await tx.knowledgeReviewPolicy.findUnique({ where: { spaceId: space.id } });
      if (policy?.active) {
        const req = input.approvedRequestId ? await tx.knowledgePublicationRequest.findFirst({ where: { id: input.approvedRequestId, articleId: article.id, status: 'APPROVED', draftRevisionId: input.draftRevisionId } }) : null;
        if (!req) throw new AppError('BUSINESS_RULE_VIOLATION', 'An approved review of this exact revision is required.', 422);
      }
      const rev = await tx.knowledgeRevision.findUniqueOrThrow({ where: { id: input.draftRevisionId } });
      if (rev.safetyScan !== 'PASSED') throw new AppError('BUSINESS_RULE_VIOLATION', 'Content failed the safety scan (script-like markup).', 422);
      for (const b of await tx.knowledgeFileBinding.findMany({ where: { revisionId: rev.id } })) await cleanFile(tx, actor, b.fileId);
      await tx.knowledgeRevision.update({ where: { id: rev.id }, data: { state: 'PUBLISHED' } });
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { publishedRevisionId: rev.id, status: article.status === 'ARCHIVED' ? 'ARCHIVED' : 'PUBLISHED', publishedAt: new Date(), title: rev.title, version: { increment: 1 },
        reviewDueAt: policy?.reviewIntervalDays ? new Date(Date.now() + policy.reviewIntervalDays * 86400000) : null } });
      if (article.status !== updated.status) await lifecycleEvent(tx, article, updated.status, actor.userId, 'PUBLISHED');
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ARTICLE_PUBLISHED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { revisionId: rev.id, versionNumber: rev.versionNumber }, requestId });
      await articleEvent(tx, updated, 'KNOWLEDGE_ARTICLE_PUBLISHED', actor.userId, { revisionId: rev.id });
      return { articleId: article.id, publishedRevisionId: rev.id, replayed: false };
    });
  }
  async setReviewPolicy(actor: Principal, spaceId: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ requiredReviewers: z.number().int().min(1).max(5).default(1), reviewIntervalDays: z.number().int().min(1).max(3650).nullable().default(null), twoPersonRule: z.boolean().default(true), active: z.boolean().default(true) }).parse(raw);
    return this.db.$transaction(async tx => {
      const { space } = await loadSpace(tx, actor, spaceId, 'MANAGE', 'knowledge.space.update');
      const row = await tx.knowledgeReviewPolicy.upsert({ where: { spaceId: space.id }, create: { workspaceId: actor.workspaceId, spaceId: space.id, ...input }, update: { ...input, version: { increment: 1 } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_REVIEW_POLICY_CHANGED', resourceType: 'KnowledgeReviewPolicy', resourceId: row.id, after: input, requestId });
      return row;
    });
  }
  async createAckRequirement(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ audienceScope: z.strictObject({ all: z.boolean().default(false), userIds: z.array(z.uuid()).max(5000).default([]), departmentIds: z.array(z.uuid()).max(200).default([]) }),
      dueAt: z.iso.datetime({ offset: true }).optional(), renewalPolicy: z.enum(['EACH_PUBLISHED_REVISION', 'ONCE']).default('EACH_PUBLISHED_REVISION'), restricted: z.boolean().default(false) }).parse(raw);
    if (input.dueAt && new Date(input.dueAt) <= new Date()) throw new AppError('VALIDATION_FAILED', 'Due date must be in the future.', 400);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.article.publish');
      if (!article.publishedRevisionId) throw new AppError('INVALID_STATE_TRANSITION', 'Only published articles can require acknowledgement.', 409);
      await tx.knowledgeAckRequirement.updateMany({ where: { articleId: article.id, active: true }, data: { active: false } });
      const row = await tx.knowledgeAckRequirement.create({ data: { workspaceId: actor.workspaceId, articleId: article.id, publishedRevisionId: article.publishedRevisionId, audienceScope: input.audienceScope, dueAt: input.dueAt ? new Date(input.dueAt) : null, renewalPolicy: input.renewalPolicy, restricted: input.restricted, createdBy: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ACK_REQUIRED', resourceType: 'KnowledgeAckRequirement', resourceId: row.id, after: { renewalPolicy: input.renewalPolicy }, requestId });
      return row;
    });
  }
  /** Self-only, idempotent per requirement+user+revision; older acknowledgements stay recorded (04 AC03/AC04). */
  async acknowledge(actor: Principal, id: string, raw: unknown) {
    const input = z.strictObject({ publishedRevisionId: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'VIEW');
      if (article.publishedRevisionId !== input.publishedRevisionId) throw new AppError('REVISION_CONFLICT', 'Acknowledge the current published revision.', 409);
      const req = await tx.knowledgeAckRequirement.findFirst({ where: { articleId: article.id, active: true } }); if (!req) throw notFound('Acknowledgement requirement');
      const scope = req.audienceScope as { all: boolean; userIds: string[]; departmentIds: string[] };
      const depts = scope.departmentIds.length ? await tx.departmentMember.count({ where: { userId: actor.userId, departmentId: { in: scope.departmentIds }, isDeleted: false } }) : 0;
      if (!scope.all && !scope.userIds.includes(actor.userId) && !depts) throw new AppError('PERMISSION_DENIED', 'You are not in this acknowledgement audience.', 403);
      const revisionId = req.renewalPolicy === 'ONCE' ? req.publishedRevisionId : input.publishedRevisionId;
      const existing = await tx.knowledgeAcknowledgment.findUnique({ where: { requirementId_employeeUserId_revisionId: { requirementId: req.id, employeeUserId: actor.userId, revisionId } } });
      if (existing) return { ...existing, replayed: true };
      const ack = await tx.knowledgeAcknowledgment.create({ data: { requirementId: req.id, employeeUserId: actor.userId, revisionId } });
      await articleEvent(tx, article, 'KNOWLEDGE_ACKNOWLEDGED', actor.userId, { requirementId: req.id, revisionId });
      return { ...ack, replayed: false };
    });
  }
  async acknowledgements(actor: Principal, raw: unknown) {
    requirePermission(actor, 'knowledge.acknowledgement.read');
    const q = z.object({ articleId: z.uuid() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, q.articleId, 'VIEW');
      const reqs = await tx.knowledgeAckRequirement.findMany({ where: { articleId: article.id }, orderBy: { createdAt: 'desc' } });
      const visible = reqs.filter(r => !r.restricted || level >= LEVELS.MANAGE); // restricted (e.g. HR policy) lists stay with authorized reviewers
      const acks = await tx.knowledgeAcknowledgment.findMany({ where: { requirementId: { in: visible.map(r => r.id) } }, orderBy: { acknowledgedAt: 'desc' } });
      return visible.map(r => ({ ...r, acknowledgements: acks.filter(a => a.requirementId === r.id) }));
    });
  }
  async overdueReviews(actor: Principal) {
    requirePermission(actor, 'knowledge.article.edit');
    const rows = await this.db.knowledgeArticle.findMany({ where: { workspaceId: actor.workspaceId, status: 'PUBLISHED', reviewDueAt: { lt: new Date() } }, orderBy: { reviewDueAt: 'asc' }, take: 500 });
    const out = [];
    for (const a of rows) if (await this.db.$transaction(tx => articleLevel(tx, actor, a)) >= LEVELS.EDIT) out.push({ id: a.id, title: a.title, spaceId: a.spaceId, reviewDueAt: a.reviewDueAt, ownerUserId: a.ownerUserId });
    return out;
  }

  // ------------------------------------------------------------------ 07 archive, recycle bin, restore, purge
  async archive(actor: Principal, id: string, on: boolean, requestId: string) {
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.article.archive');
      if (on ? !['DRAFT', 'PUBLISHED'].includes(article.status) : article.status !== 'ARCHIVED') throw new AppError('INVALID_STATE_TRANSITION', `Article is ${article.status}.`, 409);
      const next = on ? 'ARCHIVED' : article.statusBeforeArchive ?? (article.publishedRevisionId ? 'PUBLISHED' : 'DRAFT');
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { status: next, statusBeforeArchive: on ? article.status : null, version: { increment: 1 } } });
      await lifecycleEvent(tx, article, next, actor.userId);
      await aclChanged(tx, actor.workspaceId, [article.id], on ? 'ARCHIVED' : 'UNARCHIVED', actor.userId); // archived content leaves AI retrieval
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: on ? 'KNOWLEDGE_ARTICLE_ARCHIVED' : 'KNOWLEDGE_ARTICLE_UNARCHIVED', resourceType: 'KnowledgeArticle', resourceId: article.id, before: { status: article.status }, after: { status: next }, requestId });
      await articleEvent(tx, updated, on ? 'KNOWLEDGE_ARTICLE_ARCHIVED' : 'KNOWLEDGE_ARTICLE_UNARCHIVED', actor.userId);
      return updated;
    });
  }
  /** Delete = Recycle Bin for the whole subtree (no orphans); idempotent; recoverable for the configured period (default 30 days). */
  async recycle(actor: Principal, id: string, requestId: string) {
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.article.delete');
      if (article.status === 'RECYCLED') return { id: article.id, status: 'RECYCLED', replayed: true };
      const days = await recycleDays(tx), ids = await subtreeIds(tx, article.id);
      const rows = await tx.knowledgeArticle.findMany({ where: { id: { in: ids }, status: { notIn: ['RECYCLED', 'PURGED'] } } });
      for (const a of rows) {
        await tx.knowledgeArticle.update({ where: { id: a.id }, data: { status: 'RECYCLED', statusBeforeRecycle: a.status, version: { increment: 1 } } });
        await tx.knowledgeTombstone.upsert({ where: { articleId: a.id }, create: { workspaceId: a.workspaceId, articleId: a.id, originalSpaceId: a.spaceId, originalParentId: a.parentArticleId, recoverUntil: new Date(Date.now() + days * 86400000) }, update: { deletedAt: new Date(), recoverUntil: new Date(Date.now() + days * 86400000) } });
        await lifecycleEvent(tx, a, 'RECYCLED', actor.userId);
        await articleEvent(tx, { ...a, version: a.version + 1 }, 'KNOWLEDGE_ARTICLE_RECYCLED', actor.userId);
      }
      await aclChanged(tx, actor.workspaceId, rows.map(r => r.id), 'RECYCLED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ARTICLE_RECYCLED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { subtree: rows.length, recoverDays: days }, requestId });
      return { id: article.id, status: 'RECYCLED', recycled: rows.length, replayed: false };
    });
  }
  /** Restores to the prior status (archived stays archived, 07 AC02); missing parents restore to the space root; slug collisions are 409. */
  async restore(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ newSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/).optional() }).parse(raw ?? {});
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.article.restore');
      if (article.status !== 'RECYCLED') throw new AppError('INVALID_STATE_TRANSITION', `Article is ${article.status}.`, 409);
      const parent = article.parentArticleId ? await tx.knowledgeArticle.findUnique({ where: { id: article.parentArticleId } }) : null;
      const parentId = parent && !['RECYCLED', 'PURGED'].includes(parent.status) ? parent.id : null;
      const slug = input.newSlug ?? article.slug;
      const collision = await tx.knowledgeArticle.findFirst({ where: { workspaceId: article.workspaceId, spaceId: article.spaceId, parentArticleId: parentId, slug: { equals: slug, mode: 'insensitive' }, status: { notIn: ['RECYCLED', 'PURGED'] }, id: { not: article.id } } });
      if (collision) throw new AppError('SLUG_COLLISION', 'A sibling already uses this path; restore with a new slug.', 409, { slug, conflictingArticleId: collision.id });
      const ids = await subtreeIds(tx, article.id);
      const rows = await tx.knowledgeArticle.findMany({ where: { id: { in: ids }, status: 'RECYCLED' } });
      for (const a of rows) {
        const next = a.statusBeforeRecycle ?? 'DRAFT';
        await tx.knowledgeArticle.update({ where: { id: a.id }, data: { status: next, statusBeforeRecycle: null, version: { increment: 1 }, ...(a.id === article.id ? { parentArticleId: parentId, slug } : {}) } });
        await tx.knowledgeTombstone.deleteMany({ where: { articleId: a.id } });
        await lifecycleEvent(tx, a, next, actor.userId, 'RESTORED');
        await articleEvent(tx, { ...a, version: a.version + 1 }, 'KNOWLEDGE_ARTICLE_RESTORED', actor.userId, { status: next });
      }
      if (parentId !== article.parentArticleId) await rebuildPaths(tx, article.id);
      await aclChanged(tx, actor.workspaceId, rows.map(r => r.id), 'RESTORED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ARTICLE_RESTORED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { restored: rows.length, parentArticleId: parentId }, requestId });
      return { id: article.id, restored: rows.length, status: rows.find(r => r.id === article.id)?.statusBeforeRecycle ?? 'DRAFT' };
    });
  }
  /**
   * Purge: after the recovery window, never under legal hold (07 AC01/AC05). Content, revisions, chunks, grants are deleted; the
   * article row becomes a sanitized tombstone so redacted audit references survive (AC04).
   */
  async purge(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ reason: z.string().trim().min(5).max(1000), confirmation: z.literal('PURGE') }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.article.purge');
      if (article.status !== 'RECYCLED') throw new AppError('INVALID_STATE_TRANSITION', 'Only recycled articles can be purged.', 409);
      const tomb = await tx.knowledgeTombstone.findUnique({ where: { articleId: article.id } });
      if (tomb?.legalHold || await legalHoldActive(tx, actor.workspaceId, 'knowledge', article.id) || await legalHoldActive(tx, actor.workspaceId, 'knowledge', article.spaceId)) throw new AppError('LEGAL_HOLD_ACTIVE', 'A legal hold prevents purging this article.', 409);
      if (tomb && tomb.recoverUntil > new Date() && !await PlatformConfigService.platformSetting<boolean>(tx, 'knowledgeEarlyPurgeAllowed', false)) throw new AppError('BUSINESS_RULE_VIOLATION', 'The recovery window has not ended yet.', 422, { recoverUntil: tomb.recoverUntil });
      if (await tx.knowledgeArticle.count({ where: { parentArticleId: article.id, status: { not: 'PURGED' } } })) throw new AppError('BUSINESS_RULE_VIOLATION', 'Purge child articles first.', 422);
      const revisions = await tx.knowledgeRevision.findMany({ where: { articleId: article.id }, select: { id: true } });
      await tx.$executeRaw`SELECT set_config('knowledge.purge', 'on', true)`;
      await tx.knowledgeSection.deleteMany({ where: { revisionId: { in: revisions.map(r => r.id) } } });
      await tx.knowledgeFileBinding.deleteMany({ where: { articleId: article.id } });
      await tx.knowledgeAiChunk.deleteMany({ where: { articleId: article.id } });
      await tx.knowledgeAclEntry.deleteMany({ where: { resourceType: 'ARTICLE', resourceId: article.id } });
      await tx.knowledgeShare.deleteMany({ where: { articleId: article.id } });
      await tx.knowledgeGuestInvitation.updateMany({ where: { articleId: article.id, status: { in: ['PENDING', 'ACCEPTED'] } }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await tx.knowledgeFavorite.deleteMany({ where: { articleId: article.id } });
      await tx.knowledgeEditSession.deleteMany({ where: { articleId: article.id } });
      await tx.knowledgeRevision.deleteMany({ where: { articleId: article.id } });
      await tx.knowledgeArticlePath.deleteMany({ where: { OR: [{ ancestorId: article.id }, { descendantId: article.id }] } });
      const updated = await tx.knowledgeArticle.update({ where: { id: article.id }, data: { status: 'PURGED', title: 'Purged article', slug: 'purged-' + article.id, currentDraftRevisionId: null, publishedRevisionId: null, version: { increment: 1 } } });
      await tx.knowledgeTombstone.deleteMany({ where: { articleId: article.id } });
      await lifecycleEvent(tx, article, 'PURGED', actor.userId, input.reason);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ARTICLE_PURGED', resourceType: 'KnowledgeArticle', resourceId: article.id, after: { reason: input.reason, revisions: revisions.length }, requestId });
      await articleEvent(tx, updated, 'KNOWLEDGE_ARTICLE_PURGED', actor.userId);
      return { id: article.id, purged: true };
    });
  }
  async recycleBin(actor: Principal, raw: unknown) {
    const q = listQuery(['deletedAt']).extend({ spaceId: z.uuid().optional() }).strict().parse(raw);
    const tombs = await this.db.knowledgeTombstone.findMany({ where: { workspaceId: actor.workspaceId, ...(q.spaceId ? { originalSpaceId: q.spaceId } : {}) }, orderBy: { deletedAt: 'desc' }, take: 2000 });
    const out = [];
    for (const t of tombs) {
      const a = await this.db.knowledgeArticle.findUnique({ where: { id: t.articleId } });
      if (a && await this.db.$transaction(tx => articleLevel(tx, actor, a)) >= LEVELS.MANAGE) out.push({ articleId: a.id, title: a.title, spaceId: t.originalSpaceId, deletedAt: t.deletedAt, recoverUntil: t.recoverUntil, legalHold: t.legalHold });
    }
    return paged(out.slice((q.page - 1) * q.limit, q.page * q.limit), out.length, q.page, q.limit);
  }
}

/** Overdue reviews create reminders/assignments and escalate; never delete or republish (04 AC05). */
registerJob({ type: 'knowledge.reviews.overdue', ownerModule: 'knowledge', maxAttempts: 3, async run() {
  const { prisma } = await import('../prisma-client');
  const due = await prisma.knowledgeArticle.findMany({ where: { status: 'PUBLISHED', reviewDueAt: { lt: new Date() } }, take: 500 });
  let created = 0, escalated = 0;
  for (const a of due) await prisma.$transaction(async tx => {
    const existing = await tx.knowledgeReviewAssignment.findUnique({ where: { articleId_dueAt: { articleId: a.id, dueAt: a.reviewDueAt! } } });
    if (!existing) {
      await tx.knowledgeReviewAssignment.create({ data: { workspaceId: a.workspaceId, articleId: a.id, reviewerUserId: a.ownerUserId, dueAt: a.reviewDueAt! } });
      await PlatformNotificationService.emitInTx(tx, { workspaceId: a.workspaceId, recipientIds: [a.ownerUserId], topic: 'KNOWLEDGE', title: 'Article review overdue', message: 'An article you own is due for review.', eventId: `kb-review:${a.id}:${a.reviewDueAt!.toISOString()}`, subject: { type: 'knowledge.article', id: a.id }, link: `/knowledge/articles/${a.id}` });
      await articleEvent(tx, a, 'KNOWLEDGE_REVIEW_OVERDUE', null);
      created++;
    } else if (existing.currentState === 'OPEN' && !existing.escalatedAt && existing.dueAt.getTime() + 7 * 86400000 < Date.now()) {
      await tx.knowledgeReviewAssignment.update({ where: { id: existing.id }, data: { escalatedAt: new Date() } });
      await articleEvent(tx, a, 'KNOWLEDGE_REVIEW_ESCALATED', null);
      escalated++;
    }
  });
  return { created, escalated };
} });
registerSchedule({ name: 'knowledge.reviews.daily', ownerModule: 'knowledge', jobType: 'knowledge.reviews.overdue', dailyLocalTime: '06:30', timezone: 'UTC' });
