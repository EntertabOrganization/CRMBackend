import { randomUUID } from 'node:crypto';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);

const READER = [['feed.read', 'WORKSPACE']] as Array<[string, 'WORKSPACE']>;
async function fixture(label = 'feed') {
  const owner = await register(label), prisma = await db(), bob = await member(owner, `${label}-bob`, READER), carol = await member(owner, `${label}-carol`, READER);
  const toBob = (body: Record<string, unknown> = {}) => call(owner, 'POST', 'feed/posts', { body: { body: 'Hello Bob', recipients: [{ recipientType: 'USER', recipientId: bob.userId }], ...body } });
  return { owner, bob, carol, prisma, toBob };
}

it('exposes and enforces representative routes: POST   /api/v1/feed/posts; GET    /api/v1/feed; GET    /api/v1/feed/posts/:id; PUT    /api/v1/feed/posts/:id', async () => {
  const x = await fixture();
  const results = await Promise.all([1, 2].map(() => x.toBob({ title: 'Kickoff' })));
  expect(new Set(results.map(result => expectOk(result).id)).size).toBe(2);
  const keyed = await Promise.all([1, 2].map(() => call(x.owner, 'POST', 'feed/posts', { body: { body: 'Once', recipients: [{ recipientType: 'WORKSPACE' }] }, headers: { 'idempotency-key': 'feed-once' } })));
  const post = expectOk(keyed[0]); expect(expectOk(keyed[1]).id).toBe(post.id);
  expect(expectOk(await call(x.carol, 'GET', 'feed')).map((row: { id: string }) => row.id)).toEqual([post.id]);
  expect(expectOk(await call(x.bob, 'GET', `feed/posts/${post.id}`)).recipients).toEqual([{ recipientType: 'WORKSPACE', recipientId: null }]);
  const put = expectOk(await call(x.owner, 'PUT', `feed/posts/${post.id}`, { body: { body: 'Once more', title: 'Update', recipients: [{ recipientType: 'WORKSPACE' }], version: post.version } }));
  expect(put).toMatchObject({ body: 'Once more', title: 'Update', editedAt: expect.any(String) });
  expectError(await call(x.owner, 'PATCH', `feed/posts/${post.id}`, { body: { recipients: [{ recipientType: 'USER', recipientId: x.bob.userId }], version: put.version } }), 409, 'FEED_AUDIENCE_NOT_ALLOWED');
  const draft = expectOk(await call(x.owner, 'POST', 'feed/posts', { body: { body: 'Draft', publish: false, recipients: [{ recipientType: 'USER', recipientId: x.bob.userId }] } }));
  const patched = expectOk(await call(x.owner, 'PATCH', `feed/posts/${draft.id}`, { body: { recipients: [{ recipientType: 'USER', recipientId: x.carol.userId }], version: draft.version } }));
  expectError(await call(x.bob, 'GET', `feed/posts/${draft.id}`), 404, 'FEED_POST_NOT_FOUND');
  expect(expectOk(await call(x.owner, 'POST', `feed/posts/${draft.id}/publish`, { body: {} })).status).toBe('PUBLISHED');
  expect(expectOk(await call(x.carol, 'GET', `feed/posts/${draft.id}`)).id).toBe(patched.id);
  const comment = expectOk(await call(x.bob, 'POST', `feed/posts/${post.id}/comments`, { body: { body: 'Thanks' } }));
  expect(expectOk(await call(x.owner, 'GET', `feed/posts/${post.id}/comments`))).toHaveLength(1);
  expectOk(await call(x.bob, 'PATCH', `feed/comments/${comment.id}`, { body: { body: 'Thanks!', version: 1 } }));
  expectOk(await call(x.bob, 'DELETE', `feed/comments/${comment.id}`, { body: {} }));
  expectOk(await call(x.bob, 'POST', `feed/posts/${post.id}/reactions`, { body: { reaction: '👏' } }));
  expectOk(await call(x.bob, 'DELETE', `feed/posts/${post.id}/reactions/${encodeURIComponent('👏')}`, { body: {} }));
  expectOk(await call(x.bob, 'POST', `feed/posts/${post.id}/favorite`, { body: {} }));
  expectOk(await call(x.bob, 'DELETE', `feed/posts/${post.id}/favorite`, { body: {} }));
  expect(expectOk(await call(x.owner, 'POST', `feed/posts/${post.id}/pin`, { body: {} })).isPinned).toBe(true);
  expect(expectOk(await call(x.owner, 'DELETE', `feed/posts/${post.id}/pin`, { body: {} })).isPinned).toBe(false);
  expect(expectOk(await call(x.bob, 'POST', `feed/posts/${post.id}/read`, { body: {} })).isRead).toBe(true);
  expect(expectOk(await call(x.owner, 'GET', `feed/posts/${post.id}/read-stats`))).toMatchObject({ audienceMode: 'DYNAMIC', readCount: 1 });
  const announcement = expectOk(await call(x.owner, 'POST', 'feed/posts', { body: { postType: 'ANNOUNCEMENT', body: 'Policy', requiresAcknowledgement: true, recipients: [{ recipientType: 'WORKSPACE' }] } }));
  expect(expectOk(await call(x.bob, 'POST', `feed/posts/${announcement.id}/acknowledge`, { body: {} })).isAcknowledged).toBe(true);
  const pollPost = expectOk(await call(x.owner, 'POST', 'feed/posts', { body: { postType: 'POLL', body: 'Vote', recipients: [{ recipientType: 'WORKSPACE' }] } }));
  const withPoll = expectOk(await call(x.owner, 'POST', `feed/posts/${pollPost.id}/polls`, { body: { question: 'Q?', options: ['A', 'B'], isAnonymous: true } }));
  expectOk(await call(x.owner, 'POST', `feed/posts/${pollPost.id}/publish`, { body: {} }));
  const optionId = withPoll.poll.options[0].id;
  const votes = await Promise.all([call(x.bob, 'POST', `polls/${withPoll.poll.id}/votes`, { body: { optionIds: [optionId] } }), call(x.bob, 'POST', `polls/${withPoll.poll.id}/votes`, { body: { optionIds: [optionId] } })]);
  expect(votes.map(result => result.status).sort()).toEqual([200, 409]);
  expect(await x.prisma.feedPollVote.count({ where: { pollId: withPoll.poll.id } })).toBe(1);
  expectOk(await call(x.bob, 'DELETE', `polls/${withPoll.poll.id}/votes/me`, { body: {} }));
  expectOk(await call(x.owner, 'DELETE', `feed/posts/${post.id}`, { body: {} }));
  expect(expectOk(await call(x.owner, 'PATCH', `feed/posts/${post.id}/restore`, { body: {} })).status).toBe('PUBLISHED');
  expectOk(await call(x.owner, 'DELETE', `feed/posts/${post.id}`, { body: {} }));
  expectOk(await call(x.owner, 'DELETE', `feed/posts/${post.id}/hard`, { body: { reason: 'cleanup' } }));
  expect(await x.prisma.feedPost.count({ where: { id: post.id } })).toBe(0);
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
  const x = await fixture('feed-auth'), id = MISSING_ID;
  for (const [method, path] of [['POST', 'feed/posts'], ['GET', 'feed'], ['GET', `feed/posts/${id}`], ['PUT', `feed/posts/${id}`], ['PATCH', `feed/posts/${id}`], ['DELETE', `feed/posts/${id}`],
    ['PATCH', `feed/posts/${id}/restore`], ['DELETE', `feed/posts/${id}/hard`], ['POST', `feed/posts/${id}/publish`], ['GET', `feed/posts/${id}/comments`], ['POST', `feed/posts/${id}/comments`],
    ['PATCH', `feed/comments/${id}`], ['DELETE', `feed/comments/${id}`], ['POST', `feed/posts/${id}/reactions`], ['DELETE', `feed/posts/${id}/reactions/x`], ['POST', `feed/posts/${id}/favorite`],
    ['DELETE', `feed/posts/${id}/favorite`], ['POST', `feed/posts/${id}/pin`], ['DELETE', `feed/posts/${id}/pin`], ['POST', `feed/posts/${id}/read`], ['POST', `feed/posts/${id}/acknowledge`],
    ['GET', `feed/posts/${id}/read-stats`], ['POST', `feed/posts/${id}/polls`], ['POST', `polls/${id}/votes`], ['DELETE', `polls/${id}/votes/me`]] as const)
    expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
  expectError(await call(x.bob, 'POST', 'feed/posts', { body: { body: 'x', recipients: [{ recipientType: 'WORKSPACE' }] } }), 403, 'PERMISSION_DENIED');
  const author = await member(x.owner, 'feed-author', [['feed.post', 'WORKSPACE'], ['feed.read', 'WORKSPACE']]);
  expectError(await call(author, 'POST', 'feed/posts', { body: { body: 'x', recipients: [{ recipientType: 'WORKSPACE' }] } }), 403, 'FEED_AUDIENCE_NOT_ALLOWED');
  expectError(await call(author, 'POST', 'feed/posts', { body: { postType: 'ANNOUNCEMENT', body: 'x', recipients: [{ recipientType: 'USER', recipientId: x.bob.userId }] } }), 403, 'PERMISSION_DENIED');
  const post = expectOk(await x.toBob());
  expectError(await call(x.carol, 'GET', `feed/posts/${post.id}`), 404, 'FEED_POST_NOT_FOUND');
  expectError(await call(x.bob, 'GET', `feed/posts/${post.id}/read-stats`), 403, 'PERMISSION_DENIED');
  expectError(await call(x.bob, 'DELETE', `feed/posts/${post.id}`, { body: {} }), 403, 'PERMISSION_DENIED');
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
  const x = await fixture('feed-tenant'), foreign = await register('feed-foreign'), post = expectOk(await x.toBob());
  expectError(await call(foreign, 'GET', `feed/posts/${post.id}`), 404, 'FEED_POST_NOT_FOUND');
  expectError(await call(foreign, 'POST', `feed/posts/${post.id}/comments`, { body: { body: 'x' } }), 404, 'FEED_POST_NOT_FOUND');
  expectError(await call(x.owner, 'POST', 'feed/posts', { body: { body: 'x', recipients: [{ recipientType: 'USER', recipientId: foreign.userId }] } }), 403, 'FEED_AUDIENCE_NOT_ALLOWED');
  expect(expectOk(await call(foreign, 'GET', 'feed'))).toHaveLength(0);
  // Independent SQL guards.
  await expect(x.prisma.feedPost.delete({ where: { id: post.id } })).rejects.toThrow(/FEED_HISTORY_IMMUTABLE/);
  await expect(x.prisma.feedPost.update({ where: { id: post.id }, data: { authorUserId: foreign.userId } })).rejects.toThrow(/FEED_HISTORY_IMMUTABLE/);
  await expect(x.prisma.feedPostRecipient.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, postId: post.id, recipientType: 'USER', recipientId: foreign.userId } })).rejects.toThrow(/FEED_AUDIENCE_NOT_ALLOWED/);
  await expect(x.prisma.feedPostRecipient.deleteMany({ where: { postId: post.id } })).rejects.toThrow(/FEED_HISTORY_IMMUTABLE/);
  await expect(x.prisma.feedAcknowledgement.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, postId: post.id, userId: x.bob.userId, acknowledgedAt: new Date() } })).rejects.toThrow(/FEED_ACK_NOT_REQUIRED/);
});

