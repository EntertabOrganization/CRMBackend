import { createHash, randomUUID } from 'node:crypto';
import { b, collabApp } from '../support/domain';
import { AppError } from '@/src/server/errors';

it('retains configured-provider failures as accepted pending content and fences stale scanner results after reclaim', async () => {
  const c = await collabApp(), uploads = c.collab.files.uploads, worker = c.collab.files.uploadProcessing;
  const storage = c.collab.files.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Processing' }));
  const root = c.collab.files.storages.root(c.owner, storage.id), bytes = Buffer.from('pending content'), checksum = createHash('sha256').update(bytes).digest('hex');
  const objects = new Map<string, Buffer>(); let state: 'FAIL' | 'CLEAN' | 'BLOCKED' = 'FAIL';
  uploads.configure({ async putImmutable(key, value) { objects.set(key, Buffer.from(value)); }, async read(key) { return objects.get(key)!; } },
    { async process(value) { expect(value).toEqual(bytes); if (state === 'FAIL') throw new Error('private scanner failure'); return { scanStatus: state, processed: true }; } });
  const input = { targetFolderId: root.id, desiredFileName: 'pending.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() };
  const session = uploads.create(c.owner, b(input));
  await uploads.part(c.owner, session.id, b({ partNumber: 1, dataBase64: bytes.toString('base64'), checksum }));
  const accepted = await uploads.complete(c.owner, session.id, b());
  c.state.uploadSessions.find(row => row.id === session.id)!.expiresAt = new Date(0);
  expect(accepted.status).toBe('PROCESSING'); expect(c.state.driveFiles[0].status).toBe('PROCESSING');
  expect(c.state.driveFileVersions[0].scanStatus).toBe('PENDING');
  expect((await uploads.complete(c.owner, session.id, b())).resultVersionId).toBe(accepted.resultVersionId);
  const now = new Date(Date.now() + 3000), token = randomUUID();
  expect(worker.claimDue(1, token, now)).toEqual([session.id]);
  expect(worker.claimDue(1, randomUUID(), now)).toEqual([]);
  const old = worker.prepare(session.id, token, now)!;
  const failed = await worker.deliver(old); expect(failed).toEqual({ kind: 'FAILED', code: 'FILE_PROCESSOR_UNAVAILABLE' });
  expect(worker.finish(old, failed, now)).toBe(true);
  expect(worker.claimDue(1, randomUUID(), now)).toEqual([]);
  const later = new Date(now.getTime() + 360_000), nextToken = randomUUID();
  expect(worker.claimDue(1, nextToken, later)).toEqual([session.id]);
  const next = worker.prepare(session.id, nextToken, later)!;
  state = 'BLOCKED';
  expect(worker.finish(next, await worker.deliver(next), later)).toBe(true);
  expect(c.state.driveFiles[0].status).toBe('BLOCKED');
  expect(worker.finish(old, { kind: 'SENT', reference: JSON.stringify({ scanStatus: 'CLEAN', processed: true }) }, later)).toBe(false);
  expect(c.state.driveFileVersions).toHaveLength(1); expect(c.state.driveFileVersions[0].scanStatus).toBe('BLOCKED');
  expect(() => uploads.applyProcessing(c.state.uploadSessions[0], { scanStatus: 'CLEAN', processed: true }, later)).toThrow(AppError);
  expect(JSON.stringify(uploads.get(c.owner, session.id))).not.toMatch(/processingClaim|private scanner|objectKey/);
});

it('checks immutable bytes before scanning and does not activate content after storage corruption', async () => {
  const c = await collabApp(), uploads = c.collab.files.uploads, worker = c.collab.files.uploadProcessing;
  const storage = c.collab.files.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Integrity' }));
  const root = c.collab.files.storages.root(c.owner, storage.id), bytes = Buffer.from('original'), checksum = createHash('sha256').update(bytes).digest('hex');
  const objects = new Map<string, Buffer>(); let scans = 0;
  uploads.configure({ async putImmutable(key, value) { objects.set(key, Buffer.from(value)); }, async read(key) { return objects.get(key)!; } },
    { async process() { scans++; return { scanStatus: 'CLEAN', processed: false }; } });
  const session = uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'integrity.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() }));
  await uploads.part(c.owner, session.id, b({ partNumber: 1, dataBase64: bytes.toString('base64'), checksum })); await uploads.complete(c.owner, session.id, b());
  objects.set(c.state.driveFileVersions[0].objectKey, Buffer.from('changed'));
  const now = new Date(Date.now() + 3000), token = randomUUID(); worker.claimDue(1, token, now);
  const ticket = worker.prepare(session.id, token, now)!;
  const failed = await worker.deliver(ticket); expect(failed).toEqual({ kind: 'FAILED', code: 'UPLOAD_CHECKSUM_MISMATCH' });
  worker.finish(ticket, failed, now);
  expect(scans).toBe(1); expect(c.state.driveFiles[0].status).toBe('PROCESSING'); expect(c.state.driveFileVersions[0].processedAt).toBeNull();
});
