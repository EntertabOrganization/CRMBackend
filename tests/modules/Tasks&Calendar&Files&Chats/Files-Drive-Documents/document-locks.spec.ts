import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
async function fixture() {
  const c = await collabApp(), f = c.collab.files, locks = c.collab.locks, objects = new Map<string, Buffer>();
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Edit lease' })), root = f.storages.root(c.owner, storage.id);
  f.uploads.configure({ async putImmutable(key, bytes) { objects.set(key, bytes); }, async read(key) { return objects.get(key)!; } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const bytes = Buffer.from('editable text'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = f.uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'edit.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, session.id, b({ partNumber: 1, dataBase64: bytes.toString('base64'), checksum }));
  const receipt = await f.uploads.complete(c.owner, session.id, b()), fileId = receipt.resultFileId!;
  return { c, f, locks, fileId, root, storage };
}
it('permits exactly one lease and never stores or publishes its reusable token', async () => {
  const x = await fixture(), lease = x.locks.acquire(x.c.owner, x.fileId, b());
  await expectAppError(() => x.locks.acquire(x.c.owner, x.fileId, b()), 'FILE_LOCKED', 409);
  expect(JSON.stringify(x.c.state.fileLocks)).not.toContain(lease.lockToken);
  expect(JSON.stringify(x.c.state.auditLogs)).not.toContain(lease.lockToken);
  expect(JSON.stringify(x.c.state.outboxEvents)).not.toContain(lease.lockToken);
  expect(x.locks.safe(x.c.state.fileLocks[0])).not.toHaveProperty('lockTokenHash');
  await expectAppError(() => x.locks.release(x.c.owner, x.fileId, lease.id, b({ lockToken: 'wrong' })), 'FILE_LOCK_NOT_FOUND', 404);
  x.locks.release(x.c.owner, x.fileId, lease.id, b({ lockToken: lease.lockToken }));
  expect(x.locks.acquire(x.c.owner, x.fileId, b()).id).not.toBe(lease.id);
});
it('expires stale ownership, creates a new identity and prevents old-token revival', async () => {
  const x = await fixture(), old = x.locks.acquire(x.c.owner, x.fileId, b({ leaseSeconds: 15 }));
  const now = new Date(old.expiresAt.getTime()+1), spy = jest.spyOn(x.c.collab.support, 'now').mockReturnValue(now);
  try {
    const fresh = x.locks.acquire(x.c.owner, x.fileId, b()); expect(fresh.id).not.toBe(old.id);
    await expectAppError(() => x.locks.renew(x.c.owner, x.fileId, old.id, old.lockToken), 'EDIT_SESSION_EXPIRED', 410);
    expect(x.c.state.fileLocks.find(row => row.id === old.id)!.releasedAt).toEqual(now);
  } finally { spy.mockRestore(); }
});
it('blocks content and lifecycle mutation while retaining authorized read/copy access', async () => {
  const x = await fixture(), lease = x.locks.acquire(x.c.owner, x.fileId, b()), file = x.c.state.driveFiles.find(row => row.id === x.fileId)!;
  await expectAppError(() => x.f.records.update(x.c.owner, x.fileId, b({ name: 'overwrite.txt', version: file.version })), 'FILE_LOCKED', 409);
  await expectAppError(() => x.f.records.trash(x.c.owner, x.fileId, b({ version: file.version })), 'FILE_LOCKED', 409);
  await expectAppError(() => x.f.uploads.createVersion(x.c.owner, x.fileId, b({ expectedSizeBytes: 1, expectedChecksum: 'a'.repeat(64), mimeType: 'text/plain', idempotencyKey: randomUUID(), version: file.version })), 'FILE_LOCKED', 409);
  expect(x.f.records.get(x.c.owner, x.fileId).id).toBe(x.fileId);
  expect(x.f.records.copy(x.c.owner, x.fileId, b({ folderId: x.root.id, name: 'read-copy.txt' })).id).not.toBe(x.fileId);
  x.locks.release(x.c.owner, x.fileId, lease.id, b({ lockToken: lease.lockToken }));
  expect(x.f.records.update(x.c.owner, x.fileId, b({ name: 'after.txt', version: file.version })).name).toBe('after.txt');
});
it('requires both elevated action and FULL ACL for forced release, with immutable audit evidence', async () => {
  const x = await fixture(), lease = x.locks.acquire(x.c.owner, x.fileId, b());
  const actor = await x.c.memberActor('edit-only', perms('WORKSPACE', 'file.lock', 'file.force_unlock'));
  x.f.access.replace(x.c.owner, 'FILE', x.fileId, b({ version: x.c.state.driveFiles.find(row => row.id === x.fileId)!.version, assignments: [{ subjectType: 'USER', subjectId: actor.user.id, permissionLevel: 'EDIT', inheritanceMode: 'INHERIT' }] }));
  await expectAppError(() => x.locks.forceRelease(actor, x.fileId, lease.id, b({ version: 1, reason: 'No FULL access' })), 'FILE_NOT_FOUND', 404);
  expect(x.locks.forceRelease(x.c.owner, x.fileId, lease.id, b({ version: 1, reason: 'Browser lost' })).releasedAt).not.toBeNull();
  expect(x.c.state.auditLogs.filter(row => row.action === 'FILE.FORCE_UNLOCKED')).toHaveLength(1);
  expect(JSON.stringify(x.c.state.auditLogs)).not.toContain(lease.lockToken);
});
it('does not leak cross-tenant leases and permits owner cleanup after content becomes unavailable', async () => {
  const x = await fixture(), lease = x.locks.acquire(x.c.owner, x.fileId, b()), foreign = await x.c.foreignActor();
  await expectAppError(() => x.locks.release(foreign, x.fileId, lease.id, b({ lockToken: lease.lockToken })), 'FILE_NOT_FOUND', 404);
  x.c.state.driveFiles.find(row => row.id === x.fileId)!.status = 'BLOCKED';
  expect(x.locks.release(x.c.owner, x.fileId, lease.id, b({ lockToken: lease.lockToken })).releasedAt).not.toBeNull();
});

it('supports system/workflow reservation types only with FULL File authority', async () => {
  const x = await fixture(), actor = await x.c.memberActor('lock-worker', perms('WORKSPACE', 'file.lock'));
  x.f.access.replace(x.c.owner, 'FILE', x.fileId, b({ version: x.c.state.driveFiles.find(row => row.id === x.fileId)!.version,
    assignments: [{ subjectType: 'USER', subjectId: actor.user.id, permissionLevel: 'EDIT', inheritanceMode: 'INHERIT' }] }));
  for (const lockType of ['SYSTEM_PROCESS', 'WORKFLOW']) {
    await expectAppError(() => x.locks.acquire(actor, x.fileId, b({ lockType })), 'FILE_NOT_FOUND', 404);
    const lease = x.locks.acquire(x.c.owner, x.fileId, b({ lockType })); expect(lease.lockType).toBe(lockType);
    x.locks.release(x.c.owner, x.fileId, lease.id, b({ lockToken: lease.lockToken }));
  }
});
