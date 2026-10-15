import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { prepareProcessPlatformDatabase } from './process-platform-db';
import { resetRateLimits } from '../../src/server/rate-limit';
import type { WorkflowFixture } from './workflow-contract';

export type HttpScenario = {
  /** Permission key(s) whose revocation must turn the request into 403. */
  permission: string | string[];
  ids: Record<string, string>;
  body?: unknown;
  query?: string;
  /** Mutations must emit outbox evidence unless the operation is a read-only validation/dry run. */
  effects?: boolean;
  verify: (data: any, json: any) => Promise<void>;
};
export type ScenarioBuilder = (f: WorkflowFixture, db: PrismaClient) => Promise<HttpScenario>;
export type PublicScenario = { public: true; run: (call: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>, f: WorkflowFixture, db: PrismaClient) => Promise<void> };

/** Real protected HTTP contracts for the Workflow router through both the Nest adapter and Next dispatch. */
export function workflowHttpContract(database: string, scenarios: Record<string, ScenarioBuilder | PublicScenario>) {
  let db: PrismaClient, app: INestApplication, base: string;
  let router: typeof import('../../src/server/workflows/routes').workflowRouter;
  let NextRequest: typeof import('next/server').NextRequest;
  let sign: typeof import('../../src/server/security').signAccessToken;
  let fixture: typeof import('./workflow-contract').workflowFixture;
  beforeAll(async () => {
    const url = await prepareProcessPlatformDatabase(database);
    fixture = (await import('./workflow-contract')).workflowFixture;
    router = (await import('../../src/server/workflows/routes')).workflowRouter;
    NextRequest = (await import('next/server')).NextRequest;
    sign = (await import('../../src/server/security')).signAccessToken;
    const { Module } = await import('@nestjs/common'), { NestFactory } = await import('@nestjs/core');
    const { nestControllers, configurePackBodyParsing } = await import('../../src/server/process-platform/nest-adapter');
    class WorkflowContractHttpModule {}
    Module({ controllers: nestControllers(router) })(WorkflowContractHttpModule);
    app = await NestFactory.create(WorkflowContractHttpModule, { logger: false, bodyParser: false });
    configurePackBodyParsing(app as never); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const { prisma } = await import('../../src/server/prisma-client');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toBe(new URL(url).pathname.slice(1));
    db = prisma;
  }, 300000);
  afterAll(async () => { await app?.close(); const { prisma } = await import('../../src/server/prisma-client'); await prisma.$disconnect(); });
  beforeEach(() => resetRateLimits());
  jest.setTimeout(300000);
  const fill = (pattern: string, ids: Record<string, string>) => pattern.replace(/:(\w+)/g, (_, key: string) => { if (!ids[key]) throw new Error('Missing fixture ' + key); return ids[key]; });
  return async (operation: string) => {
    const [method, pattern] = operation.split(' ');
    const entry = router.entries.find(e => e.method === method && e.path === pattern);
    expect(entry).toBeDefined();
    const scenario = scenarios[operation];
    if (!scenario) throw new Error('No real fixture for ' + operation);
    for (const transport of ['Nest', 'Next'] as const) {
      resetRateLimits();
      const f = await fixture(db);
      const send = async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
        const result = transport === 'Nest' ? await fetch(base + path, init) : await router.dispatch(new NextRequest('http://test.local' + path, init));
        return { status: result.status, json: await result.json() };
      };
      if ('public' in scenario) {
        await scenario.run((path, body, headers = {}) => send(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), f, db);
        continue;
      }
      const s = await scenario(f, db), token = await sign(f.user.id), key = randomUUID();
      const path = fill(pattern, s.ids) + (s.query ?? '');
      const call = (target: string, auth?: string, workspaceId = f.workspace.id, input = s.body) => send(target, { method, headers: { 'x-workspace-id': workspaceId, 'idempotency-key': key,
        ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      const outbox = () => db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
      const before = await outbox();
      expect((await call(path)).status).toBe(401);
      expect((await call(path, 'invalid')).status).toBe(401);
      const keys = Array.isArray(s.permission) ? s.permission : [s.permission];
      const grants = await db.rolePermission.findMany({ where: { roleId: f.role.id, permission: { key: { in: keys } } } });
      expect(grants).toHaveLength(keys.length);
      await db.rolePermission.updateMany({ where: { id: { in: grants.map(g => g.id) } }, data: { isDeleted: true } });
      expect([operation, (await call(path, token)).status]).toEqual([operation, 403]);
      await db.rolePermission.updateMany({ where: { id: { in: grants.map(g => g.id) } }, data: { isDeleted: false } });
      const foreign = await fixture(db);
      expect((await call(path, token, foreign.workspace.id)).status).toBe(403);
      const params = [...pattern.matchAll(/:(\w+)/g)].map(m => m[1]);
      if (params.length) {
        // Valid IDs owned by another Workspace never disclose that Workspace's resources.
        const other = await scenario(foreign, db);
        for (const param of params.filter(name => other.ids[name] !== s.ids[name])) {
          const crossed = fill(pattern, { ...s.ids, [param]: other.ids[param] }) + (s.query ?? '');
          expect([operation, param, (await call(crossed, token)).status]).toEqual([operation, param, 404]);
        }
      }
      if (method !== 'GET') expect((await call(path, token, f.workspace.id, { ...(s.body as object ?? {}), workspaceId: foreign.workspace.id })).status).toBe(400);
      expect(await outbox()).toBe(before);
      const response = await call(path, token);
      expect([operation, transport, response.status, response.json.error ?? null]).toEqual([operation, transport, entry!.status, null]);
      expect(response.json.success).toBe(true);
      await s.verify(response.json.data, response.json);
      if (s.effects ?? method !== 'GET') expect(await outbox()).toBeGreaterThan(before);
      else expect(await outbox()).toBe(before);
    }
  };
}
