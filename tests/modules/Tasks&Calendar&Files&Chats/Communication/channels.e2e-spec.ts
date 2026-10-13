import { randomUUID } from 'node:crypto';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);

const SUBSCRIBER = ['channel.read', 'channel.comment', 'channel.publish'].map(key => [key, 'WORKSPACE'] as [string, 'WORKSPACE']);
async function fixture(label = 'channels') {
  const owner = await register(label), prisma = await db(), bob = await member(owner, `${label}-bob`, SUBSCRIBER);
  const channel = expectOk(await call(owner, 'POST', 'channels', { body: { name: 'Announcements', description: 'News' } }));
  return { owner, bob, prisma, channel };
}

it('exposes and enforces representative routes: POST   /api/v1/channels; GET    /api/v1/channels; GET    /api/v1/channels/:id; PUT    /api/v1/channels/:id', async () => {
  const x = await fixture();
  expect(expectOk(await call(x.bob, 'GET', 'channels')).map((row: { id: string }) => row.id)).toContain(x.channel.id);
  const put = expectOk(await call(x.owner, 'PUT', `channels/${x.channel.id}`, { body: { name: 'Company news', visibility: 'PUBLIC', commentPolicy: 'MEMBERS', version: x.channel.version } }));
  expect(put).toMatchObject({ name: 'Company news', description: null });
  const patched = expectOk(await call(x.owner, 'PATCH', `channels/${x.channel.id}`, { body: { description: 'All hands', version: put.version } }));
  expect(expectOk(await call(x.bob, 'POST', `channels/${x.channel.id}/subscribe`, { body: {} }))).toMatchObject({ myRole: 'SUBSCRIBER' });
  expectError(await call(x.bob, 'POST', `channels/${x.channel.id}/posts`, { body: { body: 'Nope' } }), 403, 'CHANNEL_PUBLISH_DENIED');
  expect(expectOk(await call(x.owner, 'PATCH', `channels/${x.channel.id}/members/${x.bob.userId}`, { body: { role: 'PUBLISHER' } }))).toMatchObject({ role: 'PUBLISHER' });
  expect(expectOk(await call(x.owner, 'GET', `channels/${x.channel.id}/members`)).map((row: { userId: string }) => row.userId).sort()).toEqual([x.owner.userId, x.bob.userId].sort());
  const posts = await Promise.all([1, 2].map(() => call(x.bob, 'POST', `channels/${x.channel.id}/posts`, { body: { title: 'Q3', body: 'Results' }, headers: { 'idempotency-key': 'q3-post' } })));
  const post = expectOk(posts[0]); expect(expectOk(posts[1]).id).toBe(post.id);
  expect(await x.prisma.channelPost.count({ where: { channelId: x.channel.id } })).toBe(1);
  expect(expectOk(await call(x.owner, 'GET', `channels/${x.channel.id}/posts`))).toHaveLength(1);
  expect(expectOk(await call(x.owner, 'GET', `channel-posts/${post.id}`))).toMatchObject({ title: 'Q3', commentCount: 0 });
  const edited = expectOk(await call(x.bob, 'PATCH', `channel-posts/${post.id}`, { body: { body: 'Final results', version: 1 } }));
  const comment = expectOk(await call(x.owner, 'POST', `channel-posts/${post.id}/comments`, { body: { body: 'Well done' } }));
  expect(expectOk(await call(x.bob, 'GET', `channel-posts/${post.id}/comments`))).toHaveLength(1);
  expectOk(await call(x.owner, 'PATCH', `channel-comments/${comment.id}`, { body: { body: 'Well done all', version: 1 } }));
  expectOk(await call(x.owner, 'DELETE', `channel-comments/${comment.id}`, { body: {} }));
  expect(expectOk(await call(x.bob, 'DELETE', `channel-posts/${post.id}`, { body: { version: edited.version } })).status).toBe('DELETED');
  expect(expectOk(await call(x.bob, 'POST', `channels/${x.channel.id}/unsubscribe`, { body: {} }))).toMatchObject({ subscribed: false });
  expectOk(await call(x.owner, 'POST', `channels/${x.channel.id}/members`, { body: { userId: x.bob.userId } }));
  expect(expectOk(await call(x.owner, 'DELETE', `channels/${x.channel.id}/members/${x.bob.userId}`, { body: {} }))).toMatchObject({ removed: true });
  const archived = expectOk(await call(x.owner, 'POST', `channels/${x.channel.id}/archive`, { body: {} }));
  expect(archived.status).toBe('ARCHIVED');
  expectError(await call(x.owner, 'POST', `channels/${x.channel.id}/posts`, { body: { body: 'Late' } }), 409, 'CHANNEL_ARCHIVED');
  expectOk(await call(x.owner, 'DELETE', `channels/${x.channel.id}`, { body: { version: archived.version } }));
  expectError(await call(x.owner, 'GET', `channels/${x.channel.id}`), 404, 'CHANNEL_NOT_FOUND');
  expect(patched.description).toBe('All hands');
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
  const x = await fixture('channels-auth'), id = x.channel.id;
  for (const [method, path] of [['POST', 'channels'], ['GET', 'channels'], ['GET', `channels/${id}`], ['PUT', `channels/${id}`], ['PATCH', `channels/${id}`], ['DELETE', `channels/${id}`],
    ['POST', `channels/${id}/archive`], ['GET', `channels/${id}/members`], ['POST', `channels/${id}/members`], ['PATCH', `channels/${id}/members/${MISSING_ID}`],
    ['DELETE', `channels/${id}/members/${MISSING_ID}`], ['POST', `channels/${id}/subscribe`], ['POST', `channels/${id}/unsubscribe`], ['GET', `channels/${id}/posts`],
    ['POST', `channels/${id}/posts`], ['GET', `channel-posts/${MISSING_ID}`], ['PATCH', `channel-posts/${MISSING_ID}`], ['DELETE', `channel-posts/${MISSING_ID}`],
    ['GET', `channel-posts/${MISSING_ID}/comments`], ['POST', `channel-posts/${MISSING_ID}/comments`], ['PATCH', `channel-comments/${MISSING_ID}`], ['DELETE', `channel-comments/${MISSING_ID}`]] as const)
    expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
  expectError(await call(x.bob, 'POST', 'channels', { body: { name: 'Mine' } }), 403, 'PERMISSION_DENIED');
  expectError(await call(x.bob, 'PATCH', `channels/${id}`, { body: { name: 'x', version: 1 } }), 403, 'PERMISSION_DENIED');
  expectError(await call(x.bob, 'POST', `channels/${id}/members`, { body: { userId: x.bob.userId } }), 403, 'PERMISSION_DENIED');
  const secret = expectOk(await call(x.owner, 'POST', 'channels', { body: { name: 'Private', visibility: 'PRIVATE' } }));
  expectError(await call(x.bob, 'GET', `channels/${secret.id}`), 404, 'CHANNEL_NOT_FOUND');
  expectError(await call(x.bob, 'POST', `channels/${secret.id}/subscribe`, { body: {} }), 404, 'CHANNEL_NOT_FOUND');
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
  const x = await fixture('channels-tenant'), foreign = await register('channels-foreign');
  const post = expectOk(await call(x.owner, 'POST', `channels/${x.channel.id}/posts`, { body: { body: 'Internal' } }));
  expectError(await call(foreign, 'GET', `channels/${x.channel.id}`), 404, 'CHANNEL_NOT_FOUND');
  expectError(await call(foreign, 'POST', `channels/${x.channel.id}/subscribe`, { body: {} }), 404, 'CHANNEL_NOT_FOUND');
  expectError(await call(foreign, 'GET', `channel-posts/${post.id}`), 404, 'CHANNEL_POST_NOT_FOUND');
  expectError(await call(x.owner, 'POST', `channels/${x.channel.id}/members`, { body: { userId: foreign.userId } }), 400, 'CHANNEL_MEMBER_INVALID');
  // Independent SQL guards.
  await expect(x.prisma.channelMembershipSource.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, channelId: x.channel.id, userId: foreign.userId, sourceType: 'MANUAL',
    sourceId: x.channel.id, role: 'SUBSCRIBER', active: true, createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow(/CHANNEL_MEMBER_INVALID/);
  await expect(x.prisma.channelPost.update({ where: { id: post.id }, data: { channelId: MISSING_ID } })).rejects.toThrow();
  await expect(x.prisma.channelPost.delete({ where: { id: post.id } })).rejects.toThrow(/CHANNEL_HISTORY_IMMUTABLE/);
  await expect(x.prisma.channel.update({ where: { id: x.channel.id }, data: { ownerUserId: foreign.userId, version: 99 } })).rejects.toThrow();
  await expect(x.prisma.channelMember.updateMany({ where: { channelId: x.channel.id, userId: x.owner.userId }, data: { role: 'ADMIN' } })).rejects.toThrow(/CHANNEL_OWNER_REQUIRED/);
});

it('returns stable machine-readable error envelopes for invalid requests', async () => {
  const x = await fixture('channels-errors');
  expectError(await call(x.owner, 'POST', 'channels', { body: { name: '' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', 'channels', { body: { name: 'x', visibility: 'SECRET' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'PATCH', `channels/${x.channel.id}`, { body: { name: 'x', version: 42 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectError(await call(x.owner, 'DELETE', `channels/${x.channel.id}/members/${x.owner.userId}`, { body: {} }), 409, 'CHANNEL_OWNER_REQUIRED');
  expectError(await call(x.owner, 'POST', `channels/${x.channel.id}/unsubscribe`, { body: {} }), 409, 'CHANNEL_OWNER_REQUIRED');
  expectError(await call(x.owner, 'PATCH', `channels/${x.channel.id}/members/${x.bob.userId}`, { body: { role: 'PUBLISHER' } }), 404, 'CHANNEL_MEMBER_INVALID');
  expectError(await call(x.owner, 'POST', `channels/${x.channel.id}/posts`, { body: { body: '   ' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'GET', `channel-posts/${MISSING_ID}`), 404, 'CHANNEL_POST_NOT_FOUND');
  expectError(await call(x.owner, 'PATCH', `channel-comments/${MISSING_ID}`, { body: { body: 'x', version: 1 } }), 404, 'CHANNEL_COMMENT_NOT_FOUND');
});

it('persists critical state and outbox/audit consistently on successful mutation', async () => {
  const x = await fixture('channels-outbox');
  expect(await x.prisma.channelMember.findFirstOrThrow({ where: { channelId: x.channel.id, userId: x.owner.userId } })).toMatchObject({ role: 'OWNER', leftAt: null });
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'CHANNEL_CREATED', entityId: x.channel.id } })).toBe(1);
  expectOk(await call(x.owner, 'POST', `channels/${x.channel.id}/members`, { body: { userId: x.bob.userId, role: 'PUBLISHER' } }));
  expectOk(await call(x.owner, 'PATCH', `channels/${x.channel.id}/members/${x.bob.userId}`, { body: { role: 'OWNER' } }));
  expect(await x.prisma.channel.findUniqueOrThrow({ where: { id: x.channel.id } })).toMatchObject({ ownerUserId: x.bob.userId });
  expect((await x.prisma.channelMember.findMany({ where: { channelId: x.channel.id, leftAt: null } })).map(row => [row.userId, row.role]).sort())
    .toEqual([[x.owner.userId, 'ADMIN'], [x.bob.userId, 'OWNER']].sort());
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'CHANNEL.OWNER_TRANSFERRED', entityId: x.channel.id } })).toBe(1);
  const post = expectOk(await call(x.bob, 'POST', `channels/${x.channel.id}/posts`, { body: { body: 'Owner post' } }));
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'CHANNEL_POST_PUBLISHED', entityId: post.id } })).toBe(1);
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'CHANNEL_MEMBER_CHANGED' } })).toBeGreaterThanOrEqual(3);
});
