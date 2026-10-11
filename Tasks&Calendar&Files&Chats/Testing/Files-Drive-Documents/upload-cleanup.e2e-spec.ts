import { createHash, randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { AppError } from '@/src/server/errors';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
import { Body } from '@/src/server/collab/support';
jest.setTimeout(180_000);
const token = randomUUID(), previousToken = process.env.INTERNAL_JOB_TOKEN;
beforeAll(async () => { await prepareCollabDatabase(); process.env.INTERNAL_JOB_TOKEN = token; });
afterAll(async () => { if (previousToken === undefined) delete process.env.INTERNAL_JOB_TOKEN; else process.env.INTERNAL_JOB_TOKEN = previousToken; await disconnect(); });
const job = () => api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'upload-cleanup' }, headers: { 'x-internal-job-token': token }, body: { limit: 100 } });

it('commits abort before deleting private bytes, survives rollback, fences concurrent workers and collects expiry/orphans', async () => {
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'upload-cleanup' }, body: {} }), 401, 'UNAUTHENTICATED');
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'upload-cleanup' }, headers: { 'x-internal-job-token': token }, body: { limit: 101 } }), 400, 'VALIDATION_ERROR');
  for (const body of [null, [], { workspaceId: randomUUID() }])
    expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'upload-cleanup' }, headers: { 'x-internal-job-token': token }, body }), 400, 'VALIDATION_ERROR');
  const owner = await register('cleanup-owner');
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Cleanup' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('cleanup bytes'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'abort.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, dataBase64: bytes.toString('base64'), checksum } }));
  const objects = new LocalObjectStorage(), key = `${owner.workspaceId}/uploads/${session.id}/parts/1/${checksum}`;
  const { appContext } = await import('@/src/server/app-context'), { runStateUnit } = await import('@/src/server/response');
  await expect(runStateUnit(async () => {
    const user = appContext.store.state.users.find(row => row.id === owner.userId)!;
    appContext.collab.files.uploads.abort(appContext.access.actor(user, owner.workspaceId), session.id, new Body({}));
    throw new AppError('ROLLBACK_TEST', 'Rollback.', 409);
  })).rejects.toMatchObject({ code: 'ROLLBACK_TEST' });
  const prisma = await db();
  expect((await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('UPLOADING');
  expect(await objects.read(key)).toEqual(bytes);
  const fileId = randomUUID(), now = new Date();
  await expect(prisma.$transaction(async tx => {
    await tx.driveFile.create({ data: { id: fileId, workspaceId: owner.workspaceId, storageId: storage.id, folderId: root.id,
      name: 'invalid-staging.txt', extension: 'txt', mimeType: 'text/plain', currentVersionId: null, status: 'PROCESSING', sizeBytesCurrent: 0, createdAt: now, updatedAt: now } });
    await tx.driveFileVersion.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, fileId, versionNumber: 1, objectKey: key,
      sizeBytes: bytes.length, checksum, mimeType: 'text/plain', createdByUserId: owner.userId, createdAt: now, scanStatus: 'PENDING' } });
  })).rejects.toThrow(/drive_version_not_staging/);
  expect(await prisma.driveFile.count({ where: { id: fileId } })).toBe(0);
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/abort`, { body: {} }));
  await objects.putImmutable(`${owner.workspaceId}/uploads/${session.id}/parts/unrecorded`, bytes);
  const jobs = await Promise.all([job(), job()]);
  expect(jobs.map(result => expectOk(result).sent).reduce((a, b) => a + b, 0)).toBe(1);
  await expect(objects.read(key)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(objects.read(`${owner.workspaceId}/uploads/${session.id}/parts/unrecorded`)).rejects.toMatchObject({ code: 'ENOENT' });
  const cleaned = await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } });
  expect(cleaned.cleanedAt).not.toBeNull(); expect(cleaned.cleanupClaimId).toBeNull();
  // A stale pre-abort writer can leave late bytes; the closed namespace is safely swept again.
  await objects.putImmutable(key, bytes);
  await prisma.uploadSession.update({ where: { id: session.id }, data: { cleanupNextAttemptAt: new Date(0) } });
  expect(expectOk(await job()).sent).toBe(1);
  expect((await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } })).cleanedAt).toEqual(cleaned.cleanedAt);
  const expiredId = randomUUID(), expiredKey = `${owner.workspaceId}/uploads/${expiredId}/parts/1/${checksum}`;
  await objects.putImmutable(expiredKey, bytes);
  await prisma.uploadSession.create({ data: { ...cleaned, id: expiredId, idempotencyKey: randomUUID(), status: 'UPLOADING', expiresAt: new Date(0),
    cleanupAttempts: 0, cleanupClaimId: null, cleanupLeaseExpiresAt: null, cleanupNextAttemptAt: null, cleanupErrorCode: null, cleanedAt: null,
    parts: [{ partNumber: 1, sizeBytes: bytes.length, checksum, objectKey: expiredKey }] } });
  await prisma.workspaceMembership.updateMany({ where: { workspaceId: owner.workspaceId, userId: owner.userId }, data: { isDeleted: true } });
  expect(expectOk(await job()).sent).toBe(1);
  expect((await prisma.uploadSession.findUniqueOrThrow({ where: { id: expiredId } })).status).toBe('FAILED');
  await expect(objects.read(expiredKey)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await prisma.auditLog.count({ where: { entityId: session.id, action: 'UPLOAD.OBJECTS_CLEANED' } })).toBe(2);
  await expect(prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'UPLOADING' } })).rejects.toThrow();
});
