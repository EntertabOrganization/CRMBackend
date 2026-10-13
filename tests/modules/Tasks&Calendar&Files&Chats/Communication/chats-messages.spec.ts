import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import type { ActorContext } from '@/src/server/access-service';
import { b, collabApp, perms } from '../support/domain';

const MEMBER = perms('WORKSPACE', 'chat.create', 'chat.read', 'chat.message_send', 'chat.message_edit_own', 'chat.message_delete_own', 'chat.update', 'chat.read_receipts', 'chat.member_manage');
async function fixture() {
  const c = await collabApp(), chats = c.collab.communication.chats, messages = c.collab.communication.messages;
  const alice = await c.memberActor('alice', MEMBER), bob = await c.memberActor('bob', MEMBER);
  const group = chats.createGroup(c.owner, b({ title: 'Launch', memberUserIds: [alice.user.id, bob.user.id] }));
  const send = (actor: ActorContext, text: string, extra: Record<string, unknown> = {}, chatId = group.id) =>
    messages.send(actor, chatId, b({ clientMessageId: randomUUID(), body: text, ...extra }));
  return { c, chats, messages, alice, bob, group, send };
}

it('Duplicate send.', async () => {
  const x = await fixture(), body = { clientMessageId: 'client-1', body: 'Hello team' };
  const first = x.messages.send(x.alice, x.group.id, b(body)), retry = x.messages.send(x.alice, x.group.id, b(body));
  expect(retry.id).toBe(first.id);
  expect(x.c.state.chatMessages).toHaveLength(1);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CHAT_MESSAGE_SENT')).toHaveLength(1);
  await expectAppError(() => x.messages.send(x.alice, x.group.id, b({ ...body, body: 'Different' })), 'MESSAGE_CLIENT_ID_CONFLICT', 409);
  // The client identity is per sender: another member may reuse the same opaque ID.
  expect(x.messages.send(x.bob, x.group.id, b(body)).id).not.toBe(first.id);
  expect(x.c.state.chatMessages.map(row => row.sequence)).toEqual([1, 2]);
  await expectAppError(() => x.messages.send(x.alice, x.group.id, b({ clientMessageId: 'bad id!', body: 'x' })), 'VALIDATION_ERROR', 400);
  await expectAppError(() => x.messages.send(x.alice, x.group.id, b({ clientMessageId: 'c2', body: '   ' })), 'VALIDATION_ERROR', 400);
  await expectAppError(() => x.messages.send(x.alice, x.group.id, b({ clientMessageId: 'c3', messageType: 'SYSTEM', body: 'fake' })), 'VALIDATION_ERROR', 400);
  await expectAppError(() => x.messages.send(x.alice, x.group.id, b({ clientMessageId: 'c4', messageType: 'FILE', fileIds: [randomUUID()] })), 'MESSAGE_FILE_ACCESS_DENIED', 403);
});

it('Missed realtime then reload.', async () => {
  const x = await fixture();
  for (const text of ['one', 'two', 'three', 'four']) x.send(x.alice, text);
  // A client that saw sequence 1 and missed the realtime hints reloads everything after it, in order.
  const missed = x.messages.list(x.bob, x.group.id, new URLSearchParams({ afterSequence: '1', sortOrder: 'asc' }));
  expect(missed.data.map(row => row.body)).toEqual(['two', 'three', 'four']);
  const page = x.messages.list(x.bob, x.group.id, new URLSearchParams({ limit: '2' }));
  expect(page.data.map(row => row.sequence)).toEqual([4, 3]);
  const next = x.messages.list(x.bob, x.group.id, new URLSearchParams({ limit: '2', cursor: page.meta.nextCursor! }));
  expect(next.data.map(row => row.sequence)).toEqual([2, 1]);
  expect(x.chats.list(x.bob, new URLSearchParams()).data.find(row => row.id === x.group.id)).toMatchObject({ unreadCount: 4 });
  const read = x.messages.readChat(x.bob, x.group.id, b({ messageId: x.c.state.chatMessages[1].id }));
  expect(read).toMatchObject({ lastReadSequence: 2, unreadCount: 2 });
  expect(x.messages.readChat(x.bob, x.group.id, b({ messageId: x.c.state.chatMessages[0].id })).lastReadSequence).toBe(2); // never moves back
  expect(x.messages.readChat(x.bob, x.group.id, b()).unreadCount).toBe(0);
  const third = x.c.state.chatMessages[2];
  x.messages.readMessage(x.c.owner, third.id, b());
  expect(x.messages.get(x.alice, third.id)).toMatchObject({ readByUserIds: [x.bob.user.id, x.c.owner.user.id].sort() });
  for (const audience of x.c.state.outboxEvents.filter(row => row.eventType === 'CHAT_READ_UPDATED')) expect(audience.actorUserId).not.toBe(x.alice.user.id);
  // Drafts are private per user and versioned.
  const draft = x.messages.saveDraft(x.bob, x.group.id, b({ body: 'half written', replyToMessageId: third.id }));
  expect(x.messages.getDraft(x.alice, x.group.id).body).toBeNull();
  await expectAppError(() => x.messages.saveDraft(x.bob, x.group.id, b({ body: 'stale', version: 9 })), 'RESOURCE_VERSION_CONFLICT', 409);
  expect(x.messages.saveDraft(x.bob, x.group.id, b({ body: 'finished', version: draft.version })).version).toBe(2);
  x.messages.deleteDraft(x.bob, x.group.id, b());
  expect(x.messages.getDraft(x.bob, x.group.id)).toMatchObject({ body: null, version: 0 });
  // Search only covers readable Chats.
  const outsider = await x.c.memberActor('outsider', MEMBER);
  expect(x.messages.search(x.alice, new URLSearchParams({ q: 'thr' })).data.map(row => row.body)).toEqual(['three']);
  expect(x.messages.search(outsider, new URLSearchParams({ q: 'thr' })).data).toHaveLength(0);
});

