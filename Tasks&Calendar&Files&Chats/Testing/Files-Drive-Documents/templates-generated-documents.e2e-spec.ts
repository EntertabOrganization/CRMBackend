import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { api } from '@/tests/support/api';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);
const internalToken = randomUUID(), prior = { secret: process.env.FILE_DELIVERY_SECRET, internal: process.env.INTERNAL_JOB_TOKEN };
beforeAll(async () => {
  await prepareCollabDatabase();
  process.env.FILE_DELIVERY_SECRET = 'test-delivery-signing-secret-with-32-bytes'; process.env.INTERNAL_JOB_TOKEN = internalToken;
});
afterAll(async () => {
  for (const [key, value] of Object.entries({ FILE_DELIVERY_SECRET: prior.secret, INTERNAL_JOB_TOKEN: prior.internal })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await disconnect();
});
const HTML = '<h1>{{document.title}} {{document.number}}</h1><p>{{entity.title}}</p>{{#if input.note}}<p>{{input.note}}</p>{{/if}}';
const job = (limit = 25) => api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'document-generation' }, headers: { 'x-internal-job-token': internalToken }, body: { limit } });

async function fixture(label = 'documents') {
  const owner = await register(label), prisma = await db(), { appContext } = await import('@/src/server/app-context');
  appContext.collab.files.uploads.configure(new LocalObjectStorage(), { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = expectOk(await call(owner, 'POST', 'file-storages', { body: { type: 'COMPANY', name: 'Documents' } }));
  const root = expectOk(await call(owner, 'GET', `file-storages/${storage.id}/root`));
  const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Signed agreement' } }));
  const template = expectOk(await call(owner, 'POST', 'document-templates', { body: { name: 'Agreement', templateType: 'HTML', entityType: 'TASK', documentType: 'AGREEMENT',
    outputFormats: ['PDF', 'DOCX'], numberPrefix: 'AG-', htmlTemplate: HTML, schemaJson: { inputs: { note: { type: 'string', maxLength: 100 } } } } }));
  const request = (extra: Record<string, unknown> = {}) => ({ templateId: template.id, entityId: task.id, folderId: root.id, generationKey: randomUUID(), inputs: { note: 'Countersigned' }, ...extra });
  const generate = (session = owner, extra: Record<string, unknown> = {}) => call(session, 'POST', 'generated-documents', { body: request(extra) });
  return { owner, prisma, appContext, storage, root, task, template, request, generate };
}
const redeem = async (path: string) => {
  const { GET } = await import('@/app/api/v1/file-delivery/[id]/route');
  return GET(new NextRequest(`http://localhost${path}`), { params: Promise.resolve({ id: new URL(path, 'http://localhost').pathname.split('/').at(-1)! }) });
};
/** Runs the shared worker until this test's documents settle (other suites' rows may share the queue). */
async function settle(prisma: Awaited<ReturnType<typeof db>>, workspaceId: string) {
  for (let round = 0; round < 10; round++) {
    expectOk(await job());
    if (!await prisma.generatedDocument.count({ where: { workspaceId, status: { in: ['QUEUED', 'GENERATING'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] } })) return;
  }
}

it('exposes and enforces representative routes: POST   /api/v1/document-templates; GET    /api/v1/document-templates; GET    /api/v1/document-templates/:id; PUT    /api/v1/document-templates/:id', async () => {
  const x = await fixture();
  expect(expectOk(await call(x.owner, 'GET', 'document-templates', { query: { entityType: 'TASK' } }))).toHaveLength(1);
  expect(expectOk(await call(x.owner, 'GET', `document-templates/${x.template.id}`))).toMatchObject({ currentRevision: 1, templateType: 'HTML' });
  const preview = expectOk(await call(x.owner, 'POST', `document-templates/${x.template.id}/preview`, { body: { entityId: x.task.id, inputs: { note: '<i>x</i>' } } }));
  expect(preview.content).toContain('<p>Signed agreement</p><p>&lt;i&gt;x&lt;/i&gt;</p>');
  const body = x.request(), results = await Promise.all([call(x.owner, 'POST', 'generated-documents', { body }), call(x.owner, 'POST', 'generated-documents', { body })]);
  const queued = expectOk(results[0], 202); expect(expectOk(results[1], 202).id).toBe(queued.id);
  expect(queued).toMatchObject({ status: 'QUEUED', fileId: null }); expect(queued).not.toHaveProperty('requestHash'); expect(queued).not.toHaveProperty('claimId');
  await settle(x.prisma, x.owner.workspaceId);
  const ready = expectOk(await call(x.owner, 'GET', `generated-documents/${queued.id}`));
  expect(ready).toMatchObject({ status: 'READY', documentNumber: 'AG-000001', outputFormat: 'PDF' });
  expect(expectOk(await call(x.owner, 'GET', 'generated-documents', { query: { entityId: x.task.id } })).map((row: { id: string }) => row.id)).toEqual([queued.id]);
  const grant = expectOk(await call(x.owner, 'GET', `generated-documents/${queued.id}/download`));
  const delivered = await redeem(grant.deliveryPath); expect(delivered.status).toBe(200);
  const pdf = Buffer.from(await delivered.arrayBuffer()).toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true); expect(pdf).toContain('(Signed agreement)'); expect(pdf).toContain('(Agreement AG-000001)');
  expect(expectOk(await call(x.owner, 'GET', `entities/TASK/${x.task.id}/attachments`))).toEqual([expect.objectContaining({ fileId: ready.fileId, role: 'DOCUMENT' })]);
  const put = expectOk(await call(x.owner, 'PUT', `document-templates/${x.template.id}`, { body: { version: x.template.version, name: 'Agreement v2', documentType: 'AGREEMENT',
    outputFormats: ['PDF', 'DOCX'], numberPrefix: 'AG-', htmlTemplate: `${HTML}<p>Amended</p>`, schemaJson: { inputs: { note: { type: 'string' } } } } }));
  expect(put).toMatchObject({ currentRevision: 2, version: 2 });
  const patched = expectOk(await call(x.owner, 'PATCH', `document-templates/${x.template.id}`, { body: { version: 2, description: 'Current wording' } }));
  expect(patched).toMatchObject({ currentRevision: 2, version: 3 });
  const regenerated = expectOk(await call(x.owner, 'POST', `generated-documents/${queued.id}/regenerate`, { body: { generationKey: randomUUID() } }), 202);
  await settle(x.prisma, x.owner.workspaceId);
  expect(expectOk(await call(x.owner, 'GET', `generated-documents/${regenerated.id}`))).toMatchObject({ status: 'READY', documentNumber: 'AG-000001', regeneratedFromId: queued.id });
  expect(expectOk(await call(x.owner, 'GET', `generated-documents/${queued.id}`))).toMatchObject({ supersededById: regenerated.id, fileVersionId: ready.fileVersionId });
  expect(await x.prisma.driveFileVersion.count({ where: { workspaceId: x.owner.workspaceId, objectKey: { contains: '/generated-documents/' } } })).toBe(2);
  const docx = expectOk(await x.generate(x.owner, { outputFormat: 'DOCX', fileName: 'Agreement editable' }), 202);
  await settle(x.prisma, x.owner.workspaceId);
  const docxFile = await x.prisma.driveFile.findFirstOrThrow({ where: { id: expectOk(await call(x.owner, 'GET', `generated-documents/${docx.id}`)).fileId } });
  expect(docxFile).toMatchObject({ name: 'Agreement editable.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', status: 'ACTIVE' });
  const archived = expectOk(await call(x.owner, 'DELETE', `generated-documents/${queued.id}`, { body: { version: (await x.prisma.generatedDocument.findUniqueOrThrow({ where: { id: queued.id } })).version } }));
  expect(archived.status).toBe('ARCHIVED');
  expectOk(await call(x.owner, 'DELETE', `document-templates/${x.template.id}`, { body: { version: 3 } }));
  expectError(await call(x.owner, 'GET', `document-templates/${x.template.id}`), 404, 'DOCUMENT_TEMPLATE_NOT_FOUND');
  expect(await x.prisma.documentTemplateRevision.count({ where: { templateId: x.template.id } })).toBe(2);
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
  const x = await fixture('documents-auth'), id = x.template.id;
  for (const [method, path] of [['GET', 'document-templates'], ['POST', 'document-templates'], ['GET', `document-templates/${id}`], ['PUT', `document-templates/${id}`],
    ['PATCH', `document-templates/${id}`], ['DELETE', `document-templates/${id}`], ['POST', `document-templates/${id}/preview`], ['POST', 'generated-documents'],
    ['GET', 'generated-documents'], ['GET', `generated-documents/${MISSING_ID}`], ['GET', `generated-documents/${MISSING_ID}/download`],
    ['POST', `generated-documents/${MISSING_ID}/regenerate`], ['DELETE', `generated-documents/${MISSING_ID}`]] as const)
    expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
  const reader = await member(x.owner, 'template-reader', [['document_template.read', 'WORKSPACE'], ['task.read', 'WORKSPACE']]);
  expectOk(await call(reader, 'GET', `document-templates/${id}`));
  expectError(await call(reader, 'PATCH', `document-templates/${id}`, { body: { version: 1, name: 'Nope' } }), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'POST', 'generated-documents', { body: x.request() }), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'GET', 'generated-documents'), 403, 'PERMISSION_DENIED');
  // Generation authority is re-proven by the worker: a member who loses source access never receives a published File.
  const generator = await member(x.owner, 'generator', [['document.generate', 'WORKSPACE'], ['document.read', 'WORKSPACE'], ['task.create', 'OWN'], ['task.read', 'OWN'],
    ['storage.read', 'WORKSPACE'], ['folder.read', 'WORKSPACE'], ['file.create', 'WORKSPACE'], ['file.read', 'WORKSPACE']]);
  const acl = expectOk(await call(x.owner, 'GET', `file-storages/${x.storage.id}/permissions`));
  expectOk(await call(x.owner, 'PUT', `file-storages/${x.storage.id}/permissions`, { body: { version: acl.version,
    assignments: [{ subjectType: 'USER', subjectId: generator.userId, permissionLevel: 'EDIT', inheritanceMode: 'INHERIT' }] } }));
  const own = expectOk(await call(generator, 'POST', 'tasks', { body: { title: 'Generator task' } }));
  const queued = expectOk(await x.generate(generator, { entityId: own.id }), 202);
  const { runStateUnit } = await import('@/src/server/response');
  await runStateUnit(() => {
    const state = x.appContext.store.state, taskRead = state.permissions.find(row => row.key === 'task.read')!.id;
    const roleId = state.workspaceMemberships.find(row => row.userId === generator.userId && row.workspaceId === x.owner.workspaceId)!.roleId;
    for (const row of state.rolePermissions) if (row.roleId === roleId && row.permissionId === taskRead) row.isDeleted = true;
  });
  await settle(x.prisma, x.owner.workspaceId);
  expect(await x.prisma.generatedDocument.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'FAILED', errorCode: 'DOCUMENT_CONTEXT_ACCESS_DENIED', fileId: null });
  expect(await x.prisma.driveFile.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(0);
  expectError(await call(generator, 'GET', `generated-documents/${queued.id}`), 403, 'DOCUMENT_CONTEXT_ACCESS_DENIED');
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
  const x = await fixture('documents-tenant'), foreign = await register('documents-foreign');
  const queued = expectOk(await x.generate(), 202);
  expectError(await call(foreign, 'GET', `document-templates/${x.template.id}`), 404, 'DOCUMENT_TEMPLATE_NOT_FOUND');
  expectError(await call(foreign, 'POST', `document-templates/${x.template.id}/preview`, { body: {} }), 404, 'DOCUMENT_TEMPLATE_NOT_FOUND');
  expectError(await call(foreign, 'GET', `generated-documents/${queued.id}`), 404, 'GENERATED_DOCUMENT_NOT_FOUND');
  expectError(await call(foreign, 'DELETE', `generated-documents/${queued.id}`, { body: { version: 1 } }), 404, 'GENERATED_DOCUMENT_NOT_FOUND');
  expectError(await call(foreign, 'POST', 'generated-documents', { body: x.request() }), 404, 'DOCUMENT_TEMPLATE_NOT_FOUND');
  const foreignTask = expectOk(await call(foreign, 'POST', 'tasks', { body: { title: 'Foreign' } }));
  expectError(await call(x.owner, 'POST', 'generated-documents', { body: x.request({ entityId: foreignTask.id }) }), 403, 'DOCUMENT_CONTEXT_ACCESS_DENIED');
  expectError(await call(x.owner, 'POST', `document-templates/${x.template.id}/preview`, { body: { entityId: foreignTask.id } }), 403, 'DOCUMENT_CONTEXT_ACCESS_DENIED');
  await settle(x.prisma, x.owner.workspaceId);
  const ready = await x.prisma.generatedDocument.findUniqueOrThrow({ where: { id: queued.id } });
  // Independent SQL guards: tenant links, immutable history and one-way lifecycle.
  const foreignWorkspace = foreign.workspaceId, revision = await x.prisma.documentTemplateRevision.findFirstOrThrow({ where: { templateId: x.template.id } });
  await expect(x.prisma.generatedDocument.create({ data: { ...ready, id: randomUUID(), workspaceId: foreignWorkspace, generationKey: randomUUID(), status: 'QUEUED', fileId: null,
    fileVersionId: null, documentNumber: null, generatedAt: null, contextHash: null, attempts: 0, inputs: {}, createdByUserId: foreign.userId } })).rejects.toThrow();
  await expect(x.prisma.documentTemplateRevision.update({ where: { id: revision.id }, data: { htmlTemplate: '<p>tampered</p>' } })).rejects.toThrow(/DOCUMENT_TEMPLATE_REVISION_IMMUTABLE/);
  await expect(x.prisma.documentTemplateRevision.delete({ where: { id: revision.id } })).rejects.toThrow(/DOCUMENT_TEMPLATE_REVISION_IMMUTABLE/);
  await expect(x.prisma.generatedDocument.update({ where: { id: ready.id }, data: { entityId: foreignTask.id } })).rejects.toThrow(/GENERATED_DOCUMENT_IMMUTABLE/);
  await expect(x.prisma.generatedDocument.update({ where: { id: ready.id }, data: { status: 'QUEUED' } })).rejects.toThrow(/GENERATED_DOCUMENT_IMMUTABLE/);
  await expect(x.prisma.generatedDocument.delete({ where: { id: ready.id } })).rejects.toThrow(/GENERATED_DOCUMENT_IMMUTABLE/);
  await expect(x.prisma.documentTemplate.update({ where: { id: x.template.id }, data: { templateType: 'DOCX' } })).rejects.toThrow();
  const pending = expectOk(await x.generate(), 202), now = new Date();
  await expect(x.prisma.$transaction([x.prisma.generatedDocument.update({ where: { id: pending.id }, data: { status: 'GENERATING', claimId: randomUUID(), leaseExpiresAt: now } }),
    x.prisma.generatedDocument.update({ where: { id: pending.id }, data: { status: 'READY', claimId: null, leaseExpiresAt: null, fileId: ready.fileId, fileVersionId: ready.fileVersionId,
      generatedAt: now, contextHash: ready.contextHash } })])).rejects.toThrow(/DOCUMENT_GENERATION_FAILED/);
});

