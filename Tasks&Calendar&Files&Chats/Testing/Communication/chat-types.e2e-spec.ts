import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';

jest.setTimeout(180_000);
let owner: Session, alice: Session, bob: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('all-chat-owner');
  alice = await member(owner, 'all-chat-alice', [['chat.create', 'OWN'], ['chat.read', 'OWN'], ['chat.member_manage', 'OWN']]);
  bob = await member(owner, 'all-chat-bob', [['chat.read', 'WORKSPACE'], ['chat.member_manage', 'WORKSPACE']]);
  foreign = await register('all-chat-foreign');
});
afterAll(disconnect);

async function owningResources() {
  const { runStateUnit } = await import('@/src/server/response'), { appContext } = await import('@/src/server/app-context');
  return runStateUnit(async () => {
    const actor = appContext.access.actor(appContext.store.state.users.find(row => row.id === owner.userId)!, owner.workspaceId);
    const department = appContext.departments.create(actor.user, actor.workspaceId, { name: 'Department ' + randomUUID(), managerId: owner.userId });
    appContext.departments.addMembers(actor.user, actor.workspaceId, department.id, [alice.userId]);
    const chats = appContext.collab.communication.chats, departmentChatId = chats.ensureDepartmentChat(actor.workspaceId, department.id, owner.userId);
    const collabId = randomUUID();
    appContext.store.state.collabSpaces.push({ id: collabId, workspaceId: owner.workspaceId, name: 'Restricted space', ownerUserId: owner.userId, status: 'ACTIVE', version: 1 });
    for (const [userId, memberType, role] of [[owner.userId, 'INTERNAL', 'OWNER'], [foreign.userId, 'EXTERNAL', 'GUEST']] as const)
      appContext.store.state.collabSpaceMembers.push({ id: randomUUID(), workspaceId: owner.workspaceId, collabId, userId, memberType, role, status: 'ACTIVE', joinedAt: new Date(), leftAt: null });
    const collabChatId = chats.ensureCollabChat(actor.workspaceId, collabId, owner.userId);
    return { departmentId: department.id, departmentChatId, collabId, collabChatId };
  });
}

