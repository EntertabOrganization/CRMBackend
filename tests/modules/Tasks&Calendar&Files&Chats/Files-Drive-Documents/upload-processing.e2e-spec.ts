import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { api } from '@/tests/support/api';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { call, db, disconnect, expectError, expectOk, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180_000);
let server: Server, endpoint: string, verdict: 'PENDING' | 'CLEAN' | 'BLOCKED' | 'FAIL' = 'PENDING';
const internalToken = randomUUID(), providerToken = randomUUID(), requests: Buffer[] = [];
const previous = { url: process.env.FILE_PROCESSOR_URL, token: process.env.FILE_PROCESSOR_TOKEN, internal: process.env.INTERNAL_JOB_TOKEN };
beforeAll(async () => {
  await prepareCollabDatabase();
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); requests.push(bytes);
    expect(request.headers.authorization).toBe(`Bearer ${providerToken}`);
    response.setHeader('content-type', 'application/json');
    if (verdict === 'FAIL') { response.writeHead(503); response.end('private provider diagnostic'); return; }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    expect(request.headers['x-content-sha256']).toBe(checksum);
    response.end(JSON.stringify({ checksum, scanStatus: verdict === 'BLOCKED' ? 'BLOCKED' : 'CLEAN', processed: verdict !== 'PENDING' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/process`;
  process.env.FILE_PROCESSOR_URL = endpoint; process.env.FILE_PROCESSOR_TOKEN = providerToken; process.env.INTERNAL_JOB_TOKEN = internalToken;
});
afterAll(async () => {
  for (const [key, value] of Object.entries({ FILE_PROCESSOR_URL: previous.url, FILE_PROCESSOR_TOKEN: previous.token, INTERNAL_JOB_TOKEN: previous.internal })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await disconnect();
});
const job = (name = 'upload-processing') => api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: name }, headers: { 'x-internal-job-token': internalToken }, body: { limit: 1 } });

it('processes real sealed bytes through the configured HTTP adapter and retries after creator, folder and quota changes', async () => {
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'upload-processing' }, body: {} }), 401, 'UNAUTHENTICATED');
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'upload-processing' }, headers: { 'x-internal-job-token': internalToken }, body: { limit: 0 } }), 400, 'VALIDATION_ERROR');
  const owner = await register('processing-owner');
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Processing' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('sealed processing input'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'pending.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, dataBase64: bytes.toString('base64'), checksum } }));
  const accepted = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  expect(accepted.status).toBe('PROCESSING');
  expect(expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} })).resultVersionId).toBe(accepted.resultVersionId);
  expect(requests).toHaveLength(1);
  const prisma = await db();
  expect(expectOk(await job('upload-cleanup')).sent).toBe(1);
  await expect(new LocalObjectStorage().read(`${owner.workspaceId}/uploads/${session.id}/parts/1/${checksum}`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} })).resultVersionId).toBe(accepted.resultVersionId);
  const sealed = await prisma.driveFileVersion.findUniqueOrThrow({ where: { id: accepted.resultVersionId } });
  expect(await new LocalObjectStorage().read(sealed.objectKey)).toEqual(bytes);
  const file = await prisma.driveFile.findUniqueOrThrow({ where: { id: accepted.resultFileId } });
  const destination = expectOk(await call(owner, 'POST', 'folders', { body: { storageId: storage.id, parentFolderId: root.id, name: 'Moved' } }));
  expectOk(await call(owner, 'PATCH', `files/${file.id}/move`, { body: { folderId: destination.id, version: file.version } }));
  verdict = 'FAIL'; await prisma.uploadSession.update({ where: { id: session.id }, data: { processingNextAttemptAt: new Date(0) } });
  expect(expectOk(await job()).failed).toBe(1);
  expect((await prisma.driveFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('PROCESSING');
  const retry = await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } });
  expect(retry.processingErrorCode).toBe('FILE_PROCESSOR_UNAVAILABLE'); expect(retry.processingClaimId).toBeNull();
  await prisma.projectFileStorage.update({ where: { id: storage.id }, data: { isReadOnly: true } });
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } });
  await prisma.workspace.update({ where: { id: workspace.id }, data: { settings: { ...(workspace.settings as Record<string, unknown>), fileStorageQuotaBytes: 0 } } });
  await prisma.workspaceMembership.updateMany({ where: { workspaceId: owner.workspaceId, userId: owner.userId }, data: { isDeleted: true } });
  verdict = 'CLEAN'; await prisma.uploadSession.update({ where: { id: session.id }, data: { processingNextAttemptAt: new Date(0) } });
  const jobs = await Promise.all([job(), job()]);
  expect(jobs.map(result => expectOk(result).sent).reduce((a, b) => a + b, 0)).toBe(1);
  expect(await prisma.driveFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'ACTIVE', folderId: destination.id, currentVersionId: accepted.resultVersionId });
  expect((await prisma.driveFileVersion.findUniqueOrThrow({ where: { id: accepted.resultVersionId } })).processedAt).not.toBeNull();
  expect(await prisma.driveFileVersion.count({ where: { fileId: file.id } })).toBe(1);
  expect((await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('COMPLETED');
  expect(requests).toHaveLength(3); expect(requests.every(value => value.equals(bytes))).toBe(true);
  expect(await prisma.auditLog.count({ where: { entityId: session.id, action: 'UPLOAD.PROCESSING_RETRY' } })).toBe(1);
});

it('updates historical aliases atomically without replacing newer content or restoring trashed Files', async () => {
  const owner = await register('processing-history');
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'History' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const prisma = await db();
  async function upload(text: string, fileId?: string) {
    const bytes = Buffer.from(text), checksum = createHash('sha256').update(bytes).digest('hex');
    const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: {
      targetFolderId: root.id, desiredFileName: 'history.txt', expectedSizeBytes: bytes.length,
      expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID(),
      ...(fileId ? { fileId, conflictMode: 'CREATE_VERSION', version: (await prisma.driveFile.findUniqueOrThrow({ where: { id: fileId } })).version } : {}),
    } }));
    expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, dataBase64: bytes.toString('base64'), checksum } }));
    return expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  }
  verdict = 'PENDING'; const history = await upload('historical pending bytes');
  verdict = 'CLEAN'; const current = await upload('new clean bytes', history.resultFileId);
  const copied = expectOk(await call(owner, 'POST', `files/${history.resultFileId}/copy`, { body: { folderId: root.id, name: 'copy.txt' } }));
  expectOk(await call(owner, 'DELETE', `files/${copied.id}`, { body: { version: copied.version } }));
  const old = await prisma.driveFileVersion.findUniqueOrThrow({ where: { id: history.resultVersionId } });
  expect(await prisma.driveFileVersion.count({ where: { objectKey: old.objectKey } })).toBe(2);
  await prisma.uploadSession.update({ where: { id: history.id }, data: { processingNextAttemptAt: new Date(0) } });
  verdict = 'BLOCKED'; expect(expectOk(await job()).sent).toBe(1);
  expect((await prisma.driveFileVersion.findMany({ where: { objectKey: old.objectKey } })).every(row => row.scanStatus === 'BLOCKED')).toBe(true);
  expect(await prisma.driveFile.findUniqueOrThrow({ where: { id: history.resultFileId } })).toMatchObject({ currentVersionId: current.resultVersionId, status: 'ACTIVE' });
  expect(await prisma.driveFile.findUniqueOrThrow({ where: { id: copied.id } })).toMatchObject({ status: 'TRASHED', statusBeforeTrash: 'ACTIVE' });
  await expect(prisma.driveFileVersion.update({ where: { id: old.id }, data: { scanStatus: 'CLEAN' } })).rejects.toThrow();
  verdict = 'PENDING'; const pending = await upload('pending trashed current', history.resultFileId);
  const file = await prisma.driveFile.findUniqueOrThrow({ where: { id: history.resultFileId } });
  expectOk(await call(owner, 'DELETE', `files/${file.id}`, { body: { version: file.version } }));
  await prisma.uploadSession.update({ where: { id: pending.id }, data: { processingNextAttemptAt: new Date(0) } });
  verdict = 'CLEAN'; expect(expectOk(await job()).sent).toBe(1);
  const trashed = await prisma.driveFile.findUniqueOrThrow({ where: { id: file.id } });
  expect(trashed).toMatchObject({ status: 'TRASHED', statusBeforeTrash: 'ACTIVE', currentVersionId: pending.resultVersionId });
  expect(expectOk(await call(owner, 'PATCH', `files/${file.id}/restore`, { body: { version: trashed.version } })).status).toBe('ACTIVE');
  expect(await prisma.driveFileVersion.count({ where: { fileId: file.id } })).toBe(3);
});
