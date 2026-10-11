import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { LeaseJobRunner } from '@/src/server/jobs/lease-runner';
import { blocksToDocx, readZip, writeZip } from '@/src/server/collab/files/document-render';
import type { ActorContext } from '@/src/server/access-service';
import { b, collabApp, perms } from '../support/domain';

const HTML = '<h1>{{document.title}} {{document.number}}</h1><p>Task: {{entity.title}}</p>{{#if input.note}}<p>Note: {{input.note}}</p>{{else}}<p>No note</p>{{/if}}<p>{{workspace.name}}</p>';
const SCHEMA = { inputs: { note: { type: 'string', maxLength: 200 }, amount: { type: 'number' } } };
const PERMISSIONS = perms('WORKSPACE', 'document.generate', 'document.read', 'document.delete', 'document_template.read', 'task.create', 'task.read', 'task.update',
  'storage.read', 'folder.read', 'file.create', 'file.read', 'file.download');

async function fixture() {
  const c = await collabApp(), f = c.collab.files, d = c.collab.documents, objects = new Map<string, Buffer>();
  let scanner: () => Promise<{ scanStatus: 'CLEAN' | 'BLOCKED'; processed: boolean }> = async () => ({ scanStatus: 'CLEAN', processed: true });
  f.uploads.configure({ async putImmutable(key, data) { objects.set(key, Buffer.from(data)); }, async read(key) {
    const value = objects.get(key); if (!value) throw new Error('missing'); return value;
  } }, { process: () => scanner() });
  const storage = f.storages.createStorage(c.owner, b({ type: 'COMPANY', name: 'Generated' })), root = f.storages.root(c.owner, storage.id);
  const task = c.collab.tasks.tasks.create(c.owner, { title: 'Quarterly review' });
  const template = await d.templates.create(c.owner, b({ name: 'Task brief', templateType: 'HTML', entityType: 'TASK', documentType: 'TASK_BRIEF',
    outputFormats: ['PDF', 'DOCX'], numberPrefix: 'TB-', htmlTemplate: HTML, schemaJson: SCHEMA }));
  const run = () => new LeaseJobRunner(d.generated, { unit: async fn => fn() }).runDue({ limit: 20 });
  const generate = (actor: ActorContext = c.owner, extra: Record<string, unknown> = {}) => d.generated.create(actor, b({ templateId: template.id, entityId: task.id,
    folderId: root.id, generationKey: randomUUID(), inputs: { note: 'Ship it' }, ...extra }));
  const bytes = (fileId: string) => {
    const file = c.state.driveFiles.find(row => row.id === fileId)!, version = c.state.driveFileVersions.find(row => row.id === file.currentVersionId)!;
    return objects.get(version.objectKey)!;
  };
  const doc = (id: string) => c.state.generatedDocuments.find(row => row.id === id)!;
  const setScanner = (next: typeof scanner) => { scanner = next; };
  return { c, f, d, objects, storage, root, task, template, run, generate, bytes, doc, setScanner };
}
async function upload(x: Awaited<ReturnType<typeof fixture>>, name: string, data: Buffer, mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  const checksum = createHash('sha256').update(data).digest('hex');
  const session = x.f.uploads.create(x.c.owner, b({ targetFolderId: x.root.id, desiredFileName: name, mimeType, expectedSizeBytes: data.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await x.f.uploads.part(x.c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: data.toString('base64') }));
  return (await x.f.uploads.complete(x.c.owner, session.id, b())).resultFileId!;
}
async function grantFolder(x: Awaited<ReturnType<typeof fixture>>, userId: string) {
  const storage = x.c.state.fileStorages.find(row => row.id === x.storage.id)!;
  const acl = x.f.access.get(x.c.owner, 'STORAGE', storage.id);
  x.f.access.replace(x.c.owner, 'STORAGE', storage.id, b({ version: acl.version, assignments: [{ subjectType: 'USER', subjectId: userId, permissionLevel: 'EDIT', inheritanceMode: 'INHERIT' }] }));
}

it('Template injection/invalid variables.', async () => {
  const x = await fixture(), create = (htmlTemplate: string, schemaJson: unknown = SCHEMA) => x.d.templates.create(x.c.owner, b({ name: 'Bad', templateType: 'HTML',
    entityType: 'TASK', documentType: 'BAD', htmlTemplate, schemaJson }));
  for (const source of ['{{constructor.prototype}}', '{{{entity.title}}}', '{{entity.passwordHash}}', '{{input.undeclared}}', '{{#each entity.title}}x{{/each}}',
    '{{#if entity.title}}open', '{{entity.title', 'x}}', '{{ this }}', '<script>alert(1)</script>', '<img src=x onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>'])
    await expectAppError(() => create(source), 'DOCUMENT_TEMPLATE_INVALID', 400);
  await expectAppError(() => create('{{input.a}}', { inputs: { a: { type: 'script' } } }), 'VALIDATION_ERROR', 400);
  await expectAppError(() => create('{{input.a}}', { inputs: { a: { type: 'number', maxLength: 3 } } }), 'VALIDATION_ERROR', 400);
  await expectAppError(() => create('x', { inputs: {}, code: 'process.exit()' }), 'VALIDATION_ERROR', 400);
  await expectAppError(() => x.d.templates.create(x.c.owner, b({ name: 'Unknown', templateType: 'HTML', entityType: 'SECRETS', documentType: 'X', htmlTemplate: 'x' })), 'DOCUMENT_TEMPLATE_INVALID', 400);
  expect(x.c.state.documentTemplates).toHaveLength(1);
  // Values are escaped data, never template syntax or markup.
  const payload = '<b>{{entity.title}}</b>{{#if input.note}}', preview = await x.d.templates.preview(x.c.owner, x.template.id, b({ entityId: x.task.id, inputs: { note: payload } }));
  expect(preview.content).toContain('&lt;b&gt;{{entity.title}}&lt;/b&gt;{{#if input.note}}');
  expect(preview.content).toContain('Task: Quarterly review');
  await expectAppError(() => x.generate(x.c.owner, { inputs: { unknown: 'x' } }), 'VALIDATION_ERROR', 400);
  await expectAppError(() => x.generate(x.c.owner, { inputs: { amount: '12' } }), 'VALIDATION_ERROR', 400);
  await expectAppError(() => x.generate(x.c.owner, { inputs: { note: 'x'.repeat(201) } }), 'VALIDATION_ERROR', 400);
  const queued = x.generate(x.c.owner, { inputs: { note: payload } });
  await x.run();
  const pdf = x.bytes(x.doc(queued.id).fileId!).toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('(Note: <b>{{entity.title}}</b>{{#if input.note}})');
  expect(pdf).toContain('(Task brief TB-000001)');
});

it('Job retry.', async () => {
  const x = await fixture(), key = randomUUID(), body = { generationKey: key };
  x.setScanner(async () => { throw new Error('scanner offline'); });
  const first = x.generate(x.c.owner, body);
  expect(x.generate(x.c.owner, body).id).toBe(first.id);
  await expectAppError(() => x.generate(x.c.owner, { ...body, inputs: { note: 'Changed' } }), 'DOCUMENT_GENERATION_DUPLICATE', 409);
  expect((await x.run()).failed).toBe(1);
  expect(x.doc(first.id)).toMatchObject({ status: 'QUEUED', errorCode: 'FILE_PROCESSOR_UNAVAILABLE', attempts: 1, fileId: null });
  expect(x.c.state.driveFiles).toHaveLength(0);
  expect(x.objects.size).toBe(0);
  expect((await x.run()).claimed).toBe(0); // backoff
  x.setScanner(async () => ({ scanStatus: 'CLEAN', processed: true }));
  x.doc(first.id).nextAttemptAt = new Date(0);
  expect((await x.run()).sent).toBe(1);
  const ready = x.d.generated.get(x.c.owner, first.id);
  expect(ready).toMatchObject({ status: 'READY', attempts: 2, errorCode: null, documentNumber: 'TB-000001' });
  expect(x.c.state.driveFiles).toHaveLength(1);
  expect(x.c.state.fileAttachments).toEqual([expect.objectContaining({ fileId: ready.fileId, entityType: 'TASK', entityId: x.task.id, role: 'DOCUMENT' })]);
  expect(x.generate(x.c.owner, body).status).toBe('READY');
  expect((await x.run()).claimed).toBe(0);
  for (const type of ['DOCUMENT_GENERATION_QUEUED', 'DOCUMENT_GENERATED']) expect(x.c.state.outboxEvents.filter(row => row.eventType === type)).toHaveLength(1);
  expect(x.c.state.auditLogs.filter(row => row.action === 'DOCUMENT.GENERATED')).toHaveLength(1);
  // A blocked render is terminal and its object is queued for the object garbage worker.
  x.setScanner(async () => ({ scanStatus: 'BLOCKED', processed: true }));
  const blocked = x.generate();
  await x.run();
  expect(x.doc(blocked.id)).toMatchObject({ status: 'FAILED', errorCode: 'FILE_BLOCKED', fileId: null });
  expect(x.c.state.fileObjectGarbage.map(row => row.objectKey)).toEqual([expect.stringContaining(`/generated-documents/${blocked.id}/`)]);
  // Exhausted retries end with the last stable error code.
  x.setScanner(async () => { throw new Error('down'); });
  const exhausted = x.generate();
  for (let attempt = 0; attempt < 5; attempt++) { x.doc(exhausted.id).nextAttemptAt = new Date(0); await x.run(); }
  expect(x.doc(exhausted.id)).toMatchObject({ status: 'FAILED', attempts: 5, errorCode: 'FILE_PROCESSOR_UNAVAILABLE' });
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'DOCUMENT_GENERATION_FAILED')).toHaveLength(2);
});