describe('All Chat types through HTTP and independent PostgreSQL constraints', () => {
  it('returns one canonical Direct Chat under reversed concurrent requests and protects its pair', async () => {
    const responses = await Promise.all([call(owner, 'POST', 'chats/direct', { body: { userId: alice.userId } }), call(alice, 'POST', 'chats/direct', { body: { userId: owner.userId } })]);
    const chats = responses.map(row => expectOk(row)); expect(chats[0].id).toBe(chats[1].id);
    const id = chats[0].id, prisma = await db();
    expect(await prisma.directChatPair.count({ where: { chatId: id } })).toBe(1);
    expect(expectOk(await call(alice, 'GET', `chats/${id}/members`))).toHaveLength(2);
    expectError(await call(bob, 'GET', `chats/${id}`), 404, 'CHAT_NOT_FOUND');
    expectError(await call(owner, 'POST', `chats/${id}/members`, { body: { userId: bob.userId } }), 409, 'CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    expectError(await call(owner, 'DELETE', `chats/${id}/members/${alice.userId}`), 409, 'CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    expectError(await call(owner, 'POST', 'chats/direct', { body: { userId: foreign.userId } }), 400, 'CHAT_MEMBER_INVALID');
    await expect(prisma.collaborationChatMember.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, chatId: id, userId: bob.userId, role: 'MEMBER', joinedAt: new Date() } })).rejects.toThrow('CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    await expect(prisma.directChatPair.delete({ where: { chatId: id } })).rejects.toThrow('CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    expect(await prisma.outboxEvent.count({ where: { entityId: id, eventType: 'CHAT_CREATED' } })).toBe(1);
  });

  it('enforces Group role, membership, tenant and authentication checks on all four operations', async () => {
    const group = expectOk(await call(owner, 'POST', 'chats', { body: { title: 'Private Group', memberUserIds: [alice.userId] } }));
    expectError(await call(alice, 'POST', `chats/${group.id}/members`, { body: { userId: bob.userId } }), 403, 'PERMISSION_DENIED');
    for (const [method, path, body] of [['GET', `chats/${group.id}`, {}], ['GET', `chats/${group.id}/members`, {}],
      ['POST', `chats/${group.id}/members`, { userId: bob.userId }], ['DELETE', `chats/${group.id}/members/${alice.userId}`, {}]] as const) {
      const options = { body: method === 'GET' ? undefined : body };
      expectError(await call(null, method, path, { ...options, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
      expectError(await call(foreign, method, path, options), 404, 'CHAT_NOT_FOUND');
      expectError(await call(bob, method, path, options), 404, 'CHAT_NOT_FOUND');
    }
    const added = expectOk(await call(owner, 'POST', `chats/${group.id}/members`, { body: { userId: bob.userId } }));
    expect(expectOk(await call(owner, 'POST', `chats/${group.id}/members`, { body: { userId: bob.userId } })).id).toBe(added.id);
    expectOk(await call(bob, 'GET', `chats/${group.id}`));
    expectOk(await call(owner, 'DELETE', `chats/${group.id}/members/${bob.userId}`));
    expectError(await call(bob, 'GET', `chats/${group.id}`), 404, 'CHAT_NOT_FOUND');
    const prisma = await db();
    expect(await prisma.auditLog.count({ where: { entityId: group.id, action: 'CHAT.MEMBERSHIP_SOURCE_CHANGED' } })).toBe(4);
    await expect(prisma.collaborationChatMembershipSource.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, chatId: group.id, userId: foreign.userId,
      sourceType: 'MANUAL', sourceId: group.id, active: true, createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow('CHAT_MEMBER_INVALID');
  });

  it('uses owning Department authority and prevents independent manual-source bypass', async () => {
    const c = await owningResources(), prisma = await db();
    expect(expectOk(await call(alice, 'GET', `chats/${c.departmentChatId}`))).toMatchObject({ type: 'DEPARTMENT', linkedEntityId: c.departmentId });
    expectError(await call(owner, 'POST', `chats/${c.departmentChatId}/members`, { body: { userId: bob.userId } }), 409, 'CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    await expect(prisma.collaborationChatMembershipSource.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, chatId: c.departmentChatId, userId: bob.userId,
      sourceType: 'MANUAL', sourceId: c.departmentChatId, active: true, createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow('CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    await prisma.departmentMember.update({ where: { departmentId_userId: { departmentId: c.departmentId, userId: alice.userId } }, data: { isDeleted: true } });
    expectError(await call(alice, 'GET', `chats/${c.departmentChatId}`), 404, 'CHAT_NOT_FOUND');
    expect(expectOk(await call(owner, 'GET', `chats/${c.departmentChatId}/members`)).map((row: any) => row.userId)).toEqual([owner.userId]);
  });

  it('allows external guests only Collab metadata/members, reevaluates revocation and archives', async () => {
    const c = await owningResources(), prisma = await db(), options = { workspaceId: owner.workspaceId };
    expect(expectOk(await call(foreign, 'GET', `chats/${c.collabChatId}`, options))).toMatchObject({ type: 'COLLAB', linkedEntityId: c.collabId });
    expect(expectOk(await call(foreign, 'GET', `chats/${c.collabChatId}/members`, options))).toHaveLength(2);
    expectError(await call(foreign, 'GET', `chats/${c.departmentChatId}`, options), 404, 'CHAT_NOT_FOUND');
    expectError(await call(foreign, 'POST', `chats/${c.collabChatId}/members`, { ...options, body: { userId: bob.userId } }), 403, 'PERMISSION_DENIED');
    expectError(await call(foreign, 'GET', 'file-storages', options), 403, 'PERMISSION_DENIED');
    expectError(await call(owner, 'DELETE', `chats/${c.collabChatId}/members/${foreign.userId}`), 409, 'CHAT_MEMBERSHIP_SOURCE_PROTECTED');
    await prisma.collabSpace.update({ where: { id: c.collabId }, data: { status: 'ARCHIVED' } });
    expect(expectOk(await call(foreign, 'GET', `chats/${c.collabChatId}`, options)).isReadOnly).toBe(true);
    await prisma.collabSpaceMember.update({ where: { collabId_userId: { collabId: c.collabId, userId: foreign.userId } }, data: { status: 'REMOVED', leftAt: new Date() } });
    expectError(await call(foreign, 'GET', `chats/${c.collabChatId}`, options), 404, 'CHAT_NOT_FOUND');
  });
});
