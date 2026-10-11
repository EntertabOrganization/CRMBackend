import { createHash, randomUUID } from 'node:crypto';
import { b, collabApp } from '../support/domain';

it('leases abort cleanup, retries partial deletion, fences stale finishes and sweeps unrecorded staging bytes', async () => {
  const c = await collabApp(), uploads = c.collab.files.uploads, cleanup = c.collab.files.uploadCleanup;
  const storage = c.collab.files.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Cleanup' }));
  const root = c.collab.files.storages.root(c.owner, storage.id), objects = new Map<string, Buffer>();
  let fail = true;
  uploads.configure({ async putImmutable(key, value) { objects.set(key, value); }, async read(key) { return objects.get(key)!; },
    async purgeMultipart(workspaceId, id) {
      for (const key of objects.keys()) if (key.startsWith(`${workspaceId}/uploads/${id}/parts/`)) {
        objects.delete(key); if (fail) { fail = false; throw new Error('private provider diagnostic'); }
      }
    } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const bytes = Buffer.from('safe'), checksum = createHash('sha256').update(bytes).digest('hex');
  const row = uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'abort.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() }));
  await uploads.part(c.owner, row.id, b({ partNumber: 1, dataBase64: bytes.toString('base64'), checksum }));
  objects.set(`${row.workspaceId}/uploads/${row.id}/parts/unrecorded`, bytes);
  const now = new Date();
  expect(cleanup.claimDue(1, randomUUID(), now)).toEqual([]);
  uploads.abort(c.owner, row.id, b()); uploads.abort(c.owner, row.id, b());
  expect(objects.size).toBe(2);
  const token = randomUUID(); expect(cleanup.claimDue(1, token, now)).toEqual([row.id]);
  expect(cleanup.claimDue(1, randomUUID(), now)).toEqual([]);
  const old = cleanup.prepare(row.id, token, now)!;
  const failed = await cleanup.deliver(old);
  expect(failed).toEqual({ kind: 'FAILED', code: 'FILE_OBJECT_CLEANUP_FAILED' });
  expect(cleanup.finish(old, failed, now)).toBe(true);
  expect(cleanup.claimDue(1, randomUUID(), now)).toEqual([]);
  const retryAt = new Date(now.getTime() + 360_000), nextToken = randomUUID();
  expect(cleanup.claimDue(1, nextToken, retryAt)).toEqual([row.id]);
  expect(cleanup.finish(old, { kind: 'SENT', reference: null }, retryAt)).toBe(false);
  const next = cleanup.prepare(row.id, nextToken, retryAt)!;
  expect(cleanup.finish(next, await cleanup.deliver(next), retryAt)).toBe(true);
  expect(objects.size).toBe(0);
  expect(cleanup.claimDue(1, randomUUID(), retryAt)).toEqual([]);
  expect(c.state.uploadSessions[0]).toMatchObject({ status: 'ABORTED', cleanupAttempts: 2, cleanedAt: retryAt, cleanupClaimId: null });
  expect(JSON.stringify(uploads.get(c.owner, row.id))).not.toMatch(/cleanupClaim|cleanupError|objectKey/);
  expect(JSON.stringify(c.state.auditLogs.filter(audit => audit.entityId === row.id))).not.toMatch(/private provider diagnostic|\/uploads\//);
});

it('expires only unaccepted sessions and preserves live leases and completed File bytes', async () => {
  const c = await collabApp(), uploads = c.collab.files.uploads, cleanup = c.collab.files.uploadCleanup;
  const storage = c.collab.files.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Expiry' }));
  const root = c.collab.files.storages.root(c.owner, storage.id), objects = new Map<string, Buffer>();
  uploads.configure({ async putImmutable(key, value) { objects.set(key, value); }, async read(key) { return objects.get(key)!; }, async purgeMultipart() {} },
    { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const input = { targetFolderId: root.id, desiredFileName: 'empty.txt', expectedSizeBytes: 0, expectedChecksum: createHash('sha256').update('').digest('hex'), mimeType: 'text/plain' };
  const active = uploads.create(c.owner, b({ ...input, idempotencyKey: 'active' }));
  const expired = uploads.create(c.owner, b({ ...input, idempotencyKey: 'expired' }));
  const accepted = uploads.create(c.owner, b({ ...input, desiredFileName: 'accepted.txt', idempotencyKey: 'accepted' }));
  await uploads.complete(c.owner, accepted.id, b());
  c.state.uploadSessions.find(row => row.id === expired.id)!.expiresAt = new Date(0);
  c.state.uploadSessions.find(row => row.id === accepted.id)!.expiresAt = new Date(1);
  const now = new Date(), token = randomUUID();
  expect(cleanup.claimDue(10, token, now)).toEqual([expired.id, accepted.id]);
  expect(c.state.uploadSessions.find(row => row.id === expired.id)!.status).toBe('FAILED');
  expect(c.state.uploadSessions.find(row => row.id === active.id)!.status).toBe('CREATED');
  expect(c.state.driveFiles[0].status).toBe('ACTIVE'); expect(objects.size).toBe(1);
  const stale = cleanup.prepare(expired.id, token, now)!;
  const later = new Date(now.getTime() + 300_001), newToken = randomUUID();
  expect(cleanup.claimDue(1, newToken, later)).toEqual([expired.id]);
  expect(cleanup.finish(stale, { kind: 'SENT', reference: null }, later)).toBe(false);
});
