import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareProcessPlatformDatabase } from '@/tests/support/process-platform-db';
import { spaFixture } from '@/tests/support/spa-fixture';
import { SpaTransferService } from '@/src/server/spa/transfer-service';
import { FileArtifactService } from '@/src/server/collab/files/artifact-service';
import { LocalObjectStorage } from '@/src/server/collab/files/object-storage';
import { resolvePrincipal } from '@/src/server/process-platform/context';

jest.setTimeout(120000); let db: PrismaClient, root: string;
const parent = path.resolve('.local-file-objects'), previousRoot = process.env.FILE_OBJECT_ROOT;
beforeAll(async () => {
  await mkdir(parent, { recursive: true }); root = await mkdtemp(path.join(parent, 'spa-lifecycle-test-'));
  process.env.FILE_OBJECT_ROOT = root;
  const url = await prepareProcessPlatformDatabase('truecrm_spa_transfers_test');
  db = new PrismaClient({ datasources: { db: { url } } });
}, 300000);
afterAll(async () => {
  await db?.$disconnect();
  if (previousRoot === undefined) delete process.env.FILE_OBJECT_ROOT; else process.env.FILE_OBJECT_ROOT = previousRoot;
  if (root && path.resolve(root).startsWith(parent + path.sep) && path.basename(root).startsWith('spa-lifecycle-test-'))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await spaFixture(db, 'INTEGER');
  const artifacts = new FileArtifactService(new LocalObjectStorage(root), { process: async () => ({ scanStatus: 'CLEAN', processed: true }) });
  const transfers = new SpaTransferService(db, artifacts);
  const queue = async (rows: string, mode: 'CREATE_ONLY' | 'UPSERT_BY_EXTERNAL_KEY' = 'CREATE_ONLY') => {
    const prepared = await artifacts.prepare(f.workspace.id, Buffer.from('Title,Owner,Value,Key\r\n' + rows), 'text/csv');
    const fileId = await db.$transaction(tx => artifacts.publish(tx, f.actor, prepared, 'Import-' + randomUUID() + '.csv'), { timeout: 30000 });
    return transfers.queueImport(f.actor, f.type.id, { fileId, mode, sourceSystem: 'contract', externalKeyColumn: 'Key',
      fieldMapping: { Title: 'title', Owner: 'assignedUserId', Value: 'VALUE' } });
  };
  return { ...f, transfers, queue };
}

describe('SPA Import, Export, Recycle and Retention — unit/integration contract', () => {
  it('CREATE_ONLY import reports duplicate external key without title merge', async () => {
    const f = await fixture(); await f.queue('Original,' + f.user.id + ',1,same\r\n'); await f.transfers.runTransfers();
    const second = await f.queue('Changed,' + f.user.id + ',2,same\r\n'); await f.transfers.runTransfers();
    expect(await db.spaItem.findMany({ where: { typeId: f.type.id } })).toEqual([expect.objectContaining({ title: 'Original', version: 1 })]);
    expect(await db.spaImportRow.findFirst({ where: { jobId: second.jobId } })).toMatchObject({ status: 'FAILED', errorCodes: ['SPA_GENERATION_CONFLICT'] });
  });
  it('UPSERT keyed retry does not duplicate records', async () => {
    const f = await fixture(); await f.queue('Original,' + f.user.id + ',1,same\r\n', 'UPSERT_BY_EXTERNAL_KEY'); await f.transfers.runTransfers();
    const next = await f.queue('Changed,' + f.user.id + ',2,same\r\n', 'UPSERT_BY_EXTERNAL_KEY'); await f.transfers.runTransfers();
    expect(await db.spaItem.findMany({ where: { typeId: f.type.id } })).toEqual([expect.objectContaining({ title: 'Changed', version: 2 })]);
    await f.transfers.runTransfers();
    expect(await db.spaItem.count({ where: { typeId: f.type.id } })).toBe(1);
    expect(await db.spaImportRow.count({ where: { jobId: next.jobId } })).toBe(1);
    expect(await db.spaItemExternalKey.count({ where: { typeId: f.type.id } })).toBe(1);
  });
  it('unknown mapping target is a per-row validation failure', async () => {
    const f = await fixture(), queued = await f.queue('Case,' + f.user.id + ',1,key\r\n');
    await f.schemas.editField(f.actor, f.type.id, f.field.id, { expectedVersion: 1 }, true); await f.publish(); await f.transfers.runTransfers();
    expect(await db.spaImportRow.findFirst({ where: { jobId: queued.jobId } })).toMatchObject({ status: 'FAILED', errorCodes: ['SPA_IMPORT_MAPPING_INVALID'] });
    expect(await db.spaItem.count({ where: { typeId: f.type.id } })).toBe(0);
  });
  it('partial import results include each row and avoid false all-or-nothing report', async () => {
    const f = await fixture(), queued = await f.queue('Good,' + f.user.id + ',1,good\r\nBad,' + f.user.id + ',bad,bad\r\n'); await f.transfers.runTransfers();
    expect(await f.transfers.importStatus(f.actor, f.type.id, queued.jobId)).toMatchObject({ status: 'SUCCEEDED',
      totals: { total: 2, processed: 2, succeeded: 1, failed: 1 }, reportFileId: expect.any(String),
      rows: [{ rowNumber: 2, status: 'SUCCEEDED' }, { rowNumber: 3, status: 'FAILED', errorCodes: ['SPA_IMPORT_ROW_INVALID'] }] });
    expect(await db.spaItem.count({ where: { typeId: f.type.id } })).toBe(1);
  });
  it('export excludes hidden salary and unauthorized items', async () => {
    const f = await fixture(); await f.create(100);
    await db.spaFieldPolicy.create({ data: { workspaceId: f.workspace.id, typeId: f.type.id, fieldId: f.field.id,
      subjectType: 'USER', subjectId: f.user.id, canView: false, canEdit: false } });
    await expect(f.transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['VALUE'] })).rejects.toMatchObject({ code: 'SPA_EXPORT_FORBIDDEN_FIELD' });
    await db.spaTypePolicy.create({ data: { workspaceId: f.workspace.id, typeId: f.type.id, roleId: f.role.id, action: 'SPA.ITEM.EXPORT', scope: 'NONE' } });
    const queued = await f.transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['title'] });
    expect(await db.spaExportJob.findUnique({ where: { id: queued.jobId } })).toMatchObject({ scopeSnapshot: { itemIds: [] } });
    await f.transfers.runTransfers();
    expect(await db.outboxEvent.findFirst({ where: { entityId: f.type.id, eventType: 'SPA_EXPORT_COMPLETED' } })).toMatchObject({ payload: { rowCount: 0 } });
  });
  it('import/export jobs require own or admin authorization', async () => {
    const f = await fixture(), imported = await f.queue('Good,' + f.user.id + ',1,key\r\n');
    const exported = await f.transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['title'] });
    const user = await db.user.create({ data: { firstName: 'Other', lastName: 'Reader', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: user.id, roleId: f.role.id } });
    const actor = await resolvePrincipal(db, f.workspace.id, user.id);
    actor.grants.set('SPA.ITEM.IMPORT', 'OWN'); actor.grants.set('SPA.ITEM.EXPORT', 'OWN');
    await expect(f.transfers.importStatus(actor, f.type.id, imported.jobId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(f.transfers.exportStatus(actor, f.type.id, exported.jobId)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    actor.grants.set('SPA.ITEM.IMPORT', 'WORKSPACE'); actor.grants.set('SPA.ITEM.EXPORT', 'WORKSPACE');
    expect((await f.transfers.importStatus(actor, f.type.id, imported.jobId)).jobId).toBe(imported.jobId);
    expect((await f.transfers.exportStatus(actor, f.type.id, exported.jobId)).jobId).toBe(exported.jobId);
  });
  it('purge blocked under legal hold', async () => {
    const f = await fixture(), item = await f.create(1); await f.items.lifecycle(f.actor, f.type.id, item.id, { expectedVersion: item.version });
    await db.spaItem.update({ where: { id: item.id }, data: { legalHold: true, version: { increment: 1 } } });
    await expect(f.transfers.queuePurge(f.actor, f.type.id, item.id, {})).rejects.toMatchObject({ code: 'SPA_RETENTION_HOLD' });
    expect(await db.spaPurgeJob.count({ where: { itemId: item.id } })).toBe(0);
    expect(await db.spaItem.count({ where: { id: item.id } })).toBe(1);
  });
  it('trash expires per workspace policy but keeps audit', async () => {
    const f = await fixture(), item = await f.create(1);
    await db.spaCapability.update({ where: { workspaceId_typeId_key: { workspaceId: f.workspace.id, typeId: f.type.id, key: 'RECYCLE_BIN' } }, data: { configuration: { retentionDays: 2 } } });
    await f.items.lifecycle(f.actor, f.type.id, item.id, { expectedVersion: item.version });
    const trashed = await db.spaItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(trashed.purgeAfter!.getTime() - trashed.trashedAt!.getTime()).toBeGreaterThanOrEqual(2 * 86400000);
    await expect(f.transfers.queuePurge(f.actor, f.type.id, item.id, {})).rejects.toMatchObject({ code: 'SPA_PURGE_BLOCKED' });
    // Historical retained Item: keep application and database lease clocks in agreement.
    await db.spaItem.update({ where: { id: item.id }, data: { trashedAt: new Date(Date.now() - 3 * 86400000),
      purgeAfter: new Date(Date.now() - 86400000), version: { increment: 1 } } });
    const queued = await f.transfers.queuePurge(f.actor, f.type.id, item.id, {});
      expect(await f.transfers.runPurges()).toMatchObject({ purged: 1, failed: 0 });
      expect(await db.spaItem.count({ where: { id: item.id } })).toBe(0);
      expect(await db.spaPurgeJob.findUnique({ where: { id: queued.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
      expect(await db.auditLog.count({ where: { entityId: item.id } })).toBeGreaterThan(0);
      expect(await db.outboxEvent.count({ where: { entityId: item.id, eventType: 'SPA_ITEM_PURGED' } })).toBe(1);
  });
});

export {};
