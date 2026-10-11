import { createHash, randomBytes } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import type { User } from '../../domain';
import { AppError, forbidden } from '../../errors';
import { Body, type CollabSupport, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { ChatService } from './chat-service';
import type { CollabInvitation, CollabSpace, CollabSpaceMember } from './types';

const DAY_MS = 86_400_000, EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Collabs are restricted spaces for internal users and invited external guests. Guests never receive Workspace roles:
 * their only authority is an ACTIVE Collab membership, which the owning tools (Chat, Files ACL) evaluate live.
 */
export class CollabService {
  constructor(private readonly support: CollabSupport, private readonly chats: ChatService) {}
  private get state() { return this.support.state; }

  private member(collab: CollabSpace, userId: string) {
    return this.state.collabSpaceMembers.find(row => row.collabId === collab.id && row.workspaceId === collab.workspaceId && row.userId === userId && row.status === 'ACTIVE' && !row.leftAt);
  }
  private canRead(actor: ActorContext, collab: CollabSpace) {
    if (collab.workspaceId !== actor.workspaceId || !this.support.scope(actor, 'collab.read') || !this.support.isEligibleUser(actor.workspaceId, actor.user.id)) return false;
    return Boolean(this.member(collab, actor.user.id)) || actor.role.isOwnerRole;
  }
  private collab(actor: ActorContext, id: string) {
    this.support.require(actor, 'collab.read');
    const row = isUuid(id) ? this.state.collabSpaces.find(item => item.id === id.toLowerCase() && this.canRead(actor, item)) : undefined;
    if (!row) throw notFoundError('COLLAB_NOT_FOUND', 'Collab');
    return row;
  }
  /** A Collab the actor can read as an active member (or Workspace owner); used by Calls and other child tools. */
  authorize(actor: ActorContext, id: string) { return this.collab(actor, id); }
  private manage(actor: ActorContext, collab: CollabSpace, permission: string) {
    this.support.require(actor, permission);
    const role = this.member(collab, actor.user.id)?.role;
    if (!actor.role.isOwnerRole && role !== 'OWNER' && role !== 'ADMIN') throw forbidden('This Collab action requires a Collab owner or administrator.');
  }
  private writable(collab: CollabSpace) {
    if (collab.status === 'ARCHIVED') throw new AppError('COLLAB_ARCHIVED', 'The Collab is archived and read-only.', 409);
  }
  private touch(collab: CollabSpace) { collab.version += 1; collab.updatedAt = this.support.now(); }
  private chatId(collab: CollabSpace) { return this.state.chats.find(row => row.linkedCollabId === collab.id && row.workspaceId === collab.workspaceId)?.id ?? null; }
  view(collab: CollabSpace, userId?: string) {
    const members = this.state.collabSpaceMembers.filter(row => row.collabId === collab.id && row.status === 'ACTIVE' && !row.leftAt);
    return { id: collab.id, workspaceId: collab.workspaceId, name: collab.name, description: collab.description ?? null, ownerUserId: collab.ownerUserId,
      status: collab.status, archivedAt: collab.archivedAt ?? null, version: collab.version, createdAt: collab.createdAt ?? null, updatedAt: collab.updatedAt ?? null,
      chatId: this.chatId(collab), memberCount: members.length, externalMemberCount: members.filter(row => row.memberType === 'EXTERNAL').length,
      myRole: userId ? members.find(row => row.userId === userId)?.role ?? null : null };
  }
  private changed(actor: ActorContext | null, collab: CollabSpace, action: string, changes: Record<string, unknown>, type = 'COLLAB_MEMBER_CHANGED') {
    this.support.audit(actor, collab.workspaceId, `COLLAB.${action}`, 'COLLAB', collab.id, null, changes);
    this.support.event({ workspaceId: collab.workspaceId, type, entityType: 'COLLAB', entityId: collab.id, actorUserId: actor?.user.id ?? null, changes,
      audienceUserIds: typeof changes.userId === 'string' ? [changes.userId] : undefined });
  }
  private syncChat(collab: CollabSpace, actorUserId: string) { this.chats.ensureCollabChat(collab.workspaceId, collab.id, actorUserId); }
  private setMember(collab: CollabSpace, userId: string, memberType: CollabSpaceMember['memberType'], role: CollabSpaceMember['role']) {
    const now = this.support.now();
    let row = this.state.collabSpaceMembers.find(item => item.collabId === collab.id && item.userId === userId);
    if (row) { row.status = 'ACTIVE'; row.leftAt = null; row.joinedAt = row.joinedAt ?? now; row.memberType = memberType; if (row.role !== 'OWNER') row.role = role; }
    else { row = { id: this.support.id(), workspaceId: collab.workspaceId, collabId: collab.id, userId, memberType, role, status: 'ACTIVE', joinedAt: now, leftAt: null }; this.state.collabSpaceMembers.push(row); }
    return row;
  }

  // ---- Collab lifecycle -------------------------------------------------------------------------------------------------

  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'collab.read');
    const rows = this.state.collabSpaces.filter(row => this.canRead(actor, row)).map(row => this.view(row, actor.user.id));
    return pageOf(rows, query, { searchable: ['name', 'description'], filterable: ['status', 'ownerUserId', 'myRole'], sortable: ['name', 'createdAt', 'updatedAt'], defaultSort: 'name' });
  }
  get(actor: ActorContext, id: string) { return this.view(this.collab(actor, id), actor.user.id); }
  create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'collab.create');
    body.only(['name', 'description', 'memberUserIds']);
    const name = body.str('name', { required: true, max: 200 }).normalize('NFC'), description = body.str('description', { max: 2000 }) ?? null;
    const memberIds = (body.uuids('memberUserIds', { max: 200 }) ?? []).filter(id => id !== actor.user.id);
    if (!this.support.isEligibleUser(actor.workspaceId, actor.user.id) || memberIds.some(id => !this.support.isEligibleUser(actor.workspaceId, id)))
      throw new AppError('COLLAB_MEMBER_INVALID', 'Direct members must be active internal Workspace users; invite external people.', 400);
    const now = this.support.now();
    const collab: CollabSpace = { id: this.support.id(), workspaceId: actor.workspaceId, name, description, ownerUserId: actor.user.id, status: 'ACTIVE', version: 1,
      createdByUserId: actor.user.id, archivedAt: null, createdAt: now, updatedAt: now };
    this.state.collabSpaces.push(collab);
    this.setMember(collab, actor.user.id, 'INTERNAL', 'OWNER');
    for (const userId of memberIds) this.setMember(collab, userId, 'INTERNAL', 'MEMBER');
    this.syncChat(collab, actor.user.id);
    this.changed(actor, collab, 'CREATED', { name, memberCount: memberIds.length + 1 }, 'COLLAB_CREATED');
    return this.view(collab, actor.user.id);
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch: number | undefined, full: boolean) {
    body.only(['name', 'description', 'version']);
    const collab = this.collab(actor, id);
    this.manage(actor, collab, 'collab.update');
    this.writable(collab);
    this.support.expectVersion(collab, body.raw.version ?? ifMatch);
    const before = { name: collab.name, description: collab.description ?? null };
    if (full || body.has('name')) collab.name = body.str('name', { required: true, max: 200 }).normalize('NFC');
    if (full || body.has('description')) collab.description = body.str('description', { max: 2000 }) ?? null;
    this.touch(collab);
    const chat = this.state.chats.find(row => row.linkedCollabId === collab.id);
    if (chat && chat.title !== collab.name) { chat.title = collab.name; this.support.touch(chat); }
    this.support.audit(actor, collab.workspaceId, 'COLLAB.UPDATED', 'COLLAB', collab.id, before, { name: collab.name, description: collab.description });
    this.support.event({ workspaceId: collab.workspaceId, type: 'COLLAB_UPDATED', entityType: 'COLLAB', entityId: collab.id, actorUserId: actor.user.id, changes: { name: collab.name } });
    return this.view(collab, actor.user.id);
  }
  setArchived(actor: ActorContext, id: string, body: Body, archived: boolean, ifMatch?: number) {
    body.only(['version']);
    const collab = this.collab(actor, id);
    this.manage(actor, collab, 'collab.archive');
    if ((collab.status === 'ARCHIVED') === archived) return this.view(collab, actor.user.id);
    this.support.expectVersion(collab, body.raw.version ?? ifMatch, false);
    collab.status = archived ? 'ARCHIVED' : 'ACTIVE'; collab.archivedAt = archived ? this.support.now() : null; this.touch(collab);
    this.changed(actor, collab, archived ? 'ARCHIVED' : 'RESTORED', { status: collab.status }, archived ? 'COLLAB_ARCHIVED' : 'COLLAB_RESTORED');
    return this.view(collab, actor.user.id);
  }

  // ---- members ----------------------------------------------------------------------------------------------------------

  members(actor: ActorContext, id: string, query: URLSearchParams) { return this.memberList(this.collab(actor, id), query); }
  private memberList(collab: CollabSpace, query: URLSearchParams) {
    const rows = this.state.collabSpaceMembers.filter(row => row.collabId === collab.id && row.status !== 'REMOVED').map(row => ({ ...row }));
    return pageOf(rows, query, { searchable: [], filterable: ['memberType', 'role', 'status'], sortable: ['joinedAt', 'role'], defaultSort: 'joinedAt' });
  }
  /** Internal Workspace users only; external people join through an invitation they accept with their own identity. */
  addMember(actor: ActorContext, id: string, body: Body) {
    body.only(['userId', 'role']);
    const collab = this.collab(actor, id);
    this.manage(actor, collab, 'collab.member_manage');
    this.writable(collab);
    const userId = body.uuid('userId', { required: true }), role = body.enumOf('role', ['ADMIN', 'MEMBER'] as const) ?? 'MEMBER';
    if (!this.support.isEligibleUser(collab.workspaceId, userId)) throw new AppError('COLLAB_EXTERNAL_SCOPE_DENIED', 'External people must be invited to the Collab.', 400);
    if (role === 'ADMIN' && !actor.role.isOwnerRole && this.member(collab, actor.user.id)?.role !== 'OWNER') throw forbidden('Only the Collab owner can grant administration.');
    const existing = this.member(collab, userId);
    if (existing?.role === 'OWNER') return { ...existing };
    if (existing && existing.role === role) return { ...existing };
    const row = this.setMember(collab, userId, 'INTERNAL', role);
    this.syncChat(collab, actor.user.id);
    this.changed(actor, collab, 'MEMBER_ADDED', { userId, role, memberType: 'INTERNAL' });
    return { ...row };
  }
  removeMember(actor: ActorContext, id: string, userId: string, body: Body) {
    body.only([]);
    const collab = this.collab(actor, id);
    const self = userId === actor.user.id;
    if (!self) this.manage(actor, collab, 'collab.member_manage');
    this.writable(collab);
    const row = isUuid(userId) ? this.state.collabSpaceMembers.find(item => item.collabId === collab.id && item.userId === userId.toLowerCase() && item.status !== 'REMOVED') : undefined;
    if (!row) throw notFoundError('COLLAB_MEMBER_NOT_FOUND', 'Collab member');
    if (row.role === 'OWNER') throw new AppError('COLLAB_OWNER_REQUIRED', 'The Collab owner cannot be removed.', 409);
    if (row.role === 'ADMIN' && !self && !actor.role.isOwnerRole && this.member(collab, actor.user.id)?.role !== 'OWNER') throw forbidden('Only the Collab owner can remove administrators.');
    row.status = 'REMOVED'; row.leftAt = this.support.now();
    this.syncChat(collab, actor.user.id);
    this.changed(actor, collab, 'MEMBER_REMOVED', { userId: row.userId, memberType: row.memberType });
    return { userId: row.userId, removed: true };
  }

  // ---- invitations ------------------------------------------------------------------------------------------------------

  private invitationView(row: CollabInvitation, token?: string) {
    const { tokenHash, ...rest } = row;
    return { ...rest, status: row.revokedAt ? 'REVOKED' : row.acceptedAt ? 'ACCEPTED' : row.expiresAt <= this.support.now() ? 'EXPIRED' : 'PENDING',
      ...(token ? { token, acceptPath: `/api/v1/public/collab-invitations/${token}/accept` } : {}) };
  }
  private expiry(collab: CollabSpace, requested?: number | null) {
    const configured = this.state.workspaces.find(row => row.id === collab.workspaceId)?.settings.collabInvitationExpiryDays;
    const fallback = typeof configured === 'number' && Number.isInteger(configured) && configured >= 1 && configured <= 90 ? configured : 7;
    return new Date(this.support.now().getTime() + (requested ?? fallback) * DAY_MS);
  }
  invite(actor: ActorContext, id: string, body: Body) {
    body.only(['email', 'role', 'expiresInDays']);
    const collab = this.collab(actor, id);
    this.manage(actor, collab, 'collab.invite_external');
    this.writable(collab);
    const email = body.str('email', { required: true, max: 320 }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw validationError('email', 'email must be a valid address.');
    const role = body.enumOf('role', ['MEMBER', 'GUEST'] as const) ?? 'GUEST', days = body.int('expiresInDays', { min: 1, max: 90 });
    const user = this.state.users.find(row => row.email.toLowerCase() === email && !row.isDeleted);
    if (user && this.member(collab, user.id)) throw new AppError('COLLAB_INVITATION_INVALID', 'This person is already a Collab member.', 409);
    if (this.state.collabInvitations.some(row => row.collabId === collab.id && row.email === email && !row.acceptedAt && !row.revokedAt && row.expiresAt > this.support.now()))
      throw new AppError('COLLAB_INVITATION_INVALID', 'A pending invitation exists; resend or revoke it.', 409);
    const token = randomBytes(32).toString('base64url'), now = this.support.now();
    const row: CollabInvitation = { id: this.support.id(), workspaceId: collab.workspaceId, collabId: collab.id, email, role, tokenHash: hash(token), expiresAt: this.expiry(collab, days),
      acceptedAt: null, acceptedUserId: null, revokedAt: null, invitedByUserId: actor.user.id, sendCount: 1, version: 1, createdAt: now, updatedAt: now };
    this.state.collabInvitations.push(row);
    this.changed(actor, collab, 'INVITATION_SENT', { invitationId: row.id, role, expiresAt: row.expiresAt }, 'COLLAB_INVITATION_SENT');
    return this.invitationView(row, token);
  }
  private invitation(actor: ActorContext, collab: CollabSpace, invitationId: string) {
    const row = isUuid(invitationId) ? this.state.collabInvitations.find(item => item.id === invitationId.toLowerCase() && item.collabId === collab.id && item.workspaceId === actor.workspaceId) : undefined;
    if (!row) throw notFoundError('COLLAB_INVITATION_NOT_FOUND', 'Collab invitation');
    return row;
  }
  /** Rotates the secret: the previous token stops working immediately. */
  resend(actor: ActorContext, id: string, invitationId: string, body: Body) {
    body.only(['expiresInDays']);
    const collab = this.collab(actor, id);
    this.manage(actor, collab, 'collab.invite_external');
    this.writable(collab);
    const row = this.invitation(actor, collab, invitationId);
    if (row.acceptedAt) throw new AppError('COLLAB_INVITATION_INVALID', 'The invitation was already accepted.', 409);
    if (row.revokedAt) throw new AppError('COLLAB_INVITATION_REVOKED', 'The invitation was revoked.', 410);
    const token = randomBytes(32).toString('base64url');
    row.tokenHash = hash(token); row.expiresAt = this.expiry(collab, body.int('expiresInDays', { min: 1, max: 90 })); row.sendCount += 1;
    this.support.touch(row);
    this.changed(actor, collab, 'INVITATION_RESENT', { invitationId: row.id, sendCount: row.sendCount }, 'COLLAB_INVITATION_SENT');
    return this.invitationView(row, token);
  }
  revoke(actor: ActorContext, id: string, invitationId: string, body: Body) {
    body.only([]);
    const collab = this.collab(actor, id);
    this.manage(actor, collab, 'collab.invite_external');
    const row = this.invitation(actor, collab, invitationId);
    if (row.acceptedAt) throw new AppError('COLLAB_INVITATION_INVALID', 'Accepted invitations become memberships; remove the member instead.', 409);
    if (!row.revokedAt) { row.revokedAt = this.support.now(); this.support.touch(row); this.changed(actor, collab, 'INVITATION_REVOKED', { invitationId: row.id }); }
    return this.invitationView(row);
  }
  /**
   * The caller authenticates with their own global identity (no Workspace context). Replays by the accepting user return
   * the same membership; any other replay, expiry or revocation fails without creating membership.
   */
  accept(user: User, token: string, body: Body) {
    body.only([]);
    const row = /^[A-Za-z0-9_-]{43}$/.test(token) ? this.state.collabInvitations.find(item => item.tokenHash === hash(token)) : undefined;
    if (!row) throw new AppError('COLLAB_INVITATION_INVALID', 'This invitation is invalid.', 404);
    if (row.revokedAt) throw new AppError('COLLAB_INVITATION_REVOKED', 'This invitation was revoked.', 410);
    const collab = this.state.collabSpaces.find(item => item.id === row.collabId && item.workspaceId === row.workspaceId);
    if (!collab) throw new AppError('COLLAB_INVITATION_INVALID', 'This invitation is invalid.', 404);
    if (row.acceptedAt) {
      const member = row.acceptedUserId === user.id ? this.member(collab, user.id) : undefined;
      if (!member) throw new AppError('COLLAB_INVITATION_INVALID', 'This invitation was already used.', 409);
      return { collab: this.view(collab, user.id), member: { ...member } };
    }
    if (row.expiresAt <= this.support.now()) throw new AppError('COLLAB_INVITATION_EXPIRED', 'This invitation has expired.', 410);
    if (user.email.toLowerCase() !== row.email || user.status !== 'ACTIVE') throw new AppError('COLLAB_INVITATION_INVALID', 'Sign in with the invited email address.', 403);
    if (collab.status === 'ARCHIVED') throw new AppError('COLLAB_ARCHIVED', 'The Collab is archived and read-only.', 409);
    const internal = this.support.isEligibleUser(collab.workspaceId, user.id);
    const member = this.setMember(collab, user.id, internal ? 'INTERNAL' : 'EXTERNAL', internal ? 'MEMBER' : row.role);
    row.acceptedAt = this.support.now(); row.acceptedUserId = user.id; this.support.touch(row);
    this.syncChat(collab, row.invitedByUserId);
    this.changed(null, collab, 'INVITATION_ACCEPTED', { invitationId: row.id, userId: user.id, memberType: member.memberType }, 'COLLAB_INVITATION_ACCEPTED');
    this.changed(null, collab, 'MEMBER_ADDED', { userId: user.id, role: member.role, memberType: member.memberType });
    return { collab: this.view(collab, user.id), member: { ...member } };
  }

  // ---- resources and guest reads --------------------------------------------------------------------------------------

  resources(actor: ActorContext, id: string) { return this.resourceView(this.collab(actor, id)); }
  private resourceView(collab: CollabSpace) {
    const guests = new Set(this.state.collabSpaceMembers.filter(row => row.collabId === collab.id && row.memberType === 'EXTERNAL' && row.status === 'ACTIVE' && !row.leftAt).map(row => row.userId));
    const files = this.state.filePermissionAssignments.filter(row => row.workspaceId === collab.workspaceId && row.subjectType === 'EXTERNAL_GUEST' && row.subjectId && guests.has(row.subjectId))
      .map(row => ({ resourceType: row.resourceType, resourceId: row.resourceId, subjectId: row.subjectId, permissionLevel: row.permissionLevel }));
    const chatId = this.chatId(collab);
    return { collabId: collab.id, readOnly: collab.status === 'ARCHIVED', chat: chatId ? { id: chatId } : null, files };
  }
  /** External guests read only their own Collabs; this path never constructs a Workspace actor or role. */
  guestRead(workspaceId: string, userId: string, id: string, view: 'collab' | 'members' | 'resources', query: URLSearchParams) {
    const collab = isUuid(id) ? this.state.collabSpaces.find(row => row.id === id.toLowerCase() && row.workspaceId === workspaceId) : undefined;
    const member = collab && this.member(collab, userId);
    if (!collab || !member || member.memberType !== 'EXTERNAL') throw notFoundError('COLLAB_NOT_FOUND', 'Collab');
    if (view === 'members') return this.memberList(collab, query);
    return view === 'resources' ? this.resourceView(collab) : this.view(collab, userId);
  }
}
