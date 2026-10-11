import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import { Body, type CollabSupport, cursorOf, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { TasksPolicy } from '../tasks/policy';
import { CHANNEL_ROLES, type Channel, type ChannelComment, type ChannelMembershipSource, type ChannelPost, type ChannelRole } from './channel-types';

const RANK: Record<ChannelRole, number> = { SUBSCRIBER: 0, PUBLISHER: 1, ADMIN: 2, OWNER: 3 };
const MAX_POST = 20_000, MAX_COMMENT = 5_000;

/**
 * Channels are subscription publishing spaces (not group Chats). PUBLIC Channels are discoverable and readable by active
 * internal Workspace members with `channel.read`; PRIVATE Channels exist only for their effective members. Membership is
 * the union of live sources, so removing one source never revokes access another source still grants.
 */
export class ChannelService {
  constructor(private readonly support: CollabSupport, private readonly tasks: TasksPolicy) {}
  private get state() { return this.support.state; }

  // ---- membership -----------------------------------------------------------------------------------------------------

  private groupMembers(channel: Channel, source: ChannelMembershipSource): string[] {
    if (source.sourceType === 'DEPARTMENT') {
      const department = this.state.departments.find(row => row.id === source.sourceId && row.workspaceId === channel.workspaceId && !row.isDeleted);
      return department ? [...(department.managerId ? [department.managerId] : []),
        ...this.state.departmentMembers.filter(row => row.departmentId === department.id && row.workspaceId === channel.workspaceId && !row.isDeleted).map(row => row.userId)] : [];
    }
    if (source.sourceType === 'PROJECT') {
      const project = this.state.projects.find(row => row.id === source.sourceId && row.workspaceId === channel.workspaceId && !row.isDeleted);
      return project ? [project.ownerUserId, ...this.state.projectMembers.filter(row => row.projectId === project.id && row.status === 'ACTIVE').map(row => row.userId)] : [];
    }
    return source.userId ? [source.userId] : [];
  }
  /** userId -> sources currently granting membership. External identities never qualify. */
  private grants(channel: Channel) {
    const result = new Map<string, ChannelMembershipSource[]>();
    for (const source of this.state.channelMembershipSources.filter(row => row.channelId === channel.id && row.workspaceId === channel.workspaceId && row.active))
      for (const userId of new Set(this.groupMembers(channel, source)))
        if (this.support.isEligibleUser(channel.workspaceId, userId)) result.set(userId, [...(result.get(userId) ?? []), source]);
    return result;
  }
  memberIds(channel: Channel) { return [...this.grants(channel).keys()]; }
  /** Assigned roles are authoritative; members without an assignment take the highest role of their granting sources. */
  role(channel: Channel, userId: string): ChannelRole | null {
    const sources = this.grants(channel).get(userId);
    if (!sources) return null;
    if (channel.ownerUserId === userId) return 'OWNER';
    const assigned = this.state.channelMembers.find(row => row.channelId === channel.id && row.userId === userId && !row.leftAt)?.role;
    return assigned && assigned !== 'OWNER' ? assigned : this.derivedRole(sources);
  }
  private derivedRole(sources: ChannelMembershipSource[]): ChannelRole {
    const best = sources.reduce<ChannelRole>((current, source) => RANK[source.role] > RANK[current] ? source.role : current, 'SUBSCRIBER');
    return best === 'OWNER' ? 'ADMIN' : best;
  }
  private canRead(actor: ActorContext, channel: Channel) {
    if (channel.workspaceId !== actor.workspaceId || channel.isDeleted || !this.support.scope(actor, 'channel.read') || !this.support.isEligibleUser(actor.workspaceId, actor.user.id)) return false;
    return channel.visibility === 'PUBLIC' || this.role(channel, actor.user.id) !== null;
  }
  private channel(actor: ActorContext, id: string) {
    this.support.require(actor, 'channel.read');
    const row = isUuid(id) ? this.state.channels.find(item => item.id === id.toLowerCase() && this.canRead(actor, item)) : undefined;
    if (!row) throw notFoundError('CHANNEL_NOT_FOUND', 'Channel');
    return row;
  }
  private requireRole(actor: ActorContext, channel: Channel, minimum: ChannelRole, permission: string) {
    this.support.require(actor, permission);
    const role = this.role(channel, actor.user.id);
    if ((role === null || RANK[role] < RANK[minimum]) && !actor.role.isOwnerRole) throw forbidden(`This Channel action requires the ${minimum} role.`);
    return role;
  }
  private writable(channel: Channel) {
    if (channel.status === 'ARCHIVED') throw new AppError('CHANNEL_ARCHIVED', 'The Channel is archived and read-only.', 409);
  }
  view(actor: ActorContext, channel: Channel) {
    const { isDeleted, deletedAt, ...rest } = channel;
    const members = this.memberIds(channel);
    return { ...rest, myRole: this.role(channel, actor.user.id), memberCount: members.length,
      postCount: this.state.channelPosts.filter(row => row.channelId === channel.id && row.status === 'PUBLISHED').length };
  }
  private setManual(channel: Channel, userId: string, active: boolean, role: ChannelRole, actor: ActorContext, sourceType: 'MANUAL' | 'SYSTEM' = 'MANUAL') {
    let source = this.state.channelMembershipSources.find(row => row.channelId === channel.id && row.userId === userId && row.sourceType === sourceType);
    const now = this.support.now();
    if (!source && !active) return false;
    if (source && source.active === active && (!active || source.role === role)) return false;
    if (source) { source.active = active; source.role = role; source.updatedAt = now; }
    else {
      source = { id: this.support.id(), workspaceId: channel.workspaceId, channelId: channel.id, userId, sourceType, sourceId: channel.id, role, active, createdAt: now, updatedAt: now };
      this.state.channelMembershipSources.push(source);
    }
    this.syncMember(channel, userId, active ? role : undefined);
    this.memberChanged(actor, channel, { userId, sourceType, active, role });
    return true;
  }
  /** Keeps the role row consistent with effective membership; a departed member keeps history via leftAt. */
  private syncMember(channel: Channel, userId: string, role?: ChannelRole) {
    const sources = this.grants(channel).get(userId), now = this.support.now();
    const initial = role ?? (sources ? this.derivedRole(sources) : 'SUBSCRIBER');
    let row = this.state.channelMembers.find(item => item.channelId === channel.id && item.userId === userId);
    if (!row && sources) {
      row = { id: this.support.id(), workspaceId: channel.workspaceId, channelId: channel.id, userId, role: initial, joinedAt: now, leftAt: null };
      this.state.channelMembers.push(row);
    } else if (row) {
      if (sources && row.leftAt) { row.leftAt = null; row.joinedAt = now; row.role = initial; }
      else if (sources && role) row.role = role;
      else if (!sources && !row.leftAt) row.leftAt = now;
    }
  }
  private memberChanged(actor: ActorContext, channel: Channel, changes: Record<string, unknown>) {
    this.support.audit(actor, channel.workspaceId, 'CHANNEL.MEMBERSHIP_CHANGED', 'CHANNEL', channel.id, null, changes);
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_MEMBER_CHANGED', entityType: 'CHANNEL', entityId: channel.id, actorUserId: actor.user.id,
      changes, audienceUserIds: typeof changes.userId === 'string' ? [changes.userId] : undefined });
  }

  // ---- Channel lifecycle ------------------------------------------------------------------------------------------------

  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'channel.read');
    const rows = this.state.channels.filter(row => this.canRead(actor, row)).map(row => this.view(actor, row));
    return pageOf(rows, query, { searchable: ['name', 'description'], filterable: ['visibility', 'status', 'myRole', 'ownerUserId'], sortable: ['name', 'createdAt', 'updatedAt', 'memberCount'], defaultSort: 'name' });
  }
  get(actor: ActorContext, id: string) { return this.view(actor, this.channel(actor, id)); }
  create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'channel.create');
    body.only(['name', 'description', 'visibility', 'commentPolicy', 'memberUserIds']);
    const now = this.support.now();
    const channel: Channel = { id: this.support.id(), workspaceId: actor.workspaceId, ...this.fields(body, null), ownerUserId: actor.user.id, status: 'ACTIVE',
      isDeleted: false, deletedAt: null, createdByUserId: actor.user.id, version: 1, createdAt: now, updatedAt: now };
    const memberIds = body.uuids('memberUserIds', { max: 200 }) ?? [];
    if (!this.support.isEligibleUser(actor.workspaceId, actor.user.id) || memberIds.some(id => !this.support.isEligibleUser(actor.workspaceId, id)))
      throw new AppError('CHANNEL_MEMBER_INVALID', 'Channel members must be active internal Workspace users.', 400);
    this.state.channels.push(channel);
    this.setManual(channel, actor.user.id, true, 'OWNER', actor);
    for (const userId of memberIds.filter(id => id !== actor.user.id)) this.setManual(channel, userId, true, 'SUBSCRIBER', actor);
    this.support.audit(actor, channel.workspaceId, 'CHANNEL.CREATED', 'CHANNEL', channel.id, null, { name: channel.name, visibility: channel.visibility });
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_CREATED', entityType: 'CHANNEL', entityId: channel.id, actorUserId: actor.user.id,
      changes: { visibility: channel.visibility } });
    return this.view(actor, channel);
  }
  private fields(body: Body, current: Channel | null) {
    const name = body.has('name') || !current ? body.str('name', { required: true, max: 200 }).normalize('NFC') : current.name;
    return {
      name,
      description: body.has('description') ? body.str('description', { max: 2000 }) ?? null : current?.description ?? null,
      visibility: body.enumOf('visibility', ['PUBLIC', 'PRIVATE'] as const) ?? current?.visibility ?? 'PUBLIC',
      commentPolicy: body.enumOf('commentPolicy', ['MEMBERS', 'PUBLISHERS', 'DISABLED'] as const) ?? current?.commentPolicy ?? 'MEMBERS',
    };
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch: number | undefined, full: boolean) {
    body.only(['name', 'description', 'visibility', 'commentPolicy', 'version']);
    const channel = this.channel(actor, id);
    this.requireRole(actor, channel, 'ADMIN', 'channel.update');
    this.writable(channel);
    this.support.expectVersion(channel, body.raw.version ?? ifMatch);
    const before = { name: channel.name, description: channel.description, visibility: channel.visibility, commentPolicy: channel.commentPolicy };
    const next = full ? { ...this.fields(new Body({ description: null, ...body.raw }), null) } : this.fields(body, channel);
    Object.assign(channel, next); this.support.touch(channel);
    this.support.audit(actor, channel.workspaceId, 'CHANNEL.UPDATED', 'CHANNEL', channel.id, before, next);
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_UPDATED', entityType: 'CHANNEL', entityId: channel.id, actorUserId: actor.user.id, changes: next });
    return this.view(actor, channel);
  }
  archive(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']);
    const channel = this.channel(actor, id);
    this.requireRole(actor, channel, 'ADMIN', 'channel.update');
    if (channel.status === 'ARCHIVED') return this.view(actor, channel);
    this.support.expectVersion(channel, body.raw.version ?? ifMatch, false);
    channel.status = 'ARCHIVED'; this.support.touch(channel);
    this.support.audit(actor, channel.workspaceId, 'CHANNEL.ARCHIVED', 'CHANNEL', channel.id, { status: 'ACTIVE' }, { status: 'ARCHIVED' });
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_ARCHIVED', entityType: 'CHANNEL', entityId: channel.id, actorUserId: actor.user.id,
      changes: { status: 'ARCHIVED' }, audienceUserIds: this.memberIds(channel) });
    return this.view(actor, channel);
  }
  delete(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']);
    const channel = this.channel(actor, id);
    this.requireRole(actor, channel, 'OWNER', 'channel.update');
    this.support.expectVersion(channel, body.raw.version ?? ifMatch);
    channel.isDeleted = true; channel.deletedAt = this.support.now(); this.support.touch(channel);
    this.support.audit(actor, channel.workspaceId, 'CHANNEL.DELETED', 'CHANNEL', channel.id, { name: channel.name }, null);
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_DELETED', entityType: 'CHANNEL', entityId: channel.id, actorUserId: actor.user.id, changes: {} });
    return { id: channel.id, deleted: true };
  }

  // ---- members ----------------------------------------------------------------------------------------------------------

  members(actor: ActorContext, id: string, query: URLSearchParams) {
    const channel = this.channel(actor, id);
    if (channel.visibility === 'PUBLIC' && this.role(channel, actor.user.id) === null && !actor.role.isOwnerRole) throw new AppError('CHANNEL_PRIVATE', 'Only Channel members can list members.', 403);
    const rows = [...this.grants(channel)].map(([userId, sources]) => ({ userId, role: this.role(channel, userId)!,
      sources: sources.map(source => ({ sourceType: source.sourceType, sourceId: source.sourceId })),
      joinedAt: this.state.channelMembers.find(row => row.channelId === channel.id && row.userId === userId)?.joinedAt ?? null }));
    return pageOf(rows, query, { searchable: [], filterable: ['role'], sortable: ['userId', 'role'], defaultSort: 'userId' });
  }
  /** Adds one user (MANUAL) or links a Department/Project whose live members join with the given role. */
  addMember(actor: ActorContext, id: string, body: Body) {
    body.only(['userId', 'role', 'sourceType', 'sourceId', 'active']);
    const channel = this.channel(actor, id);
    const actorRole = this.requireRole(actor, channel, 'ADMIN', 'channel.member_manage');
    this.writable(channel);
    const role = body.enumOf('role', CHANNEL_ROLES.filter(item => item !== 'OWNER')) ?? 'SUBSCRIBER';
    if (role === 'ADMIN' && actorRole !== 'OWNER' && !actor.role.isOwnerRole) throw forbidden('Only the Channel owner can grant the ADMIN role.');
    const sourceType = body.enumOf('sourceType', ['MANUAL', 'DEPARTMENT', 'PROJECT'] as const) ?? 'MANUAL';
    if (sourceType === 'MANUAL') {
      const userId = body.uuid('userId', { required: true });
      if (!this.support.isEligibleUser(channel.workspaceId, userId)) throw new AppError('CHANNEL_MEMBER_INVALID', 'Channel members must be active internal Workspace users.', 400);
      if (body.bool('active') === false) throw validationError('active', 'Use DELETE /channels/:id/members/:userId to remove a member.');
      if (channel.ownerUserId === userId) throw new AppError('CHANNEL_OWNER_REQUIRED', 'Use an ownership transfer to change the owner role.', 409);
      if (!this.setManual(channel, userId, true, role, actor) && body.has('role')) this.syncMember(channel, userId, role);
      return { userId, role: this.role(channel, userId) };
    }
    const sourceId = body.uuid('sourceId', { required: true }), active = body.bool('active') ?? true;
    const exists = sourceType === 'DEPARTMENT' ? this.state.departments.some(row => row.id === sourceId && row.workspaceId === channel.workspaceId && !row.isDeleted)
      : this.state.projects.some(row => row.id === sourceId && row.workspaceId === channel.workspaceId && !row.isDeleted);
    if (!exists) throw new AppError('CHANNEL_MEMBER_INVALID', `The ${sourceType.toLowerCase()} was not found.`, 400, { field: 'sourceId' });
    if (sourceType === 'PROJECT') this.tasks.project(actor, sourceId);
    const before = new Set(this.memberIds(channel)), now = this.support.now();
    let link = this.state.channelMembershipSources.find(row => row.channelId === channel.id && row.userId === null && row.sourceType === sourceType && row.sourceId === sourceId);
    if (link) { link.active = active; link.role = role; link.updatedAt = now; }
    else if (active) {
      link = { id: this.support.id(), workspaceId: channel.workspaceId, channelId: channel.id, userId: null, sourceType, sourceId, role, active, createdAt: now, updatedAt: now };
      this.state.channelMembershipSources.push(link);
    }
    for (const userId of new Set([...before, ...this.memberIds(channel)])) this.syncMember(channel, userId);
    this.memberChanged(actor, channel, { sourceType, sourceId, active, role });
    return { sourceType, sourceId, active, role, memberCount: this.memberIds(channel).length };
  }
  updateMember(actor: ActorContext, id: string, userId: string, body: Body) {
    body.only(['role']);
    const channel = this.channel(actor, id);
    const actorRole = this.requireRole(actor, channel, 'ADMIN', 'channel.member_manage');
    this.writable(channel);
    const role = body.enumOf('role', CHANNEL_ROLES, { required: true });
    const current = this.role(channel, userId);
    if (!current) throw new AppError('CHANNEL_MEMBER_INVALID', 'The user is not a Channel member.', 404);
    const ownerAction = role === 'OWNER' || current === 'OWNER' || role === 'ADMIN' || current === 'ADMIN';
    if (ownerAction && actorRole !== 'OWNER' && !actor.role.isOwnerRole) throw forbidden('Only the Channel owner can change owner or administrator roles.');
    if (current === 'OWNER' && role !== 'OWNER') throw new AppError('CHANNEL_OWNER_REQUIRED', 'Transfer ownership to another member first.', 409);
    if (role === current) return { userId, role };
    if (role === 'OWNER') {
      // Ownership transfer: the new owner holds a direct grant; the previous owner stays as administrator.
      const previous = channel.ownerUserId;
      channel.ownerUserId = userId; this.support.touch(channel);
      this.setManual(channel, userId, true, 'ADMIN', actor);
      const prior = this.state.channelMembers.find(row => row.channelId === channel.id && row.userId === previous);
      if (prior) prior.role = 'ADMIN';
      for (const source of this.state.channelMembershipSources.filter(row => row.channelId === channel.id && row.userId === previous && row.role === 'OWNER')) source.role = 'ADMIN';
      const next = this.state.channelMembers.find(row => row.channelId === channel.id && row.userId === userId)!;
      next.role = 'OWNER';
      this.support.audit(actor, channel.workspaceId, 'CHANNEL.OWNER_TRANSFERRED', 'CHANNEL', channel.id, { ownerUserId: previous }, { ownerUserId: userId });
    } else {
      let row = this.state.channelMembers.find(item => item.channelId === channel.id && item.userId === userId && !item.leftAt);
      if (!row) { this.syncMember(channel, userId, role); row = this.state.channelMembers.find(item => item.channelId === channel.id && item.userId === userId)!; }
      row.role = role;
    }
    this.memberChanged(actor, channel, { userId, role, previousRole: current });
    return { userId, role: this.role(channel, userId) };
  }
  removeMember(actor: ActorContext, id: string, userId: string, body: Body) {
    body.only([]);
    const channel = this.channel(actor, id);
    const actorRole = this.requireRole(actor, channel, 'ADMIN', 'channel.member_manage');
    this.writable(channel);
    userId = new Body({ userId }).uuid('userId', { required: true });
    if (channel.ownerUserId === userId) throw new AppError('CHANNEL_OWNER_REQUIRED', 'Transfer ownership before removing the Channel owner.', 409);
    if (this.role(channel, userId) === 'ADMIN' && actorRole !== 'OWNER' && !actor.role.isOwnerRole) throw forbidden('Only the Channel owner can remove administrators.');
    this.setManual(channel, userId, false, 'SUBSCRIBER', actor);
    const remaining = this.grants(channel).get(userId) ?? [];
    return { userId, removed: remaining.length === 0, remainingSources: remaining.map(source => ({ sourceType: source.sourceType, sourceId: source.sourceId })) };
  }
  subscribe(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const channel = this.channel(actor, id);
    this.writable(channel);
    if (channel.visibility === 'PRIVATE' && this.role(channel, actor.user.id) === null) throw new AppError('CHANNEL_PRIVATE', 'Private Channels require an invitation.', 403);
    if (this.role(channel, actor.user.id) === null) this.setManual(channel, actor.user.id, true, 'SUBSCRIBER', actor);
    return this.view(actor, channel);
  }
  unsubscribe(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const channel = this.channel(actor, id);
    if (channel.ownerUserId === actor.user.id) throw new AppError('CHANNEL_OWNER_REQUIRED', 'Transfer ownership before leaving the Channel.', 409);
    this.setManual(channel, actor.user.id, false, 'SUBSCRIBER', actor);
    const remaining = this.grants(channel).get(actor.user.id) ?? [];
    return { channelId: channel.id, subscribed: remaining.length > 0, remainingSources: remaining.map(source => ({ sourceType: source.sourceType, sourceId: source.sourceId })) };
  }

  // ---- posts and comments -----------------------------------------------------------------------------------------------

  private postView(actor: ActorContext, row: ChannelPost) {
    return { ...row, commentCount: this.state.channelComments.filter(item => item.postId === row.id && item.status === 'ACTIVE').length };
  }
  private post(actor: ActorContext, id: string) {
    const row = isUuid(id) ? this.state.channelPosts.find(item => item.id === id.toLowerCase() && item.workspaceId === actor.workspaceId) : undefined;
    const channel = row && this.state.channels.find(item => item.id === row.channelId && this.canRead(actor, item));
    if (!row || !channel) { this.support.require(actor, 'channel.read'); throw notFoundError('CHANNEL_POST_NOT_FOUND', 'Channel post'); }
    this.support.require(actor, 'channel.read');
    return { row, channel };
  }
  private moderator(actor: ActorContext, channel: Channel) {
    return Boolean(this.support.scope(actor, 'channel.moderate')) && (actor.role.isOwnerRole || RANK[this.role(channel, actor.user.id) ?? 'SUBSCRIBER'] >= RANK.ADMIN);
  }
  posts(actor: ActorContext, id: string, query: URLSearchParams) {
    const channel = this.channel(actor, id);
    const rows = this.state.channelPosts.filter(row => row.channelId === channel.id).map(row => this.postView(actor, row));
    return cursorOf(rows, query, { searchable: ['title', 'body'], filterable: ['authorUserId', 'status'], sortable: ['publishedAt'], defaultSort: 'publishedAt', defaultOrder: 'desc' });
  }
  publish(actor: ActorContext, id: string, body: Body, idempotencyKey?: string) {
    body.only(['title', 'body']);
    const channel = this.channel(actor, id);
    this.support.require(actor, 'channel.publish');
    const role = this.role(channel, actor.user.id);
    if (role === null || RANK[role] < RANK.PUBLISHER) throw new AppError('CHANNEL_PUBLISH_DENIED', 'Only owners, administrators and publishers can publish.', 403);
    this.writable(channel);
    const key = this.support.idempotencyKey(idempotencyKey), replay = this.support.recall(actor, `channel.publish:${channel.id}`, key, body.raw);
    if (replay) { const existing = this.state.channelPosts.find(row => row.id === replay.postId); if (existing) return this.postView(actor, existing); }
    const now = this.support.now();
    const row: ChannelPost = { id: this.support.id(), workspaceId: channel.workspaceId, channelId: channel.id, authorUserId: actor.user.id,
      title: body.str('title', { max: 300 }) ?? null, body: body.str('body', { required: true, trim: false, max: MAX_POST }), status: 'PUBLISHED',
      publishedAt: now, editedAt: null, deletedAt: null, deletedByUserId: null, version: 1, createdAt: now, updatedAt: now };
    if (!row.body!.trim()) throw validationError('body', 'body must not be empty.');
    this.state.channelPosts.push(row);
    this.support.remember(actor, `channel.publish:${channel.id}`, key, body.raw, { postId: row.id });
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_POST_PUBLISHED', entityType: 'CHANNEL_POST', entityId: row.id, actorUserId: actor.user.id,
      changes: { channelId: channel.id }, audienceUserIds: this.memberIds(channel) });
    return this.postView(actor, row);
  }
  getPost(actor: ActorContext, id: string) { return this.postView(actor, this.post(actor, id).row); }
  editPost(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['title', 'body', 'version']);
    const { row, channel } = this.post(actor, id);
    this.support.require(actor, 'channel.publish');
    if (row.authorUserId !== actor.user.id) throw forbidden('Only the author can edit a Channel post.');
    if (row.status === 'DELETED') throw notFoundError('CHANNEL_POST_NOT_FOUND', 'Channel post');
    const role = this.role(channel, actor.user.id);
    if (role === null || RANK[role] < RANK.PUBLISHER) throw new AppError('CHANNEL_PUBLISH_DENIED', 'Only current publishers can edit posts.', 403);
    this.writable(channel);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (body.has('title')) row.title = body.str('title', { max: 300 }) ?? null;
    if (body.has('body')) { const text = body.str('body', { required: true, trim: false, max: MAX_POST }); if (!text.trim()) throw validationError('body', 'body must not be empty.'); row.body = text; }
    row.editedAt = this.support.now(); this.support.touch(row);
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_POST_UPDATED', entityType: 'CHANNEL_POST', entityId: row.id, actorUserId: actor.user.id, changes: { channelId: channel.id } });
    return this.postView(actor, row);
  }
  deletePost(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version', 'reason']);
    const { row, channel } = this.post(actor, id);
    if (row.status === 'DELETED') return this.postView(actor, row);
    const own = row.authorUserId === actor.user.id, moderator = this.moderator(actor, channel);
    if (own) this.support.require(actor, 'channel.publish');
    else if (!moderator) throw forbidden('Only the author or a Channel moderator can delete this post.');
    this.writable(channel);
    this.support.expectVersion(row, body.raw.version ?? ifMatch, false);
    const before = { title: row.title, body: row.body };
    row.status = 'DELETED'; row.title = null; row.body = null; row.deletedAt = this.support.now(); row.deletedByUserId = actor.user.id; this.support.touch(row);
    if (!own) this.support.audit(actor, channel.workspaceId, 'CHANNEL.POST_MODERATED', 'CHANNEL_POST', row.id, before, { status: 'DELETED' }, { reason: body.str('reason', { max: 500 }) ?? null });
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_POST_DELETED', entityType: 'CHANNEL_POST', entityId: row.id, actorUserId: actor.user.id, changes: { channelId: channel.id, moderated: !own } });
    return this.postView(actor, row);
  }
  comments(actor: ActorContext, id: string, query: URLSearchParams) {
    const { row } = this.post(actor, id);
    const rows = this.state.channelComments.filter(item => item.postId === row.id).map(item => ({ ...item }));
    return cursorOf(rows, query, { searchable: [], filterable: ['authorUserId', 'status'], sortable: ['createdAt'], defaultSort: 'createdAt', defaultOrder: 'asc' });
  }
  comment(actor: ActorContext, id: string, body: Body) {
    body.only(['body']);
    const { row, channel } = this.post(actor, id);
    this.support.require(actor, 'channel.comment');
    if (row.status === 'DELETED') throw notFoundError('CHANNEL_POST_NOT_FOUND', 'Channel post');
    this.writable(channel);
    const role = this.role(channel, actor.user.id);
    if (channel.commentPolicy === 'DISABLED' || role === null || channel.commentPolicy === 'PUBLISHERS' && RANK[role] < RANK.PUBLISHER)
      throw new AppError('CHANNEL_COMMENT_DENIED', 'Comments are not open to you in this Channel.', 403);
    const text = body.str('body', { required: true, trim: false, max: MAX_COMMENT });
    if (!text.trim()) throw validationError('body', 'body must not be empty.');
    const now = this.support.now();
    const item: ChannelComment = { id: this.support.id(), workspaceId: channel.workspaceId, channelId: channel.id, postId: row.id, authorUserId: actor.user.id, body: text,
      status: 'ACTIVE', editedAt: null, deletedAt: null, deletedByUserId: null, version: 1, createdAt: now, updatedAt: now };
    this.state.channelComments.push(item);
    this.support.event({ workspaceId: channel.workspaceId, type: 'CHANNEL_COMMENT_ADDED', entityType: 'CHANNEL_COMMENT', entityId: item.id, actorUserId: actor.user.id,
      changes: { channelId: channel.id, postId: row.id }, audienceUserIds: [row.authorUserId] });
    return item;
  }
  private commentOf(actor: ActorContext, id: string) {
    const item = isUuid(id) ? this.state.channelComments.find(row => row.id === id.toLowerCase() && row.workspaceId === actor.workspaceId) : undefined;
    const channel = item && this.state.channels.find(row => row.id === item.channelId && this.canRead(actor, row));
    this.support.require(actor, 'channel.read');
    if (!item || !channel) throw notFoundError('CHANNEL_COMMENT_NOT_FOUND', 'Channel comment');
    return { item, channel };
  }
  editComment(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['body', 'version']);
    const { item, channel } = this.commentOf(actor, id);
    this.support.require(actor, 'channel.comment');
    if (item.authorUserId !== actor.user.id) throw forbidden('Only the author can edit a comment.');
    if (item.status === 'DELETED') throw notFoundError('CHANNEL_COMMENT_NOT_FOUND', 'Channel comment');
    this.writable(channel);
    this.support.expectVersion(item, body.raw.version ?? ifMatch);
    const text = body.str('body', { required: true, trim: false, max: MAX_COMMENT });
    if (!text.trim()) throw validationError('body', 'body must not be empty.');
    item.body = text; item.editedAt = this.support.now(); this.support.touch(item);
    return item;
  }
  deleteComment(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version', 'reason']);
    const { item, channel } = this.commentOf(actor, id);
    if (item.status === 'DELETED') return item;
    const own = item.authorUserId === actor.user.id;
    if (own) this.support.require(actor, 'channel.comment');
    else if (!this.moderator(actor, channel)) throw forbidden('Only the author or a Channel moderator can delete this comment.');
    this.writable(channel);
    this.support.expectVersion(item, body.raw.version ?? ifMatch, false);
    const before = { body: item.body };
    item.status = 'DELETED'; item.body = null; item.deletedAt = this.support.now(); item.deletedByUserId = actor.user.id; this.support.touch(item);
    if (!own) this.support.audit(actor, channel.workspaceId, 'CHANNEL.COMMENT_MODERATED', 'CHANNEL_COMMENT', item.id, before, { status: 'DELETED' }, { reason: body.str('reason', { max: 500 }) ?? null });
    return item;
  }
}
