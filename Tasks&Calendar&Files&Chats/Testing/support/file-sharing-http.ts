import { createHash, randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from './e2e';

export function fileSharingHttpScenarios() {
 jest.setTimeout(180000);
 beforeAll(async () => {
  await prepareCollabDatabase();
  const { appContext } = await import('@/src/server/app-context');
  const objects = new Map<string, Buffer>();
  appContext.collab.files.uploads.configure({ async putImmutable(key, value) { objects.set(key, value); }, async read(key) { return objects.get(key)!; } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
 });
 afterAll(disconnect);
 const fixture = async () => {
  const owner = await register('sharing-overview'), prisma = await db();
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Sharing' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('shared content'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'sharing.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
  const complete = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  const file = expectOk(await call(owner, 'GET', `files/${complete.resultFileId}`));
  const paths = [`files/${file.id}/permissions`, `folders/${root.id}/permissions`, `file-storages/${storage.id}/permissions`];
  return { owner, prisma, file, root, storage, paths };
 };
 return {
  async routes() {
   const x = await fixture();
   for (const path of x.paths) {
    const current = expectOk(await call(x.owner, 'GET', path)); expect(current.assignments).toEqual([]);
    const updated = expectOk(await call(x.owner, 'PUT', path, { body: { version: current.version, assignments: [{ subjectType: 'USER', subjectId: x.owner.userId, permissionLevel: 'FULL', inheritanceMode: 'INHERIT' }] } }));
    expect(updated.version).toBe(current.version + 1); expect(expectOk(await call(x.owner, 'GET', path)).assignments).toHaveLength(1);
   }
  },
  async 'requires authenticated/authorized workspace context for protected endpoints'() {
   const x = await fixture(), denied = await member(x.owner, 'sharing-no-admin', [['file.read', 'WORKSPACE']]);
   for (const path of x.paths) for (const method of ['GET', 'PUT'] as const) {
    const options = { body: method === 'GET' ? undefined : { version: 1, assignments: [] } };
    expectError(await call(null, method, path, options), 401, 'UNAUTHENTICATED'); expectError(await call(denied, method, path, options), 403, 'PERMISSION_DENIED');
   }
  },
  async 'rejects cross-workspace resource access without leaking resource existence'() {
   const x = await fixture(), foreign = await register('sharing-foreign');
   for (const path of x.paths) for (const method of ['GET', 'PUT'] as const)
    expectError(await call(foreign, method, path, { body: method === 'GET' ? undefined : { version: 1, assignments: [] } }), 404, path.startsWith('files/') ? 'FILE_NOT_FOUND' : path.startsWith('folders/') ? 'FOLDER_NOT_FOUND' : 'STORAGE_NOT_FOUND');
   expectError(await call(foreign, 'POST', `files/${x.file.id}/public-links`, { body: {} }), 404, 'FILE_NOT_FOUND');
  },
  async 'returns stable machine-readable error envelopes for invalid requests'() {
   const x = await fixture(), foreign = await register('sharing-invalid-subject');
   expectError(await call(x.owner, 'PUT', x.paths[0], { body: { version: x.file.version, assignments: [{ subjectType: 'USER', subjectId: foreign.userId, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] } }), 400, 'FILE_PERMISSION_INVALID');
   const first = expectOk(await call(x.owner, 'PUT', x.paths[0], { body: { version: x.file.version, assignments: [] } }));
   expectError(await call(x.owner, 'PUT', x.paths[0], { body: { version: x.file.version, assignments: [] } }), 409, 'RESOURCE_VERSION_CONFLICT');
   expect(expectOk(await call(x.owner, 'GET', x.paths[0])).version).toBe(first.version);
   expect(await x.prisma.filePermissionAssignment.count({ where: { resourceId: x.file.id } })).toBe(0);
  },
  async 'persists critical state and outbox/audit consistently on successful mutation'() {
   const x = await fixture(), reader = await member(x.owner, 'sharing-reader', [['file.read', 'WORKSPACE']]);
   const updated = expectOk(await call(x.owner, 'PUT', x.paths[0], { body: { version: x.file.version, assignments: [{ subjectType: 'USER', subjectId: reader.userId, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] } }));
   expect(expectOk(await call(reader, 'GET', `files/${x.file.id}`)).id).toBe(x.file.id);
   expect(await x.prisma.driveFile.findUniqueOrThrow({ where: { id: x.file.id } })).toMatchObject({ version: updated.version });
   expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, entityId: x.file.id, action: 'FILE.PERMISSION_CHANGED' } })).toBe(1);
   expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, entityId: x.file.id, eventType: 'FILE_PERMISSION_CHANGED' } })).toBe(1);
   expectOk(await call(x.owner, 'PUT', x.paths[0], { body: { version: updated.version, assignments: [] } }));
   expectError(await call(reader, 'GET', `files/${x.file.id}`), 404, 'FILE_NOT_FOUND');
  },
 };
}