it('Remove one of multiple membership sources.', async () => {
  const x = await fixture();
  const project = x.c.collab.tasks.projects.create(x.c.owner, b({ name: 'Sourced', tools: ['CHAT'], memberUserIds: [x.alice.user.id] }));
  const resourceId = x.c.collab.tasks.projects.linkedResources(x.c.owner, project.id).CHAT.resourceId;
  expect(resourceId).not.toBeNull();
  const chatId = resourceId!;
  x.chats.addMember(x.c.owner, chatId, b({ userId: x.alice.user.id }));
  expect(x.c.state.chatMembershipSources.filter(row => row.chatId === chatId && row.userId === x.alice.user.id && row.active).map(row => row.sourceType).sort()).toEqual(['MANUAL', 'PROJECT']);
  x.chats.leave(x.alice, chatId, b());
  const message = x.send(x.alice, 'still here through the Project', {}, chatId);
  expect(message.sequence).toBe(1);
  x.c.collab.tasks.projects.removeMember(x.c.owner, project.id, x.alice.user.id);
  await expectAppError(() => x.send(x.alice, 'gone', {}, chatId), 'CHAT_NOT_FOUND', 404);
  await expectAppError(() => x.messages.get(x.alice, message.id), 'MESSAGE_NOT_FOUND', 404);
  // Project membership alone cannot be "left"; it follows the Project.
  await expectAppError(() => x.chats.leave(x.c.owner, chatId, b()), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
  // Group: the last administrator cannot strand the Group; ordinary members can leave.
  await expectAppError(() => x.chats.leave(x.c.owner, x.group.id, b()), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
  expect(x.chats.leave(x.bob, x.group.id, b())).toMatchObject({ left: true });
  await expectAppError(() => x.chats.get(x.bob, x.group.id), 'CHAT_NOT_FOUND', 404);
});

it('Task Chat bypass attempt.', async () => {
  const x = await fixture();
  const task = x.c.collab.tasks.tasks.create(x.c.owner, { title: 'Confidential task' });
  const chatId = x.c.state.chats.find(row => row.linkedTaskId === task.id)!.id;
  const posted = x.send(x.c.owner, 'Task-only discussion', {}, chatId);
  const intruder = await x.c.memberActor('intruder', [...perms('WORKSPACE', 'chat.read', 'chat.message_send', 'chat.member_manage', 'chat.moderate', 'chat.update'), ...perms('OWN', 'task.read')]);
  await expectAppError(() => x.send(intruder, 'let me in', {}, chatId), 'CHAT_NOT_FOUND', 404);
  await expectAppError(() => x.messages.get(intruder, posted.id), 'MESSAGE_NOT_FOUND', 404);
  await expectAppError(() => x.messages.list(intruder, chatId, new URLSearchParams()), 'CHAT_NOT_FOUND', 404);
  await expectAppError(() => x.chats.addMember(x.c.owner, chatId, b({ userId: intruder.user.id })), 'TASK_CHAT_MEMBERSHIP_MANAGED', 409);
  await expectAppError(() => x.chats.update(x.c.owner, chatId, b({ title: 'Renamed', version: 1 }), undefined, false), 'CHAT_SOURCE_MANAGED', 409);
  await expectAppError(() => x.chats.leave(x.c.owner, chatId, b()), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
  expect(x.messages.search(intruder, new URLSearchParams({ q: 'discussion' })).data).toHaveLength(0);
  expect(x.chats.list(intruder, new URLSearchParams()).data.map(row => row.id)).not.toContain(chatId);
  // Gaining Task access is the only way in.
  x.c.collab.tasks.tasks.addMember(x.c.owner, task.id, b({ userId: intruder.user.id }), 'OBSERVER');
  expect(x.messages.list(intruder, chatId, new URLSearchParams()).data.map(row => row.id)).toEqual([posted.id]);
});

it('Edit/delete expiry.', async () => {
  const x = await fixture(), message = x.send(x.alice, 'first draft');
  const edited = x.messages.edit(x.alice, message.id, b({ body: 'second draft', version: 1 }));
  expect(edited).toMatchObject({ body: 'second draft', version: 2 });
  expect(x.messages.versions(x.bob, message.id)).toEqual([expect.objectContaining({ versionNumber: 1, body: 'first draft', editedByUserId: x.alice.user.id })]);
  await expectAppError(() => x.messages.edit(x.bob, message.id, b({ body: 'hijack', version: 2 })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.messages.edit(x.alice, message.id, b({ body: 'stale', version: 1 })), 'RESOURCE_VERSION_CONFLICT', 409);
  await expectAppError(() => x.messages.remove(x.bob, message.id, b()), 'PERMISSION_DENIED', 403);
  const row = x.c.state.chatMessages.find(item => item.id === message.id)!;
  row.sentAt = new Date(Date.now() - 25 * 3600_000);
  await expectAppError(() => x.messages.edit(x.alice, message.id, b({ body: 'late', version: 2 })), 'MESSAGE_EDIT_WINDOW_EXPIRED', 409);
  await expectAppError(() => x.messages.remove(x.alice, message.id, b()), 'MESSAGE_DELETE_WINDOW_EXPIRED', 409);
  x.c.state.workspaces.find(item => item.id === x.c.owner.workspaceId)!.settings.chatMessageEditWindowSeconds = 172_800;
  expect(x.messages.edit(x.alice, message.id, b({ body: 'allowed by policy', version: 2 })).version).toBe(3);
  x.c.state.workspaces.find(item => item.id === x.c.owner.workspaceId)!.settings.chatMessageEditWindowSeconds = 60;
  x.messages.react(x.bob, message.id, b({ reaction: '👍' }));
  x.messages.pin(x.bob, message.id, b(), true);
  // A moderator acts after the window; the deletion leaves a tombstone and audit evidence.
  const removed = x.messages.remove(x.c.owner, message.id, b({ reason: 'Off-topic' }));
  expect(removed).toMatchObject({ status: 'DELETED', body: null, reactions: [], isPinned: false, sequence: 1 });
  expect(x.c.state.auditLogs.filter(item => item.action === 'CHAT.MESSAGE_MODERATED')).toHaveLength(1);
  await expectAppError(() => x.messages.versions(x.bob, message.id), 'MESSAGE_NOT_FOUND', 404);
  expect(x.messages.versions(x.c.owner, message.id)).toHaveLength(2);
  await expectAppError(() => x.messages.edit(x.alice, message.id, b({ body: 'revive', version: removed.version })), 'MESSAGE_NOT_FOUND', 404);
  expect(x.messages.list(x.bob, x.group.id, new URLSearchParams()).data[0]).toMatchObject({ id: message.id, status: 'DELETED', body: null });
  const fresh = x.send(x.alice, 'own delete');
  expect(x.messages.remove(x.alice, fresh.id, b()).status).toBe('DELETED');
  expect(x.c.state.auditLogs.filter(item => item.action === 'CHAT.MESSAGE_MODERATED')).toHaveLength(1);
});

it('Cross-workspace direct Chat.', async () => {
  const x = await fixture(), foreign = await x.c.foreignActor();
  await expectAppError(() => x.chats.direct(x.c.owner, b({ userId: foreign.user.id })), 'CHAT_MEMBER_INVALID', 400);
  await expectAppError(() => x.chats.direct(foreign, b({ userId: x.c.owner.user.id })), 'CHAT_MEMBER_INVALID', 400);
  const direct = x.chats.direct(x.c.owner, b({ userId: x.alice.user.id })), message = x.send(x.c.owner, 'private', {}, direct.id);
  await expectAppError(() => x.send(foreign, 'hi', {}, direct.id), 'CHAT_NOT_FOUND', 404);
  await expectAppError(() => x.messages.get(foreign, message.id), 'MESSAGE_NOT_FOUND', 404);
  await expectAppError(() => x.messages.react(foreign, message.id, b({ reaction: '👍' })), 'MESSAGE_NOT_FOUND', 404);
  await expectAppError(() => x.messages.readChat(foreign, direct.id, b()), 'CHAT_NOT_FOUND', 404);
  await expectAppError(() => x.messages.getDraft(foreign, direct.id), 'CHAT_NOT_FOUND', 404);
  expect(x.messages.search(foreign, new URLSearchParams({ q: 'private' })).data).toHaveLength(0);
  await expectAppError(() => x.messages.get(x.bob, message.id), 'MESSAGE_NOT_FOUND', 404);
});

it('manages reactions, pins, favorites, Group metadata and source objects', async () => {
  const x = await fixture(), message = x.send(x.alice, 'Ship the release on Friday\nwith notes');
  x.messages.react(x.bob, message.id, b({ reaction: '🎉' })); x.messages.react(x.bob, message.id, b({ reaction: '🎉' }));
  x.messages.react(x.alice, message.id, b({ reaction: ':rocket:' }));
  expect(x.messages.get(x.bob, message.id).reactions).toEqual([{ reaction: ':rocket:', count: 1, reactedByMe: false }, { reaction: '🎉', count: 1, reactedByMe: true }]);
  await expectAppError(() => x.messages.react(x.bob, message.id, b({ reaction: '<script>' })), 'VALIDATION_ERROR', 400);
  x.messages.unreact(x.bob, message.id, encodeURIComponent('🎉'), b());
  expect(x.messages.get(x.bob, message.id).reactions).toHaveLength(1);
  expect(x.messages.pin(x.bob, message.id, b(), true).isPinned).toBe(true);
  expect(x.messages.list(x.alice, x.group.id, new URLSearchParams({ isPinned: 'true' })).data).toHaveLength(1);
  expect(x.messages.pin(x.bob, message.id, b(), false).isPinned).toBe(false);
  expect(x.messages.favorite(x.bob, message.id, b(), true).isFavorite).toBe(true);
  expect(x.messages.get(x.alice, message.id).isFavorite).toBe(false);
  expect(x.messages.favorite(x.bob, message.id, b(), false).isFavorite).toBe(false);
  const reply = x.send(x.bob, 'Agreed', { replyToMessageId: message.id });
  expect(reply.replyTo).toMatchObject({ id: message.id, excerpt: 'Ship the release on Friday\nwith notes' });
  // Group metadata: administrators only, optimistic versions, archive freezes writes.
  await expectAppError(() => x.chats.update(x.alice, x.group.id, b({ title: 'Mine', version: 1 }), undefined, false), 'PERMISSION_DENIED', 403);
  const renamed = x.chats.update(x.c.owner, x.group.id, b({ title: 'Launch room', version: x.c.state.chats.find(row => row.id === x.group.id)!.version }), undefined, true);
  expect(renamed.title).toBe('Launch room');
  // Source objects keep a binding back to the Message; Task creation uses the caller's own authority.
  const created = x.messages.createFrom(x.c.owner, message.id, 'TASK', b({}), 'task-from-message');
  expect(x.c.state.tasks.find(row => row.id === created.targetId)).toMatchObject({ title: 'Ship the release on Friday', description: 'Ship the release on Friday\nwith notes' });
  expect(x.messages.createFrom(x.c.owner, message.id, 'TASK', b({}), 'task-from-message').targetId).toBe(created.targetId);
  expect(x.c.state.communicationBindings).toEqual([expect.objectContaining({ sourceId: message.id, targetType: 'TASK', targetId: created.targetId })]);
  await expectAppError(() => x.messages.createFrom(x.bob, message.id, 'TASK', b({})), 'MESSAGE_SOURCE_OBJECT_CREATE_DENIED', 403);
  const calendar = x.c.collab.calendar.calendars.create(x.c.owner, b({ type: 'PERSONAL', name: 'Mine', timezone: 'UTC' }));
  const event = x.messages.createFrom(x.c.owner, message.id, 'CALENDAR_EVENT', b({ calendarId: calendar.id, startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T10:00:00Z' }));
  expect(x.c.state.calendarEvents.find(row => row.id === event.targetId)?.title).toBe('Ship the release on Friday');
  x.chats.archive(x.c.owner, x.group.id, b());
  await expectAppError(() => x.send(x.alice, 'after archive'), 'CHAT_ARCHIVED', 409);
  await expectAppError(() => x.messages.react(x.bob, message.id, b({ reaction: '👍' })), 'CHAT_ARCHIVED', 409);
  expect(x.messages.list(x.alice, x.group.id, new URLSearchParams()).data).toHaveLength(2);
});
