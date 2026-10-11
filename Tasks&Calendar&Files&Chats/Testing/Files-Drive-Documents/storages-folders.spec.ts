import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Folder lifecycle', () => {
  it('moves, copies, trashes and restores a bounded graph without losing descendants', async () => {
    const c = await collabApp(), s = c.collab.files.storages, f = c.collab.files.folders;
    const storage = s.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Lifecycle' })), root = s.root(c.owner, storage.id);
    const parent = s.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Parent' }));
    const child = s.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: parent.id, name: 'Child' }));
    expect(f.tree(c.owner, root.id, new URLSearchParams('maxDepth=1'))).toMatchObject({ truncated: true });
    expect(f.children(c.owner, parent.id, new URLSearchParams()).data).toHaveLength(1);
    await expectAppError(() => f.move(c.owner, parent.id, b({ parentFolderId: child.id, version: parent.version })), 'FOLDER_HIERARCHY_CYCLE', 409);
    f.update(c.owner, child.id, b({ name: 'Renamed', version: child.version }));
    const copy = f.copy(c.owner, parent.id, b({ parentFolderId: root.id, name: 'Copy' }));
    expect(copy.copiedFolderCount).toBe(2);
    expect(f.tree(c.owner, copy.folder.id, new URLSearchParams()).nodes.map(row => row.name)).toEqual(['Copy', 'Renamed']);
    f.move(c.owner, child.id, b({ parentFolderId: root.id, version: child.version }));
    f.trash(c.owner, parent.id, b({ version: parent.version }));
    await expectAppError(() => s.folder(c.owner, parent.id), 'FOLDER_NOT_FOUND', 404);
    await expectAppError(() => f.purge(c.owner, parent.id, b({ version: parent.version })), 'FILE_RETENTION_HOLD', 409);
    parent.originalParentFolderId = randomUUID();
    await expectAppError(() => f.restore(c.owner, parent.id, b({ version: parent.version })), 'FOLDER_RESTORE_CONFLICT', 409);
    f.restore(c.owner, parent.id, b({ parentFolderId: root.id, name: 'Recovered', version: parent.version }));
    expect(parent.status).toBe('ACTIVE');
    c.owner.workspace.settings.fileRetentionDays = 0;
    f.trash(c.owner, copy.folder.id, b({ version: copy.folder.version }));
    expect(f.purge(c.owner, copy.folder.id, b({ version: copy.folder.version })).deletedFolderCount).toBe(2);
    expect(c.state.fileFolders.some(row => row.parentFolderId === copy.folder.id)).toBe(false);
  });

  it('preserves tenant, permission, root, retention and storage configuration fences', async () => {
    const c = await collabApp(), s = c.collab.files.storages, f = c.collab.files.folders;
    const denied = await c.memberActor('lifecycle-denied', perms('OWN', 'folder.read'));
    const foreign = await c.foreignActor();
    const storage = s.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Private' })), root = s.root(c.owner, storage.id);
    const folder = s.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Held' }));
    await expectAppError(() => f.update(denied, folder.id, b({ name: 'Denied', version: 1 })), 'PERMISSION_DENIED', 403);
    await expectAppError(() => f.tree(foreign, root.id, new URLSearchParams()), 'FOLDER_NOT_FOUND', 404);
    await expectAppError(() => f.trash(c.owner, root.id, b({ version: root.version })), 'FOLDER_ROOT_MANAGED', 409);
    c.owner.workspace.settings.fileRetentionDays = 0;
    f.trash(c.owner, folder.id, b({ version: folder.version }));
    c.state.retentionRecords.push({ id: randomUUID(), workspaceId: c.owner.workspaceId, category: 'FILE', resourceId: folder.id, legalHold: true, expiresAt: new Date(0), createdAt: new Date() } as any);
    await expectAppError(() => f.purge(c.owner, folder.id, b({ version: folder.version })), 'FILE_RETENTION_HOLD', 409);
    s.updateStorage(c.owner, storage.id, b({ name: 'Changed', isActive: false, version: storage.version }));
    await expectAppError(() => s.get(c.owner, storage.id), 'STORAGE_NOT_FOUND', 404);
    s.updateStorage(c.owner, storage.id, b({ isActive: true, version: storage.version }));
    expect(s.root(c.owner, storage.id).name).toBe('Changed');
  });
});