it('returns stable machine-readable error envelopes for invalid requests', async () => {
  const x = await fixture('documents-errors');
  expectError(await call(x.owner, 'POST', 'document-templates', { body: { name: 'Bad', templateType: 'HTML', entityType: 'TASK', documentType: 'BAD', htmlTemplate: '{{process.env}}' } }), 400, 'DOCUMENT_TEMPLATE_INVALID');
  expectError(await call(x.owner, 'POST', 'document-templates', { body: { name: 'Bad', templateType: 'HTML', entityType: 'TASK', documentType: 'BAD', htmlTemplate: '<script>x</script>' } }), 400, 'DOCUMENT_TEMPLATE_INVALID');
  expectError(await call(x.owner, 'POST', 'document-templates', { body: { name: 'Bad', templateType: 'HTML', entityType: 'TASK', documentType: 'bad', htmlTemplate: 'x' } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', 'document-templates', { body: { name: 'Bad', templateType: 'HTML', entityType: 'TASK', documentType: 'BAD', htmlTemplate: 'x', extra: 1 } }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'PATCH', `document-templates/${x.template.id}`, { body: { name: 'Stale', version: 9 } }), 409, 'RESOURCE_VERSION_CONFLICT');
  expectError(await call(x.owner, 'GET', `document-templates/${MISSING_ID}`), 404, 'DOCUMENT_TEMPLATE_NOT_FOUND');
  expectError(await call(x.owner, 'GET', `generated-documents/${MISSING_ID}`), 404, 'GENERATED_DOCUMENT_NOT_FOUND');
  expectError(await call(x.owner, 'POST', 'generated-documents', { body: x.request({ inputs: { note: 3 } }) }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', 'generated-documents', { body: x.request({ inputs: { other: 'x' } }) }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', 'generated-documents', { body: x.request({ fileName: '../escape' }) }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'POST', 'generated-documents', { body: x.request({ folderId: MISSING_ID }) }), 404, 'FOLDER_NOT_FOUND');
  const body = x.request(), queued = expectOk(await call(x.owner, 'POST', 'generated-documents', { body }), 202);
  expectError(await call(x.owner, 'POST', 'generated-documents', { body: { ...body, inputs: { note: 'Different' } } }), 409, 'DOCUMENT_GENERATION_DUPLICATE');
  expectError(await call(x.owner, 'GET', `generated-documents/${queued.id}/download`), 409, 'DOCUMENT_STATE_INVALID');
  expectError(await call(x.owner, 'POST', `generated-documents/${queued.id}/regenerate`, { body: { generationKey: randomUUID() } }), 409, 'DOCUMENT_STATE_INVALID');
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'document-generation' }, body: {} }), 401, 'UNAUTHENTICATED');
  expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'document-generation' }, headers: { 'x-internal-job-token': internalToken }, body: { limit: 0 } }), 400, 'VALIDATION_ERROR');
});

