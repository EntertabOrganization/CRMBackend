import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { api } from '@/tests/support/api';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';
jest.setTimeout(180_000);
let owner: Session, denied: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('folder-links-owner'); foreign = await register('folder-links-foreign');
  denied = await member(owner, 'folder-links-denied', []);
});
afterAll(disconnect);
const publicGet = (token: string, password?: string, folderId?: string) => api('GET', '/api/v1/public/folders/[[...path]]', { params: { path: [token] }, headers: password ? { 'x-share-password': password } : {}, query: folderId ? { folderId } : {} });

it('persists secure capabilities, enforces six routes and respects live move, trash, restore and purge', async () => {
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Public folders' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const create = async (parentFolderId: string, name: string) => expectOk(await call(owner, 'POST', 'folders', { body: { storageId: storage.id, parentFolderId, name } }));
  let branch = await create(root.id, 'Branch'), child = await create(branch.id, 'Child');
  const input = { password: 'sharing-password', includeChildren: true };
  const link = expectOk(await call(owner, 'POST', `folders/${branch.id}/public-links`, { body: input }));
  for (const [method, path, body] of [
    ['POST', `folders/${branch.id}/public-links`, input], ['GET', 'public-links', undefined], ['GET', `public-links/${link.id}`, undefined],
    ['PATCH', `public-links/${link.id}`, { includeChildren: false, version: 1 }], ['DELETE', `public-links/${link.id}`, { version: 1 }],
  ] as const) {
    const options = body ? { body } : {};
    expectError(await call(denied, method, path, options), 403, 'PERMISSION_DENIED');
    expectError(await call(null, method, path, { ...options, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    if (path !== 'public-links') expectError(await call(foreign, method, path, options), 404, method === 'POST' ? 'FOLDER_NOT_FOUND' : 'PUBLIC_LINK_NOT_FOUND');
  }
  expect(expectOk(await call(foreign, 'GET', 'public-links'))).toEqual([]);
  expect(expectOk(await call(owner, 'GET', 'public-links'))).toHaveLength(1);
  expect(JSON.stringify(expectOk(await call(owner, 'GET', `public-links/${link.id}`)))).not.toMatch(/tokenHash|passwordHash|sharing-password/);
  expectError(await publicGet(link.id), 404, 'PUBLIC_LINK_NOT_FOUND');
  const { GET } = await import('@/app/api/v1/public/folders/[[...path]]/route');
  const invalidResponse = await GET(new NextRequest(`http://localhost/api/v1/public/folders/${link.id}`), { params: Promise.resolve({ path: [link.id] }) });
  expect(invalidResponse.headers.get('cache-control')).toContain('no-store');
  expect(invalidResponse.headers.get('referrer-policy')).toBe('no-referrer');
  expectError(await publicGet(link.token, 'wrong-password'), 403, 'PUBLIC_LINK_PASSWORD_INVALID');
  const response = await publicGet(link.token, 'sharing-password');
  expect(expectOk(response).children.map((row: any) => row.id)).toEqual([child.id]);
  child = expectOk(await call(owner, 'PATCH', `folders/${child.id}/move`, { body: { parentFolderId: root.id, version: child.version } }));
  expectError(await publicGet(link.token, 'sharing-password', child.id), 404, 'PUBLIC_LINK_NOT_FOUND');
  const updated = expectOk(await call(owner, 'PATCH', `public-links/${link.id}`, { body: { password: null, includeChildren: false, version: 1 } }));
  expect(expectOk(await publicGet(link.token)).children).toEqual([]);
  branch = expectOk(await call(owner, 'DELETE', `folders/${branch.id}`, { body: { version: branch.version } }));
  expectError(await publicGet(link.token), 410, 'PUBLIC_LINK_REVOKED');
  branch = expectOk(await call(owner, 'PATCH', `folders/${branch.id}/restore`, { body: { version: branch.version } }));
  expectError(await publicGet(link.token), 410, 'PUBLIC_LINK_REVOKED');
  const revoked = expectOk(await call(owner, 'DELETE', `public-links/${link.id}`, { body: { version: updated.version } }));
  expectError(await call(owner, 'PATCH', `public-links/${link.id}`, { body: { version: revoked.version, isActive: true } }), 410, 'PUBLIC_LINK_REVOKED');
  const prisma = await db(), stored = await prisma.filePublicLink.findUniqueOrThrow({ where: { id: link.id } });
  expect(stored.tokenHash).not.toBe(link.token); expect(stored.accessCount).toBe(2);
  await expect(prisma.filePublicLink.update({ where: { id: link.id }, data: { isActive: true, revokedAt: null } })).rejects.toThrow('PUBLIC_LINK_REVOKED');
  await expect(prisma.filePublicLink.create({ data: { ...stored, id: randomUUID(), workspaceId: foreign.workspaceId, tokenHash: 'a'.repeat(64) } })).rejects.toThrow();
  const audits = await prisma.auditLog.findMany({ where: { entityId: link.id } });
  expect(audits.map(row => row.action)).toEqual(expect.arrayContaining(['PUBLIC_LINK.CREATED', 'PUBLIC_LINK.UPDATED', 'PUBLIC_LINK.REVOKED', 'PUBLIC_LINK.ACCESSED']));
  expect(await prisma.outboxEvent.count({ where: { entityId: link.id, eventType: 'PUBLIC_LINK_ACCESSED' } })).toBe(2);
  expect(JSON.stringify(audits)).not.toMatch(/sharing-password/);
  expect(JSON.stringify(audits)).not.toContain(link.token);
  branch = expectOk(await call(owner, 'DELETE', `folders/${branch.id}`, { body: { version: branch.version } }));
  await prisma.projectRootFolder.update({ where: { id: branch.id }, data: { purgeAfter: new Date(0) } });
  expectOk(await call(owner, 'DELETE', `folders/${branch.id}/hard`, { body: { version: branch.version } }));
  expect(await prisma.filePublicLink.findUnique({ where: { id: link.id } })).toBeNull();
});

it('rechecks issuer eligibility, Workspace sharing policy and persisted expiry on public access', async () => {
  const prisma = await db();
  const storage = await prisma.projectFileStorage.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, type: 'PERSONAL' } });
  const root = await prisma.projectRootFolder.findFirstOrThrow({ where: { storageId: storage.id, parentFolderId: null } });
  const link = expectOk(await call(owner, 'POST', `folders/${root.id}/public-links`, { body: {} }));
  await prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: owner.userId } }, data: { status: 'SUSPENDED' } });
  expectError(await publicGet(link.token), 410, 'PUBLIC_LINK_REVOKED');
  await prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: owner.userId } }, data: { status: 'ACTIVE' } });
  expectOk(await publicGet(link.token));
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } });
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { settings: { ...(workspace.settings as object), publicLinksEnabled: false } } });
  expectError(await publicGet(link.token), 410, 'PUBLIC_LINK_REVOKED');
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { settings: workspace.settings as any } });
  await prisma.filePublicLink.update({ where: { id: link.id }, data: { expiresAt: new Date(0) } });
  expectError(await publicGet(link.token), 410, 'PUBLIC_LINK_EXPIRED');
  expect((await prisma.filePublicLink.findUniqueOrThrow({ where: { id: link.id } })).accessCount).toBe(1);
});
