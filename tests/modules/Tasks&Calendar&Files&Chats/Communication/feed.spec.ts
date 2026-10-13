import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

const AUTHOR = perms('WORKSPACE', 'feed.post', 'feed.read', 'feed.update_own', 'feed.delete_own', 'feed.announcement', 'feed.poll');
const READER = perms('WORKSPACE', 'feed.read');
async function fixture() {
  const c = await collabApp(), feed = c.collab.communication.feed, departments = c.app.departments;
  const alice = await c.memberActor('alice', AUTHOR), bob = await c.memberActor('bob', READER), carol = await c.memberActor('carol', READER);
  const engineering = departments.create(c.owner.user, c.owner.workspaceId, { name: 'Engineering' });
  departments.addMembers(c.owner.user, c.owner.workspaceId, engineering.id, [alice.user.id, bob.user.id]);
  const toDepartment = (extra: Record<string, unknown> = {}) => feed.create(alice, b({ body: 'Sprint review on Friday', recipients: [{ recipientType: 'DEPARTMENT', recipientId: engineering.id }], ...extra }));
  return { c, feed, departments, alice, bob, carol, engineering, toDepartment };
}

it('Dynamic vs snapshot audience.', async () => {
  const x = await fixture();
  const normal = x.toDepartment();
  const announcement = x.toDepartment({ postType: 'ANNOUNCEMENT', title: 'Security policy', requiresAcknowledgement: true });
  await expectAppError(() => x.feed.get(x.carol, normal.id), 'FEED_POST_NOT_FOUND', 404);
  expect(x.feed.readStats(x.alice, announcement.id)).toMatchObject({ audienceMode: 'SNAPSHOT', audienceSize: 1, acknowledgedCount: 0, pendingAcknowledgementUserIds: [x.bob.user.id] });
  // Joining the Department later reveals the normal post dynamically, but the announcement denominator stays stable.
  x.departments.addMembers(x.c.owner.user, x.c.owner.workspaceId, x.engineering.id, [x.carol.user.id]);
  expect(x.feed.get(x.carol, normal.id).id).toBe(normal.id);
  expect(x.feed.list(x.carol, new URLSearchParams()).data.map(row => row.id).sort()).toEqual([normal.id, announcement.id].sort());
  await expectAppError(() => x.feed.acknowledge(x.carol, announcement.id, b()), 'FEED_ACK_NOT_REQUIRED', 409);
  x.feed.acknowledge(x.bob, announcement.id, b()); x.feed.acknowledge(x.bob, announcement.id, b());
  expect(x.feed.readStats(x.alice, announcement.id)).toMatchObject({ audienceSize: 1, acknowledgedCount: 1, readCount: 1, pendingAcknowledgementUserIds: [] });
  expect(x.feed.readStats(x.alice, normal.id)).toMatchObject({ audienceMode: 'DYNAMIC', audienceSize: 2 });
  // Leaving the Department removes dynamic access; snapshot members keep the announcement.
  x.departments.removeMember(x.c.owner.user, x.c.owner.workspaceId, x.engineering.id, x.bob.user.id);
  await expectAppError(() => x.feed.get(x.bob, normal.id), 'FEED_POST_NOT_FOUND', 404);
  expect(x.feed.get(x.bob, announcement.id).isAcknowledged).toBe(true);
  await expectAppError(() => x.feed.readStats(x.bob, announcement.id), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.feed.update(x.alice, announcement.id, b({ recipients: [{ recipientType: 'USER', recipientId: x.carol.user.id }], version: announcement.version }), undefined, false), 'FEED_AUDIENCE_NOT_ALLOWED', 409);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'ANNOUNCEMENT_ACKNOWLEDGED')).toHaveLength(1);
});