it('Source entity becomes unauthorized.', async () => {
  const x = await fixture(), member = await x.c.memberActor('generator', PERMISSIONS);
  await grantFolder(x, member.user.id);
  const task = x.c.collab.tasks.tasks.create(member, { title: 'Member task' });
  const queued = x.generate(member, { entityId: task.id });
  const revoke = (key: string) => { for (const row of x.c.state.rolePermissions.filter(row => row.roleId === member.role.id && row.permissionId === key)) row.isDeleted = true; };
  revoke('task.read');
  await x.run();
  expect(x.doc(queued.id)).toMatchObject({ status: 'FAILED', errorCode: 'DOCUMENT_CONTEXT_ACCESS_DENIED', fileId: null });
  expect(x.c.state.driveFiles).toHaveLength(0);
  await expectAppError(() => x.generate(member, { entityId: task.id }), 'DOCUMENT_CONTEXT_ACCESS_DENIED', 403);
  await expectAppError(() => x.d.generated.get(member, queued.id), 'DOCUMENT_CONTEXT_ACCESS_DENIED', 403);
  expect(x.d.generated.list(member, new URLSearchParams()).meta.total).toBe(0);
  // Authority is proven again after rendering: a change while the job was in flight is never published.
  for (const row of x.c.state.rolePermissions.filter(row => row.roleId === member.role.id && row.permissionId === 'task.read')) row.isDeleted = false;
  const inFlight = x.generate(member, { entityId: task.id }), runner = x.d.generated, now = new Date();
  const [claimed] = runner.claimDue(1, randomUUID(), now);
  const ticket = runner.prepare(claimed, x.doc(claimed).claimId!, now)!;
  const outcome = await runner.deliver(ticket);
  x.c.state.tasks.find(row => row.id === task.id)!.title = 'Renamed while rendering';
  runner.finish(ticket, outcome, now);
  expect(x.doc(inFlight.id)).toMatchObject({ status: 'QUEUED', errorCode: 'DOCUMENT_CONTEXT_CHANGED', fileId: null });
  revoke('task.read');
  const ticket2 = (() => { const at = new Date(Date.now() + 3600_000); runner.claimDue(1, 'second', at); return runner.prepare(inFlight.id, 'second', at); })();
  expect(ticket2).toBeNull();
  expect(x.doc(inFlight.id)).toMatchObject({ status: 'FAILED', errorCode: 'DOCUMENT_CONTEXT_ACCESS_DENIED' });
  expect(x.c.state.driveFiles).toHaveLength(0);
  // A foreign Workspace cannot see or address the document or its source.
  const foreign = await x.c.foreignActor();
  await expectAppError(() => x.d.generated.get(foreign, queued.id), 'GENERATED_DOCUMENT_NOT_FOUND', 404);
  await expectAppError(() => x.d.templates.get(foreign, x.template.id), 'DOCUMENT_TEMPLATE_NOT_FOUND', 404);
});

