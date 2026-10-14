import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
const priorSecret = process.env.FILE_DELIVERY_SECRET;
beforeAll(() => { process.env.FILE_DELIVERY_SECRET = 'test-delivery-signing-secret-with-32-bytes'; });
afterAll(() => { if (priorSecret === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = priorSecret; });
async function fixture() {
  const c = await collabApp(), f = c.collab.files, bytes = Buffer.from('signed content'), objects = new Map<string, Buffer>();
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Delivery' })), root = f.storages.root(c.owner, storage.id);
  f.uploads.configure({ async putImmutable(key, value) { objects.set(key, value); }, async read(key) { return objects.get(key)!; } },
    { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const checksum = createHash('sha256').update(bytes).digest('hex'), session = f.uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'sample.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
  const receipt = await f.uploads.complete(c.owner, session.id, b()), file = c.state.driveFiles.find(row => row.id === receipt.resultFileId)!;
  const issue = () => f.delivery.issue(c.owner, file.id, new URLSearchParams());
  const redeem = (path: string) => { const url = new URL(path, 'http://localhost'); return f.delivery.redeem(url.pathname.split('/').at(-1)!, url.searchParams, 'private-client'); };
  return { c, f, file, bytes, objects, issue, redeem };
}
it('signs opaque two-minute paths, verifies integrity, consumes once and omits secrets from evidence', async () => {
  const x = await fixture(), grant = await x.issue();
  expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(120000);
  await expectAppError(() => x.redeem(grant.deliveryPath.replace('signature=', 'signature=x')), 'FILE_DELIVERY_UNAVAILABLE', 410);
  expect((await x.redeem(grant.deliveryPath)).bytes).toEqual(x.bytes);
  await expectAppError(() => x.redeem(grant.deliveryPath), 'FILE_DELIVERY_UNAVAILABLE', 410);
  expect(JSON.stringify(x.c.state.auditLogs)).not.toContain(new URL(grant.deliveryPath, 'http://localhost').searchParams.get('nonce'));
  expect(x.c.state.auditLogs.some(row => row.action === 'FILE.DOWNLOADED')).toBe(true);
});
it('checks action, Workspace, live resource access, scan proof and expiry', async () => {
  const x = await fixture(), denied = await x.c.memberActor('delivery-denied', perms('WORKSPACE', 'file.read')), foreign = await x.c.foreignActor();
  await expectAppError(() => x.f.delivery.issue(denied, x.file.id, new URLSearchParams()), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.f.delivery.issue(foreign, x.file.id, new URLSearchParams()), 'FILE_NOT_FOUND', 404);
  const grant = await x.issue();
  x.c.state.driveFiles.find(row => row.id === x.file.id)!.status = 'QUARANTINED';
  await expectAppError(() => x.redeem(grant.deliveryPath), 'FILE_DELIVERY_UNAVAILABLE', 410);
  x.c.state.driveFiles.find(row => row.id === x.file.id)!.status = 'ACTIVE';
  jest.useFakeTimers();
  try { jest.setSystemTime(grant.expiresAt); await expectAppError(() => x.redeem(grant.deliveryPath), 'FILE_DELIVERY_UNAVAILABLE', 410); }
  finally { jest.useRealTimers(); }
});
it('keeps failed content reads retryable and requires configured signing', async () => {
  const x = await fixture(), grant = await x.issue(), version = x.c.state.driveFileVersions[0];
  x.objects.set(version.objectKey, Buffer.from('corrupt'));
  await expectAppError(() => x.redeem(grant.deliveryPath), 'FILE_CONTENT_UNAVAILABLE', 503);
  expect(x.c.state.fileDeliveryGrants[0].consumedAt).toBeNull();
  x.objects.set(version.objectKey, x.bytes); expect((await x.redeem(grant.deliveryPath)).bytes).toEqual(x.bytes);
  const configured = process.env.FILE_DELIVERY_SECRET; delete process.env.FILE_DELIVERY_SECRET;
  try { await expectAppError(() => x.issue(), 'FILE_DELIVERY_UNCONFIGURED', 503); } finally { process.env.FILE_DELIVERY_SECRET = configured; }
});