it('Mention unauthorized user.', async () => {
  const x = await fixture();
  const post = x.toDepartment({ mentionUserIds: [x.bob.user.id, x.carol.user.id] });
  // Carol cannot see the post, so she is neither stored as a mention nor notified.
  expect(post.mentionUserIds).toEqual([x.bob.user.id]);
  const mentioned = x.c.state.outboxEvents.filter(row => row.eventType === 'FEED_MENTIONED');
  expect(mentioned).toHaveLength(1);
  expect((mentioned[0].payload as { mentionUserIds: string[] }).mentionUserIds).toEqual([x.bob.user.id]);
  await expectAppError(() => x.feed.get(x.carol, post.id), 'FEED_POST_NOT_FOUND', 404);
  // Drafts are private to the author and mentions are re-filtered at publication.
  const draft = x.toDepartment({ publish: false, mentionUserIds: [x.carol.user.id] });
  await expectAppError(() => x.feed.get(x.bob, draft.id), 'FEED_POST_NOT_FOUND', 404);
  expect(x.feed.publish(x.alice, draft.id, b()).mentionUserIds).toEqual([]);
  const foreign = await x.c.foreignActor();
  await expectAppError(() => x.feed.create(x.alice, b({ body: 'x', recipients: [{ recipientType: 'USER', recipientId: foreign.user.id }] })), 'FEED_AUDIENCE_NOT_ALLOWED', 403);
  await expectAppError(() => x.feed.get(foreign, post.id), 'FEED_POST_NOT_FOUND', 404);
});

it('Anonymous poll privacy.', async () => {
  const x = await fixture();
  const post = x.toDepartment({ postType: 'POLL', body: 'Offsite location?' });
  expect(post.status).toBe('DRAFT');
  await expectAppError(() => x.feed.publish(x.alice, post.id, b()), 'POLL_NOT_OPEN', 409);
  x.feed.createPoll(x.alice, post.id, b({ question: 'Where?', options: ['Lisbon', 'Berlin'], isAnonymous: true }));
  const published = x.feed.publish(x.alice, post.id, b());
  const [lisbon, berlin] = published.poll!.options;
  const voted = x.feed.vote(x.bob, published.poll!.id, b({ optionIds: [lisbon.id] }));
  expect(voted.myOptionIds).toEqual([lisbon.id]);
  await expectAppError(() => x.feed.vote(x.bob, published.poll!.id, b({ optionIds: [berlin.id] })), 'POLL_ALREADY_VOTED', 409);
  await expectAppError(() => x.feed.vote(x.alice, published.poll!.id, b({ optionIds: [lisbon.id, berlin.id] })), 'VALIDATION_ERROR', 400);
  x.feed.vote(x.alice, published.poll!.id, b({ optionIds: [berlin.id] }));
  // Results expose counts only; no voter identity reaches the API or the outbox.
  const results = x.feed.get(x.alice, post.id).poll!;
  expect(results.options.map(option => [option.label, option.votes])).toEqual([['Lisbon', 1], ['Berlin', 1]]);
  expect(JSON.stringify(results)).not.toContain(x.bob.user.id);
  for (const event of x.c.state.outboxEvents.filter(row => row.eventType === 'POLL_VOTED')) { expect(event.actorUserId).toBeNull(); expect(JSON.stringify(event.payload)).not.toContain(x.bob.user.id); }
  x.feed.retract(x.bob, published.poll!.id, b());
  expect(x.feed.vote(x.bob, published.poll!.id, b({ optionIds: [berlin.id] })).options[1].votes).toBe(2);
  // Non-anonymous polls show voters; closed polls reject votes; outsiders cannot reach the poll.
  const open = x.toDepartment({ postType: 'POLL', body: 'Lunch?', publish: false });
  x.feed.createPoll(x.alice, open.id, b({ question: 'Pizza?', options: ['Yes', 'No'] }));
  const visible = x.feed.publish(x.alice, open.id, b());
  expect(x.feed.vote(x.bob, visible.poll!.id, b({ optionIds: [visible.poll!.options[0].id] })).options[0]).toMatchObject({ voterUserIds: [x.bob.user.id] });
  await expectAppError(() => x.feed.vote(x.carol, visible.poll!.id, b({ optionIds: [visible.poll!.options[0].id] })), 'POLL_NOT_FOUND', 404);
  x.c.state.feedPolls.find(row => row.id === visible.poll!.id)!.closesAt = new Date(Date.now() - 1000);
  await expectAppError(() => x.feed.vote(x.alice, visible.poll!.id, b({ optionIds: [visible.poll!.options[1].id] })), 'POLL_NOT_OPEN', 409);
});

