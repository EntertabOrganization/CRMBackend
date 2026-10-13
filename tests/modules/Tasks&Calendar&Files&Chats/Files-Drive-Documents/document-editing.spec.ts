import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { EnvironmentEditingProvider } from '@/src/server/collab/files/editor-provider';
import { b, collabApp } from '../support/domain';
async function fixture() {
  const c = await collabApp(), f = c.collab.files, editing = c.collab.editing, objects = new Map<string, Buffer>();
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Editor' })), root = f.storages.root(c.owner, storage.id);
  f.uploads.configure({ async putImmutable(key, bytes) { objects.set(key, bytes); }, async read(key) { return objects.get(key)!; } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const bytes = Buffer.from('original text'), checksum = createHash('sha256').update(bytes).digest('hex');
  const upload = f.uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'edit.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, upload.id, b({ partNumber: 1, dataBase64: bytes.toString('base64'), checksum }));
  const receipt = await f.uploads.complete(c.owner, upload.id, b());
  return { c, f, editing, objects, fileId: receipt.resultFileId! };
}
async function start(x: Awaited<ReturnType<typeof fixture>>, mode = 'EXCLUSIVE_LOCK') {
  const ticket = x.editing.reserve(x.c.owner, x.fileId, b({ mode }));
  const opened = await x.editing.open(ticket), session = x.editing.activate(x.c.owner, ticket); return { ticket, opened, session };
}
it('opens private text with an atomic lease and safe metadata projections', async () => {
  const x = await fixture(), s = await start(x);
  expect(s.opened.dataBase64).toBe(Buffer.from('original text').toString('base64'));
  await expectAppError(() => x.editing.reserve(x.c.owner, x.fileId, b()), 'FILE_LOCKED', 409);
  const safe = x.editing.get(x.c.owner, s.session.id);
  for (const field of ['providerSessionId', 'saveRequestHash', 'uploadSessionId', 'lockToken', 'cleanupClaimId']) expect(safe).not.toHaveProperty(field);
  expect(JSON.stringify(x.c.state.documentEditSessions)).not.toContain(s.ticket.lockToken);
});
it('publishes exactly one immutable Version across callback retries and releases the lease', async () => {
  const x = await fixture(), s = await start(x), dataBase64 = Buffer.from('saved text').toString('base64');
  const request = b({ version: s.session.version, lockToken: s.ticket.lockToken, dataBase64 });
  const t = x.editing.beginSave(x.c.owner, s.session.id, request), content = await x.editing.saveContent(t);
  const uploadId = x.editing.stageSave(x.c.owner, s.session.id, t.hash, content, s.ticket.lockToken);
  await expectAppError(() => x.f.uploads.get(x.c.owner, uploadId), 'UPLOAD_SESSION_NOT_FOUND', 404);
  await expectAppError(() => x.f.uploads.complete(x.c.owner, uploadId, b()), 'UPLOAD_SESSION_NOT_FOUND', 404);
  await x.editing.writePart(x.c.owner, s.session.id, t.hash, 1, content.bytes, s.ticket.lockToken);
  const saved = await x.editing.finishSave(x.c.owner, s.session.id, t.hash, s.ticket.lockToken);
  expect(saved.status).toBe('COMPLETED'); expect(x.c.state.driveFileVersions.filter(v => v.fileId === x.fileId)).toHaveLength(2);
  expect(x.editing.beginSave(x.c.owner, s.session.id, request).completed?.resultVersionId).toBe(saved.resultVersionId);
  expect((await x.editing.finishSave(x.c.owner, s.session.id, t.hash, s.ticket.lockToken)).resultVersionId).toBe(saved.resultVersionId);
  expect(x.c.state.fileLocks.find(r => r.id === s.session.lockId)!.releasedAt).not.toBeNull();
  await expectAppError(() => x.editing.beginSave(x.c.owner, s.session.id, b({ dataBase64: Buffer.from('different').toString('base64') })), 'EDIT_SAVE_CONFLICT', 409);
});
it('rejects stale source Versions while preserving concurrent collaborative history', async () => {
  const x = await fixture(), a = await start(x, 'COLLABORATIVE'), z = await start(x, 'COLLABORATIVE');
  const t = x.editing.beginSave(x.c.owner, a.session.id, b({ version: a.session.version, dataBase64: Buffer.from('winner').toString('base64') })), content = await x.editing.saveContent(t);
  x.editing.stageSave(x.c.owner, a.session.id, t.hash, content); await x.editing.writePart(x.c.owner, a.session.id, t.hash, 1, content.bytes);
  await x.editing.finishSave(x.c.owner, a.session.id, t.hash);
  await expectAppError(() => x.editing.beginSave(x.c.owner, z.session.id, b({ version: z.session.version, dataBase64: 'eA==' })), 'RESOURCE_VERSION_CONFLICT', 409);
  expect(x.c.state.driveFileVersions.filter(v => v.fileId === x.fileId)).toHaveLength(2);
});
it('cannot revive an expired session and cleans its lease before replacement', async () => {
  const x = await fixture(), s = await start(x), spy = jest.spyOn(x.c.collab.support, 'now').mockReturnValue(new Date(s.session.expiresAt.getTime() + 1));
  try {
    await expectAppError(() => x.editing.heartbeat(x.c.owner, s.session.id, b({ version: s.session.version, lockToken: s.ticket.lockToken })), 'EDIT_SESSION_EXPIRED', 410);
    expect(x.editing.expireDue(10)).toBe(1); expect(x.editing.get(x.c.owner, s.session.id).status).toBe('EXPIRED');
    expect(x.editing.reserve(x.c.owner, x.fileId, b()).id).not.toBe(s.session.id);
  } finally { spy.mockRestore(); }
});
it('compensates failed editor opening and force release schedules provider cleanup', async () => {
  const x = await fixture(), base = new EnvironmentEditingProvider();
  x.editing.configure({ assertConfigured() {}, supports: () => true, open: async () => { throw new Error('provider down'); }, save: base.save.bind(base), close: base.close.bind(base) });
  const ticket = x.editing.reserve(x.c.owner, x.fileId, b()); await expectAppError(() => x.editing.open(ticket), 'EDIT_PROVIDER_ERROR', 502);
  x.editing.compensate(ticket); expect(x.editing.get(x.c.owner, ticket.id).status).toBe('ABORTED');
  expect(x.c.state.documentEditSessions.find(r => r.id === ticket.id)!.cleanupRequired).toBe(true);
  x.editing.configure(base); const s = await start(x);
  x.c.collab.locks.forceRelease(x.c.owner, x.fileId, s.session.lockId!, b({ version: 1, reason: 'lost browser' }));
  expect(x.editing.get(x.c.owner, s.session.id).status).toBe('ABORTED');
});
it('aborts unaccepted staging, retains original bytes and fences cleanup retries', async () => {
  const x = await fixture(), s = await start(x), t = x.editing.beginSave(x.c.owner, s.session.id, b({ version: s.session.version, lockToken: s.ticket.lockToken, dataBase64: 'eA==' }));
  const content = await x.editing.saveContent(t), uploadId = x.editing.stageSave(x.c.owner, s.session.id, t.hash, content, s.ticket.lockToken);
  const current = x.editing.get(x.c.owner, s.session.id);
  x.editing.abort(x.c.owner, s.session.id, b({ version: current.version, lockToken: s.ticket.lockToken }));
  expect(x.c.state.uploadSessions.find(r => r.id === uploadId)!.status).toBe('ABORTED');
  expect(x.c.state.fileObjectGarbage.some(r => r.objectKey.includes(uploadId))).toBe(true);
  expect(x.c.state.driveFileVersions.filter(v => v.fileId === x.fileId)).toHaveLength(1);
  const worker = x.c.collab.editingCleanup, now = new Date(), token = randomUUID();
  expect(worker.claimDue(10, token, now)).toContain(s.session.id); const job = worker.prepare(s.session.id, token, now)!;
  expect(worker.finish({ ...job, token: randomUUID() }, { kind: 'SENT', reference: null }, now)).toBe(false);
  expect(worker.finish(job, await worker.deliver(job), now)).toBe(true);
  expect(x.c.state.documentEditSessions.find(r => r.id === s.session.id)!.cleanupRequired).toBe(false);
});
it('does not reveal another tenant session and refuses malformed content before claiming a save', async () => {
  const x = await fixture(), s = await start(x), foreign = await x.c.foreignActor();
  await expectAppError(() => x.editing.get(foreign, s.session.id), 'EDIT_SESSION_NOT_FOUND', 404);
  await expectAppError(() => x.editing.beginSave(x.c.owner, s.session.id, b({ version: s.session.version, lockToken: s.ticket.lockToken, dataBase64: '/w==' })), 'VALIDATION_ERROR', 400);
  expect(x.c.state.documentEditSessions.find(r => r.id === s.session.id)!.saveRequestHash).toBeNull();
});
