import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from './domain';
import { fileScenarioFixture } from './file-scenarios';
const MEMBER = perms('WORKSPACE', 'chat.read', 'chat.message_send', 'chat.create', 'chat.message_delete_own');
async function fixture() {
 const c = await collabApp(), comm = c.collab.communication, user = await c.memberActor('overview-chat', MEMBER);
 const chat = comm.chats.createGroup(c.owner, b({ title: 'Overview', memberUserIds: [user.user.id] }));
 return { c, comm, user, chat };
}
export const communicationOverviewScenarios = {
 async 'Durable Message survives missed realtime.'() {
  const x = await fixture(), first = x.comm.messages.send(x.c.owner, x.chat.id, b({ clientMessageId: 'first', body: 'First' }));
  for (const text of ['second', 'third']) x.comm.messages.send(x.c.owner, x.chat.id, b({ clientMessageId: text, body: text }));
  const reload = x.comm.messages.list(x.user, x.chat.id, new URLSearchParams({ afterSequence: String(first.sequence), sortOrder: 'asc' }));
  expect(reload.data.map(row => row.body)).toEqual(['second', 'third']); expect(x.c.state.chatMessages).toHaveLength(3);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CHAT_MESSAGE_SENT')).toHaveLength(3);
 },
 async 'Duplicate sends dedupe.'() {
  const x = await fixture(), body = { clientMessageId: 'same', body: 'Once' };
  const results = await Promise.all([1, 2].map(() => Promise.resolve().then(() => x.comm.messages.send(x.user, x.chat.id, b(body)))));
  expect(results[0].id).toBe(results[1].id); expect(x.c.state.chatMessages).toHaveLength(1);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CHAT_MESSAGE_SENT')).toHaveLength(1);
  await expectAppError(() => x.comm.messages.send(x.user, x.chat.id, b({ ...body, body: 'different' })), 'MESSAGE_CLIENT_ID_CONFLICT', 409);
 },
 async 'Access source recomputation.'() {
  const x = await fixture(), project = x.c.collab.tasks.projects.create(x.c.owner, b({ name: 'Sourced', tools: ['CHAT'], memberUserIds: [x.user.user.id] }));
  const chatId = x.c.collab.tasks.projects.linkedResources(x.c.owner, project.id).CHAT.resourceId!;
  x.comm.chats.addMember(x.c.owner, chatId, b({ userId: x.user.user.id }));
  x.comm.chats.leave(x.user, chatId, b()); expect(x.comm.chats.get(x.user, chatId).id).toBe(chatId);
  x.c.collab.tasks.projects.removeMember(x.c.owner, project.id, x.user.user.id);
  await expectAppError(() => x.comm.chats.get(x.user, chatId), 'CHAT_NOT_FOUND', 404);
 },
 async 'External Collab isolation.'() {
  const x = await fixture(), guest = await x.c.foreignActor('overview-guest');
  const space = x.comm.collabs.create(x.c.owner, b({ name: 'External' }));
  const invitation = x.comm.collabs.invite(x.c.owner, space.id, b({ email: guest.user.email }));
  x.comm.collabs.accept(guest.user, invitation.token!, b());
  expect(x.comm.chats.guestRead(x.c.owner.workspaceId, guest.user.id, space.chatId!)).toMatchObject({ id: space.chatId });
  await expectAppError(() => x.comm.chats.guestRead(x.c.owner.workspaceId, guest.user.id, x.chat.id), 'CHAT_NOT_FOUND', 404);
  expect(x.c.app.access.isActiveMember(x.c.owner.workspaceId, guest.user.id)).toBe(false);
  x.comm.collabs.removeMember(x.c.owner, space.id, guest.user.id, b());
  await expectAppError(() => x.comm.chats.guestRead(x.c.owner.workspaceId, guest.user.id, space.chatId!), 'CHAT_NOT_FOUND', 404);
 },
 async 'Retention vs Legal Hold.'() {
  const x = await fileScenarioFixture(), comm = x.c.collab.communication;
  const chat = comm.chats.createGroup(x.c.owner, b({ title: 'Retained evidence' }));
  const message = comm.messages.send(x.c.owner, chat.id, b({ clientMessageId: 'held', messageType: 'FILE', body: 'Evidence', fileIds: [x.file.id] }));
  const stored = x.c.state.chatMessages.find(row => row.id === message.id)!; stored.sentAt = new Date('2000-01-01T00:00:00Z');
  // Default indefinite retention survives age and File lifecycle changes.
  expect(comm.messages.get(x.c.owner, message.id).body).toBe('Evidence');
  x.c.state.retentionRecords.push({ id: randomUUID(), workspaceId: x.c.owner.workspaceId, category: 'CHAT', resourceId: chat.id, expiresAt: new Date(0), legalHold: true });
  const removed = comm.messages.remove(x.c.owner, message.id, b());
  expect(removed).toMatchObject({ status: 'DELETED', body: null });
  expect(comm.messages.versions(x.c.owner, message.id)).toEqual([expect.objectContaining({ versionNumber: message.version, body: 'Evidence' })]);
  expect(x.c.state.driveFiles.find(row => row.id === x.file.id)!.status).toBe('ACTIVE'); expect(x.c.state.driveFileVersions).toHaveLength(1);
  x.c.owner.workspace.settings.fileRetentionDays = 0;
  x.c.state.retentionRecords.push({ id: randomUUID(), workspaceId: x.c.owner.workspaceId, category: 'FILE', resourceId: x.file.id, expiresAt: new Date(0), legalHold: true });
  x.f.records.trash(x.c.owner, x.file.id, b({ version: x.file.version }));
  await expectAppError(() => x.f.records.purge(x.c.owner, x.file.id, b({ version: x.file.version })), 'FILE_RETENTION_HOLD', 409);
  expect(comm.messages.versions(x.c.owner, message.id)[0].body).toBe('Evidence');
 },
};
