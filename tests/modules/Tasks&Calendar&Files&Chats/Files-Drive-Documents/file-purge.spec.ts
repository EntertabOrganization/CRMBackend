import { createHash, randomUUID } from 'node:crypto';
import { b, collabApp, perms } from '../support/domain';
import { expectAppError } from '@/tests/support/domain';
async function fixture(processed = true) {
  const c = await collabApp(), f = c.collab.files, bytes = Buffer.from('retained immutable bytes');
  c.owner.workspace.settings.fileRetentionDays = 0;
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Purge' })), root = f.storages.root(c.owner, storage.id);
  const objects = new Map<string, Buffer>(); let removeFails = false;
  f.uploads.configure({ async putImmutable(key, value) { objects.set(key, Buffer.from(value)); }, async read(key) { return objects.get(key)!; },
    async remove(key) { if (removeFails) throw new Error('private provider failure'); objects.delete(key); }, async purgeMultipart() {} },
    { async process() { return { scanStatus: 'CLEAN', processed }; } });
  async function upload(folderId = root.id, name = 'sample.txt') {
    const checksum = createHash('sha256').update(bytes).digest('hex'), input = { targetFolderId: folderId, desiredFileName: name,
      expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() };
    const session = f.uploads.create(c.owner, b(input));
    await f.uploads.part(c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
    const accepted = await f.uploads.complete(c.owner, session.id, b());
    const file = c.state.driveFiles.find(row => row.id === accepted.resultFileId)!;
    return { file, session, input, version: c.state.driveFileVersions.find(row => row.id === accepted.resultVersionId)! };
  }
  return { c, f, root, storage, objects, upload, failRemove: (value: boolean) => { removeFails = value; } };
}

it('purges metadata atomically but keeps shared bytes until the final logical reference is purged', async () => {
  const x = await fixture(), source = await x.upload();
  const copy = x.f.records.copy(x.c.owner, source.file.id, b({ folderId: x.root.id, name: 'copy.txt' }));
  x.f.records.trash(x.c.owner, source.file.id, b({ version: source.file.version }));
  expect(x.f.records.purge(x.c.owner, source.file.id, b({ version: source.file.version }))).toMatchObject({ deletedVersionCount: 1, queuedObjectCount: 0 });
  expect(x.objects.has(source.version.objectKey)).toBe(true); expect(x.c.state.fileObjectGarbage).toHaveLength(0);
  await expectAppError(() => x.f.uploads.complete(x.c.owner, source.session.id, b()), 'UPLOAD_SESSION_NOT_FOUND', 404);
  await expectAppError(() => x.f.uploads.create(x.c.owner, b(source.input)), 'UPLOAD_SESSION_PURGED', 410);
  x.f.records.trash(x.c.owner, copy.id, b({ version: copy.version }));
  expect(x.f.records.purge(x.c.owner, copy.id, b({ version: copy.version }))).toMatchObject({ deletedVersionCount: 1, queuedObjectCount: 1 });
  expect(x.objects.has(source.version.objectKey)).toBe(true); expect(x.c.state.driveFileVersions).toHaveLength(0);
  expect(x.c.state.auditLogs.some(row => row.action === 'FILE.DELETED' && row.entityId === source.file.id)).toBe(true);
});

it('preflights File, Version, ancestor and storage retention and requires full authorized access', async () => {
  const x = await fixture(), source = await x.upload(), denied = await x.c.memberActor('purge-denied', perms('WORKSPACE', 'file.read')), foreign = await x.c.foreignActor();
  await expectAppError(() => x.f.records.purge(x.c.owner, source.file.id, b({ version: source.file.version })), 'FILE_STATE_INVALID', 409);
  x.f.records.trash(x.c.owner, source.file.id, b({ version: source.file.version }));
  await expectAppError(() => x.f.records.purge(denied, source.file.id, b({ version: 2 })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.f.records.purge(foreign, source.file.id, b({ version: 2 })), 'FILE_NOT_FOUND', 404);
  await expectAppError(() => x.f.records.purge(x.c.owner, source.file.id, b({ version: 1 })), 'RESOURCE_VERSION_CONFLICT', 409);
  for (const resourceId of [source.file.id, source.version.id, x.root.id, x.storage.id]) {
    const hold = { id: randomUUID(), workspaceId: x.c.owner.workspaceId, category: 'FILE', resourceId, legalHold: true, expiresAt: new Date(0), createdAt: new Date() };
    x.c.state.retentionRecords.push(hold as any);
    await expectAppError(() => x.f.records.purge(x.c.owner, source.file.id, b({ version: x.c.state.driveFiles.find(row => row.id === source.file.id)!.version })), 'FILE_RETENTION_HOLD', 409);
    expect(x.c.state.fileObjectGarbage).toHaveLength(0); expect(x.c.state.driveFileVersions).toHaveLength(1);
    x.c.state.retentionRecords = [];
  }
});

it('purges folder content and cancels unaccepted uploads while keeping copied content outside the subtree', async () => {
  const x = await fixture(), folder = x.f.storages.createFolder(x.c.owner, b({ storageId: x.storage.id, parentFolderId: x.root.id, name: 'Tree' }));
  const source = await x.upload(folder.id);
  const copy = x.f.records.copy(x.c.owner, source.file.id, b({ folderId: x.root.id, name: 'outside.txt' }));
  const pending = x.f.uploads.create(x.c.owner, b({ ...source.input, desiredFileName: 'pending.txt', idempotencyKey: randomUUID() }));
  x.f.folders.trash(x.c.owner, folder.id, b({ version: folder.version }));
  const result = x.f.folders.purge(x.c.owner, folder.id, b({ version: folder.version }));
  expect(result).toMatchObject({ deletedFileCount: 1, deletedVersionCount: 1, queuedObjectCount: 0 });
  expect(x.c.state.driveFiles.map(row => row.id)).toEqual([copy.id]);
  expect(x.c.state.uploadSessions.find(row => row.id === pending.id)).toMatchObject({ status: 'FAILED', purgedAt: expect.any(Date) });
});

it('preserves processing for accepted content moved out of a purged original upload folder', async () => {
  const x = await fixture(false), folder = x.f.storages.createFolder(x.c.owner, b({ storageId: x.storage.id, parentFolderId: x.root.id, name: 'Original' }));
  const source = await x.upload(folder.id);
  x.f.records.move(x.c.owner, source.file.id, b({ folderId: x.root.id, version: source.file.version }));
  x.f.folders.trash(x.c.owner, folder.id, b({ version: folder.version })); x.f.folders.purge(x.c.owner, folder.id, b({ version: folder.version }));
  expect(x.c.state.uploadSessions[0].purgedAt).toBeFalsy();
  const now = new Date(Date.now() + 5000), token = randomUUID();
  expect(x.f.uploadProcessing.claimDue(1, token, now)).toEqual([source.session.id]);
});

it('retries physical cleanup, fences expired leases and sweeps again for late orphan writes', async () => {
  const x = await fixture(), source = await x.upload(), worker = x.f.objectGarbage;
  x.f.records.trash(x.c.owner, source.file.id, b({ version: source.file.version })); x.f.records.purge(x.c.owner, source.file.id, b({ version: source.file.version }));
  const now = new Date(), token = randomUUID(), [id] = worker.claimDue(1, token, now), old = worker.prepare(id, token, now)!;
  expect(worker.claimDue(1, randomUUID(), now)).toEqual([]);
  x.failRemove(true); expect(worker.finish(old, await worker.deliver(old), now)).toBe(true);
  expect(x.c.state.fileObjectGarbage[0].errorCode).toBe('FILE_OBJECT_CLEANUP_FAILED');
  const later = new Date(now.getTime() + 400_000), next = randomUUID(); worker.claimDue(1, next, later);
  const current = worker.prepare(id, next, later)!; x.failRemove(false);
  expect(worker.finish(current, await worker.deliver(current), later)).toBe(true);
  expect(worker.finish(old, { kind: 'SENT', reference: null }, later)).toBe(false);
  expect(x.objects.has(source.version.objectKey)).toBe(false);
  x.objects.set(source.version.objectKey, Buffer.from('late stale write'));
  const tomorrow = new Date(later.getTime() + 86400_001), sweep = randomUUID(); worker.claimDue(1, sweep, tomorrow);
  const ticket = worker.prepare(id, sweep, tomorrow)!; worker.finish(ticket, await worker.deliver(ticket), tomorrow);
  expect(x.objects.has(source.version.objectKey)).toBe(false);
});
