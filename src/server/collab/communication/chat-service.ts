import type { ActorContext } from '../../access-service';
import { AppError, forbidden } from '../../errors';
import { Body, type CollabSupport, notFoundError, pageOf } from '../support';
import type { TasksPolicy } from '../tasks/policy';
import type { Task, Project } from '../tasks/types';
import type { TaskChatPort, ProjectResourceProvisioner } from '../tasks/ports';
import type { Chat, ChatMembershipSource } from './types';

/** Communication owns canonical Chat rows; Tasks/Projects delegate lifecycle and membership through ports. */
export type ChatActivity = { lastMessageAt: Date | null; lastReadMessageId: string | null; unreadCount: number };
export class ChatService implements TaskChatPort {
  private activity: (actor: ActorContext, chat: Chat) => ChatActivity = () => ({ lastMessageAt: null, lastReadMessageId: null, unreadCount: 0 });
  constructor(private readonly support: CollabSupport, private readonly tasks: TasksPolicy) {}
  /** Messages supply per-user activity (last message, read position, unread count) for Chat lists. */
  setActivityProvider(provider: typeof this.activity) { this.activity = provider; }
  private get state() { return this.support.state; }
  taskChatOf(taskId: string) { return this.state.chats.find((row) => row.linkedTaskId === taskId) ?? null; }
  private collabMember(chat: Chat, userId: string) {
    return this.state.collabSpaceMembers.find(row => row.workspaceId === chat.workspaceId && row.collabId === chat.linkedCollabId &&
      row.userId === userId && row.status === 'ACTIVE' && !row.leftAt);
  }
  private derivedIds(chat: Chat): string[] {
    if (chat.type === 'DEPARTMENT') {
      const department = this.state.departments.find(row => row.id === chat.linkedDepartmentId && row.workspaceId === chat.workspaceId && !row.isDeleted);
      return department ? [...new Set([...(department.managerId ? [department.managerId] : []),
        ...this.state.departmentMembers.filter(row => row.departmentId === department.id && row.workspaceId === chat.workspaceId && !row.isDeleted).map(row => row.userId)])] : [];
    }
    if (chat.type === 'COLLAB') return this.state.collabSpaceMembers.filter(row => row.collabId === chat.linkedCollabId && row.workspaceId === chat.workspaceId &&
      row.status === 'ACTIVE' && !row.leftAt).map(row => row.userId);
    return [];
  }
  private eligible(chat: Chat, userId: string) {
    if (!this.state.workspaces.some(row => row.id === chat.workspaceId && !row.isDeleted)) return false;
    const user = this.state.users.find(row => row.id === userId && row.status === 'ACTIVE' && !row.isDeleted);
    if (!user) return false;
    if (chat.type === 'COLLAB') {
      const space = this.state.collabSpaces.find(row => row.id === chat.linkedCollabId && row.workspaceId === chat.workspaceId);
      const member = this.collabMember(chat, userId);
      return Boolean(space && member && (member.memberType === 'EXTERNAL' || this.support.isEligibleUser(chat.workspaceId, userId)));
    }
    return this.support.isEligibleUser(chat.workspaceId, userId);
  }
  private sourceValid(chat: Chat, source: ChatMembershipSource) {
    if (!source.active || source.workspaceId !== chat.workspaceId || !this.eligible(chat, source.userId)) return false;
    if (chat.type === 'DIRECT') {
      const pair = this.state.directChatPairs.find(row => row.chatId === chat.id && row.workspaceId === chat.workspaceId);
      return Boolean(pair && [pair.userAId, pair.userBId].includes(source.userId));
    }
    if (chat.type === 'DEPARTMENT' || chat.type === 'COLLAB')
      return source.sourceType === chat.type && source.sourceId === (chat.linkedDepartmentId ?? chat.linkedCollabId) && this.derivedIds(chat).includes(source.userId);
    if (source.sourceType === 'PROJECT') {
      const project = this.state.projects.find((row) => row.id === chat.linkedProjectId && row.id === source.sourceId && row.workspaceId === chat.workspaceId && !row.isDeleted);
      return Boolean(project && this.tasks.projectRole(project, source.userId));
    }
    if (source.sourceType === 'TASK') {
      const task = this.state.tasks.find((row) => row.id === chat.linkedTaskId && row.id === source.sourceId && row.workspaceId === chat.workspaceId);
      return Boolean(task && this.tasks.taskAudience(task).includes(source.userId));
    }
    return true;
  }
  effectiveMemberIds(chatId: string) {
    const chat = this.state.chats.find((row) => row.id === chatId);
    return chat ? [...new Set([...this.state.chatMembershipSources.filter((row) => row.chatId === chat.id && this.sourceValid(chat, row)).map((row) => row.userId),
      ...this.derivedIds(chat).filter(id => this.eligible(chat, id))])] : [];
  }
  private canRead(actor: ActorContext, chat: Chat) {
    if (chat.workspaceId !== actor.workspaceId || !this.support.scope(actor, 'chat.read') || !this.support.isEligibleUser(actor.workspaceId, actor.user.id)) return false;
    if (chat.type === 'TASK' && chat.linkedTaskId) {
      const task = this.state.tasks.find((row) => row.id === chat.linkedTaskId && row.workspaceId === actor.workspaceId);
      return Boolean(task && this.tasks.canViewTask(actor, task));
    }
    return this.effectiveMemberIds(chat.id).includes(actor.user.id);
  }
  /** A Chat the actor can currently read (404 CHAT_NOT_FOUND otherwise, indistinguishable from a missing Chat). */
  chat(actor: ActorContext, id: string) {
    this.support.require(actor, 'chat.read');
    const row = this.state.chats.find((chat) => chat.id === id && this.canRead(actor, chat));
    if (!row) throw notFoundError('CHAT_NOT_FOUND', 'Chat'); return row;
  }
  get(actor: ActorContext, id: string) {
    const chat = this.chat(actor, id);
    return this.view(chat);
  }
  authorizeAttachment(actor: ActorContext, id: string, write: boolean) {
    const chat = this.chat(actor, id);
    if (write && (this.readOnly(chat) || !this.support.scope(actor, 'chat.message_send')))
      throw forbidden('This Chat does not allow attachment changes.');
  }
  view(chat: Chat) {
    return { ...chat, linkedEntityType: chat.linkedTaskId ? 'TASK' : chat.linkedProjectId ? 'PROJECT' : chat.linkedDepartmentId ? 'DEPARTMENT' : chat.linkedCollabId ? 'COLLAB' : null,
      linkedEntityId: chat.linkedTaskId ?? chat.linkedProjectId ?? chat.linkedDepartmentId ?? chat.linkedCollabId ?? null, isReadOnly: this.readOnly(chat) };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'chat.read');
    const rows = this.state.chats.filter(chat => chat.workspaceId === actor.workspaceId && this.canRead(actor, chat)).map(chat => {
      const activity = this.activity(actor, chat);
      return { ...this.view(chat), ...activity, lastActivityAt: activity.lastMessageAt ?? chat.createdAt };
    });
    return pageOf(rows, query, { searchable: ['title'], filterable: ['type', 'status', 'linkedEntityType', 'linkedEntityId', 'isReadOnly'],
      sortable: ['lastActivityAt', 'createdAt', 'updatedAt', 'title', 'unreadCount'], defaultSort: 'lastActivityAt', defaultOrder: 'desc' });
  }
  /**
   * Moderation authority inside one Chat: Workspace owner, Group administrator, Project manager, Department manager or
   * Collab owner/administrator. Broad RBAC alone never moderates a Chat the actor cannot read.
   */
  isModerator(actor: ActorContext, chat: Chat) {
    if (actor.role.isOwnerRole) return true;
    if (chat.type === 'PROJECT') {
      const project = this.state.projects.find(row => row.id === chat.linkedProjectId && row.workspaceId === chat.workspaceId);
      if (project && this.tasks.isProjectManager(project, actor.user.id)) return true;
    }
    return this.memberViews(chat).some(row => row.userId === actor.user.id && row.role === 'ADMIN');
  }
  private administer(actor: ActorContext, id: string) {
    const chat = this.chat(actor, id);
    this.support.require(actor, 'chat.update');
    if (chat.type !== 'GROUP') throw new AppError('CHAT_SOURCE_MANAGED', 'This Chat is managed by its owning resource.', 409);
    if (!this.isModerator(actor, chat)) throw forbidden('Chat changes require a Chat administrator.');
    return chat;
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch: number | undefined, full: boolean) {
    body.only(['title', 'version']);
    const chat = this.administer(actor, id);
    if (this.readOnly(chat)) throw new AppError('CHAT_ARCHIVED', 'The Chat is read-only.', 409);
    this.support.expectVersion(chat, body.raw.version ?? ifMatch);
    const title = body.has('title') || full ? body.str('title', { required: true, max: 500 }) : chat.title;
    const before = { title: chat.title };
    chat.title = title; this.support.touch(chat);
    this.support.audit(actor, chat.workspaceId, 'CHAT.UPDATED', 'CHAT', chat.id, before, { title });
    this.support.event({ workspaceId: chat.workspaceId, type: 'CHAT_UPDATED', entityType: 'CHAT', entityId: chat.id, actorUserId: actor.user.id,
      changes: { title }, audienceUserIds: this.effectiveMemberIds(chat.id) });
    return this.view(chat);
  }
  archive(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']);
    const chat = this.administer(actor, id);
    if (chat.status === 'ARCHIVED') return this.view(chat);
    this.support.expectVersion(chat, body.raw.version ?? ifMatch, false);
    chat.status = 'ARCHIVED'; this.support.touch(chat);
    this.support.audit(actor, chat.workspaceId, 'CHAT.ARCHIVED', 'CHAT', chat.id, { status: 'ACTIVE' }, { status: 'ARCHIVED' });
    this.support.event({ workspaceId: chat.workspaceId, type: 'CHAT_ARCHIVED', entityType: 'CHAT', entityId: chat.id, actorUserId: actor.user.id,
      changes: { status: 'ARCHIVED' }, audienceUserIds: this.effectiveMemberIds(chat.id) });
    return this.view(chat);
  }
  /** Only a directly granted (MANUAL) membership can be left; derived access follows its owning resource. */
  leave(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const chat = this.chat(actor, id);
    const manual = this.state.chatMembershipSources.find(row => row.chatId === chat.id && row.userId === actor.user.id && row.sourceType === 'MANUAL' && row.active);
    if (!manual || !['GROUP', 'PROJECT'].includes(chat.type))
      throw new AppError('CHAT_MEMBERSHIP_SOURCE_PROTECTED', 'Membership is managed by the Direct pair or owning resource.', 409);
    if (this.readOnly(chat)) throw new AppError('CHAT_ARCHIVED', 'The Chat is read-only.', 409);
    const admins = this.state.chatMembers.filter(row => row.chatId === chat.id && row.role === 'ADMIN' && !row.leftAt && this.effectiveMemberIds(chat.id).includes(row.userId));
    if (chat.type === 'GROUP' && admins.some(row => row.userId === actor.user.id) && admins.length === 1 && this.effectiveMemberIds(chat.id).length > 1)
      throw new AppError('CHAT_MEMBERSHIP_SOURCE_PROTECTED', 'Assign another administrator before leaving this Group.', 409);
    this.setSource(chat, actor.user.id, 'MANUAL', manual.sourceId, false, actor.user.id);
    return { chatId: chat.id, userId: actor.user.id, left: !this.effectiveMemberIds(chat.id).includes(actor.user.id) };
  }
  /** Guest authority is usable only by the two Collab Chat read routes. */
  guestRead(workspaceId: string, userId: string, id: string, members = false) {
    const chat = this.state.chats.find(row => row.id === id && row.workspaceId === workspaceId && row.type === 'COLLAB' &&
      this.collabMember(row, userId)?.memberType === 'EXTERNAL' && this.eligible(row, userId));
    if (!chat) throw notFoundError('CHAT_NOT_FOUND', 'Chat');
    return members ? this.memberViews(chat) : this.view(chat);
  }
  members(actor: ActorContext, id: string) {
    return this.memberViews(this.chat(actor, id));
  }
  private memberViews(chat: Chat) {
    return this.effectiveMemberIds(chat.id).map(userId => {
      const member = this.state.chatMembers.find(row => row.chatId === chat.id && row.workspaceId === chat.workspaceId && row.userId === userId);
      const collabRole = this.collabMember(chat, userId)?.role;
      const department = this.state.departments.find(row => row.id === chat.linkedDepartmentId && row.workspaceId === chat.workspaceId);
      const role = chat.type === 'COLLAB' ? (collabRole === 'OWNER' || collabRole === 'ADMIN' ? 'ADMIN' : 'MEMBER') :
        chat.type === 'DEPARTMENT' ? (department?.managerId === userId ? 'ADMIN' : 'MEMBER') : member?.role ?? 'MEMBER';
      return { ...(member ?? { id: userId, workspaceId: chat.workspaceId, chatId: chat.id, userId, joinedAt: this.collabMember(chat, userId)?.joinedAt ?? chat.createdAt }), role, leftAt: null, lastReadMessageId: member?.lastReadMessageId ?? null };
    });
  }
  readOnly(chat: Chat) {
    const project = chat.linkedProjectId ? this.state.projects.find((row) => row.id === chat.linkedProjectId) :
      chat.linkedTaskId ? this.state.projects.find((project) => this.state.tasks.some((task) => task.id === chat.linkedTaskId && task.projectId === project.id)) : null;
    const department = chat.linkedDepartmentId ? this.state.departments.find(row => row.id === chat.linkedDepartmentId && row.workspaceId === chat.workspaceId) : null;
    const space = chat.linkedCollabId ? this.state.collabSpaces.find(row => row.id === chat.linkedCollabId && row.workspaceId === chat.workspaceId) : null;
    return chat.status === 'ARCHIVED' || Boolean(project && (project.isDeleted || project.status === 'ARCHIVED')) ||
      Boolean(department?.isDeleted || space?.status === 'ARCHIVED');
  }
  private manage(actor: ActorContext, id: string) {
    const chat = this.chat(actor, id);
    if (chat.type === 'TASK') throw new AppError('TASK_CHAT_MEMBERSHIP_MANAGED', 'Task Chat access is managed by the Task.', 409);
    this.support.require(actor, 'chat.member_manage');
    if (['DIRECT', 'DEPARTMENT', 'COLLAB'].includes(chat.type))
      throw new AppError('CHAT_MEMBERSHIP_SOURCE_PROTECTED', 'Membership is managed by the Direct pair or owning resource.', 409);
    const project = this.state.projects.find((row) => row.id === chat.linkedProjectId && row.workspaceId === actor.workspaceId);
    if (!actor.role.isOwnerRole && !(project && this.tasks.isProjectManager(project, actor.user.id)) &&
      !this.state.chatMembers.some((row) => row.chatId === id && row.userId === actor.user.id && row.role === 'ADMIN' && !row.leftAt))
      throw forbidden('Chat membership changes require a managing role.');
    if (this.readOnly(chat)) throw new AppError('CHAT_ARCHIVED', 'The Chat is read-only.', 409);
    return chat;
  }
  createGroup(actor: ActorContext, body: Body) {
    this.support.require(actor, 'chat.create'); body.only(['type', 'title', 'memberUserIds']);
    if (body.has('type')) body.enumOf('type', ['GROUP'] as const, { required: true });
    const title = body.str('title', { required: true, max: 500 });
    const ids = [...new Set([actor.user.id, ...(body.uuids('memberUserIds', { max: 100 }) ?? [])])];
    if (ids.some(id => !this.support.isEligibleUser(actor.workspaceId, id))) throw new AppError('CHAT_MEMBER_INVALID', 'Chat members must be active internal Workspace users.', 400);
    const chat = this.create(actor.workspaceId, 'GROUP', title, this.support.id(), actor.user.id);
    for (const id of ids) this.setSource(chat, id, 'MANUAL', chat.id, true, actor.user.id);
    return this.view(chat);
  }
  direct(actor: ActorContext, body: Body) {
    this.support.require(actor, 'chat.create'); body.only(['userId']);
    const userId = body.uuid('userId', { required: true });
    if (userId === actor.user.id || !this.support.isEligibleUser(actor.workspaceId, userId))
      throw new AppError('CHAT_MEMBER_INVALID', 'A Direct Chat requires another active internal Workspace user.', 400);
    const [userAId, userBId] = [actor.user.id, userId].sort();
    const old = this.state.directChatPairs.find(row => row.workspaceId === actor.workspaceId && row.userAId === userAId && row.userBId === userBId);
    if (old) return this.get(actor, old.chatId);
    const chat = this.create(actor.workspaceId, 'DIRECT', '', this.support.id(), actor.user.id); chat.title = null;
    this.state.directChatPairs.push({ id: this.support.id(), workspaceId: actor.workspaceId, chatId: chat.id, userAId, userBId });
    for (const id of [userAId, userBId]) this.setSource(chat, id, 'SYSTEM', chat.id, true, actor.user.id);
    return this.view(chat);
  }
  ensureDepartmentChat(workspaceId: string, departmentId: string, actorUserId: string) {
    const department = this.state.departments.find(row => row.id === departmentId && row.workspaceId === workspaceId && !row.isDeleted);
    if (!department) throw notFoundError('CHAT_NOT_FOUND', 'Department');
    const chat = this.state.chats.find(row => row.linkedDepartmentId === departmentId && row.workspaceId === workspaceId) ??
      this.create(workspaceId, 'DEPARTMENT', department.name, departmentId, actorUserId);
    this.sync(chat, 'DEPARTMENT', departmentId, this.derivedIds(chat)); return chat.id;
  }
  departmentChanged(workspaceId: string, departmentId: string, actorUserId: string) {
    const department = this.state.departments.find(row => row.id === departmentId && row.workspaceId === workspaceId);
    if (!department) return;
    if (!department.isDeleted) { this.ensureDepartmentChat(workspaceId, departmentId, actorUserId); return; }
    const chat = this.state.chats.find(row => row.linkedDepartmentId === departmentId && row.workspaceId === workspaceId);
    if (chat) { chat.status = 'ARCHIVED'; this.support.touch(chat); this.sync(chat, 'DEPARTMENT', departmentId, []); }
  }
  ensureCollabChat(workspaceId: string, collabId: string, actorUserId: string) {
    const space = this.state.collabSpaces.find(row => row.id === collabId && row.workspaceId === workspaceId);
    if (!space) throw notFoundError('CHAT_NOT_FOUND', 'Collab');
    const chat = this.state.chats.find(row => row.linkedCollabId === collabId && row.workspaceId === workspaceId) ??
      this.create(workspaceId, 'COLLAB', space.name, collabId, actorUserId);
    this.sync(chat, 'COLLAB', collabId, this.derivedIds(chat)); return chat.id;
  }
  addMember(actor: ActorContext, id: string, body: Body) {
    const chat = this.manage(actor, id); body.only(['userId']);
    const userId = body.uuid('userId', { required: true });
    if (!this.support.isEligibleUser(chat.workspaceId, userId)) throw new AppError('CHAT_MEMBER_INVALID', 'Chat members must be active internal Workspace users.', 400);
    this.setSource(chat, userId, 'MANUAL', chat.id, true, actor.user.id);
    return this.state.chatMembers.find((row) => row.chatId === id && row.userId === userId)!;
  }
  removeMember(actor: ActorContext, id: string, userId: string) {
    const chat = this.manage(actor, id); userId = new Body({ userId }).uuid('userId', { required: true });
    if (chat.type === 'GROUP' && this.state.chatMembers.some(row => row.chatId === id && row.userId === userId && row.role === 'ADMIN' && !row.leftAt) &&
      !this.state.chatMembers.some(row => row.chatId === id && row.userId !== userId && row.role === 'ADMIN' && !row.leftAt && this.effectiveMemberIds(id).includes(row.userId)))
      throw new AppError('CHAT_MEMBERSHIP_SOURCE_PROTECTED', 'A Group must retain an active administrator.', 409);
    this.setSource(chat, userId, 'MANUAL', chat.id, false, actor.user.id);
    return { userId, removed: !this.effectiveMemberIds(id).includes(userId) };
  }
  private setSource(chat: Chat, userId: string, sourceType: ChatMembershipSource['sourceType'], sourceId: string, active: boolean, actorUserId: string | null) {
    let source = this.state.chatMembershipSources.find((row) => row.chatId === chat.id && row.userId === userId && row.sourceType === sourceType && row.sourceId === sourceId);
    if (source?.active === active || !source && !active) return;
    const now = this.support.now();
    if (source) { source.active = active; source.updatedAt = now; }
    else { source = { id: this.support.id(), workspaceId: chat.workspaceId, chatId: chat.id, userId, sourceType, sourceId, active, createdAt: now, updatedAt: now }; this.state.chatMembershipSources.push(source); }
    let member = this.state.chatMembers.find((row) => row.chatId === chat.id && row.userId === userId);
    const effective = this.effectiveMemberIds(chat.id).includes(userId);
    if (member) member.leftAt = effective ? null : now;
    else if (effective) { member = { id: this.support.id(), workspaceId: chat.workspaceId, chatId: chat.id, userId, role: userId === chat.createdByUserId ? 'ADMIN' : 'MEMBER', joinedAt: now, leftAt: null }; this.state.chatMembers.push(member); }
    this.support.event({ workspaceId: chat.workspaceId, type: 'CHAT_MEMBER_CHANGED', entityType: 'CHAT', entityId: chat.id, actorUserId,
      audienceUserIds: [userId], changes: { userId, sourceType, sourceId, active, effective } });
    const actor = actorUserId ? this.support.access.actor(this.state.users.find((row) => row.id === actorUserId)!, chat.workspaceId) : null;
    this.support.audit(actor, chat.workspaceId, 'CHAT.MEMBERSHIP_SOURCE_CHANGED', 'CHAT', chat.id, null, { userId, sourceType, sourceId, active });
  }
  private sync(chat: Chat, type: 'TASK' | 'PROJECT' | 'DEPARTMENT' | 'COLLAB', sourceId: string, userIds: string[]) {
    const desired = new Set(userIds.filter((id) => this.eligible(chat, id)));
    const previous = this.state.chatMembershipSources.filter((row) => row.chatId === chat.id && row.sourceType === type && row.sourceId === sourceId).map((row) => row.userId);
    for (const id of new Set([...previous, ...desired])) this.setSource(chat, id, type, sourceId, desired.has(id), null);
  }
  private create(workspaceId: string, type: Chat['type'], title: string, sourceId: string, actorUserId: string) {
    const now = this.support.now(), chat: Chat = { id: this.support.id(), workspaceId, type, title, linkedTaskId: type === 'TASK' ? sourceId : null,
      linkedProjectId: type === 'PROJECT' ? sourceId : null, createdByUserId: actorUserId, status: 'ACTIVE', version: 1, createdAt: now, updatedAt: now };
    chat.linkedDepartmentId = type === 'DEPARTMENT' ? sourceId : null;
    chat.linkedCollabId = type === 'COLLAB' ? sourceId : null;
    this.state.chats.push(chat);
    this.support.audit(null, workspaceId, 'CHAT.PROVISIONED', 'CHAT', chat.id, null, { type, sourceId, actorUserId });
    this.support.event({ workspaceId, type: 'CHAT_CREATED', entityType: 'CHAT', entityId: chat.id, actorUserId, changes: { type, sourceId } });
    return chat;
  }
  ensureTaskChat(task: Task, audienceUserIds: string[], actorUserId: string | null) {
    const chat = this.taskChatOf(task.id) ?? this.create(task.workspaceId, 'TASK', task.title, task.id, actorUserId ?? task.createdByUserId);
    if (chat.title !== task.title) { chat.title = task.title; this.support.touch(chat); }
    this.sync(chat, 'TASK', task.id, audienceUserIds); return chat.id;
  }
  syncTaskChatAccess(task: Task, audienceUserIds: string[]) { this.ensureTaskChat(task, audienceUserIds, null); }
  onTaskLifecycle(task: Task, change: 'DELETED' | 'RESTORED' | 'HARD_DELETED') {
    const chat = this.taskChatOf(task.id); if (!chat) return;
    chat.status = change === 'RESTORED' ? 'ACTIVE' : 'ARCHIVED';
    if (change === 'HARD_DELETED') {
      chat.linkedTaskId = null;
      for (const source of this.state.chatMembershipSources.filter((row) => row.chatId === chat.id && row.sourceType === 'TASK')) source.sourceType = 'SYSTEM';
    }
    this.support.touch(chat);
  }
  projectProvisioner(): ProjectResourceProvisioner {
    const find = (project: Project, id: string) => this.state.chats.find((row) => row.id === id && row.workspaceId === project.workspaceId && row.linkedProjectId === project.id);
    return { toolType: 'CHAT', resourceType: 'CHAT',
      provision: (project, actorUserId, members) => {
        const chat = this.state.chats.find((row) => row.linkedProjectId === project.id && row.workspaceId === project.workspaceId) ?? this.create(project.workspaceId, 'PROJECT', project.name, project.id, actorUserId);
        this.sync(chat, 'PROJECT', project.id, members); return chat.id;
      },
      syncProjectMembers: (project, id, members) => { const chat = find(project, id); if (chat) this.sync(chat, 'PROJECT', project.id, members); },
      setReadOnly: (project, id, readOnly) => { const chat = find(project, id); if (chat && (chat.status === 'ARCHIVED') !== readOnly) { chat.status = readOnly ? 'ARCHIVED' : 'ACTIVE'; this.support.touch(chat); } },
      detach: (project, id) => {
        const chat = find(project, id); if (!chat) return;
        chat.linkedProjectId = null; chat.status = 'ARCHIVED'; this.support.touch(chat);
        for (const source of this.state.chatMembershipSources.filter((row) => row.chatId === id && row.sourceType === 'PROJECT')) source.sourceType = 'SYSTEM';
      },
    };
  }
}
