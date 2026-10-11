import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Versioned storage and folder ACL configuration', () => {
  it('restricts inherited Project access and restores it when direct assignments are cleared', async () => {
    const c = await collabApp();
    const alice = await c.memberActor('acl-config-alice', perms('WORKSPACE', 'folder.read', 'storage.read', 'file.permission_manage'));
    const project = c.collab.tasks.projects.create(c.owner, b({ name: 'ACL project', tools: ['DRIVE'], memberUserIds: [alice.user.id] }));
    const storageId = c.collab.tasks.projects.linkedResources(c.owner, project.id).DRIVE.resourceId!;
    const root = c.collab.files.storages.root(c.owner, storageId);
    const child = c.collab.files.storages.createFolder(c.owner, b({ storageId, parentFolderId: root.id, name: 'Restricted' }));
    const access = c.collab.files.access;
    await expectAppError(() => access.get(alice, 'FOLDER', child.id), 'FOLDER_NOT_FOUND', 404);
    const updated = access.replace(c.owner, 'FOLDER', child.id, b({ version: child.version, assignments: [
      { subjectType: 'USER', subjectId: c.owner.user.id, permissionLevel: 'FULL', inheritanceMode: 'OVERRIDE' },
      { subjectType: 'PROJECT_ROLE', subjectId: 'MEMBER', permissionLevel: 'NONE', inheritanceMode: 'OVERRIDE' },
    ] }));
    expect(access.get(c.owner, 'FOLDER', child.id).assignments).toHaveLength(2);
    await expectAppError(() => c.collab.files.storages.folder(alice, child.id), 'FOLDER_NOT_FOUND', 404);
    await expectAppError(() => access.replace(c.owner, 'FOLDER', child.id, b({ version: 1, assignments: [] })), 'RESOURCE_VERSION_CONFLICT', 409);
    access.replace(c.owner, 'FOLDER', child.id, b({ version: updated.version, assignments: [] }));
    expect(c.collab.files.storages.folder(alice, child.id).id).toBe(child.id);
  });

  it('validates every subject before replacing an ACL and distinguishes platform action from resource authority', async () => {
    const c = await collabApp(), foreign = await c.foreignActor();
    const denied = await c.memberActor('acl-config-denied', perms('WORKSPACE', 'storage.read'));
    const storage = c.collab.files.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'ACL' }));
    const access = c.collab.files.access;
    await expectAppError(() => access.get(denied, 'STORAGE', storage.id), 'PERMISSION_DENIED', 403);
    await expectAppError(() => access.get(foreign, 'STORAGE', storage.id), 'STORAGE_NOT_FOUND', 404);
    const entry = { subjectType: 'USER', subjectId: c.owner.user.id, permissionLevel: 'FULL', inheritanceMode: 'INHERIT' };
    for (const assignments of [[{ ...entry, subjectId: foreign.user.id }], [entry, entry], [entry, { ...entry, subjectType: 'WORKSPACE', subjectId: null, inheritanceMode: 'OVERRIDE' }], [{ ...entry, subjectType: 'PROJECT_ROLE', subjectId: 'OWNER' }], [{ ...entry, subjectType: 'EXTERNAL_GUEST', subjectId: foreign.user.id }]]) {
      await expectAppError(() => access.replace(c.owner, 'STORAGE', storage.id, b({ version: storage.version, assignments })), 'FILE_PERMISSION_INVALID', 400);
      expect(access.get(c.owner, 'STORAGE', storage.id).assignments).toHaveLength(0);
      expect(storage.version).toBe(1);
    }
    const changed = access.replace(c.owner, 'STORAGE', storage.id, b({ version: storage.version, assignments: [{ subjectType: 'ROLE', subjectId: denied.role.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] }));
    expect(changed.version).toBe(2);
    expect(c.collab.files.storages.get(denied, storage.id).id).toBe(storage.id);
    const system = c.collab.files.storages.createStorage(c.owner, b({ type: 'SYSTEM', name: 'System ACL' }));
    access.replace(c.owner, 'STORAGE', system.id, b({ version: system.version, assignments: [{ subjectType: 'USER', subjectId: denied.user.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] }));
    expect(c.collab.files.storages.get(denied, system.id).isReadOnly).toBe(true);
    access.replace(c.owner, 'STORAGE', system.id, b({ version: system.version, assignments: [] }));
    await expectAppError(() => c.collab.files.storages.get(denied, system.id), 'STORAGE_NOT_FOUND', 404);
  });
});
