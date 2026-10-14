import { createHash, randomBytes } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError, forbidden, isAppError } from '../../errors';
import { Body, type CollabSupport, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { ChatService } from './chat-service';
import type { CollabService } from './collab-service';
import { EnvironmentCallProvider, type CallMediaProvider } from './call-provider';
import type { CommunicationCall, CommunicationCallParticipant } from './call-types';

const ACCESS_MS = 4 * 3600_000, GUEST_MS = 24 * 3600_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export type CallStartTicket = { callId: string; workspaceId: string; callType: CommunicationCall['callType']; replay: boolean; ready: boolean };
type FileAccess = { check(workspaceId: string, actor: ActorContext, fileId: string): 'OK' | 'MISSING' | 'FORBIDDEN'; issue(actor: ActorContext, fileId: string, query: URLSearchParams): object | Promise<object> };

/**
 * Call lifecycle metadata and authorization. Media rooms belong to the provider adapter: the start reservation commits
 * before provider I/O, and provider failure is committed as a visible FAILED call so history survives the outage.
 */
export class CallService {
  private provider: CallMediaProvider = new EnvironmentCallProvider();
  constructor(private readonly support: CollabSupport, private readonly chats: ChatService, private readonly collabs: CollabService, private readonly files: FileAccess) {}
  configure(provider: CallMediaProvider) { this.provider = provider; }
  private get state() { return this.support.state; }

  // ---- authority ------------------------------------------------------------------------------------------------------

  private participant(call: CommunicationCall, userId: string) {
    return this.state.callParticipants.find(row => row.callId === call.id && row.userId === userId);
  }
  /** Linked context is re-evaluated live: Chat readers, active Collab members, or the invitees/participants of an ad-hoc call. */
  private canRead(actor: ActorContext, call: CommunicationCall) {
    if (call.workspaceId !== actor.workspaceId || !this.support.scope(actor, 'call.read') || !this.support.isEligibleUser(actor.workspaceId, actor.user.id)) return false;
    try {
      if (call.chatId) { this.chats.chat(actor, call.chatId); return true; }
      if (call.collabId) { this.collabs.authorize(actor, call.collabId); return true; }
    } catch { return false; }
    return call.startedByUserId === actor.user.id || call.inviteeUserIds.includes(actor.user.id) || Boolean(this.participant(call, actor.user.id)) || actor.role.isOwnerRole;
  }
  private call(actor: ActorContext, id: string) {
    this.support.require(actor, 'call.read');
    const row = isUuid(id) ? this.state.calls.find(item => item.id === id.toLowerCase() && this.canRead(actor, item)) : undefined;
    if (!row) throw notFoundError('CALL_NOT_FOUND', 'Call');
    return row;
  }
  private host(actor: ActorContext, call: CommunicationCall) {
    if (actor.role.isOwnerRole || call.startedByUserId === actor.user.id) return true;
    if (call.chatId) { const chat = this.state.chats.find(row => row.id === call.chatId); return Boolean(chat && this.chats.isModerator(actor, chat)); }
    if (call.collabId) return ['OWNER', 'ADMIN'].includes(this.state.collabSpaceMembers.find(row => row.collabId === call.collabId && row.userId === actor.user.id && row.status === 'ACTIVE')?.role ?? '');
    return false;
  }
  view(call: CommunicationCall) {
    const { idempotencyKey, ...rest } = call;
    const participants = this.state.callParticipants.filter(row => row.callId === call.id);
    return { ...rest, inviteeUserIds: [...call.inviteeUserIds], hasRecording: Boolean(call.recordingFileId), joinedCount: participants.filter(row => row.status === 'JOINED').length };
  }
  private live(call: CommunicationCall) {
    if (call.status !== 'RINGING' && call.status !== 'ACTIVE') throw new AppError('CALL_INVALID_STATE', `The call is ${call.status.toLowerCase()}.`, 409);
    if (!call.providerRoomId) throw new AppError('CALL_INVALID_STATE', 'The call room is not ready.', 409);
  }
  private emit(call: CommunicationCall, type: string, actorUserId: string | null, changes: Record<string, unknown> = {}) {
    const audience = new Set([call.startedByUserId, ...call.inviteeUserIds, ...this.state.callParticipants.filter(row => row.callId === call.id && row.userId).map(row => row.userId!)]);
    this.support.event({ workspaceId: call.workspaceId, type, entityType: 'CALL', entityId: call.id, actorUserId, changes: { status: call.status, ...changes }, audienceUserIds: [...audience] });
  }

  // ---- start (staged) -------------------------------------------------------------------------------------------------

  /** Phase 1: authorize and commit the RINGING reservation (or return the idempotent replay). */
  reserve(actor: ActorContext, body: Body, idempotencyKey?: string): CallStartTicket {
    this.support.require(actor, 'call.create');
    body.only(['chatId', 'collabId', 'callType', 'title', 'inviteeUserIds', 'recordingEnabled']);
    const key = this.support.idempotencyKey(idempotencyKey), replay = this.support.recall(actor, 'call.start', key, body.raw);
    if (replay) {
      const existing = this.state.calls.find(row => row.id === replay.callId && row.workspaceId === actor.workspaceId);
      if (existing) return { callId: existing.id, workspaceId: existing.workspaceId, callType: existing.callType, replay: true, ready: Boolean(existing.providerRoomId) || existing.status !== 'RINGING' };
    }
    const chatId = body.uuid('chatId') ?? null, collabId = body.uuid('collabId') ?? null;
    if (chatId && collabId) throw validationError('collabId', 'Link a call to a Chat or a Collab, not both.');
    const callType = body.enumOf('callType', ['AUDIO', 'VIDEO'] as const) ?? 'VIDEO';
    const recordingEnabled = body.bool('recordingEnabled') ?? false;
    if (recordingEnabled && this.state.workspaces.find(row => row.id === actor.workspaceId)?.settings.callRecordingEnabled !== true)
      throw new AppError('CALL_INVALID_STATE', 'Call recording is disabled by Workspace policy.', 409);
    let invitees = body.uuids('inviteeUserIds', { max: 50 }) ?? [];
    try {
      if (chatId) {
        const chat = this.chats.chat(actor, chatId);
        if (this.chats.readOnly(chat)) throw new AppError('CHAT_ARCHIVED', 'The Chat is read-only.', 409);
        invitees = this.chats.effectiveMemberIds(chat.id).filter(id => id !== actor.user.id && this.support.isEligibleUser(actor.workspaceId, id));
      } else if (collabId) {
        const collab = this.collabs.authorize(actor, collabId);
        if (collab.status === 'ARCHIVED') throw new AppError('COLLAB_ARCHIVED', 'The Collab is archived and read-only.', 409);
        invitees = this.state.collabSpaceMembers.filter(row => row.collabId === collab.id && row.status === 'ACTIVE' && !row.leftAt && row.userId !== actor.user.id).map(row => row.userId);
      } else if (invitees.some(id => !this.support.isEligibleUser(actor.workspaceId, id))) throw new AppError('CALL_ACCESS_DENIED', 'Invitees must be active internal Workspace users.', 403);
    } catch (error) {
      if (isAppError(error) && ['CHAT_NOT_FOUND', 'COLLAB_NOT_FOUND'].includes(error.code)) throw new AppError('CALL_ACCESS_DENIED', 'The linked conversation is inaccessible.', 403);
      throw error;
    }
    const now = this.support.now();
    const call: CommunicationCall = { id: this.support.id(), workspaceId: actor.workspaceId, chatId, collabId, callType, title: body.str('title', { max: 200 }) ?? null,
      startedByUserId: actor.user.id, status: 'RINGING', provider: this.provider.name, providerRoomId: null, errorCode: null, recordingEnabled, recordingFileId: null,
      inviteeUserIds: [...new Set(invitees.filter(id => id !== actor.user.id))], idempotencyKey: key ?? null, startedAt: now, endedAt: null, endedByUserId: null,
      version: 1, createdAt: now, updatedAt: now };
    this.state.calls.push(call);
    this.support.remember(actor, 'call.start', key, body.raw, { callId: call.id });
    return { callId: call.id, workspaceId: call.workspaceId, callType, replay: false, ready: false };
  }
  /** Phase 2 (outside state units): idempotent provider room creation. */
  openRoom(ticket: CallStartTicket, signal?: AbortSignal) {
    return this.provider.createRoom({ callId: ticket.callId, workspaceId: ticket.workspaceId, callType: ticket.callType }, signal);
  }
  /** Phase 3: attach the room and join the host. A call already resolved by another attempt is returned unchanged. */
  activate(actor: ActorContext, ticket: CallStartTicket, roomId?: string) {
    const call = this.call(actor, ticket.callId);
    if (roomId && !call.providerRoomId && call.status === 'RINGING') {
      call.providerRoomId = roomId; this.support.touch(call);
      this.emit(call, 'CALL_STARTED', actor.user.id, { chatId: call.chatId, collabId: call.collabId, callType: call.callType });
    }
    if (call.status === 'FAILED') throw new AppError('CALL_PROVIDER_ERROR', 'The call provider is unavailable.', 502, { callId: call.id });
    return { ...this.view(call), ...(call.status === 'RINGING' || call.status === 'ACTIVE' ? this.enter(actor, call) : {}) };
  }
  /** Provider failure is durable business state, visible in history. */
  fail(workspaceId: string, callId: string, code: string) {
    const call = this.state.calls.find(row => row.id === callId && row.workspaceId === workspaceId);
    if (!call || call.status !== 'RINGING' || call.providerRoomId) return;
    call.status = 'FAILED'; call.errorCode = code; call.endedAt = this.support.now(); this.support.touch(call);
    this.support.audit(null, call.workspaceId, 'CALL.PROVIDER_FAILED', 'CALL', call.id, null, { errorCode: code, provider: call.provider });
    this.emit(call, 'CALL_FAILED', null, { errorCode: code });
  }
  /** In-process orchestration of the three phases (service callers and tests); HTTP runs each phase in its own state unit. */
  async start(actor: ActorContext, body: Body, idempotencyKey?: string) {
    const ticket = this.reserve(actor, body, idempotencyKey);
    if (ticket.ready) return this.activate(actor, ticket);
    let roomId: string;
    try { roomId = (await this.openRoom(ticket)).roomId; }
    catch (error) { this.fail(ticket.workspaceId, ticket.callId, isAppError(error) ? error.code : 'CALL_PROVIDER_ERROR'); throw new AppError('CALL_PROVIDER_ERROR', 'The call provider is unavailable.', 502, { callId: ticket.callId }); }
    return this.activate(actor, ticket, roomId);
  }

  // ---- participation --------------------------------------------------------------------------------------------------

  private enter(actor: ActorContext, call: CommunicationCall) {
    const now = this.support.now();
    let row = this.participant(call, actor.user.id);
    const joined = row?.status === 'JOINED';
    if (!row) {
      row = { id: this.support.id(), workspaceId: call.workspaceId, callId: call.id, userId: actor.user.id, externalGuestId: null, displayName: null,
        role: call.startedByUserId === actor.user.id ? 'HOST' : 'PARTICIPANT', status: 'JOINED', joinedAt: now, leftAt: null };
      this.state.callParticipants.push(row);
    } else if (!joined) { row.status = 'JOINED'; row.joinedAt = now; row.leftAt = null; }
    if (!joined) { this.promote(call); this.emit(call, 'CALL_PARTICIPANT_JOINED', actor.user.id, { participantId: row.id }); }
    const name = `${actor.user.firstName ?? ''} ${actor.user.lastName ?? ''}`.trim() || 'Participant';
    return { participant: { ...row }, access: this.provider.participantAccess(call.providerRoomId!, row.id, name, new Date(now.getTime() + ACCESS_MS)) };
  }
  private promote(call: CommunicationCall) {
    if (call.status === 'RINGING' && this.state.callParticipants.filter(row => row.callId === call.id && row.status === 'JOINED').length >= 2) { call.status = 'ACTIVE'; this.support.touch(call); }
  }
  join(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const call = this.call(actor, id);
    this.support.require(actor, 'call.join');
    this.live(call);
    return { ...this.enter(actor, call), call: this.view(call) };
  }
  leave(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const call = this.call(actor, id), row = this.participant(call, actor.user.id);
    if (row?.status === 'JOINED') {
      row.status = 'LEFT'; row.leftAt = this.support.now();
      this.emit(call, 'CALL_PARTICIPANT_LEFT', actor.user.id, { participantId: row.id });
      if (call.status === 'ACTIVE' && !this.state.callParticipants.some(item => item.callId === call.id && item.status === 'JOINED')) this.finish(call, null);
    }
    return this.view(call);
  }
  private finish(call: CommunicationCall, actorUserId: string | null) {
    const now = this.support.now();
    call.status = 'ENDED'; call.endedAt = now; call.endedByUserId = actorUserId; this.support.touch(call);
    for (const row of this.state.callParticipants.filter(item => item.callId === call.id && item.status === 'JOINED')) { row.status = 'LEFT'; row.leftAt = now; }
    this.emit(call, 'CALL_ENDED', actorUserId, { providerRoomId: call.providerRoomId });
  }
  /** Idempotent: ending an ended call returns it; provider room teardown consumes the CALL_ENDED outbox event. */
  end(actor: ActorContext, id: string, body: Body) {
    body.only(['recordingFileId']);
    const call = this.call(actor, id);
    this.support.require(actor, 'call.end');
    const recordingFileId = body.uuid('recordingFileId') ?? null;
    if (call.status === 'ENDED' && (!recordingFileId || recordingFileId === call.recordingFileId)) return this.view(call);
    if (!this.host(actor, call)) throw forbidden('Only the call host or a moderator can end this call.');
    if (call.status !== 'ENDED' && call.status !== 'RINGING' && call.status !== 'ACTIVE') throw new AppError('CALL_INVALID_STATE', `The call is ${call.status.toLowerCase()}.`, 409);
    if (recordingFileId) {
      if (!call.recordingEnabled) throw new AppError('CALL_INVALID_STATE', 'Recording was not enabled for this call.', 409);
      if (call.recordingFileId && call.recordingFileId !== recordingFileId) throw new AppError('CALL_INVALID_STATE', 'A different recording is already linked.', 409);
      if (this.files.check(actor.workspaceId, actor, recordingFileId) !== 'OK') throw new AppError('CALL_ACCESS_DENIED', 'The recording File is inaccessible.', 403);
    }
    if (call.status !== 'ENDED') this.finish(call, actor.user.id);
    if (recordingFileId && !call.recordingFileId) {
      call.recordingFileId = recordingFileId; this.support.touch(call);
      this.support.audit(actor, call.workspaceId, 'CALL.RECORDING_LINKED', 'CALL', call.id, null, { fileId: recordingFileId });
      this.emit(call, 'CALL_RECORDING_AVAILABLE', actor.user.id, { fileId: recordingFileId });
    }
    return this.view(call);
  }
  cancel(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const call = this.call(actor, id);
    this.support.require(actor, 'call.end');
    if (call.status === 'CANCELLED') return this.view(call);
    if (!this.host(actor, call)) throw forbidden('Only the call host or a moderator can cancel this call.');
    if (call.status !== 'RINGING') throw new AppError('CALL_INVALID_STATE', 'Only ringing calls can be cancelled; end an active call instead.', 409);
    const now = this.support.now();
    call.status = 'CANCELLED'; call.endedAt = now; call.endedByUserId = actor.user.id; this.support.touch(call);
    for (const row of this.state.callParticipants.filter(item => item.callId === call.id && item.status === 'JOINED')) { row.status = 'LEFT'; row.leftAt = now; }
    this.emit(call, 'CALL_CANCELLED', actor.user.id);
    return this.view(call);
  }
  participants(actor: ActorContext, id: string, query: URLSearchParams) {
    const call = this.call(actor, id);
    const rows = this.state.callParticipants.filter(row => row.callId === call.id).map(row => ({ ...row }));
    return pageOf(rows, query, { searchable: [], filterable: ['status', 'role'], sortable: ['joinedAt'], defaultSort: 'joinedAt' });
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'call.read');
    const rows = this.state.calls.filter(row => this.canRead(actor, row)).map(row => this.view(row));
    return pageOf(rows, query, { searchable: ['title'], filterable: ['status', 'callType', 'chatId', 'collabId', 'startedByUserId'], sortable: ['startedAt', 'endedAt'], defaultSort: 'startedAt', defaultOrder: 'desc' });
  }
  get(actor: ActorContext, id: string) { return this.view(this.call(actor, id)); }

  // ---- external guests and recordings ---------------------------------------------------------------------------------

  inviteExternal(actor: ActorContext, id: string, body: Body) {
    body.only(['displayName', 'email']);
    const call = this.call(actor, id);
    this.support.require(actor, 'call.external_invite');
    if (!this.host(actor, call)) throw forbidden('Only the call host or a moderator can invite external guests.');
    this.live(call);
    const displayName = body.str('displayName', { required: true, max: 100 }), email = body.str('email', { max: 320 })?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationError('email', 'email must be a valid address.');
    const token = randomBytes(32).toString('base64url'), now = this.support.now();
    const row = { id: this.support.id(), workspaceId: call.workspaceId, callId: call.id, displayName, email, tokenHash: hash(token), expiresAt: new Date(now.getTime() + GUEST_MS),
      revokedAt: null, createdByUserId: actor.user.id, createdAt: now };
    this.state.callInvitations.push(row);
    this.support.audit(actor, call.workspaceId, 'CALL.EXTERNAL_INVITED', 'CALL', call.id, null, { invitationId: row.id, email, expiresAt: row.expiresAt });
    const { tokenHash, ...safe } = row;
    return { ...safe, token, joinPath: `/api/v1/public/calls/${token}/join` };
  }
  /** Public, call-scoped: returns media access only, never Chat history, ids of linked conversations or directory data. */
  joinExternal(token: string, body: Body) {
    body.only(['displayName']);
    const invitation = /^[A-Za-z0-9_-]{43}$/.test(token) ? this.state.callInvitations.find(row => row.tokenHash === hash(token)) : undefined;
    const call = invitation && this.state.calls.find(row => row.id === invitation.callId && row.workspaceId === invitation.workspaceId);
    if (!invitation || !call || invitation.revokedAt || invitation.expiresAt <= this.support.now() || (call.status !== 'RINGING' && call.status !== 'ACTIVE') || !call.providerRoomId)
      throw new AppError('CALL_EXTERNAL_TOKEN_INVALID', 'This call link is invalid or has expired.', 404);
    const now = this.support.now(), displayName = body.str('displayName', { max: 100 }) || invitation.displayName;
    let row = this.state.callParticipants.find(item => item.callId === call.id && item.externalGuestId === invitation.id);
    if (!row) {
      row = { id: this.support.id(), workspaceId: call.workspaceId, callId: call.id, userId: null, externalGuestId: invitation.id, displayName, role: 'GUEST', status: 'JOINED', joinedAt: now, leftAt: null };
      this.state.callParticipants.push(row);
      this.promote(call); this.emit(call, 'CALL_PARTICIPANT_JOINED', null, { participantId: row.id, external: true });
    } else if (row.status !== 'JOINED') { row.status = 'JOINED'; row.joinedAt = now; row.leftAt = null; this.promote(call); }
    const expiresAt = new Date(Math.min(now.getTime() + ACCESS_MS, invitation.expiresAt.getTime()));
    return { callId: call.id, callType: call.callType, title: call.title, participantId: row.id, access: this.provider.participantAccess(call.providerRoomId, row.id, displayName, expiresAt) };
  }
  async recording(actor: ActorContext, id: string, query: URLSearchParams) {
    const call = this.call(actor, id);
    this.support.require(actor, 'call.recording_read');
    if (!call.recordingFileId) throw notFoundError('CALL_RECORDING_NOT_FOUND', 'Call recording');
    return { callId: call.id, ...await this.files.issue(actor, call.recordingFileId, query) };
  }
}
