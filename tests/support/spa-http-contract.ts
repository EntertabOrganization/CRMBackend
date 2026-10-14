import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { prepareProcessPlatformDatabase } from './process-platform-db';

/** Real protected HTTP contracts against both adapters and an owned migrated database. */
export function spaHttpContract() {
  let db: PrismaClient, app: INestApplication, base: string;
  let router: typeof import('../../src/server/spa/routes').spaRouter;
  let NextRequest: typeof import('next/server').NextRequest;
  let sign: typeof import('../../src/server/security').signAccessToken;
  let fixture: typeof import('./spa-contract').contractFixture;
  beforeAll(async () => {
    const url = await prepareProcessPlatformDatabase('truecrm_spa_schema_http_test');
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$connect();
    fixture = (await import('./spa-contract')).contractFixture;
    router = (await import('../../src/server/spa/routes')).spaRouter;
    NextRequest = (await import('next/server')).NextRequest;
    sign = (await import('../../src/server/security')).signAccessToken;
    const { Module } = await import('@nestjs/common'), { NestFactory } = await import('@nestjs/core');
    const { nestControllers, configurePackBodyParsing } = await import('../../src/server/process-platform/nest-adapter');
    class ContractHttpModule {}
    Module({ controllers: nestControllers(router) })(ContractHttpModule);
    app = await NestFactory.create(ContractHttpModule, { logger: false, bodyParser: false });
    configurePackBodyParsing(app as never); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const { prisma } = await import('../../src/server/prisma-client');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toBe('truecrm_spa_schema_http_test');
    await db.$disconnect(); db = prisma;
  }, 300000);
  afterAll(async () => { await app?.close(); await db?.$disconnect();
    const { prisma } = await import('../../src/server/prisma-client'); await prisma.$disconnect(); });
  jest.setTimeout(120000);
  return async (operation: string) => {
    const [method, pattern] = operation.split(' ');
    for (const transport of ['Nest', 'Next'] as const) {
      const f = await fixture(db), token = await sign(f.user.id);
      const ids: Record<string, string> = { typeId: f.type.id, key: 'TASKS', fieldId: f.field.id };
      let body: unknown = method === 'GET' ? undefined : {}, permission = '', query = '';
      let verify: (data: any) => Promise<void>;
      const typeVersion = async () => (await f.types.get(f.actor, f.type.id)).version;
      const item = await f.create('Original'); ids.itemId = item.id;
      const tail = pattern.replace('/api/v1/spa/types', '');
      if (!tail || /^\/:typeId(?:\/(activate|archive|restore|capabilities(?:\/:key)?))?$/.test(tail)) {
        permission = method === 'GET' ? 'SPA.TYPE.READ' : 'SPA.TYPE.MANAGE';
        if (method === 'POST' && !tail) body = { code: 'HTTP_CASE', name: 'HTTP case', pluralName: 'HTTP cases', placement: 'CRM' };
        if (method === 'PATCH') body = { expectedVersion: await typeVersion(), name: 'Renamed' };
        if (/activate$/.test(tail)) await db.spaEntityType.update({ where: { id: f.type.id }, data: { status: 'DRAFT' } });
        if (/restore$/.test(tail)) await f.types.transition(f.actor, f.type.id, 'archive', { expectedVersion: await typeVersion() });
        if (/activate|archive|restore/.test(tail)) body = { expectedVersion: await typeVersion() };
        if (/capabilities\/:key$/.test(tail)) body = { expectedVersion: await typeVersion(), enabled: true, configuration: {} };
        verify = async data => {
          if (method === 'GET') {
            if (!tail) expect(data.map((r: any) => r.id)).toEqual([f.type.id]);
            else if (tail.endsWith('capabilities')) expect(data).toHaveLength(13);
            else expect(data).toMatchObject({ id: f.type.id, status: 'ACTIVE' });
          } else if (tail.endsWith(':key')) {
            expect(data.publicationRequired).toBe(true); expect((await f.schemas.draft(f.actor, f.type.id)).snapshot.capabilities?.find(c => c.key === 'TASKS')?.enabled).toBe(true);
          } else {
            const row = await db.spaEntityType.findUniqueOrThrow({ where: { id: data.id } });
            expect(data.version).toBe(row.version); expect(data.status).toBe(row.status);
            if (method === 'PATCH') expect(row.name).toBe('Renamed');
            else expect(row.status).toBe(tail.endsWith('archive') ? 'ARCHIVED' : !tail ? 'DRAFT' : 'ACTIVE');
          }
        };
      } else if (tail.includes('/permissions')) {
        permission = tail.endsWith('/me') ? 'SPA.ITEM.READ' : 'SPA.PERMISSION.MANAGE';
        if (method === 'PUT') body = { expectedVersion: 1, rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.UPDATE', scope: 'NONE' }], stagePolicies: [], fieldPolicies: [] };
        if (tail.endsWith('/history')) await f.matrix({ rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.UPDATE', scope: 'NONE' }] });
        verify = async data => {
          if (tail.endsWith('/me')) { expect(data.actions).toContain('SPA.ITEM.READ'); expect(data.visibleFields).toEqual(['VALUE']); }
          else if (tail.endsWith('/history')) expect(data[0].action).toBe('SPA_PERMISSION_CHANGED');
          else if (method === 'PUT') { expect(data.version).toBe(2); await expect(f.items.update(f.actor, f.type.id, item.id, { expectedVersion: item.version, title: 'Denied' })).rejects.toMatchObject({ status: 403 }); }
          else expect(data).toMatchObject({ version: 1, rolePolicies: [], stagePolicies: [], fieldPolicies: [] });
        };
      } else if (tail.includes('/pipelines') || tail.endsWith('/kanban') || tail.endsWith('/transition')) {
        const p = await f.pipeline(); ids.pipelineId = p.p.id; ids.stageId = p.start.id;
        const bound = await f.create('Pipeline'); ids.itemId = bound.id;
        permission = tail.endsWith('/transition') ? 'SPA.ITEM.STAGE_CHANGE' : tail.endsWith('/kanban') ? 'SPA.ITEM.READ'
          : tail.includes('/stages') ? method === 'GET' ? 'SPA.PIPELINE.READ' : 'SPA.STAGE.MANAGE'
          : method === 'GET' ? 'SPA.PIPELINE.READ' : 'SPA.PIPELINE.MANAGE';
        if (tail.endsWith('/kanban')) query = '?pipelineId=' + p.p.id;
        if (method === 'POST' && tail.endsWith('/pipelines')) body = { code: 'SECOND', name: 'Second' };
        if (method === 'PATCH') body = { expectedVersion: 1, name: 'Renamed' };
        if (method === 'POST' && tail.endsWith('/stages')) body = { code: 'REVIEW', name: 'Review', semantic: 'PROGRESS', sortOrder: 4 };
        if (tail.endsWith('/archive')) {
          const other = await f.pipelines.create(f.actor, f.type.id, { code: 'SURVIVOR', name: 'Survivor' });
          const target = tail.includes('/stages') ? await f.pipelines.createStage(f.actor, f.type.id, p.p.id, { code: 'SURVIVOR', name: 'Survivor', semantic: 'PROGRESS', sortOrder: 4 })
            : (await f.pipelines.stages(f.actor, f.type.id, other.id)).find(s => s.isDefault)!;
          body = { ...(tail.includes('/stages') ? {} : { expectedVersion: 1 }), migrationTarget: { pipelineId: target.pipelineId, stageId: target.id } };
        }
        if (tail.endsWith('/transition')) body = { expectedVersion: bound.version, targetPipelineId: p.p.id, targetStageId: p.success.id };
        verify = async data => {
          if (tail.endsWith('/kanban')) expect(data.columns.flatMap((c: any) => c.items).map((i: any) => i.id)).toContain(bound.id);
          else if (tail.endsWith('/transition')) expect(await db.spaItem.findUnique({ where: { id: bound.id } })).toMatchObject({ status: 'COMPLETED', stageId: p.success.id, version: 2 });
          else if (method === 'GET') expect(data.map((r: any) => r.id)).toContain(tail.includes('/stages') ? p.start.id : p.p.id);
          else {
            const row = tail.includes('/stages') ? await db.spaStage.findUniqueOrThrow({ where: { id: data.id } }) : await db.spaPipeline.findUniqueOrThrow({ where: { id: data.id } });
            expect(data.id).toBe(row.id); expect(row.name).toBe(method === 'PATCH' ? 'Renamed' : tail.endsWith('/archive') ? tail.includes('/stages') ? 'New' : 'Main' : tail.includes('/stages') ? 'Review' : 'Second');
            if (tail.endsWith('/archive')) expect(row.status).toBe('ARCHIVED');
          }
        };
      } else if (tail.includes('/numbering') || tail.includes('/recurrence')) {
        permission = tail.includes('/numbering') ? method === 'GET' ? 'SPA.TYPE.READ' : 'SPA.TYPE.MANAGE' : method === 'GET' ? 'SPA.RECURRENCE.READ' : 'SPA.RECURRENCE.MANAGE';
        if (tail.includes('/numbering')) {
          if (method === 'PUT') body = { expectedVersion: 1, prefixTemplate: 'HTTP-', padding: 6, resetPolicy: 'NEVER' };
          verify = async data => { expect(data.typeId).toBe(f.type.id); expect((await db.spaNumberingScheme.findFirstOrThrow({ where: { typeId: f.type.id } })).prefixTemplate).toBe(method === 'PUT' ? 'HTTP-' : 'SCHEMA_CASES-'); };
        } else {
          const { SpaRecurrenceService } = await import('../../src/server/spa/recurrence-service'), service = new SpaRecurrenceService(db);
          await f.types.setCapability(f.actor, f.type.id, 'RECURRENCE', { expectedVersion: await typeVersion(), enabled: true, configuration: {} }); await f.publish();
          const input = { frequency: 'DAILY', timezone: 'UTC', interval: 1, startsAt: '2035-01-01T00:00:00Z', templatePayload: { title: 'Scheduled', assignedUserId: f.user.id, fieldValues: { VALUE: 'Future' } } };
          const rule = await service.create(f.actor, f.type.id, input); ids.ruleId = rule.id;
          if (method === 'POST' && tail.endsWith('/recurrence')) body = input;
          if (method === 'PATCH') body = { expectedVersion: rule.version, rule: { interval: 2 } };
          if (tail.endsWith('/resume')) await service.pause(f.actor, f.type.id, rule.id);
          if (tail.endsWith('/instances')) await service.runDue(100, new Date('2035-01-01T00:01:00Z'));
          verify = async data => {
            if (tail.endsWith('/instances')) { expect(data).toHaveLength(1); expect(data[0].ruleId).toBe(rule.id); expect(await db.spaItem.count({ where: { id: data[0].itemId } })).toBe(1); }
            else if (method === 'GET') expect(data.map((r: any) => r.id)).toEqual([rule.id]);
            else { const row = await db.spaRecurrenceRule.findUniqueOrThrow({ where: { id: data.id } }); expect(row.typeId).toBe(f.type.id); expect(row.isActive).toBe(!tail.endsWith('/pause')); if (method === 'PATCH') expect(row.interval).toBe(2); }
          };
        }
      } else if (tail.includes('/relations') || tail.includes('/relation-definitions') || tail.includes('/layouts') || tail.includes('/views')) {
        const { SpaRelationService } = await import('../../src/server/spa/relation-service'), r = new SpaRelationService(db);
        permission = tail.includes('/layouts') || tail.includes('/relation-definitions') ? method === 'GET' ? 'SPA.SCHEMA.READ' : 'SPA.SCHEMA.MANAGE' : method === 'GET' || tail.includes('/views') ? 'SPA.ITEM.READ' : 'SPA.ITEM.UPDATE';
        const input = { code: 'RELATED', name: 'Related', targetType: 'SPA_ITEM', targetSubtypeId: f.type.id, cardinality: 'MANY' };
        const definition = await r.addDefinition(f.actor, f.type.id, input); await f.publish();
        const target = await f.create('Target'); const row = await r.link(f.actor, f.type.id, item.id, { definitionId: definition.id, targetType: 'SPA_ITEM', targetId: target.id }); ids.relationId = row.id;
        const layout = (await r.layouts(f.actor, f.type.id, {}))[0]; ids.layoutId = layout.id;
        if (method === 'POST' && tail.endsWith('/relation-definitions')) body = { ...input, code: 'OTHER' };
        if (method === 'POST' && tail.endsWith('/relations')) { const other = await f.create('Other'); body = { definitionId: definition.id, targetType: 'SPA_ITEM', targetId: other.id }; }
        if (method === 'PUT' && tail.includes('/layouts')) body = { expectedVersion: layout.version, sections: [{ id: randomUUID(), name: 'Details', fieldCodes: ['VALUE'] }] };
        const preference = { viewType: 'LIST', columns: ['title', 'VALUE'], filters: [], sort: { fieldCode: 'createdAt', direction: 'desc' } };
        if (tail.includes('/views')) { if (method === 'GET') await r.saveView(f.actor, f.type.id, preference); else body = preference; }
        verify = async data => {
          if (tail.includes('/views')) { const saved = await r.views(f.actor, f.type.id); expect(saved[0].userId).toBe(f.user.id); expect(saved[0].preferences.columns).toEqual(['title', 'VALUE']); expect(method === 'GET' ? data[0].id : data.id).toBe(saved[0].id); }
          else if (tail.includes('/layouts')) { const current = await r.layouts(f.actor, f.type.id, {}); expect(current[0].id).toBe(layout.id); if (method === 'PUT') expect(current[0].sections[0].fieldCodes).toEqual(['VALUE']); else expect(data[0].context).toBe('CREATE'); }
          else if (tail.includes('/relation-definitions')) expect((await r.definitions(f.actor, f.type.id)).map(d => d.code)).toContain(method === 'POST' ? 'OTHER' : 'RELATED');
          else if (method === 'DELETE') { expect(data.unlinked).toBe(true); expect(await db.spaItemRelation.count({ where: { id: row.id } })).toBe(0); expect(await db.spaItem.count({ where: { id: target.id } })).toBe(1); }
          else if (method === 'POST') expect(await db.spaItemRelation.findUnique({ where: { id: data.id } })).toMatchObject({ sourceItemId: item.id, targetId: (body as { targetId: string }).targetId });
          else expect(data.map((x: any) => x.id)).toEqual([row.id]);
        };
      } else if (tail.includes('/items')) {
        permission = method === 'GET' ? 'SPA.ITEM.READ' : tail.endsWith('/assign') ? 'SPA.ITEM.ASSIGN' : tail.includes('/observers') ? 'SPA.ITEM.MANAGE_OBSERVERS' : tail.endsWith('/restore') ? 'SPA.ITEM.RESTORE' : method === 'DELETE' ? 'SPA.ITEM.DELETE' : method === 'POST' ? 'SPA.ITEM.CREATE' : 'SPA.ITEM.UPDATE';
        const member = await f.member(); ids.userId = member.user.id;
        if (method === 'POST' && tail.endsWith('/items')) body = { title: 'HTTP item', assignedUserId: f.user.id, fieldValues: { VALUE: 'HTTP' } };
        if (method === 'PATCH' || method === 'PUT') body = tail.endsWith('/assign') ? { expectedVersion: item.version, responsibleUserId: member.user.id }
          : { expectedVersion: item.version, title: 'Updated', ...(method === 'PUT' ? { assignedUserId: f.user.id } : {}), fieldValues: { VALUE: 'Updated' } };
        if (tail.endsWith('/observers') && method === 'POST') body = { userId: member.user.id };
        if (tail.includes('/observers/:userId')) await f.items.observer(f.actor, f.type.id, item.id, { userId: member.user.id });
        if (tail.endsWith('/restore')) { const trashed = await f.items.lifecycle(f.actor, f.type.id, item.id, { expectedVersion: item.version }); body = { expectedVersion: trashed.version }; }
        else if (method === 'DELETE' && !tail.includes('/observers')) body = { expectedVersion: item.version };
        verify = async data => {
          if (tail.includes('/observers')) { expect(data.observing).toBe(method === 'POST'); expect(await db.spaItemObserver.count({ where: { itemId: item.id, userId: member.user.id } })).toBe(method === 'POST' ? 1 : 0); }
          else if (tail.endsWith('/history')) expect(data[0].action).toBe('SPA_ITEM_CREATED');
          else if (method === 'GET' && tail.endsWith('/items')) expect(data.map((i: any) => i.id)).toEqual([item.id]);
          else if (method === 'GET') expect(data).toMatchObject({ id: item.id, fieldValues: { VALUE: 'Original' } });
          else {
            const persisted = await db.spaItem.findUniqueOrThrow({ where: { id: data.id } });
            expect(data.version).toBe(persisted.version);
            if (method === 'DELETE') expect(persisted.status).toBe('TRASHED');
            else if (tail.endsWith('/restore')) expect(persisted.status).toBe('ACTIVE');
            else if (tail.endsWith('/assign')) expect(persisted.assignedUserId).toBe(member.user.id);
            else expect((await f.items.get(f.actor, f.type.id, persisted.id)).fieldValues.VALUE).toBe(method === 'POST' ? 'HTTP' : 'Updated');
          }
        };
      } else throw new Error('No real fixture for ' + operation);
      const path = pattern.replace(/:(\w+)/g, (_, key: string) => { if (!ids[key]) throw new Error('Missing fixture ' + key); return ids[key]; }) + query;
      const key = randomUUID();
      const call = async (path: string, auth?: string, workspaceId = f.workspace.id, input = body) => {
        const init = { method, headers: { 'x-workspace-id': workspaceId, 'idempotency-key': key, ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }) };
        const result = transport === 'Nest' ? await fetch(base + path, init) : await router.dispatch(new NextRequest('http://test.local' + path, init));
        return { status: result.status, json: await result.json() };
      };
      const before = await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } });
      expect((await call(path)).status).toBe(401);
      expect((await call(path, 'invalid')).status).toBe(401);
      const grant = await db.rolePermission.findFirstOrThrow({ where: { roleId: f.role.id, permission: { key: permission } } });
      await db.rolePermission.update({ where: { id: grant.id }, data: { isDeleted: true } });
      expect((await call(path, token)).status).toBe(403);
      await db.rolePermission.update({ where: { id: grant.id }, data: { isDeleted: false } });
      const foreign = await fixture(db);
      expect((await call(path, token, foreign.workspace.id)).status).toBe(403);
      if (pattern.includes(':typeId')) expect((await call(path.replace(f.type.id, foreign.type.id), token)).status).toBe(404);
      if (method !== 'GET') expect((await call(path, token, f.workspace.id, { ...(body as object), workspaceId: foreign.workspace.id })).status).toBe(400);
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before);
      const response = await call(path, token);
      expect(response.status).toBe(router.entries.find(e => e.method === method && e.path === pattern)!.status);
      expect(response.json.success).toBe(true); await verify!(response.json.data);
      if (method === 'GET') expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(before);
      if (method !== 'GET') {
        expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(before);
        expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(0);
      }
    }
  };
}
