import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { parse, uuid } from '../process-platform/dto';
import { capabilityKeys, createType, listTypes, typeAction, updateCapability, updateType } from './dto';
import { schemaSnapshot } from './field-metadata';

export class SpaTypeService {
  constructor(private readonly db: PrismaClient) {}

  private async type(tx: Tx, actor: Principal, id: string) {
    parse(uuid, id);
    const row = await tx.spaEntityType.findFirst({ where: { id, workspaceId: actor.workspaceId, deletedAt: null } });
    if (!row) throw new AppError('SPA_TYPE_NOT_FOUND', 'Smart Process Type was not found.', 404);
    return row;
  }

  /** Type counts are configured in Workspace settings by the existing entitlement owner. */
  private async entitlement(tx: Tx, actor: Principal) {
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    const settings = workspace.settings as Record<string, unknown>;
    const entitlements = settings.entitlements as Record<string, unknown> | undefined;
    if (entitlements?.spa === false) throw new AppError('SPA_PLAN_LIMIT', 'Smart Processes are unavailable for this Workspace.', 403);
    return entitlements;
  }

  async create(actor: Principal, raw: unknown) {
    requirePermission(actor, 'SPA.TYPE.MANAGE', true);
    const input = parse(createType, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type-count');
      const entitlements = await this.entitlement(tx, actor);
      if (typeof entitlements?.maxSpaTypes === 'number' &&
          await tx.spaEntityType.count({ where: { workspaceId: actor.workspaceId, deletedAt: null } }) >= entitlements.maxSpaTypes)
        throw new AppError('SPA_PLAN_LIMIT', 'Smart Process Type limit reached.', 422);
      if (await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, code: input.code } }))
        throw new AppError('SPA_TYPE_CODE_EXISTS', 'Type code already exists.', 409);
      const selected = new Map((input.capabilities ?? []).map(capability => [capability.key, capability]));
      if (selected.size !== input.capabilities?.length && input.capabilities)
        throw new AppError('INVALID_ARGUMENT', 'Capability keys must be unique.', 400);
      if (selected.get('KANBAN')?.enabled && !selected.get('PIPELINES')?.enabled)
        throw new AppError('SPA_CAPABILITY_DEPENDENCY', 'KANBAN requires PIPELINES.', 422);
      const row = await tx.spaEntityType.create({ data: { workspaceId: actor.workspaceId, createdByUserId: actor.userId,
        code: input.code, name: input.name, pluralName: input.pluralName, placement: input.placement } });
      await tx.spaCapability.createMany({ data: capabilityKeys.map(key => ({ workspaceId: actor.workspaceId, typeId: row.id,
        key, enabled: selected.get(key)?.enabled ?? ['NUMBERING', 'RECYCLE_BIN', 'OBSERVERS', 'ACTIVITIES'].includes(key),
        configuration: selected.get(key)?.configuration ?? {} })) });
      await tx.spaSchemaDraft.create({ data: { workspaceId: actor.workspaceId, typeId: row.id,
        snapshot: { fields: [], uniqueConstraints: [], relations: [], layouts: ['CREATE','DETAIL','EDIT'].map(context => ({
          id: randomUUID(), name: context.charAt(0) + context.slice(1).toLowerCase(), context, version: 1, sections: [] })) } } });
      await tx.spaNumberingScheme.create({ data: { workspaceId: actor.workspaceId, typeId: row.id, prefixTemplate: input.code + '-' } });
      await evidence(tx, actor, 'SPA_TYPE', row.id, 'SPA_TYPE_CREATED', { code: row.code, status: row.status });
      return row;
    }, { timeout: 30000 });
  }

  async list(actor: Principal, raw: unknown) {
    requirePermission(actor, 'SPA.TYPE.READ');
    const input = parse(listTypes, raw);
    const where: Prisma.SpaEntityTypeWhereInput = { workspaceId: actor.workspaceId, deletedAt: null,
      ...(input.status && { status: input.status }), ...(input.placement && { placement: input.placement }),
      ...(input.search && { name: { contains: input.search, mode: 'insensitive' } }) };
    const [data, total] = await this.db.$transaction([
      this.db.spaEntityType.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (input.page - 1) * input.limit, take: input.limit }), this.db.spaEntityType.count({ where }),
    ]);
    return { data, meta: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
  }

  async get(actor: Principal, id: string) {
    requirePermission(actor, 'SPA.TYPE.READ');
    return this.db.$transaction(async tx => {
      const row = await this.type(tx, actor, id);
      const capabilities = await tx.spaCapability.findMany({ where: { workspaceId: actor.workspaceId, typeId: id }, orderBy: { key: 'asc' } });
      return { ...row, capabilities, permissions: [...actor.grants.keys()].filter(key => key.startsWith('SPA.')) };
    });
  }

  async update(actor: Principal, id: string, raw: unknown) {
    requirePermission(actor, 'SPA.TYPE.MANAGE', true);
    const { expectedVersion, ...changes } = parse(updateType, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + id);
      const row = await this.type(tx, actor, id);
      assertVersion(row.version, expectedVersion);
      if (row.status === 'ARCHIVED') throw new AppError('SPA_TYPE_INVALID_STATUS', 'Archived Types are read-only.', 409);
      const result = await tx.spaEntityType.update({ where: { id }, data: { ...changes, version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_TYPE', id, 'SPA_TYPE_UPDATED', { version: result.version });
      return result;
    });
  }

  async transition(actor: Principal, id: string, action: 'activate' | 'archive' | 'restore', raw: unknown) {
    requirePermission(actor, 'SPA.TYPE.MANAGE', true);
    const input = parse(typeAction, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + id);
      const row = await this.type(tx, actor, id);
      assertVersion(row.version, input.expectedVersion);
      const allowed = action === 'activate' ? ['DRAFT'] : action === 'restore' ? ['ARCHIVED'] : ['ACTIVE', 'DRAFT'];
      if (!allowed.includes(row.status)) throw new AppError('SPA_TYPE_INVALID_STATUS', 'Type cannot perform this transition.', 409);
      if (action !== 'archive') {
        await this.entitlement(tx, actor);
        if (!row.schemaVersion || !await tx.spaSchemaVersion.findFirst({ where: { workspaceId: actor.workspaceId, typeId: id,
          versionNumber: row.schemaVersion } })) throw new AppError('SPA_SCHEMA_NOT_PUBLISHED', 'A published schema is required.', 422);
        const pipelines = await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId: id, key: 'PIPELINES', enabled: true } });
        if (pipelines) {
          const pipeline = await tx.spaPipeline.findFirst({ where: { workspaceId: actor.workspaceId, typeId: id,
            isDefault: true, status: 'ACTIVE' } });
          if (!pipeline || !await tx.spaStage.findFirst({ where: { workspaceId: actor.workspaceId, pipelineId: pipeline.id,
            isDefault: true, semantic: 'PROGRESS', status: 'ACTIVE' } }))
            throw new AppError('SPA_CAPABILITY_DEPENDENCY', 'An active default Pipeline and start Stage are required.', 422);
        }
      }
      const result = await tx.spaEntityType.update({ where: { id }, data: {
        status: action === 'archive' ? 'ARCHIVED' : 'ACTIVE', version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_TYPE', id, 'SPA_TYPE_' + ({ activate: 'ACTIVATED', archive: 'ARCHIVED', restore: 'RESTORED' }[action]),
        { status: result.status, version: result.version });
      return result;
    });
  }

  async capabilities(actor: Principal, id: string) {
    return (await this.get(actor, id)).capabilities;
  }

  async setCapability(actor: Principal, id: string, rawKey: string, raw: unknown) {
    requirePermission(actor, 'SPA.TYPE.MANAGE', true);
    const key = parse(z.enum(capabilityKeys), rawKey);
    const input = parse(updateCapability, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + id);
      const row = await this.type(tx, actor, id);
      assertVersion(row.version, input.expectedVersion);
      if (row.status === 'ARCHIVED') throw new AppError('SPA_TYPE_INVALID_STATUS', 'Archived Types are read-only.', 409);
      const flags = await tx.spaCapability.findMany({ where: { workspaceId: actor.workspaceId, typeId: id } });
      const draft = await tx.spaSchemaDraft.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId: id } } });
      const snapshot = parse(schemaSnapshot, draft.snapshot);
      const staged = snapshot.capabilities ?? flags;
      const enabled = new Set(staged.filter(flag => flag.enabled).map(flag => flag.key));
      if (input.enabled) enabled.add(key); else enabled.delete(key);
      if (enabled.has('KANBAN') && !enabled.has('PIPELINES'))
        throw new AppError('SPA_CAPABILITY_DEPENDENCY', 'KANBAN requires PIPELINES.', 422);
      if (!input.enabled && flags.some(flag => flag.key === key && flag.enabled) &&
          await tx.spaItem.count({ where: { workspaceId: actor.workspaceId, typeId: id } }))
        throw new AppError('SPA_CAPABILITY_IN_USE', 'Existing Item bindings require a reviewed migration before disabling.', 409);
      await tx.spaSchemaDraft.update({ where: { id: draft.id }, data: { version: { increment: 1 },
        snapshot: { ...snapshot, capabilities: capabilityKeys.map(flag => ({ key: flag, enabled: enabled.has(flag),
          configuration: flag === key ? input.configuration : staged.find(value => value.key === flag)?.configuration ?? {} })) } } });
      await tx.spaEntityType.update({ where: { id }, data: { version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_TYPE', id, 'SPA_SCHEMA_DRAFT_UPDATED', { capabilityKey: key, enabled: input.enabled });
      return { draftId: draft.id, draftVersion: draft.version + 1, publicationRequired: true };
    });
  }
}
