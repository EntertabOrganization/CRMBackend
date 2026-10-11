import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';

jest.setTimeout(180_000);
let owner: Session, alice: Session, bob: Session, foreign: Session, nosy: Session;
beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('canonical-chat-owner');
  const permissions = [['chat.read', 'OWN'], ['task.read', 'OWN'], ['project.read', 'OWN']] as Array<[string, 'OWN']>;
  alice = await member(owner, 'canonical-alice', permissions);
  bob = await member(owner, 'canonical-bob', permissions);
  nosy = await member(owner, 'canonical-nosy', [['chat.read', 'WORKSPACE'], ['chat.member_manage', 'WORKSPACE']]);
  foreign = await register('canonical-foreign');
});
afterAll(disconnect);

async function task(title: string, extra: Record<string, unknown> = {}) {
  return expectOk(await call(owner, 'POST', 'tasks', { body: { title, ...extra } }));
}
async function chatOf(taskId: string) {
  const row = await (await db()).collaborationChat.findUnique({ where: { linkedTaskId: taskId } });
  expect(row).not.toBeNull(); return row!;
}

describe('Canonical Task and Project Chats through HTTP and PostgreSQL', () => {
  it('atomically provisions one Chat for Tasks, subtasks and template instances, including replay', async () => {
    const prisma = await db();
    const root = await task('Canonical parent', { responsibleUserId: alice.userId });
    const rootChat = await chatOf(root.id);
    const child = expectOk(await call(owner, 'POST', `tasks/${root.id}/subtasks`, { body: { title: 'Canonical child' } }));
    const template = expectOk(await call(owner, 'POST', 'task-templates', { body: { name: 'Canonical template', titleTemplate: 'Instantiated' } }));
    const options = { body: {}, headers: { 'idempotency-key': randomUUID() } };
    const first = expectOk(await call(owner, 'POST', `task-templates/${template.id}/instantiate`, options));
    const replay = expectOk(await call(owner, 'POST', `task-templates/${template.id}/instantiate`, options));
    expect(replay.id).toBe(first.id);
    for (const id of [root.id, child.id, first.id]) {
      expect(await prisma.collaborationChat.count({ where: { linkedTaskId: id } })).toBe(1);
      expect(await prisma.outboxEvent.count({ where: { entityId: (await chatOf(id)).id, eventType: 'CHAT_CREATED' } })).toBe(1);
    }
    expectOk(await call(owner, 'PATCH', `tasks/${root.id}`, { body: { title: 'Renamed', version: root.version } }));
    expect((await chatOf(root.id)).id).toBe(rootChat.id);
    const members = expectOk(await call(owner, 'GET', `chats/${rootChat.id}/members`));
    expect(members.map((m: any) => m.userId)).toEqual(expect.arrayContaining([owner.userId, alice.userId]));
  });

  it('enforces live Task authority on reads and rejects manual Task Chat membership', async () => {
    const created = await task('Task authority', { responsibleUserId: alice.userId });
    const chat = await chatOf(created.id);
    expectOk(await call(alice, 'GET', `chats/${chat.id}`));
    expectError(await call(nosy, 'GET', `chats/${chat.id}`), 404, 'CHAT_NOT_FOUND');
    expectError(await call(nosy, 'GET', `chats/${chat.id}/members`), 404, 'CHAT_NOT_FOUND');
    expectError(await call(foreign, 'GET', `chats/${chat.id}`), 404, 'CHAT_NOT_FOUND');
    expectError(await call(null, 'GET', `chats/${chat.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(owner, 'POST', `chats/${chat.id}/members`, { body: { userId: bob.userId } }), 409, 'TASK_CHAT_MEMBERSHIP_MANAGED');
    expectError(await call(owner, 'DELETE', `chats/${chat.id}/members/${alice.userId}`), 409, 'TASK_CHAT_MEMBERSHIP_MANAGED');
    expectOk(await call(owner, 'PATCH', `tasks/${created.id}/responsible`, { body: { responsibleUserId: bob.userId, version: created.version } }));
    expectError(await call(alice, 'GET', `chats/${chat.id}`), 404, 'CHAT_NOT_FOUND');
    expectOk(await call(bob, 'GET', `chats/${chat.id}`));
    expect((await (await db()).collaborationChatMember.findUnique({ where: { chatId_userId: { chatId: chat.id, userId: alice.userId } } }))?.leftAt).not.toBeNull();
  });

  it('removes only Project-derived membership and preserves direct grants', async () => {
    const project = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Chat sources', tools: ['TASKS', 'CHAT'], memberUserIds: [alice.userId, bob.userId] } }));
    const resource = expectOk(await call(owner, 'GET', `projects/${project.id}/linked-resources`)).CHAT.resourceId;
    expectOk(await call(alice, 'GET', `chats/${resource}`));
    const manual = expectOk(await call(owner, 'POST', `chats/${resource}/members`, { body: { userId: alice.userId } }));
    expect(expectOk(await call(owner, 'POST', `chats/${resource}/members`, { body: { userId: alice.userId } })).id).toBe(manual.id);
    expectOk(await call(owner, 'DELETE', `projects/${project.id}/members/${alice.userId}`));
    expectOk(await call(owner, 'DELETE', `projects/${project.id}/members/${bob.userId}`));
    expectOk(await call(alice, 'GET', `chats/${resource}`));
    expectError(await call(bob, 'GET', `chats/${resource}`), 404, 'CHAT_NOT_FOUND');
    expectError(await call(alice, 'POST', `chats/${resource}/members`, { body: { userId: bob.userId } }), 403, 'PERMISSION_DENIED');
    expectError(await call(owner, 'POST', `chats/${resource}/members`, { body: { userId: foreign.userId } }), 400, 'CHAT_MEMBER_INVALID');
    expectOk(await call(owner, 'DELETE', `chats/${resource}/members/${alice.userId}`));
    expectError(await call(alice, 'GET', `chats/${resource}`), 404, 'CHAT_NOT_FOUND');
    const sources = await (await db()).collaborationChatMembershipSource.findMany({ where: { chatId: resource, userId: alice.userId } });
    expect(sources).toHaveLength(2); expect(sources.every(s => !s.active)).toBe(true);
  });

  it('archives, restores and detaches the canonical Project resource without replacing it', async () => {
    const project = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Chat lifecycle', tools: ['TASKS', 'CHAT'] } }));
    const resource = expectOk(await call(owner, 'GET', `projects/${project.id}/linked-resources`)).CHAT.resourceId;
    expectOk(await call(owner, 'POST', `projects/${project.id}/archive`, { body: {} }));
    expect(expectOk(await call(owner, 'GET', `chats/${resource}`)).isReadOnly).toBe(true);
    expectError(await call(owner, 'POST', `chats/${resource}/members`, { body: { userId: bob.userId } }), 409, 'CHAT_ARCHIVED');
    expectOk(await call(owner, 'POST', `projects/${project.id}/unarchive`, { body: {} }));
    expect(expectOk(await call(owner, 'GET', `chats/${resource}`)).isReadOnly).toBe(false);
    expectOk(await call(owner, 'POST', `projects/${project.id}/tools/CHAT/disable`, { body: {} }));
    expectOk(await call(owner, 'POST', `projects/${project.id}/tools/CHAT/enable`, { body: {} }));
    expect(expectOk(await call(owner, 'GET', `projects/${project.id}/linked-resources`)).CHAT.resourceId).toBe(resource);
    expectOk(await call(owner, 'DELETE', `projects/${project.id}`, { body: {} }));
    expectOk(await call(owner, 'DELETE', `projects/${project.id}/hard`, { body: {} }));
    expect(expectOk(await call(owner, 'GET', `chats/${resource}`))).toMatchObject({ linkedProjectId: null, isReadOnly: true });
  });

  it('rejects duplicate canonical links and cross-Workspace database references', async () => {
    const created = await task('SQL integrity'); const chat = await chatOf(created.id); const prisma = await db();
    await expect(prisma.collaborationChat.create({ data: { ...chat, id: randomUUID() } })).rejects.toThrow();
    await expect(prisma.collaborationChat.create({ data: { ...chat, id: randomUUID(), workspaceId: foreign.workspaceId, createdByUserId: foreign.userId } })).rejects.toThrow();
    await expect(prisma.collaborationChat.update({ where: { id: chat.id }, data: { workspaceId: foreign.workspaceId, createdByUserId: foreign.userId } })).rejects.toThrow();
    await expect(prisma.collaborationChatMember.create({ data: { id: randomUUID(), workspaceId: foreign.workspaceId, chatId: chat.id, userId: foreign.userId, role: 'MEMBER', joinedAt: new Date() } })).rejects.toThrow();
    expect(await prisma.collaborationChat.count({ where: { linkedTaskId: created.id } })).toBe(1);
  });
});
