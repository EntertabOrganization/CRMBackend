import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NextRequest } from 'next/server';
import { prepareProcessPlatformDatabase } from '@/tests/support/process-platform-db';
let spaFixture: typeof import('@/tests/support/spa-fixture').spaFixture;

jest.setTimeout(120000);
let db: PrismaClient, app: INestApplication, base: string;
let router: typeof import('@/src/server/spa/routes').spaRouter;
let request: typeof NextRequest;
let sign: typeof import('@/src/server/security').signAccessToken;
beforeAll(async () => {
  const url = await prepareProcessPlatformDatabase('truecrm_spa_schema_http_test');
  db = new PrismaClient({ datasources: { db: { url } } });
  spaFixture = (await import('@/tests/support/spa-fixture')).spaFixture;
  const { Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { nestControllers, configurePackBodyParsing } = await import('@/src/server/process-platform/nest-adapter');
  router = (await import('@/src/server/spa/routes')).spaRouter;
  const { prisma } = await import('@/src/server/prisma-client');
  const connected = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  expect(connected[0].name).toBe('truecrm_spa_schema_http_test');
  request = (await import('next/server')).NextRequest;
  sign = (await import('@/src/server/security')).signAccessToken;
  class SchemaHttpModule {}
  Module({ controllers: nestControllers(router) })(SchemaHttpModule);
  app = await NestFactory.create(SchemaHttpModule, { logger: false, bodyParser: false });
  configurePackBodyParsing(app as never);
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
}, 300000);
afterAll(async () => {
  await app?.close(); await db?.$disconnect();
  const { prisma } = await import('@/src/server/prisma-client'); await prisma.$disconnect();
});

type Fixture = Awaited<ReturnType<typeof spaFixture>>;
type Case = { method: string; route: string; permission: string; status: number; body: (f: Fixture) => Promise<unknown>;
  verify: (f: Fixture, data: any) => Promise<void> };
const empty = async () => undefined;
const cases: Case[] = [
  { method: 'GET', route: 'fields', permission: 'SPA.SCHEMA.READ', status: 200, body: empty,
    verify: async (f, data) => { expect(data).toEqual([expect.objectContaining({ id: f.field.id, code: 'VALUE' })]); } },
  { method: 'POST', route: 'fields', permission: 'SPA.SCHEMA.MANAGE', status: 201,
    body: async () => ({ code: 'SECOND', name: 'Second', fieldType: 'TEXT' }),
    verify: async (f, data) => { expect(data.code).toBe('SECOND'); expect((await f.schemas.draft(f.actor, f.type.id)).snapshot.fields).toHaveLength(2);
      expect(await db.spaFieldDefinition.count({ where: { typeId: f.type.id } })).toBe(1); } },
  { method: 'PATCH', route: 'fields/:fieldId', permission: 'SPA.SCHEMA.MANAGE', status: 200,
    body: async () => ({ name: 'Renamed' }), verify: async (f, data) => { expect(data.name).toBe('Renamed');
      expect((await f.schemas.draft(f.actor, f.type.id)).snapshot.fields[0].name).toBe('Renamed');
      expect((await db.spaFieldDefinition.findUniqueOrThrow({ where: { id: f.field.id } })).name).toBe('Value'); } },
  { method: 'POST', route: 'fields/:fieldId/deactivate', permission: 'SPA.SCHEMA.MANAGE', status: 200,
    body: async () => ({ expectedVersion: 1 }), verify: async (f, data) => { expect(data.isActive).toBe(false);
      expect(await db.outboxEvent.count({ where: { entityId: f.type.id, eventType: 'SPA_FIELD_DEACTIVATED' } })).toBe(1); } },
  { method: 'GET', route: 'schema/draft', permission: 'SPA.SCHEMA.READ', status: 200, body: empty,
    verify: async (f, data) => { expect(data.snapshot.fields[0]).toMatchObject({ id: f.field.id, code: 'VALUE' }); } },
  { method: 'PATCH', route: 'schema/draft', permission: 'SPA.SCHEMA.MANAGE', status: 200,
    body: async f => ({ expectedVersion: (await f.schemas.draft(f.actor, f.type.id)).version,
      changes: [{ kind: 'UPDATE_FIELD', fieldId: f.field.id, changes: { name: 'Draft changed' } }] }),
    verify: async (f, data) => { expect(data.snapshot.fields[0].name).toBe('Draft changed');
      expect((await db.spaFieldDefinition.findUniqueOrThrow({ where: { id: f.field.id } })).name).toBe('Value'); } },
  { method: 'POST', route: 'schema/validate', permission: 'SPA.SCHEMA.MANAGE', status: 200,
    body: async f => ({ draftVersion: (await f.schemas.draft(f.actor, f.type.id)).version }),
    verify: async (_f, data) => { expect(data).toEqual({ valid: true, issues: [] }); } },
  { method: 'POST', route: 'schema/publish', permission: 'SPA.SCHEMA.PUBLISH', status: 200,
    body: async f => ({ expectedDraftVersion: (await f.schemas.draft(f.actor, f.type.id)).version }),
    verify: async (f, data) => { expect(data.versionNumber).toBe(2); expect((await f.types.get(f.actor, f.type.id)).schemaVersion).toBe(2); } },
  { method: 'GET', route: 'schema/versions', permission: 'SPA.SCHEMA.READ', status: 200, body: empty,
    verify: async (_f, data) => { expect(data).toEqual([expect.objectContaining({ versionNumber: 1 })]); } },
  { method: 'POST', route: 'schema/migrations', permission: 'SPA.SCHEMA.MANAGE', status: 202,
    body: async f => ({ fieldId: f.field.id, targetType: 'INTEGER', mappingStrategy: 'STRICT' }),
    verify: async (f, data) => { expect(data.status).toBe('QUEUED');
      expect(await db.spaSchemaMigrationJob.findUnique({ where: { id: data.jobId } })).toMatchObject({ typeId: f.type.id, status: 'QUEUED' }); } },
  { method: 'POST', route: 'unique-constraints', permission: 'SPA.SCHEMA.MANAGE', status: 201,
    body: async () => ({ name: 'Unique value', fieldCodes: ['VALUE'] }),
    verify: async (f, data) => { expect(data.fieldCodes).toEqual(['VALUE']);
      expect((await f.schemas.draft(f.actor, f.type.id)).snapshot.uniqueConstraints[0].id).toBe(data.id); } },
];

for (const transport of ['Nest', 'Next'] as const) describe('SPA schema REST E2E: ' + transport, () => {
  for (const operation of cases) it(operation.method + ' /api/v1/spa/types/:typeId/' + operation.route +
    ' verifies response, permission/token, tenant scope, DB effect and outbox', async () => {
    const f = await spaFixture(db), input = await operation.body(f), token = await sign(f.user.id);
    const tail = operation.route.replace(':fieldId', f.field.id);
    const path = '/api/v1/spa/types/' + f.type.id + '/' + tail;
    async function call(url: string, authToken?: string, workspaceId = f.workspace.id, body = input) {
      const headers = { 'x-workspace-id': workspaceId, ...(authToken ? { authorization: 'Bearer ' + authToken } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      const init = { method: operation.method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const result = transport === 'Nest' ? await fetch(base + url, init) : await router.dispatch(new request('http://test.local' + url, init));
      return { status: result.status, body: await result.json() };
    }
    expect((await call(path)).status).toBe(401);
    const grant = await db.permission.findUniqueOrThrow({ where: { key: operation.permission } });
    const roleGrant = { roleId_permissionId: { roleId: f.role.id, permissionId: grant.id } };
    await db.rolePermission.update({ where: roleGrant, data: { isDeleted: true } });
    expect((await call(path, token)).status).toBe(403);
    await db.rolePermission.update({ where: roleGrant, data: { isDeleted: false } });
    const foreign = await spaFixture(db), foreignToken = await sign(foreign.user.id);
    expect((await call(path, foreignToken, foreign.workspace.id)).status).toBe(404);
    expect((await call(path.replace(f.type.id, 'invalid-uuid'), token)).status).toBe(400);
    const outboxBefore = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
    const auditBefore = await db.auditLog.count({ where: { workspaceId: f.workspace.id } });
    if (operation.method !== 'GET') expect((await call(path, token, f.workspace.id, { ...input as object, workspaceId: foreign.workspace.id })).status).toBe(400);
    const result = await call(path, token); expect(result.status).toBe(operation.status); expect(result.body.success).toBe(true);
    await operation.verify(f, result.body.data);
    const mutates = operation.method !== 'GET' && operation.route !== 'schema/validate';
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(outboxBefore + (mutates ? operation.route.endsWith('/deactivate') ? 2 : 1 : 0));
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(auditBefore + (mutates ? operation.route.endsWith('/deactivate') ? 2 : 1 : 0));
    if (['schema/draft', 'schema/publish', 'fields/:fieldId/deactivate'].includes(operation.route) && operation.method !== 'GET')
      expect((await call(path, token)).status).toBe(409);
  });
});
