import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { api } from '@/tests/support/api';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
const previous = process.env.FILE_DELIVERY_SECRET;
beforeAll(async () => { await prepareCollabDatabase(); process.env.FILE_DELIVERY_SECRET = 'public-delivery-secret-at-least-32-bytes'; });
afterAll(async () => { if (previous === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = previous; await disconnect(); });
async function fixture() {
  const owner = await register('public-delivery'), prisma = await db(), { appContext } = await import('@/src/server/app-context'), objects = new LocalObjectStorage();
  appContext.collab.files.uploads.configure(objects, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Shared' } })), root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const folder = expectOk(await call(owner, 'POST', 'folders', { body: { storageId: storage.id, parentFolderId: root.id, name: 'Branch' } }));
  const bytes = Buffer.from('real anonymous file delivery'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: folder.id, desiredFileName: 'public.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
  const receipt = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  const file = expectOk(await call(owner, 'GET', `files/${receipt.resultFileId}`));
  const create = (body: Record<string, unknown> = {}) => call(owner, 'POST', `files/${file.id}/public-links`, { body: { permissionMode: 'DOWNLOAD', ...body } });
  const issue = (token: string, password?: string, type = 'files') => api('GET', `/api/v1/public/${type}/[[...path]]`, { params: { path: [token, 'download'] },
    headers: password ? { 'x-share-password': password } : {}, query: type === 'folders' ? { fileId: file.id } : {} });
  const redeem = async (path: string) => { const { GET } = await import('@/app/api/v1/file-delivery/[id]/route'); return GET(new NextRequest(`http://localhost${path}`),
    { params: Promise.resolve({ id: new URL(path, 'http://localhost').pathname.split('/').at(-1)! }) }); };
  return { owner, prisma, appContext, objects, bytes, root, folder, file, create, issue, redeem };
}
it('delivers once under concurrent requests and enforces independent PostgreSQL accounting without leaking capability secrets', async () => {
  const x = await fixture(), link = expectOk(await x.create({ maxDownloads: 1, password: 'sharing-password' }));
  expectError(await x.issue(link.token, 'bad'), 403, 'PUBLIC_LINK_PASSWORD_INVALID');
  const a = expectOk(await x.issue(link.token, 'sharing-password')), b = expectOk(await x.issue(link.token, 'sharing-password'));
  const untouched = await x.prisma.fileDeliveryGrant.findFirstOrThrow({ where: { publicLinkId: link.id } });
  await expect(x.prisma.filePublicLink.update({ where: { id: link.id }, data: { downloadCount: 2 } })).rejects.toThrow();
  await expect(x.prisma.fileDeliveryGrant.update({ where: { id: untouched.id }, data: { consumedAt: new Date() } })).rejects.toThrow('PUBLIC_LINK_DOWNLOAD_LIMIT');
  const responses = await Promise.all([x.redeem(a.deliveryPath), x.redeem(b.deliveryPath)]);
  expect(responses.map(row => row.status).sort()).toEqual([200, 410]);
  expect(Buffer.from(await responses.find(row => row.status === 200)!.arrayBuffer())).toEqual(x.bytes);
  expect((await x.prisma.filePublicLink.findUniqueOrThrow({ where: { id: link.id } })).downloadCount).toBe(1);
  expect(await x.prisma.fileDeliveryGrant.count({ where: { publicLinkId: link.id, consumedAt: { not: null } } })).toBe(1);
  expectError(await x.issue(link.token, 'sharing-password'), 410, 'PUBLIC_LINK_DOWNLOAD_LIMIT');
  expect(await x.prisma.auditLog.count({ where: { entityId: link.id, action: 'PUBLIC_LINK.DOWNLOADED' } })).toBe(1);
  const audits = await x.prisma.auditLog.findMany({ where: { workspaceId: x.owner.workspaceId } });
  expect(JSON.stringify(audits)).not.toContain(link.token); expect(JSON.stringify(audits)).not.toContain(new URL(a.deliveryPath, 'http://localhost').searchParams.get('nonce'));
});
it('rejects VIEW downloads and invalidates old paths through password edits, revocation and issuer suspension', async () => {
  const x = await fixture(), view = expectOk(await x.create({ permissionMode: 'VIEW' }));
  expectError(await x.issue(view.token), 403, 'PERMISSION_DENIED');
  const link = expectOk(await x.create({ password: 'old-password' })), old = expectOk(await x.issue(link.token, 'old-password'));
  const updated = expectOk(await call(x.owner, 'PATCH', `public-links/${link.id}`, { body: { password: 'new-password', version: 1 } }));
  expect((await x.redeem(old.deliveryPath)).status).toBe(410);
  const fresh = expectOk(await x.issue(link.token, 'new-password'));
  expectOk(await call(x.owner, 'DELETE', `public-links/${link.id}`, { body: { version: updated.version } }));
  expect((await x.redeem(fresh.deliveryPath)).status).toBe(410);
  const nextLink = expectOk(await x.create()), grant = expectOk(await x.issue(nextLink.token));
  await x.prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: x.owner.workspaceId, userId: x.owner.userId } }, data: { status: 'SUSPENDED' } });
  expect((await x.redeem(grant.deliveryPath)).status).toBe(410);
});
it('lists safe folder Files, honors includeChildren and invalidates byte grants after moving a File outside the shared tree', async () => {
  const x = await fixture();
  const rootLink = expectOk(await call(x.owner, 'POST', `folders/${x.root.id}/public-links`, { body: { permissionMode: 'DOWNLOAD' } }));
  expectError(await x.issue(rootLink.token, undefined, 'folders'), 404, 'PUBLIC_LINK_NOT_FOUND');
  const recursive = expectOk(await call(x.owner, 'POST', `folders/${x.root.id}/public-links`, { body: { permissionMode: 'DOWNLOAD', includeChildren: true } }));
  expectOk(await x.issue(recursive.token, undefined, 'folders'));
  const link = expectOk(await call(x.owner, 'POST', `folders/${x.folder.id}/public-links`, { body: { permissionMode: 'DOWNLOAD' } }));
  const list = expectOk(await api('GET', '/api/v1/public/folders/[[...path]]', { params: { path: [link.token] } }));
  expect(list.files).toMatchObject([{ id: x.file.id, downloadPath: `/api/v1/public/folders/${link.token}/download?fileId=${x.file.id}` }]);
  expect(JSON.stringify(list)).not.toMatch(/objectKey|workspaceId|storageId/);
  const grant = expectOk(await x.issue(link.token, undefined, 'folders'));
  expectOk(await call(x.owner, 'PATCH', `files/${x.file.id}/move`, { body: { folderId: x.root.id, version: x.file.version } }));
  expect((await x.redeem(grant.deliveryPath)).status).toBe(404);
  expectError(await x.issue(link.token, undefined, 'folders'), 404, 'PUBLIC_LINK_NOT_FOUND');
  expect(expectOk(await api('GET', '/api/v1/public/folders/[[...path]]', { params: { path: [link.token] } })).files).toEqual([]);
});
it('retains both download allowance and an unconsumed grant when physical content delivery fails', async () => {
  const x = await fixture(), link = expectOk(await x.create({ maxDownloads: 1 })), grant = expectOk(await x.issue(link.token));
  x.appContext.collab.files.uploads.configure({ putImmutable: x.objects.putImmutable.bind(x.objects), async read() { throw new Error('private provider failure'); } },
    { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  expect((await x.redeem(grant.deliveryPath)).status).toBe(503);
  expect((await x.prisma.filePublicLink.findUniqueOrThrow({ where: { id: link.id } })).downloadCount).toBe(0);
  expect((await x.prisma.fileDeliveryGrant.findFirstOrThrow({ where: { publicLinkId: link.id } })).consumedAt).toBeNull();
  x.appContext.collab.files.uploads.configure(x.objects, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  expect((await x.redeem(grant.deliveryPath)).status).toBe(200);
});
it('fences delivery against an independently committed link policy change during storage I/O', async () => {
  const x = await fixture(), link = expectOk(await x.create({ maxDownloads: 1 })), grant = expectOk(await x.issue(link.token));
  x.appContext.collab.files.uploads.configure({ putImmutable: x.objects.putImmutable.bind(x.objects), async read(key) {
    await x.prisma.filePublicLink.update({ where: { id: link.id }, data: { permissionMode: 'VIEW', version: 2 } });
    return x.objects.read(key);
  } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const response = await x.redeem(grant.deliveryPath); expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('CONCURRENCY_CONFLICT');
  expect((await x.prisma.filePublicLink.findUniqueOrThrow({ where: { id: link.id } })).downloadCount).toBe(0);
  expect((await x.prisma.fileDeliveryGrant.findFirstOrThrow({ where: { publicLinkId: link.id } })).consumedAt).toBeNull();
  expect(await x.prisma.auditLog.count({ where: { entityId: link.id, action: 'PUBLIC_LINK.DOWNLOADED' } })).toBe(0);
});
it('prevents File and folder copies from stripping unreadable private owning-record bindings', async () => {
  const x = await fixture(), reader = await member(x.owner, 'copy-file-only', [['file.copy', 'WORKSPACE'], ['folder.read', 'WORKSPACE'], ['folder.create', 'WORKSPACE']]);
  const permissions = expectOk(await call(x.owner, 'GET', `folders/${x.root.id}/permissions`));
  expectOk(await call(x.owner, 'PUT', `folders/${x.root.id}/permissions`, { body: { version: permissions.version, assignments: [
    { subjectType: 'USER', subjectId: x.owner.userId, inheritanceMode: 'OVERRIDE', permissionLevel: 'FULL' },
    { subjectType: 'USER', subjectId: reader.userId, inheritanceMode: 'OVERRIDE', permissionLevel: 'ADD' },
  ] } }));
  expectOk(await call(reader, 'POST', `files/${x.file.id}/copy`, { body: { folderId: x.root.id, name: 'authorized-before-binding.txt' } }));
  const task = expectOk(await call(x.owner, 'POST', 'tasks', { body: { title: 'Private result', responsibleUserId: x.owner.userId } }));
  await x.prisma.taskResult.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, taskId: task.id, resultType: 'FILE',
    fileId: x.file.id, submittedByUserId: x.owner.userId, createdAt: new Date() } });
  expectError(await call(reader, 'POST', `files/${x.file.id}/copy`, { body: { folderId: x.root.id, name: 'blocked-copy.txt' } }), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expectError(await call(reader, 'POST', `folders/${x.folder.id}/copy`, { body: { parentFolderId: x.root.id, name: 'Blocked subtree' } }), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expect(await x.prisma.driveFile.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(2);
  expect(await x.prisma.projectRootFolder.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(2);
});
