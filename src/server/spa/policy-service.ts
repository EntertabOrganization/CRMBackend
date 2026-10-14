import { Prisma, type PrismaClient, type SpaItem } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { pageQuery, parse, uuid, version } from '../process-platform/dto';
import permissions from '../process-platform/permission-catalog.json';
import { projectRoleFor } from '../collab/tasks/policy';
import { schemaSnapshot } from './field-metadata';

const actions = permissions.filter(key => key.startsWith('SPA.ITEM.'));
const action = z.string().refine(value => actions.includes(value), 'Unknown Item permission');
const scope = z.enum(['NONE', 'OWN', 'DEPARTMENT', 'DEPARTMENT_TREE', 'TEAM', 'ALL']);
const rolePolicy = z.strictObject({ roleId: uuid, action, scope });
const stagePolicy = rolePolicy.extend({ pipelineId: uuid, stageId: uuid });
const fieldPolicy = z.strictObject({ fieldId: uuid, subjectType: z.enum(['ROLE', 'USER']), subjectId: uuid,
  canView: z.boolean(), canEdit: z.boolean() }).refine(p => !p.canEdit || p.canView, 'Editable field must be visible');
export const replacement = z.strictObject({ expectedVersion: version, rolePolicies: z.array(rolePolicy).max(2000),
  stagePolicies: z.array(stagePolicy).max(10000), fieldPolicies: z.array(fieldPolicy).max(10000) });

