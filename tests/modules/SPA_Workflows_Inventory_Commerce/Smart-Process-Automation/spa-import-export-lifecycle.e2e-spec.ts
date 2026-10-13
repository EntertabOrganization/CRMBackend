import { PrismaClient } from '@prisma/client';
import type { INestApplication } from '@nestjs/common';
import type { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from '@/tests/support/process-platform-db';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
let spaFixture: typeof import('@/tests/support/spa-fixture').spaFixture;
let db: PrismaClient, app: INestApplication, base: string, root: string;
let router: typeof import('@/src/server/spa/routes').spaRouter, request: typeof NextRequest;
let sign: typeof import('@/src/server/security').signAccessToken;
let artifacts: import('@/src/server/collab/files/artifact-service').FileArtifactService;
let transfers: import('@/src/server/spa/transfer-service').SpaTransferService;
const parent = path.resolve('.local-file-objects'), previousRoot = process.env.FILE_OBJECT_ROOT;
jest.setTimeout(120000);
beforeAll(async () => {
  await mkdir(parent, { recursive: true }); root = await mkdtemp(path.join(parent, 'spa-transfer-http-'));
  process.env.FILE_OBJECT_ROOT = root;
  const url = await prepareProcessPlatformDatabase('truecrm_spa_schema_http_test');
  db = new PrismaClient({ datasources: { db: { url } } });
  spaFixture = (await import('@/tests/support/spa-fixture')).spaFixture;
  const { FileArtifactService } = await import('@/src/server/collab/files/artifact-service');
  const { LocalObjectStorage } = await import('@/src/server/collab/files/object-storage');
  const { SpaTransferService } = await import('@/src/server/spa/transfer-service');
  artifacts = new FileArtifactService(new LocalObjectStorage(root), { process: async () => ({ scanStatus: 'CLEAN', processed: true }) });
  transfers = new SpaTransferService(db, artifacts);
  const { Module } = await import('@nestjs/common'), { NestFactory } = await import('@nestjs/core');
  const { nestControllers, configurePackBodyParsing } = await import('@/src/server/process-platform/nest-adapter');
  router = (await import('@/src/server/spa/routes')).spaRouter;
  const { prisma } = await import('@/src/server/prisma-client');
  expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toBe('truecrm_spa_schema_http_test');
  request = (await import('next/server')).NextRequest; sign = (await import('@/src/server/security')).signAccessToken;
  class TransferHttpModule {}
  Module({ controllers: nestControllers(router) })(TransferHttpModule);
  app = await NestFactory.create(TransferHttpModule, { logger: false, bodyParser: false }); configurePackBodyParsing(app as never);
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
}, 300000);
afterAll(async () => {
  await app?.close(); await db?.$disconnect(); await (await import('@/src/server/prisma-client')).prisma.$disconnect();
  if (previousRoot === undefined) delete process.env.FILE_OBJECT_ROOT; else process.env.FILE_OBJECT_ROOT = previousRoot;
  if (root && path.resolve(root).startsWith(parent + path.sep) && path.basename(root).startsWith('spa-transfer-http-')) await rm(root, { recursive: true, force: true });
});
const operations = [
  ['POST', 'imports', 'SPA.ITEM.IMPORT', 202], ['GET', 'imports/:jobId', 'SPA.ITEM.IMPORT', 200],
  ['POST', 'imports/:jobId/cancel', 'SPA.ITEM.IMPORT', 200], ['POST', 'exports', 'SPA.ITEM.EXPORT', 202],
  ['GET', 'exports/:jobId', 'SPA.ITEM.EXPORT', 200], ['GET', 'trash', 'SPA.ITEM.RESTORE', 200],
  ['POST', 'items/:itemId/purge', 'SPA.ITEM.HARD_DELETE', 202],
] as const;

for (const transport of ['Nest', 'Next'] as const) describe('SPA transfer REST E2E: ' + transport, () => {
  for (const [method, route, permission, status] of operations) it(method + ' /api/v1/spa/types/:typeId/' + route +
    ' verifies response, permission/token, tenant scope, DB effect and outbox', async () => {
    const f = await spaFixture(db), token = await sign(f.user.id);
    const prepared = await artifacts.prepare(f.workspace.id, Buffer.from('Title,Owner\r\nCase,' + f.user.id + '\r\n'), 'text/csv');
    const fileId = await db.$transaction(tx => artifacts.publish(tx, f.actor, prepared, 'Source.csv'), { timeout: 30000 });
    const importBody = { fileId, mode: 'CREATE_ONLY', fieldMapping: { Title: 'title', Owner: 'assignedUserId' } };
    const imported = await transfers.queueImport(f.actor, f.type.id, importBody);
    const exported = await transfers.queueExport(f.actor, f.type.id, { fieldCodes: ['title'] });
    const item = await f.create('Value'); await f.items.lifecycle(f.actor, f.type.id, item.id, { expectedVersion: item.version });
    await db.spaItem.update({ where: { id: item.id }, data: { trashedAt: new Date(Date.now() - 2 * 86400000), purgeAfter: new Date(Date.now() - 86400000), version: { increment: 1 } } });
    const tail = route.replace(':jobId', route.startsWith('imports') ? imported.jobId : exported.jobId).replace(':itemId', item.id);
    const url = '/api/v1/spa/types/' + f.type.id + '/' + tail;
    const input = method === 'GET' ? undefined : route === 'imports' ? importBody : route === 'exports' ? { fieldCodes: ['title'] } : {};
    const call = async (endpoint: string, auth?: string, workspaceId = f.workspace.id, body: unknown = input) => {
      const headers = { 'x-workspace-id': workspaceId, ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const response = transport === 'Nest' ? await fetch(base + endpoint, init) : await router.dispatch(new request('http://test.local' + endpoint, init));
      return { status: response.status, body: await response.json() };
    };
    expect((await call(url)).status).toBe(401);
    const granted = await db.permission.findUniqueOrThrow({ where: { key: permission } });
    const grant = { roleId_permissionId: { roleId: f.role.id, permissionId: granted.id } };
    await db.rolePermission.update({ where: grant, data: { isDeleted: true } }); expect((await call(url, token)).status).toBe(403);
    await db.rolePermission.update({ where: grant, data: { isDeleted: false } });
    const foreign = await spaFixture(db); expect((await call(url, await sign(foreign.user.id), foreign.workspace.id)).status).toBe(404);
    expect((await call(url.replace(f.type.id, 'invalid'), token)).status).toBe(400);
    const before = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } }), audits = await db.auditLog.count({ where: { workspaceId: f.workspace.id } });
    if (method === 'POST') expect((await call(url, token, f.workspace.id, { ...input, workspaceId: foreign.workspace.id })).status).toBe(400);
    const result = await call(url, token); expect(result.status).toBe(status); expect(result.body.success).toBe(true);
    const data = result.body.data;
    if (route === 'imports') expect(await db.spaImportJob.findUnique({ where: { id: data.jobId } })).toMatchObject({ workspaceId: f.workspace.id, typeId: f.type.id, status: 'QUEUED', sourceFileId: fileId });
    if (route === 'imports/:jobId') expect(data).toMatchObject({ jobId: imported.jobId, status: 'QUEUED', rows: [] });
    if (route.endsWith('/cancel')) {
      expect(await db.spaImportJob.findUnique({ where: { id: imported.jobId } })).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
      expect(await db.spaImportRow.count({ where: { jobId: imported.jobId } })).toBe(0);
    }
    if (route === 'exports') expect(await db.spaExportJob.findUnique({ where: { id: data.jobId } })).toMatchObject({ workspaceId: f.workspace.id, scopeSnapshot: { itemIds: [] } });
    if (route === 'exports/:jobId') expect(data).toMatchObject({ jobId: exported.jobId, status: 'QUEUED', downloadFileId: null });
    if (route === 'trash') expect(data).toEqual([expect.objectContaining({ id: item.id, status: 'TRASHED' })]);
    if (route.endsWith('/purge')) {
      expect(await db.spaPurgeJob.findUnique({ where: { id: data.jobId } })).toMatchObject({ workspaceId: f.workspace.id, itemId: item.id, status: 'QUEUED' });
      expect(await db.spaItem.count({ where: { id: item.id } })).toBe(1);
    }
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before + (method === 'POST' ? 1 : 0));
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(audits + (method === 'POST' ? 1 : 0));
    if (route.endsWith('/cancel') || route.endsWith('/purge')) {
      expect((await call(url, token)).status).toBe(status);
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before + 1);
    }
  });
});

export {};
