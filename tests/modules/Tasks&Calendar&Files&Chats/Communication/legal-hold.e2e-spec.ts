import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);

it('preserves the final Message body under live Chat Legal Hold and rejects SQL evidence bypass', async () => {
 const owner = await register('message-hold'), foreign = await register('message-hold-foreign'), prisma = await db();
 const chat = expectOk(await call(owner, 'POST', 'chats', { body: { title: 'Held conversation' } }));
 const message = expectOk(await call(owner, 'POST', `chats/${chat.id}/messages`, { body: { clientMessageId: 'held', body: 'Preserve this evidence' } }));
 const id = randomUUID();
 await prisma.commercialPackRecord.create({ data: { id, workspaceId: owner.workspaceId, collection: 'retentionRecords', data: {
  id, workspaceId: owner.workspaceId, category: 'CHAT', resourceId: chat.id, expiresAt: new Date(0).toISOString(), legalHold: true,
 } } });
 await expect(prisma.chatMessage.update({ where: { id: message.id }, data: { status: 'DELETED', body: null, fileIds: [], deletedAt: new Date(), deletedByUserId: owner.userId, version: message.version + 1 } })).rejects.toThrow(/MESSAGE_LEGAL_HOLD/);
 expect(await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: 'ACTIVE', body: 'Preserve this evidence', version: message.version });
 expectError(await call(foreign, 'DELETE', `messages/${message.id}`, { body: { version: message.version } }), 404, 'MESSAGE_NOT_FOUND');
 const removed = expectOk(await call(owner, 'DELETE', `messages/${message.id}`, { body: { version: message.version } })); expect(removed).toMatchObject({ status: 'DELETED', body: null });
 const evidence = await prisma.chatMessageVersion.findFirstOrThrow({ where: { messageId: message.id, versionNumber: message.version } });
 expect(evidence).toMatchObject({ workspaceId: owner.workspaceId, body: 'Preserve this evidence' });
 expect(expectOk(await call(owner, 'GET', `messages/${message.id}/versions`))).toEqual([expect.objectContaining({ body: 'Preserve this evidence' })]);
 await expect(prisma.chatMessageVersion.delete({ where: { id: evidence.id } })).rejects.toThrow(/CHAT_MESSAGE_IMMUTABLE/);
 expect(await prisma.outboxEvent.count({ where: { entityId: message.id, eventType: 'CHAT_MESSAGE_DELETED' } })).toBe(1);
 expect(await prisma.driveFile.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
});
