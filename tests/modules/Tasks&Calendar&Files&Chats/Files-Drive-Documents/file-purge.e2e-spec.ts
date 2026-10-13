import { createHash, randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { Body } from '@/src/server/collab/support';
import { AppError } from '@/src/server/errors';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180_000);
const jobToken = randomUUID(), previous = process.env.INTERNAL_JOB_TOKEN;
beforeAll(async () => { await prepareCollabDatabase(); process.env.INTERNAL_JOB_TOKEN = jobToken; });
afterAll(async () => { if (previous === undefined) delete process.env.INTERNAL_JOB_TOKEN; else process.env.INTERNAL_JOB_TOKEN = previous; await disconnect(); });
const job = (name = 'file-object-garbage') => api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: name }, headers: { 'x-internal-job-token': jobToken }, body: { limit: 100 } });
async function fixture(processed = true) {
  const owner = await register('purge'), prisma = await db();
  await prisma.workspace.update({ where: { id: owner.workspaceId }, data: { settings: { fileRetentionDays: 0 } } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Purge' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const { appContext } = await import('@/src/server/app-context');
  appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process() { return { scanStatus: 'CLEAN', processed }; } });
  async function upload(folderId = root.id, name = 'sample.txt') {
    const bytes = Buffer.from('real immutable purge bytes'), checksum = createHash('sha256').update(bytes).digest('hex');
    const input = { targetFolderId: folderId, desiredFileName: name, expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() };
    const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: input }));
    expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
    const accepted = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
    return { session, input, bytes, file: await prisma.driveFile.findUniqueOrThrow({ where: { id: accepted.resultFileId } }), version: await prisma.driveFileVersion.findUniqueOrThrow({ where: { id: accepted.resultVersionId } }) };
  }
  return { owner, storage, root, prisma, upload };
}
it('retains shared bytes, tombstones upload receipts and deletes final orphan bytes through the authenticated worker', async () => {
  const f = await fixture(), source = await f.upload(), objects = new LocalObjectStorage();
  const copy = expectOk(await call(f.owner, 'POST', `files/${source.file.id}/copy`, { body: { folderId: f.root.id, name: 'copy.txt' } }));
  let trashed = expectOk(await call(f.owner, 'DELETE', `files/${source.file.id}`, { body: { version: source.file.version } }));
  expect(expectOk(await call(f.owner, 'DELETE', `files/${source.file.id}/hard`, { body: { version: trashed.version } }))).toMatchObject({ queuedObjectCount: 0, deletedVersionCount: 1 });
  expect(await objects.read(source.version.objectKey)).toEqual(source.bytes);
  expect(await f.prisma.fileObjectGarbage.count({ where: { workspaceId: f.owner.workspaceId } })).toBe(0);
  expectError(await call(f.owner, 'POST', `upload-sessions/${source.session.id}/complete`, { body: {} }), 404, 'UPLOAD_SESSION_NOT_FOUND');
  expectError(await call(f.owner, 'POST', 'upload-sessions', { body: source.input }), 410, 'UPLOAD_SESSION_PURGED');
  expect((await f.prisma.uploadSession.findUniqueOrThrow({ where: { id: source.session.id } })).purgedAt).not.toBeNull();
  trashed = expectOk(await call(f.owner, 'DELETE', `files/${copy.id}`, { body: { version: copy.version } }));
  const results = await Promise.all([1, 2].map(() => call(f.owner, 'DELETE', `files/${copy.id}/hard`, { body: { version: trashed.version } })));
  expect(results.map(result => result.status).sort()).toEqual([200, 404]);
  expectError(results.find(result => result.status === 404)!, 404, 'FILE_NOT_FOUND');
  expect(await objects.read(source.version.objectKey)).toEqual(source.bytes);
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'file-object-garbage' }, body: {} }), 401, 'UNAUTHENTICATED');
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'file-object-garbage' }, headers: { 'x-internal-job-token': jobToken }, body: { limit: 0 } }), 400, 'VALIDATION_ERROR');
  const workers = await Promise.all([job(), job()]);
  expect(workers.map(result => expectOk(result).sent).reduce((a, b) => a + b, 0)).toBe(1);
  await expect(objects.read(source.version.objectKey)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.prisma.auditLog.count({ where: { workspaceId: f.owner.workspaceId, action: 'FILE.DELETED' } })).toBe(2);
  const retired = await f.prisma.fileObjectGarbage.findFirstOrThrow({ where: { workspaceId: f.owner.workspaceId } });
  expect(retired.cleanedAt).not.toBeNull();
  await expect(f.prisma.fileObjectGarbage.delete({ where: { id: retired.id } })).rejects.toThrow();
  await expect(f.prisma.driveFileVersion.create({ data: { ...source.version, id: randomUUID(), fileId: randomUUID() } })).rejects.toThrow('FILE_OBJECT_RETIRED');
  await expect(f.prisma.uploadSession.update({ where: { id: source.session.id }, data: { purgedAt: null, version: source.session.version + 100 } })).rejects.toThrow();
  expect(expectOk(await job('upload-cleanup')).sent).toBeGreaterThan(0);
});

