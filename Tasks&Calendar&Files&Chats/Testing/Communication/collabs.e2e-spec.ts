import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);

async function fixture(label = 'collabs') {
  const owner = await register(label), prisma = await db(), guest = await register(`${label}-guest`);
  const space = expectOk(await call(owner, 'POST', 'collabs', { body: { name: 'Agency launch', description: 'External project' } }));
  const accept = (session: typeof guest | null, token: string) => api('POST', '/api/v1/public/collab-invitations/[[...path]]', { ...(session ? { token: session.token } : {}), params: { path: [token, 'accept'] }, body: {} });
  return { owner, guest, prisma, space, accept };
}

it('exposes and enforces representative routes: POST   /api/v1/collabs; GET    /api/v1/collabs; GET    /api/v1/collabs/:id; PUT    /api/v1/collabs/:id', async () => {
  const x = await fixture();
  expect(expectOk(await call(x.owner, 'GET', 'collabs')).map((row: { id: string }) => row.id)).toContain(x.space.id);
  expect(expectOk(await call(x.owner, 'GET', `collabs/${x.space.id}`))).toMatchObject({ myRole: 'OWNER', chatId: expect.any(String) });
  const put = expectOk(await call(x.owner, 'PUT', `collabs/${x.space.id}`, { body: { name: 'Agency launch 2', version: x.space.version } }));
  expect(put.description).toBeNull();
  const patched = expectOk(await call(x.owner, 'PATCH', `collabs/${x.space.id}`, { body: { description: 'Q4', version: put.version } }));
  const colleague = await member(x.owner, 'collab-colleague', [['collab.read', 'WORKSPACE'], ['chat.read', 'WORKSPACE']]);
  expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/members`, { body: { userId: colleague.userId } }));
  const invitation = expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: x.guest.email } }));
  const resent = expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations/${invitation.id}/resend`, { body: {} }));
  expectError(await x.accept(x.guest, invitation.token), 404, 'COLLAB_INVITATION_INVALID');
  const accepted = await Promise.all([x.accept(x.guest, resent.token), x.accept(x.guest, resent.token)]);
  expect(expectOk(accepted[0]).member.id).toBe(expectOk(accepted[1]).member.id);
  expect(await x.prisma.collabSpaceMember.count({ where: { collabId: x.space.id, userId: x.guest.userId } })).toBe(1);
  // The guest reads the Collab with their own identity and the host Workspace header, never through a Workspace role.
  const guestView = { workspaceId: x.owner.workspaceId };
  expect(expectOk(await call(x.guest, 'GET', `collabs/${x.space.id}`, guestView))).toMatchObject({ myRole: 'GUEST' });
  expect(expectOk(await call(x.guest, 'GET', `collabs/${x.space.id}/members`, guestView))).toHaveLength(3);
  expect(expectOk(await call(x.guest, 'GET', `collabs/${x.space.id}/resources`, guestView))).toMatchObject({ chat: { id: x.space.chatId } });
  expect(expectOk(await call(x.guest, 'GET', `chats/${x.space.chatId}`, guestView)).type).toBe('COLLAB');
  expect(expectOk(await call(x.owner, 'GET', `collabs/${x.space.id}/resources`))).toMatchObject({ readOnly: false });
  const pending = expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: 'nobody@example.com' } }));
  expect(expectOk(await call(x.owner, 'DELETE', `collabs/${x.space.id}/invitations/${pending.id}`, { body: {} })).status).toBe('REVOKED');
  expectOk(await call(x.owner, 'DELETE', `collabs/${x.space.id}/members/${colleague.userId}`, { body: {} }));
  expect(expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/archive`, { body: {} })).status).toBe('ARCHIVED');
  expect(expectOk(await call(x.guest, 'GET', `chats/${x.space.chatId}`, guestView)).isReadOnly).toBe(true);
  expect(expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/restore`, { body: {} })).status).toBe('ACTIVE');
  expect(patched.description).toBe('Q4');
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
  const x = await fixture('collabs-auth'), id = x.space.id;
  for (const [method, path] of [['POST', 'collabs'], ['GET', 'collabs'], ['GET', `collabs/${id}`], ['PUT', `collabs/${id}`], ['PATCH', `collabs/${id}`], ['POST', `collabs/${id}/archive`],
    ['POST', `collabs/${id}/restore`], ['GET', `collabs/${id}/members`], ['POST', `collabs/${id}/members`], ['DELETE', `collabs/${id}/members/${MISSING_ID}`],
    ['POST', `collabs/${id}/invitations`], ['POST', `collabs/${id}/invitations/${MISSING_ID}/resend`], ['DELETE', `collabs/${id}/invitations/${MISSING_ID}`],
    ['GET', `collabs/${id}/resources`]] as const)
    expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
  const invitation = expectOk(await call(x.owner, 'POST', `collabs/${id}/invitations`, { body: { email: x.guest.email } }));
  expectError(await x.accept(null, invitation.token), 401);
  const reader = await member(x.owner, 'collab-reader', [['collab.read', 'WORKSPACE']]);
  expectError(await call(reader, 'GET', `collabs/${id}`), 404, 'COLLAB_NOT_FOUND');
  expectError(await call(reader, 'POST', 'collabs', { body: { name: 'Nope' } }), 403, 'PERMISSION_DENIED');
  expectOk(await call(x.owner, 'POST', `collabs/${id}/members`, { body: { userId: reader.userId } }));
  expectError(await call(reader, 'POST', `collabs/${id}/invitations`, { body: { email: 'a@example.com' } }), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'PATCH', `collabs/${id}`, { body: { name: 'x', version: 1 } }), 403, 'PERMISSION_DENIED');
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
  const x = await fixture('collabs-tenant'), invitation = expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: x.guest.email } }));
  expectOk(await x.accept(x.guest, invitation.token));
  const guestView = { workspaceId: x.owner.workspaceId };
  // Guest attempts non-Collab Workspace access: ordinary APIs require Workspace membership.
  for (const path of ['tasks', 'projects', 'file-storages', 'channels', 'chats', 'collabs'] as const)
    expect([403, 404]).toContain((await call(x.guest, 'GET', path, guestView)).status);
  const internal = expectOk(await call(x.owner, 'POST', 'collabs', { body: { name: 'Internal only' } }));
  expectError(await call(x.guest, 'GET', `collabs/${internal.id}`, guestView), 404, 'COLLAB_NOT_FOUND');
  const group = expectOk(await call(x.owner, 'POST', 'chats', { body: { title: 'Staff only' } }));
  expectError(await call(x.guest, 'GET', `chats/${group.id}`, guestView), 404, 'CHAT_NOT_FOUND');
  expectError(await call(x.guest, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: 'x@example.com' }, workspaceId: x.owner.workspaceId }), 403);
  // A foreign Workspace member sees nothing; invitations cannot be redirected across tenants.
  expectError(await call(x.guest, 'GET', `collabs/${x.space.id}`), 404, 'COLLAB_NOT_FOUND');
  // Independent SQL guards.
  const row = await x.prisma.collabInvitation.findFirstOrThrow({ where: { collabId: x.space.id } });
  await expect(x.prisma.collabInvitation.update({ where: { id: row.id }, data: { acceptedAt: null, acceptedUserId: null } })).rejects.toThrow(/COLLAB_INVITATION_INVALID/);
  await expect(x.prisma.collabInvitation.delete({ where: { id: row.id } })).rejects.toThrow(/COLLAB_INVITATION_INVALID/);
  await expect(x.prisma.collabInvitation.create({ data: { ...row, id: randomUUID(), tokenHash: 'b'.repeat(64), workspaceId: x.guest.workspaceId, acceptedAt: null, acceptedUserId: null } })).rejects.toThrow();
  await expect(x.prisma.collabSpaceMember.updateMany({ where: { collabId: x.space.id, userId: x.owner.userId }, data: { status: 'REMOVED', leftAt: new Date() } })).rejects.toThrow(/COLLAB_OWNER_REQUIRED/);
  await expect(x.prisma.collabSpace.delete({ where: { id: x.space.id } })).rejects.toThrow(/COLLAB_HISTORY_IMMUTABLE/);
});

