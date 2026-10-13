import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

const ADMIN = perms('WORKSPACE', 'collab.create', 'collab.read', 'collab.update', 'collab.member_manage', 'collab.invite_external', 'collab.archive', 'chat.read');
async function fixture() {
  const c = await collabApp(), collabs = c.collab.communication.collabs;
  const alice = await c.memberActor('alice', ADMIN), guest = await c.foreignActor('guest');
  const space = collabs.create(alice, b({ name: 'Partner launch', description: 'With the agency' }));
  const invite = (email = guest.user.email, extra: Record<string, unknown> = {}) => collabs.invite(alice, space.id, b({ email, ...extra }));
  return { c, collabs, alice, guest, space, invite };
}

it('Expired/replayed invite.', async () => {
  const x = await fixture(), sent = x.invite();
  expect(sent).toMatchObject({ status: 'PENDING', role: 'GUEST', token: expect.any(String) });
  expect(x.c.state.collabInvitations[0]).not.toHaveProperty('token');
  expect(x.c.state.collabInvitations[0].tokenHash).not.toBe(sent.token);
  expect(x.c.state.collabInvitations[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  await expectAppError(() => x.invite(), 'COLLAB_INVITATION_INVALID', 409);
  // Resend rotates the secret: the old token is dead immediately.
  const resent = x.collabs.resend(x.alice, x.space.id, sent.id, b());
  await expectAppError(() => x.collabs.accept(x.guest.user, sent.token!, b()), 'COLLAB_INVITATION_INVALID', 404);
  const accepted = x.collabs.accept(x.guest.user, resent.token!, b());
  expect(accepted.member).toMatchObject({ memberType: 'EXTERNAL', role: 'GUEST', status: 'ACTIVE' });
  // A replay by the same person is idempotent; nobody else can reuse the token; membership is never duplicated.
  expect(x.collabs.accept(x.guest.user, resent.token!, b()).member.id).toBe(accepted.member.id);
  const other = await x.c.foreignActor('other');
  await expectAppError(() => x.collabs.accept(other.user, resent.token!, b()), 'COLLAB_INVITATION_INVALID', 409);
  expect(x.c.state.collabSpaceMembers.filter(row => row.collabId === x.space.id && row.userId === x.guest.user.id)).toHaveLength(1);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'COLLAB_INVITATION_ACCEPTED')).toHaveLength(1);
  // Expired and revoked invitations fail without creating membership.
  const late = x.invite(other.user.email);
  x.c.state.collabInvitations.find(row => row.id === late.id)!.expiresAt = new Date(Date.now() - 1000);
  await expectAppError(() => x.collabs.accept(other.user, late.token!, b()), 'COLLAB_INVITATION_EXPIRED', 410);
  const fresh = x.collabs.resend(x.alice, x.space.id, late.id, b({ expiresInDays: 2 }));
  x.collabs.revoke(x.alice, x.space.id, late.id, b());
  await expectAppError(() => x.collabs.accept(other.user, fresh.token!, b()), 'COLLAB_INVITATION_REVOKED', 410);
  await expectAppError(() => x.collabs.resend(x.alice, x.space.id, late.id, b()), 'COLLAB_INVITATION_REVOKED', 410);
  expect(x.c.state.collabSpaceMembers.some(row => row.userId === other.user.id)).toBe(false);
  await expectAppError(() => x.collabs.accept(other.user, 'not-a-token', b()), 'COLLAB_INVITATION_INVALID', 404);
  // Workspace policy shortens the default expiry.
  x.c.state.workspaces.find(row => row.id === x.c.owner.workspaceId)!.settings.collabInvitationExpiryDays = 1;
  const third = await x.c.foreignActor('third');
  const short = x.invite(third.user.email);
  expect(x.c.state.collabInvitations.find(row => row.id === short.id)!.expiresAt.getTime() - Date.now()).toBeLessThan(86_400_001);
});

it('Existing account acceptance.', async () => {
  const x = await fixture(), bob = await x.c.memberActor('bob', perms('WORKSPACE', 'collab.read', 'chat.read'));
  const sent = x.invite(bob.user.email.toUpperCase(), { role: 'MEMBER' });
  await expectAppError(() => x.collabs.accept(x.guest.user, sent.token!, b()), 'COLLAB_INVITATION_INVALID', 403);
  const before = x.c.state.users.length;
  const accepted = x.collabs.accept(bob.user, sent.token!, b());
  // An existing internal identity joins as an internal member; no identity is created or duplicated.
  expect(accepted.member).toMatchObject({ userId: bob.user.id, memberType: 'INTERNAL', role: 'MEMBER' });
  expect(x.c.state.users).toHaveLength(before);
  expect(x.collabs.get(bob, x.space.id).myRole).toBe('MEMBER');
  expect(x.c.collab.communication.chats.get(bob, x.space.chatId!).linkedEntityType).toBe('COLLAB');
  // External people cannot be added directly.
  await expectAppError(() => x.collabs.addMember(x.alice, x.space.id, b({ userId: x.guest.user.id })), 'COLLAB_EXTERNAL_SCOPE_DENIED', 400);
});