it('Regenerate preserving old output.', async () => {
  const x = await fixture(), first = x.generate();
  await x.run();
  const original = x.d.generated.get(x.c.owner, first.id), originalBytes = Buffer.from(x.bytes(original.fileId!));
  const originalVersion = x.c.state.driveFileVersions.find(row => row.id === original.fileVersionId)!;
  await x.d.templates.patch(x.c.owner, x.template.id, b({ version: x.template.version, htmlTemplate: `${HTML}<p>Revised terms</p>` }));
  expect(x.c.state.documentTemplateRevisions.map(row => row.revision)).toEqual([1, 2]);
  const second = x.d.generated.regenerate(x.c.owner, first.id, b({ generationKey: randomUUID() }));
  await expectAppError(() => x.d.generated.regenerate(x.c.owner, first.id, b({ generationKey: randomUUID() })), 'DOCUMENT_STATE_INVALID', 409);
  await x.run();
  const regenerated = x.d.generated.get(x.c.owner, second.id), previous = x.d.generated.get(x.c.owner, first.id);
  expect(regenerated).toMatchObject({ status: 'READY', regeneratedFromId: first.id, documentNumber: original.documentNumber, templateRevisionId: x.c.state.documentTemplateRevisions[1].id });
  expect(regenerated.fileId).not.toBe(original.fileId);
  expect(previous).toMatchObject({ status: 'READY', supersededById: second.id, fileId: original.fileId, fileVersionId: original.fileVersionId });
  expect(x.c.state.driveFileVersions.find(row => row.id === originalVersion.id)).toEqual(originalVersion);
  expect(x.bytes(original.fileId!).equals(originalBytes)).toBe(true);
  expect(x.bytes(regenerated.fileId!).toString('latin1')).toContain('Revised terms');
  expect(originalBytes.toString('latin1')).not.toContain('Revised terms');
  await expectAppError(() => x.d.generated.regenerate(x.c.owner, first.id, b({ generationKey: randomUUID() })), 'DOCUMENT_STATE_INVALID', 409);
  // Pinning the original revision reproduces identical bytes.
  const pinned = x.d.generated.regenerate(x.c.owner, second.id, b({ generationKey: randomUUID(), useCurrentTemplate: false }));
  await x.run();
  expect(x.bytes(x.doc(pinned.id).fileId!).equals(x.bytes(regenerated.fileId!))).toBe(true);
  // Archiving withdraws the record but keeps the retained artifact.
  const archived = x.d.generated.remove(x.c.owner, first.id, b({ version: x.doc(first.id).version }));
  expect(archived.status).toBe('ARCHIVED');
  expect(x.c.state.driveFiles.find(row => row.id === original.fileId)?.status).toBe('ACTIVE');
  expect(x.d.generated.list(x.c.owner, new URLSearchParams()).data.map(row => row.id)).not.toContain(first.id);
  expect(x.d.generated.list(x.c.owner, new URLSearchParams({ status: 'ARCHIVED' })).data.map(row => row.id)).toEqual([first.id]);
  expect(x.c.state.auditLogs.filter(row => row.action === 'DOCUMENT.ARCHIVED')).toHaveLength(1);
  // Template deletion keeps every revision used by history.
  x.d.templates.delete(x.c.owner, x.template.id, b({ version: x.c.state.documentTemplates[0].version }));
  expect(x.c.state.documentTemplateRevisions).toHaveLength(2);
  await expectAppError(() => x.generate(), 'DOCUMENT_TEMPLATE_NOT_FOUND', 404);
});