it('returns stable machine-readable error envelopes for invalid requests', async () => {
  const x = await fixture('collabs-errors');
  expectError(await call(x.owner, 'POST', 'collabs', { body: { name: '' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: 'not-an-email' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', `collabs/${x.space.id}/members`, { body: { userId: x.guest.userId } }), 400, 'COLLAB_EXTERNAL_SCOPE_DENIED');
  expectError(await call(x.owner, 'DELETE', `collabs/${x.space.id}/members/${x.owner.userId}`, { body: {} }), 409, 'COLLAB_OWNER_REQUIRED');
  expectError(await call(x.owner, 'PATCH', `collabs/${x.space.id}`, { body: { name: 'x', version: 40 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectError(await x.accept(x.guest, 'a'.repeat(43)), 404, 'COLLAB_INVITATION_INVALID');
  const invitation = expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: 'someone-else@example.com' } }));
  expectError(await x.accept(x.guest, invitation.token), 403, 'COLLAB_INVITATION_INVALID');
  expectError(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: 'someone-else@example.com' } }), 409, 'COLLAB_INVITATION_INVALID');
  expectError(await call(x.owner, 'GET', `collabs/${MISSING_ID}`), 404, 'COLLAB_NOT_FOUND');
});

it('persists critical state and outbox/audit consistently on successful mutation', async () => {
  const x = await fixture('collabs-outbox');
  expect(await x.prisma.collabSpace.findUniqueOrThrow({ where: { id: x.space.id } })).toMatchObject({ createdByUserId: x.owner.userId, description: 'External project' });
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'COLLAB_CREATED', entityId: x.space.id } })).toBe(1);
  const invitation = expectOk(await call(x.owner, 'POST', `collabs/${x.space.id}/invitations`, { body: { email: x.guest.email } }));
  const stored = await x.prisma.collabInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(stored)).not.toContain(invitation.token);
  expectOk(await x.accept(x.guest, invitation.token));
  expect(await x.prisma.collabSpaceMember.findFirstOrThrow({ where: { collabId: x.space.id, userId: x.guest.userId } })).toMatchObject({ memberType: 'EXTERNAL', role: 'GUEST', status: 'ACTIVE' });
  for (const type of ['COLLAB_INVITATION_SENT', 'COLLAB_INVITATION_ACCEPTED'])
    expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: type } })).toBe(1);
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'COLLAB.INVITATION_ACCEPTED' } })).toBe(1);
  expect(await x.prisma.collaborationChatMembershipSource.count({ where: { userId: x.guest.userId, sourceType: 'COLLAB', active: true } })).toBe(1);
});
