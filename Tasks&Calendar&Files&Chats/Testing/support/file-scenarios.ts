import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from './domain';

export async function fileScenarioFixture() {
 const c = await collabApp(), f = c.collab.files, objects = new Map<string, Buffer>(), bytes = Buffer.from('version one');
 const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Overview' })), root = f.storages.root(c.owner, storage.id);
 const folder = f.storages.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Shared' }));
 f.uploads.configure({ async putImmutable(key, data) { objects.set(key, data); }, async read(key) { return objects.get(key)!; } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
 const checksum = createHash('sha256').update(bytes).digest('hex');
 const input = { targetFolderId: folder.id, desiredFileName: 'overview.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() };
 const session = f.uploads.create(c.owner, b(input));
 await f.uploads.part(c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
 const receipt = await f.uploads.complete(c.owner, session.id, b()), file = c.state.driveFiles.find(row => row.id === receipt.resultFileId)!;
 const upload = async (folderId: string, name: string) => {
  const pending = f.uploads.create(c.owner, b({ ...input, targetFolderId: folderId, desiredFileName: name, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, pending.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
  const result = await f.uploads.complete(c.owner, pending.id, b());
  return c.state.driveFiles.find(row => row.id === result.resultFileId)!;
 };
 return { c, f, root, folder, storage, file, input, bytes, objects, upload };
}

export const fileOverviewScenarios = {
 async 'Version immutability.'() {
  const x = await fileScenarioFixture(), original = structuredClone(x.c.state.driveFileVersions[0]);
  const restored = x.f.records.restoreVersion(x.c.owner, x.file.id, original.id, b({ version: x.file.version }));
  expect(restored.version).toMatchObject({ versionNumber: 2, checksum: original.checksum });
  expect(restored.version.id).not.toBe(original.id); expect(x.c.state.driveFileVersions.find(row => row.id === original.id)).toEqual(original);
  expect(x.c.state.driveFileVersions).toHaveLength(2);
  expect(JSON.stringify(x.f.records.versions(x.c.owner, x.file.id, new URLSearchParams()))).not.toContain(original.objectKey);
 },
 async 'ACL inheritance and business-record intersection.'() {
  const x = await fileScenarioFixture(), reader = await x.c.memberActor('overview-reader', [...perms('WORKSPACE', 'file.read'), ...perms('OWN', 'task.read')]);
  x.f.access.replace(x.c.owner, 'FOLDER', x.folder.id, b({ version: x.folder.version, assignments: [{ subjectType: 'USER', subjectId: reader.user.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] }));
  expect(x.f.records.get(reader, x.file.id).id).toBe(x.file.id);
  const task = x.c.collab.tasks.tasks.create(x.c.owner, { title: 'Private context' });
  const attachment = x.c.collab.attachments.attach(x.c.owner, b({ fileId: x.file.id, entityType: 'TASK', entityId: task.id }));
  // Even broad File visibility cannot circumvent a private owning record.
  await expectAppError(() => x.c.collab.attachments.get(reader, attachment.id), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
 },
 async 'Public token expiry/password/revocation.'() {
  const x = await fileScenarioFixture(), link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b({ password: 'overview-password' }));
  const read = (password: string | null) => x.f.publicLinks.publicFile(link.token, new URLSearchParams(), password, 'client');
  await expectAppError(() => read('wrong'), 'PUBLIC_LINK_PASSWORD_INVALID', 403); expect((await read('overview-password')).file.id).toBe(x.file.id);
  const stored = x.c.state.filePublicLinks.find(row => row.id === link.id)!; stored.expiresAt = new Date(0);
  await expectAppError(() => read('overview-password'), 'PUBLIC_LINK_EXPIRED', 410); stored.expiresAt = new Date(Date.now() + 86400000);
  x.f.publicLinks.revoke(x.c.owner, link.id, b({ version: stored.version })); await expectAppError(() => read('overview-password'), 'PUBLIC_LINK_REVOKED', 410);
 },
 async 'Quarantine blocks access.'() {
  const x = await fileScenarioFixture(); x.file.status = 'QUARANTINED'; x.c.state.driveFileVersions[0].scanStatus = 'PENDING';
  await expectAppError(() => x.f.delivery.issue(x.c.owner, x.file.id, new URLSearchParams()), 'FILE_QUARANTINED', 409);
  await expectAppError(() => x.f.publicLinks.createFile(x.c.owner, x.file.id, b()), 'PUBLIC_LINK_REVOKED', 410);
  expect(x.c.state.fileDeliveryGrants).toEqual([]);
 },
 async 'Quota and upload-size failures.'() {
  const x = await fileScenarioFixture(); x.c.owner.workspace.settings.fileMaxBytes = 1;
  await expectAppError(() => x.f.uploads.create(x.c.owner, b({ ...x.input, desiredFileName: 'too-big.txt', idempotencyKey: randomUUID() })), 'FILE_TOO_LARGE', 413);
  x.c.owner.workspace.settings.fileMaxBytes = 100; x.c.owner.workspace.settings.fileStorageQuotaBytes = x.bytes.length;
  await expectAppError(() => x.f.uploads.create(x.c.owner, b({ ...x.input, desiredFileName: 'no-quota.txt', idempotencyKey: randomUUID() })), 'STORAGE_QUOTA_EXCEEDED', 409);
  expect(x.c.state.uploadSessions).toHaveLength(1); expect(x.c.state.driveFiles).toHaveLength(1);
 },
};

export const fileSharingScenarios = {
 async 'Inheritance override.'() {
  const x = await fileScenarioFixture(), reader = await x.c.memberActor('inherited', perms('WORKSPACE', 'file.read'));
  x.f.access.replace(x.c.owner, 'FOLDER', x.folder.id, b({ version: x.folder.version, assignments: [{ subjectType: 'USER', subjectId: reader.user.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] }));
  expect(x.f.records.get(reader, x.file.id).id).toBe(x.file.id);
  const changed = x.f.access.replace(x.c.owner, 'FILE', x.file.id, b({ version: x.file.version, assignments: [{ subjectType: 'USER', subjectId: x.c.owner.user.id, permissionLevel: 'FULL', inheritanceMode: 'OVERRIDE' }] }));
  await expectAppError(() => x.f.records.get(reader, x.file.id), 'FILE_NOT_FOUND', 404);
  x.f.access.replace(x.c.owner, 'FILE', x.file.id, b({ version: changed.version, assignments: [] })); expect(x.f.records.get(reader, x.file.id).id).toBe(x.file.id);
 },
 async 'Project role vs file override.'() {
  const x = await fileScenarioFixture(), reader = await x.c.memberActor('project-reader', perms('WORKSPACE', 'file.read', 'folder.read', 'storage.read'));
  const project = x.c.collab.tasks.projects.create(x.c.owner, b({ name: 'Project sharing', tools: ['DRIVE'], memberUserIds: [reader.user.id] }));
  const drive = x.c.collab.tasks.projects.linkedResources(x.c.owner, project.id).DRIVE.resourceId!;
  const root = x.f.storages.root(x.c.owner, drive);
  const copy = await x.upload(root.id, 'project.txt');
  expect(x.f.records.get(reader, copy.id).id).toBe(copy.id);
  x.f.access.replace(x.c.owner, 'FILE', copy.id, b({ version: copy.version, assignments: [{ subjectType: 'USER', subjectId: x.c.owner.user.id, permissionLevel: 'FULL', inheritanceMode: 'OVERRIDE' }] }));
  await expectAppError(() => x.f.records.get(reader, copy.id), 'FILE_NOT_FOUND', 404);
 },
 async 'Expired/password/limit public link.'() {
  await fileOverviewScenarios['Public token expiry/password/revocation.']();
  const x = await fileScenarioFixture(), link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b({ permissionMode: 'DOWNLOAD', maxDownloads: 1 }));
  x.c.state.filePublicLinks.find(row => row.id === link.id)!.downloadCount = 1;
  await expectAppError(() => x.f.delivery.issuePublic(link.token, 'FILE', new URLSearchParams(), null), 'PUBLIC_LINK_DOWNLOAD_LIMIT', 410);
 },
 async 'Folder move out of public tree.'() {
  const x = await fileScenarioFixture(), link = await x.f.publicLinks.createFolder(x.c.owner, x.folder.id, b({ includeChildren: true, permissionMode: 'DOWNLOAD' }));
  expect((await x.f.publicLinks.publicFolder(link.token, new URLSearchParams(), null, 'client')).files.map(row => row.id)).toEqual([x.file.id]);
  x.f.records.move(x.c.owner, x.file.id, b({ folderId: x.root.id, version: x.file.version }));
  expect((await x.f.publicLinks.publicFolder(link.token, new URLSearchParams(), null, 'client')).files).toEqual([]);
  await expectAppError(() => x.f.delivery.issuePublic(link.token, 'FOLDER', new URLSearchParams({ fileId: x.file.id }), null), 'PUBLIC_LINK_NOT_FOUND', 404);
 },
};
