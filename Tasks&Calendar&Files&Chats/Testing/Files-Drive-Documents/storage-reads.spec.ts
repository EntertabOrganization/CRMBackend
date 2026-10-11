import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Storage types and safe inherited folder reads', () => {
  it('reads Personal, Company and System roots with independent resource authority', async () => {
    const c = await collabApp(), storages = c.collab.files.storages;
    const alice = await c.memberActor('storage-alice', perms('OWN', 'storage.read', 'folder.read'));
    const personal = storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Private' }));
    const company = storages.createStorage(c.owner, b({ type: 'COMPANY', name: 'Company' }));
    const system = storages.createStorage(c.owner, b({ type: 'SYSTEM', name: 'System' }));
    expect(storages.list(alice, new URLSearchParams()).data.map(row => row.id)).toEqual([company.id]);
    expect(storages.root(alice, company.id).parentFolderId).toBeNull();
    await expectAppError(() => storages.get(alice, personal.id), 'STORAGE_NOT_FOUND', 404);
    await expectAppError(() => storages.get(alice, system.id), 'STORAGE_NOT_FOUND', 404);
    await expectAppError(() => storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Duplicate' })), 'STORAGE_ALREADY_EXISTS', 409);
    const root = storages.root(c.owner, personal.id);
    c.state.filePermissionAssignments.push({ id: randomUUID(), workspaceId: c.owner.workspaceId, resourceType: 'STORAGE', resourceId: personal.id,
      subjectType: 'USER', subjectId: alice.user.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' });
    expect(storages.root(alice, personal.id).id).toBe(root.id);
    c.state.fileStorages.find(row => row.id === company.id)!.isActive = false;
    await expectAppError(() => storages.root(alice, company.id), 'STORAGE_NOT_FOUND', 404);
  });

  it('applies child overrides and grants while rejecting trashed ancestors, missing parents and cycles', async () => {
    const c = await collabApp(), storages = c.collab.files.storages;
    const alice = await c.memberActor('folder-alice', perms('WORKSPACE', 'storage.read', 'folder.read'));
    const foreign = await c.foreignActor();
    const storage = storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Private' })), root = storages.root(c.owner, storage.id);
    const parent = storages.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Parent' }));
    const child = storages.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: parent.id, name: 'Child' }));
    c.state.filePermissionAssignments.push({ id: randomUUID(), workspaceId: c.owner.workspaceId, resourceType: 'FOLDER', resourceId: parent.id,
      subjectType: 'USER', subjectId: alice.user.id, permissionLevel: 'READ', inheritanceMode: 'OVERRIDE' });
    expect(storages.folder(alice, child.id).id).toBe(child.id);
    await expectAppError(() => storages.get(alice, storage.id), 'STORAGE_NOT_FOUND', 404);
    await expectAppError(() => storages.folder(c.owner, child.id), 'FOLDER_NOT_FOUND', 404);
    await expectAppError(() => storages.folder(foreign, child.id), 'FOLDER_NOT_FOUND', 404);
    parent.status = 'TRASHED';
    await expectAppError(() => storages.folder(alice, child.id), 'FOLDER_NOT_FOUND', 404);
    parent.status = 'ACTIVE'; parent.parentFolderId = child.id;
    await expectAppError(() => storages.folder(alice, child.id), 'FOLDER_NOT_FOUND', 404);
    parent.parentFolderId = randomUUID();
    await expectAppError(() => storages.folder(alice, child.id), 'FOLDER_NOT_FOUND', 404);
  });

  it('prevents hierarchy escape, normalized sibling conflicts and writes to archived Drive', async () => {
    const c = await collabApp(), storages = c.collab.files.storages;
    const project = c.collab.tasks.projects.create(c.owner, b({ name: 'Drive', tools: ['DRIVE'] }));
    const storageId = c.collab.tasks.projects.linkedResources(c.owner, project.id).DRIVE.resourceId!, root = storages.root(c.owner, storageId);
    storages.createFolder(c.owner, b({ storageId, parentFolderId: root.id, name: 'Café' }));
    await expectAppError(() => storages.createFolder(c.owner, b({ storageId, parentFolderId: root.id, name: 'CAFE\u0301' })), 'FOLDER_NAME_CONFLICT', 409);
    const other = storages.createStorage(c.owner, b({ type: 'COMPANY', name: 'Company' }));
    await expectAppError(() => storages.createFolder(c.owner, b({ storageId: other.id, parentFolderId: root.id, name: 'Escape' })), 'FOLDER_NOT_FOUND', 404);
    c.collab.tasks.projects.archive(c.owner, project.id);
    expect(storages.get(c.owner, storageId).isReadOnly).toBe(true);
    await expectAppError(() => storages.createFolder(c.owner, b({ storageId, parentFolderId: root.id, name: 'Archived' })), 'STORAGE_READ_ONLY', 409);
  });
  it('delegates Project storage creation and retry to the canonical Project resource port', async () => {
    const c = await collabApp(), storages = c.collab.files.storages;
    const project = c.collab.tasks.projects.create(c.owner, b({ name: 'Canonical storage', tools: ['TASKS'] }));
    const first = storages.createStorage(c.owner, b({ type: 'PROJECT', projectId: project.id }));
    expect(storages.createStorage(c.owner, b({ type: 'PROJECT', projectId: project.id })).id).toBe(first.id);
    expect(c.collab.tasks.projects.linkedResources(c.owner, project.id).DRIVE.resourceId).toBe(first.id);
    expect(c.state.fileFolders.filter(row => row.storageId === first.id && row.parentFolderId === null)).toHaveLength(1);
  });
  it('reevaluates Role, Department tree and Project-role overrides on each read', async () => {
    const c = await collabApp(), storages = c.collab.files.storages;
    const alice = await c.memberActor('acl-alice', perms('OWN', 'storage.read', 'folder.read', 'chat.read'));
    const personal = storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Roles' }));
    const roleGrant = { id: randomUUID(), workspaceId: c.owner.workspaceId, resourceType: 'STORAGE' as const, resourceId: personal.id,
      subjectType: 'ROLE' as const, subjectId: alice.role.id, permissionLevel: 'READ' as const, inheritanceMode: 'INHERIT' as const };
    c.state.filePermissionAssignments.push(roleGrant);
    expect(storages.get(alice, personal.id).id).toBe(personal.id);
    c.state.filePermissionAssignments = [];
    const parent = c.app.departments.create(c.owner.user, c.owner.workspaceId, { name: 'ACL parent' });
    const child = c.app.departments.create(c.owner.user, c.owner.workspaceId, { name: 'ACL child', parentDepartmentId: parent.id });
    c.app.departments.addMembers(c.owner.user, c.owner.workspaceId, child.id, [alice.user.id]);
    c.state.filePermissionAssignments.push({ ...roleGrant, id: randomUUID(), subjectType: 'DEPARTMENT_TREE', subjectId: parent.id });
    expect(storages.get(alice, personal.id).id).toBe(personal.id);
    c.app.departments.softDelete(c.owner.user, c.owner.workspaceId, child.id);
    await expectAppError(() => storages.get(alice, personal.id), 'STORAGE_NOT_FOUND', 404);
    const project = c.collab.tasks.projects.create(c.owner, b({ name: 'Role Drive', tools: ['DRIVE'], memberUserIds: [alice.user.id] }));
    const id = c.collab.tasks.projects.linkedResources(c.owner, project.id).DRIVE.resourceId!, root = storages.root(c.owner, id);
    c.state.filePermissionAssignments.push({ ...roleGrant, id: randomUUID(), resourceType: 'FOLDER', resourceId: root.id,
      subjectType: 'PROJECT_ROLE', subjectId: 'OWNER', inheritanceMode: 'OVERRIDE' });
    expect(storages.root(c.owner, id).id).toBe(root.id);
    await expectAppError(() => storages.root(alice, id), 'FOLDER_NOT_FOUND', 404);
  });
});
