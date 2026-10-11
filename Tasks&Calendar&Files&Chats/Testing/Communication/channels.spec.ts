import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

const READER = perms('WORKSPACE', 'channel.read', 'channel.comment');
const MANAGER = perms('WORKSPACE', 'project.read', 'channel.create', 'channel.read', 'channel.update', 'channel.member_manage', 'channel.publish', 'channel.comment', 'channel.moderate');
async function fixture() {
  const c = await collabApp(), channels = c.collab.communication.channels;
  const alice = await c.memberActor('alice', MANAGER), bob = await c.memberActor('bob', [...READER, ...perms('WORKSPACE', 'channel.publish')]);
  const announcements = channels.create(alice, b({ name: 'Announcements', description: 'Company news' }));
  const secret = channels.create(alice, b({ name: 'Leadership', visibility: 'PRIVATE' }));
  return { c, channels, alice, bob, announcements, secret };
}

it('Public discovery vs private.', async () => {
  const x = await fixture();
  expect(x.channels.list(x.bob, new URLSearchParams()).data.map(row => row.name)).toEqual(['Announcements']);
  await expectAppError(() => x.channels.get(x.bob, x.secret.id), 'CHANNEL_NOT_FOUND', 404);
  await expectAppError(() => x.channels.subscribe(x.bob, x.secret.id, b()), 'CHANNEL_NOT_FOUND', 404);
  await expectAppError(() => x.channels.posts(x.bob, x.secret.id, new URLSearchParams()), 'CHANNEL_NOT_FOUND', 404);
  // A PUBLIC Channel is readable before subscribing; discussion requires membership.
  const post = x.channels.publish(x.alice, x.announcements.id, b({ title: 'Launch', body: 'We ship Friday' }));
  expect(x.channels.posts(x.bob, x.announcements.id, new URLSearchParams()).data.map(row => row.id)).toEqual([post.id]);
  await expectAppError(() => x.channels.comment(x.bob, post.id, b({ body: 'Great' })), 'CHANNEL_COMMENT_DENIED', 403);
  expect(x.channels.subscribe(x.bob, x.announcements.id, b())).toMatchObject({ myRole: 'SUBSCRIBER', memberCount: 2 });
  expect(x.channels.comment(x.bob, post.id, b({ body: 'Great' })).status).toBe('ACTIVE');
  // Invited members see private Channels; external identities never qualify, and a foreign Workspace sees nothing.
  x.channels.addMember(x.alice, x.secret.id, b({ userId: x.bob.user.id }));
  expect(x.channels.get(x.bob, x.secret.id).myRole).toBe('SUBSCRIBER');
  const foreign = await x.c.foreignActor();
  await expectAppError(() => x.channels.get(foreign, x.announcements.id), 'CHANNEL_NOT_FOUND', 404);
  await expectAppError(() => x.channels.addMember(x.alice, x.announcements.id, b({ userId: foreign.user.id })), 'CHANNEL_MEMBER_INVALID', 400);
  await expectAppError(() => x.channels.getPost(foreign, post.id), 'CHANNEL_POST_NOT_FOUND', 404);
  const outsider = await x.c.memberActor('outsider', perms('WORKSPACE', 'channel.read'));
  await expectAppError(() => x.channels.members(outsider, x.announcements.id, new URLSearchParams()), 'CHANNEL_PRIVATE', 403);
});

