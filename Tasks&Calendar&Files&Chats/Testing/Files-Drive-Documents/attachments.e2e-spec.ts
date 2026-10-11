import { createHash, randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
beforeAll(prepareCollabDatabase); afterAll(disconnect);
async function fixture() {
  const owner = await register('attachments'), prisma = await db(), { appContext } = await import('@/src/server/app-context');
  const objects = new LocalObjectStorage();
  appContext.collab.files.uploads.configure(objects, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'PERSONAL', name: 'Attachments' } })), root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const bytes = Buffer.from('one binary, multiple records'), checksum = createHash('sha256').update(bytes).digest('hex');
  const session = expectOk(await call(owner, 'POST', 'upload-sessions', { body: { targetFolderId: root.id, desiredFileName: 'shared.txt', mimeType: 'text/plain', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() } }));
  expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/parts`, { body: { partNumber: 1, checksum, dataBase64: bytes.toString('base64') } }));
  const receipt = expectOk(await call(owner, 'POST', `upload-sessions/${session.id}/complete`, { body: {} }));
  const fileId = receipt.resultFileId, task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Attached task' } }));
  const body = { fileId, entityType: 'TASK', entityId: task.id, role: 'ATTACHMENT' };
  const attach = () => call(owner, 'POST', 'attachments', { body });
  return { owner, prisma, appContext, objects, fileId, root, task, body, attach };
}
it('exposes all five routes, survives hydration and deduplicates concurrent retries without copying content', async () => {
  const x = await fixture(), results = await Promise.all([x.attach(), x.attach()]), row = expectOk(results[0]); expect(expectOk(results[1]).id).toBe(row.id);
  expect(expectOk(await call(x.owner, 'GET', `attachments/${row.id}`))).toMatchObject(x.body);
  expect(expectOk(await call(x.owner, 'GET', 'attachments', { query: { fileId: x.fileId } }))).toHaveLength(1);
  expect(expectOk(await call(x.owner, 'GET', `entities/TASK/${x.task.id}/attachments`))).toHaveLength(1);
  const other = expectOk(await call(x.owner, 'POST', 'tasks', { body: { title: 'Other task' } }));
  const second = expectOk(await call(x.owner, 'POST', 'attachments', { body: { ...x.body, entityId: other.id } }));
  expectOk(await call(x.owner, 'DELETE', `attachments/${row.id}`, { body: {} }));
  expectOk(await call(x.owner, 'GET', `attachments/${second.id}`));
  expect(await x.prisma.driveFileVersion.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(1);
  expect(await x.prisma.driveFile.count({ where: { id: x.fileId } })).toBe(1);
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'FILE_ATTACHED' } })).toBe(2);
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'FILE_DETACHED' } })).toBe(1);
});
it('requires authenticated workspace and independent attachment action grants', async () => {
  const x = await fixture(), row = expectOk(await x.attach());
  for (const [method, path] of [['GET','attachments'],['POST','attachments'],['GET',`attachments/${row.id}`],['DELETE',`attachments/${row.id}`],['GET',`entities/TASK/${x.task.id}/attachments`]] as const)
    expectError(await call(null, method, path, { body: method === 'POST' ? x.body : method === 'DELETE' ? {} : undefined }), 401);
  const actor = await member(x.owner, 'read-only', [['file.read', 'WORKSPACE'], ['task.read', 'WORKSPACE']]);
  expectError(await call(actor, 'POST', 'attachments', { body: x.body }), 403, 'PERMISSION_DENIED');
  expectError(await call(actor, 'DELETE', `attachments/${row.id}`, { body: {} }), 403, 'PERMISSION_DENIED');
});
it('rejects cross-Workspace IDs and direct SQL tenant corruption without disclosure', async () => {
  const x = await fixture(), foreign = await register('foreign-attachments'), task = expectOk(await call(foreign, 'POST', 'tasks', { body: { title: 'Foreign task' } })), row = expectOk(await x.attach());
  expectError(await call(x.owner, 'POST', 'attachments', { body: { ...x.body, entityId: task.id } }), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expectError(await call(foreign, 'GET', `attachments/${row.id}`), 404, 'ATTACHMENT_NOT_FOUND');
  expectError(await call(foreign, 'DELETE', `attachments/${row.id}`, { body: {} }), 404, 'ATTACHMENT_NOT_FOUND');
  await expect(x.prisma.fileAttachment.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, fileId: x.fileId, entityType: 'TASK', entityId: task.id, role: 'COVER', attachedByUserId: x.owner.userId, createdAt: new Date() } })).rejects.toThrow(/ATTACHMENT_CROSS_WORKSPACE/);
  await expect(x.prisma.fileAttachment.update({ where: { id: row.id }, data: { entityId: task.id } })).rejects.toThrow(/ATTACHMENT_IDENTITY_IMMUTABLE/);
});
it('enforces both live authorities on reads/lists/detach and returns stable validation envelopes', async () => {
  const x = await fixture(), row = expectOk(await x.attach());
  const actor = await member(x.owner, 'file-without-task', [['file.read','OWN'],['file.attach','OWN'],['file.detach','OWN'],['task.read','OWN'],['task.update','OWN']]);
  const file = expectOk(await call(x.owner, 'GET', `files/${x.fileId}`));
  expectOk(await call(x.owner, 'PUT', `files/${x.fileId}/permissions`, { body: { version: file.version, assignments: [{ subjectType: 'USER', subjectId: actor.userId, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] } }));
  expectError(await call(actor, 'GET', `attachments/${row.id}`), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expect(expectOk(await call(actor, 'GET', 'attachments'))).toHaveLength(0);
  expectError(await call(actor, 'DELETE', `attachments/${row.id}`, { body: {} }), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  const noFile = await member(x.owner, 'task-without-file', [['file.read','WORKSPACE'],['file.attach','WORKSPACE'],['task.read','WORKSPACE'],['task.update','WORKSPACE']]);
  expectError(await call(noFile, 'POST', 'attachments', { body: x.body }), 403, 'ATTACHMENT_FILE_ACCESS_DENIED');
  expectError(await call(x.owner, 'POST', 'attachments', { body: { ...x.body, role: 'BOGUS' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', 'attachments', { body: { ...x.body, workspaceId: actor.workspaceId } }), 400, 'VALIDATION_ERROR');
});
it('keeps bytes private after attaching, fences old grants and permits cleanup after target deletion', async () => {
  const x = await fixture(), previous = process.env.FILE_DELIVERY_SECRET; process.env.FILE_DELIVERY_SECRET = 'attachment-secret-at-least-thirty-two-bytes';
  try {
    const grant = expectOk(await call(x.owner, 'GET', `files/${x.fileId}/download`)), row = expectOk(await x.attach());
    const { GET } = await import('@/app/api/v1/file-delivery/[id]/route'), { NextRequest } = await import('next/server');
    const url = new URL(grant.deliveryPath, 'http://localhost');
    expect((await GET(new NextRequest(url), { params: Promise.resolve({ id: url.pathname.split('/').at(-1)! }) })).status).toBe(410);
    expectError(await call(x.owner, 'POST', `files/${x.fileId}/public-links`, { body: {} }), 410, 'PUBLIC_LINK_REVOKED');
    expect(await x.prisma.fileDeliveryGrant.findUnique({ where: { id: url.pathname.split('/').at(-1)! } })).toMatchObject({ consumedAt: null });
    const task = expectOk(await call(x.owner, 'GET', `tasks/${x.task.id}`));
    expectOk(await call(x.owner, 'DELETE', `tasks/${x.task.id}`, { body: { version: task.version } }));
    expect(await x.prisma.driveFile.count({ where: { id: x.fileId } })).toBe(1);
    expectOk(await call(x.owner, 'DELETE', `attachments/${row.id}`, { body: {} }));
  } finally { if (previous === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = previous; }
});
it('rolls back attachments, File revision and outbox when a remote owning-record change races commit', async () => {
  const x = await fixture(), version = (await x.prisma.driveFile.findUniqueOrThrow({ where: { id: x.fileId } })).version;
  const original = x.appContext.collab.attachments.attach.bind(x.appContext.collab.attachments);
  const { runStateUnit } = await import('@/src/server/response');
  await expect(runStateUnit(async () => {
    const actor = x.appContext.access.actor(x.appContext.store.state.users.find(row => row.id === x.owner.userId)!, x.owner.workspaceId);
    original(actor, new (await import('@/src/server/collab/support')).Body(x.body));
    await x.prisma.task.update({ where: { id: x.task.id }, data: { isDeleted: true } });
  })).rejects.toThrow(/changed|version|CONFLICT/i);
  expect(await x.prisma.fileAttachment.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(0);
  expect(await x.prisma.driveFile.findUniqueOrThrow({ where: { id: x.fileId } })).toMatchObject({ version });
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'FILE_ATTACHED' } })).toBe(0);
});

it('wires real File authority into Calendar references and keeps legacy owning records private', async () => {
  const x = await fixture();
  const calendar = expectOk(await call(x.owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'File context', timezone: 'UTC' } }));
  const event = expectOk(await call(x.owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Files', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z', sourceTimezone: 'UTC', fileIds: [x.fileId] } }));
  expect(await x.prisma.calendarEventFile.count({ where: { eventId: event.id, fileId: x.fileId } })).toBe(1);
  expectError(await call(x.owner, 'POST', `files/${x.fileId}/public-links`, { body: {} }), 410, 'PUBLIC_LINK_REVOKED');
  expectOk(await call(x.owner, 'POST', 'attachments', { body: { fileId: x.fileId, entityType: 'CALENDAR_EVENT', entityId: event.id } }));
  const actor = await member(x.owner, 'file-without-event', [['file.read','OWN'],['file.download','OWN'],['file.copy','OWN']]);
  const file = expectOk(await call(x.owner, 'GET', `files/${x.fileId}`));
  expectOk(await call(x.owner, 'PUT', `files/${x.fileId}/permissions`, { body: { version: file.version, assignments: [{ subjectType: 'USER', subjectId: actor.userId, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] } }));
  expectError(await call(actor, 'GET', `files/${x.fileId}/download`), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expectError(await call(actor, 'POST', `files/${x.fileId}/copy`, { body: { folderId: x.root.id } }), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
});

it('uses CRM owning read/mutation policies and records audit only under the Workspace attachment policy', async () => {
  const x = await fixture();
  const contact = expectOk(await api('POST', '/api/v1/crm/contacts', { token: x.owner.token, workspaceId: x.owner.workspaceId, body: { firstName: 'File', lastName: 'Owner' } }));
  const workspace = await x.prisma.workspace.findUniqueOrThrow({ where: { id: x.owner.workspaceId } });
  await x.prisma.workspace.update({ where: { id: workspace.id }, data: { settings: { ...workspace.settings as Record<string, unknown>, auditFileAttachments: true } } });
  const row = expectOk(await call(x.owner, 'POST', 'attachments', { body: { fileId: x.fileId, entityType: 'CONTACT', entityId: contact.id, role: 'DOCUMENT' } }));
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'FILE.ATTACHED', entityId: row.id } })).toBe(1);
  const actor = await member(x.owner, 'file-contact-reader', [['file.read','WORKSPACE'],['file.attach','WORKSPACE'],['file.detach','WORKSPACE'],['crm.contact.read','WORKSPACE']]);
  const file = expectOk(await call(x.owner, 'GET', `files/${x.fileId}`));
  expectOk(await call(x.owner, 'PUT', `files/${x.fileId}/permissions`, { body: { version: file.version, assignments: [{ subjectType: 'USER', subjectId: actor.userId, permissionLevel: 'READ', inheritanceMode: 'INHERIT' }] } }));
  expectOk(await call(actor, 'GET', `attachments/${row.id}`));
  expectError(await call(actor, 'DELETE', `attachments/${row.id}`, { body: {} }), 403, 'ATTACHMENT_ENTITY_ACCESS_DENIED');
  expectOk(await call(x.owner, 'DELETE', `attachments/${row.id}`, { body: {} }));
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'FILE.DETACHED', entityId: row.id } })).toBe(1);
});
