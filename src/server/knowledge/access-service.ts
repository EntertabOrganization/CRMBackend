import type { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { enforceRateLimit } from '../platform/governance-service';
import { PlatformNotificationService } from '../platform/notifications-service';
import { assertVersion, audit, emitEvent, notFound } from '../platform/kernel';
import { aclChanged, articleEvent, LEVELS, loadArticle, sha, type Content, type Level } from './support';

const GUEST_DAYS = () => Number(process.env.KNOWLEDGE_GUEST_MAX_DAYS ?? 30), GUEST_SESSION_HOURS = 8;
const guestSecret = () => process.env.KNOWLEDGE_GUEST_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'local-knowledge-guest-secret';
const signGuest = (body: string) => createHmac('sha256', guestSecret()).update(body).digest('base64url');
const entry = z.strictObject({ principalType: z.enum(['USER', 'DEPARTMENT', 'PROJECT']), principalId: z.uuid(), level: z.enum(['VIEW', 'COMMENT', 'EDIT', 'MANAGE']), effect: z.enum(['ALLOW', 'DENY']).default('ALLOW'), expiresAt: z.iso.datetime({ offset: true }).nullable().default(null) });

/** Article ACL, direct shares and article-scoped external guests (28/03). */
export class KnowledgeAccessService {
  constructor(private readonly db: PrismaClient) {}

  async getAccess(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'VIEW');
      if (level < LEVELS.MANAGE) return { myLevel: Object.keys(LEVELS)[level], entries: [], shares: [] }; // only managers see the ACL
      const [entries, shares, guests] = await Promise.all([tx.knowledgeAclEntry.findMany({ where: { workspaceId: actor.workspaceId, resourceType: 'ARTICLE', resourceId: article.id } }),
        tx.knowledgeShare.findMany({ where: { articleId: article.id, revokedAt: null } }), tx.knowledgeGuestInvitation.findMany({ where: { articleId: article.id, status: { in: ['PENDING', 'ACCEPTED'] } }, select: { id: true, status: true, expiresAt: true, createdAt: true } })]);
      return { myLevel: 'MANAGE', aclVersion: article.aclVersion, entries, shares, guests };
    });
  }
  /** Replace article ACL; grants can't exceed the grantor's own level; deny beats allow; commits ACL version + outbox + audit. */
  async putAccess(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ entries: z.array(entry).max(200), expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.access.manage');
      assertVersion(article.aclVersion, input.expectedVersion); // expectedVersion is the ACL version
      for (const e of input.entries) {
        if (LEVELS[e.level as Level] > level) throw new AppError('PERMISSION_DENIED', 'You cannot grant more than your own access.', 403);
        const exists = e.principalType === 'USER' ? await tx.workspaceMembership.findFirst({ where: { workspaceId: actor.workspaceId, userId: e.principalId, isDeleted: false } })
          : e.principalType === 'DEPARTMENT' ? await tx.department.findFirst({ where: { workspaceId: actor.workspaceId, id: e.principalId, isDeleted: false } }) : await tx.project.findFirst({ where: { workspaceId: actor.workspaceId, id: e.principalId, isDeleted: false } });
        if (!exists) throw new AppError('VALIDATION_FAILED', 'ACL principals must belong to this Workspace.', 400, { fields: [{ field: 'entries.principalId', reason: 'NOT_IN_WORKSPACE' }] });
      }
      const before = await tx.knowledgeAclEntry.findMany({ where: { workspaceId: actor.workspaceId, resourceType: 'ARTICLE', resourceId: article.id } });
      await tx.knowledgeAclEntry.deleteMany({ where: { workspaceId: actor.workspaceId, resourceType: 'ARTICLE', resourceId: article.id } });
      for (const e of input.entries) await tx.knowledgeAclEntry.create({ data: { workspaceId: actor.workspaceId, resourceType: 'ARTICLE', resourceId: article.id, principalType: e.principalType, principalId: e.principalId, level: e.level, effect: e.effect, issuedBy: actor.userId, expiresAt: e.expiresAt ? new Date(e.expiresAt) : null } });
      const descendants = (await tx.knowledgeArticlePath.findMany({ where: { ancestorId: article.id }, select: { descendantId: true } })).map(r => r.descendantId);
      await aclChanged(tx, actor.workspaceId, [...new Set([article.id, ...descendants])], 'ACL_CHANGED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ACCESS_CHANGED', resourceType: 'KnowledgeArticle', resourceId: article.id, before: before.map(b => ({ t: b.principalType, l: b.level, e: b.effect })), after: input.entries.map(b => ({ t: b.principalType, l: b.level, e: b.effect })), requestId });
      await articleEvent(tx, article, 'KNOWLEDGE_ACCESS_CHANGED', actor.userId);
      return { aclVersion: article.aclVersion + 1, entries: input.entries.length };
    });
  }
  /** Direct share requires MANAGE; a link alone never authorizes (03 rule 2). */
  async share(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ recipientUserId: z.uuid(), level: z.enum(['VIEW', 'COMMENT', 'EDIT']), expiresAt: z.iso.datetime({ offset: true }).optional() }).parse(raw);
    return this.db.$transaction(async tx => {
      const { article, level } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.share');
      if (LEVELS[input.level] > level) throw new AppError('PERMISSION_DENIED', 'You cannot share above your own access.', 403);
      if (!await tx.workspaceMembership.findFirst({ where: { workspaceId: actor.workspaceId, userId: input.recipientUserId, status: 'ACTIVE', isDeleted: false } })) throw new AppError('VALIDATION_FAILED', 'Recipient must be an active Workspace member (use a guest invitation for outsiders).', 400);
      await tx.knowledgeShare.updateMany({ where: { articleId: article.id, sharedWithUserId: input.recipientUserId, revokedAt: null }, data: { revokedAt: new Date() } });
      const share = await tx.knowledgeShare.create({ data: { workspaceId: actor.workspaceId, articleId: article.id, sharedWithUserId: input.recipientUserId, level: input.level, grantedBy: actor.userId, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } });
      await aclChanged(tx, actor.workspaceId, [article.id], 'SHARED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ACCESS_CHANGED', resourceType: 'KnowledgeShare', resourceId: share.id, after: { recipientUserId: input.recipientUserId, level: input.level }, requestId });
      await PlatformNotificationService.emitInTx(tx, { workspaceId: actor.workspaceId, recipientIds: [input.recipientUserId], topic: 'KNOWLEDGE', title: 'An article was shared with you', message: 'Open it from Knowledge → Shared with me.', eventId: 'kb-share:' + share.id, subject: { type: 'knowledge.article', id: article.id }, link: `/knowledge/articles/${article.id}` });
      return share;
    });
  }
  async revokeShare(actor: Principal, id: string, shareId: string, requestId: string) {
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.share');
      const r = await tx.knowledgeShare.updateMany({ where: { id: z.uuid().parse(shareId), articleId: article.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (!r.count) throw notFound('Share');
      await aclChanged(tx, actor.workspaceId, [article.id], 'SHARE_REVOKED', actor.userId);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_ACCESS_CHANGED', resourceType: 'KnowledgeShare', resourceId: shareId, after: { revoked: true }, requestId });
      return { id: shareId, revoked: true };
    });
  }
  /** Guest invitation: one article, VIEW only, hashed single-use token, capped expiry; no Workspace membership (03 rule 3). */
  async inviteGuest(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ email: z.email().max(254), scope: z.literal('VIEW').default('VIEW'), expiresAt: z.iso.datetime({ offset: true }) }).parse(raw);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= new Date() || expiresAt.getTime() - Date.now() > GUEST_DAYS() * 86400000) throw new AppError('VALIDATION_FAILED', `Guest access must expire within ${GUEST_DAYS()} days.`, 400);
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.guest.invite');
      if (!article.publishedRevisionId) throw new AppError('INVALID_STATE_TRANSITION', 'Only published articles can be shared with guests.', 409);
      const inv = await tx.knowledgeGuestInvitation.create({ data: { workspaceId: actor.workspaceId, articleId: article.id, emailHash: sha(input.email.trim().toLowerCase()), tokenHash: sha(token), invitedBy: actor.userId, expiresAt } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_GUEST_INVITED', resourceType: 'KnowledgeGuestInvitation', resourceId: inv.id, after: { articleId: article.id, expiresAt }, requestId });
      await articleEvent(tx, article, 'KNOWLEDGE_GUEST_INVITED', actor.userId, { invitationId: inv.id });
      return inv;
    });
    // Email delivery is the Notifications provider's job; the raw token is returned once for that hand-off and never stored.
    return { id: invitation.id, status: invitation.status, expiresAt, deliveryToken: token };
  }
  async revokeGuest(actor: Principal, id: string, invitationId: string, requestId: string) {
    return this.db.$transaction(async tx => {
      const { article } = await loadArticle(tx, actor, id, 'MANAGE', 'knowledge.guest.invite');
      const r = await tx.knowledgeGuestInvitation.updateMany({ where: { id: z.uuid().parse(invitationId), articleId: article.id, status: { in: ['PENDING', 'ACCEPTED'] } }, data: { status: 'REVOKED', revokedAt: new Date() } });
      if (!r.count) throw notFound('Invitation');
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_GUEST_REVOKED', resourceType: 'KnowledgeGuestInvitation', resourceId: invitationId, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'KNOWLEDGE_GUEST_REVOKED', aggregateType: 'KnowledgeGuestInvitation', aggregateId: invitationId, actorId: actor.userId, payload: { articleId: article.id } });
      return { id: invitationId, status: 'REVOKED' }; // the next guest read re-checks status and fails immediately (AC02)
    });
  }
  /** Single activation by the recipient email; returns a short-lived signed guest session bound to the invitation. */
  async acceptGuest(raw: unknown, ip: string | null) {
    const input = z.strictObject({ token: z.string().min(20).max(200), email: z.email().max(254) }).parse(raw);
    await enforceRateLimit(this.db, 'knowledge.guest.accept', 'IP', ip ?? 'unknown', { requests: 10, windowSeconds: 600 });
    return this.db.$transaction(async tx => {
      const inv = await tx.knowledgeGuestInvitation.findUnique({ where: { tokenHash: sha(input.token) } });
      const invalid = new AppError('VALIDATION_FAILED', 'Invitation is invalid or expired.', 400);
      if (!inv || inv.status !== 'PENDING' || inv.emailHash !== sha(input.email.trim().toLowerCase())) throw invalid;
      if (inv.expiresAt <= new Date()) { await tx.knowledgeGuestInvitation.update({ where: { id: inv.id }, data: { status: 'EXPIRED' } }); throw invalid; }
      await tx.knowledgeGuestInvitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      const exp = Math.floor(Math.min(inv.expiresAt.getTime(), Date.now() + GUEST_SESSION_HOURS * 3600000) / 1000);
      const body = Buffer.from(JSON.stringify({ i: inv.id, exp })).toString('base64url');
      return { guestSession: body + '.' + signGuest(body), articleId: inv.articleId, expiresAt: new Date(exp * 1000) };
    });
  }
  /** Guest read: invitation must still be ACCEPTED/unexpired and the article live+published; published content only. */
  async guestRead(session: string | null) {
    const [body, mac] = (session ?? '').replace(/^Bearer\s+/i, '').split('.');
    const expected = body ? signGuest(body) : '';
    if (!body || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new AppError('UNAUTHENTICATED', 'Guest session is invalid.', 401);
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as { i: string; exp: number };
    if (claims.exp * 1000 < Date.now()) throw new AppError('UNAUTHENTICATED', 'Guest session expired.', 401);
    const inv = await this.db.knowledgeGuestInvitation.findUnique({ where: { id: claims.i } });
    if (!inv || inv.status !== 'ACCEPTED' || inv.expiresAt <= new Date()) throw new AppError('UNAUTHENTICATED', 'Guest access was revoked or expired.', 401);
    const article = await this.db.knowledgeArticle.findFirst({ where: { id: inv.articleId, status: 'PUBLISHED' } });
    const space = article ? await this.db.knowledgeSpace.findUnique({ where: { id: article.spaceId } }) : null;
    if (!article?.publishedRevisionId || space?.status !== 'ACTIVE') throw notFound('Article');
    const rev = await this.db.knowledgeRevision.findUniqueOrThrow({ where: { id: article.publishedRevisionId } });
    // Guests never receive embedded files (no File ACL principal exists for them).
    const content = { blocks: (rev.contentJson as Content).blocks.map(b => 'fileId' in b ? { type: b.type, unavailable: true, caption: '' } : b) };
    return { articleId: article.id, title: rev.title, revisionId: rev.id, content };
  }
  /** Shared-with-me: only currently authorized articles (03 AC03). */
  async sharedWithMe(actor: Principal) {
    requirePermission(actor, 'knowledge.space.read');
    const shares = await this.db.knowledgeShare.findMany({ where: { workspaceId: actor.workspaceId, sharedWithUserId: actor.userId, revokedAt: null }, orderBy: { createdAt: 'desc' }, take: 500 });
    const out = [];
    for (const s of shares) {
      if (s.expiresAt && s.expiresAt <= new Date()) continue;
      try { const { article, level } = await this.db.$transaction(tx => loadArticle(tx, actor, s.articleId, 'VIEW')); out.push({ articleId: article.id, title: article.title, level: Object.keys(LEVELS)[level], sharedAt: s.createdAt, sharedBy: s.grantedBy }); } catch { /* no longer visible */ }
    }
    return out;
  }
}
