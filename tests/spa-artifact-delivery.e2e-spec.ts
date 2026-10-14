import { PrismaClient } from '@prisma/client';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';

jest.setTimeout(120000);
let db: PrismaClient, root: string;
const parent = path.resolve('.local-file-objects'), previousRoot = process.env.FILE_OBJECT_ROOT,
  previousSecret = process.env.FILE_DELIVERY_SECRET;
beforeAll(async () => {
  await mkdir(parent, { recursive: true }); root = await mkdtemp(path.join(parent, 'spa-artifact-http-'));
  process.env.FILE_OBJECT_ROOT = root;
  process.env.FILE_DELIVERY_SECRET = 'spa-artifact-http-signing-secret-with-32-bytes';
  const url = await prepareProcessPlatformDatabase('truecrm_spa_artifact_http_test');
  db = new PrismaClient({ datasources: { db: { url } } });
}, 300000);
afterAll(async () => {
  await db?.$disconnect(); await (await import('../src/server/prisma-client')).prisma.$disconnect();
  if (previousRoot === undefined) delete process.env.FILE_OBJECT_ROOT; else process.env.FILE_OBJECT_ROOT = previousRoot;
  if (previousSecret === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = previousSecret;
  if (root && path.resolve(root).startsWith(parent + path.sep) && path.basename(root).startsWith('spa-artifact-http-'))
    await rm(root, { recursive: true, force: true });
});

it('delivers private exports through real Next handlers and rejects cached grants after SPA revocation', async () => {
  // Import application modules only after pointing their Prisma singleton at the owned database.
  const { spaFixture } = await import('./support/spa-fixture'), { FileArtifactService } = await import('../src/server/collab/files/artifact-service');
  const { LocalObjectStorage } = await import('../src/server/collab/files/object-storage');
  const { SpaTransferService } = await import('../src/server/spa/transfer-service'), { parseCsv } = await import('../src/server/process-platform/csv');
  const f = await spaFixture(db, 'INTEGER'), objects = new LocalObjectStorage(root);
  const transfers = new SpaTransferService(db, new FileArtifactService(objects,
    { process: async () => ({ scanStatus: 'CLEAN', processed: true }) }));
  await f.create(12);
  const queued = await transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['title', 'VALUE'] });
  await transfers.runTransfers();
  const job = await db.spaExportJob.findUniqueOrThrow({ where: { id: queued.jobId } });
  expect(job.status).toBe('SUCCEEDED'); expect(job.downloadFileId).not.toBeNull();
  const fileId = job.downloadFileId!;
  const { prisma } = await import('../src/server/prisma-client');
  expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toBe('truecrm_spa_artifact_http_test');
  const { NextRequest } = await import('next/server'), { signAccessToken } = await import('../src/server/security');
  const issueRoute = await import('../app/api/v1/files/[[...path]]/route');
  const deliveryRoute = await import('../app/api/v1/file-delivery/[id]/route');
  const { appContext } = await import('../src/server/app-context');
  appContext.collab.files.uploads.configure(objects, { process: async () => ({ scanStatus: 'CLEAN', processed: true }) });
  const token = await signAccessToken(f.user.id);
  const issue = () => issueRoute.GET(new NextRequest('http://test.local/api/v1/files/' + fileId + '/download',
    { headers: { authorization: 'Bearer ' + token, 'x-workspace-id': f.workspace.id } }),
    { params: Promise.resolve({ path: [fileId, 'download'] }) });
  const redeem = (deliveryPath: string) => deliveryRoute.GET(new NextRequest('http://test.local' + deliveryPath),
    { params: Promise.resolve({ id: new URL(deliveryPath, 'http://test.local').pathname.split('/').at(-1)! }) });
  const issued = await issue(); expect(issued.status).toBe(200);
  expect(issued.headers.get('cache-control')).toContain('no-store');
  const first = (await issued.json()).data, delivered = await redeem(first.deliveryPath);
  expect(delivered.status).toBe(200);
  expect(parseCsv(Buffer.from(await delivered.arrayBuffer()))).toEqual([{ title: 'Case', VALUE: '12' }]);
  const second = (await (await issue()).json()).data;
  const permission = await db.permission.findUniqueOrThrow({ where: { key: 'SPA.ITEM.EXPORT' } });
  await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.role.id, permissionId: permission.id } }, data: { isDeleted: true } });
  const denied = await redeem(second.deliveryPath); expect(denied.status).toBe(410);
  expect((await denied.json()).error.code).toBe('FILE_DELIVERY_UNAVAILABLE');
  expect(await db.fileDeliveryGrant.count({ where: { fileId, consumedAt: null } })).toBe(1);
  expect(await db.auditLog.count({ where: { entityId: fileId, action: 'FILE.DOWNLOADED' } })).toBe(1);
  expect((await issue()).status).toBe(403);
});
