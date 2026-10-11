import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';
jest.setTimeout(180_000);
let owner: Session, reader: Session, manager: Session, denied: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('acl-config-owner'); foreign = await register('acl-config-foreign');
  reader = await member(owner, 'acl-config-reader', [['storage.read', 'WORKSPACE'], ['folder.read', 'WORKSPACE']]);
  manager = await member(owner, 'acl-config-manager', [['file.permission_manage', 'WORKSPACE']]);
  denied = await member(owner, 'acl-config-denied', []);
});
afterAll(disconnect);

it('enforces all four permission routes, atomic replacement, inherited access and audit evidence', async () => {
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'ACL config' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const child = expectOk(await call(owner, 'POST', 'folders', { body: { storageId: storage.id, parentFolderId: root.id, name: 'Child' } }));
  for (const [prefix, id] of [['file-storages', storage.id], ['folders', child.id]]) {
    const path = `${prefix}/${id}/permissions`, error = prefix === 'folders' ? 'FOLDER_NOT_FOUND' : 'STORAGE_NOT_FOUND';
    expect(expectOk(await call(owner, 'GET', path)).assignments).toEqual([]);
    for (const method of ['GET', 'PUT'] as const) {
      const options = method === 'PUT' ? { body: { assignments: [], version: 1 } } : {};
      expectError(await call(null, method, path, { ...options, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
      expectError(await call(denied, method, path, options), 403, 'PERMISSION_DENIED');
      expectError(await call(foreign, method, path, options), 404, error);
      expectError(await call(manager, method, path, options), 404, error);
    }
  }
  const path = `file-storages/${storage.id}/permissions`;
  const grant = { subjectType: 'USER', subjectId: reader.userId, permissionLevel: 'READ', inheritanceMode: 'INHERIT' };
  const first = expectOk(await call(owner, 'PUT', path, { body: { assignments: [grant], version: 1 } }));
  expectOk(await call(reader, 'GET', `folders/${child.id}`));
  expectError(await call(reader, 'GET', `folders/${child.id}/permissions`), 403, 'PERMISSION_DENIED');
  expectError(await call(owner, 'PUT', path, { body: { assignments: [], version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectError(await call(owner, 'PUT', path, { body: { assignments: [grant, { ...grant, subjectId: foreign.userId }], version: first.version } }), 400, 'FILE_PERMISSION_INVALID');
  expect(expectOk(await call(owner, 'GET', path)).version).toBe(first.version);
  const restriction = expectOk(await call(owner, 'PUT', `folders/${child.id}/permissions`, { body: { version: 1, assignments: [
    { subjectType: 'USER', subjectId: owner.userId, permissionLevel: 'FULL', inheritanceMode: 'OVERRIDE' },
  ] } }));
  expectError(await call(reader, 'GET', `folders/${child.id}`), 404, 'FOLDER_NOT_FOUND');
  expectOk(await call(owner, 'PUT', `folders/${child.id}/permissions`, { body: { assignments: [], version: restriction.version } }));
  expectOk(await call(reader, 'GET', `folders/${child.id}`));
  // Replacement of the same subject is safe with deferred uniqueness.
  const second = expectOk(await call(owner, 'PUT', path, { body: { assignments: [grant], version: first.version } }));
  const outcomes = await Promise.all([
    call(owner, 'PUT', path, { body: { assignments: [grant], version: second.version } }),
    call(owner, 'PUT', path, { body: { assignments: [], version: second.version } }),
  ]);
  expect(outcomes.filter(row => row.status === 200)).toHaveLength(1);
  expect(outcomes.filter(row => row.status === 409)).toHaveLength(1);
  const prisma = await db();
  expect(await prisma.auditLog.count({ where: { workspaceId: owner.workspaceId, entityId: storage.id, action: 'FILE.PERMISSION_CHANGED' } })).toBeGreaterThanOrEqual(3);
  expect(await prisma.outboxEvent.count({ where: { workspaceId: owner.workspaceId, entityId: storage.id, eventType: 'FILE_PERMISSION_CHANGED' } })).toBeGreaterThanOrEqual(3);
});

it('rejects independent SQL duplicates, mixed modes, foreign guests and Project roles without a Project', async () => {
  const prisma = await db(), storage = await prisma.projectFileStorage.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, type: 'PERSONAL' } });
  const root = await prisma.projectRootFolder.findFirstOrThrow({ where: { storageId: storage.id, parentFolderId: null } });
  const grant = { id: randomUUID(), workspaceId: owner.workspaceId, resourceType: 'FOLDER', resourceId: root.id, subjectType: 'USER', subjectId: owner.userId, permissionLevel: 'FULL', inheritanceMode: 'INHERIT' };
  await prisma.filePermissionAssignment.create({ data: grant });
  await expect(prisma.filePermissionAssignment.create({ data: { ...grant, id: randomUUID() } })).rejects.toThrow();
  await expect(prisma.filePermissionAssignment.create({ data: { ...grant, id: randomUUID(), subjectId: reader.userId, inheritanceMode: 'OVERRIDE' } })).rejects.toThrow('FILE_PERMISSION_INVALID');
  await expect(prisma.filePermissionAssignment.create({ data: { ...grant, id: randomUUID(), subjectId: foreign.userId, subjectType: 'EXTERNAL_GUEST' } })).rejects.toThrow('FILE_PERMISSION_INVALID');
  await expect(prisma.filePermissionAssignment.create({ data: { ...grant, id: randomUUID(), subjectId: 'OWNER', subjectType: 'PROJECT_ROLE' } })).rejects.toThrow('FILE_PERMISSION_INVALID');
  expect(await prisma.filePermissionAssignment.count({ where: { resourceId: root.id } })).toBe(1);
});