it('Guest attempts non-Collab Workspace access.', async () => {
  const x = await fixture(), sent = x.invite();
  x.collabs.accept(x.guest.user, sent.token!, b());
  const ws = x.c.owner.workspaceId;
  expect(x.collabs.guestRead(ws, x.guest.user.id, x.space.id, 'collab', new URLSearchParams())).toMatchObject({ id: x.space.id, myRole: 'GUEST' });
  expect(x.collabs.guestRead(ws, x.guest.user.id, x.space.id, 'resources', new URLSearchParams())).toMatchObject({ chat: { id: x.space.chatId } });
  expect(x.c.collab.communication.chats.guestRead(ws, x.guest.user.id, x.space.chatId!)).toMatchObject({ type: 'COLLAB' });
  // Other Collabs, ordinary Chats and Channels stay invisible.
  const otherSpace = x.collabs.create(x.alice, b({ name: 'Internal only' }));
  await expectAppError(() => x.collabs.guestRead(ws, x.guest.user.id, otherSpace.id, 'collab', new URLSearchParams()), 'COLLAB_NOT_FOUND', 404);
  const group = x.c.collab.communication.chats.createGroup(x.c.owner, b({ title: 'Staff' }));
  await expectAppError(() => x.c.collab.communication.chats.guestRead(ws, x.guest.user.id, group.id), 'CHAT_NOT_FOUND', 404);
  expect(x.c.app.access.isActiveMember(ws, x.guest.user.id)).toBe(false);
  // Removing the guest revokes Collab and Collab Chat access live.
  x.collabs.removeMember(x.alice, x.space.id, x.guest.user.id, b());
  await expectAppError(() => x.collabs.guestRead(ws, x.guest.user.id, x.space.id, 'collab', new URLSearchParams()), 'COLLAB_NOT_FOUND', 404);
  await expectAppError(() => x.c.collab.communication.chats.guestRead(ws, x.guest.user.id, x.space.chatId!), 'CHAT_NOT_FOUND', 404);
});

it('manages metadata, internal members, archive/restore and authority', async () => {
  const x = await fixture(), bob = await x.c.memberActor('bob', perms('WORKSPACE', 'collab.read', 'collab.member_manage', 'chat.read'));
  await expectAppError(() => x.collabs.get(bob, x.space.id), 'COLLAB_NOT_FOUND', 404);
  x.collabs.addMember(x.alice, x.space.id, b({ userId: bob.user.id }));
  expect(x.collabs.list(bob, new URLSearchParams()).data.map(row => row.id)).toEqual([x.space.id]);
  await expectAppError(() => x.collabs.addMember(bob, x.space.id, b({ userId: x.c.owner.user.id })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.collabs.invite(bob, x.space.id, b({ email: 'x@example.com' })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.collabs.removeMember(x.alice, x.space.id, x.alice.user.id, b()), 'COLLAB_OWNER_REQUIRED', 409);
  const renamed = x.collabs.update(x.alice, x.space.id, b({ name: 'Agency launch', version: x.space.version }), undefined, false);
  expect(renamed.name).toBe('Agency launch');
  expect(x.c.state.chats.find(row => row.id === x.space.chatId)?.title).toBe('Agency launch');
  await expectAppError(() => x.collabs.update(x.alice, x.space.id, b({ name: 'Stale', version: 1 }), undefined, false), 'RESOURCE_VERSION_CONFLICT', 409);
  x.collabs.setArchived(x.alice, x.space.id, b(), true);
  expect(x.c.collab.communication.chats.get(bob, x.space.chatId!).isReadOnly).toBe(true);
  await expectAppError(() => x.collabs.invite(x.alice, x.space.id, b({ email: 'late@example.com' })), 'COLLAB_ARCHIVED', 409);
  x.collabs.setArchived(x.alice, x.space.id, b(), false);
  expect(x.collabs.removeMember(bob, x.space.id, bob.user.id, b())).toMatchObject({ removed: true });
  await expectAppError(() => x.collabs.get(bob, x.space.id), 'COLLAB_NOT_FOUND', 404);
  const foreign = await x.c.foreignActor('tenant');
  await expectAppError(() => x.collabs.get(foreign, x.space.id), 'COLLAB_NOT_FOUND', 404);
  expect(x.c.state.auditLogs.filter(row => row.action.startsWith('COLLAB.')).length).toBeGreaterThanOrEqual(5);
});
