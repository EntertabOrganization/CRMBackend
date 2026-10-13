import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';
jest.setTimeout(180_000);
let owner: Session, alice: Session, denied: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('storage-types-owner');
  alice = await member(owner, 'storage-types-alice', [['storage.read', 'OWN'], ['folder.read', 'OWN']]);
  denied = await member(owner, 'storage-types-denied', []); foreign = await register('storage-types-foreign');
});
afterAll(disconnect);
async function storage(type: 'PERSONAL' | 'COMPANY' | 'SYSTEM') {
  const row = expectOk(await call(owner, 'POST', 'file-storages', { body: { type, name: type + ' ' + randomUUID() } }));
  return { ...row, root: expectOk(await call(owner, 'GET', `file-storages/${row.id}/root`)) };
}
async function folder(storageId: string, parentFolderId: string, name: string) {
  return expectOk(await call(owner, 'POST', 'folders', { body: { storageId, parentFolderId, name } }));
}

describe('Complete storage and hierarchical folder read HTTP/PostgreSQL contracts', () => {
  it('reads every storage type with tenant, authentication and action grants on all four operations', async () => {
    const personal = await storage('PERSONAL'), company = await storage('COMPANY'), system = await storage('SYSTEM');
    expect(expectOk(await call(alice, 'GET', 'file-storages')).map((row: any) => row.id)).toEqual([company.id]);
    for (const row of [personal, company, system]) {
      expectOk(await call(owner, 'GET', `file-storages/${row.id}`));
      expectOk(await call(owner, 'GET', `folders/${row.root.id}`));
      for (const path of ['file-storages', `file-storages/${row.id}`, `file-storages/${row.id}/root`, `folders/${row.root.id}`]) {
        expectError(await call(null, 'GET', path, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
        expectError(await call(denied, 'GET', path), 403, 'PERMISSION_DENIED');
        if (path !== 'file-storages') expectError(await call(foreign, 'GET', path), 404, path.startsWith('folders') ? 'FOLDER_NOT_FOUND' : 'STORAGE_NOT_FOUND');
      }
    }
    expectError(await call(alice, 'GET', `file-storages/${personal.id}`), 404, 'STORAGE_NOT_FOUND');
    expectError(await call(alice, 'GET', `file-storages/${system.id}`), 404, 'STORAGE_NOT_FOUND');
    const prisma = await db();
    await expect(prisma.projectFileStorage.create({ data: { ...(await prisma.projectFileStorage.findUniqueOrThrow({ where: { id: company.id } })), id: randomUUID() } })).rejects.toThrow();
    await expect(prisma.projectFileStorage.create({ data: { ...(await prisma.projectFileStorage.findUniqueOrThrow({ where: { id: personal.id } })), id: randomUUID() } })).rejects.toThrow();
    expect(await prisma.projectRootFolder.count({ where: { storageId: personal.id, parentFolderId: null } })).toBe(1);
  });

  it('evaluates inherited folder grants, restrictive overrides, live membership and trash ancestors', async () => {
    const prisma = await db(), personal = await prisma.projectFileStorage.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, type: 'PERSONAL' } });
    const root = await prisma.projectRootFolder.findFirstOrThrow({ where: { storageId: personal.id, parentFolderId: null } });
    const parent = await folder(personal.id, root.id, 'Shared branch'), child = await folder(personal.id, parent.id, 'Visible child');
    await prisma.filePermissionAssignment.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, resourceType: 'FOLDER', resourceId: parent.id,
      subjectType: 'USER', subjectId: alice.userId, permissionLevel: 'READ', inheritanceMode: 'OVERRIDE' } });
    expectOk(await call(alice, 'GET', `folders/${child.id}`));
    expectError(await call(alice, 'GET', `file-storages/${personal.id}`), 404, 'STORAGE_NOT_FOUND');
    expectError(await call(owner, 'GET', `folders/${child.id}`), 404, 'FOLDER_NOT_FOUND');
    const restriction = await prisma.filePermissionAssignment.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, resourceType: 'FOLDER', resourceId: child.id,
      subjectType: 'WORKSPACE', subjectId: null, permissionLevel: 'NONE', inheritanceMode: 'OVERRIDE' } });
    expectError(await call(alice, 'GET', `folders/${child.id}`), 404, 'FOLDER_NOT_FOUND');
    await prisma.filePermissionAssignment.delete({ where: { id: restriction.id } });
    await prisma.projectRootFolder.update({ where: { id: parent.id }, data: { status: 'TRASHED', trashedAt: new Date() } });
    expectError(await call(alice, 'GET', `folders/${child.id}`), 404, 'FOLDER_NOT_FOUND');
    await prisma.projectRootFolder.update({ where: { id: parent.id }, data: { status: 'ACTIVE', trashedAt: null } });
    expectOk(await call(alice, 'GET', `folders/${child.id}`));
    await prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: alice.userId } }, data: { status: 'SUSPENDED' } });
    expectError(await call(alice, 'GET', `folders/${child.id}`), 403, 'PERMISSION_DENIED');
    await prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: alice.userId } }, data: { status: 'ACTIVE' } });
    await prisma.projectFileStorage.update({ where: { id: personal.id }, data: { isActive: false } });
    expectError(await call(alice, 'GET', `folders/${child.id}`), 404, 'FOLDER_NOT_FOUND');
    await prisma.projectFileStorage.update({ where: { id: personal.id }, data: { isActive: true } });
  });

  it('rejects independent SQL parent escape, cycles, sibling collisions and foreign ACL subjects', async () => {
    const prisma = await db(), system = await prisma.projectFileStorage.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, type: 'SYSTEM' } });
    const personal = await prisma.projectFileStorage.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, type: 'PERSONAL' } });
    const root = await prisma.projectRootFolder.findFirstOrThrow({ where: { storageId: personal.id, parentFolderId: null } });
    const parent = await folder(personal.id, root.id, 'Café'), child = await folder(personal.id, parent.id, 'Child');
    await expect(prisma.projectRootFolder.update({ where: { id: parent.id }, data: { parentFolderId: child.id } })).rejects.toThrow('FOLDER_HIERARCHY_CYCLE');
    const systemRoot = await prisma.projectRootFolder.findFirstOrThrow({ where: { storageId: system.id, parentFolderId: null } });
    await expect(prisma.projectRootFolder.update({ where: { id: child.id }, data: { parentFolderId: systemRoot.id } })).rejects.toThrow();
    await expect(prisma.projectRootFolder.create({ data: { ...(await prisma.projectRootFolder.findUniqueOrThrow({ where: { id: parent.id } })), id: randomUUID(), name: 'CAFE\u0301' } })).rejects.toThrow();
    await expect(prisma.filePermissionAssignment.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, resourceType: 'FOLDER', resourceId: child.id,
      subjectType: 'USER', subjectId: foreign.userId, permissionLevel: 'FULL', inheritanceMode: 'INHERIT' } })).rejects.toThrow('FILE_PERMISSION_INVALID');
    await expect(prisma.filePermissionAssignment.create({ data: { id: randomUUID(), workspaceId: foreign.workspaceId, resourceType: 'FOLDER', resourceId: child.id,
      subjectType: 'WORKSPACE', subjectId: null, permissionLevel: 'READ', inheritanceMode: 'INHERIT' } })).rejects.toThrow('FILE_PERMISSION_INVALID');
    expect(await prisma.projectRootFolder.findUnique({ where: { id: parent.id } })).toMatchObject({ parentFolderId: root.id });
  });
  it('creates canonical Project storage through its domain port and rejects unauthorized construction', async () => {
    const project = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Canonical factory', tools: ['TASKS'] } }));
    const input = { type: 'PROJECT', projectId: project.id };
    const first = expectOk(await call(owner, 'POST', 'file-storages', { body: input }));
    expect(expectOk(await call(owner, 'POST', 'file-storages', { body: input })).id).toBe(first.id);
    expect(expectOk(await call(owner, 'GET', `projects/${project.id}/linked-resources`)).DRIVE.resourceId).toBe(first.id);
    expectError(await call(denied, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Denied' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(alice, 'POST', 'folders', { body: { storageId: first.id, parentFolderId: randomUUID(), name: 'Denied' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(foreign, 'POST', 'file-storages', { body: input }), 404, 'PROJECT_NOT_FOUND');
    const prisma = await db(), root = await prisma.projectRootFolder.findFirstOrThrow({ where: { storageId: first.id, parentFolderId: null } });
    await expect(prisma.projectRootFolder.delete({ where: { id: root.id } })).rejects.toThrow('FOLDER_NOT_FOUND');
    expect(await prisma.projectRootFolder.count({ where: { storageId: first.id, parentFolderId: null } })).toBe(1);
  });
  it('serializes independent graph changes so opposite moves cannot commit a cycle', async () => {
    const prisma = await db(), project = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Graph race', tools: ['DRIVE'] } }));
    const storageId = expectOk(await call(owner, 'GET', `projects/${project.id}/linked-resources`)).DRIVE.resourceId;
    const root = expectOk(await call(owner, 'GET', `file-storages/${storageId}/root`));
    const a = await folder(storageId, root.id, 'A'), b = await folder(storageId, root.id, 'B');
    const outcomes = await Promise.allSettled([
      prisma.$transaction(tx => tx.projectRootFolder.update({ where: { id: a.id }, data: { parentFolderId: b.id } })),
      prisma.$transaction(tx => tx.projectRootFolder.update({ where: { id: b.id }, data: { parentFolderId: a.id } })),
    ]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find(row => row.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toMatch(/FOLDER_HIERARCHY_CYCLE|deadlock|write conflict/i);
    expectOk(await call(owner, 'GET', `folders/${a.id}`)); expectOk(await call(owner, 'GET', `folders/${b.id}`));
  });
});
