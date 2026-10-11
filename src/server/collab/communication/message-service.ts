import type { ActorContext } from '../../access-service';
import { AppError, forbidden, isAppError } from '../../errors';
import { Body, type CollabSupport, cursorOf, fingerprint, isUuid, validationError } from '../support';
import type { ChatService } from './chat-service';
import { MESSAGE_TYPES, type ChatDraft, type ChatMessage, type ChatReadState, type CommunicationBinding } from './message-types';
import type { Chat } from './types';

const MAX_BODY = 10_000, EDIT_WINDOW_SECONDS = 86_400, RECEIPT_MEMBER_LIMIT = 50, MAX_PINS = 50, MAX_REACTIONS_PER_USER = 20;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const REACTION_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]{1,16}|:[a-z0-9_+-]{1,32}:)$/u;

export type FileReadCheck = (workspaceId: string, actor: ActorContext, fileId: string) => 'OK' | 'MISSING' | 'FORBIDDEN';
export type SourceObjectFactory = {
  createTask(actor: ActorContext, body: Body, idempotencyKey?: string): { id: string };
  createEvent(actor: ActorContext, body: Body, idempotencyKey?: string): { id: string };
};

/**
 * Durable Messages for every Chat type. Messages, versions, reactions and read positions commit with their outbox
 * events; realtime hints are released only after commit, so a client that missed them reloads by `afterSequence`.
 */
