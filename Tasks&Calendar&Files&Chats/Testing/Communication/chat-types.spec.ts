import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Complete Chat metadata and membership policy', () => {
  it('deduplicates reversed Direct pairs and protects their two-member roster', async () => {
    const c = await collabApp(), chats = c.collab.communication.chats;
    const alice = await c.memberActor('direct-alice', perms('OWN', 'chat.create', 'chat.read', 'chat.member_manage'));
    const bob = await c.memberActor('direct-bob', perms('WORKSPACE', 'chat.read', 'chat.member_manage'));
    const foreign = await c.foreignActor();
    const first = chats.direct(c.owner, b({ userId: alice.user.id }));
    expect(chats.direct(alice, b({ userId: c.owner.user.id })).id).toBe(first.id);
    expect(chats.members(alice, first.id).map(row => row.userId).sort()).toEqual([alice.user.id, c.owner.user.id].sort());
    expect(first).toMatchObject({ type: 'DIRECT', title: null, linkedEntityId: null });
    await expectAppError(() => chats.get(bob, first.id), 'CHAT_NOT_FOUND', 404);
    await expectAppError(() => chats.direct(c.owner, b({ userId: foreign.user.id })), 'CHAT_MEMBER_INVALID', 400);
    await expectAppError(() => chats.addMember(c.owner, first.id, b({ userId: bob.user.id })), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
    await expectAppError(() => chats.removeMember(c.owner, first.id, alice.user.id), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
  });

  it('requires membership and managing authority for Groups; retries preserve sources and audit', async () => {
    const c = await collabApp(), chats = c.collab.communication.chats;
    const alice = await c.memberActor('group-alice', perms('OWN', 'chat.read', 'chat.member_manage'));
    const bob = await c.memberActor('group-bob', perms('WORKSPACE', 'chat.read', 'chat.member_manage'));
    const group = chats.createGroup(c.owner, b({ title: 'Private group', memberUserIds: [alice.user.id] }));
    await expectAppError(() => chats.removeMember(c.owner, group.id, c.owner.user.id), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
    await expectAppError(() => chats.get(bob, group.id), 'CHAT_NOT_FOUND', 404);
    await expectAppError(() => chats.addMember(alice, group.id, b({ userId: bob.user.id })), 'PERMISSION_DENIED', 403);
    chats.addMember(c.owner, group.id, b({ userId: bob.user.id }));
    const before = c.state.auditLogs.length; chats.addMember(c.owner, group.id, b({ userId: bob.user.id }));
    expect(c.state.auditLogs).toHaveLength(before);
    chats.removeMember(c.owner, group.id, bob.user.id);
    await expectAppError(() => chats.get(bob, group.id), 'CHAT_NOT_FOUND', 404);
    c.state.chats.find(row => row.id === group.id)!.status = 'ARCHIVED';
    expect(chats.get(alice, group.id).isReadOnly).toBe(true);
    await expectAppError(() => chats.removeMember(c.owner, group.id, alice.user.id), 'CHAT_ARCHIVED', 409);
  });

  it('synchronizes Department membership and denies stale or manual access', async () => {
    const c = await collabApp(), chats = c.collab.communication.chats;
    const alice = await c.memberActor('department-alice', perms('OWN', 'chat.read', 'chat.member_manage'));
    const bob = await c.memberActor('department-bob', perms('WORKSPACE', 'chat.read'));
    const department = c.app.departments.create(c.owner.user, c.owner.workspaceId, { name: 'Engineering', managerId: c.owner.user.id });
    const id = chats.ensureDepartmentChat(c.owner.workspaceId, department.id, c.owner.user.id);
    c.app.departments.addMembers(c.owner.user, c.owner.workspaceId, department.id, [alice.user.id]);
    expect(chats.get(alice, id).linkedEntityType).toBe('DEPARTMENT');
    await expectAppError(() => chats.get(bob, id), 'CHAT_NOT_FOUND', 404);
    await expectAppError(() => chats.addMember(c.owner, id, b({ userId: bob.user.id })), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
    c.app.departments.removeMember(c.owner.user, c.owner.workspaceId, department.id, alice.user.id);
    await expectAppError(() => chats.get(alice, id), 'CHAT_NOT_FOUND', 404);
    expect(c.state.chatMembers.find(row => row.chatId === id && row.userId === alice.user.id)!.leftAt).not.toBeNull();
    c.app.departments.softDelete(c.owner.user, c.owner.workspaceId, department.id);
    await expectAppError(() => chats.get(c.owner, id), 'CHAT_NOT_FOUND', 404);
  });

  it('limits external users to live Collab membership and preserves archived reads', async () => {
    const c = await collabApp(), chats = c.collab.communication.chats, guest = await c.foreignActor();
    const id = randomUUID();
    c.state.collabSpaces.push({ id, workspaceId: c.owner.workspaceId, name: 'Restricted', ownerUserId: c.owner.user.id, status: 'ACTIVE', version: 1 });
    for (const [userId, memberType, role] of [[c.owner.user.id, 'INTERNAL', 'OWNER'], [guest.user.id, 'EXTERNAL', 'GUEST']] as const)
      c.state.collabSpaceMembers.push({ id: randomUUID(), workspaceId: c.owner.workspaceId, collabId: id, userId, memberType, role, status: 'ACTIVE', joinedAt: new Date(), leftAt: null });
    const chatId = chats.ensureCollabChat(c.owner.workspaceId, id, c.owner.user.id);
    expect(chats.guestRead(c.owner.workspaceId, guest.user.id, chatId)).toMatchObject({ type: 'COLLAB', isReadOnly: false });
    expect(chats.members(c.owner, chatId)).toHaveLength(2);
    await expectAppError(() => chats.addMember(c.owner, chatId, b({ userId: guest.user.id })), 'CHAT_MEMBERSHIP_SOURCE_PROTECTED', 409);
    const group = chats.createGroup(c.owner, b({ title: 'Internal' }));
    await expectAppError(() => chats.guestRead(c.owner.workspaceId, guest.user.id, group.id), 'CHAT_NOT_FOUND', 404);
    c.state.collabSpaces[0].status = 'ARCHIVED';
    expect(chats.guestRead(c.owner.workspaceId, guest.user.id, chatId)).toMatchObject({ isReadOnly: true });
    c.state.workspaces.find(row => row.id === c.owner.workspaceId)!.isDeleted = true;
    await expectAppError(() => chats.guestRead(c.owner.workspaceId, guest.user.id, chatId), 'CHAT_NOT_FOUND', 404);
    c.state.workspaces.find(row => row.id === c.owner.workspaceId)!.isDeleted = false;
    c.state.collabSpaceMembers.find(row => row.userId === guest.user.id)!.status = 'REMOVED';
    await expectAppError(() => chats.guestRead(c.owner.workspaceId, guest.user.id, chatId), 'CHAT_NOT_FOUND', 404);
    expect(chats.members(c.owner, chatId)).toHaveLength(1);
  });
});