it('Owner removal.', async () => {
  const x = await fixture();
  x.channels.addMember(x.alice, x.announcements.id, b({ userId: x.bob.user.id, role: 'ADMIN' }));
  await expectAppError(() => x.channels.removeMember(x.alice, x.announcements.id, x.alice.user.id, b()), 'CHANNEL_OWNER_REQUIRED', 409);
  await expectAppError(() => x.channels.unsubscribe(x.alice, x.announcements.id, b()), 'CHANNEL_OWNER_REQUIRED', 409);
  await expectAppError(() => x.channels.updateMember(x.alice, x.announcements.id, x.alice.user.id, b({ role: 'ADMIN' })), 'CHANNEL_OWNER_REQUIRED', 409);
  // Only the owner transfers ownership; the previous owner stays as an administrator.
  const carol = await x.c.memberActor('carol', MANAGER);
  x.channels.addMember(x.alice, x.announcements.id, b({ userId: carol.user.id, role: 'ADMIN' }));
  await expectAppError(() => x.channels.updateMember(carol, x.announcements.id, carol.user.id, b({ role: 'OWNER' })), 'PERMISSION_DENIED', 403);
  x.channels.updateMember(x.alice, x.announcements.id, carol.user.id, b({ role: 'OWNER' }));
  expect(x.channels.get(carol, x.announcements.id).myRole).toBe('OWNER');
  expect(x.channels.get(x.alice, x.announcements.id)).toMatchObject({ myRole: 'ADMIN', ownerUserId: carol.user.id });
  expect(x.c.state.channelMembers.filter(row => row.channelId === x.announcements.id && row.role === 'OWNER' && !row.leftAt).map(row => row.userId)).toEqual([carol.user.id]);
  expect(x.channels.removeMember(carol, x.announcements.id, x.alice.user.id, b())).toMatchObject({ removed: true });
  await expectAppError(() => x.channels.removeMember(carol, x.announcements.id, carol.user.id, b()), 'CHANNEL_OWNER_REQUIRED', 409);
  expect(x.c.state.auditLogs.filter(row => row.action === 'CHANNEL.OWNER_TRANSFERRED')).toHaveLength(1);
  // Administrators cannot remove other administrators or grant the ADMIN role.
  x.channels.addMember(carol, x.announcements.id, b({ userId: x.alice.user.id, role: 'ADMIN' }));
  await expectAppError(() => x.channels.addMember(x.alice, x.announcements.id, b({ userId: x.bob.user.id, role: 'ADMIN' })), 'PERMISSION_DENIED', 403);
  const dave = await x.c.memberActor('dave', MANAGER);
  x.channels.addMember(carol, x.announcements.id, b({ userId: dave.user.id, role: 'ADMIN' }));
  await expectAppError(() => x.channels.removeMember(x.alice, x.announcements.id, dave.user.id, b()), 'PERMISSION_DENIED', 403);
  x.channels.delete(carol, x.announcements.id, b({ version: x.c.state.channels.find(row => row.id === x.announcements.id)!.version }));
  await expectAppError(() => x.channels.get(carol, x.announcements.id), 'CHANNEL_NOT_FOUND', 404);
});

it('Publisher vs subscriber.', async () => {
  const x = await fixture();
  x.channels.subscribe(x.bob, x.announcements.id, b());
  await expectAppError(() => x.channels.publish(x.bob, x.announcements.id, b({ body: 'Spam' })), 'CHANNEL_PUBLISH_DENIED', 403);
  await expectAppError(() => x.channels.updateMember(x.bob, x.announcements.id, x.bob.user.id, b({ role: 'PUBLISHER' })), 'PERMISSION_DENIED', 403);
  x.channels.updateMember(x.alice, x.announcements.id, x.bob.user.id, b({ role: 'PUBLISHER' }));
  const post = x.channels.publish(x.bob, x.announcements.id, b({ body: 'Release notes' }), 'publish-1');
  expect(x.channels.publish(x.bob, x.announcements.id, b({ body: 'Release notes' }), 'publish-1').id).toBe(post.id);
  expect(x.channels.editPost(x.bob, post.id, b({ body: 'Release notes v2', version: 1 })).body).toBe('Release notes v2');
  await expectAppError(() => x.channels.editPost(x.alice, post.id, b({ body: 'Not mine', version: 2 })), 'PERMISSION_DENIED', 403);
  // Demotion takes effect immediately: the former publisher can no longer publish or edit.
  x.channels.updateMember(x.alice, x.announcements.id, x.bob.user.id, b({ role: 'SUBSCRIBER' }));
  await expectAppError(() => x.channels.publish(x.bob, x.announcements.id, b({ body: 'Again' })), 'CHANNEL_PUBLISH_DENIED', 403);
  await expectAppError(() => x.channels.editPost(x.bob, post.id, b({ body: 'v3', version: 2 })), 'CHANNEL_PUBLISH_DENIED', 403);
  // Comment policy and moderation.
  const comment = x.channels.comment(x.bob, post.id, b({ body: 'Thanks' }));
  x.channels.update(x.alice, x.announcements.id, b({ commentPolicy: 'PUBLISHERS', version: x.c.state.channels.find(row => row.id === x.announcements.id)!.version }), undefined, false);
  await expectAppError(() => x.channels.comment(x.bob, post.id, b({ body: 'Blocked' })), 'CHANNEL_COMMENT_DENIED', 403);
  expect(x.channels.editComment(x.bob, comment.id, b({ body: 'Thanks!', version: 1 })).body).toBe('Thanks!');
  const moderated = x.channels.deleteComment(x.alice, comment.id, b({ reason: 'Off-topic' }));
  expect(moderated).toMatchObject({ status: 'DELETED', body: null });
  expect(x.channels.deletePost(x.alice, post.id, b({})).status).toBe('DELETED');
  expect(x.c.state.auditLogs.filter(row => row.action === 'CHANNEL.COMMENT_MODERATED' || row.action === 'CHANNEL.POST_MODERATED')).toHaveLength(2);
  // Archive makes the Channel read-only.
  x.channels.archive(x.alice, x.announcements.id, b());
  await expectAppError(() => x.channels.publish(x.alice, x.announcements.id, b({ body: 'After archive' })), 'CHANNEL_ARCHIVED', 409);
  expect(x.channels.posts(x.bob, x.announcements.id, new URLSearchParams()).data).toHaveLength(1);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CHANNEL_POST_PUBLISHED')).toHaveLength(1);
});

