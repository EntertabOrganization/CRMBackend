import { createHash, randomUUID } from 'node:crypto';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180_000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);
async function fixture() {
  const owner = await register('upload-contract');
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Contracts' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`)), bytes = Buffer.from('HTTP contract bytes');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const input = { targetFolderId: root.id, desiredFileName: 'contract.txt', expectedSizeBytes: bytes.length, expectedChecksum: checksum, mimeType: 'text/plain', idempotencyKey: randomUUID() };
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: input }));
  return { owner, bytes, input, session, part: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } };
}
describe('Files, Versions & Uploads Specification E2E contract', () => {
  it('exposes and enforces representative create/read/part/complete routes', async () => {
    const f = await fixture();
    expect(expectOk(await call(f.owner, 'GET', `upload-sessions/${f.session.id}`))).toMatchObject({ id: f.session.id, status: 'CREATED' });
    expectOk(await call(f.owner, 'POST', `upload-sessions/${f.session.id}/parts`, { body: f.part }));
    const { appContext } = await import('@/src/server/app-context');
    appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process(bytes) { expect(bytes).toEqual(f.bytes); return { scanStatus: 'CLEAN', processed: true }; } });
    const accepted = expectOk(await call(f.owner, 'POST', `upload-sessions/${f.session.id}/complete`, { body: {} }));
    expect(accepted.status).toBe('COMPLETED');
    expect(expectOk(await call(f.owner, 'POST', `upload-sessions/${f.session.id}/complete`, { body: {} }))).toEqual(accepted);
    expect(await (await db()).driveFileVersion.count({ where: { fileId: accepted.resultFileId } })).toBe(1);
  });
  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const f = await fixture(), denied = await member(f.owner, 'upload-contract-denied', []);
    for (const [method, path, body] of [['POST', 'upload-sessions', f.input], ['GET', `upload-sessions/${f.session.id}`, undefined],
      ['POST', `upload-sessions/${f.session.id}/parts`, f.part], ['POST', `upload-sessions/${f.session.id}/complete`, {}]] as const) {
      expectError(await call(null, method, path, { body, workspaceId: f.owner.workspaceId }), 401, 'UNAUTHENTICATED');
      expectError(await call(denied, method, path, { body }), 403, 'PERMISSION_DENIED');
    }
  });
  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const f = await fixture(), foreign = await register('upload-contract-foreign');
    expectError(await call(foreign, 'POST', 'upload-sessions', { body: f.input }), 404, 'FOLDER_NOT_FOUND');
    for (const id of [f.session.id, randomUUID()]) {
      expectError(await call(foreign, 'GET', `upload-sessions/${id}`), 404, 'UPLOAD_SESSION_NOT_FOUND');
      expectError(await call(foreign, 'POST', `upload-sessions/${id}/parts`, { body: f.part }), 404, 'UPLOAD_SESSION_NOT_FOUND');
      expectError(await call(foreign, 'POST', `upload-sessions/${id}/complete`, { body: {} }), 404, 'UPLOAD_SESSION_NOT_FOUND');
    }
  });
  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const f = await fixture();
    expectError(await call(f.owner, 'POST', `upload-sessions/${f.session.id}/parts`, { body: { ...f.part, checksum: '0'.repeat(64) } }), 409, 'UPLOAD_CHECKSUM_MISMATCH');
    expectError(await call(f.owner, 'POST', 'upload-sessions', { body: { ...f.input, expectedSizeBytes: 104857601, idempotencyKey: randomUUID() } }), 413, 'FILE_TOO_LARGE');
    expect((await (await db()).uploadSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).toBe('CREATED');
  });
  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const f = await fixture(), prisma = await db();
    expect(await prisma.auditLog.count({ where: { entityId: f.session.id, action: 'UPLOAD.CREATED' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { entityId: f.session.id, eventType: 'UPLOAD_CREATED' } })).toBe(1);
    await prisma.workspace.update({ where: { id: f.owner.workspaceId }, data: { settings: { fileStorageQuotaBytes: 2 * f.bytes.length } } });
    const attempts = await Promise.all([1, 2].map(() => call(f.owner, 'POST', 'upload-sessions', { body: { ...f.input, idempotencyKey: randomUUID() } })));
    expect(attempts.map(result => result.status).sort()).toEqual([200, 409]);
    expectError(attempts.find(result => result.status === 409)!, 409, 'STORAGE_QUOTA_EXCEEDED');
    expect(await prisma.uploadSession.count({ where: { workspaceId: f.owner.workspaceId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { workspaceId: f.owner.workspaceId, action: 'UPLOAD.CREATED' } })).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { workspaceId: f.owner.workspaceId, eventType: 'UPLOAD_CREATED' } })).toBe(2);
  });
});
