import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import { Body, type CollabSupport, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { TasksPolicy } from '../tasks/policy';
import { FEED_POST_TYPES, FEED_RECIPIENT_TYPES, type FeedPoll, type FeedPost, type FeedPostRecipient } from './feed-types';

const MAX_BODY = 20_000, MAX_COMMENT = 5_000;
const REACTION_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]{1,16}|:[a-z0-9_+-]{1,32}:)$/u;
type Recipient = { recipientType: FeedPostRecipient['recipientType']; recipientId: string | null };

/**
 * Feed is a recipient-based broadcast model, not Chat: audiences are WORKSPACE/USER/DEPARTMENT/PROJECT recipients
 * resolved live for ordinary posts. Announcements also snapshot their audience at publication so acknowledgement
 * metrics keep a stable denominator. Every read re-evaluates visibility; unauthorized callers see FEED_POST_NOT_FOUND.
 */
export class FeedService {
  constructor(private readonly support: CollabSupport, private readonly tasks: TasksPolicy) {}
  private get state() { return this.support.state; }

  // ---- audience -------------------------------------------------------------------------------------------------------

  private recipients(post: FeedPost) { return this.state.feedPostRecipients.filter(row => row.postId === post.id && row.workspaceId === post.workspaceId); }
  private departmentUsers(workspaceId: string, id: string) {
    const department = this.state.departments.find(row => row.id === id && row.workspaceId === workspaceId && !row.isDeleted);
    return department ? [...(department.managerId ? [department.managerId] : []),
      ...this.state.departmentMembers.filter(row => row.departmentId === id && row.workspaceId === workspaceId && !row.isDeleted).map(row => row.userId)] : [];
  }
  private projectUsers(workspaceId: string, id: string) {
    const project = this.state.projects.find(row => row.id === id && row.workspaceId === workspaceId && !row.isDeleted);
    return project ? [project.ownerUserId, ...this.state.projectMembers.filter(row => row.projectId === id && row.status === 'ACTIVE').map(row => row.userId)] : [];
  }
  private inAudience(post: FeedPost, userId: string) {
    if (post.authorUserId === userId) return true;
    if (this.state.feedAudienceSnapshots.some(row => row.postId === post.id && row.userId === userId)) return true;
    return this.recipients(post).some(row => row.recipientType === 'WORKSPACE' || row.recipientType === 'USER' && row.recipientId === userId ||
      row.recipientType === 'DEPARTMENT' && this.departmentUsers(post.workspaceId, row.recipientId!).includes(userId) ||
      row.recipientType === 'PROJECT' && this.projectUsers(post.workspaceId, row.recipientId!).includes(userId));
  }
  /** Users who can currently see a published post (live, active internal members only). */
  private audience(post: FeedPost) {
    return this.state.workspaceMemberships.filter(row => row.workspaceId === post.workspaceId && row.status === 'ACTIVE' && !row.isDeleted)
      .map(row => row.userId).filter(userId => this.support.isEligibleUser(post.workspaceId, userId) && this.inAudience(post, userId));
  }
  private moderator(actor: ActorContext) { return Boolean(this.support.scope(actor, 'feed.moderate')); }
  private canSee(actor: ActorContext, post: FeedPost) {
    if (post.workspaceId !== actor.workspaceId || !this.support.scope(actor, 'feed.read') || !this.support.isEligibleUser(actor.workspaceId, actor.user.id)) return false;
    if (post.status === 'DRAFT') return post.authorUserId === actor.user.id;
    if (post.status === 'DELETED') return this.moderator(actor) || post.authorUserId === actor.user.id;
    return this.inAudience(post, actor.user.id);
  }
  private post(actor: ActorContext, id: string) {
    this.support.require(actor, 'feed.read');
    const row = isUuid(id) ? this.state.feedPosts.find(item => item.id === id.toLowerCase() && this.canSee(actor, item)) : undefined;
    if (!row) throw notFoundError('FEED_POST_NOT_FOUND', 'Feed post');
    return row;
  }
  private published(post: FeedPost) {
    if (post.status !== 'PUBLISHED') throw new AppError('FEED_POST_NOT_PUBLISHED', 'This action requires a published post.', 409);
  }
  /** Authors may target only audiences their permissions and memberships allow. */
  private readRecipients(actor: ActorContext, body: Body): Recipient[] {
    const raw = body.array('recipients', { required: true, max: 100 })!;
    if (!raw.length) throw validationError('recipients', 'At least one recipient is required.');
    const result: Recipient[] = [], wide = Boolean(this.support.scope(actor, 'feed.post_workspace'));
    for (const [index, item] of raw.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw validationError(`recipients.${index}`, 'Each recipient must be an object.');
      const entry = new Body(item as Record<string, unknown>).only(['recipientType', 'recipientId']);
      const recipientType = entry.enumOf('recipientType', FEED_RECIPIENT_TYPES, { required: true });
      const recipientId = recipientType === 'WORKSPACE' ? null : entry.uuid('recipientId', { required: true });
      const denied = () => new AppError('FEED_AUDIENCE_NOT_ALLOWED', 'You cannot publish to this audience.', 403, { recipientType, recipientId });
      if (recipientType === 'WORKSPACE' && !wide) throw denied();
      if (recipientType === 'USER' && !this.support.isEligibleUser(actor.workspaceId, recipientId!)) throw denied();
      if (recipientType === 'DEPARTMENT' && (!this.state.departments.some(row => row.id === recipientId && row.workspaceId === actor.workspaceId && !row.isDeleted) ||
        !wide && !this.departmentUsers(actor.workspaceId, recipientId!).includes(actor.user.id))) throw denied();
      if (recipientType === 'PROJECT') {
        const project = this.state.projects.find(row => row.id === recipientId && row.workspaceId === actor.workspaceId && !row.isDeleted);
        if (!project || !wide && !this.tasks.projectRole(project, actor.user.id)) throw denied();
      }
      if (!result.some(row => row.recipientType === recipientType && row.recipientId === recipientId)) result.push({ recipientType, recipientId });
    }
    return result;
  }
  private setRecipients(post: FeedPost, recipients: Recipient[]) {
    this.state.feedPostRecipients = this.state.feedPostRecipients.filter(row => row.postId !== post.id);
    for (const item of recipients) this.state.feedPostRecipients.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, ...item });
  }

  // ---- views ----------------------------------------------------------------------------------------------------------

  view(actor: ActorContext, post: FeedPost) {
    const reactions = new Map<string, { reaction: string; count: number; reactedByMe: boolean }>();
    for (const row of this.state.feedReactions.filter(item => item.postId === post.id)) {
      const entry = reactions.get(row.reaction) ?? { reaction: row.reaction, count: 0, reactedByMe: false };
      entry.count++; entry.reactedByMe ||= row.userId === actor.user.id; reactions.set(row.reaction, entry);
    }
    const poll = this.state.feedPolls.find(row => row.postId === post.id);
    const { statusBeforeDelete, ...rest } = post;
    return { ...rest, mentionUserIds: [...post.mentionUserIds], recipients: this.recipients(post).map(({ recipientType, recipientId }) => ({ recipientType, recipientId })),
      commentCount: this.state.feedComments.filter(row => row.postId === post.id && row.status === 'ACTIVE').length,
      reactions: [...reactions.values()], isFavorite: this.state.feedFavorites.some(row => row.postId === post.id && row.userId === actor.user.id),
      isRead: this.state.feedReads.some(row => row.postId === post.id && row.userId === actor.user.id),
      isAcknowledged: this.state.feedAcknowledgements.some(row => row.postId === post.id && row.userId === actor.user.id),
      acknowledgementRequired: post.requiresAcknowledgement && this.state.feedAudienceSnapshots.some(row => row.postId === post.id && row.userId === actor.user.id),
      poll: poll ? this.pollView(actor, poll) : null };
  }
  /** Anonymous polls expose counts and the caller's own choice only, never other voters. */
  private pollView(actor: ActorContext, poll: FeedPoll) {
    const votes = this.state.feedPollVotes.filter(row => row.pollId === poll.id);
    return { id: poll.id, question: poll.question, isAnonymous: poll.isAnonymous, allowMultiple: poll.allowMultiple, closesAt: poll.closesAt, isOpen: this.pollOpen(poll),
      totalVoters: new Set(votes.map(row => row.userId)).size, myOptionIds: votes.filter(row => row.userId === actor.user.id).map(row => row.optionId),
      options: this.state.feedPollOptions.filter(row => row.pollId === poll.id).sort((a, b) => a.position - b.position).map(option => {
        const optionVotes = votes.filter(row => row.optionId === option.id);
        return { id: option.id, label: option.label, votes: optionVotes.length, ...(poll.isAnonymous ? {} : { voterUserIds: optionVotes.map(row => row.userId).sort() }) };
      }) };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'feed.read');
    const status = query.get('status') ?? 'PUBLISHED';
    if (!['PUBLISHED', 'DRAFT', 'DELETED'].includes(status)) throw new AppError('QUERY_INVALID', 'status must be PUBLISHED, DRAFT or DELETED.', 400);
    // Pinned posts lead; then newest first. One numeric rank keeps pagination stable.
    const rows = this.state.feedPosts.filter(row => row.status === status && this.canSee(actor, row))
      .map(row => ({ ...this.view(actor, row), feedRank: (row.isPinned ? 1e15 : 0) + (row.publishedAt ?? row.createdAt).getTime() }));
    const page = pageOf(rows, new URLSearchParams([...query].filter(([key]) => key !== 'status')), { searchable: ['title', 'body'], filterable: ['postType', 'authorUserId', 'isPinned', 'isRead'],
      sortable: ['feedRank', 'createdAt'], defaultSort: 'feedRank', defaultOrder: 'desc' });
    return { ...page, data: page.data.map(({ feedRank, ...row }) => row) };
  }
  get(actor: ActorContext, id: string) { return this.view(actor, this.post(actor, id)); }

  // ---- authoring ------------------------------------------------------------------------------------------------------

  create(actor: ActorContext, body: Body, idempotencyKey?: string) {
    this.support.require(actor, 'feed.post');
    body.only(['postType', 'title', 'body', 'recipients', 'mentionUserIds', 'publish', 'requiresAcknowledgement']);
    const key = this.support.idempotencyKey(idempotencyKey), replay = this.support.recall(actor, 'feed.post', key, body.raw);
    if (replay) { const existing = this.state.feedPosts.find(row => row.id === replay.postId); if (existing) return this.view(actor, existing); }
    const postType = body.enumOf('postType', FEED_POST_TYPES) ?? 'STANDARD';
    if (postType === 'ANNOUNCEMENT') this.support.require(actor, 'feed.announcement');
    if (postType === 'POLL') this.support.require(actor, 'feed.poll');
    const requiresAcknowledgement = body.bool('requiresAcknowledgement') ?? false;
    if (requiresAcknowledgement && postType !== 'ANNOUNCEMENT') throw validationError('requiresAcknowledgement', 'Only announcements can require acknowledgement.');
    const recipients = this.readRecipients(actor, body), now = this.support.now();
    const text = body.str('body', { required: true, trim: false, max: MAX_BODY });
    if (!text.trim()) throw validationError('body', 'body must not be empty.');
    const post: FeedPost = { id: this.support.id(), workspaceId: actor.workspaceId, authorUserId: actor.user.id, postType, title: body.str('title', { max: 300 }) ?? null,
      body: text, status: 'DRAFT', statusBeforeDelete: null, requiresAcknowledgement, mentionUserIds: body.uuids('mentionUserIds', { max: 50 }) ?? [], isPinned: false,
      publishedAt: null, editedAt: null, deletedAt: null, deletedByUserId: null, version: 1, createdAt: now, updatedAt: now };
    this.state.feedPosts.push(post);
    this.setRecipients(post, recipients);
    if (body.bool('publish') ?? postType !== 'POLL') this.publishPost(actor, post);
    else post.mentionUserIds = post.mentionUserIds.filter(id => this.support.isEligibleUser(actor.workspaceId, id));
    this.support.remember(actor, 'feed.post', key, body.raw, { postId: post.id });
    return this.view(actor, post);
  }
  private publishPost(actor: ActorContext, post: FeedPost) {
    if (post.postType === 'POLL' && !this.state.feedPolls.some(row => row.postId === post.id)) throw new AppError('POLL_NOT_OPEN', 'Add the poll before publishing a POLL post.', 409);
    const now = this.support.now();
    post.status = 'PUBLISHED'; post.publishedAt = now;
    const audience = this.audience(post);
    if (post.postType === 'ANNOUNCEMENT') {
      // Freeze the denominator: later joiners may still see the post, but metrics use this set.
      for (const userId of audience.filter(id => id !== post.authorUserId))
        this.state.feedAudienceSnapshots.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, userId, reason: 'PUBLISHED_AUDIENCE', publishedAt: now });
      this.support.audit(actor, post.workspaceId, 'FEED.ANNOUNCEMENT_PUBLISHED', 'FEED_POST', post.id, null, { audienceSize: audience.length - 1, requiresAcknowledgement: post.requiresAcknowledgement });
    }
    if (this.recipients(post).some(row => row.recipientType === 'WORKSPACE')) this.support.audit(actor, post.workspaceId, 'FEED.WORKSPACE_PUBLISHED', 'FEED_POST', post.id, null, { postType: post.postType });
    // Mentions notify only people who can actually see the post.
    post.mentionUserIds = post.mentionUserIds.filter(id => audience.includes(id) && id !== post.authorUserId);
    this.support.event({ workspaceId: post.workspaceId, type: post.postType === 'ANNOUNCEMENT' ? 'ANNOUNCEMENT_PUBLISHED' : 'FEED_POST_PUBLISHED', entityType: 'FEED_POST', entityId: post.id,
      actorUserId: actor.user.id, changes: { postType: post.postType }, audienceUserIds: audience });
    if (post.mentionUserIds.length) this.support.event({ workspaceId: post.workspaceId, type: 'FEED_MENTIONED', entityType: 'FEED_POST', entityId: post.id,
      actorUserId: actor.user.id, changes: { mentionUserIds: post.mentionUserIds }, audienceUserIds: post.mentionUserIds });
  }
  publish(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const post = this.post(actor, id);
    if (post.authorUserId !== actor.user.id) throw forbidden('Only the author can publish this post.');
    if (post.status === 'PUBLISHED') return this.view(actor, post);
    if (post.status !== 'DRAFT') throw new AppError('FEED_POST_NOT_PUBLISHED', 'Deleted posts must be restored first.', 409);
    // Audience authority is re-proven at publication time.
    this.readRecipients(actor, new Body({ recipients: this.recipients(post).map(({ recipientType, recipientId }) => ({ recipientType, ...(recipientId ? { recipientId } : {}) })) }));
    this.publishPost(actor, post); this.support.touch(post);
    return this.view(actor, post);
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch: number | undefined, full: boolean) {
    body.only(['title', 'body', 'recipients', 'mentionUserIds', 'version']);
    const post = this.post(actor, id);
    this.support.require(actor, 'feed.update_own');
    if (post.authorUserId !== actor.user.id) throw forbidden('Only the author can edit this post.');
    if (post.status === 'DELETED') throw notFoundError('FEED_POST_NOT_FOUND', 'Feed post');
    this.support.expectVersion(post, body.raw.version ?? ifMatch);
    if (full || body.has('body')) { const text = body.str('body', { required: true, trim: false, max: MAX_BODY }); if (!text.trim()) throw validationError('body', 'body must not be empty.'); post.body = text; }
    if (full || body.has('title')) post.title = body.str('title', { max: 300 }) ?? null;
    if (body.has('recipients')) {
      const next = this.readRecipients(actor, body), key = (items: Recipient[]) => items.map(item => `${item.recipientType}:${item.recipientId}`).sort().join('|');
      // A published audience is part of the record (and announcement metrics); only drafts change recipients.
      if (post.status !== 'DRAFT' && key(next) !== key(this.recipients(post))) throw new AppError('FEED_AUDIENCE_NOT_ALLOWED', 'Recipients of a published post cannot change.', 409);
      if (post.status === 'DRAFT') this.setRecipients(post, next);
    }
    if (body.has('mentionUserIds')) {
      const mentions = body.uuids('mentionUserIds', { max: 50 }) ?? [];
      post.mentionUserIds = post.status === 'PUBLISHED' ? mentions.filter(userId => userId !== post.authorUserId && this.support.isEligibleUser(post.workspaceId, userId) && this.inAudience(post, userId)) : mentions;
    }
    if (post.status === 'PUBLISHED') post.editedAt = this.support.now();
    this.support.touch(post);
    this.support.event({ workspaceId: post.workspaceId, type: 'FEED_POST_UPDATED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: { status: post.status } });
    return this.view(actor, post);
  }
  remove(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version', 'reason']);
    const post = this.post(actor, id);
    if (post.status === 'DELETED') return this.view(actor, post);
    const own = post.authorUserId === actor.user.id;
    if (own) this.support.require(actor, 'feed.delete_own'); else if (!this.moderator(actor)) throw forbidden('Only the author or a moderator can delete this post.');
    this.support.expectVersion(post, body.raw.version ?? ifMatch, false);
    post.statusBeforeDelete = post.status as 'DRAFT' | 'PUBLISHED'; post.status = 'DELETED'; post.deletedAt = this.support.now(); post.deletedByUserId = actor.user.id; post.isPinned = false;
    this.support.touch(post);
    if (!own) this.support.audit(actor, post.workspaceId, 'FEED.POST_MODERATED', 'FEED_POST', post.id, null, { status: 'DELETED', reason: body.str('reason', { max: 500 }) ?? null });
    this.support.event({ workspaceId: post.workspaceId, type: 'FEED_POST_DELETED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: {} });
    return this.view(actor, post);
  }
  restore(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']);
    const post = this.post(actor, id);
    if (post.status !== 'DELETED') return this.view(actor, post);
    if (post.authorUserId !== actor.user.id && !this.moderator(actor)) throw forbidden('Only the author or a moderator can restore this post.');
    this.support.expectVersion(post, body.raw.version ?? ifMatch, false);
    post.status = post.statusBeforeDelete ?? 'DRAFT'; post.statusBeforeDelete = null; post.deletedAt = null; post.deletedByUserId = null;
    this.support.touch(post);
    this.support.event({ workspaceId: post.workspaceId, type: 'FEED_POST_RESTORED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: { status: post.status } });
    return this.view(actor, post);
  }
  /** Moderator-only permanent removal of an already soft-deleted post and its dependent rows; audited. */
  hardDelete(actor: ActorContext, id: string, body: Body) {
    body.only(['reason']);
    const post = this.post(actor, id);
    this.support.require(actor, 'feed.moderate');
    if (post.status !== 'DELETED') throw new AppError('FEED_POST_NOT_PUBLISHED', 'Soft-delete the post before permanent removal.', 409);
    const polls = new Set(this.state.feedPolls.filter(row => row.postId === post.id).map(row => row.id)), keep = <T extends { postId: string }>(rows: T[]) => rows.filter(row => row.postId !== post.id);
    this.state.feedPollVotes = this.state.feedPollVotes.filter(row => !polls.has(row.pollId));
    this.state.feedPollOptions = this.state.feedPollOptions.filter(row => !polls.has(row.pollId));
    this.state.feedPolls = keep(this.state.feedPolls); this.state.feedComments = keep(this.state.feedComments); this.state.feedReactions = keep(this.state.feedReactions);
    this.state.feedFavorites = keep(this.state.feedFavorites); this.state.feedReads = keep(this.state.feedReads); this.state.feedAcknowledgements = keep(this.state.feedAcknowledgements);
    this.state.feedAudienceSnapshots = keep(this.state.feedAudienceSnapshots); this.state.feedPostRecipients = keep(this.state.feedPostRecipients);
    this.state.feedPosts = this.state.feedPosts.filter(row => row.id !== post.id);
    this.support.audit(actor, post.workspaceId, 'FEED.POST_HARD_DELETED', 'FEED_POST', post.id, { authorUserId: post.authorUserId, postType: post.postType, title: post.title },
      null, { reason: body.str('reason', { max: 500 }) ?? null });
    this.support.event({ workspaceId: post.workspaceId, type: 'FEED_POST_PURGED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: {} });
    return { id: post.id, deleted: true };
  }

  // ---- engagement -----------------------------------------------------------------------------------------------------

  comments(actor: ActorContext, id: string, query: URLSearchParams) {
    const post = this.post(actor, id);
    const rows = this.state.feedComments.filter(row => row.postId === post.id).map(row => ({ ...row }));
    return pageOf(rows, query, { searchable: [], filterable: ['authorUserId', 'status'], sortable: ['createdAt'], defaultSort: 'createdAt' });
  }
  comment(actor: ActorContext, id: string, body: Body) {
    body.only(['body']);
    const post = this.post(actor, id);
    this.published(post);
    const text = body.str('body', { required: true, trim: false, max: MAX_COMMENT });
    if (!text.trim()) throw validationError('body', 'body must not be empty.');
    const now = this.support.now(), row = { id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, authorUserId: actor.user.id, body: text, status: 'ACTIVE' as const,
      editedAt: null, deletedAt: null, deletedByUserId: null, version: 1, createdAt: now, updatedAt: now };
    this.state.feedComments.push(row);
    this.support.event({ workspaceId: post.workspaceId, type: 'FEED_COMMENT_ADDED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: { commentId: row.id },
      audienceUserIds: [post.authorUserId] });
    return row;
  }
  private commentOf(actor: ActorContext, id: string) {
    this.support.require(actor, 'feed.read');
    const row = isUuid(id) ? this.state.feedComments.find(item => item.id === id.toLowerCase() && item.workspaceId === actor.workspaceId) : undefined;
    const post = row && this.state.feedPosts.find(item => item.id === row.postId && this.canSee(actor, item));
    if (!row || !post) throw notFoundError('FEED_COMMENT_NOT_FOUND', 'Feed comment');
    return { row, post };
  }
  editComment(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['body', 'version']);
    const { row } = this.commentOf(actor, id);
    if (row.authorUserId !== actor.user.id) throw forbidden('Only the author can edit this comment.');
    if (row.status === 'DELETED') throw notFoundError('FEED_COMMENT_NOT_FOUND', 'Feed comment');
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const text = body.str('body', { required: true, trim: false, max: MAX_COMMENT });
    if (!text.trim()) throw validationError('body', 'body must not be empty.');
    row.body = text; row.editedAt = this.support.now(); this.support.touch(row);
    return row;
  }
  deleteComment(actor: ActorContext, id: string, body: Body) {
    body.only(['reason']);
    const { row, post } = this.commentOf(actor, id);
    if (row.status === 'DELETED') return row;
    const own = row.authorUserId === actor.user.id;
    if (!own && !this.moderator(actor) && post.authorUserId !== actor.user.id) throw forbidden('Only the author, post author or a moderator can delete this comment.');
    const before = { body: row.body };
    row.status = 'DELETED'; row.body = null; row.deletedAt = this.support.now(); row.deletedByUserId = actor.user.id; this.support.touch(row);
    if (!own) this.support.audit(actor, row.workspaceId, 'FEED.COMMENT_MODERATED', 'FEED_COMMENT', row.id, before, { status: 'DELETED' }, { reason: body.str('reason', { max: 500 }) ?? null });
    return row;
  }
  react(actor: ActorContext, id: string, body: Body) {
    body.only(['reaction']);
    const post = this.post(actor, id); this.published(post);
    const reaction = this.reaction(body.str('reaction', { required: true, max: 64 }));
    if (!this.state.feedReactions.some(row => row.postId === post.id && row.userId === actor.user.id && row.reaction === reaction)) {
      this.state.feedReactions.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, userId: actor.user.id, reaction, createdAt: this.support.now() });
      this.support.event({ workspaceId: post.workspaceId, type: 'FEED_REACTED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: { reaction, active: true } });
    }
    return this.view(actor, post);
  }
  unreact(actor: ActorContext, id: string, raw: string, body: Body) {
    body.only([]);
    const post = this.post(actor, id);
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { throw validationError('reaction', 'reaction is invalid.'); }
    const reaction = this.reaction(decoded);
    this.state.feedReactions = this.state.feedReactions.filter(row => !(row.postId === post.id && row.userId === actor.user.id && row.reaction === reaction));
    return this.view(actor, post);
  }
  private reaction(value: string) {
    const normalized = value.normalize('NFC');
    if (!REACTION_RE.test(normalized)) throw validationError('reaction', 'reaction must be an emoji or a :shortcode:.');
    return normalized;
  }
  favorite(actor: ActorContext, id: string, body: Body, on: boolean) {
    body.only([]);
    const post = this.post(actor, id);
    const existing = this.state.feedFavorites.find(row => row.postId === post.id && row.userId === actor.user.id);
    if (on && !existing) this.state.feedFavorites.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, userId: actor.user.id, createdAt: this.support.now() });
    if (!on && existing) this.state.feedFavorites = this.state.feedFavorites.filter(row => row !== existing);
    return this.view(actor, post);
  }
  pin(actor: ActorContext, id: string, body: Body, on: boolean) {
    body.only([]);
    const post = this.post(actor, id); this.published(post);
    if (!this.moderator(actor) && !(post.authorUserId === actor.user.id && this.support.scope(actor, 'feed.post_workspace')))
      throw forbidden('Pinning requires Feed moderation or Workspace-wide publishing authority.');
    if (post.isPinned !== on) {
      post.isPinned = on; this.support.touch(post);
      this.support.audit(actor, post.workspaceId, on ? 'FEED.POST_PINNED' : 'FEED.POST_UNPINNED', 'FEED_POST', post.id, null, { isPinned: on });
    }
    return this.view(actor, post);
  }
  read(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const post = this.post(actor, id); this.published(post);
    if (!this.state.feedReads.some(row => row.postId === post.id && row.userId === actor.user.id))
      this.state.feedReads.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, userId: actor.user.id, readAt: this.support.now() });
    return this.view(actor, post);
  }
  acknowledge(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const post = this.post(actor, id); this.published(post);
    if (!post.requiresAcknowledgement || !this.state.feedAudienceSnapshots.some(row => row.postId === post.id && row.userId === actor.user.id))
      throw new AppError('FEED_ACK_NOT_REQUIRED', 'No acknowledgement is required from you for this post.', 409);
    if (!this.state.feedAcknowledgements.some(row => row.postId === post.id && row.userId === actor.user.id)) {
      const now = this.support.now();
      this.state.feedAcknowledgements.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, userId: actor.user.id, acknowledgedAt: now });
      if (!this.state.feedReads.some(row => row.postId === post.id && row.userId === actor.user.id))
        this.state.feedReads.push({ id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, userId: actor.user.id, readAt: now });
      this.support.event({ workspaceId: post.workspaceId, type: 'ANNOUNCEMENT_ACKNOWLEDGED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: {},
        audienceUserIds: [post.authorUserId] });
    }
    return this.view(actor, post);
  }
  /** Author/moderator metrics. Announcements use the publication snapshot as the stable denominator. */
  readStats(actor: ActorContext, id: string) {
    const post = this.post(actor, id); this.published(post);
    if (post.authorUserId !== actor.user.id && !this.moderator(actor)) throw forbidden('Only the author or a moderator can view read statistics.');
    const snapshot = this.state.feedAudienceSnapshots.filter(row => row.postId === post.id).map(row => row.userId);
    const audience = post.postType === 'ANNOUNCEMENT' ? snapshot : this.audience(post).filter(userId => userId !== post.authorUserId);
    const reads = new Set(this.state.feedReads.filter(row => row.postId === post.id).map(row => row.userId));
    const acks = new Set(this.state.feedAcknowledgements.filter(row => row.postId === post.id).map(row => row.userId));
    return { postId: post.id, audienceMode: post.postType === 'ANNOUNCEMENT' ? 'SNAPSHOT' : 'DYNAMIC', audienceSize: audience.length,
      readCount: audience.filter(userId => reads.has(userId)).length, acknowledgedCount: audience.filter(userId => acks.has(userId)).length,
      ...(post.requiresAcknowledgement ? { pendingAcknowledgementUserIds: audience.filter(userId => !acks.has(userId)).sort() } : {}) };
  }

  // ---- polls ----------------------------------------------------------------------------------------------------------

  private pollOpen(poll: FeedPoll) { return !poll.closesAt || poll.closesAt > this.support.now(); }
  createPoll(actor: ActorContext, id: string, body: Body) {
    body.only(['question', 'options', 'isAnonymous', 'allowMultiple', 'closesAt']);
    const post = this.post(actor, id);
    this.support.require(actor, 'feed.poll');
    if (post.authorUserId !== actor.user.id) throw forbidden('Only the author can add a poll.');
    if (post.postType !== 'POLL') throw validationError('postType', 'Polls attach to POLL posts.');
    if (post.status === 'DELETED' || this.state.feedPolls.some(row => row.postId === post.id)) throw new AppError('POLL_NOT_OPEN', 'This post cannot take another poll.', 409);
    const question = body.str('question', { required: true, max: 500 });
    const options = body.array('options', { required: true, max: 20 })!;
    if (options.length < 2 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 200)) throw validationError('options', 'Provide 2 to 20 option labels of at most 200 characters.');
    const closesAt = body.instant('closesAt') ?? null;
    if (closesAt && closesAt <= this.support.now()) throw validationError('closesAt', 'closesAt must be in the future.');
    const poll: FeedPoll = { id: this.support.id(), workspaceId: post.workspaceId, postId: post.id, question, isAnonymous: body.bool('isAnonymous') ?? false,
      allowMultiple: body.bool('allowMultiple') ?? false, closesAt, createdByUserId: actor.user.id, createdAt: this.support.now() };
    this.state.feedPolls.push(poll);
    (options as string[]).forEach((label, position) => this.state.feedPollOptions.push({ id: this.support.id(), workspaceId: post.workspaceId, pollId: poll.id, label: label.trim(), position }));
    this.support.event({ workspaceId: post.workspaceId, type: 'POLL_CREATED', entityType: 'FEED_POST', entityId: post.id, actorUserId: actor.user.id, changes: { pollId: poll.id } });
    return this.view(actor, post);
  }
  private pollOf(actor: ActorContext, pollId: string) {
    this.support.require(actor, 'feed.read');
    const poll = isUuid(pollId) ? this.state.feedPolls.find(row => row.id === pollId.toLowerCase() && row.workspaceId === actor.workspaceId) : undefined;
    const post = poll && this.state.feedPosts.find(row => row.id === poll.postId && this.canSee(actor, row));
    if (!poll || !post) throw notFoundError('POLL_NOT_FOUND', 'Poll');
    if (post.status !== 'PUBLISHED' || !this.pollOpen(poll)) throw new AppError('POLL_NOT_OPEN', 'This poll is not open for voting.', 409);
    return { poll, post };
  }
  vote(actor: ActorContext, pollId: string, body: Body) {
    body.only(['optionIds']);
    const { poll, post } = this.pollOf(actor, pollId);
    const optionIds = body.uuids('optionIds', { required: true, max: 20 })!;
    const valid = new Set(this.state.feedPollOptions.filter(row => row.pollId === poll.id).map(row => row.id));
    if (!optionIds.length || optionIds.some(id => !valid.has(id)) || !poll.allowMultiple && optionIds.length !== 1) throw validationError('optionIds', poll.allowMultiple ? 'Choose options of this poll.' : 'Choose exactly one option.');
    if (this.state.feedPollVotes.some(row => row.pollId === poll.id && row.userId === actor.user.id)) throw new AppError('POLL_ALREADY_VOTED', 'You already voted; retract your vote to change it.', 409);
    for (const optionId of optionIds) this.state.feedPollVotes.push({ id: this.support.id(), workspaceId: poll.workspaceId, pollId: poll.id, optionId, userId: actor.user.id, createdAt: this.support.now() });
    // Anonymous votes carry no actor identity even in the outbox.
    this.support.event({ workspaceId: poll.workspaceId, type: 'POLL_VOTED', entityType: 'FEED_POLL', entityId: poll.id, actorUserId: poll.isAnonymous ? null : actor.user.id,
      changes: poll.isAnonymous ? {} : { optionIds } });
    return this.pollView(actor, poll);
  }
  retract(actor: ActorContext, pollId: string, body: Body) {
    body.only([]);
    const { poll } = this.pollOf(actor, pollId);
    this.state.feedPollVotes = this.state.feedPollVotes.filter(row => !(row.pollId === poll.id && row.userId === actor.user.id));
    return this.pollView(actor, poll);
  }
}
