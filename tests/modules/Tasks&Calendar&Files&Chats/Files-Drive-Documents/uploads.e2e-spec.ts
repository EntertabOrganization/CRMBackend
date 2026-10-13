import { createHash, randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
jest.setTimeout(180_000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);
it('runs persistent upload routes with real private bytes, scanner gates, retries and tenant checks', async () => {
  const owner = await register('uploads-owner'), foreign = await register('uploads-foreign'), denied = await member(owner, 'uploads-denied', []);
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Uploads' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('verified upload'), checksum = createHash('sha256').update(bytes).digest('hex');
  const input = { targetFolderId: root.id, desiredFileName: 'sample.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() };
  expectError(await call(owner, 'POST', 'upload-sessions', { body: input, headers: { 'content-length': '65537' } }), 413, 'REQUEST_BODY_TOO_LARGE');
  expectError(await call(null, 'POST', 'upload-sessions', { body: input, workspaceId: owner.workspaceId, headers: { 'content-length': '65537' } }), 401, 'UNAUTHENTICATED');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: input }));
  expect(expectOk(await call(owner, 'POST', 'upload-sessions', { body: input })).id).toBe(session.id);
  for (const [method, path, body] of [['POST', 'upload-sessions', input], ['GET', `upload-sessions/${session.id}`, undefined],
    ['POST', `upload-sessions/${session.id}/parts`, { partNumber: 1, dataBase64: bytes.toString('base64'), checksum }],
    ['POST', `upload-sessions/${session.id}/complete`, {}], ['POST', `upload-sessions/${session.id}/abort`, {}]] as const) {
    const options = body ? { body } : {};
    expectError(await call(null, method, path, { ...options, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(denied, method, path, options), 403, 'PERMISSION_DENIED');
    expectError(await call(foreign, method, path, options), 404, path === 'upload-sessions' ? 'FOLDER_NOT_FOUND' : 'UPLOAD_SESSION_NOT_FOUND');
  }
  const part = { partNumber: 1, dataBase64: bytes.toString('base64'), checksum };
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: part }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: part }));
  expectError(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }), 503, 'FILE_PROCESSOR_UNAVAILABLE');
  const { appContext } = await import('@/src/server/app-context');
  appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process(value) { expect(value).toEqual(bytes); return { scanStatus: 'CLEAN', processed: true }; } });
  const complete = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  expect(expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} })).resultVersionId).toBe(complete.resultVersionId);
  expect(expectOk(await call(owner, 'GET', `files/${complete.resultFileId}`)).status).toBe('ACTIVE');
  const prisma = await db();
  expect(await prisma.driveFileVersion.count({ where: { fileId: complete.resultFileId } })).toBe(1);
  const version = await prisma.driveFileVersion.findUniqueOrThrow({ where: { id: complete.resultVersionId } });
  expect(await new LocalObjectStorage().read(version.objectKey)).toEqual(bytes);
  const file = await prisma.driveFile.findUniqueOrThrow({ where: { id: complete.resultFileId } });
  expectError(await call(owner, 'POST', `files/${file.id}/versions`, { body: {}, headers: { 'content-length': '65537' } }), 413, 'REQUEST_BODY_TOO_LARGE');
  const second = expectOk(await call(owner, 'POST', `files/${file.id}/versions`, { body: { expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', version: file.version, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${second.id}/abort`, { body: {} }));
  expectError(await call(owner, 'POST', `upload-sessions/${second.id}/parts`, { body: part }), 409, 'UPLOAD_SESSION_STATE_INVALID');
  const versionOnly = await member(owner, 'uploads-version-only', [['file.version_create', 'WORKSPACE']]);
  const acl = expectOk(await call(owner, 'PUT', `files/${file.id}/permissions`, { body: { version: file.version, assignments: [
    { subjectType: 'USER', subjectId: owner.userId, permissionLevel: 'FULL', inheritanceMode: 'OVERRIDE' },
    { subjectType: 'USER', subjectId: versionOnly.userId, permissionLevel: 'EDIT', inheritanceMode: 'OVERRIDE' },
  ] } }));
  const versionSession = expectOk(await call(versionOnly, 'POST', `files/${file.id}/versions`, { body: { expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', version: acl.version, idempotencyKey: randomUUID() } }));
  expectOk(await call(versionOnly, 'POST', `upload-sessions/${versionSession.id}/parts`, { body: part }));
  expectOk(await call(versionOnly, 'POST', `upload-sessions/${versionSession.id}/complete`, { body: {} }));
  expect(await prisma.driveFileVersion.count({ where: { fileId: file.id } })).toBe(2);
  expect(await prisma.auditLog.count({ where: { entityId: session.id } })).toBeGreaterThanOrEqual(3);
  const { runStateUnit } = await import('@/src/server/response');
  await runStateUnit(async () => {
    appContext.store.state.workspaces.find(row => row.id === owner.workspaceId)!.settings.fileStorageQuotaBytes = bytes.length * 3;
  });
  const reservations = await Promise.all(['race-a', 'race-b'].map(name => call(owner, 'POST', 'upload-sessions', {
    body: { ...input, desiredFileName: `${name}.txt`, idempotencyKey: randomUUID() },
  })));
  expect(reservations.map(result => result.status).sort()).toEqual([200, 409]);
  expectError(reservations.find(result => result.status === 409)!, 409, 'STORAGE_QUOTA_EXCEEDED');
  expect(await prisma.uploadSession.count({ where: { workspaceId: owner.workspaceId, status: 'CREATED' } })).toBe(1);
});
