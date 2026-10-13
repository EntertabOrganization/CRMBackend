import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { EnvironmentEditingProvider } from '@/src/server/collab/files/editor-provider';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000); beforeAll(prepareCollabDatabase); afterAll(disconnect);
async function fixture() {
  const owner = await register('edit-session'), prisma = await db(), { appContext } = await import('@/src/server/app-context');
  appContext.collab.editing.configure(new EnvironmentEditingProvider());
  appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Editing' } })), root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('source'), checksum = createHash('sha256').update(bytes).digest('hex');
  const upload = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'edit.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${upload.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
  const receipt = expectOk(await call(owner, 'POST', `upload-sessions/${upload.id}/complete`, { body: {} }));
  return { owner, prisma, appContext, fileId: receipt.resultFileId as string };
}
it('starts, lists, reads, heartbeats and completes once across concurrent callback retries', async () => {
  const x = await fixture(), opened = await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} }), session = expectOk(opened);
  expect(session.dataBase64).toBe(Buffer.from('source').toString('base64')); expect(session.lockToken).toBeTruthy();
  expectOk(await call(x.owner, 'GET', `files/${x.fileId}/edit-sessions`)).forEach((r: any) => expect(r).not.toHaveProperty('lockToken'));
  const read = expectOk(await call(x.owner, 'GET', `edit-sessions/${session.id}`)); expect(read).not.toHaveProperty('providerSessionId');
  const heartbeat = expectOk(await call(x.owner, 'POST', `edit-sessions/${session.id}/heartbeat`, { body: { version: session.version, lockToken: session.lockToken } }));
  const body = { version: heartbeat.version, lockToken: session.lockToken, dataBase64: Buffer.from('saved').toString('base64') };
  const results = await Promise.all([call(x.owner, 'POST', `edit-sessions/${session.id}/complete`, { body }), call(x.owner, 'POST', `edit-sessions/${session.id}/complete`, { body })]);
  const saved = results.map(r => expectOk(r)); expect(saved[0].resultVersionId).toBe(saved[1].resultVersionId);
  expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(2);
  expect(await x.prisma.outboxEvent.count({ where: { entityId: session.id, eventType: 'FILE_EDIT_SESSION_COMPLETED' } })).toBe(1);
  const persisted = await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: session.id } });
  expect(persisted.status).toBe('COMPLETED'); expect(persisted.uploadSessionId).toBeTruthy();
  expect((await x.prisma.fileLock.findUniqueOrThrow({ where: { id: session.lockId } })).releasedAt).not.toBeNull();
  expectError(await call(x.owner, 'POST', `upload-sessions/${persisted.uploadSessionId}/complete`, { body: {} }), 404, 'UPLOAD_SESSION_NOT_FOUND');
  await expect(x.prisma.documentEditSession.update({ where: { id: session.id }, data: { resultVersionId: randomUUID(), version: persisted.version + 1 } })).rejects.toThrow(/EDIT_SESSION_PROOF_IMMUTABLE/);
});
it('authenticates every route before body validation and hides foreign or non-owner sessions', async () => {
  const x = await fixture(), s = expectOk(await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} }));
  for (const [method, path] of [['POST', `files/${x.fileId}/edit-sessions`], ['GET', `files/${x.fileId}/edit-sessions`], ['GET', `edit-sessions/${s.id}`], ['POST', `edit-sessions/${s.id}/heartbeat`], ['POST', `edit-sessions/${s.id}/complete`], ['POST', `edit-sessions/${s.id}/abort`]] as const)
    expectError(await call(null, method, path, method === 'GET' ? {} : { body: { unexpected: true } }), 401);
  const foreign = await register('foreign-editor'); expectError(await call(foreign, 'GET', `edit-sessions/${s.id}`), 404, 'EDIT_SESSION_NOT_FOUND');
  const other = await member(x.owner, 'other-editor', [['file.edit', 'WORKSPACE']]);
  expectError(await call(other, 'GET', `edit-sessions/${s.id}`), 404, 'EDIT_SESSION_NOT_FOUND');
});
it('serializes exclusive start races and force release irreversibly ends the editor', async () => {
  const x = await fixture(), starts = await Promise.all([call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} }), call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} })]);
  expect(starts.map(r => r.status).sort()).toEqual([200, 409]); const s = expectOk(starts.find(r => r.status === 200)!);
  expectOk(await call(x.owner, 'POST', `files/${x.fileId}/locks/${s.lockId}/force-release`, { body: { version: 1, reason: 'lost browser' } }));
  expect(expectOk(await call(x.owner, 'GET', `edit-sessions/${s.id}`)).status).toBe('ABORTED');
  expectError(await call(x.owner, 'POST', `edit-sessions/${s.id}/heartbeat`, { body: { version: s.version, lockToken: s.lockToken } }), 410, 'EDIT_SESSION_EXPIRED');
});
it('compensates broker failure durably and retains aborted-session evidence through cleanup', async () => {
  const x = await fixture(), base = new EnvironmentEditingProvider();
  x.appContext.collab.editing.configure({ assertConfigured() {}, supports: () => true, open: async () => { throw new (await import('@/src/server/errors')).AppError('EDIT_PROVIDER_ERROR', 'Unavailable', 502); }, save: base.save.bind(base), close: base.close.bind(base) });
  expectError(await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} }), 502, 'EDIT_PROVIDER_ERROR');
  const row = await x.prisma.documentEditSession.findFirstOrThrow({ where: { fileId: x.fileId } });
  expect(row.status).toBe('ABORTED'); expect(row.cleanupRequired).toBe(true);
  expect((await x.prisma.fileLock.findUniqueOrThrow({ where: { id: row.lockId! } })).releasedAt).not.toBeNull();
  const { runDocumentEditCleanup } = await import('@/src/server/response'); await runDocumentEditCleanup(100);
  expect((await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: row.id } })).cleanupRequired).toBe(false);
  expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(1);
});
it('aborts without replacing content and rejects malformed saves before claiming receipts', async () => {
  const x = await fixture(), s = expectOk(await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} }));
  expectError(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body: { version: s.version, lockToken: s.lockToken, dataBase64: '/w==' } }), 400, 'VALIDATION_ERROR');
  expect((await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: s.id } })).saveRequestHash).toBeNull();
  const aborted = expectOk(await call(x.owner, 'POST', `edit-sessions/${s.id}/abort`, { body: { version: s.version, lockToken: s.lockToken } })); expect(aborted.status).toBe('ABORTED');
  expectOk(await call(x.owner, 'POST', `edit-sessions/${s.id}/abort`, { body: { lockToken: s.lockToken } }));
  expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(1);
});
it('reauthorizes after provider I/O so revoked File access cannot stage or publish bytes', async () => {
  const x = await fixture(), actor = await member(x.owner, 'revoked-editor', [['file.edit', 'WORKSPACE'], ['file.lock', 'WORKSPACE']]);
  const file = expectOk(await call(x.owner, 'GET', `files/${x.fileId}`));
  expectOk(await call(x.owner, 'PUT', `files/${x.fileId}/permissions`, { body: { version: file.version, assignments: [{ subjectType: 'USER', subjectId: actor.userId, permissionLevel: 'EDIT', inheritanceMode: 'INHERIT' }] } }));
  const s = expectOk(await call(actor, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} })), base = new EnvironmentEditingProvider();
  x.appContext.collab.editing.configure({ assertConfigured: base.assertConfigured.bind(base), supports: base.supports.bind(base), open: base.open.bind(base), close: base.close.bind(base),
    async save(identity, mime, input, signal) {
      const current = expectOk(await call(x.owner, 'GET', `files/${x.fileId}`));
      expectOk(await call(x.owner, 'PUT', `files/${x.fileId}/permissions`, { body: { version: current.version, assignments: [] } }));
      return base.save(identity, mime, input, signal);
    } });
  expectError(await call(actor, 'POST', `edit-sessions/${s.id}/complete`, { body: { version: s.version, lockToken: s.lockToken, dataBase64: 'eA==' } }), 404, 'FILE_NOT_FOUND');
  const persisted = await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: s.id } }); expect(persisted.uploadSessionId).toBeNull();
  expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(1);
});
it('keeps the durable save receipt after a storage failure and resumes without duplicate Versions', async () => {
  const x = await fixture(), s = expectOk(await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} })), objects = new LocalObjectStorage();
  let fail = true;
  x.appContext.collab.files.uploads.configure({ read: objects.read.bind(objects), async putImmutable(key, bytes) {
    await objects.putImmutable(key, bytes);
    if (fail) { fail = false; throw new (await import('@/src/server/errors')).AppError('FILE_STORAGE_UNAVAILABLE', 'Unavailable', 503); }
  } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const body = { version: s.version, lockToken: s.lockToken, dataBase64: Buffer.from('resumable').toString('base64') };
  expectError(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body }), 503, 'FILE_STORAGE_UNAVAILABLE');
  const staged = await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: s.id } }); expect(staged.uploadSessionId).toBeTruthy();
  expect((await x.prisma.uploadSession.findUniqueOrThrow({ where: { id: staged.uploadSessionId! } })).parts).toEqual([]);
  const saved = expectOk(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body })); expect(saved.status).toBe('COMPLETED');
  expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(2);
  expect(await x.prisma.uploadSession.count({ where: { editSessionId: s.id } })).toBe(1);
});
it('orchestrates an authenticated broker with bound receipts and private launch credentials', async () => {
  const x = await fixture(), previous = { url: process.env.FILE_EDITOR_URL, token: process.env.FILE_EDITOR_TOKEN }, requests: Array<{ path: string; authorization?: string; body: any }> = [];
  const bytes = Buffer.from('broker-saved'), checksum = createHash('sha256').update(bytes).digest('hex'); let mismatch = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url!, authorization: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...body, fileId: mismatch ? randomUUID() : body.fileId, providerSessionId: body.id, editorUrl: 'https://editor.example/session',
      mimeType: 'text/plain', dataBase64: bytes.toString('base64'), checksum }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.FILE_EDITOR_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/editor`; process.env.FILE_EDITOR_TOKEN = 'editing-e2e-broker-secret';
  try {
    const s = expectOk(await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: { provider: 'CUSTOM' } }));
    expect(s.editorUrl).toBe('https://editor.example/session'); expect(s).not.toHaveProperty('dataBase64');
    expect(requests[0].authorization).toBe('Bearer editing-e2e-broker-secret'); expect(requests[0].body).not.toHaveProperty('lockToken');
    const safe = expectOk(await call(x.owner, 'GET', `edit-sessions/${s.id}`)); expect(safe).not.toHaveProperty('editorUrl');
    expectError(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body: { version: s.version, lockToken: s.lockToken, dataBase64: 'eA==', saveId: 'receipt-1' } }), 400, 'VALIDATION_ERROR');
    const body = { version: s.version, lockToken: s.lockToken, saveId: 'receipt-1' }; mismatch = true;
    const rejected = await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body }); expectError(rejected, 502, 'EDIT_PROVIDER_ERROR');
    expect(JSON.stringify(rejected.body)).not.toContain('editing-e2e-broker-secret');
    expect((await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: s.id } })).uploadSessionId).toBeNull(); mismatch = false;
    const saved = expectOk(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body })); expect(saved.status).toBe('COMPLETED');
    expect((await x.prisma.driveFileVersion.findUniqueOrThrow({ where: { id: saved.resultVersionId } })).checksum).toBe(checksum);
    const { runDocumentEditCleanup } = await import('@/src/server/response'); await runDocumentEditCleanup(100);
    expect(requests.some(r => r.path.endsWith('/sessions/close') && r.body.id === s.id)).toBe(true);
    expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous.url === undefined) delete process.env.FILE_EDITOR_URL; else process.env.FILE_EDITOR_URL = previous.url;
    if (previous.token === undefined) delete process.env.FILE_EDITOR_TOKEN; else process.env.FILE_EDITOR_TOKEN = previous.token;
  }
});
it('retains one accepted Version through processor outages and immutable terminal-session cleanup', async () => {
  const x = await fixture(), s = expectOk(await call(x.owner, 'POST', `files/${x.fileId}/edit-sessions`, { body: {} }));
  x.appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process() { throw new Error('scanner unavailable'); } });
  const body = { version: s.version, lockToken: s.lockToken, dataBase64: 'eA==' }, saved = expectOk(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body }));
  expect(saved.status).toBe('COMPLETED');
  const upload = await x.prisma.uploadSession.findFirstOrThrow({ where: { editSessionId: s.id } }); expect(upload.status).toBe('PROCESSING');
  expect((await x.prisma.driveFileVersion.findUniqueOrThrow({ where: { id: saved.resultVersionId } })).scanStatus).toBe('PENDING');
  expect(expectOk(await call(x.owner, 'POST', `edit-sessions/${s.id}/complete`, { body })).resultVersionId).toBe(saved.resultVersionId);
  await expect(x.prisma.uploadSession.update({ where: { id: upload.id }, data: { editSessionId: null, version: upload.version + 1 } })).rejects.toThrow(/EDIT_SESSION_PROOF_IMMUTABLE/);
  const { runDocumentEditCleanup } = await import('@/src/server/response'); await runDocumentEditCleanup(100);
  expect((await x.prisma.documentEditSession.findUniqueOrThrow({ where: { id: s.id } })).resultVersionId).toBe(saved.resultVersionId);
  expect(await x.prisma.driveFileVersion.count({ where: { fileId: x.fileId } })).toBe(2);
});
