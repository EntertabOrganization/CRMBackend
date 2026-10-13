import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';
jest.setTimeout(180_000);
let owner: Session, denied: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('file-core-owner'); foreign = await register('file-core-foreign'); denied = await member(owner, 'file-core-denied', []);
});
afterAll(disconnect);
async function fixture() {
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'SYSTEM', name: randomUUID() } }));
  // System content remains read-only: use canonical Personal storage for mutable lifecycle.
  const prisma = await db();
  let personal = await prisma.projectFileStorage.findFirst({ where: { workspaceId: owner.workspaceId, type: 'PERSONAL' } });
  if (!personal) personal = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Files' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${personal!.id}/root`));
  const folder = expectOk(await call(owner, 'POST', 'folders', { body: { storageId: personal!.id, parentFolderId: root.id, name: randomUUID() } }));
  const id = randomUUID(), versionId = randomUUID(), now = new Date();
  const file = { id, workspaceId: owner.workspaceId, storageId: personal!.id, folderId: folder.id, name: randomUUID() + '.pdf', extension: 'pdf', mimeType: 'application/pdf', status: 'ACTIVE',
    currentVersionId: versionId, sizeBytesCurrent: 10, version: 1, publicShareVersion: 1, originalFolderId: null, statusBeforeTrash: null, trashedAt: null, purgeAfter: null, createdAt: now, updatedAt: now };
  const version = { id: versionId, workspaceId: owner.workspaceId, fileId: id, versionNumber: 1, objectKey: `${owner.workspaceId}/test-object/${versionId}`, sizeBytes: 10,
    checksum: 'a'.repeat(64), mimeType: file.mimeType, createdByUserId: owner.userId, createdAt: now, processedAt: now, scanStatus: 'CLEAN' };
  await prisma.$transaction(async tx => { await tx.driveFile.create({ data: file }); await tx.driveFileVersion.create({ data: version }); });
  return { file, version, root, folder, storage };
}

