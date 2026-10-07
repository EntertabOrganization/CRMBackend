/**
 * TrueCRM executable contract test for Project Members & Contextual Permissions Specification.
 * Service-level; the HTTP/Postgres path is covered by project-members-permissions.e2e-spec.ts.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms, requireModule } from '../support/domain';

describe('Project Members & Contextual Permissions Specification contract', () => {
  it('Sole-owner protection.', async () => {
    const ctx = await collabApp();
    const { collab, owner, memberActor } = ctx;
    const mod = await memberActor('mod', perms('OWN', 'project.read', 'project.member_manage', 'project.member_view'));
    const project = collab.tasks.projects.create(owner, b({ name: 'P', memberUserIds: [mod.user.id] }));
    collab.tasks.projects.updateMember(owner, project.id, mod.user.id, b({ memberRole: 'MODERATOR', version: 1 }));
    await expectAppError(() => collab.tasks.projects.removeMember(mod, project.id, owner.user.id), 'PROJECT_OWNER_REQUIRED', 409);
    await expectAppError(() => collab.tasks.projects.removeMember(owner, project.id, owner.user.id), 'PROJECT_OWNER_REQUIRED', 409);
    await expectAppError(() => collab.tasks.projects.updateMember(mod, project.id, owner.user.id, b({ memberRole: 'MEMBER', version: 1 })), 'PROJECT_OWNER_REQUIRED', 409);
    // Ownership only moves through a transfer, which keeps exactly one active owner.
    await expectAppError(() => collab.tasks.projects.transferOwnership(mod, project.id, b({ newOwnerUserId: mod.user.id })), 'PERMISSION_DENIED', 403);
    collab.tasks.projects.transferOwnership(owner, project.id, b({ newOwnerUserId: mod.user.id }));
    const owners = ctx.state.projectMembers.filter((row) => row.projectId === project.id && row.memberRole === 'OWNER' && row.status === 'ACTIVE');
    expect(owners.map((row) => row.userId)).toEqual([mod.user.id]);
    expect(collab.tasks.projects.get(mod, project.id)).toMatchObject({ ownerUserId: mod.user.id, myRole: 'OWNER' });
    // The former owner is now a removable moderator; the new owner is protected.
    collab.tasks.projects.removeMember(mod, project.id, owner.user.id);
    await expectAppError(() => collab.tasks.projects.removeMember(mod, project.id, mod.user.id), 'PROJECT_OWNER_REQUIRED', 409);
  });

  it('Membership source removal without over-revoking.', async () => {
    const { collab, owner, memberActor } = await collabApp();
    const communication = requireModule<{ chats: { effectiveMemberIds(chatId: string): string[]; addMember(actor: unknown, chatId: string, body: unknown): unknown } }>(collab, 'communication', 'Communication (Project Chat membership sources)');
    const alice = await memberActor('alice', perms('OWN', 'project.read', 'chat.read', 'chat.send'));
    const project = collab.tasks.projects.create(owner, b({ name: 'P', memberUserIds: [alice.user.id], tools: ['TASKS', 'CHAT'] }));
    const chatId = collab.tasks.projects.linkedResources(owner, project.id).CHAT.resourceId!;
    expect(communication.chats.effectiveMemberIds(chatId)).toContain(alice.user.id);
    // Alice is ALSO added to the chat directly; removing her Project membership must keep that direct source.
    communication.chats.addMember(owner, chatId, b({ userId: alice.user.id }));
    collab.tasks.projects.removeMember(owner, project.id, alice.user.id);
    expect(communication.chats.effectiveMemberIds(chatId)).toContain(alice.user.id);
  });

  it('External-user rejection.', async () => {
    const { collab, owner, foreignActor } = await collabApp();
    const external = await foreignActor('external');
    const project = collab.tasks.projects.create(owner, b({ name: 'P', visibility: 'OPEN' }));
    await expectAppError(() => collab.tasks.projects.addMember(owner, project.id, b({ userId: external.user.id })), 'PROJECT_EXTERNAL_MEMBER_NOT_ALLOWED', 400);
    await expectAppError(() => collab.tasks.projects.create(owner, b({ name: 'Q', memberUserIds: [external.user.id] })), 'PROJECT_EXTERNAL_MEMBER_NOT_ALLOWED', 400);
    await expectAppError(() => collab.tasks.projects.create(owner, b({ name: 'R', ownerUserId: external.user.id })), 'PROJECT_OWNER_INVALID', 400);
    await expectAppError(() => collab.tasks.projects.transferOwnership(owner, project.id, b({ newOwnerUserId: external.user.id })), 'PROJECT_OWNER_TRANSFER_INVALID', 400);
    // An OPEN Project of another Workspace is not even discoverable, let alone joinable.
    await expectAppError(() => collab.tasks.projects.addMember(external, project.id, b({ userId: external.user.id })), 'PROJECT_NOT_FOUND', 404);
  });
});
