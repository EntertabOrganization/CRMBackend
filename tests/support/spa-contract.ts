import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './process-platform-db';
import { spaFixture } from './spa-fixture';
import { resolvePrincipal } from '../../src/server/process-platform/context';
import { SpaPolicyService } from '../../src/server/spa/policy-service';
import { SpaPipelineService } from '../../src/server/spa/pipeline-service';

/** Each suite recreates this owned database; each case gets a separate Workspace. */
export function spaContractDatabase() {
  let db: PrismaClient;
  beforeAll(async () => {
    const url = await prepareProcessPlatformDatabase('truecrm_spa_schema_test');
    db = new PrismaClient({ datasources: { db: { url } } });
  }, 300000);
  afterAll(async () => { await db?.$disconnect(); });
  jest.setTimeout(120000);
  return () => db;
}
export async function contractFixture(db: PrismaClient) {
  const f = await spaFixture(db);
  const policies = new SpaPolicyService(db), pipelines = new SpaPipelineService(db);
  const matrix = async (changes: Record<string, unknown>) => {
    const m = await policies.matrix(f.actor, f.type.id);
    return policies.replace(f.actor, f.type.id, { expectedVersion: m.version, rolePolicies: m.rolePolicies.map(p => ({ roleId: p.roleId, action: p.action, scope: p.scope })),
      stagePolicies: m.stagePolicies.map(p => ({ roleId: p.roleId, action: p.action, scope: p.scope, pipelineId: p.pipelineId, stageId: p.stageId })),
      fieldPolicies: m.fieldPolicies.map(p => ({ fieldId: p.fieldId, subjectType: p.subjectType, subjectId: p.subjectId, canView: p.canView, canEdit: p.canEdit })), ...changes });
  };
  const member = async (scopes: Record<string, string> = {}) => {
    const user = await db.user.create({ data: { firstName: 'Second', lastName: 'Member', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
    const role = await db.role.create({ data: { workspaceId: f.workspace.id, name: 'Scoped member' } });
    await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: user.id, roleId: role.id } });
    await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(p => ({ roleId: role.id, permissionId: p.id,
      scope: (scopes[p.key] ?? 'WORKSPACE') as 'WORKSPACE' })) });
    return { user, role, actor: await resolvePrincipal(db, f.workspace.id, user.id) };
  };
  const pipeline = async () => {
    const p = await pipelines.create(f.actor, f.type.id, { code: 'MAIN', name: 'Main' });
    for (const key of ['PIPELINES', 'KANBAN']) {
      const t = await f.types.get(f.actor, f.type.id);
      await f.types.setCapability(f.actor, f.type.id, key, { expectedVersion: t.version, enabled: true, configuration: {} });
    }
    await f.publish();
    const stages = await pipelines.stages(f.actor, f.type.id, p.id);
    return { p, stages, start: stages.find(s => s.isDefault)!, success: stages.find(s => s.semantic === 'SUCCESS')! };
  };
  const hide = () => matrix({ fieldPolicies: [{ fieldId: f.field.id, subjectType: 'ROLE', subjectId: f.role.id, canView: false, canEdit: false }] });
  return { ...f, policies, pipelines, matrix, member, pipeline, hide };
}