it('rejects tenant/permission/stale requests and preserves the complete graph when File or Version retention blocks purge', async () => {
  const f = await fixture(), source = await f.upload(), foreign = await register('purge-foreign'), denied = await member(f.owner, 'purge-denied', [['file.read', 'WORKSPACE']]);
  const trashed = expectOk(await call(f.owner, 'DELETE', `files/${source.file.id}`, { body: { version: source.file.version } }));
  expectError(await call(null, 'DELETE', `files/${source.file.id}/hard`, { body: { version: trashed.version } }), 401, 'UNAUTHENTICATED');
  expectError(await call(denied, 'DELETE', `files/${source.file.id}/hard`, { body: { version: trashed.version } }), 403, 'PERMISSION_DENIED');
  expectError(await call(foreign, 'DELETE', `files/${source.file.id}/hard`, { body: { version: trashed.version } }), 404, 'FILE_NOT_FOUND');
  expectError(await call(f.owner, 'DELETE', `files/${source.file.id}/hard`, { body: { version: source.file.version } }), 409, 'RESOURCE_VERSION_CONFLICT');
  const holdId = randomUUID();
  await f.prisma.commercialPackRecord.create({ data: { id: holdId, workspaceId: f.owner.workspaceId, collection: 'retentionRecords', data: {
    id: holdId, workspaceId: f.owner.workspaceId, category: 'FILE', resourceId: source.version.id, legalHold: true, expiresAt: new Date(0).toISOString(), createdAt: new Date().toISOString(),
  } } });
  expectError(await call(f.owner, 'DELETE', `files/${source.file.id}/hard`, { body: { version: trashed.version } }), 409, 'FILE_RETENTION_HOLD');
  await expect(f.prisma.driveFileVersion.delete({ where: { id: source.version.id } })).rejects.toThrow();
  await expect(f.prisma.driveFile.delete({ where: { id: source.file.id } })).rejects.toThrow();
  expect(await f.prisma.driveFileVersion.count({ where: { fileId: source.file.id } })).toBe(1);
  expect(await f.prisma.fileObjectGarbage.count({ where: { workspaceId: f.owner.workspaceId } })).toBe(0);
  expect((await f.prisma.uploadSession.findUniqueOrThrow({ where: { id: source.session.id } })).purgedAt).toBeNull();
});

it('purges folder content and unaccepted sessions atomically while preserving moved pending content outside the tree', async () => {
  const f = await fixture(false), folder = expectOk(await call(f.owner, 'POST', 'folders', { body: { storageId: f.storage.id, parentFolderId: f.root.id, name: 'Subtree' } }));
  const moved = await f.upload(folder.id, 'moved.txt'), inside = await f.upload(folder.id, 'inside.txt');
  expectOk(await call(f.owner, 'PATCH', `files/${moved.file.id}/move`, { body: { folderId: f.root.id, version: moved.file.version } }));
  const pending = expectOk(await call(f.owner, 'POST', 'upload-sessions', { body: { ...inside.input, desiredFileName: 'unaccepted.txt', idempotencyKey: randomUUID() } }));
  const trashed = expectOk(await call(f.owner, 'DELETE', `folders/${folder.id}`, { body: { version: folder.version } }));
  expect(expectOk(await call(f.owner, 'DELETE', `folders/${folder.id}/hard`, { body: { version: trashed.version } }))).toMatchObject({ deletedFolderCount: 1, deletedFileCount: 1, deletedVersionCount: 1, queuedObjectCount: 1 });
  expect(await f.prisma.projectRootFolder.findUnique({ where: { id: folder.id } })).toBeNull();
  expect(await f.prisma.driveFile.findUnique({ where: { id: inside.file.id } })).toBeNull();
  expect(await f.prisma.uploadSession.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'FAILED', purgedAt: expect.any(Date) });
  expect((await f.prisma.uploadSession.findUniqueOrThrow({ where: { id: moved.session.id } })).purgedAt).toBeNull();
  const { appContext } = await import('@/src/server/app-context');
  appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  await f.prisma.uploadSession.update({ where: { id: moved.session.id }, data: { processingNextAttemptAt: new Date(0) } });
  expect(expectOk(await job('upload-processing')).sent).toBe(1);
  expect((await f.prisma.driveFile.findUniqueOrThrow({ where: { id: moved.file.id } })).status).toBe('ACTIVE');
});

it('commits neither metadata removal nor byte cleanup when the request transaction fails', async () => {
  const f = await fixture(), source = await f.upload(), trashed = expectOk(await call(f.owner, 'DELETE', `files/${source.file.id}`, { body: { version: source.file.version } }));
  const { appContext } = await import('@/src/server/app-context'), { runStateUnit } = await import('@/src/server/response');
  await expect(runStateUnit(async () => {
    const user = appContext.store.state.users.find(row => row.id === f.owner.userId)!;
    appContext.collab.files.records.purge(appContext.access.actor(user, f.owner.workspaceId), source.file.id, new Body({ version: trashed.version }));
    throw new AppError('ROLLBACK_TEST', 'Rollback.', 409);
  })).rejects.toMatchObject({ code: 'ROLLBACK_TEST' });
  expect(await f.prisma.driveFile.findUnique({ where: { id: source.file.id } })).not.toBeNull();
  expect(await f.prisma.fileObjectGarbage.count({ where: { workspaceId: f.owner.workspaceId } })).toBe(0);
  expect(await new LocalObjectStorage().read(source.version.objectKey)).toEqual(source.bytes);
  expect(await f.prisma.outboxEvent.count({ where: { entityId: source.file.id, eventType: 'FILE_DELETED' } })).toBe(0);
});