it('persists critical state and outbox/audit consistently on successful mutation', async () => {
  const x = await fixture('documents-outbox'), queued = expectOk(await x.generate(), 202);
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'DOCUMENT_TEMPLATE_CHANGED' } })).toBe(1);
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'DOCUMENT_GENERATION_QUEUED', entityId: queued.id } })).toBe(1);
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'DOCUMENT_TEMPLATE.CREATED' } })).toBe(1);
  await settle(x.prisma, x.owner.workspaceId);
  const row = await x.prisma.generatedDocument.findUniqueOrThrow({ where: { id: queued.id } });
  expect(row).toMatchObject({ status: 'READY', attempts: 1, claimId: null });
  const version = await x.prisma.driveFileVersion.findUniqueOrThrow({ where: { id: row.fileVersionId! } });
  expect(version).toMatchObject({ fileId: row.fileId, scanStatus: 'CLEAN', mimeType: 'application/pdf', createdByUserId: x.owner.userId });
  expect(await x.prisma.fileAttachment.count({ where: { fileId: row.fileId!, entityType: 'TASK', entityId: x.task.id, role: 'DOCUMENT' } })).toBe(1);
  for (const type of ['DOCUMENT_GENERATED', 'FILE_CREATED', 'FILE_ATTACHED'])
    expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: type } })).toBe(1);
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'DOCUMENT.GENERATED', entityId: queued.id } })).toBe(1);
  // A second worker run is a no-op; replays return the committed document.
  expectOk(await job());
  expect(await x.prisma.driveFile.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(1);
  expect(expectOk(await call(x.owner, 'POST', 'generated-documents', { body: { ...x.request(), generationKey: row.generationKey } }), 202)).toMatchObject({ id: queued.id, status: 'READY' });
});
