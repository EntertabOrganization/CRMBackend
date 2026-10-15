import { PrismaClient } from '@prisma/client';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { spaFixture } from './support/spa-fixture';
import { SpaTransferService } from '../src/server/spa/transfer-service';
import { SpaPolicyService } from '../src/server/spa/policy-service';
import { spaReferenceContext } from '../src/server/spa/reference-adapter';
import { FileArtifactService } from '../src/server/collab/files/artifact-service';
import { LocalObjectStorage } from '../src/server/collab/files/object-storage';
import { parseCsv } from '../src/server/process-platform/csv';
import { hydrateState } from '../src/server/persistence';
import { InMemoryStore } from '../src/server/store';
import { AccessService } from '../src/server/access-service';
import { RealtimeHub } from '../src/server/realtime';
import { CollaborationModule } from '../src/server/collab';
import { UnconfiguredFilePort } from '../src/server/ports';
import { Body } from '../src/server/collab/support';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

jest.setTimeout(120000); let db: PrismaClient, storageRoot: string;
const ownedParent = path.resolve('.local-file-objects'), previousRoot = process.env.FILE_OBJECT_ROOT;
const previousSecret = process.env.FILE_DELIVERY_SECRET;
beforeAll(async () => {
  process.env.FILE_DELIVERY_SECRET = 'spa-transfer-delivery-secret-with-32-bytes';
  await mkdir(ownedParent, { recursive: true }); storageRoot = await mkdtemp(path.join(ownedParent, 'spa-transfer-test-'));
  process.env.FILE_OBJECT_ROOT = storageRoot;
  const url = await prepareProcessPlatformDatabase('truecrm_spa_transfers_test');
  db = new PrismaClient({ datasources: { db: { url } } });
}, 300000);
afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = previousSecret;
  await db?.$disconnect();
  await (await import('../src/server/prisma-client')).prisma.$disconnect();
  if (previousRoot === undefined) delete process.env.FILE_OBJECT_ROOT; else process.env.FILE_OBJECT_ROOT = previousRoot;
  if (storageRoot && path.resolve(storageRoot).startsWith(ownedParent + path.sep) && path.basename(storageRoot).startsWith('spa-transfer-test-'))
    await rm(storageRoot, { recursive: true, force: true });
});
async function fixture() {
  const f = await spaFixture(db, 'INTEGER'), objects = new LocalObjectStorage(storageRoot);
  let blocked = false;
  const artifacts = new FileArtifactService(objects, { process: async () => ({ scanStatus: blocked ? 'BLOCKED' : 'CLEAN', processed: true }) });
  const transfers = new SpaTransferService(db, artifacts);
  const source = Buffer.from('Title,Owner,Value\r\nGood,' + f.user.id + ',7\r\nInvalid,' + f.user.id + ',not-an-integer\r\n');
  const prepared = await artifacts.prepare(f.workspace.id, source, 'text/csv');
  const fileId = await db.$transaction(tx => artifacts.publish(tx, f.actor, prepared, 'Source.csv'), { timeout: 30000 });
  const queue = () => transfers.queueImport(f.actor, f.type.id, { fileId, mode: 'CREATE_ONLY',
    fieldMapping: { Title: 'title', Owner: 'assignedUserId', Value: 'VALUE' } });
  const read = (id: string) => db.$transaction(async tx => (await spaReferenceContext(tx, f.actor, new SpaPolicyService(db)))
    .readFile(id, 1000000), { timeout: 30000 });
  const files = async () => {
    const store = new InMemoryStore(await hydrateState(db)), access = new AccessService(store);
    const actor = access.actor(store.state.users.find(row => row.id === f.user.id)!, f.workspace.id);
    const collab = new CollaborationModule({ store, access, realtime: new RealtimeHub(), files: () => new UnconfiguredFilePort(),
      authorizeFileContent: (a, key, purpose) => db.$transaction(tx => transfers.authorizeArtifact(tx, a.workspaceId, a.user.id, key, purpose)) });
    collab.files.uploads.configure(objects, { process: async () => ({ scanStatus: 'CLEAN', processed: true }) });
    const redeem = (deliveryPath: string) => {
      const url = new URL(deliveryPath, 'http://test.local');
      return collab.files.delivery.redeem(url.pathname.split('/').at(-1)!, url.searchParams, 'artifact-client');
    };
    return { store, access, actor, collab, redeem };
  };
  const exportFile = async () => {
    const item = await f.create(12), ack = await transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['title', 'VALUE'] });
    await transfers.runTransfers();
    const job = await db.spaExportJob.findUniqueOrThrow({ where: { id: ack.jobId } });
    expect(job.status).toBe('SUCCEEDED'); expect(job.downloadFileId).not.toBeNull();
    return { item, job, fileId: job.downloadFileId! };
  };
  return { ...f, objects, artifacts, transfers, source, prepared, fileId, queue, read, files, exportFile,
    block: (value: boolean) => { blocked = value; } };
}
describe('SPA transfers through owning private Files artifacts', () => {
  it('stores and reads generated immutable content using the durable storage namespace', async () => {
    const f = await fixture(); expect(f.prepared.objectKey).toContain('/objects/artifacts/');
    expect(await f.objects.read(f.prepared.objectKey)).toEqual(f.source);
    expect((await f.read(f.fileId)).content).toEqual(f.source);
    await expect(f.objects.putImmutable(f.prepared.objectKey, Buffer.from('overwrite'))).rejects.toThrow();
    expect(await f.objects.read(f.prepared.objectKey)).toEqual(f.source);
  });
  it('publishes every row outcome in a private report with atomic job totals and completion evidence', async () => {
    const f = await fixture(), ack = await f.queue(); await f.transfers.runTransfers();
    const job = await db.spaImportJob.findUniqueOrThrow({ where: { id: ack.jobId } });
    expect(job).toMatchObject({ status: 'SUCCEEDED', totals: { total: 2, processed: 2, succeeded: 1, failed: 1 } });
    expect(job.reportFileId).not.toBeNull();
    const report = parseCsv((await f.read(job.reportFileId!)).content);
    expect(report).toEqual([expect.objectContaining({ rowNumber: '2', status: 'SUCCEEDED', errorCodes: '' }),
      expect.objectContaining({ rowNumber: '3', status: 'FAILED', itemId: '', errorCodes: 'SPA_IMPORT_ROW_INVALID' })]);
    expect(await db.spaItem.count({ where: { workspaceId: f.workspace.id, typeId: f.type.id } })).toBe(1);
    expect(await db.outboxEvent.findFirst({ where: { entityId: f.type.id, eventType: 'SPA_IMPORT_COMPLETED' } }))
      .toMatchObject({ payload: { reportFileId: job.reportFileId, succeeded: 1, failed: 1 } });
    const file = await db.driveFile.findUniqueOrThrow({ where: { id: job.reportFileId! } });
    expect(file).toMatchObject({ workspaceId: f.workspace.id, status: 'ACTIVE' });
    expect(await db.projectFileStorage.findUnique({ where: { id: file.storageId } })).toMatchObject({ type: 'PERSONAL', ownerUserId: f.user.id });
    expect((await f.transfers.importStatus(f.actor, f.type.id, job.id)).reportFileId).toBe(file.id);
    await f.transfers.runTransfers();
    expect(await db.outboxEvent.count({ where: { entityId: f.type.id, eventType: 'SPA_IMPORT_COMPLETED' } })).toBe(1);
  });
  it('retries report processing failures without replaying committed rows or claiming completion', async () => {
    const f = await fixture(), ack = await f.queue(); f.block(true); await f.transfers.runTransfers();
    expect(await db.spaImportJob.findUnique({ where: { id: ack.jobId } })).toMatchObject({ status: 'QUEUED', reportFileId: null, attempts: 1 });
    expect(await db.spaItem.count({ where: { typeId: f.type.id } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { entityId: f.type.id, eventType: 'SPA_IMPORT_COMPLETED' } })).toBe(0);
    f.block(false); await db.spaImportJob.update({ where: { id: ack.jobId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await f.transfers.runTransfers();
    expect(await db.spaImportJob.findUnique({ where: { id: ack.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await db.spaItem.count({ where: { typeId: f.type.id } })).toBe(1);
    expect(await db.spaImportRow.count({ where: { jobId: ack.jobId } })).toBe(2);
    expect(await db.driveFile.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
  });
  it('publishes an authorized export and hides its download identity once expired', async () => {
    const f = await fixture(); await f.create(12);
    const ack = await f.transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['title', 'VALUE'] });
    await f.transfers.runTransfers();
    const job = await db.spaExportJob.findUniqueOrThrow({ where: { id: ack.jobId } });
    expect(job.status).toBe('SUCCEEDED'); expect(job.downloadFileId).not.toBeNull();
    expect(parseCsv((await f.read(job.downloadFileId!)).content)).toEqual([{ title: 'Case', VALUE: '12' }]);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setInterval', 'setTimeout', 'queueMicrotask', 'performance', 'hrtime'] });
    try {
      jest.setSystemTime(new Date(job.expiresAt.getTime() + 1000));
      expect((await f.transfers.exportStatus(f.actor, f.type.id, job.id)).downloadFileId).toBeNull();
      await expect(f.read(job.downloadFileId!)).rejects.toMatchObject({ code: 'FILE_DELIVERY_UNAVAILABLE', status: 410 });
    } finally { jest.useRealTimers(); }
  });
  it('rejects a cached grant after export expiry without consuming it or emitting download evidence', async () => {
    const f = await fixture(), exported = await f.exportFile(), files = await f.files();
    const grant = await files.collab.files.delivery.issue(files.actor, exported.fileId, new URLSearchParams());
    await db.spaExportJob.update({ where: { id: exported.job.id }, data: { expiresAt: new Date(exported.job.createdAt.getTime() + 1) } });
    await expect(files.redeem(grant.deliveryPath)).rejects.toMatchObject({ code: 'FILE_DELIVERY_UNAVAILABLE', status: 410 });
    expect(files.store.state.fileDeliveryGrants.find(row => row.fileId === exported.fileId)!.consumedAt).toBeNull();
    expect(files.store.state.outboxEvents.some(row => row.entityId === exported.fileId && row.eventType === 'FILE_DOWNLOADED')).toBe(false);
    await expect(files.collab.files.delivery.issue(files.actor, exported.fileId, new URLSearchParams()))
      .rejects.toMatchObject({ code: 'FILE_DELIVERY_UNAVAILABLE' });
  });
  it.each(['permission', 'field', 'item', 'entitlement', 'membership'] as const)
    ('rechecks current %s authority even when Files and delivery state were loaded earlier', async change => {
      const f = await fixture(), exported = await f.exportFile(), files = await f.files();
      const grant = await files.collab.files.delivery.issue(files.actor, exported.fileId, new URLSearchParams());
      if (change === 'permission') {
        const permission = await db.permission.findUniqueOrThrow({ where: { key: 'SPA.ITEM.EXPORT' } });
        await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id, permissionId: permission.id } }, data: { isDeleted: true } });
      }
      if (change === 'field') await db.spaFieldPolicy.create({ data: { workspaceId: f.workspace.id, typeId: f.type.id,
        fieldId: f.field.id, subjectType: 'USER', subjectId: f.user.id, canView: false, canEdit: false } });
      if (change === 'item') await db.spaTypePolicy.create({ data: { workspaceId: f.workspace.id, typeId: f.type.id,
        roleId: f.role.id, action: 'SPA.ITEM.READ', scope: 'NONE' } });
      if (change === 'entitlement') await db.workspace.update({ where: { id: f.workspace.id }, data: { settings: { entitlements: { spa: false } } } });
      if (change === 'membership') await db.workspaceMembership.updateMany({ where: { workspaceId: f.workspace.id, userId: f.user.id }, data: { status: 'SUSPENDED' } });
      await expect(files.redeem(grant.deliveryPath)).rejects.toMatchObject({ code: 'FILE_DELIVERY_UNAVAILABLE', status: 410 });
      await expect(f.read(exported.fileId)).rejects.toBeDefined();
      expect(files.store.state.fileDeliveryGrants.find(row => row.fileId === exported.fileId)!.consumedAt).toBeNull();
    });
  it('retains object restrictions across File and folder copies, even after the original File is removed', async () => {
    const f = await fixture(), exported = await f.exportFile(), files = await f.files();
    const original = files.store.state.driveFiles.find(row => row.id === exported.fileId)!;
    const copy = files.collab.files.records.copy(files.actor, original.id, new Body({ folderId: original.folderId, name: 'Copy.csv' }));
    const copiedVersion = files.store.state.driveFileVersions.find(row => row.id === copy.currentVersionId)!;
    const binding = await db.fileArtifactBinding.findUniqueOrThrow({ where: { workspaceId_objectKey: { workspaceId: f.workspace.id, objectKey: copiedVersion.objectKey } } });
    expect(binding).toMatchObject({ entityType: 'SPA_EXPORT_JOB', entityId: exported.job.id });
    const staged = files.collab.files.records.stageFolderCopy(files.actor, new Map([[original.folderId, original.folderId]]), original.storageId);
    expect(staged.versions.some(row => row.objectKey === copiedVersion.objectKey)).toBe(true);
    const grant = await files.collab.files.delivery.issue(files.actor, copy.id, new URLSearchParams());
    const retiredAt = new Date(Date.now() - 1000);
    await db.$transaction(async tx => {
      // Simulate eventual owner retention before File purge; the existing FK
      // correctly prevents removing a File still referenced by a retained job.
      await tx.spaExportJob.delete({ where: { id: exported.job.id } });
      await tx.driveFile.update({ where: { id: original.id }, data: { currentVersionId: null,
        status: 'TRASHED', statusBeforeTrash: 'ACTIVE', trashedAt: retiredAt, purgeAfter: retiredAt,
        publicShareVersion: { increment: 1 } } });
      await tx.driveFileVersion.deleteMany({ where: { fileId: original.id } });
      await tx.driveFile.delete({ where: { id: original.id } });
    });
    await expect(files.redeem(grant.deliveryPath)).rejects.toMatchObject({ code: 'FILE_DELIVERY_UNAVAILABLE' });
    await expect(db.fileArtifactBinding.delete({ where: { id: binding.id } })).rejects.toThrow();
  });
  it('blocks public sharing, folder delivery and editor/template repurposing of private exports', async () => {
    const f = await fixture(), exported = await f.exportFile(), files = await f.files();
    const file = files.store.state.driveFiles.find(row => row.id === exported.fileId)!;
    await expect(files.collab.files.publicLinks.createFile(files.actor, file.id, new Body({ permissionMode: 'DOWNLOAD' })))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    const link = await files.collab.files.publicLinks.createFolder(files.actor, file.folderId, new Body({ permissionMode: 'DOWNLOAD' }));
    await expect(files.collab.files.delivery.issuePublic(link.token, 'FOLDER', new URLSearchParams({ fileId: file.id }), null))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    const version = files.store.state.driveFileVersions.find(row => row.id === file.currentVersionId)!;
    for (const purpose of ['EDIT', 'TEMPLATE'] as const)
      await expect(db.$transaction(tx => f.transfers.authorizeArtifact(tx, f.workspace.id, f.user.id, version.objectKey, purpose)))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(files.store.state.fileDeliveryGrants).toHaveLength(0);
  });
  it('checks authorization again after storage I/O and leaves a revoked delivery retryable', async () => {
    const f = await fixture(), exported = await f.exportFile(), files = await f.files();
    const grant = await files.collab.files.delivery.issue(files.actor, exported.fileId, new URLSearchParams());
    files.collab.files.uploads.configure({ putImmutable: (key, bytes) => f.objects.putImmutable(key, bytes), read: async key => {
      const bytes = await f.objects.read(key);
      await db.spaTypePolicy.create({ data: { workspaceId: f.workspace.id, typeId: f.type.id, roleId: f.role.id, action: 'SPA.ITEM.EXPORT', scope: 'NONE' } });
      return bytes;
    } }, { process: async () => ({ scanStatus: 'CLEAN', processed: true }) });
    await expect(files.redeem(grant.deliveryPath)).rejects.toMatchObject({ code: 'FILE_DELIVERY_UNAVAILABLE' });
    expect(files.store.state.fileDeliveryGrants[0].consumedAt).toBeNull();
  });
  it('rejects corrupted bytes in bounded processing instead of importing unverified content', async () => {
    const f = await fixture(), files = await f.files();
    files.collab.files.uploads.configure({ putImmutable: (key, bytes) => f.objects.putImmutable(key, bytes),
      read: async () => Buffer.from('tampered') }, { process: async () => ({ scanStatus: 'CLEAN', processed: true }) });
    await expect(files.collab.files.delivery.readForProcessing(files.actor, f.fileId, 1000000))
      .rejects.toMatchObject({ code: 'FILE_CONTENT_UNAVAILABLE', status: 503 });
  });
  it('requires current own-job or Workspace-wide IMPORT authority for report bytes', async () => {
    const f = await fixture(), imported = await f.queue(); await f.transfers.runTransfers();
    const job = await db.spaImportJob.findUniqueOrThrow({ where: { id: imported.jobId } });
    const version = await db.driveFileVersion.findFirstOrThrow({ where: { fileId: job.reportFileId! } });
    const user = await db.user.create({ data: { firstName: 'Report', lastName: 'Reader', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    const role = await db.role.create({ data: { workspaceId: f.workspace.id, name: 'Report reader' } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: user.id, roleId: role.id } });
    const permission = await db.permission.findUniqueOrThrow({ where: { key: 'SPA.ITEM.IMPORT' } });
    const grant = await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id, scope: 'OWN' } });
    const read = () => db.$transaction(tx => f.transfers.authorizeArtifact(tx, f.workspace.id, user.id, version.objectKey, 'DOWNLOAD'));
    await expect(read()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    await db.rolePermission.update({ where: { id: grant.id }, data: { scope: 'WORKSPACE' } });
    await expect(read()).resolves.toBeUndefined();
    await db.rolePermission.update({ where: { id: grant.id }, data: { isDeleted: true } });
    await expect(read()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
  });
  it('backfills retained export/report objects on the prior schema and enforces tenant-safe immutable ownership', async () => {
    const f = await fixture(), exported = await f.exportFile(), imported = await f.queue(); await f.transfers.runTransfers();
    const report = await db.spaImportJob.findUniqueOrThrow({ where: { id: imported.jobId } });
    const prior = await db.fileArtifactBinding.findMany({ where: { workspaceId: f.workspace.id } });
    expect(prior).toHaveLength(2);
    const url = new URL(process.env.DATABASE_URL!);
    const name = (await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name;
    if (name !== 'truecrm_spa_transfers_test' || url.pathname !== '/' + name || url.hostname !== '127.0.0.1')
      throw new Error('Schema compatibility checks require the explicitly owned SPA transfer database.');
    // Roll back only the new schema in this disposable database, retain the real
    // pre-existing jobs/Files, and apply the exact forward migration atomically.
    await db.$executeRawUnsafe('DROP TABLE file_artifact_bindings');
    await db.$executeRawUnsafe('DROP FUNCTION file_artifact_binding_immutable()');
    await db.$executeRawUnsafe('DROP FUNCTION file_artifact_binding_owner_guard()');
    const psqlName = process.platform === 'win32' ? 'psql.exe' : 'psql';
    const psqlBin = process.env.POSTGRES_BIN ?? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'TrueCRM-ProcessPack', 'Postgres', 'runtime', 'pgsql', 'bin') : undefined);
    const psql = psqlBin ? path.join(psqlBin, psqlName) : psqlName;
    execFileSync(psql, ['-X', '-v', 'ON_ERROR_STOP=1', '-1', '-h', url.hostname, '-p', url.port, '-U', decodeURIComponent(url.username), '-d', name,
      '-f', path.resolve('prisma/migrations/202610140002_spa_file_artifact_authority/migration.sql')],
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, stdio: 'pipe' });
    const bindings = await db.fileArtifactBinding.findMany({ where: { workspaceId: f.workspace.id } });
    expect(bindings.map(row => ({ objectKey: row.objectKey, entityType: row.entityType, entityId: row.entityId })))
      .toEqual(expect.arrayContaining(prior.map(row => ({ objectKey: row.objectKey, entityType: row.entityType, entityId: row.entityId }))));
    expect((await f.read(report.reportFileId!)).content.toString()).toContain('SUCCEEDED');
    expect((await f.read(exported.fileId)).content.toString()).toContain('12');
    const foreign = await fixture(), foreignExport = await foreign.exportFile();
    await expect(db.fileArtifactBinding.create({ data: { workspaceId: f.workspace.id, objectKey: f.prepared.objectKey,
      entityType: 'SPA_EXPORT_JOB', entityId: foreignExport.job.id } })).rejects.toThrow();
    await expect(db.fileArtifactBinding.update({ where: { id: bindings[0].id }, data: { entityId: foreignExport.job.id } })).rejects.toThrow();
  });
});
