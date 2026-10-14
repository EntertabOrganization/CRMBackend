import { type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { code, name, pageQuery, parse, uuid, version } from '../process-platform/dto';
import { SpaItemService } from './item-service';

export const createPipeline = z.strictObject({ code, name, isDefault: z.boolean().default(false) });
export const changePipeline = z.strictObject({ expectedVersion: version, name: name.optional(),
  sortOrder: z.number().int().min(0).optional(), isDefault: z.boolean().optional() });
const semantic = z.enum(['PROGRESS', 'SUCCESS', 'FAILURE']);
export const createStage = z.strictObject({ code, name, semantic, sortOrder: z.number().int().min(0),
  isDefault: z.boolean().default(false) });
export const changeStage = z.strictObject({ expectedVersion: version, name: name.optional(),
  sortOrder: z.number().int().min(0).optional(), semantic: semantic.optional() });

export class SpaPipelineService {
  constructor(private readonly db: PrismaClient) {}
  private async type(tx: Tx, actor: Principal, typeId: string, writable = false) {
    parse(uuid, typeId);
    const type = await tx.spaEntityType.findFirst({ where: { id: typeId, workspaceId: actor.workspaceId, deletedAt: null } });
    if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    if (writable && type.status === 'ARCHIVED') throw new AppError('SPA_TYPE_ARCHIVED', 'Archived Type is read-only.', 409);
    return type;
  }
  private async pipeline(tx: Tx, actor: Principal, typeId: string, pipelineId: string, writable = false) {
    await this.type(tx, actor, typeId, writable);
    parse(uuid, pipelineId);
    const row = await tx.spaPipeline.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: pipelineId } });
    if (!row) throw new AppError('SPA_PIPELINE_NOT_FOUND', 'Pipeline was not found.', 404);
    if (writable && row.status !== 'ACTIVE') throw new AppError('SPA_INVALID_TRANSITION', 'Pipeline is archived.', 409);
    return row;
  }
  private async stage(tx: Tx, actor: Principal, typeId: string, pipelineId: string, stageId: string, writable = false) {
    await this.pipeline(tx, actor, typeId, pipelineId, writable);
    parse(uuid, stageId);
    const row = await tx.spaStage.findFirst({ where: { workspaceId: actor.workspaceId, pipelineId, id: stageId } });
    if (!row) throw new AppError('SPA_STAGE_NOT_FOUND', 'Stage was not found.', 404);
    if (writable && row.status !== 'ACTIVE') throw new AppError('SPA_INVALID_TRANSITION', 'Stage is archived.', 409);
    return row;
  }
  async list(actor: Principal, typeId: string, query: unknown) {
    requirePermission(actor, 'SPA.PIPELINE.READ');
    const input = parse(pageQuery, query);
    return this.db.$transaction(async tx => {
      await this.type(tx, actor, typeId);
      const where = { workspaceId: actor.workspaceId, typeId,
        ...(input.search ? { name: { contains: input.search, mode: 'insensitive' as const } } : {}) };
      const data = await tx.spaPipeline.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: (input.page - 1) * input.limit, take: input.limit });
      const total = await tx.spaPipeline.count({ where });
      return { data, meta: { page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit) } };
    });
  }
  async create(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.PIPELINE.MANAGE', true);
    const input = parse(createPipeline, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      await this.type(tx, actor, typeId, true);
      const existing = await tx.spaPipeline.count({ where: { workspaceId: actor.workspaceId, typeId, status: 'ACTIVE' } });
      if (await tx.spaPipeline.findFirst({ where: { workspaceId: actor.workspaceId, typeId, code: input.code } }))
        throw new AppError('SPA_PIPELINE_CODE_EXISTS', 'Pipeline code already exists.', 409);
      const isDefault = input.isDefault || existing === 0;
      if (isDefault) await tx.spaPipeline.updateMany({ where: { workspaceId: actor.workspaceId, typeId, isDefault: true },
        data: { isDefault: false, version: { increment: 1 } } });
      const row = await tx.spaPipeline.create({ data: { workspaceId: actor.workspaceId, typeId, ...input, isDefault,
        sortOrder: existing } });
      await tx.spaStage.createMany({ data: [
        { code: 'NEW', name: 'New', semantic: 'PROGRESS', isDefault: true, sortOrder: 0 },
        { code: 'SUCCESS', name: 'Completed', semantic: 'SUCCESS', isDefault: false, sortOrder: 1 },
        { code: 'FAILURE', name: 'Failed', semantic: 'FAILURE', isDefault: false, sortOrder: 2 },
      ].map(stage => ({ workspaceId: actor.workspaceId, pipelineId: row.id, ...stage })) });
      await evidence(tx, actor, 'SPA_PIPELINE', row.id, 'SPA_PIPELINE_CREATED', { typeId, code: row.code });
      return row;
    });
  }
  async update(actor: Principal, typeId: string, pipelineId: string, raw: unknown) {
    requirePermission(actor, 'SPA.PIPELINE.MANAGE', true);
    const { expectedVersion, ...changes } = parse(changePipeline, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const row = await this.pipeline(tx, actor, typeId, pipelineId, true);
      assertVersion(row.version, expectedVersion);
      if (changes.isDefault === false && row.isDefault)
        throw new AppError('SPA_INVALID_TRANSITION', 'Select another default Pipeline before clearing the current default.', 422);
      if (changes.isDefault) await tx.spaPipeline.updateMany({ where: { workspaceId: actor.workspaceId, typeId,
        id: { not: pipelineId }, isDefault: true }, data: { isDefault: false, version: { increment: 1 } } });
      const result = await tx.spaPipeline.update({ where: { id: pipelineId }, data: { ...changes, version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_PIPELINE', pipelineId, 'SPA_PIPELINE_UPDATED', { version: result.version });
      return result;
    });
  }
  async stages(actor: Principal, typeId: string, pipelineId: string) {
    requirePermission(actor, 'SPA.PIPELINE.READ');
    return this.db.$transaction(async tx => {
      await this.pipeline(tx, actor, typeId, pipelineId);
      return tx.spaStage.findMany({ where: { workspaceId: actor.workspaceId, pipelineId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    });
  }
  async createStage(actor: Principal, typeId: string, pipelineId: string, raw: unknown) {
    requirePermission(actor, 'SPA.STAGE.MANAGE', true);
    const input = parse(createStage, raw);
    if (input.isDefault && input.semantic !== 'PROGRESS')
      throw new AppError('SPA_INVALID_TRANSITION', 'Initial Stage must have PROGRESS semantics.', 422);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      await this.pipeline(tx, actor, typeId, pipelineId, true);
      if (await tx.spaStage.findFirst({ where: { workspaceId: actor.workspaceId, pipelineId, code: input.code } }))
        throw new AppError('SPA_STAGE_CODE_EXISTS', 'Stage code already exists.', 409);
      if (input.isDefault) await tx.spaStage.updateMany({ where: { workspaceId: actor.workspaceId, pipelineId, isDefault: true },
        data: { isDefault: false, version: { increment: 1 } } });
      const row = await tx.spaStage.create({ data: { workspaceId: actor.workspaceId, pipelineId, ...input } });
      await evidence(tx, actor, 'SPA_STAGE', row.id, 'SPA_STAGE_CREATED', { typeId, pipelineId, semantic: row.semantic });
      return row;
    });
  }
  async updateStage(actor: Principal, typeId: string, pipelineId: string, stageId: string, raw: unknown) {
    requirePermission(actor, 'SPA.STAGE.MANAGE', true);
    const { expectedVersion, ...changes } = parse(changeStage, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const row = await this.stage(tx, actor, typeId, pipelineId, stageId, true);
      assertVersion(row.version, expectedVersion);
      if (changes.semantic && changes.semantic !== row.semantic) {
        if (row.isDefault && changes.semantic !== 'PROGRESS')
          throw new AppError('SPA_INVALID_TRANSITION', 'Initial Stage must have PROGRESS semantics.', 422);
        if (await tx.spaItem.count({ where: { workspaceId: actor.workspaceId, typeId, stageId, status: { not: 'TRASHED' } } }))
          throw new AppError('SPA_STAGE_HAS_ITEMS', 'Transition bound Items before changing Stage semantics.', 409);
      }
      const result = await tx.spaStage.update({ where: { id: stageId }, data: { ...changes, version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_STAGE', stageId, 'SPA_STAGE_UPDATED', { version: result.version });
      return result;
    });
  }
  async archive(actor: Principal, typeId: string, pipelineId: string, raw: unknown, stageId?: string) {
    requirePermission(actor, stageId ? 'SPA.STAGE.MANAGE' : 'SPA.PIPELINE.MANAGE', true);
    const target = z.strictObject({ pipelineId: uuid, stageId: uuid });
    const input = parse(stageId ? z.strictObject({ migrationTarget: target.optional() })
      : z.strictObject({ expectedVersion: version, migrationTarget: target.optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const type = await this.type(tx, actor, typeId, true);
      const row = stageId ? await this.stage(tx, actor, typeId, pipelineId, stageId, true)
        : await this.pipeline(tx, actor, typeId, pipelineId, true);
      if ('expectedVersion' in input) assertVersion(row.version, parse(version, input.expectedVersion));
      const bound = await tx.spaItem.findMany({ where: { workspaceId: actor.workspaceId, typeId, pipelineId,
        ...(stageId ? { stageId } : {}), status: { not: 'TRASHED' } }, orderBy: { id: 'asc' } });
      if (bound.length && !input.migrationTarget)
        throw new AppError(stageId ? 'SPA_STAGE_HAS_ITEMS' : 'SPA_PIPELINE_HAS_ITEMS', 'Bound Items require an explicit migration target.', 409);
      let destination;
      if (input.migrationTarget) {
        const p = input.migrationTarget;
        destination = await this.stage(tx, actor, typeId, p.pipelineId, p.stageId, true);
        if (stageId ? destination.id === stageId : destination.pipelineId === pipelineId)
          throw new AppError('SPA_INVALID_TRANSITION', 'Migration target must survive archival.', 422);
        if (stageId && row.isDefault && (destination.pipelineId !== pipelineId || destination.semantic !== 'PROGRESS'))
          throw new AppError('SPA_INVALID_TRANSITION', 'Initial Stage replacement must be a progress Stage in the same Pipeline.', 422);
        const items = new SpaItemService(this.db);
        for (const item of bound) await items.transitionInTransaction(tx, actor, typeId, item.id, {
          expectedVersion: item.version, targetPipelineId: destination.pipelineId, targetStageId: destination.id, reason: 'Explicit archive migration' });
      }
      const enabled = await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId, key: 'PIPELINES', enabled: true } });
      if (stageId && row.isDefault && !destination)
        throw new AppError('SPA_INVALID_TRANSITION', 'Select a replacement initial Stage before archival.', 422);
      if (row.isDefault && type.status === 'ACTIVE' && enabled && !destination)
        throw new AppError('SPA_INVALID_TRANSITION', 'Select a replacement default before archival.', 422);
      if (stageId) {
        const result = await tx.spaStage.update({ where: { id: stageId }, data: { status: 'ARCHIVED', isDefault: false, version: { increment: 1 } } });
        if (row.isDefault && destination?.pipelineId === pipelineId) await tx.spaStage.update({ where: { id: destination.id },
          data: { isDefault: true, version: { increment: 1 } } });
        await evidence(tx, actor, 'SPA_STAGE', stageId, 'SPA_STAGE_ARCHIVED', { migratedItems: bound.length });
        return result;
      }
      const result = await tx.spaPipeline.update({ where: { id: pipelineId }, data: { status: 'ARCHIVED', isDefault: false, version: { increment: 1 } } });
      if (row.isDefault && destination) {
        await tx.spaPipeline.updateMany({ where: { workspaceId: actor.workspaceId, typeId, isDefault: true },
          data: { isDefault: false, version: { increment: 1 } } });
        await tx.spaPipeline.update({ where: { id: destination.pipelineId }, data: { isDefault: true, version: { increment: 1 } } });
      }
      await evidence(tx, actor, 'SPA_PIPELINE', pipelineId, 'SPA_PIPELINE_ARCHIVED', { migratedItems: bound.length });
      return result;
    }, { timeout: 30000 });
  }
}