it('returns stable machine-readable error envelopes for invalid requests', async () => {
  const x = await fixture('feed-errors');
  expectError(await x.toBob({ postType: 'MEME' }), 400, 'VALIDATION_ERROR');
  expectError(await x.toBob({ recipients: [] }), 400, 'VALIDATION_ERROR');
  expectError(await x.toBob({ body: ' ' }), 400, 'VALIDATION_ERROR');
  expectError(await x.toBob({ requiresAcknowledgement: true }), 400, 'VALIDATION_ERROR');
  const post = expectOk(await x.toBob());
  expectError(await call(x.bob, 'POST', `feed/posts/${post.id}/acknowledge`, { body: {} }), 409, 'FEED_ACK_NOT_REQUIRED');
  expectError(await call(x.owner, 'PATCH', `feed/posts/${post.id}`, { body: { body: 'x', version: 99 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectError(await call(x.owner, 'DELETE', `feed/posts/${post.id}/hard`, { body: {} }), 409, 'FEED_POST_NOT_PUBLISHED');
  const draft = expectOk(await x.toBob({ publish: false }));
  expectError(await call(x.bob, 'POST', `feed/posts/${draft.id}/comments`, { body: { body: 'x' } }), 404, 'FEED_POST_NOT_FOUND');
  expectError(await call(x.owner, 'POST', `feed/posts/${draft.id}/comments`, { body: { body: 'x' } }), 409, 'FEED_POST_NOT_PUBLISHED');
  expectError(await call(x.owner, 'GET', 'feed', { query: { status: 'ARCHIVED' } }), 400, 'QUERY_INVALID');
  expectError(await call(x.owner, 'POST', `polls/${MISSING_ID}/votes`, { body: { optionIds: [MISSING_ID] } }), 404, 'POLL_NOT_FOUND');
});

it('persists critical state and outbox/audit consistently on successful mutation', async () => {
  const x = await fixture('feed-outbox');
  const announcement = expectOk(await call(x.owner, 'POST', 'feed/posts', { body: { postType: 'ANNOUNCEMENT', body: 'Policy', requiresAcknowledgement: true,
    recipients: [{ recipientType: 'USER', recipientId: x.bob.userId }], mentionUserIds: [x.bob.userId, x.carol.userId] } }));
  expect(await x.prisma.feedAudienceSnapshot.findMany({ where: { postId: announcement.id } })).toEqual([expect.objectContaining({ userId: x.bob.userId })]);
  expect(await x.prisma.feedPost.findUniqueOrThrow({ where: { id: announcement.id } })).toMatchObject({ status: 'PUBLISHED', mentionUserIds: [x.bob.userId] });
  for (const type of ['ANNOUNCEMENT_PUBLISHED', 'FEED_MENTIONED'])
    expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: type, entityId: announcement.id } })).toBe(1);
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'FEED.ANNOUNCEMENT_PUBLISHED', entityId: announcement.id } })).toBe(1);
  expectOk(await call(x.bob, 'POST', `feed/posts/${announcement.id}/acknowledge`, { body: {} }));
  expect(await x.prisma.feedAcknowledgement.count({ where: { postId: announcement.id, userId: x.bob.userId } })).toBe(1);
  expect(expectOk(await call(x.owner, 'GET', `feed/posts/${announcement.id}/read-stats`))).toMatchObject({ audienceSize: 1, acknowledgedCount: 1, pendingAcknowledgementUserIds: [] });
});
