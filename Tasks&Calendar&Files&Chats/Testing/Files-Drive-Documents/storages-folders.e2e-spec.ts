import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180_000);
beforeAll(prepareCollabDatabase);
afterAll(disconnect);
it('persists lifecycle operations, enforces authorization and protects SQL purge', async () => {
  const owner = await register('folder-lifecycle-owner'), foreign = await register('folder-lifecycle-foreign');
  const denied = await member(owner, 'folder-lifecycle-denied', []);
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Lifecycle' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const create = async (parentFolderId: string, name: string) => expectOk(await call(owner, 'POST', 'folders', { body: { storageId: storage.id, parentFolderId, name } }));
  let parent = await create(root.id, 'Parent'), child = await create(parent.id, 'Child');
  expect(expectOk(await call(owner, 'GET', `folders/${root.id}/tree`)).nodes).toHaveLength(3);
  expect(expectOk(await call(owner, 'GET', `folders/${parent.id}/children`))).toHaveLength(1);
  expectError(await call(owner, 'PATCH', `folders/${parent.id}/move`, { body: { parentFolderId: child.id, version: parent.version } }), 409, 'FOLDER_HIERARCHY_CYCLE');
  for (const path of [`folders/${parent.id}/tree`, `folders/${parent.id}/children`]) {
    expectError(await call(foreign, 'GET', path), 404, 'FOLDER_NOT_FOUND');
    expectError(await call(denied, 'GET', path), 403, 'PERMISSION_DENIED');
    expectError(await call(null, 'GET', path, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
  }
  child = expectOk(await call(owner, 'PATCH', `folders/${child.id}`, { body: { name: 'Renamed', version: child.version } }));
  const copied = expectOk(await call(owner, 'POST', `folders/${parent.id}/copy`, { body: { parentFolderId: root.id, name: 'Copy' } }));
  expect(copied.copiedFolderCount).toBe(2);
  for (const [method, path, body] of [
    ['PATCH', `file-storages/${storage.id}`, { name: 'Denied', version: 1 }],
    ['PATCH', `folders/${parent.id}`, { name: 'Denied', version: 1 }],
    ['PATCH', `folders/${parent.id}/move`, { parentFolderId: root.id, version: 1 }],
    ['POST', `folders/${parent.id}/copy`, { parentFolderId: root.id, name: 'Denied' }],
    ['DELETE', `folders/${parent.id}`, { version: 1 }],
    ['PATCH', `folders/${parent.id}/restore`, { version: 1 }],
    ['DELETE', `folders/${parent.id}/hard`, { version: 1 }],
  ] as const) {
    expectError(await call(denied, method, path, { body }), 403, 'PERMISSION_DENIED');
    expectError(await call(foreign, method, path, { body }), 404, path.startsWith('file-storages') ? 'STORAGE_NOT_FOUND' : 'FOLDER_NOT_FOUND');
    expectError(await call(null, method, path, { body, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
  }
  child = expectOk(await call(owner, 'PATCH', `folders/${child.id}/move`, { body: { parentFolderId: root.id, version: child.version } }));
  parent = expectOk(await call(owner, 'DELETE', `folders/${parent.id}`, { body: { version: parent.version } }));
  expectError(await call(owner, 'DELETE', `folders/${parent.id}/hard`, { body: { version: parent.version } }), 409, 'FILE_RETENTION_HOLD');
  const prisma = await db();
  await expect(prisma.projectRootFolder.delete({ where: { id: parent.id } })).rejects.toThrow('FILE_RETENTION_HOLD');
  await create(root.id, 'Parent');
  expectError(await call(owner, 'PATCH', `folders/${parent.id}/restore`, { body: { version: parent.version } }), 409, 'FOLDER_RESTORE_CONFLICT');
  parent = expectOk(await call(owner, 'PATCH', `folders/${parent.id}/restore`, { body: { name: 'Recovered', version: parent.version } }));
  parent = expectOk(await call(owner, 'DELETE', `folders/${parent.id}`, { body: { version: parent.version } }));
  await prisma.projectRootFolder.update({ where: { id: parent.id }, data: { purgeAfter: new Date(0) } });
  expectOk(await call(owner, 'DELETE', `folders/${parent.id}/hard`, { body: { version: parent.version } }));
  const changed = expectOk(await call(owner, 'PATCH', `file-storages/${storage.id}`, { body: { name: 'Changed', version: storage.version } }));
  expect(changed.name).toBe('Changed');
  expect(await prisma.projectRootFolder.findUnique({ where: { id: parent.id } })).toBeNull();
  const trashCopy = expectOk(await call(owner, 'DELETE', `folders/${copied.folder.id}`, { body: { version: copied.folder.version } }));
  await prisma.projectRootFolder.update({ where: { id: copied.folder.id }, data: { purgeAfter: new Date(0) } });
  expect(expectOk(await call(owner, 'DELETE', `folders/${copied.folder.id}/hard`, { body: { version: trashCopy.version } })).deletedFolderCount).toBe(2);
});
