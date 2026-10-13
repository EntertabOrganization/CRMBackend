import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';
import { spaFixture } from './support/spa-fixture';
import { resolvePrincipal } from '../src/server/process-platform/context';
import { SpaPolicyService } from '../src/server/spa/policy-service';
import { SpaRelationService } from '../src/server/spa/relation-service';
import { SpaPipelineService } from '../src/server/spa/pipeline-service';
import { workflowActions } from '../src/server/workflows/action-registry';

jest.setTimeout(120000); let db: PrismaClient;
beforeAll(async () => { const url = await prepareProcessPlatformDatabase('truecrm_spa_team_test');
  db = new PrismaClient({ datasources: { db: { url } } }); }, 300000);
afterAll(async () => { await db?.$disconnect(); });
async function fixture() {
  const f = await spaFixture(db), item = await f.create('Team case'), now = new Date();
  const reader = await db.user.create({ data: { firstName: 'Team', lastName: 'Reader', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
  const role = await db.role.create({ data: { workspaceId: f.workspace.id, name: 'Team role' } });
  await db.workspaceMembership.create({ data: { workspaceId: f.workspace.id, userId: reader.id, roleId: role.id } });
  const permissions = await db.permission.findMany({ where: { key: { in: ['SPA.ITEM.READ', 'SPA.ITEM.UPDATE'] } } });
  await db.rolePermission.createMany({ data: permissions.map(permission => ({ roleId: role.id, permissionId: permission.id, scope: 'WORKSPACE' as const })) });
  const project = await db.project.create({ data: { id: randomUUID(), workspaceId: f.workspace.id, name: 'Private team',
    projectType: 'WORKGROUP', status: 'ACTIVE', ownerUserId: f.user.id, visibility: 'PRIVATE', createdByUserId: f.user.id,
    createdAt: now, updatedAt: now } });
  const membership = await db.projectMember.create({ data: { id: randomUUID(), workspaceId: f.workspace.id,
    projectId: project.id, userId: reader.id, memberRole: 'MEMBER', status: 'ACTIVE', joinedAt: now, createdAt: now, updatedAt: now } });
  const relations = new SpaRelationService(db), definition = await relations.addDefinition(f.actor, f.type.id,
    { code: 'TEAM_PROJECT', name: 'Team project', targetType: 'PROJECT', cardinality: 'MANY' });
  await f.publish();
  const binding = await relations.link(f.actor, f.type.id, item.id, { definitionId: definition.id, targetType: 'PROJECT', targetId: project.id });
  const policies = new SpaPolicyService(db);
  await policies.replace(f.actor, f.type.id, { expectedVersion: 1, rolePolicies: ['SPA.ITEM.READ', 'SPA.ITEM.UPDATE'].map(action =>
    ({ roleId: role.id, action, scope: 'TEAM' })), stagePolicies: [], fieldPolicies: [] });
  const actor = await resolvePrincipal(db, f.workspace.id, reader.id);
  return { ...f, item, reader, readerRole: role, project, membership, relations, definition, binding, policies, readerActor: actor };
}
describe('SPA TEAM scopes use the confirmed linked project/workgroup membership', () => {
  it('enforces Stage TEAM policy and uses the owning Workflow stage adapter DTO', async () => {
    const f = await fixture(), pipelines = new SpaPipelineService(db);
    const pipeline = await pipelines.create(f.actor, f.type.id, { code: 'TEAM_PIPELINE', name: 'Team pipeline' });
    const stage = await pipelines.createStage(f.actor, f.type.id, pipeline.id, { code: 'OPEN', name: 'Open', semantic: 'PROGRESS', sortOrder: 0, isDefault: true });
    await f.types.setCapability(f.actor, f.type.id, 'PIPELINES', { expectedVersion: (await f.types.get(f.actor, f.type.id)).version,
      enabled: true, configuration: {} }); await f.publish();
    const before = await db.spaItem.findUniqueOrThrow({ where: { id: f.item.id } });
    await db.$transaction(tx => workflowActions(db).execute(tx, f.actor, 'SPA.CHANGE_STAGE', { typeId: f.type.id, itemId: f.item.id,
      expectedVersion: before.version, pipelineId: pipeline.id, stageId: stage.id }, randomUUID()), { timeout: 30000 });
    expect(await db.spaItem.findUnique({ where: { id: f.item.id } })).toMatchObject({ pipelineId: pipeline.id, stageId: stage.id });
    await f.policies.replace(f.actor, f.type.id, { expectedVersion: 2, rolePolicies: [{ roleId: f.readerRole.id, action: 'SPA.ITEM.READ', scope: 'ALL' }],
      stagePolicies: [{ roleId: f.readerRole.id, action: 'SPA.ITEM.READ', scope: 'TEAM', pipelineId: pipeline.id, stageId: stage.id }], fieldPolicies: [] });
    expect((await f.items.get(f.readerActor, f.type.id, f.item.id)).id).toBe(f.item.id);
    await db.projectMember.update({ where: { id: f.membership.id }, data: { status: 'REMOVED', version: { increment: 1 } } });
    await expect(f.items.get(f.readerActor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('enforces current Workspace entitlements across item, schema and type APIs', async () => {
    const f = await fixture(); await db.workspace.update({ where: { id: f.workspace.id }, data: { settings: { entitlements: { spa: false } } } });
    const actor = await resolvePrincipal(db, f.workspace.id, f.user.id);
    for (const run of [() => f.types.get(actor, f.type.id), () => f.schemas.fields(actor, f.type.id),
      () => f.items.get(actor, f.type.id, f.item.id), () => f.policies.matrix(actor, f.type.id)])
      await expect(run()).rejects.toMatchObject({ code: 'SPA_PLAN_LIMIT', status: 403 });
    await db.workspace.update({ where: { id: f.workspace.id }, data: { settings: { entitlements: { spa: true } } } });
    expect((await f.items.get(await resolvePrincipal(db, f.workspace.id, f.reader.id), f.type.id, f.item.id)).id).toBe(f.item.id);
  });
  it('allows an active member to read and update, including a private Workgroup with no project discovery grant', async () => {
    const f = await fixture(); expect(f.readerActor.grants.has('project.read')).toBe(false);
    expect((await f.items.get(f.readerActor, f.type.id, f.item.id)).id).toBe(f.item.id);
    const current = await db.spaItem.findUniqueOrThrow({ where: { id: f.item.id } });
    await f.items.update(f.readerActor, f.type.id, f.item.id, { expectedVersion: current.version, title: 'Team edit' });
    expect((await db.spaItem.findUniqueOrThrow({ where: { id: f.item.id } })).title).toBe('Team edit');
    for (const status of ['PLANNED', 'ON_HOLD', 'COMPLETED'] as const) {
      await db.project.update({ where: { id: f.project.id }, data: { status, version: { increment: 1 } } });
      expect((await f.items.get(f.readerActor, f.type.id, f.item.id)).id).toBe(f.item.id);
    }
  });
  it('revokes access immediately when membership, project lifecycle or the published binding changes', async () => {
    const f = await fixture();
    await db.projectMember.update({ where: { id: f.membership.id }, data: { status: 'REMOVED', version: { increment: 1 } } });
    await expect(f.items.get(f.readerActor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await db.projectMember.update({ where: { id: f.membership.id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
    await db.project.update({ where: { id: f.project.id }, data: { status: 'ARCHIVED', version: { increment: 1 } } });
    await expect(f.items.get(f.readerActor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await db.project.update({ where: { id: f.project.id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
    await f.relations.unlink(f.actor, f.type.id, f.item.id, f.binding.id);
    await expect(f.items.get(f.readerActor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('does not convert public project visibility or observer status into TEAM membership', async () => {
    const f = await fixture(); await db.projectMember.update({ where: { id: f.membership.id }, data: { status: 'REMOVED', version: { increment: 1 } } });
    await db.project.update({ where: { id: f.project.id }, data: { visibility: 'OPEN', version: { increment: 1 } } });
    await db.spaItemObserver.create({ data: { workspaceId: f.workspace.id, itemId: f.item.id, userId: f.reader.id } });
    await expect(f.items.get(f.readerActor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('intersects TEAM with current OWN grants instead of broadening Workspace permission', async () => {
    const f = await fixture(), permission = await db.permission.findUniqueOrThrow({ where: { key: 'SPA.ITEM.READ' } });
    await db.rolePermission.update({ where: { roleId_permissionId: { roleId: f.readerRole.id, permissionId: permission.id } }, data: { scope: 'OWN' } });
    const actor = await resolvePrincipal(db, f.workspace.id, f.reader.id);
    await expect(f.items.get(actor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await db.spaItem.update({ where: { id: f.item.id }, data: { assignedUserId: f.reader.id } });
    expect((await f.items.get(actor, f.type.id, f.item.id)).id).toBe(f.item.id);
  });
  it('uses the owning implicit Project owner rule and rejects unlinked/foreign Projects', async () => {
    const f = await fixture();
    await f.policies.replace(f.actor, f.type.id, { expectedVersion: 2, rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.READ', scope: 'TEAM' }],
      stagePolicies: [], fieldPolicies: [] });
    expect((await f.items.get(f.actor, f.type.id, f.item.id)).id).toBe(f.item.id);
    const foreign = await fixture();
    await expect(f.relations.link(f.actor, f.type.id, f.item.id, { definitionId: f.definition.id, targetType: 'PROJECT', targetId: foreign.project.id }))
      .rejects.toMatchObject({ code: 'SPA_RELATION_TARGET_INVALID' });
    await f.relations.unlink(f.actor, f.type.id, f.item.id, f.binding.id);
    await expect(f.items.get(f.actor, f.type.id, f.item.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