it('Multi-source membership.', async () => {
  const x = await fixture();
  const department = x.c.app.departments.create(x.c.owner.user, x.c.owner.workspaceId, { name: 'Engineering' });
  x.c.app.departments.addMembers(x.c.owner.user, x.c.owner.workspaceId, department.id, [x.bob.user.id]);
  x.channels.addMember(x.alice, x.secret.id, b({ sourceType: 'DEPARTMENT', sourceId: department.id, role: 'PUBLISHER' }));
  x.channels.addMember(x.alice, x.secret.id, b({ userId: x.bob.user.id }));
  expect(x.channels.get(x.bob, x.secret.id).myRole).toBe('SUBSCRIBER');
  // Removing the direct grant keeps access through the Department.
  expect(x.channels.removeMember(x.alice, x.secret.id, x.bob.user.id, b())).toMatchObject({ removed: false, remainingSources: [{ sourceType: 'DEPARTMENT', sourceId: department.id }] });
  expect(x.channels.get(x.bob, x.secret.id).myRole).toBe('SUBSCRIBER');
  // Leaving the Department (owning module) revokes the last source live.
  x.c.app.departments.removeMember(x.c.owner.user, x.c.owner.workspaceId, department.id, x.bob.user.id);
  await expectAppError(() => x.channels.get(x.bob, x.secret.id), 'CHANNEL_NOT_FOUND', 404);
  // A new Department member joins automatically with the link role.
  const carol = await x.c.memberActor('carol', READER);
  x.c.app.departments.addMembers(x.c.owner.user, x.c.owner.workspaceId, department.id, [carol.user.id]);
  expect(x.channels.get(carol, x.secret.id).myRole).toBe('PUBLISHER');
  x.channels.addMember(x.alice, x.secret.id, b({ sourceType: 'DEPARTMENT', sourceId: department.id, active: false }));
  await expectAppError(() => x.channels.get(carol, x.secret.id), 'CHANNEL_NOT_FOUND', 404);
  // Project-linked membership follows the Project roster.
  const project = x.c.collab.tasks.projects.create(x.c.owner, b({ name: 'Sourced', tools: ['TASKS'], memberUserIds: [x.bob.user.id, x.alice.user.id] }));
  x.channels.addMember(x.alice, x.secret.id, b({ sourceType: 'PROJECT', sourceId: project.id }));
  expect(x.channels.get(x.bob, x.secret.id).myRole).toBe('SUBSCRIBER');
  x.c.collab.tasks.projects.removeMember(x.c.owner, project.id, x.bob.user.id);
  await expectAppError(() => x.channels.get(x.bob, x.secret.id), 'CHANNEL_NOT_FOUND', 404);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CHANNEL_MEMBER_CHANGED').length).toBeGreaterThan(4);
});
