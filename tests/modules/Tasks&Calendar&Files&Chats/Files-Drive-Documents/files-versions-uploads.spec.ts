import { createHash, randomUUID } from 'node:crypto';
import { b, collabApp } from '../support/domain';
import { expectAppError } from '@/tests/support/domain';

async function fixture(blocked = false) {
  const c = await collabApp(), uploads = c.collab.files.uploads;
  const storage = c.collab.files.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Contracts' }));
  const root = c.collab.files.storages.root(c.owner, storage.id), bytes = Buffer.from('contract bytes');
  const checksum = createHash('sha256').update(bytes).digest('hex'), objects = new Map<string, Buffer>();
  uploads.configure({ async putImmutable(key, value) { objects.set(key, Buffer.from(value)); }, async read(key) { return objects.get(key)!; } },
    { async process() { return { scanStatus: blocked ? 'BLOCKED' : 'CLEAN', processed: true }; } });
  const input = { targetFolderId: root.id, desiredFileName: 'contract.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain' };
  const create = () => uploads.create(c.owner, b({ ...input, idempotencyKey: randomUUID() }));
  const complete = async (id: string) => {
    await uploads.part(c.owner, id, b({ partNumber: 1, dataBase64: bytes.toString('base64'), checksum }));
    return uploads.complete(c.owner, id, b());
  };
  return { c, uploads, input, create, complete, bytes };
}

describe('Files, Versions & Uploads Specification contract', () => {
  it('Oversize.', async () => {
    const f = await fixture();
    await expectAppError(() => f.uploads.create(f.c.owner, b({ ...f.input, expectedSizeBytes: 104857601, idempotencyKey: randomUUID() })), 'FILE_TOO_LARGE', 413);
    expect(f.c.state.uploadSessions).toHaveLength(0);
  });
  it('Quota race.', async () => {
    const f = await fixture(); f.c.owner.workspace.settings.fileStorageQuotaBytes = f.bytes.length;
    const results = await Promise.allSettled([Promise.resolve().then(f.create), Promise.resolve().then(f.create)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'STORAGE_QUOTA_EXCEEDED' } });
    expect(f.c.state.uploadSessions).toHaveLength(1);
  });
  it('Same-name conflict.', async () => {
    const f = await fixture(); await f.complete(f.create().id);
    await expectAppError(() => f.complete(f.create().id), 'FILE_NAME_CONFLICT', 409);
    expect(f.c.state.driveFileVersions).toHaveLength(1);
  });
  it('Complete retry.', async () => {
    const f = await fixture(), session = f.create(), accepted = await f.complete(session.id);
    expect(await f.uploads.complete(f.c.owner, session.id, b())).toEqual(accepted);
    expect(f.c.state.driveFiles).toHaveLength(1); expect(f.c.state.driveFileVersions).toHaveLength(1);
  });
  it('Malware blocked.', async () => {
    const f = await fixture(true), accepted = await f.complete(f.create().id);
    expect(f.c.state.driveFileVersions[0].scanStatus).toBe('BLOCKED'); expect(f.c.state.driveFiles[0].status).toBe('BLOCKED');
    await expectAppError(() => f.c.collab.files.records.restoreVersion(f.c.owner, accepted.resultFileId!, accepted.resultVersionId!, b({ version: f.c.state.driveFiles[0].version })), 'FILE_BLOCKED', 409);
  });
  it('Restore immutability.', async () => {
    const f = await fixture(), accepted = await f.complete(f.create().id), original = structuredClone(f.c.state.driveFileVersions[0]);
    const restored = f.c.collab.files.records.restoreVersion(f.c.owner, accepted.resultFileId!, accepted.resultVersionId!, b({ version: f.c.state.driveFiles[0].version }));
    expect(f.c.state.driveFileVersions[0]).toEqual(original); expect(restored.version.id).not.toBe(original.id);
    expect(restored.version.versionNumber).toBe(2); expect(restored.file.currentVersionId).toBe(restored.version.id);
  });
});
