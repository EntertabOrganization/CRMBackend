import { randomUUID } from 'node:crypto';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);

const CHAT_PERMISSIONS = ['chat.create', 'chat.read', 'chat.message_send', 'chat.message_edit_own', 'chat.message_delete_own', 'chat.update', 'chat.read_receipts', 'task.create', 'task.read']
  .map(key => [key, 'WORKSPACE'] as [string, 'WORKSPACE']);
async function fixture(label = 'chats') {
  const owner = await register(label), prisma = await db(), alice = await member(owner, `${label}-alice`, CHAT_PERMISSIONS);
  const group = expectOk(await call(owner, 'POST', 'chats', { body: { title: 'Release room', memberUserIds: [alice.userId] } }));
  const send = (session = alice, body: Record<string, unknown> = {}) => call(session, 'POST', `chats/${group.id}/messages`, { body: { clientMessageId: randomUUID(), body: 'Hello', ...body } });
  return { owner, alice, prisma, group, send };
}

it('exposes and enforces representative routes: POST   /api/v1/chats; GET    /api/v1/chats; GET    /api/v1/chats/:id; PUT    /api/v1/chats/:id', async () => {
  const x = await fixture();
  const body = { clientMessageId: 'retry-1', body: 'Deploy at noon\nchecklist attached' };
  const sent = await Promise.all([x.send(x.alice, body), x.send(x.alice, body)]);
  const message = expectOk(sent[0]); expect(expectOk(sent[1]).id).toBe(message.id);
  expect(await x.prisma.chatMessage.count({ where: { chatId: x.group.id } })).toBe(1);
  const parallel = await Promise.all([x.send(x.owner, { body: 'a' }), x.send(x.owner, { body: 'b' })]);
  expect(parallel.map(result => expectOk(result).sequence).sort()).toEqual([2, 3]);
  expect(expectOk(await call(x.alice, 'GET', 'chats', { query: { type: 'GROUP' } })).find((row: { id: string }) => row.id === x.group.id)).toMatchObject({ unreadCount: 2 });
  expect(expectOk(await call(x.owner, 'GET', `chats/${x.group.id}`))).toMatchObject({ title: 'Release room' });
  const renamed = expectOk(await call(x.owner, 'PUT', `chats/${x.group.id}`, { body: { title: 'Release war room', version: x.group.version } }));
  expectOk(await call(x.owner, 'PATCH', `chats/${x.group.id}`, { body: { title: 'Release room', version: renamed.version } }));
  expect(expectOk(await call(x.alice, 'GET', `chats/${x.group.id}/messages`, { query: { afterSequence: '1', sortOrder: 'asc' } })).map((row: { body: string }) => row.body).sort()).toEqual(['a', 'b']);
  const edited = expectOk(await call(x.alice, 'PATCH', `messages/${message.id}`, { body: { body: 'Deploy at 13:00', version: 1 } }));
  expect(expectOk(await call(x.owner, 'GET', `messages/${message.id}/versions`))).toEqual([expect.objectContaining({ versionNumber: 1, body: body.body })]);
  expectOk(await call(x.owner, 'POST', `messages/${message.id}/reactions`, { body: { reaction: '🚀' } }));
  expect(expectOk(await call(x.alice, 'GET', `messages/${message.id}`)).reactions).toEqual([{ reaction: '🚀', count: 1, reactedByMe: false }]);
  expectOk(await call(x.owner, 'DELETE', `messages/${message.id}/reactions/${encodeURIComponent('🚀')}`, { body: {} }));
  expect(expectOk(await call(x.owner, 'POST', `messages/${message.id}/pin`, { body: {} })).isPinned).toBe(true);
  expect(expectOk(await call(x.owner, 'DELETE', `messages/${message.id}/pin`, { body: {} })).isPinned).toBe(false);
  expect(expectOk(await call(x.owner, 'POST', `messages/${message.id}/favorite`, { body: {} })).isFavorite).toBe(true);
  expect(expectOk(await call(x.owner, 'DELETE', `messages/${message.id}/favorite`, { body: {} })).isFavorite).toBe(false);
  expect(expectOk(await call(x.owner, 'POST', `messages/${message.id}/read`, { body: {} }))).toMatchObject({ messageId: message.id });
  expect(expectOk(await call(x.owner, 'POST', `chats/${x.group.id}/read`, { body: {} }))).toMatchObject({ lastReadSequence: 3, unreadCount: 0 });
  expect(expectOk(await call(x.alice, 'GET', `messages/${message.id}`)).readByUserIds).toEqual([x.owner.userId]);
  const draft = expectOk(await call(x.alice, 'PUT', `chats/${x.group.id}/draft`, { body: { body: 'unsent', replyToMessageId: message.id } }));
  expect(expectOk(await call(x.alice, 'GET', `chats/${x.group.id}/draft`))).toMatchObject({ body: 'unsent', version: draft.version });
  expectOk(await call(x.alice, 'DELETE', `chats/${x.group.id}/draft`, { body: {} }));
  expect(expectOk(await call(x.alice, 'GET', 'messages/search', { query: { q: '13:00' } })).map((row: { id: string }) => row.id)).toEqual([message.id]);
  const task = expectOk(await call(x.alice, 'POST', `messages/${message.id}/create-task`, { body: {}, headers: { 'idempotency-key': 'message-task' } }));
  expect(expectOk(await call(x.alice, 'POST', `messages/${message.id}/create-task`, { body: {}, headers: { 'idempotency-key': 'message-task' } })).targetId).toBe(task.targetId);
  expect(await x.prisma.task.findUniqueOrThrow({ where: { id: task.targetId } })).toMatchObject({ title: 'Deploy at 13:00' });
  const calendar = expectOk(await call(x.owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Mine', timezone: 'UTC' } }));
  const event = expectOk(await call(x.owner, 'POST', `messages/${message.id}/create-event`, { body: { calendarId: calendar.id, startAt: '2030-02-01T09:00:00Z', endAt: '2030-02-01T10:00:00Z' } }));
  expect(await x.prisma.communicationBinding.count({ where: { sourceId: message.id } })).toBe(2);
  expect(event.targetType).toBe('CALENDAR_EVENT');
  expect(expectOk(await call(x.alice, 'DELETE', `messages/${message.id}`, { body: { version: edited.version } })).status).toBe('DELETED');
  expect(expectOk(await call(x.alice, 'POST', `chats/${x.group.id}/leave`, { body: {} }))).toMatchObject({ left: true });
  expectError(await call(x.alice, 'GET', `chats/${x.group.id}`), 404, 'CHAT_NOT_FOUND');
  expect(expectOk(await call(x.owner, 'POST', `chats/${x.group.id}/archive`, { body: {} })).status).toBe('ARCHIVED');
  expectError(await x.send(x.owner), 409, 'CHAT_ARCHIVED');
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
  const x = await fixture('chats-auth'), message = expectOk(await x.send());
  for (const [method, path] of [['GET', 'chats'], ['PUT', `chats/${x.group.id}`], ['PATCH', `chats/${x.group.id}`], ['POST', `chats/${x.group.id}/archive`],
    ['POST', `chats/${x.group.id}/leave`], ['GET', `chats/${x.group.id}/messages`], ['POST', `chats/${x.group.id}/messages`], ['GET', `messages/${message.id}`],
    ['PATCH', `messages/${message.id}`], ['DELETE', `messages/${message.id}`], ['GET', `messages/${message.id}/versions`], ['POST', `messages/${message.id}/reactions`],
    ['DELETE', `messages/${message.id}/reactions/x`], ['POST', `messages/${message.id}/pin`], ['DELETE', `messages/${message.id}/pin`], ['POST', `messages/${message.id}/favorite`],
    ['DELETE', `messages/${message.id}/favorite`], ['POST', `chats/${x.group.id}/read`], ['POST', `messages/${message.id}/read`], ['GET', `chats/${x.group.id}/draft`],
    ['PUT', `chats/${x.group.id}/draft`], ['DELETE', `chats/${x.group.id}/draft`], ['GET', 'messages/search'], ['POST', `messages/${message.id}/create-task`],
    ['POST', `messages/${message.id}/create-event`]] as const)
    expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
  const reader = await member(x.owner, 'chat-reader', [['chat.read', 'WORKSPACE']]);
  expectOk(await call(x.owner, 'POST', `chats/${x.group.id}/members`, { body: { userId: reader.userId } }));
  expectOk(await call(reader, 'GET', `chats/${x.group.id}/messages`));
  expectError(await x.send(reader), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'PATCH', `chats/${x.group.id}`, { body: { title: 'x', version: 1 } }), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'PATCH', `messages/${message.id}`, { body: { body: 'x', version: 1 } }), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'DELETE', `messages/${message.id}`, { body: {} }), 403, 'PERMISSION_DENIED');
  const outsider = await member(x.owner, 'chat-outsider', CHAT_PERMISSIONS);
  expectError(await call(outsider, 'GET', `chats/${x.group.id}/messages`), 404, 'CHAT_NOT_FOUND');
  expectError(await call(outsider, 'GET', `messages/${message.id}`), 404, 'MESSAGE_NOT_FOUND');
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
  const x = await fixture('chats-tenant'), foreign = await register('chats-foreign'), message = expectOk(await x.send());
  expectError(await call(foreign, 'GET', `chats/${x.group.id}/messages`), 404, 'CHAT_NOT_FOUND');
  expectError(await call(foreign, 'POST', `chats/${x.group.id}/messages`, { body: { clientMessageId: 'x', body: 'x' } }), 404, 'CHAT_NOT_FOUND');
  expectError(await call(foreign, 'GET', `messages/${message.id}`), 404, 'MESSAGE_NOT_FOUND');
  expectError(await call(foreign, 'POST', `messages/${message.id}/reactions`, { body: { reaction: '👍' } }), 404, 'MESSAGE_NOT_FOUND');
  expectError(await call(foreign, 'POST', 'chats/direct', { body: { userId: x.owner.userId } }), 400, 'CHAT_MEMBER_INVALID');
  expect(expectOk(await call(foreign, 'GET', 'messages/search', { query: { q: 'Hello' } }))).toHaveLength(0);
  const foreignChat = expectOk(await call(foreign, 'POST', 'chats', { body: { title: 'Foreign' } }));
  expectError(await x.send(x.alice, { replyToMessageId: MISSING_ID }), 404, 'MESSAGE_NOT_FOUND');
  // Independent SQL guards: tenant-composite links, immutable identity/history, tombstones and forward-only reads.
  await expect(x.prisma.chatMessage.update({ where: { id: message.id }, data: { chatId: foreignChat.id } })).rejects.toThrow();
  await expect(x.prisma.chatMessage.update({ where: { id: message.id }, data: { body: 'silent rewrite', version: 2, editedAt: new Date() } })).rejects.toThrow(/CHAT_MESSAGE_IMMUTABLE/);
  await expect(x.prisma.chatMessage.delete({ where: { id: message.id } })).rejects.toThrow(/CHAT_MESSAGE_IMMUTABLE/);
  await expect(x.prisma.chatMessage.create({ data: { id: randomUUID(), workspaceId: foreign.workspaceId, chatId: x.group.id, sequence: 99, senderType: 'USER', senderId: foreign.userId,
    clientMessageId: 'sql', requestHash: 'a'.repeat(64), messageType: 'TEXT', body: 'x', fileIds: [], status: 'ACTIVE', sentAt: new Date(), version: 1, createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow();
  expectOk(await call(x.owner, 'POST', `chats/${x.group.id}/read`, { body: {} }));
  const state = await x.prisma.chatReadState.findFirstOrThrow({ where: { chatId: x.group.id, userId: x.owner.userId } });
  await expect(x.prisma.chatReadState.update({ where: { id: state.id }, data: { lastReadSequence: 0, lastReadMessageId: null } })).rejects.toThrow(/CHAT_READ_POSITION_INVALID/);
});

it('returns stable machine-readable error envelopes for invalid requests', async () => {
  const x = await fixture('chats-errors'), message = expectOk(await x.send(x.alice, { clientMessageId: 'stable' }));
  expectError(await x.send(x.alice, { clientMessageId: 'stable', body: 'changed' }), 409, 'MESSAGE_CLIENT_ID_CONFLICT');
  expectError(await x.send(x.alice, { clientMessageId: 'has space' }), 400, 'VALIDATION_ERROR');
  expectError(await x.send(x.alice, { body: 'x'.repeat(10_001) }), 400, 'VALIDATION_ERROR');
  expectError(await x.send(x.alice, { unknown: true }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.alice, 'PATCH', `messages/${message.id}`, { body: { body: 'x', version: 7 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectError(await call(x.alice, 'POST', `messages/${message.id}/reactions`, { body: { reaction: 'not an emoji' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.alice, 'GET', 'messages/search', { query: { q: 'x' } }), 400, 'QUERY_INVALID');
  expectError(await call(x.alice, 'GET', `chats/${x.group.id}/messages`, { query: { afterSequence: '-1' } }), 400, 'QUERY_INVALID');
  expectError(await call(x.alice, 'GET', `messages/${MISSING_ID}`), 404, 'MESSAGE_NOT_FOUND');
  expectError(await call(x.alice, 'GET', 'messages/not-a-uuid'), 404, 'MESSAGE_NOT_FOUND');
});

it('persists critical state and outbox/audit consistently on successful mutation', async () => {
  const x = await fixture('chats-outbox'), message = expectOk(await x.send());
  const row = await x.prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } });
  expect(row).toMatchObject({ chatId: x.group.id, senderId: x.alice.userId, sequence: 1, status: 'ACTIVE' });
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'CHAT_MESSAGE_SENT', entityId: message.id } })).toBe(1);
  expectOk(await call(x.alice, 'PATCH', `messages/${message.id}`, { body: { body: 'Edited', version: 1 } }));
  expect(await x.prisma.chatMessageVersion.count({ where: { messageId: message.id } })).toBe(1);
  expectOk(await call(x.owner, 'DELETE', `messages/${message.id}`, { body: { reason: 'cleanup' } }));
  expect(await x.prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: 'DELETED', body: null, deletedByUserId: x.owner.userId });
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'CHAT.MESSAGE_MODERATED', entityId: message.id } })).toBe(1);
  for (const type of ['CHAT_MESSAGE_EDITED', 'CHAT_MESSAGE_DELETED'])
    expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: type, entityId: message.id } })).toBe(1);
});