it('exercises 13 real File/Version/ACL routes with authentication, tenant and immutable-history checks', async () => {
  let { file, version, root } = await fixture();
  const cases = [
    ['GET', 'files', undefined], ['GET', `files/${file.id}`, undefined], ['PATCH', `files/${file.id}`, { name: 'Denied.pdf', version: 1 }],
    ['PATCH', `files/${file.id}/move`, { folderId: root.id, version: 1 }], ['POST', `files/${file.id}/copy`, { folderId: root.id, name: 'Denied.pdf' }],
    ['DELETE', `files/${file.id}`, { version: 1 }], ['PATCH', `files/${file.id}/restore`, { version: 1 }],
    ['GET', `files/${file.id}/versions`, undefined], ['GET', `files/${file.id}/versions/${version.id}`, undefined],
    ['POST', `files/${file.id}/versions/${version.id}/restore`, { version: 1 }], ['GET', `files/${file.id}/processing-status`, undefined],
    ['GET', `files/${file.id}/permissions`, undefined], ['PUT', `files/${file.id}/permissions`, { assignments: [], version: 1 }],
  ] as const;
  for (const [method, path, body] of cases) {
    const options = body ? { body } : {};
    expectError(await call(null, method, path, { ...options, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(denied, method, path, options), 403, 'PERMISSION_DENIED');
    if (path !== 'files') expectError(await call(foreign, method, path, options), 404, 'FILE_NOT_FOUND');
  }
  expect(expectOk(await call(foreign, 'GET', 'files'))).toEqual([]);
  expect(expectOk(await call(owner, 'GET', 'files')).some((row: any) => row.id === file.id)).toBe(true);
  expectOk(await call(owner, 'GET', `files/${file.id}`));
  const acl = expectOk(await call(owner, 'GET', `files/${file.id}/permissions`));
  const changed = expectOk(await call(owner, 'PUT', `files/${file.id}/permissions`, { body: { assignments: [], version: acl.version } }));
  const folderCopy = expectOk(await call(owner, 'POST', `folders/${file.folderId}/copy`, { body: { parentFolderId: root.id, name: 'Folder content copy' } }));
  expect(folderCopy.copiedFileCount).toBe(1);
  expect(expectOk(await call(owner, 'GET', 'files', { query: { folderId: folderCopy.folder.id } }))).toHaveLength(1);
  expectError(await call(owner, 'PATCH', `files/${file.id}`, { body: { name: 'Stale.pdf', version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  file = expectOk(await call(owner, 'PATCH', `files/${file.id}`, { body: { name: 'Renamed.pdf', version: changed.version } }));
  file = expectOk(await call(owner, 'PATCH', `files/${file.id}/move`, { body: { folderId: root.id, version: file.version } }));
  const copied = expectOk(await call(owner, 'POST', `files/${file.id}/copy`, { body: { folderId: root.id, name: 'Copy.pdf' } }));
  expect(copied.currentVersionId).not.toBe(version.id);
  const restored = expectOk(await call(owner, 'POST', `files/${file.id}/versions/${version.id}/restore`, { body: { version: file.version } }));
  file = restored.file;
  expect(restored.version.versionNumber).toBe(2);
  expect(JSON.stringify(expectOk(await call(owner, 'GET', `files/${file.id}/versions`)))).not.toContain('objectKey');
  expectOk(await call(owner, 'GET', `files/${file.id}/versions/${version.id}`));
  expect(expectOk(await call(owner, 'GET', `files/${file.id}/processing-status`)).scanStatus).toBe('CLEAN');
  file = expectOk(await call(owner, 'DELETE', `files/${file.id}`, { body: { version: file.version } }));
  expectError(await call(owner, 'GET', `files/${file.id}`), 404, 'FILE_NOT_FOUND');
  file = expectOk(await call(owner, 'PATCH', `files/${file.id}/restore`, { body: { name: 'Recovered.pdf', version: file.version } }));
  const prisma = await db();
  expect(await prisma.driveFileVersion.findUnique({ where: { id: version.id } })).toEqual(version);
  expect(await prisma.auditLog.count({ where: { entityId: file.id } })).toBeGreaterThanOrEqual(6);
  await expect(prisma.driveFileVersion.update({ where: { id: version.id }, data: { checksum: 'b'.repeat(64) } })).rejects.toThrow('FILE_VERSION_IMMUTABLE');
  await expect(prisma.driveFileVersion.delete({ where: { id: version.id } })).rejects.toThrow('FILE_VERSION_IMMUTABLE');
  await expect(prisma.driveFile.update({ where: { id: file.id }, data: { currentVersionId: copied.currentVersionId } })).rejects.toThrow();
  await expect(prisma.driveFile.update({ where: { id: file.id }, data: { workspaceId: foreign.workspaceId } })).rejects.toThrow('FILE_VERSION_INVALID');
  await expect(prisma.driveFileVersion.create({ data: { ...version, id: randomUUID(), versionNumber: 42, sizeBytes: 11 } })).rejects.toThrow('FILE_VERSION_IMMUTABLE');
  await expect(prisma.driveFileVersion.create({ data: { ...version, id: randomUUID(), versionNumber: 42, objectKey: `${owner.workspaceId}/foreign-creator`, createdByUserId: foreign.userId } })).rejects.toThrow('FILE_VERSION_INVALID');
});

it('blocks unsafe activation and over-quota version growth even through independent SQL', async () => {
  const { file, version } = await fixture(), prisma = await db();
  await expect(prisma.$transaction(async tx => {
    await tx.driveFileVersion.update({ where: { id: version.id }, data: { scanStatus: 'BLOCKED' } });
  })).rejects.toThrow('FILE_VERSION_INVALID');
  await prisma.$transaction(async tx => {
    await tx.driveFile.update({ where: { id: file.id }, data: { status: 'BLOCKED' } });
    await tx.driveFileVersion.update({ where: { id: version.id }, data: { scanStatus: 'BLOCKED' } });
  });
  expectError(await call(owner, 'POST', `files/${file.id}/copy`, { body: { folderId: file.folderId, name: 'Blocked copy' } }), 409, 'FILE_BLOCKED');
  await expect(prisma.driveFileVersion.update({ where: { id: version.id }, data: { scanStatus: 'CLEAN' } })).rejects.toThrow('FILE_VERSION_IMMUTABLE');
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } });
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { settings: { ...(workspace.settings as object), fileStorageQuotaBytes: 40 } } });
  await expect(prisma.driveFileVersion.create({ data: { ...version, id: randomUUID(), versionNumber: 2, objectKey: `${owner.workspaceId}/quota-object`, sizeBytes: 100 } })).rejects.toThrow('STORAGE_QUOTA_EXCEEDED');
  expect(await prisma.driveFileVersion.count({ where: { fileId: file.id } })).toBe(1);
  const usage = (await prisma.driveFileVersion.aggregate({ where: { workspaceId: owner.workspaceId }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { settings: { ...(workspace.settings as object), fileStorageQuotaBytes: usage + 10 } } });
  const competing = await Promise.allSettled([2, 3].map(versionNumber => prisma.driveFileVersion.create({ data: {
    ...version, id: randomUUID(), versionNumber, objectKey: `${owner.workspaceId}/quota-race/${randomUUID()}`, scanStatus: 'CLEAN',
  } })));
  expect(competing.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(String((competing.find(row => row.status === 'rejected') as PromiseRejectedResult).reason)).toContain('STORAGE_QUOTA_EXCEEDED');
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { settings: workspace.settings as any } });
});
