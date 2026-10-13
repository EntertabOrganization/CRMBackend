import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { resolvePrincipal } from '../../src/server/process-platform/context';
import { SpaTypeService } from '../../src/server/spa/type-service';
import { SpaSchemaService } from '../../src/server/spa/schema-service';
import { SpaItemService } from '../../src/server/spa/item-service';

export async function spaFixture(db: PrismaClient, fieldType: 'TEXT' | 'INTEGER' = 'TEXT') {
  const user = await db.user.create({ data: { firstName: 'Schema', lastName: 'Owner', email: randomUUID() + '@example.test', status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Schema tests', slug: randomUUID(), ownerUserId: user.id } });
  const role = await db.role.create({ data: { workspaceId: workspace.id, name: 'Schema manager' } });
  await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: user.id, roleId: role.id } });
  await db.rolePermission.createMany({ data: (await db.permission.findMany()).map(permission => ({ roleId: role.id,
    permissionId: permission.id, scope: 'WORKSPACE' as const })) });
  const actor = await resolvePrincipal(db, workspace.id, user.id);
  const types = new SpaTypeService(db), schemas = new SpaSchemaService(db), items = new SpaItemService(db);
  const type = await types.create(actor, { code: 'SCHEMA_CASES', name: 'Case', pluralName: 'Cases', placement: 'CRM' });
  const field = await schemas.addField(actor, type.id, { code: 'VALUE', name: 'Value', fieldType });
  const publish = async (migrationPlanId?: string) => schemas.publish(actor, type.id,
    { expectedDraftVersion: (await schemas.draft(actor, type.id)).version, ...(migrationPlanId ? { migrationPlanId } : {}) });
  await publish();
  const current = await types.get(actor, type.id);
  await types.transition(actor, type.id, 'activate', { expectedVersion: current.version });
  const create = (value: unknown) => items.create(actor, type.id, { title: 'Case', assignedUserId: user.id,
    fieldValues: { VALUE: value } }, randomUUID());
  return { user, workspace, role, actor, types, schemas, items, type, field, publish, create };
}
