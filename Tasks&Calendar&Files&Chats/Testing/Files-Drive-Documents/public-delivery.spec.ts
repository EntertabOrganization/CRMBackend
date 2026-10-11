import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp } from '../support/domain';
const previous = process.env.FILE_DELIVERY_SECRET;
beforeAll(() => { process.env.FILE_DELIVERY_SECRET = 'public-delivery-secret-at-least-32-bytes'; });
afterAll(() => { if (previous === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = previous; });
async function fixture() {
  const c = await collabApp(), f = c.collab.files, bytes = Buffer.from('public delivered bytes'), objects = new Map<string, Buffer>();
  const storage = f.storages.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Shared' })), root = f.storages.root(c.owner, storage.id);
  const folder = f.storages.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Subtree' }));
  f.uploads.configure({ async putImmutable(key, value) { objects.set(key, value); }, async read(key) { return objects.get(key)!; } },
    { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const checksum = createHash('sha256').update(bytes).digest('hex'), session = f.uploads.create(c.owner, b({ targetFolderId: folder.id, desiredFileName: 'shared.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
  const receipt = await f.uploads.complete(c.owner, session.id, b()), file = c.state.driveFiles.find(row => row.id === receipt.resultFileId)!;
  const issue = (token: string, type: 'FILE' | 'FOLDER' = 'FILE', password: string | null = null) => f.delivery.issuePublic(token, type,
    type === 'FILE' ? new URLSearchParams() : new URLSearchParams({ fileId: file.id }), password);
  const redeem = (path: string) => { const url = new URL(path, 'http://localhost'); return f.delivery.redeem(url.pathname.split('/').at(-1)!, url.searchParams, 'private-client'); };
  return { c, f, bytes, file, root, folder, issue, redeem };
}
it('permits DOWNLOAD only, counts verified delivery once, and rejects unused grants when the limit is exhausted', async () => {
  const x = await fixture(), view = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b());
  await expectAppError(() => x.issue(view.token), 'PERMISSION_DENIED', 403);
  const link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b({ permissionMode: 'DOWNLOAD', maxDownloads: 1 }));
  const first = await x.issue(link.token), second = await x.issue(link.token);
  expect(x.c.state.filePublicLinks.find(row => row.id === link.id)!.downloadCount).toBe(0);
  expect((await x.redeem(first.deliveryPath)).bytes).toEqual(x.bytes);
  await expectAppError(() => x.redeem(second.deliveryPath), 'PUBLIC_LINK_DOWNLOAD_LIMIT', 410);
  expect(x.c.state.filePublicLinks.find(row => row.id === link.id)!).toMatchObject({ downloadCount: 1, accessCount: 1 });
  expect(x.c.state.auditLogs.some(row => row.action === 'PUBLIC_LINK.DOWNLOADED')).toBe(true);
  expect(x.c.state.auditLogs.filter(row => row.action === 'FILE.DELIVERY_AUTHORIZED').every(row => row.actorUserId === null)).toBe(true);
  expect(x.c.state.outboxEvents.find(row => row.eventType === 'FILE_DOWNLOADED')!.actorUserId).toBeNull();
});
it('fences previously issued paths through password changes, revocation and private business bindings', async () => {
  const x = await fixture(), link = await x.f.publicLinks.createFile(x.c.owner, x.file.id, b({ permissionMode: 'DOWNLOAD', password: 'old-password' }));
  await expectAppError(() => x.issue(link.token, 'FILE', 'bad'), 'PUBLIC_LINK_PASSWORD_INVALID', 403);
  const old = await x.issue(link.token, 'FILE', 'old-password');
  const changed = await x.f.publicLinks.update(x.c.owner, link.id, b({ password: 'new-password', version: 1 }));
  await expectAppError(() => x.redeem(old.deliveryPath), 'PUBLIC_LINK_REVOKED', 410);
  const next = await x.issue(link.token, 'FILE', 'new-password');
  x.c.state.calendarEventFiles.push({ id: randomUUID(), workspaceId: x.c.owner.workspaceId, fileId: x.file.id, eventId: randomUUID(), createdAt: new Date() });
  await expectAppError(() => x.redeem(next.deliveryPath), 'PUBLIC_LINK_REVOKED', 410);
  x.c.state.calendarEventFiles = [];
  x.f.publicLinks.revoke(x.c.owner, link.id, b({ version: changed.version }));
  await expectAppError(() => x.redeem(next.deliveryPath), 'PUBLIC_LINK_REVOKED', 410);
});
it('lists clean authorized folder content and removes access to Files moved outside the capability tree', async () => {
  const x = await fixture(), link = await x.f.publicLinks.createFolder(x.c.owner, x.root.id, b({ permissionMode: 'DOWNLOAD', includeChildren: true }));
  const listing = await x.f.publicLinks.publicFolder(link.token, new URLSearchParams({ folderId: x.folder.id }), null, 'client');
  expect(listing.files).toMatchObject([{ id: x.file.id, downloadPath: `/api/v1/public/folders/${link.token}/download?fileId=${x.file.id}` }]);
  const grant = await x.issue(link.token, 'FOLDER');
  const narrow = await x.f.publicLinks.createFolder(x.c.owner, x.folder.id, b({ permissionMode: 'DOWNLOAD' }));
  const narrowGrant = await x.issue(narrow.token, 'FOLDER');
  x.f.records.move(x.c.owner, x.file.id, b({ folderId: x.root.id, version: x.file.version }));
  await expectAppError(() => x.redeem(narrowGrant.deliveryPath), 'PUBLIC_LINK_NOT_FOUND', 404);
  expect((await x.redeem(grant.deliveryPath)).bytes).toEqual(x.bytes);
});
