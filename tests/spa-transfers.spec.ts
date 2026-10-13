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

jest.setTimeout(120000); let db: PrismaClient, storageRoot: string;
const ownedParent = path.resolve('.local-file-objects'), previousRoot = process.env.FILE_OBJECT_ROOT;
beforeAll(async () => {
  await mkdir(ownedParent, { recursive: true }); storageRoot = await mkdtemp(path.join(ownedParent, 'spa-transfer-test-'));
  process.env.FILE_OBJECT_ROOT = storageRoot;
  const url = await prepareProcessPlatformDatabase('truecrm_spa_transfers_test');
  db = new PrismaClient({ datasources: { db: { url } } });
}, 300000);
afterAll(async () => {
  await db?.$disconnect();
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
  return { ...f, objects, artifacts, transfers, source, prepared, fileId, queue, read, block: (value: boolean) => { blocked = value; } };
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
    } finally { jest.useRealTimers(); }
  });
});