it('Workspace-wide permission.', async () => {
  const x = await fixture();
  await expectAppError(() => x.feed.create(x.alice, b({ body: 'Everyone!', recipients: [{ recipientType: 'WORKSPACE' }] })), 'FEED_AUDIENCE_NOT_ALLOWED', 403);
  const sales = x.departments.create(x.c.owner.user, x.c.owner.workspaceId, { name: 'Sales' });
  await expectAppError(() => x.feed.create(x.alice, b({ body: 'Hi sales', recipients: [{ recipientType: 'DEPARTMENT', recipientId: sales.id }] })), 'FEED_AUDIENCE_NOT_ALLOWED', 403);
  await expectAppError(() => x.feed.create(x.bob, b({ body: 'No author rights', recipients: [{ recipientType: 'USER', recipientId: x.alice.user.id }] })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.feed.create(x.alice, b({ postType: 'APPRECIATION', body: 'x', recipients: [], })), 'VALIDATION_ERROR', 400);
  const broadcaster = await x.c.memberActor('broadcaster', [...AUTHOR, ...perms('WORKSPACE', 'feed.post_workspace')]);
  const everyone = x.feed.create(broadcaster, b({ body: 'Company update', recipients: [{ recipientType: 'WORKSPACE' }] }), 'company-update');
  expect(x.feed.create(broadcaster, b({ body: 'Company update', recipients: [{ recipientType: 'WORKSPACE' }] }), 'company-update').id).toBe(everyone.id);
  expect(x.feed.get(x.carol, everyone.id).id).toBe(everyone.id);
  expect(x.c.state.auditLogs.filter(row => row.action === 'FEED.WORKSPACE_PUBLISHED')).toHaveLength(1);
  // Pinning requires moderation or workspace-wide authority; pinned posts lead the feed.
  await expectAppError(() => x.feed.pin(x.alice, everyone.id, b(), true), 'PERMISSION_DENIED', 403);
  x.feed.pin(broadcaster, everyone.id, b(), true);
  x.toDepartment();
  expect(x.feed.list(x.bob, new URLSearchParams()).data[0].id).toBe(everyone.id);
});

it('edits, comments, reactions, soft delete, restore and moderator hard delete', async () => {
  const x = await fixture(), post = x.toDepartment();
  const edited = x.feed.update(x.alice, post.id, b({ body: 'Sprint review moved to Monday', version: post.version }), undefined, false);
  expect(edited.editedAt).not.toBeNull();
  await expectAppError(() => x.feed.update(x.bob, post.id, b({ body: 'Hijack', version: edited.version }), undefined, false), 'PERMISSION_DENIED', 403);
  const comment = x.feed.comment(x.bob, post.id, b({ body: 'See you there' }));
  expect(x.feed.editComment(x.bob, comment.id, b({ body: 'See you Monday', version: 1 })).body).toBe('See you Monday');
  x.feed.react(x.bob, post.id, b({ reaction: '🎉' })); x.feed.favorite(x.bob, post.id, b(), true); x.feed.read(x.bob, post.id, b());
  expect(x.feed.get(x.bob, post.id)).toMatchObject({ commentCount: 1, isFavorite: true, isRead: true, reactions: [{ reaction: '🎉', count: 1, reactedByMe: true }] });
  x.feed.unreact(x.bob, post.id, encodeURIComponent('🎉'), b());
  const deleted = x.feed.remove(x.alice, post.id, b());
  expect(deleted.status).toBe('DELETED');
  await expectAppError(() => x.feed.get(x.bob, post.id), 'FEED_POST_NOT_FOUND', 404);
  expect(x.feed.list(x.alice, new URLSearchParams({ status: 'DELETED' })).data.map(row => row.id)).toEqual([post.id]);
  expect(x.feed.restore(x.alice, post.id, b()).status).toBe('PUBLISHED');
  x.feed.remove(x.alice, post.id, b());
  await expectAppError(() => x.feed.hardDelete(x.alice, post.id, b()), 'PERMISSION_DENIED', 403);
  x.feed.hardDelete(x.c.owner, post.id, b({ reason: 'Retention request' }));
  expect(x.c.state.feedPosts.some(row => row.id === post.id)).toBe(false);
  expect(x.c.state.feedComments.some(row => row.postId === post.id)).toBe(false);
  expect(x.c.state.auditLogs.filter(row => row.action === 'FEED.POST_HARD_DELETED')).toHaveLength(1);
});
