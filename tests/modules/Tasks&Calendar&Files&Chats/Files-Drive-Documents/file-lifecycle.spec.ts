import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
import type { DriveFile, DriveFileVersion } from '@/src/server/collab/files/types';

async function fixture() {
  const c = await collabApp(), reader = await c.memberActor('file-core-reader', perms('WORKSPACE', 'file.read'));
  const foreign = await c.foreignActor(), s = c.collab.files.storages;
  const storage = s.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Files' })), root = s.root(c.owner, storage.id);
  const folder = s.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Folder' }));
  const now = new Date(), fileId = randomUUID(), versionId = randomUUID();
  const file: DriveFile = { id: fileId, workspaceId: c.owner.workspaceId, storageId: storage.id, folderId: folder.id, name: 'report.pdf', extension: 'pdf', mimeType: 'application/pdf',
    status: 'ACTIVE', currentVersionId: versionId, sizeBytesCurrent: 10, version: 1, publicShareVersion: 1, originalFolderId: null, statusBeforeTrash: null, trashedAt: null, purgeAfter: null, createdAt: now, updatedAt: now };
  const version: DriveFileVersion = { id: versionId, workspaceId: file.workspaceId, fileId, versionNumber: 1, objectKey: `${file.workspaceId}/immutable-object`, sizeBytes: 10,
    checksum: 'a'.repeat(64), mimeType: file.mimeType, createdByUserId: c.owner.user.id, createdAt: now, processedAt: now, scanStatus: 'CLEAN' };
  c.state.driveFiles.push(file); c.state.driveFileVersions.push(version);
  return { c, reader, foreign, storage, root, folder, file, version, records: c.collab.files.records };
}

describe('Logical Files and immutable Versions', () => {
  it('copies folder content and revokes descendant shares without reactivating independently trashed Files', async () => {
    const { c, reader, records, file, folder, root } = await fixture();
    const copied = c.collab.files.folders.copy(c.owner, folder.id, b({ parentFolderId: root.id, name: 'Folder copy' }));
    expect(copied.copiedFileCount).toBe(1);
    expect(c.state.driveFiles.find(row => row.folderId === copied.folder.id)!.currentVersionId).not.toBe(file.currentVersionId);
    records.trash(c.owner, file.id, b({ version: file.version }));
    const oldShareVersion = file.publicShareVersion;
    c.collab.files.folders.trash(c.owner, folder.id, b({ version: folder.version }));
    expect(file.publicShareVersion).toBe(oldShareVersion + 1);
    c.collab.files.folders.restore(c.owner, folder.id, b({ version: folder.version }));
    await expectAppError(() => records.get(c.owner, file.id), 'FILE_NOT_FOUND', 404);
    const privateFile = c.state.driveFiles.find(row => row.folderId === copied.folder.id)!;
    c.collab.files.access.replace(c.owner, 'FILE', privateFile.id, b({ version: privateFile.version, assignments: [
      { subjectType: 'USER', subjectId: reader.user.id, permissionLevel: 'FULL', inheritanceMode: 'OVERRIDE' },
    ] }));
    const folderCount = c.state.fileFolders.length;
    await expectAppError(() => c.collab.files.folders.copy(c.owner, copied.folder.id, b({ parentFolderId: root.id, name: 'Denied copy' })), 'FILE_NOT_FOUND', 404);
    expect(c.state.fileFolders).toHaveLength(folderCount);
  });
  it('recovers blocked current content by creating a new Version from clean history', async () => {
    const { c, records, file, version } = await fixture();
    const blocked = { ...version, id: randomUUID(), versionNumber: 2, scanStatus: 'BLOCKED' as const, checksum: 'b'.repeat(64), objectKey: `${file.workspaceId}/blocked-object` };
    c.state.driveFileVersions.push(blocked); file.currentVersionId = blocked.id; file.status = 'BLOCKED';
    const recovered = records.restoreVersion(c.owner, file.id, version.id, b({ version: file.version }));
    expect(recovered.file.status).toBe('ACTIVE'); expect(recovered.version.versionNumber).toBe(3);
    expect(blocked.scanStatus).toBe('BLOCKED'); expect(version.scanStatus).toBe('CLEAN');
  });
  it('moves, copies, trashes, recovers and restores historical content by creating another immutable version', async () => {
    const { c, records, file, version, root } = await fixture();
    const original = structuredClone(version);
    records.update(c.owner, file.id, b({ name: 'Renamed.txt', version: file.version }));
    expect(file.extension).toBe('txt');
    records.move(c.owner, file.id, b({ folderId: root.id, version: file.version }));
    const copied = records.copy(c.owner, file.id, b({ folderId: root.id, name: 'Copy.txt' }));
    expect(copied.currentVersionId).not.toBe(file.currentVersionId);
    expect(c.state.driveFileVersions.find(row => row.id === copied.currentVersionId)!.objectKey).toBe(version.objectKey);
    const restored = records.restoreVersion(c.owner, file.id, version.id, b({ version: file.version }));
    expect(restored.version.versionNumber).toBe(2); expect(version).toEqual(original);
    expect(JSON.stringify(records.versions(c.owner, file.id, new URLSearchParams()))).not.toContain('immutable-object');
    records.trash(c.owner, file.id, b({ version: file.version }));
    await expectAppError(() => records.get(c.owner, file.id), 'FILE_NOT_FOUND', 404);
    records.restore(c.owner, file.id, b({ name: 'Recovered.txt', version: file.version }));
    expect(records.get(c.owner, file.id).status).toBe('ACTIVE');
    expect(records.processing(c.owner, file.id).scanStatus).toBe('CLEAN');
  });
  it('keeps direct File ACLs, quota failures, restricted content and conflicts from bypassing authority', async () => {
    const { c, reader, foreign, records, file, version, root } = await fixture();
    await expectAppError(() => records.get(reader, file.id), 'FILE_NOT_FOUND', 404);
    await expectAppError(() => records.get(foreign, file.id), 'FILE_NOT_FOUND', 404);
    const acl = c.collab.files.access.replace(c.owner, 'FILE', file.id, b({ version: file.version, assignments: [
      { subjectType: 'USER', subjectId: reader.user.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' },
    ] }));
    expect(records.list(reader, new URLSearchParams()).data).toHaveLength(1);
    await expectAppError(() => records.update(reader, file.id, b({ name: 'Denied', version: acl.version })), 'PERMISSION_DENIED', 403);
    await expectAppError(() => records.update(c.owner, file.id, b({ name: 'Stale', version: 1 })), 'RESOURCE_VERSION_CONFLICT', 409);
    records.copy(c.owner, file.id, b({ folderId: root.id, name: file.name }));
    await expectAppError(() => records.move(c.owner, file.id, b({ folderId: root.id, version: file.version })), 'FILE_NAME_CONFLICT', 409);
    c.state.workspaces.find(row => row.id === file.workspaceId)!.settings.fileStorageQuotaBytes = 20;
    await expectAppError(() => records.restoreVersion(c.owner, file.id, version.id, b({ version: file.version })), 'STORAGE_QUOTA_EXCEEDED', 409);
    expect(c.state.driveFileVersions.filter(row => row.fileId === file.id)).toHaveLength(1);
    file.status = 'BLOCKED'; version.scanStatus = 'BLOCKED';
    await expectAppError(() => records.copy(c.owner, file.id, b({ folderId: root.id, name: 'Blocked' })), 'FILE_BLOCKED', 409);
    expect(records.processing(c.owner, file.id).status).toBe('BLOCKED');
  });
});