export class MessageService {
  constructor(private readonly support: CollabSupport, private readonly chats: ChatService, private readonly files: FileReadCheck,
    private readonly sources: () => SourceObjectFactory) {
    chats.setActivityProvider((actor, chat) => this.activity(actor, chat));
  }
  private get state() { return this.support.state; }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  private message(actor: ActorContext, id: string) {
    const row = isUuid(id) ? this.state.chatMessages.find(item => item.id === id.toLowerCase() && item.workspaceId === actor.workspaceId) : undefined;
    if (!row) throw new AppError('MESSAGE_NOT_FOUND', 'Message was not found.', 404);
    let chat: Chat;
    try { chat = this.chats.chat(actor, row.chatId); }
    catch (error) { if (isAppError(error) && error.code === 'CHAT_NOT_FOUND') throw new AppError('MESSAGE_NOT_FOUND', 'Message was not found.', 404); throw error; }
    return { row, chat };
  }
  view(actor: ActorContext, row: ChatMessage) {
    const reactions = new Map<string, { reaction: string; count: number; reactedByMe: boolean }>();
    for (const item of this.state.chatMessageReactions.filter(item => item.messageId === row.id && item.workspaceId === row.workspaceId)) {
      const entry = reactions.get(item.reaction) ?? { reaction: item.reaction, count: 0, reactedByMe: false };
      entry.count++; entry.reactedByMe ||= item.userId === actor.user.id; reactions.set(item.reaction, entry);
    }
    const reply = row.replyToMessageId ? this.state.chatMessages.find(item => item.id === row.replyToMessageId && item.chatId === row.chatId) : undefined;
    return { id: row.id, chatId: row.chatId, sequence: row.sequence, senderType: row.senderType, senderId: row.senderId, clientMessageId: row.clientMessageId,
      messageType: row.messageType, body: row.body, fileIds: [...row.fileIds], replyToMessageId: row.replyToMessageId,
      replyTo: reply ? { id: reply.id, senderId: reply.senderId, status: reply.status, excerpt: reply.status === 'ACTIVE' ? (reply.body ?? '').slice(0, 200) : null } : null,
      status: row.status, sentAt: row.sentAt, editedAt: row.editedAt, deletedAt: row.deletedAt, version: row.version,
      reactions: [...reactions.values()].sort((a, b) => b.count - a.count || a.reaction.localeCompare(b.reaction)),
      isPinned: this.state.chatMessagePins.some(item => item.messageId === row.id && item.workspaceId === row.workspaceId),
      isFavorite: this.state.chatMessageFavorites.some(item => item.messageId === row.id && item.userId === actor.user.id && item.workspaceId === row.workspaceId) };
  }
  list(actor: ActorContext, chatId: string, query: URLSearchParams) {
    const chat = this.chats.chat(actor, chatId);
    const after = query.get('afterSequence');
    if (after !== null && !/^\d{1,15}$/.test(after)) throw new AppError('QUERY_INVALID', 'afterSequence must be a non-negative integer.', 400);
    const rows = this.state.chatMessages.filter(row => row.chatId === chat.id && row.workspaceId === actor.workspaceId && (after === null || row.sequence > Number(after)))
      .map(row => this.view(actor, row));
    return cursorOf(rows, query, { searchable: [], filterable: ['messageType', 'senderId', 'status', 'isPinned'], sortable: ['sequence'], defaultSort: 'sequence', defaultOrder: 'desc' });
  }
  get(actor: ActorContext, id: string) {
    const { row, chat } = this.message(actor, id);
    const view = this.view(actor, row);
    if (!this.support.scope(actor, 'chat.read_receipts')) return view;
    const members = this.chats.effectiveMemberIds(chat.id);
    if (members.length > RECEIPT_MEMBER_LIMIT) return view;
    const exact = new Set(this.state.chatMessageReads.filter(item => item.messageId === row.id).map(item => item.userId));
    const readBy = members.filter(userId => userId !== row.senderId && (exact.has(userId) ||
      (this.state.chatReadStates.find(item => item.chatId === chat.id && item.userId === userId)?.lastReadSequence ?? 0) >= row.sequence));
    return { ...view, readByUserIds: readBy.sort() };
  }
  versions(actor: ActorContext, id: string) {
    const { row, chat } = this.message(actor, id);
    if (row.status === 'DELETED' && !this.moderator(actor, chat)) throw new AppError('MESSAGE_NOT_FOUND', 'Message was not found.', 404);
    return this.state.chatMessageVersions.filter(item => item.messageId === row.id && item.workspaceId === row.workspaceId)
      .sort((a, b) => a.versionNumber - b.versionNumber).map(({ workspaceId, ...item }) => item);
  }
  search(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'chat.read');
    const q = (query.get('q') ?? '').trim();
    if (q.length < 2 || q.length > 200) throw new AppError('QUERY_INVALID', 'q must be 2 to 200 characters.', 400);
    const chatId = query.get('chatId');
    const readable = new Map<string, boolean>(), canRead = (id: string) => {
      if (!readable.has(id)) { try { this.chats.chat(actor, id); readable.set(id, true); } catch { readable.set(id, false); } }
      return readable.get(id)!;
    };
    if (chatId !== null) this.chats.chat(actor, chatId);
    const needle = q.toLowerCase();
    const rows = this.state.chatMessages.filter(row => row.workspaceId === actor.workspaceId && row.status === 'ACTIVE' && (chatId === null || row.chatId === chatId) &&
      (row.body ?? '').toLowerCase().includes(needle) && canRead(row.chatId)).map(row => this.view(actor, row));
    return cursorOf(rows, query, { searchable: [], filterable: ['chatId', 'senderId', 'messageType'], sortable: ['sequence', 'sentAt'], defaultSort: 'sentAt', defaultOrder: 'desc' });
  }

  // ---- send / edit / delete -----------------------------------------------------------------------------------------

  private writable(actor: ActorContext, chat: Chat) {
    this.support.require(actor, 'chat.message_send');
    if (this.chats.readOnly(chat)) throw new AppError('CHAT_ARCHIVED', 'The Chat is read-only.', 409);
  }
  send(actor: ActorContext, chatId: string, body: Body) {
    body.only(['clientMessageId', 'messageType', 'body', 'fileIds', 'replyToMessageId']);
    const chat = this.chats.chat(actor, chatId);
    this.support.require(actor, 'chat.message_send');
    const clientMessageId = body.str('clientMessageId', { required: true, max: 100 });
    if (!CLIENT_ID_RE.test(clientMessageId)) throw validationError('clientMessageId', 'clientMessageId may contain letters, digits and . _ : - only.');
    const messageType = body.enumOf('messageType', MESSAGE_TYPES) ?? 'TEXT';
    const text = body.str('body', { trim: false, max: MAX_BODY }) ?? null;
    const fileIds = body.uuids('fileIds', { max: 10 }) ?? [];
    const replyToMessageId = body.uuid('replyToMessageId') ?? null;
    const requestHash = fingerprint({ messageType, body: text, fileIds, replyToMessageId });
    // Same sender + clientMessageId is the same semantic send: the original Message is returned, never duplicated.
    const existing = this.state.chatMessages.find(row => row.chatId === chat.id && row.senderId === actor.user.id && row.clientMessageId === clientMessageId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AppError('MESSAGE_CLIENT_ID_CONFLICT', 'This clientMessageId was already used for a different Message.', 409);
      return this.view(actor, existing);
    }
    this.writable(actor, chat);
    if (messageType === 'SYSTEM') throw validationError('messageType', 'SYSTEM Messages are created by the platform.');
    if (messageType === 'TEXT' && (!text || !text.trim())) throw validationError('body', 'body is required for TEXT Messages.');
    if (messageType === 'TEXT' && fileIds.length) throw validationError('fileIds', 'fileIds require a FILE, VOICE or VIDEO Message.');
    if (messageType !== 'TEXT' && !fileIds.length) throw validationError('fileIds', `${messageType} Messages require fileIds.`);
    if ((messageType === 'VOICE' || messageType === 'VIDEO') && fileIds.length !== 1) throw validationError('fileIds', `${messageType} Messages carry exactly one File.`);
    for (const fileId of fileIds) if (this.files(actor.workspaceId, actor, fileId) !== 'OK') throw new AppError('MESSAGE_FILE_ACCESS_DENIED', 'A referenced File is inaccessible.', 403, { fileId });
    if (replyToMessageId && !this.state.chatMessages.some(row => row.id === replyToMessageId && row.chatId === chat.id && row.status === 'ACTIVE'))
      throw new AppError('MESSAGE_NOT_FOUND', 'The quoted Message was not found in this Chat.', 404, { field: 'replyToMessageId' });
    const now = this.support.now();
    const row: ChatMessage = { id: this.support.id(), workspaceId: actor.workspaceId, chatId: chat.id, sequence: this.nextSequence(chat.id), senderType: 'USER',
      senderId: actor.user.id, clientMessageId, requestHash, messageType, body: text, fileIds, replyToMessageId, status: 'ACTIVE', sentAt: now, editedAt: null,
      deletedAt: null, deletedByUserId: null, version: 1, createdAt: now, updatedAt: now };
    this.state.chatMessages.push(row);
    this.advance(actor, chat, row);
    this.emit(actor, chat, 'CHAT_MESSAGE_SENT', row, { sequence: row.sequence, messageType, replyToMessageId });
    return this.view(actor, row);
  }
  private nextSequence(chatId: string) {
    return this.state.chatMessages.reduce((max, row) => row.chatId === chatId ? Math.max(max, row.sequence) : max, 0) + 1;
  }
  private moderator(actor: ActorContext, chat: Chat) {
    return Boolean(this.support.scope(actor, 'chat.moderate')) && this.chats.isModerator(actor, chat);
  }
  private windowOpen(row: ChatMessage) {
    const configured = this.state.workspaces.find(item => item.id === row.workspaceId)?.settings.chatMessageEditWindowSeconds;
    const seconds = typeof configured === 'number' && Number.isInteger(configured) && configured >= 0 ? configured : EDIT_WINDOW_SECONDS;
    return this.support.now().getTime() - row.sentAt.getTime() <= seconds * 1000;
  }
  edit(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['body', 'version']);
    const { row, chat } = this.message(actor, id);
    this.support.require(actor, 'chat.message_edit_own');
    if (row.senderId !== actor.user.id || row.senderType !== 'USER') throw forbidden('Only the sender can edit a Message.');
    if (row.status === 'DELETED') throw new AppError('MESSAGE_NOT_FOUND', 'Message was not found.', 404);
    this.writable(actor, chat);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (!this.windowOpen(row) && !this.moderator(actor, chat)) throw new AppError('MESSAGE_EDIT_WINDOW_EXPIRED', 'The edit window for this Message has expired.', 409);
    const text = body.str('body', { required: true, trim: false, max: MAX_BODY });
    if (!text.trim() && row.messageType === 'TEXT') throw validationError('body', 'body must not be empty.');
    if (text === row.body) return this.view(actor, row);
    const now = this.support.now();
    this.state.chatMessageVersions.push({ id: this.support.id(), workspaceId: row.workspaceId, messageId: row.id, versionNumber: row.version, body: row.body,
      editedByUserId: actor.user.id, createdAt: now });
    row.body = text; row.editedAt = now; this.support.touch(row);
    this.emit(actor, chat, 'CHAT_MESSAGE_EDITED', row, { version: row.version });
    return this.view(actor, row);
  }
  remove(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version', 'reason']);
    const { row, chat } = this.message(actor, id);
    if (row.status === 'DELETED') return this.view(actor, row);
    const own = row.senderId === actor.user.id && row.senderType === 'USER', moderator = this.moderator(actor, chat);
    if (own && !moderator) {
      this.support.require(actor, 'chat.message_delete_own');
      if (!this.windowOpen(row)) throw new AppError('MESSAGE_DELETE_WINDOW_EXPIRED', 'The delete window for this Message has expired.', 409);
    } else if (!moderator) throw forbidden('Only the sender or a Chat moderator can delete this Message.');
    if (this.chats.readOnly(chat)) throw new AppError('CHAT_ARCHIVED', 'The Chat is read-only.', 409);
    this.support.expectVersion(row, body.raw.version ?? ifMatch, false);
    const reason = body.str('reason', { max: 500 }) ?? null, now = this.support.now();
    // Tombstone: content is removed, position and reply structure remain; earlier versions stay as moderator evidence.
    const before = { body: row.body, fileIds: row.fileIds };
    const held = this.state.retentionRecords.some(hold => hold.workspaceId === row.workspaceId && hold.legalHold && !hold.purgedAt &&
      [row.id, chat.id, row.workspaceId, chat.linkedCollabId, chat.linkedDepartmentId, chat.linkedProjectId].includes(hold.resourceId));
    if (held && !this.state.chatMessageVersions.some(version => version.messageId === row.id && version.versionNumber === row.version))
      this.state.chatMessageVersions.push({ id: this.support.id(), workspaceId: row.workspaceId, messageId: row.id, versionNumber: row.version,
        body: row.body, editedByUserId: actor.user.id, createdAt: now });
    row.status = 'DELETED'; row.body = null; row.fileIds = []; row.deletedAt = now; row.deletedByUserId = actor.user.id; this.support.touch(row);
    this.state.chatMessageReactions = this.state.chatMessageReactions.filter(item => item.messageId !== row.id);
    this.state.chatMessagePins = this.state.chatMessagePins.filter(item => item.messageId !== row.id);
    if (!own) this.support.audit(actor, row.workspaceId, 'CHAT.MESSAGE_MODERATED', 'CHAT_MESSAGE', row.id, before, { status: 'DELETED' }, { chatId: chat.id, senderId: row.senderId, reason });
    this.emit(actor, chat, 'CHAT_MESSAGE_DELETED', row, { moderated: !own });
    return this.view(actor, row);
  }

  // ---- reactions / pins / favorites -----------------------------------------------------------------------------------

  private active(actor: ActorContext, id: string) {
    const found = this.message(actor, id);
    if (found.row.status !== 'ACTIVE') throw new AppError('MESSAGE_NOT_FOUND', 'Message was not found.', 404);
    return found;
  }
  react(actor: ActorContext, id: string, body: Body) {
    body.only(['reaction']);
    const { row, chat } = this.active(actor, id);
    this.writable(actor, chat);
    const reaction = this.reaction(body.str('reaction', { required: true, max: 64 }));
    const mine = this.state.chatMessageReactions.filter(item => item.messageId === row.id && item.userId === actor.user.id);
    if (mine.some(item => item.reaction === reaction)) return this.view(actor, row);
    if (mine.length >= MAX_REACTIONS_PER_USER) throw new AppError('MESSAGE_REACTION_LIMIT', 'Too many reactions on this Message.', 409);
    this.state.chatMessageReactions.push({ id: this.support.id(), workspaceId: row.workspaceId, messageId: row.id, userId: actor.user.id, reaction, createdAt: this.support.now() });
    this.emit(actor, chat, 'MESSAGE_REACTED', row, { reaction, active: true });
    return this.view(actor, row);
  }
  unreact(actor: ActorContext, id: string, raw: string, body: Body) {
    body.only([]);
    const { row, chat } = this.active(actor, id);
    this.writable(actor, chat);
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { throw validationError('reaction', 'reaction is invalid.'); }
    const reaction = this.reaction(decoded);
    const before = this.state.chatMessageReactions.length;
    this.state.chatMessageReactions = this.state.chatMessageReactions.filter(item => !(item.messageId === row.id && item.userId === actor.user.id && item.reaction === reaction));
    if (this.state.chatMessageReactions.length !== before) this.emit(actor, chat, 'MESSAGE_REACTED', row, { reaction, active: false });
    return this.view(actor, row);
  }
  private reaction(value: string) {
    const normalized = value.normalize('NFC');
    if (!REACTION_RE.test(normalized)) throw validationError('reaction', 'reaction must be an emoji or a :shortcode:.');
    return normalized;
  }
  pin(actor: ActorContext, id: string, body: Body, pinned: boolean) {
    body.only([]);
    const { row, chat } = pinned ? this.active(actor, id) : this.message(actor, id);
    this.writable(actor, chat);
    const existing = this.state.chatMessagePins.find(item => item.messageId === row.id && item.workspaceId === row.workspaceId);
    if (Boolean(existing) === pinned) return this.view(actor, row);
    if (pinned) {
      if (this.state.chatMessagePins.filter(item => item.chatId === chat.id).length >= MAX_PINS) throw new AppError('MESSAGE_PIN_LIMIT', 'This Chat has too many pinned Messages.', 409);
      this.state.chatMessagePins.push({ id: this.support.id(), workspaceId: row.workspaceId, chatId: chat.id, messageId: row.id, pinnedByUserId: actor.user.id, createdAt: this.support.now() });
    } else this.state.chatMessagePins = this.state.chatMessagePins.filter(item => item !== existing);
    this.emit(actor, chat, pinned ? 'CHAT_MESSAGE_PINNED' : 'CHAT_MESSAGE_UNPINNED', row, {});
    return this.view(actor, row);
  }
  favorite(actor: ActorContext, id: string, body: Body, favorite: boolean) {
    body.only([]);
    const { row } = favorite ? this.active(actor, id) : this.message(actor, id);
    const existing = this.state.chatMessageFavorites.find(item => item.messageId === row.id && item.userId === actor.user.id);
    if (favorite && !existing) this.state.chatMessageFavorites.push({ id: this.support.id(), workspaceId: row.workspaceId, messageId: row.id, userId: actor.user.id, createdAt: this.support.now() });
    if (!favorite && existing) this.state.chatMessageFavorites = this.state.chatMessageFavorites.filter(item => item !== existing);
    return this.view(actor, row);
  }

  // ---- read model ---------------------------------------------------------------------------------------------------

  private readState(actor: ActorContext, chat: Chat) {
    return this.state.chatReadStates.find(item => item.chatId === chat.id && item.userId === actor.user.id && item.workspaceId === chat.workspaceId);
  }
  /** Read positions only move forward; an older position is accepted as a no-op so out-of-order clients converge. */
  private advance(actor: ActorContext, chat: Chat, target: ChatMessage | undefined) {
    let state = this.readState(actor, chat);
    if (!target || state && state.lastReadSequence >= target.sequence) return { state, changed: false };
    const now = this.support.now();
    if (!state) {
      state = { id: this.support.id(), workspaceId: chat.workspaceId, chatId: chat.id, userId: actor.user.id, lastReadSequence: 0, lastReadMessageId: null, updatedAt: now };
      this.state.chatReadStates.push(state);
    }
    state.lastReadSequence = target.sequence; state.lastReadMessageId = target.id; state.updatedAt = now;
    return { state, changed: true };
  }
  private readResult(actor: ActorContext, chat: Chat, state: ChatReadState | undefined, changed: boolean) {
    if (changed) this.support.event({ workspaceId: chat.workspaceId, type: 'CHAT_READ_UPDATED', entityType: 'CHAT', entityId: chat.id, actorUserId: actor.user.id,
      changes: { userId: actor.user.id, lastReadSequence: state?.lastReadSequence ?? 0 }, audienceUserIds: [actor.user.id] });
    return { chatId: chat.id, lastReadMessageId: state?.lastReadMessageId ?? null, lastReadSequence: state?.lastReadSequence ?? 0, unreadCount: this.activity(actor, chat).unreadCount };
  }
  readChat(actor: ActorContext, chatId: string, body: Body) {
    body.only(['messageId']);
    const chat = this.chats.chat(actor, chatId);
    const messageId = body.uuid('messageId');
    const target = messageId ? this.state.chatMessages.find(row => row.id === messageId && row.chatId === chat.id) :
      this.state.chatMessages.filter(row => row.chatId === chat.id).sort((a, b) => b.sequence - a.sequence)[0];
    if (messageId && !target) throw new AppError('MESSAGE_NOT_FOUND', 'Message was not found.', 404);
    const { state, changed } = this.advance(actor, chat, target);
    return this.readResult(actor, chat, state, changed);
  }
  readMessage(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const { row, chat } = this.message(actor, id);
    const { state, changed } = this.advance(actor, chat, row);
    // Exact receipts are kept only for small Chats; larger Chats rely on positions.
    const receipt = row.senderId !== actor.user.id && this.chats.effectiveMemberIds(chat.id).length <= RECEIPT_MEMBER_LIMIT &&
      !this.state.chatMessageReads.some(item => item.messageId === row.id && item.userId === actor.user.id);
    if (receipt) this.state.chatMessageReads.push({ id: this.support.id(), workspaceId: row.workspaceId, chatId: chat.id, messageId: row.id, userId: actor.user.id, readAt: this.support.now() });
    return { ...this.readResult(actor, chat, state, changed || receipt), messageId: row.id };
  }
  activity(actor: ActorContext, chat: Chat) {
    let last: ChatMessage | undefined, unread = 0;
    const position = this.readState(actor, chat)?.lastReadSequence ?? 0;
    for (const row of this.state.chatMessages) {
      if (row.chatId !== chat.id) continue;
      if (!last || row.sequence > last.sequence) last = row;
      if (row.sequence > position && row.status === 'ACTIVE' && row.senderId !== actor.user.id) unread++;
    }
    return { lastMessageAt: last?.sentAt ?? null, lastReadMessageId: this.readState(actor, chat)?.lastReadMessageId ?? null, unreadCount: unread };
  }

  // ---- drafts -------------------------------------------------------------------------------------------------------

  private draftOf(actor: ActorContext, chat: Chat) {
    return this.state.chatDrafts.find(item => item.chatId === chat.id && item.userId === actor.user.id && item.workspaceId === chat.workspaceId);
  }
  private draftView(chat: Chat, row: ChatDraft | undefined) {
    return row ? { chatId: chat.id, body: row.body, replyToMessageId: row.replyToMessageId, version: row.version, updatedAt: row.updatedAt }
      : { chatId: chat.id, body: null, replyToMessageId: null, version: 0, updatedAt: null };
  }
  getDraft(actor: ActorContext, chatId: string) {
    const chat = this.chats.chat(actor, chatId);
    return this.draftView(chat, this.draftOf(actor, chat));
  }
  saveDraft(actor: ActorContext, chatId: string, body: Body, ifMatch?: number) {
    body.only(['body', 'replyToMessageId', 'version']);
    const chat = this.chats.chat(actor, chatId);
    const text = body.str('body', { required: true, trim: false, max: MAX_BODY });
    const replyToMessageId = body.uuid('replyToMessageId') ?? null;
    if (replyToMessageId && !this.state.chatMessages.some(row => row.id === replyToMessageId && row.chatId === chat.id))
      throw new AppError('MESSAGE_NOT_FOUND', 'The quoted Message was not found in this Chat.', 404, { field: 'replyToMessageId' });
    let row = this.draftOf(actor, chat);
    const expected = body.raw.version ?? ifMatch;
    if (row) this.support.expectVersion(row, expected, false);
    else if (expected !== undefined && expected !== 0) throw new AppError('RESOURCE_VERSION_CONFLICT', 'The resource was changed by someone else. Reload and retry.', 409, { currentVersion: 0 });
    const now = this.support.now();
    if (!row) { row = { id: this.support.id(), workspaceId: chat.workspaceId, chatId: chat.id, userId: actor.user.id, body: text, replyToMessageId, version: 1, createdAt: now, updatedAt: now }; this.state.chatDrafts.push(row); }
    else { row.body = text; row.replyToMessageId = replyToMessageId; this.support.touch(row); }
    return this.draftView(chat, row);
  }
  deleteDraft(actor: ActorContext, chatId: string, body: Body) {
    body.only([]);
    const chat = this.chats.chat(actor, chatId);
    this.state.chatDrafts = this.state.chatDrafts.filter(item => !(item.chatId === chat.id && item.userId === actor.user.id));
    return this.draftView(chat, undefined);
  }

  // ---- source objects -----------------------------------------------------------------------------------------------

  /** Task/Event creation runs with the caller's own authority in the owning module; the binding back to the Message is stored here. */
  createFrom(actor: ActorContext, id: string, targetType: CommunicationBinding['targetType'], body: Body, idempotencyKey?: string) {
    const { row, chat } = this.active(actor, id);
    const text = (row.body ?? '').trim(), firstLine = text.split('\n')[0].trim().slice(0, 200) || 'Chat message';
    const defaults: Record<string, unknown> = { title: firstLine, ...(text ? { description: text.slice(0, targetType === 'TASK' ? 50_000 : 10_000) } : {}) };
    let created: { id: string };
    try {
      const source = new Body({ ...defaults, ...body.raw });
      created = targetType === 'TASK' ? this.sources().createTask(actor, source, idempotencyKey) : this.sources().createEvent(actor, source, idempotencyKey);
    } catch (error) {
      if (isAppError(error) && (error.code === 'PERMISSION_DENIED' || error.status === 403))
        throw new AppError('MESSAGE_SOURCE_OBJECT_CREATE_DENIED', `You cannot create this ${targetType === 'TASK' ? 'Task' : 'Event'}.`, 403, { cause: error.code });
      throw error;
    }
    let binding = this.state.communicationBindings.find(item => item.sourceId === row.id && item.targetType === targetType && item.targetId === created.id);
    if (!binding) {
      binding = { id: this.support.id(), workspaceId: row.workspaceId, sourceType: 'CHAT_MESSAGE', sourceId: row.id, chatId: chat.id, targetType, targetId: created.id,
        createdByUserId: actor.user.id, createdAt: this.support.now() };
      this.state.communicationBindings.push(binding);
      this.support.event({ workspaceId: row.workspaceId, type: 'COMMUNICATION_BINDING_CREATED', entityType: 'CHAT_MESSAGE', entityId: row.id, actorUserId: actor.user.id,
        changes: { targetType, targetId: created.id, chatId: chat.id } });
    }
    return { messageId: row.id, chatId: chat.id, targetType, targetId: created.id, bindingId: binding.id, [targetType === 'TASK' ? 'task' : 'event']: created };
  }

  private emit(actor: ActorContext, chat: Chat, type: string, row: ChatMessage, changes: Record<string, unknown>) {
    this.support.event({ workspaceId: chat.workspaceId, type, entityType: 'CHAT_MESSAGE', entityId: row.id, actorUserId: actor.user.id,
      changes: { chatId: chat.id, ...changes }, audienceUserIds: this.chats.effectiveMemberIds(chat.id) });
  }
}
