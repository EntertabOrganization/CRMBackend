import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
async function fixture() {
  const c = await collabApp(), f = c.collab.files, bytes = Buffer.from('public clean content'), objects = new Map<string, Buffer>();
  c.owner.workspace.settings.fileRetentionDays = 0;
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Public Files' })), root = f.storages.root(c.owner, storage.id);
  f.uploads.configure({ async putImmutable(key, value) { objects.set(key, value); }, async read(key) { return objects.get(key)!; } },
    { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const session = f.uploads.create(c.owner, b({ targetFolderId: root.id, desiredFileName: 'shared.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
  const receipt = await f.uploads.complete(c.owner, session.id, b());
  const file = c.state.driveFiles.find(row => row.id === receipt.resultFileId)!;
  const read = (token: string, password: string | null = null) => f.publicLinks.publicFile(token, new URLSearchParams(), password, 'private-client');
  return { c, f, file, root, read };
}
it('creates hash-only File capabilities and enforces password, resource type and restricted public metadata', async () => {
  const x = await fixture(), link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b({ password: 'valid-password', permissionMode: 'DOWNLOAD', maxDownloads: 1 }));
  expect(link).toMatchObject({ resourceType: 'FILE', includeChildren: false, publicPath: `/api/v1/public/files/${link.token}` });
  await expectAppError(() => x.read(link.id), 'PUBLIC_LINK_NOT_FOUND', 404);
  await expectAppError(() => x.read(link.token, 'invalid'), 'PUBLIC_LINK_PASSWORD_INVALID', 403);
  await expectAppError(() => x.f.publicLinks.publicFolder(link.token, new URLSearchParams(), 'valid-password', 'client'), 'PUBLIC_LINK_NOT_FOUND', 404);
  expect(await x.read(link.token, 'valid-password')).toMatchObject({ permissionMode: 'DOWNLOAD', file: { id: x.file.id, name: 'shared.txt', mimeType: 'text/plain' } });
  expect(x.c.state.filePublicLinks[0]).toMatchObject({ accessCount: 1, downloadCount: 0 });
  expect(JSON.stringify(x.f.publicLinks.get(x.c.owner, link.id))).not.toMatch(/tokenHash|passwordHash|valid-password/);
  expect(JSON.stringify(x.c.state.auditLogs)).not.toContain(link.token);
  await expectAppError(() => x.f.publicLinks.createFile(x.c.owner, x.file.id, b({ includeChildren: true })), 'VALIDATION_ERROR', 400);
});
it('requires live FULL issuer authority and never grants access through private business bindings', async () => {
  const x = await fixture(), denied = await x.c.memberActor('public-denied', perms('WORKSPACE', 'file.public_link_manage')), foreign = await x.c.foreignActor();
  await expectAppError(() => x.f.publicLinks.createFile(denied, x.file.id, b()), 'FILE_NOT_FOUND', 404);
  await expectAppError(() => x.f.publicLinks.createFile(foreign, x.file.id, b()), 'FILE_NOT_FOUND', 404);
  const link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b());
  x.c.state.calendarEventFiles.push({ id: randomUUID(), workspaceId: x.c.owner.workspaceId, eventId: randomUUID(), fileId: x.file.id, createdAt: new Date() });
  await expectAppError(() => x.read(link.token), 'PUBLIC_LINK_REVOKED', 410);
  await expectAppError(() => x.f.publicLinks.createFile(x.c.owner, x.file.id, b()), 'PUBLIC_LINK_REVOKED', 410);
  expect(x.c.state.filePublicLinks[0].accessCount).toBe(0);
  x.c.state.calendarEventFiles = [];
  const membership = x.c.state.workspaceMemberships.find(row => row.workspaceId === x.c.owner.workspaceId && row.userId === x.c.owner.user.id)!;
  membership.status = 'SUSPENDED';
  await expectAppError(() => x.read(link.token), 'PUBLIC_LINK_REVOKED', 410);
});
it('supports common File link management and fences policy, expiry, quarantine, trash, restore and purge', async () => {
  const x = await fixture(), link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b());
  const updated = await x.f.publicLinks.update(x.c.owner, link.id, b({ password: 'new-password', version: link.version }));
  await expectAppError(() => x.f.publicLinks.update(x.c.owner, link.id, b({ version: link.version })), 'RESOURCE_VERSION_CONFLICT', 409);
  x.file.status = 'QUARANTINED'; await expectAppError(() => x.read(link.token, 'new-password'), 'PUBLIC_LINK_REVOKED', 410);
  x.file.status = 'ACTIVE';
  x.c.owner.workspace.settings.publicLinksEnabled = false; await expectAppError(() => x.read(link.token), 'PUBLIC_LINK_REVOKED', 410);
  x.c.owner.workspace.settings.publicLinksEnabled = true;
  x.c.state.filePublicLinks[0].expiresAt = new Date(0); await expectAppError(() => x.read(link.token), 'PUBLIC_LINK_EXPIRED', 410);
  x.c.state.filePublicLinks[0].expiresAt = new Date(Date.now() + 86400000);
  x.f.records.trash(x.c.owner, x.file.id, b({ version: x.file.version }));
  x.f.records.restore(x.c.owner, x.file.id, b({ version: x.file.version }));
  await expectAppError(() => x.read(link.token, 'new-password'), 'PUBLIC_LINK_REVOKED', 410);
  const revoked = x.f.publicLinks.revoke(x.c.owner, link.id, b({ version: updated.version }));
  await expectAppError(() => x.f.publicLinks.update(x.c.owner, link.id, b({ version: revoked.version, isActive: true })), 'PUBLIC_LINK_REVOKED', 410);
  x.f.records.trash(x.c.owner, x.file.id, b({ version: x.file.version })); x.f.records.purge(x.c.owner, x.file.id, b({ version: x.file.version }));
  expect(x.c.state.filePublicLinks).toEqual([]); await expectAppError(() => x.read(link.token), 'PUBLIC_LINK_NOT_FOUND', 404);
});
