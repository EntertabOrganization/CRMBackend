import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
const priorSecret = process.env.FILE_DELIVERY_SECRET;
beforeAll(async () => { await prepareCollabDatabase(); process.env.FILE_DELIVERY_SECRET = 'test-delivery-signing-secret-with-32-bytes'; });
afterAll(async () => { if (priorSecret === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = priorSecret; await disconnect(); });
async function fixture() {
  const owner = await register('delivery'), prisma = await db(), { appContext } = await import('@/src/server/app-context'), objects = new LocalObjectStorage();
  appContext.collab.files.uploads.configure(objects, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Delivery' } })), root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('real signed download bytes'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'unsafe\r\n名.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
  const receipt = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  const file = expectOk(await call(owner, 'GET', `files/${receipt.resultFileId}`));
  const issue = () => call(owner, 'GET', `files/${file.id}/download`);
  const redeem = async (path: string) => { const { GET } = await import('@/app/api/v1/file-delivery/[id]/route'); return GET(new NextRequest(`http://localhost${path}`), { params: Promise.resolve({ id: new URL(path, 'http://localhost').pathname.split('/').at(-1)! }) }); };
  return { owner, prisma, appContext, objects, bytes, file, issue, redeem };
}
it('serves verified bytes only after durable single-use consumption and enforces authorization/tenant isolation', async () => {
  const x = await fixture(), denied = await member(x.owner, 'download-denied', []), foreign = await register('download-foreign');
  expectError(await call(null, 'GET', `files/${x.file.id}/download`), 401, 'UNAUTHENTICATED');
  expectError(await call(denied, 'GET', `files/${x.file.id}/download`), 403, 'PERMISSION_DENIED');
  expectError(await call(foreign, 'GET', `files/${x.file.id}/download`), 404, 'FILE_NOT_FOUND');
  const { GET: issueGet } = await import('@/app/api/v1/files/[[...path]]/route');
  const issued = await issueGet(new NextRequest(`http://localhost/api/v1/files/${x.file.id}/download`, { headers: {
    authorization: `Bearer ${x.owner.token}`, 'x-workspace-id': x.owner.workspaceId,
  } }), { params: Promise.resolve({ path: [x.file.id, 'download'] }) });
  expect(issued.status).toBe(200); expect(issued.headers.get('cache-control')).toContain('no-store');
  expect(issued.headers.get('referrer-policy')).toBe('no-referrer');
  const grant = (await issued.json()).data; expect(JSON.stringify(grant)).not.toMatch(/objectKey|workspaceId/);
  const responses = await Promise.all([x.redeem(grant.deliveryPath), x.redeem(grant.deliveryPath)]);
  expect(responses.map(row => row.status).sort()).toEqual([200, 410]);
  const response = responses.find(row => row.status === 200)!;
  expect(Buffer.from(await response.arrayBuffer())).toEqual(x.bytes);
  expect(response.headers.get('content-type')).toBe('application/octet-stream'); expect(response.headers.get('content-disposition')).toContain('attachment;');
  expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const stored = await x.prisma.fileDeliveryGrant.findFirstOrThrow({ where: { fileId: x.file.id } }); expect(stored.consumedAt).not.toBeNull();
  await expect(x.prisma.fileDeliveryGrant.update({ where: { id: stored.id }, data: { consumedAt: null } })).rejects.toThrow('FILE_DELIVERY_UNAVAILABLE');
  await expect(x.prisma.fileDeliveryGrant.delete({ where: { id: stored.id } })).rejects.toThrow('FILE_DELIVERY_UNAVAILABLE');
  await expect(x.prisma.fileDeliveryGrant.create({ data: { ...stored, id: randomUUID(), workspaceId: foreign.workspaceId } })).rejects.toThrow('FILE_DELIVERY_UNAVAILABLE');
  expect(await x.prisma.auditLog.count({ where: { entityId: x.file.id, action: 'FILE.DOWNLOADED' } })).toBe(1);
});
it('rechecks owning-record authority and rolls back consumption if independent access revocation races a content read', async () => {
  const x = await fixture(), grant = expectOk(await x.issue());
  const calendar = expectOk(await call(x.owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Bound', timezone: 'UTC' } }));
  const event = expectOk(await call(x.owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Private', startAt: '2030-01-01T10:00:00Z', endAt: '2030-01-01T11:00:00Z', sourceTimezone: 'UTC' } }));
  await x.prisma.calendarEventFile.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, eventId: event.id, fileId: x.file.id, createdAt: new Date() } });
  x.appContext.collab.files.uploads.configure({ putImmutable: x.objects.putImmutable.bind(x.objects), async read(key) {
    await x.prisma.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId: x.owner.workspaceId, userId: x.owner.userId } }, data: { status: 'SUSPENDED' } });
    return x.objects.read(key);
  } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const response = await x.redeem(grant.deliveryPath); expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('CONCURRENCY_CONFLICT');
  expect((await x.prisma.fileDeliveryGrant.findFirstOrThrow({ where: { fileId: x.file.id } })).consumedAt).toBeNull();
  expect((await x.redeem(grant.deliveryPath)).status).toBe(410);
});
it('does not consume a grant when private content cannot be read and rejects it after trash', async () => {
  const x = await fixture(), grant = expectOk(await x.issue());
  x.appContext.collab.files.uploads.configure({ putImmutable: x.objects.putImmutable.bind(x.objects), async read() { throw new Error('private provider diagnostics'); } },
    { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const failure = await x.redeem(grant.deliveryPath); expect(failure.status).toBe(503); expect(JSON.stringify(await failure.json())).not.toContain('private provider');
  expect((await x.prisma.fileDeliveryGrant.findFirstOrThrow({ where: { fileId: x.file.id } })).consumedAt).toBeNull();
  const trashed = expectOk(await call(x.owner, 'DELETE', `files/${x.file.id}`, { body: { version: x.file.version } }));
  expect((await x.redeem(grant.deliveryPath)).status).toBe(410);
  expectOk(await call(x.owner, 'PATCH', `files/${x.file.id}/restore`, { body: { version: trashed.version } }));
  expect((await x.redeem(grant.deliveryPath)).status).toBe(410);
});
it('requires owning Task access even when a member has File download authority', async () => {
  const x = await fixture(), reader = await member(x.owner, 'file-only-reader', [['file.download', 'WORKSPACE']]);
  const acl = expectOk(await call(x.owner, 'GET', `files/${x.file.id}/permissions`));
  expectOk(await call(x.owner, 'PUT', `files/${x.file.id}/permissions`, { body: { version: acl.version, assignments: [
    { subjectType: 'USER', subjectId: x.owner.userId, inheritanceMode: 'OVERRIDE', permissionLevel: 'FULL' },
    { subjectType: 'USER', subjectId: reader.userId, inheritanceMode: 'OVERRIDE', permissionLevel: 'READ' },
  ] } }));
  const allowed = expectOk(await call(reader, 'GET', `files/${x.file.id}/download`));
  const task = expectOk(await call(x.owner, 'POST', 'tasks', { body: { title: 'Private task', responsibleUserId: x.owner.userId } }));
  await x.prisma.taskResult.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, taskId: task.id, resultType: 'FILE',
    fileId: x.file.id, submittedByUserId: x.owner.userId, createdAt: new Date() } });
  expectError(await call(reader, 'GET', `files/${x.file.id}/download`), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expect((await x.redeem(allowed.deliveryPath)).status).toBe(410);
  expectOk(await x.issue());
});