/** Database policy reads deliberately avoid a process cache so revocation applies to the next command. */
export class SpaPolicyService {
  get database() { return this.db; }
  constructor(private readonly db: PrismaClient) {}
  private async type(tx: Tx, actor: Principal, typeId: string) {
    parse(uuid, typeId);
    const row = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
    if (!row) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    return row;
  }
  async matrix(actor: Principal, typeId: string) {
    requirePermission(actor, 'SPA.PERMISSION.MANAGE', true);
    return this.db.$transaction(async tx => {
      await this.type(tx, actor, typeId);
      const where = { workspaceId: actor.workspaceId, typeId };
      return { version: (await tx.spaPolicyVersion.findUnique({ where: { workspaceId_typeId: where } }))?.version ?? 1,
        rolePolicies: await tx.spaTypePolicy.findMany({ where }), stagePolicies: await tx.spaStagePolicy.findMany({ where }),
        fieldPolicies: await tx.spaFieldPolicy.findMany({ where }) };
    });
  }
  async replace(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.PERMISSION.MANAGE', true);
    const input = parse(replacement, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      await this.type(tx, actor, typeId);
      const where = { workspaceId: actor.workspaceId, typeId };
      const epoch = await tx.spaPolicyVersion.upsert({ where: { workspaceId_typeId: where }, create: where, update: {} });
      assertVersion(epoch.version, input.expectedVersion);
      const roleIds = [...new Set([...input.rolePolicies, ...input.stagePolicies].map(p => p.roleId)
        .concat(input.fieldPolicies.filter(p => p.subjectType === 'ROLE').map(p => p.subjectId)))];
      const roles = await tx.role.findMany({ where: { workspaceId: actor.workspaceId, id: { in: roleIds }, isDeleted: false },
        include: { rolePermissions: { where: { isDeleted: false }, include: { permission: true } } } });
      if (roles.length !== roleIds.length) throw new AppError('SPA_POLICY_CONFLICT', 'Policy subject is unavailable.', 422);
      for (const policy of [...input.rolePolicies, ...input.stagePolicies]) {
        const granted = roles.find(role => role.id === policy.roleId)?.rolePermissions.find(p => p.permission.key === policy.action && !p.permission.isDeleted);
        const maxScope = granted?.scope;
        const ranks: Record<string, number> = { NONE: 0, OWN: 1, DEPARTMENT: 2, DEPARTMENT_TREE: 3, ALL: 4, WORKSPACE: 4 };
        if (policy.scope !== 'NONE' && (!maxScope || policy.scope !== 'TEAM' && ranks[policy.scope] > ranks[maxScope]))
          throw new AppError('SPA_PERMISSION_INVALID_SCOPE', 'Type policy cannot broaden Workspace role grants.', 422);
      }
      const userIds = [...new Set(input.fieldPolicies.filter(p => p.subjectType === 'USER').map(p => p.subjectId))];
      if (await tx.workspaceMembership.count({ where: { workspaceId: actor.workspaceId, userId: { in: userIds },
        status: 'ACTIVE', isDeleted: false } }) !== userIds.length)
        throw new AppError('SPA_POLICY_CONFLICT', 'Policy subject is unavailable.', 422);
      const fieldIds = [...new Set(input.fieldPolicies.map(p => p.fieldId))];
      if (await tx.spaFieldDefinition.count({ where: { ...where, id: { in: fieldIds } } }) !== fieldIds.length)
        throw new AppError('SPA_POLICY_CONFLICT', 'Field is unavailable.', 422);
      for (const policy of input.stagePolicies) if (!await tx.spaStage.findFirst({ where: { workspaceId: actor.workspaceId,
        id: policy.stageId, pipelineId: policy.pipelineId } }) || !await tx.spaPipeline.findFirst({ where: { ...where, id: policy.pipelineId } }))
        throw new AppError('SPA_POLICY_CONFLICT', 'Stage is unavailable.', 422);
      for (const list of [input.rolePolicies, input.stagePolicies, input.fieldPolicies]) {
        const keys = list.map(p => 'fieldId' in p ? `${p.fieldId}:${p.subjectType}:${p.subjectId}`
          : `${p.roleId}:${p.action}:${'stageId' in p ? p.stageId : ''}`);
        if (new Set(keys).size !== keys.length) throw new AppError('SPA_POLICY_CONFLICT', 'Policy entries must be unique.', 422);
      }
      const before = { rolePolicies: await tx.spaTypePolicy.findMany({ where }), stagePolicies: await tx.spaStagePolicy.findMany({ where }),
        fieldPolicies: await tx.spaFieldPolicy.findMany({ where }) };
      await tx.spaTypePolicy.deleteMany({ where }); await tx.spaStagePolicy.deleteMany({ where }); await tx.spaFieldPolicy.deleteMany({ where });
      await tx.spaTypePolicy.createMany({ data: input.rolePolicies.map(p => ({ ...where, ...p })) });
      await tx.spaStagePolicy.createMany({ data: input.stagePolicies.map(p => ({ ...where, ...p })) });
      await tx.spaFieldPolicy.createMany({ data: input.fieldPolicies.map(p => ({ ...where, ...p })) });
      const updated = await tx.spaPolicyVersion.update({ where: { id: epoch.id }, data: { version: { increment: 1 } } });
      const changes = { before, after: input, authorizationVersion: updated.version } as unknown as Prisma.InputJsonObject;
      await tx.spaHistory.create({ data: { ...where, actorUserId: actor.userId, action: 'SPA_PERMISSION_CHANGED', changes } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_PERMISSION_CHANGED', changes);
      return { version: updated.version };
    });
  }
  private async scoped(tx: Tx, actor: Principal, item: SpaItem, rawScope: string): Promise<boolean> {
    if (rawScope === 'ALL' || rawScope === 'WORKSPACE') return true;
    if (rawScope === 'OWN') return item.assignedUserId === actor.userId || item.createdByUserId === actor.userId;
    if (rawScope === 'TEAM') {
      const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: item.typeId, deletedAt: null } });
      if (!type?.schemaVersion) return false;
      const publication = await tx.spaSchemaVersion.findUnique({ where: { workspaceId_typeId_versionNumber: {
        workspaceId: actor.workspaceId, typeId: item.typeId, versionNumber: type.schemaVersion } } });
      if (!publication) return false;
      const definitions = schemaSnapshot.parse(publication.snapshot).relations.filter(definition => definition.targetType === 'PROJECT');
      if (!definitions.length) return false;
      const bindings = await tx.spaItemRelation.findMany({ where: { workspaceId: actor.workspaceId, typeId: item.typeId,
        sourceItemId: item.id, targetType: 'PROJECT', definitionId: { in: definitions.map(definition => definition.id) } }, select: { targetId: true } });
      if (!bindings.length) return false;
      const projects = await tx.project.findMany({ where: { workspaceId: actor.workspaceId,
        id: { in: bindings.map(binding => binding.targetId) }, status: { not: 'ARCHIVED' }, isDeleted: false },
        include: { members: { where: { workspaceId: actor.workspaceId, userId: actor.userId, status: 'ACTIVE' } } } });
      return projects.some(project => projectRoleFor(project, project.members, actor.userId) !== null);
    }
    if (rawScope !== 'DEPARTMENT' && rawScope !== 'DEPARTMENT_TREE') return false;
    const departments = await tx.department.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false },
      include: { members: { where: { isDeleted: false } } } });
    const eligible = new Set(departments.filter(d => d.members.some(m => m.userId === actor.userId)).map(d => d.id));
    if (rawScope === 'DEPARTMENT_TREE') {
      let changed = true;
      while (changed) { changed = false; for (const d of departments)
        if (d.parentDepartmentId && eligible.has(d.parentDepartmentId) && !eligible.has(d.id)) { eligible.add(d.id); changed = true; } }
    }
    return departments.some(d => eligible.has(d.id) && d.members.some(m => m.userId === item.assignedUserId));
  }
  async allowed(tx: Tx, actor: Principal, item: SpaItem, permission: string): Promise<boolean> {
    if (item.workspaceId !== actor.workspaceId || actor.entitlements?.spa === false) return false;
    const base = actor.grants.get(permission);
    if (!base) return false;
    const typePolicy = await tx.spaTypePolicy.findUnique({ where: { workspaceId_typeId_roleId_action: {
      workspaceId: actor.workspaceId, typeId: item.typeId, roleId: actor.roleId, action: permission } } });
    if (typePolicy?.scope === 'NONE') return false;
    const scopeAllowed = await this.scoped(tx, actor, item, base) && (!typePolicy || await this.scoped(tx, actor, item, typePolicy.scope));
    const observer = permission === 'SPA.ITEM.READ' && base !== 'TEAM' && typePolicy?.scope !== 'TEAM' && !!await tx.spaItemObserver.findUnique({ where: {
      workspaceId_itemId_userId: { workspaceId: actor.workspaceId, itemId: item.id, userId: actor.userId } } });
    if (!scopeAllowed && !observer) return false;
    if (item.stageId) {
      const stagePolicy = await tx.spaStagePolicy.findUnique({ where: { workspaceId_typeId_stageId_roleId_action: {
        workspaceId: actor.workspaceId, typeId: item.typeId, stageId: item.stageId, roleId: actor.roleId, action: permission } } });
      if (stagePolicy && !await this.scoped(tx, actor, item, stagePolicy.scope)) return false;
    }
    return true;
  }
  async assertItem(tx: Tx, actor: Principal, item: SpaItem, permission: string) {
    if (item.workspaceId !== actor.workspaceId || !await this.allowed(tx, actor, item, permission))
      throw new AppError('PERMISSION_DENIED', 'Item permission is required.', 403);
  }
  /** SQL eligibility is evaluated before pagination/counts, never after taking a page. */
  async itemWhere(tx: Tx, actor: Principal, typeId: string, permission: string): Promise<Prisma.SpaItemWhereInput> {
    const denied = { id: { in: [] as string[] } };
    const base = actor.grants.get(permission);
    if (!base || actor.entitlements?.spa === false) return denied;
    const where = { workspaceId: actor.workspaceId, typeId };
    const typePolicy = await tx.spaTypePolicy.findUnique({ where: { workspaceId_typeId_roleId_action: {
      ...where, roleId: actor.roleId, action: permission } } });
    if (typePolicy?.scope === 'NONE') return denied;
    const cache = new Map<string, Prisma.SpaItemWhereInput>();
    const scoped = async (scope: string): Promise<Prisma.SpaItemWhereInput> => {
      const cached = cache.get(scope); if (cached) return cached;
      let result: Prisma.SpaItemWhereInput = denied;
      if (scope === 'WORKSPACE' || scope === 'ALL') result = { workspaceId: actor.workspaceId };
      else if (scope === 'OWN') result = { OR: [{ createdByUserId: actor.userId }, { assignedUserId: actor.userId }] };
      else if (scope === 'DEPARTMENT' || scope === 'DEPARTMENT_TREE') {
        const departments = await tx.department.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false },
          include: { members: { where: { isDeleted: false } } } });
        const eligible = new Set(departments.filter(d => d.members.some(m => m.userId === actor.userId)).map(d => d.id));
        if (scope === 'DEPARTMENT_TREE') {
          let changed = true;
          while (changed) { changed = false; for (const d of departments)
            if (d.parentDepartmentId && eligible.has(d.parentDepartmentId) && !eligible.has(d.id)) { eligible.add(d.id); changed = true; } }
        }
        result = { assignedUserId: { in: [...new Set(departments.filter(d => eligible.has(d.id)).flatMap(d => d.members.map(m => m.userId)))] } };
      } else if (scope === 'TEAM') {
        const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
        const publication = type?.schemaVersion ? await tx.spaSchemaVersion.findUnique({ where: { workspaceId_typeId_versionNumber: {
          ...where, versionNumber: type.schemaVersion } } }) : null;
        const definitions = publication ? schemaSnapshot.parse(publication.snapshot).relations.filter(r => r.targetType === 'PROJECT') : [];
        if (definitions.length) {
          const projects = await tx.project.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false, status: { not: 'ARCHIVED' },
            OR: [{ ownerUserId: actor.userId }, { members: { some: { workspaceId: actor.workspaceId, userId: actor.userId, status: 'ACTIVE' } } }] }, select: { id: true } });
          const bindings = await tx.spaItemRelation.findMany({ where: { ...where, definitionId: { in: definitions.map(d => d.id) },
            targetType: 'PROJECT', targetId: { in: projects.map(p => p.id) } }, select: { sourceItemId: true } });
          result = { id: { in: [...new Set(bindings.map(b => b.sourceItemId))] } };
        }
      }
      cache.set(scope, result); return result;
    };
    let eligible: Prisma.SpaItemWhereInput = { AND: [await scoped(base), ...(typePolicy ? [await scoped(typePolicy.scope)] : [])] };
    if (permission === 'SPA.ITEM.READ' && base !== 'TEAM' && typePolicy?.scope !== 'TEAM') {
      const observers = await tx.spaItemObserver.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, select: { itemId: true } });
      eligible = { OR: [eligible, { id: { in: observers.map(o => o.itemId) } }] };
    }
    const stagePolicies = await tx.spaStagePolicy.findMany({ where: { ...where, roleId: actor.roleId, action: permission } });
    const stages: Prisma.SpaItemWhereInput[] = [];
    for (const policy of stagePolicies) stages.push({ OR: [{ stageId: null }, { stageId: { not: policy.stageId } },
      { AND: [{ stageId: policy.stageId }, await scoped(policy.scope)] }] });
    return { ...where, AND: [eligible, ...stages] };
  }
  async fieldAccess(tx: Tx, actor: Principal, typeId: string, fieldId: string) {
    const rules = await tx.spaFieldPolicy.findMany({ where: { workspaceId: actor.workspaceId, typeId, fieldId,
      OR: [{ subjectType: 'ROLE', subjectId: actor.roleId }, { subjectType: 'USER', subjectId: actor.userId }] } });
    return { canView: rules.every(rule => rule.canView), canEdit: rules.every(rule => rule.canView && rule.canEdit) };
  }
  async history(actor: Principal, typeId: string, query: unknown) {
    requirePermission(actor, 'SPA.PERMISSION.MANAGE', true);
    const input = parse(pageQuery, query);
    return this.db.$transaction(async tx => {
      await this.type(tx, actor, typeId);
      const where = { workspaceId: actor.workspaceId, typeId, action: 'SPA_PERMISSION_CHANGED' };
      const data = await tx.spaHistory.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.limit, take: input.limit });
      const total = await tx.spaHistory.count({ where });
      return { data, meta: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
    });
  }
}