it('renders DOCX templates from an immutable source snapshot and rejects split placeholders', async () => {
  const x = await fixture();
  const source = blocksToDocx([{ kind: 'heading', text: 'Brief for {{entity.title}}', level: 1 }, { kind: 'paragraph', text: 'Note {{input.note}} & more', level: 0 }]);
  const fileId = await upload(x, 'brief.docx', source);
  const template = await x.d.templates.create(x.c.owner, b({ name: 'Docx brief', templateType: 'DOCX', entityType: 'TASK', documentType: 'DOCX_BRIEF', sourceFileId: fileId, schemaJson: SCHEMA }));
  expect(template.outputFormats).toEqual(['DOCX']);
  const preview = await x.d.templates.preview(x.c.owner, template.id, b({ entityId: x.task.id, inputs: { note: '<x>' } }));
  expect(preview).toMatchObject({ format: 'TEXT', content: 'Brief for Quarterly review\nNote <x> & more' });
  // Later Versions of the source File do not change the published revision.
  const replacement = blocksToDocx([{ kind: 'paragraph', text: 'Replaced', level: 0 }]), checksum = createHash('sha256').update(replacement).digest('hex');
  const next = x.f.uploads.createVersion(x.c.owner, fileId, b({ expectedSizeBytes: replacement.length, expectedChecksum: checksum, idempotencyKey: randomUUID(),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', version: x.c.state.driveFiles.find(row => row.id === fileId)!.version }));
  await x.f.uploads.part(x.c.owner, next.id, b({ partNumber: 1, checksum, dataBase64: replacement.toString('base64') }));
  await x.f.uploads.complete(x.c.owner, next.id, b());
  expect(x.c.state.driveFileVersions.filter(row => row.fileId === fileId)).toHaveLength(2);
  const queued = x.d.generated.create(x.c.owner, b({ templateId: template.id, entityId: x.task.id, folderId: x.root.id, generationKey: randomUUID(), inputs: { note: '<x>' }, fileName: 'Generated brief' }));
  await x.run();
  const doc = x.d.generated.get(x.c.owner, queued.id), file = x.c.state.driveFiles.find(row => row.id === doc.fileId)!;
  expect(file).toMatchObject({ name: 'Generated brief.docx', extension: 'docx', status: 'ACTIVE' });
  const xml = readZip(x.bytes(file.id)).find(entry => entry.name === 'word/document.xml')!.data.toString('utf8');
  expect(xml).toContain('Brief for Quarterly review'); expect(xml).toContain('Note &lt;x&gt; &amp; more');
  await expectAppError(() => x.d.generated.create(x.c.owner, b({ templateId: template.id, entityId: x.task.id, folderId: x.root.id, generationKey: randomUUID(), outputFormat: 'PDF' })), 'DOCUMENT_TEMPLATE_INVALID', 400);
  const split = writeZip(readZip(source).map(entry => entry.name === 'word/document.xml' ? { name: entry.name, data: Buffer.from(entry.data.toString('utf8')
    .replace('Brief for {{entity.title}}', 'Brief for {{entity.</w:t></w:r><w:r><w:t>title}}')) } : entry));
  const splitId = await upload(x, 'split.docx', split);
  await expectAppError(() => x.d.templates.create(x.c.owner, b({ name: 'Split', templateType: 'DOCX', entityType: 'TASK', documentType: 'SPLIT', sourceFileId: splitId })), 'DOCUMENT_TEMPLATE_INVALID', 400);
  const notZip = await upload(x, 'plain.docx', Buffer.from('not a zip'));
  await expectAppError(() => x.d.templates.create(x.c.owner, b({ name: 'Plain', templateType: 'DOCX', entityType: 'TASK', documentType: 'PLAIN', sourceFileId: notZip })), 'DOCUMENT_TEMPLATE_INVALID', 400);
});

it('enforces template permissions, optimistic versions and metadata-only revisions', async () => {
  const x = await fixture(), reader = await x.c.memberActor('template-reader', perms('WORKSPACE', 'document_template.read'));
  expect(x.d.templates.list(reader, new URLSearchParams({ entityType: 'TASK' })).meta.total).toBe(1);
  await expectAppError(() => x.d.templates.create(reader, b({ name: 'No', templateType: 'HTML', entityType: 'TASK', documentType: 'NO', htmlTemplate: 'x' })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.d.templates.patch(reader, x.template.id, b({ version: 1, name: 'No' })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.d.generated.create(reader, b({ templateId: x.template.id, entityId: x.task.id, folderId: x.root.id, generationKey: 'k' })), 'PERMISSION_DENIED', 403);
  await expectAppError(() => x.d.templates.patch(x.c.owner, x.template.id, b({ version: 99, name: 'Stale' })), 'RESOURCE_VERSION_CONFLICT', 409);
  await expectAppError(() => x.d.templates.patch(x.c.owner, x.template.id, b({ version: 1, templateType: 'DOCX' })), 'VALIDATION_ERROR', 400);
  const renamed = await x.d.templates.patch(x.c.owner, x.template.id, b({ version: 1, name: 'Renamed', isActive: false }));
  expect(renamed).toMatchObject({ name: 'Renamed', currentRevision: 1, version: 2, isActive: false });
  await expectAppError(() => x.generate(), 'DOCUMENT_TEMPLATE_INVALID', 409);
  const replaced = await x.d.templates.replace(x.c.owner, x.template.id, b({ version: 2, name: 'Replaced', documentType: 'TASK_BRIEF', htmlTemplate: '<p>{{entity.title}}</p>' }));
  expect(replaced).toMatchObject({ currentRevision: 2, isActive: true, outputFormats: ['PDF'], numberPrefix: null, schemaJson: { inputs: {} } });
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'DOCUMENT_TEMPLATE_CHANGED')).toHaveLength(3);
  expect(x.c.state.auditLogs.filter(row => row.action.startsWith('DOCUMENT_TEMPLATE.'))).toHaveLength(3);
});
