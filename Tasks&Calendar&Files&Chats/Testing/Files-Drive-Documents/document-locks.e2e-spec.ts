import { createHash, randomUUID } from 'node:crypto';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000); beforeAll(prepareCollabDatabase); afterAll(disconnect);
async function fixture() {
  const owner = await register('edit-locks'), prisma = await db(), { appContext } = await import('@/src/server/app-context');
  appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Editing' } })), root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('lease test'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'edit.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
  const receipt = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} })), fileId = receipt.resultFileId;
  const acquire = (body = {}) => call(owner, 'POST', `files/${fileId}/locks`, { body });
  return { owner, prisma, appContext, fileId, acquire };
}
it('serializes API acquisition and independently rejects overlapping SQL leases and identity revival', async () => {
  const x = await fixture(), results = await Promise.all([x.acquire(), x.acquire()]);
  expect(results.filter(row => row.status === 200)).toHaveLength(1); expect(results.filter(row => row.status === 409)).toHaveLength(1);
  const lease = expectOk(results.find(row => row.status === 200)!);
  const row = await x.prisma.fileLock.findUniqueOrThrow({ where: { id: lease.id } });
  expect(JSON.stringify(row)).not.toContain(lease.lockToken);
  await expect(x.prisma.fileLock.create({ data: { ...row, id: randomUUID(), lockTokenHash: 'a'.repeat(64) } })).rejects.toThrow(/file_locks_exclusive/);
  await expect(x.prisma.fileLock.update({ where: { id: lease.id }, data: { lockedByUserId: null } })).rejects.toThrow(/FILE_LOCK_PROOF_IMMUTABLE/);
  expectError(await call(x.owner, 'DELETE', `files/${x.fileId}/locks/${lease.id}`, { body: { lockToken: 'wrong' } }), 404, 'FILE_LOCK_NOT_FOUND');
  expectOk(await call(x.owner, 'DELETE', `files/${x.fileId}/locks/${lease.id}`, { body: { lockToken: lease.lockToken } }));
  await expect(x.prisma.fileLock.update({ where: { id: lease.id }, data: { releasedAt: null } })).rejects.toThrow(/FILE_LOCK_PROOF_IMMUTABLE/);
  await expect(x.prisma.fileLock.delete({ where: { id: lease.id } })).rejects.toThrow(/FILE_LOCK_PROOF_IMMUTABLE/);
  expectOk(await x.acquire());
});
it('blocks API and SQL File mutation and records elevated force-release atomically', async () => {
  const x = await fixture(), lease = expectOk(await x.acquire()), file = expectOk(await call(x.owner, 'GET', `files/${x.fileId}`));
  expectError(await call(x.owner, 'PATCH', `files/${x.fileId}`, { body: { name: 'overwrite.txt', version: file.version } }), 409, 'FILE_LOCKED');
  expectError(await call(x.owner, 'DELETE', `files/${x.fileId}`, { body: { version: file.version } }), 409, 'FILE_LOCKED');
  await expect(x.prisma.driveFile.update({ where: { id: x.fileId }, data: { name: 'direct-overwrite.txt' } })).rejects.toThrow(/FILE_LOCKED/);
  expectError(await call(x.owner, 'POST', `files/${x.fileId}/locks/${lease.id}/force-release`, { body: { version: 2, reason: 'Stale' } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectOk(await call(x.owner, 'POST', `files/${x.fileId}/locks/${lease.id}/force-release`, { body: { version: 1, reason: 'Lost editor' } }));
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'FILE.FORCE_UNLOCKED', entityId: lease.id } })).toBe(1);
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'FILE_LOCK_RELEASED', entityId: lease.id } })).toBe(1);
  expectOk(await call(x.owner, 'PATCH', `files/${x.fileId}`, { body: { name: 'after.txt', version: file.version } }));
});
it('requires authenticated, live tenant/action/ACL authority and never accepts a foreign lease token', async () => {
  const x = await fixture(), lease = expectOk(await x.acquire()), foreign = await register('foreign-lock'), actor = await member(x.owner, 'no-lock', [['file.read','WORKSPACE']]);
  for (const [method, path, body] of [['POST',`files/${x.fileId}/locks`,{}],['DELETE',`files/${x.fileId}/locks/${lease.id}`,{ lockToken: lease.lockToken }],['POST',`files/${x.fileId}/locks/${lease.id}/force-release`,{ version: 1, reason: 'No' }]] as const)
    expectError(await call(null, method, path, { body }), 401);
  expectError(await call(actor, 'POST', `files/${x.fileId}/locks`, { body: {} }), 403, 'PERMISSION_DENIED');
  expectError(await call(foreign, 'DELETE', `files/${x.fileId}/locks/${lease.id}`, { body: { lockToken: lease.lockToken } }), 404, 'FILE_NOT_FOUND');
  expect(await x.prisma.fileLock.findUniqueOrThrow({ where: { id: lease.id } })).toMatchObject({ releasedAt: null });
});
it('recovers expired SQL leases without reuse or late revival', async () => {
  const x = await fixture(), lease = expectOk(await x.acquire({ leaseSeconds: 15 }));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(lease.expiresAt)-Date.now())+250));
  const fresh = expectOk(await x.acquire()); expect(fresh.id).not.toBe(lease.id);
  expect(await x.prisma.fileLock.findUniqueOrThrow({ where: { id: lease.id } })).not.toMatchObject({ releasedAt: null });
  await expect(x.prisma.fileLock.update({ where: { id: lease.id }, data: { expiresAt: new Date(Date.now()+300000), releasedAt: null, version: 3 } })).rejects.toThrow(/FILE_LOCK_PROOF_IMMUTABLE/);
});
