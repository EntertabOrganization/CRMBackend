import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { pageQuery, parse, uuid, version } from '../process-platform/dto';
import { layoutDefinition, relationDefinition, schemaSnapshot, type SchemaSnapshot } from './field-metadata';
import { SpaItemService } from './item-service';
import { spaReferenceContext } from './reference-adapter';

export class SpaRelationService {
  private readonly items: SpaItemService;
  constructor(private readonly db: PrismaClient) { this.items = new SpaItemService(db); }
  private async schema(tx: Tx, actor: Principal, typeId: string, draftMode = false) {
    parse(uuid, typeId);
    const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
    if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    if (draftMode && type.status === 'ARCHIVED') throw new AppError('SPA_TYPE_ARCHIVED', 'Archived Type is read-only.', 409);
    const draft = await tx.spaSchemaDraft.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId } } });
    const publication = !draftMode && type.schemaVersion ? await tx.spaSchemaVersion.findUnique({ where: {
      workspaceId_typeId_versionNumber: { workspaceId: actor.workspaceId, typeId, versionNumber: type.schemaVersion } } }) : null;
    return { type, draft, snapshot: parse(schemaSnapshot, publication?.snapshot ?? draft.snapshot) };
  }
  private async saveDraft(tx: Tx, actor: Principal, typeId: string, id: string, snapshot: SchemaSnapshot) {
    const result = await tx.spaSchemaDraft.update({ where: { id }, data: { snapshot: snapshot as Prisma.InputJsonObject, version: { increment: 1 } } });
    await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_SCHEMA_DRAFT_UPDATED', { draftVersion: result.version });
    return result.version;
  }
  async definitions(actor: Principal, typeId: string) {
    requirePermission(actor, 'SPA.SCHEMA.READ');
    return this.db.$transaction(async tx => (await this.schema(tx, actor, typeId,
      actor.grants.get('SPA.SCHEMA.MANAGE') === 'WORKSPACE')).snapshot.relations);
  }
  async addDefinition(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    const input = parse(relationDefinition.omit({ id: true }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { draft, snapshot } = await this.schema(tx, actor, typeId, true);
      if (snapshot.relations.some(r => r.code === input.code)) throw new AppError('SPA_RELATION_DUPLICATE', 'Relation code already exists.', 409);
      if (input.targetSubtypeId && (input.targetType !== 'SPA_ITEM' || !await tx.spaEntityType.findFirst({ where: {
        workspaceId: actor.workspaceId, id: input.targetSubtypeId, deletedAt: null } })))
        throw new AppError('SPA_RELATION_TARGET_INVALID', 'Target subtype is unavailable.', 422);
      const definition = parse(relationDefinition, { ...input, id: randomUUID() }); snapshot.relations.push(definition);
      const draftVersion = await this.saveDraft(tx, actor, typeId, draft.id, snapshot);
      return { ...definition, draftVersion, publicationRequired: true };
    });
  }
  async list(actor: Principal, typeId: string, itemId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.READ');
    const query = parse(pageQuery.extend({ targetType: relationDefinition.shape.targetType.optional() }), raw);
    return this.db.$transaction(async tx => {
      await this.items.load(tx, actor, typeId, itemId, 'SPA.ITEM.READ');
      const { snapshot } = await this.schema(tx, actor, typeId);
      const references = await spaReferenceContext(tx, actor, this.items.policies);
      const rows = await tx.spaItemRelation.findMany({ where: { workspaceId: actor.workspaceId, typeId, sourceItemId: itemId,
        ...(query.targetType ? { targetType: query.targetType } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const visible = [];
      for (const row of rows) {
        const definition = snapshot.relations.find(r => r.id === row.definitionId);
        if (definition && await references.checkTarget(row.targetType, row.targetId, definition.targetSubtypeId)) visible.push(row);
      }
      return { data: visible.slice((query.page - 1) * query.limit, query.page * query.limit),
        meta: { page: query.page, limit: query.limit, total: visible.length, totalPages: Math.ceil(visible.length / query.limit) } };
    }, { timeout: 30000 });
  }
  async link(actor: Principal, typeId: string, itemId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.UPDATE');
    const input = parse(z.strictObject({ definitionId: uuid, targetType: relationDefinition.shape.targetType, targetId: uuid,
      isPrimary: z.boolean().default(false) }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { type, snapshot } = await this.schema(tx, actor, typeId);
      if (type.status !== 'ACTIVE') throw new AppError('SPA_TYPE_ARCHIVED', 'Active Type is required.', 409);
      const item = await this.items.load(tx, actor, typeId, itemId, 'SPA.ITEM.UPDATE');
      if (item.status === 'TRASHED') throw new AppError('SPA_ITEM_TRASHED', 'Trashed Item is read-only.', 409);
      const definition = snapshot.relations.find(r => r.id === input.definitionId && r.targetType === input.targetType);
      if (!definition) throw new AppError('SPA_RELATION_TARGET_INVALID', 'Published relation definition is unavailable.', 422);
      const references = await spaReferenceContext(tx, actor, this.items.policies);
      if (!await references.checkTarget(input.targetType, input.targetId, definition.targetSubtypeId))
        throw new AppError('SPA_RELATION_TARGET_INVALID', 'Target is inaccessible.', 422);
      const where = { workspaceId: actor.workspaceId, typeId, sourceItemId: itemId, definitionId: input.definitionId };
      const existing = await tx.spaItemRelation.findFirst({ where: { ...where, targetId: input.targetId, targetType: input.targetType } });
      if (existing) return existing;
      if (definition.cardinality === 'ONE' && await tx.spaItemRelation.count({ where }))
        throw new AppError('SPA_RELATION_CARDINALITY', 'This relation already has its single target.', 409);
      if (input.isPrimary) await tx.spaItemRelation.updateMany({ where: { ...where, isPrimary: true }, data: { isPrimary: false } });
      const result = await tx.spaItemRelation.create({ data: { ...where, ...input } });
      await tx.spaItem.update({ where: { id: itemId }, data: { version: { increment: 1 }, updatedByUserId: actor.userId } });
      const changes = { relationId: result.id, definitionId: definition.id };
      await tx.spaHistory.create({ data: { workspaceId: actor.workspaceId, typeId, itemId, actorUserId: actor.userId, action: 'SPA_RELATION_LINKED', changes } });
      await evidence(tx, actor, 'SPA_ITEM', itemId, 'SPA_RELATION_LINKED', changes);
      return result;
    }, { timeout: 30000 });
  }
  async unlink(actor: Principal, typeId: string, itemId: string, relationId: string) {
    requirePermission(actor, 'SPA.ITEM.UPDATE'); parse(uuid, relationId);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { type, snapshot } = await this.schema(tx, actor, typeId);
      if (type.status !== 'ACTIVE') throw new AppError('SPA_TYPE_ARCHIVED', 'Active Type is required.', 409);
      const item = await this.items.load(tx, actor, typeId, itemId, 'SPA.ITEM.UPDATE');
      if (item.status === 'TRASHED') throw new AppError('SPA_ITEM_TRASHED', 'Trashed Item is read-only.', 409);
      const row = await tx.spaItemRelation.findFirst({ where: { workspaceId: actor.workspaceId, typeId, sourceItemId: itemId, id: relationId } });
      if (!row) throw new AppError('SPA_RELATION_NOT_FOUND', 'Relation was not found.', 404);
      const definition = snapshot.relations.find(r => r.id === row.definitionId);
      if (definition?.isRequired && await tx.spaItemRelation.count({ where: { workspaceId: actor.workspaceId, typeId,
        sourceItemId: itemId, definitionId: row.definitionId } }) <= 1)
        throw new AppError('SPA_RELATION_REQUIRED', 'Required relation must retain a target.', 422);
      await tx.spaItemRelation.delete({ where: { id: relationId } });
      await tx.spaItem.update({ where: { id: itemId }, data: { version: { increment: 1 }, updatedByUserId: actor.userId } });
      await evidence(tx, actor, 'SPA_ITEM', itemId, 'SPA_RELATION_UNLINKED', { relationId, definitionId: row.definitionId });
      return { id: relationId, unlinked: true };
    });
  }
  async layouts(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.READ');
    const query = parse(z.strictObject({ context: layoutDefinition.shape.context.optional() }), raw);
    return this.db.$transaction(async tx => {
      const { snapshot } = await this.schema(tx, actor, typeId, actor.grants.get('SPA.SCHEMA.MANAGE') === 'WORKSPACE');
      const visible = new Set<string>();
      for (const field of snapshot.fields) if (field.isActive && (await this.items.policies.fieldAccess(tx, actor, typeId, field.id)).canView) visible.add(field.code);
      return snapshot.layouts.filter(l => !query.context || l.context === query.context).map(layout => ({ ...layout,
        sections: layout.sections.map(section => ({ ...section, fieldCodes: section.fieldCodes.filter(code => visible.has(code)) })) }));
    });
  }
  async updateLayout(actor: Principal, typeId: string, layoutId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true); parse(uuid, layoutId);
    const input = parse(z.strictObject({ expectedVersion: version, sections: layoutDefinition.shape.sections }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { draft, snapshot } = await this.schema(tx, actor, typeId, true);
      const layout = snapshot.layouts.find(l => l.id === layoutId);
      if (!layout) throw new AppError('SPA_LAYOUT_NOT_FOUND', 'Layout was not found.', 404);
      assertVersion(layout.version, input.expectedVersion);
      const codes = input.sections.flatMap(section => section.fieldCodes);
      if (new Set(codes).size !== codes.length || new Set(input.sections.map(s => s.id)).size !== input.sections.length)
        throw new AppError('SPA_LAYOUT_FIELD_INVALID', 'Layout references must be unique.', 422);
      for (const code of codes) {
        const field = snapshot.fields.find(f => f.code === code && f.isActive);
        if (!field || !(await this.items.policies.fieldAccess(tx, actor, typeId, field.id)).canView)
          throw new AppError('SPA_LAYOUT_FIELD_INVALID', 'Layout field is unavailable.', 422);
      }
      layout.sections = input.sections; layout.version += 1;
      const draftVersion = await this.saveDraft(tx, actor, typeId, draft.id, snapshot);
      return { ...layout, draftVersion, publicationRequired: true };
    });
  }
  async views(actor: Principal, typeId: string) {
    requirePermission(actor, 'SPA.ITEM.READ');
    return this.db.$transaction(async tx => {
      const { snapshot } = await this.schema(tx, actor, typeId);
      const rows = await tx.spaUserViewPreference.findMany({ where: { workspaceId: actor.workspaceId, typeId, userId: actor.userId } });
      const visible = new Set<string>(['title','itemNumber','status','createdAt','updatedAt','assignedUserId']);
      for (const field of snapshot.fields) if ((await this.items.policies.fieldAccess(tx, actor, typeId, field.id)).canView) visible.add(field.code);
      return rows.map(row => {
        const p = row.preferences as { columns: string[]; filters: Array<{ fieldCode: string }>; sort: { fieldCode: string; direction: string } };
        return { ...row, preferences: { ...p, columns: p.columns.filter(c => visible.has(c)),
          filters: p.filters.filter(f => visible.has(f.fieldCode)), sort: visible.has(p.sort.fieldCode) ? p.sort : { fieldCode: 'createdAt', direction: 'desc' } } };
      });
    });
  }
  async saveView(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.READ');
    const input = parse(z.strictObject({ viewType: z.enum(['LIST','KANBAN']), columns: z.array(z.string().max(64)).max(100),
      filters: z.array(z.strictObject({ fieldCode: z.string().max(64), operator: z.enum(['EQ','NEQ','CONTAINS']), value: z.json() })).max(30),
      sort: z.strictObject({ fieldCode: z.string().max(64), direction: z.enum(['asc','desc']) }) }), raw);
    return this.db.$transaction(async tx => {
      const { snapshot } = await this.schema(tx, actor, typeId);
      const system = new Set(['title','itemNumber','status','createdAt','updatedAt','assignedUserId']);
      const used = [...input.columns, ...input.filters.map(f => f.fieldCode), input.sort.fieldCode];
      for (const code of used) {
        if (system.has(code)) continue;
        const field = snapshot.fields.find(f => f.code === code && f.isActive);
        if (!field || !(await this.items.policies.fieldAccess(tx, actor, typeId, field.id)).canView ||
          input.filters.some(f => f.fieldCode === code) && !field.isSearchable)
          throw new AppError('SPA_FIELD_PERMISSION_DENIED', 'View field is unavailable.', 403);
      }
      const key = { workspaceId: actor.workspaceId, typeId, userId: actor.userId, viewType: input.viewType };
      return tx.spaUserViewPreference.upsert({ where: { workspaceId_typeId_userId_viewType: key },
        create: { ...key, preferences: input as Prisma.InputJsonObject }, update: { preferences: input as Prisma.InputJsonObject, version: { increment: 1 } } });
    });
  }
}
