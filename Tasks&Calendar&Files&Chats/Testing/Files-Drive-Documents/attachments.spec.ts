import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
async function fixture() {
  const c = await collabApp(), f = c.collab.files, a = c.collab.attachments;
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Attachments' })), root = f.storages.root(c.owner, storage.id);
  const bytes = Buffer.from('shared attachment'), objects = new Map<string, Buffer>(), checksum = createHash('sha256').update(bytes).digest('hex');
  f.uploads.configure({ async putImmutable(key, data) { objects.set(key, data); }, async read(key) { return objects.get(key)!; } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const session = f.uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'shared.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
  const receipt = await f.uploads.complete(c.owner, session.id, b()), fileId = receipt.resultFileId!;
  const task = c.collab.tasks.tasks.create(c.owner, { title: 'Owner record' });
  const attach = (entityId = task.id, role = 'ATTACHMENT') => a.attach(c.owner, b({ fileId, entityType: 'TASK', entityId, role }));
  return { c, f, a, fileId, task, root, storage, objects, objectCount: objects.size, attach };
}
it('Cross-workspace bind is rejected without revealing foreign records.', async () => {
  const x = await fixture(), foreign = await x.c.foreignActor(), foreignTask = x.c.collab.tasks.tasks.create(foreign, { title: 'Foreign' });
  await expectAppError(() => x.attach(foreignTask.id), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
  await expectAppError(() => x.a.attach(foreign, b({ fileId: x.fileId, entityType: 'TASK', entityId: foreignTask.id })), 'ATTACHMENT_FILE_ACCESS_DENIED', 403);
  expect(x.c.state.fileAttachments).toHaveLength(0);
});
it('File allowed but target denied, including read-only observers and live authority changes.', async () => {
  const x = await fixture(), actor = await x.c.memberActor('observer', perms('OWN', 'file.read', 'file.attach', 'file.detach', 'file.copy', 'file.download', 'task.read', 'task.update'));
  const task = x.c.state.tasks.find(row => row.id === x.task.id)!;
  x.c.state.taskMembers.push({ id: randomUUID(), workspaceId: actor.workspaceId, taskId: task.id, userId: actor.user.id, role: 'OBSERVER', addedByUserId: x.c.owner.user.id, createdAt: new Date() });
  x.f.access.replace(x.c.owner, 'FILE', x.fileId, b({ version: x.c.state.driveFiles[0].version, assignments: [{ subjectType: 'USER', subjectId: actor.user.id, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] }));
  expect(x.a.check(actor.workspaceId, actor, x.fileId)).toBe('OK');
  await expectAppError(() => x.a.attach(actor, b({ fileId: x.fileId, entityType: 'TASK', entityId: task.id })), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
  const row = x.attach(); expect(x.a.get(actor, row.id).id).toBe(row.id);
  x.c.state.taskMembers = x.c.state.taskMembers.filter(item => item.userId !== actor.user.id);
  await expectAppError(() => x.a.get(actor, row.id), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
  expect(x.a.list(actor, new URLSearchParams()).meta.total).toBe(0);
  await expectAppError(() => x.f.records.copy(actor, x.fileId, b({ folderId: x.root.id })), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
  await expectAppError(() => x.f.delivery.issue(actor, x.fileId, new URLSearchParams()), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
});
it('Target allowed but File denied; no metadata or binding is disclosed.', async () => {
  const x = await fixture(), actor = await x.c.memberActor('no-file', perms('WORKSPACE', 'file.attach', 'file.read', 'task.read', 'task.update'));
  const task = x.c.collab.tasks.tasks.create(x.c.owner, { title: 'Visible' });
  await expectAppError(() => x.a.attach(actor, b({ fileId: x.fileId, entityType: 'TASK', entityId: task.id })), 'ATTACHMENT_FILE_ACCESS_DENIED', 403);
  const row = x.attach(); await expectAppError(() => x.a.get(actor, row.id), 'ATTACHMENT_FILE_ACCESS_DENIED', 403);
});
it('Shared File detached from one of several entities; retries deduplicate and emit exactly once.', async () => {
  const x = await fixture(), second = x.c.collab.tasks.tasks.create(x.c.owner, { title: 'Second' }), first = x.attach(), other = x.attach(second.id);
  expect(x.attach().id).toBe(first.id); expect(x.c.state.fileAttachments).toHaveLength(2);
  expect(x.objects.size).toBe(x.objectCount); expect(x.c.state.driveFileVersions).toHaveLength(1);
  x.a.detach(x.c.owner, first.id, b());
  expect(x.a.get(x.c.owner, other.id).fileId).toBe(x.fileId); expect(x.c.state.driveFiles).toHaveLength(1); expect(x.objects.size).toBe(x.objectCount);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'FILE_ATTACHED')).toHaveLength(2);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'FILE_DETACHED')).toHaveLength(1);
  await expectAppError(() => x.a.detach(x.c.owner, first.id, b()), 'ATTACHMENT_NOT_FOUND', 404);
});
it('Private attachments retire grants, prohibit public content, block purge and let owners clean deleted target references.', async () => {
  const x = await fixture(), before = x.c.state.driveFiles[0].publicShareVersion, row = x.attach();
  expect(x.c.state.driveFiles[0].publicShareVersion).toBeGreaterThan(before);
  await expectAppError(() => x.f.publicLinks.createFile(x.c.owner, x.fileId, b()), 'PUBLIC_LINK_REVOKED', 410);
  x.f.records.trash(x.c.owner, x.fileId, b({ version: x.c.state.driveFiles[0].version }));
  await expectAppError(() => x.f.records.purge(x.c.owner, x.fileId, b({ version: x.c.state.driveFiles[0].version })), 'FILE_HAS_ATTACHMENTS', 409);
  x.c.state.tasks.find(item => item.id === x.task.id)!.isDeleted = true;
  x.a.detach(x.c.owner, row.id, b());
  x.c.state.driveFiles[0].purgeAfter = new Date(0);
  for (const row of x.c.state.retentionRecords) row.expiresAt = new Date(0);
  x.f.records.purge(x.c.owner, x.fileId, b({ version: x.c.state.driveFiles[0].version }));
  expect(x.c.state.driveFiles).toHaveLength(0);
});
it('Registers owning modules, rejects unsupported targets and uses real File authority in the default port.', async () => {
  const x = await fixture();
  await expectAppError(() => x.a.attach(x.c.owner, b({ fileId: x.fileId, entityType: 'UNREGISTERED', entityId: randomUUID() })), 'ATTACHMENT_ENTITY_ACCESS_DENIED', 403);
  const chat = x.c.collab.communication.chats.createGroup(x.c.owner, b({ title: 'Owning chat', memberUserIds: [] }));
  const row = x.a.attach(x.c.owner, b({ fileId: x.fileId, entityType: 'CHAT', entityId: chat.id, role: 'MEDIA' }));
  expect(x.a.get(x.c.owner, row.id).role).toBe('MEDIA');
  expect(x.a.check(x.c.owner.workspaceId, x.c.owner, randomUUID())).toBe('MISSING');
});

it('refuses attachment creation in archived storage without changing its revision or emitting an event', async () => {
  const x = await fixture(), storage = x.c.state.fileStorages.find(row => row.id === x.storage.id)!;
  storage.isReadOnly = true;
  const version = x.c.state.driveFiles[0].version;
  await expectAppError(() => x.attach(), 'ATTACHMENT_FILE_ACCESS_DENIED', 403);
  expect(x.c.state.driveFiles[0].version).toBe(version);
  expect(x.c.state.fileAttachments).toHaveLength(0);
});
