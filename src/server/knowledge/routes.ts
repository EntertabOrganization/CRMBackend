import { prisma } from '../prisma-client';
import '../platform/register';
import { SuiteRouter } from '../platform/http';
import { KnowledgeAccessService } from './access-service';
import { KnowledgeArticleService } from './article-service';
import { KnowledgeExchangeService } from './exchange-service';
import { KnowledgeIndexService } from './index-service';
import { KnowledgeInsightService } from './insight-service';
import { KnowledgeSpaceService } from './space-service';

const spaces = new KnowledgeSpaceService(prisma), articles = new KnowledgeArticleService(prisma), access = new KnowledgeAccessService(prisma);
const index = new KnowledgeIndexService(prisma), exchange = new KnowledgeExchangeService(prisma), insight = new KnowledgeInsightService(prisma);
const K = '/api/v1/knowledge', A = K + '/articles/:id';
const ip = (c: { request: { headers: Headers } }) => c.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

/** 28-Knowledge-Base HTTP surface (Workspace principals; guests use the public router). */
export const knowledgeRouter = new SuiteRouter()
  // 01 spaces & hierarchy
  .workspace('POST', K + '/spaces', c => spaces.create(c.actor, c.body, c.requestId), 201)
  .workspace('GET', K + '/spaces', c => spaces.list(c.actor, c.query))
  .workspace('GET', K + '/spaces/:id', c => spaces.get(c.actor, c.params.id))
  .workspace('PATCH', K + '/spaces/:id', c => spaces.update(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', K + '/spaces/:id/archive', c => spaces.lifecycle(c.actor, c.params.id, 'archive', c.requestId))
  .workspace('POST', K + '/spaces/:id/restore', c => spaces.lifecycle(c.actor, c.params.id, 'restore', c.requestId))
  .workspace('POST', K + '/spaces/:id/recycle', c => spaces.lifecycle(c.actor, c.params.id, 'recycle', c.requestId))
  .workspace('GET', K + '/spaces/:id/tree', c => spaces.tree(c.actor, c.params.id))
  .workspace('PUT', K + '/spaces/:id/review-policy', c => articles.setReviewPolicy(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', K + '/spaces/:id/ai-indexing', c => index.setAiIndexing(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/move', c => spaces.move(c.actor, c.params.id, c.body, c.requestId))
  // 02 editor & revisions
  .workspace('POST', K + '/articles', c => articles.create(c.actor, c.body, c.requestId), 201)
  .workspace('GET', A, c => articles.get(c.actor, c.params.id, c.query))
  .workspace('PUT', A + '/draft', c => articles.saveDraft(c.actor, c.params.id, c.body, c.key, c.requestId))
  .workspace('POST', A + '/collaborative-edits', c => articles.collaborate(c.actor, c.params.id, c.body, c.key, c.requestId))
  .workspace('GET', A + '/guest-invitations/:invitationId/delivery', c => access.guestDelivery(c.actor, c.params.id, c.params.invitationId))
  .workspace('GET', A + '/revisions', c => articles.revisions(c.actor, c.params.id, c.query))
  .workspace('GET', A + '/revisions/:revisionId', c => articles.revision(c.actor, c.params.id, c.params.revisionId))
  .workspace('POST', A + '/revert', c => articles.revert(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/sections/:anchor/link', c => articles.sectionLink(c.actor, c.params.id, c.params.anchor))
  // 03 access
  .workspace('GET', A + '/access', c => access.getAccess(c.actor, c.params.id))
  .workspace('PUT', A + '/access', c => access.putAccess(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/shares', c => access.share(c.actor, c.params.id, c.body, c.requestId), 201)
  .workspace('DELETE', A + '/shares/:shareId', c => access.revokeShare(c.actor, c.params.id, c.params.shareId, c.requestId))
  .workspace('POST', A + '/guest-invitations', c => access.inviteGuest(c.actor, c.params.id, c.body, c.requestId), 202)
  .workspace('DELETE', A + '/guest-invitations/:invitationId', c => access.revokeGuest(c.actor, c.params.id, c.params.invitationId, c.requestId))
  // 04 review / publish / acknowledgement
  .workspace('POST', A + '/request-publication', c => articles.requestPublication(c.actor, c.params.id, c.body, c.requestId), 201)
  .workspace('POST', A + '/approve', c => articles.approve(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/reject', c => articles.reject(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/publish', c => articles.publish(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/acknowledgement-requirements', c => articles.createAckRequirement(c.actor, c.params.id, c.body, c.requestId), 201)
  .workspace('POST', A + '/acknowledge', c => articles.acknowledge(c.actor, c.params.id, c.body))
  .workspace('GET', K + '/reviews/overdue', c => articles.overdueReviews(c.actor))
  .workspace('GET', K + '/acknowledgements', c => articles.acknowledgements(c.actor, c.query))
  // 05 search / AI / citations
  .workspace('GET', K + '/search', c => index.search(c.actor, c.query))
  .workspace('POST', A + '/reindex', c => index.reindex(c.actor, c.params.id), 202)
  .workspace('GET', A + '/citation', c => index.citation(c.actor, c.params.id, c.query))
  // 06 import / export / templates
  .workspace('POST', K + '/import-jobs', c => exchange.createImport(c.actor, c.body, c.requestId), 202)
  .workspace('POST', K + '/import-jobs/:id/execute', c => exchange.executeImport(c.actor, c.params.id, c.body, c.requestId), 202)
  .workspace('POST', K + '/import-jobs/:id/cancel', c => exchange.cancelImport(c.actor, c.params.id))
  .workspace('GET', K + '/import-jobs/:id', c => exchange.getImport(c.actor, c.params.id))
  .workspace('POST', K + '/export-jobs', c => exchange.createExport(c.actor, c.body, c.requestId), 202)
  .workspace('GET', K + '/export-jobs/:id/download', c => exchange.downloadExport(c.actor, c.params.id))
  .workspace('GET', K + '/templates', c => exchange.templates(c.actor, c.query))
  .workspace('POST', K + '/templates', c => exchange.createTemplate(c.actor, c.body, c.requestId), 201)
  // 07 lifecycle
  .workspace('POST', A + '/archive', c => articles.archive(c.actor, c.params.id, true, c.requestId))
  .workspace('POST', A + '/unarchive', c => articles.archive(c.actor, c.params.id, false, c.requestId))
  .workspace('DELETE', A, c => articles.recycle(c.actor, c.params.id, c.requestId))
  .workspace('POST', A + '/restore', c => articles.restore(c.actor, c.params.id, c.body, c.requestId))
  .workspace('POST', A + '/purge', c => articles.purge(c.actor, c.params.id, c.body, c.requestId))
  .workspace('GET', K + '/recycle-bin', c => articles.recycleBin(c.actor, c.query))
  // 08 experience & analytics
  .workspace('GET', K + '/me/shared', c => access.sharedWithMe(c.actor))
  .workspace('GET', K + '/me/favorites', c => insight.favorites(c.actor))
  .workspace('PUT', K + '/me/favorites/:articleId', c => insight.favorite(c.actor, c.params.articleId, true))
  .workspace('DELETE', K + '/me/favorites/:articleId', c => insight.favorite(c.actor, c.params.articleId, false))
  .workspace('GET', K + '/me/recent', c => insight.recent(c.actor))
  .workspace('POST', A + '/reads', c => insight.recordRead(c.actor, c.params.id))
  .workspace('GET', K + '/analytics', c => insight.analytics(c.actor, c.query))
  .workspace('GET', K + '/admin/reviews', c => insight.reviewQueue(c.actor, c.query))
  .workspace('POST', A + '/review-complete', c => insight.completeReview(c.actor, c.params.id, c.body));

/** Guest (article-scoped) and service-identity endpoints. */
export const knowledgePublicRouter = new SuiteRouter()
  .public('POST', '/api/v1/public/knowledge/guest-invitations/accept', c => access.acceptGuest(c.body, ip(c)))
  .public('GET', '/api/v1/public/knowledge/guest/article', c => access.guestRead(c.request.headers.get('authorization')))
  .public('POST', '/api/v1/internal/knowledge/retrieve', c => index.internalRetrieve(c.request.headers.get('authorization'), c.body));
