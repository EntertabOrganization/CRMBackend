import { Prisma, type PrismaClient, type SpaItem, type SpaItemValue } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, command, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { canonical, name, pageQuery, parse, uuid, version } from '../process-platform/dto';
import { normalizedFieldDefault, parseFieldValue, schemaSnapshot, uniqueValueKey, type SchemaSnapshot, type FieldDefinition } from './field-metadata';
import { SpaPolicyService } from './policy-service';
import { SpaNumberingService } from './numbering-service';
import { spaReferenceContext, spaValueReferenceContext } from './reference-adapter';
import { evaluateConditionTree, validateConditionTree, type OperandDescriptor } from '../automation/conditions';
import type { ConditionNode } from '../automation/types';
import { spaEntitlements } from './entitlements';
import { NotificationService } from '../notifications/service';

const values = z.record(z.string().max(64), z.json());
const editable = z.strictObject({ title: name, assignedUserId: uuid, companyId: uuid.nullable().optional(),
  contacts: z.array(uuid).max(100).optional(), fieldValues: values.default({}) });
const createItem = editable.extend({ pipelineId: uuid.optional(), stageId: uuid.optional(), expectedSchemaVersion: version.optional() });
export const spaCreateItemDto = createItem;
export const patchItem = editable.partial().extend({ expectedVersion: version });
export const replaceItem = editable.extend({ expectedVersion: version });
const filters = z.array(z.strictObject({ fieldCode: z.string().max(64), operator: z.enum(['EQ','NEQ','CONTAINS']), value: z.json() })).max(30);
export const itemQuery = pageQuery.extend({ sortBy: z.enum(['title','createdAt','updatedAt','itemNumber']).default('createdAt'),
  pipelineId: uuid.optional(), stageId: uuid.optional(),
  sortOrder: z.enum(['asc','desc']).default('desc'), filters: z.string().max(10000).optional(), status: z.enum(['ACTIVE','COMPLETED','TRASHED']).optional() });
const empty = (value: unknown) => value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0;

export function storedValue(row: SpaItemValue, field?: FieldDefinition): unknown {
  if (field?.fieldType === 'INTEGER' && row.valueNumber !== null) return row.valueNumber.toNumber();
  if (field?.fieldType === 'DATE' && row.valueDate !== null) return row.valueDate.toISOString().slice(0, 10);
  return row.valueJson ?? row.valueText ?? row.valueNumber?.toString() ?? row.valueDate?.toISOString() ?? row.valueBoolean ?? null;
}
export function valueColumns(field: FieldDefinition, value: unknown): Prisma.SpaItemValueCreateInput {
  const base: Prisma.SpaItemValueCreateInput = { workspaceId: '', itemId: '', fieldId: field.id, schemaVersion: 1 };
  if (empty(value)) return base;
  if (field.isMultiple || field.fieldType === 'MULTI_LIST' || ['MONEY','CRM_REF'].includes(field.fieldType))
    base.valueJson = value as Prisma.InputJsonValue;
  else if (['INTEGER','DECIMAL'].includes(field.fieldType)) base.valueNumber = new Prisma.Decimal(String(value));
  else if (field.fieldType === 'BOOLEAN') base.valueBoolean = value as boolean;
  else if (['DATE','DATETIME'].includes(field.fieldType)) base.valueDate = new Date(String(value));
  else base.valueText = String(value);
  return base;
}

export class SpaItemService {
  readonly policies: SpaPolicyService;
  private readonly numbering: SpaNumberingService;
  constructor(private readonly db: PrismaClient) { this.policies = new SpaPolicyService(db); this.numbering = new SpaNumberingService(db); }
  private async type(tx: Tx, actor: Principal, typeId: string, writable = false) {
    parse(uuid, typeId);
    const type = await tx.spaEntityType.findFirst({ where: { workspaceId: actor.workspaceId, id: typeId, deletedAt: null } });
    if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Type was not found.', 404);
    if (writable && type.status !== 'ACTIVE') throw new AppError('SPA_TYPE_ARCHIVED', 'An active Type is required.', 409);
    const publication = await tx.spaSchemaVersion.findUnique({ where: { workspaceId_typeId_versionNumber: {
      workspaceId: actor.workspaceId, typeId, versionNumber: type.schemaVersion } } });
    if (!publication) throw new AppError('SPA_SCHEMA_NOT_PUBLISHED', 'Published schema is required.', 422);
    await spaEntitlements(tx, actor.workspaceId);
    return { type, snapshot: parse(schemaSnapshot, publication.snapshot) };
  }
  async load(tx: Tx, actor: Principal, typeId: string, itemId: string, permission: string) {
    parse(uuid, typeId); parse(uuid, itemId);
    const item = await tx.spaItem.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: itemId } });
    if (!item) throw new AppError('SPA_ITEM_NOT_FOUND', 'Item was not found.', 404);
    await this.policies.assertItem(tx, actor, item, permission);
    return item;
  }
  private async assignment(tx: Tx, actor: Principal, userId: string) {
    const member = await tx.workspaceMembership.findFirst({ where: { workspaceId: actor.workspaceId, userId,
      status: 'ACTIVE', isDeleted: false, user: { status: 'ACTIVE', isDeleted: false } } });
    if (!member) throw new AppError('SPA_ASSIGNMENT_INVALID', 'Responsible User is unavailable.', 422);
  }
  private async stage(tx: Tx, actor: Principal, typeId: string, pipelineId?: string | null, stageId?: string | null) {
    const enabled = await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId, key: 'PIPELINES', enabled: true } });
    if (!enabled) {
      if (pipelineId || stageId) throw new AppError('SPA_INVALID_TRANSITION', 'Pipelines are disabled for this Type.', 422);
      return null;
    }
    const pipeline = await tx.spaPipeline.findFirst({ where: { workspaceId: actor.workspaceId, typeId, status: 'ACTIVE',
      ...(pipelineId ? { id: pipelineId } : { isDefault: true }) } });
    if (!pipeline) throw new AppError('SPA_PIPELINE_NOT_FOUND', 'Active Pipeline was not found.', 422);
    const stage = await tx.spaStage.findFirst({ where: { workspaceId: actor.workspaceId, pipelineId: pipeline.id, status: 'ACTIVE',
      ...(stageId ? { id: stageId } : { isDefault: true }) } });
    if (!stage) throw new AppError('SPA_STAGE_NOT_FOUND', 'Active Stage was not found.', 422);
    return stage;
  }
  private async validateValues(tx: Tx, actor: Principal, typeId: string, snapshot: SchemaSnapshot,
    supplied: Record<string, unknown>, current: Map<string, unknown>, replace = false, legacyRelationships = false) {
    const byCode = new Map(snapshot.fields.map(f => [f.code, f]));
    for (const key of Object.keys(supplied)) if (!byCode.has(key))
      throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'Unknown field.', 422);
    const targets = new Map<string, string>();
    const referenceIds: string[] = [];
    for (const f of snapshot.fields.filter(f => f.fieldType === 'SPA_REF')) {
      const raw = supplied[f.code] ?? current.get(f.code) ?? f.defaultValue;
      for (const id of Array.isArray(raw) ? raw : [raw]) if (typeof id === 'string' && uuid.safeParse(id).success) {
        if (targets.has(id) && targets.get(id) !== f.referenceTypeId)
          throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'SPA reference subtype does not match its field.', 422);
        referenceIds.push(id); targets.set(id, f.referenceTypeId!);
      }
    }
    const userIds: string[] = [];
    for (const f of snapshot.fields.filter(f => f.fieldType === 'USER')) {
      const raw = supplied[f.code] ?? current.get(f.code) ?? f.defaultValue;
      for (const id of Array.isArray(raw) ? raw : [raw]) if (typeof id === 'string' && uuid.safeParse(id).success) userIds.push(id);
    }
    const legacy = legacyRelationships || snapshot.fields.some(f => ['CRM_REF', 'FILE'].includes(f.fieldType) &&
      !empty(supplied[f.code] ?? current.get(f.code) ?? f.defaultValue));
    const references = legacy ? await spaReferenceContext(tx, actor, this.policies, referenceIds, targets)
      : await spaValueReferenceContext(tx, actor, this.policies, [...new Set(userIds)], referenceIds, targets);
    const result = new Map<string, unknown>(current);
    for (const field of snapshot.fields) {
      const access = await this.policies.fieldAccess(tx, actor, typeId, field.id);
      const has = Object.prototype.hasOwnProperty.call(supplied, field.code);
      if (has && (!field.isActive || !access.canEdit))
        throw new AppError('SPA_FIELD_PERMISSION_DENIED', 'Field cannot be edited.', 403);
      if (!field.isActive) continue;
      const raw = has ? supplied[field.code] : replace && access.canEdit ? field.defaultValue ?? null
        : current.has(field.code) ? current.get(field.code) : field.defaultValue ?? null;
      if (!access.canView && field.isRequired && empty(raw))
        throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'Schema requires an authorized default or workflow value.', 422);
      const old = current.get(field.code);
      const oldItems = Array.isArray(old) ? old : empty(old) ? [] : [old];
      result.set(field.code, parseFieldValue(field, raw, actor.workspaceId, references, oldItems));
    }
    for (const constraint of snapshot.uniqueConstraints) {
      const keyNormalized = uniqueValueKey(constraint, result);
      if (keyNormalized === null) continue;
      const ids = snapshot.fields.filter(f => constraint.fieldCodes.includes(f.code)).map(f => f.id);
      const liveItems = await tx.spaItem.findMany({ where: { workspaceId: actor.workspaceId, typeId,
        status: { not: 'TRASHED' } }, select: { id: true } });
      const rows = await tx.spaItemValue.findMany({ where: { workspaceId: actor.workspaceId, fieldId: { in: ids },
        itemId: { in: liveItems.map(item => item.id) } } });
      const itemValues = new Map<string, Map<string, unknown>>();
      for (const item of liveItems) itemValues.set(item.id, new Map(snapshot.fields.map(field => [field.code, normalizedFieldDefault(field, actor.workspaceId)])));
      for (const row of rows) {
        const values = itemValues.get(row.itemId) ?? new Map<string, unknown>();
        const field = snapshot.fields.find(f => f.id === row.fieldId)!;
        values.set(field.code, storedValue(row, field)); itemValues.set(row.itemId, values);
      }
      // The caller excludes its current Item below, under the Type lock.
      for (const [itemId, item] of itemValues) {
        if (uniqueValueKey(constraint, item) === keyNormalized)
          result.set('__conflict:' + itemId, true);
      }
    }
    return { result, references };
  }
  private async commitValues(tx: Tx, actor: Principal, item: SpaItem, snapshot: SchemaSnapshot, result: Map<string, unknown>) {
    if ([...result.keys()].some(key => key.startsWith('__conflict:') && key !== '__conflict:' + item.id))
      throw new AppError('SPA_SCHEMA_DUPLICATE_VALUES', 'Item values conflict with a uniqueness rule.', 409);
    for (const field of snapshot.fields) {
      if (!field.isActive || !result.has(field.code)) continue;
      const data = { ...valueColumns(field, result.get(field.code)), workspaceId: actor.workspaceId, itemId: item.id, schemaVersion: item.schemaVersion };
      await tx.spaItemValue.upsert({ where: { workspaceId_itemId_fieldId: { workspaceId: actor.workspaceId, itemId: item.id, fieldId: field.id } },
        create: data, update: { valueText: null, valueNumber: null, valueDate: null, valueBoolean: null, valueJson: Prisma.DbNull, ...data } });
    }
  }
  private async currentValues(tx: Tx, actor: Principal, itemId: string, snapshot: SchemaSnapshot) {
    const rows = await tx.spaItemValue.findMany({ where: { workspaceId: actor.workspaceId, itemId } });
    return new Map(rows.map(row => {
      const field = snapshot.fields.find(f => f.id === row.fieldId);
      return [field?.code ?? row.fieldId, storedValue(row, field)];
    }));
  }
  private async projection(tx: Tx, actor: Principal, item: SpaItem, snapshot: SchemaSnapshot) {
    return (await this.projections(tx, actor, [item], snapshot))[0];
  }
  private async projections(tx: Tx, actor: Principal, items: SpaItem[], snapshot: SchemaSnapshot) {
    if (!items.length) return [];
    const where = { workspaceId: actor.workspaceId, itemId: { in: items.map(i => i.id) } };
    const [values, contacts, observers, rules] = await Promise.all([
      tx.spaItemValue.findMany({ where }), tx.spaItemContact.findMany({ where }), tx.spaItemObserver.findMany({ where }),
      tx.spaFieldPolicy.findMany({ where: { workspaceId: actor.workspaceId, typeId: items[0].typeId,
        OR: [{ subjectType: 'ROLE', subjectId: actor.roleId }, { subjectType: 'USER', subjectId: actor.userId }] } }),
    ]);
    const fields = new Map(snapshot.fields.filter(f => rules.filter(r => r.fieldId === f.id).every(r => r.canView)).map(f => [f.id, f]));
    const grouped = new Map<string, Record<string, unknown>>();
    for (const value of values) {
      const field = fields.get(value.fieldId); if (!field) continue;
      const values = grouped.get(value.itemId) ?? {}; values[field.code] = storedValue(value, field); grouped.set(value.itemId, values);
    }
    const referenceFields = [...fields.values()].filter(f => ['SPA_REF', 'CRM_REF', 'FILE'].includes(f.fieldType));
    const spaIds: string[] = [], targets = new Map<string, string>();
    for (const field of referenceFields.filter(f => f.fieldType === 'SPA_REF')) for (const current of grouped.values()) {
      const raw = current[field.code]; for (const id of Array.isArray(raw) ? raw : [raw]) if (typeof id === 'string') { spaIds.push(id); targets.set(id, field.referenceTypeId!); }
    }
    const legacy = items.some(i => i.companyId) || contacts.length > 0 || referenceFields.some(f => f.fieldType !== 'SPA_REF' &&
      [...grouped.values()].some(v => !empty(v[f.code])));
    const references = legacy ? await spaReferenceContext(tx, actor, this.policies, spaIds, targets)
      : spaIds.length ? await spaValueReferenceContext(tx, actor, this.policies, [], spaIds, targets) : null;
    return items.map(item => {
      const fieldValues = grouped.get(item.id) ?? {};
      if (references) for (const field of referenceFields) {
        const raw = fieldValues[field.code]; if (empty(raw)) continue;
        const accessible = (value: any) => field.fieldType === 'FILE' ? references.checkFile(value) === 'OK'
          : field.fieldType === 'SPA_REF' ? references.checkCrmReference('SPA_ITEM', value) === 'OK'
          : references.checkCrmReference(value.entityType, value.entityId) === 'OK';
        if (Array.isArray(raw)) fieldValues[field.code] = raw.filter(accessible);
        else if (!accessible(raw)) delete fieldValues[field.code];
      }
      return { ...item, companyId: item.companyId && references?.checkCrmReference('COMPANY', item.companyId) !== 'OK' ? null : item.companyId,
        fieldValues, contacts: contacts.filter(c => c.itemId === item.id && references?.checkCrmReference('CONTACT', c.contactId) === 'OK').map(c => c.contactId),
        observers: observers.filter(o => o.itemId === item.id).map(o => o.userId) };
    });
  }
  private async history(tx: Tx, actor: Principal, item: SpaItem, action: string, changes: Prisma.InputJsonObject) {
    await tx.spaHistory.create({ data: { workspaceId: actor.workspaceId, typeId: item.typeId, itemId: item.id,
      actorUserId: actor.userId, action, changes } });
    await evidence(tx, actor, 'SPA_ITEM', item.id, action, changes);
  }
  /** Assignment evidence and the assignee's in-app notification commit with the reassignment. Field values are never copied. */
  private async assigned(tx: Tx, actor: Principal, previousUserId: string, item: SpaItem) {
    await this.history(tx, actor, item, 'SPA_ITEM_ASSIGNED', { previousUserId, assignedUserId: item.assignedUserId, version: item.version });
    if (item.assignedUserId === actor.userId) return;
    await new NotificationService(this.db).deliverInTransaction(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId,
      recipientUserIds: [item.assignedUserId], notificationType: 'SPA_ITEM_ASSIGNED', title: 'Smart Process Item assigned',
      message: 'You are now responsible for Item ' + item.itemNumber + '.', link: '/spa/types/' + item.typeId + '/items/' + item.id,
      idempotencyKey: 'spa-item-assigned:' + item.id + ':' + item.version });
  }
  async validateTemplate(tx: Tx, actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.CREATE');
    const input = parse(createItem, raw);
    const { type, snapshot } = await this.type(tx, actor, typeId, true);
    if (input.expectedSchemaVersion !== undefined) assertVersion(type.schemaVersion, input.expectedSchemaVersion);
    await this.assignment(tx, actor, input.assignedUserId);
    if (input.assignedUserId !== actor.userId) requirePermission(actor, 'SPA.ITEM.ASSIGN');
    const stage = await this.stage(tx, actor, typeId, input.pipelineId, input.stageId);
    if (stage?.semantic !== 'PROGRESS' && stage) throw new AppError('SPA_INVALID_TRANSITION', 'Template initial Stage must be a progress Stage.', 422);
    const prepared = await this.validateValues(tx, actor, typeId, snapshot, input.fieldValues, new Map(), false, !!input.companyId || !!input.contacts?.length);
    if (input.companyId && prepared.references.checkCrmReference('COMPANY', input.companyId) !== 'OK' ||
      input.contacts?.some(id => prepared.references.checkCrmReference('CONTACT', id) !== 'OK'))
      throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'CRM relationship is inaccessible.', 422);
    return input;
  }
  async create(actor: Principal, typeId: string, raw: unknown, idempotencyKey: string | null) {
    return this.db.$transaction(tx => this.createInTransaction(tx, actor, typeId, raw, idempotencyKey), { timeout: 30000 });
  }
  async createInTransaction(tx: Tx, actor: Principal, typeId: string, raw: unknown, idempotencyKey: string | null) {
    requirePermission(actor, 'SPA.ITEM.CREATE');
    const input = parse(createItem, raw);
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const committed = await command(tx, actor, 'spa.item.create:' + typeId, idempotencyKey, input, async () => {
        const { type, snapshot } = await this.type(tx, actor, typeId, true);
        if (input.expectedSchemaVersion !== undefined) assertVersion(type.schemaVersion, input.expectedSchemaVersion);
        await this.assignment(tx, actor, input.assignedUserId);
        if (input.assignedUserId !== actor.userId) requirePermission(actor, 'SPA.ITEM.ASSIGN');
        const stage = await this.stage(tx, actor, typeId, input.pipelineId, input.stageId);
        if (stage && stage.semantic !== 'PROGRESS') throw new AppError('SPA_INVALID_TRANSITION', 'Create at a progress Stage, then transition.', 422);
        const prepared = await this.validateValues(tx, actor, typeId, snapshot, input.fieldValues, new Map(), false, !!input.companyId || !!input.contacts?.length);
        if (input.companyId && prepared.references.checkCrmReference('COMPANY', input.companyId) !== 'OK' ||
          input.contacts?.some(id => prepared.references.checkCrmReference('CONTACT', id) !== 'OK'))
          throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'CRM relationship is inaccessible.', 422);
        const item = await tx.spaItem.create({ data: { id: randomUUID(), workspaceId: actor.workspaceId, typeId,
          title: input.title, assignedUserId: input.assignedUserId, companyId: input.companyId,
          pipelineId: stage?.pipelineId, stageId: stage?.id, schemaVersion: type.schemaVersion,
          createdByUserId: actor.userId, updatedByUserId: actor.userId, itemNumber: await this.numbering.allocate(tx, actor, typeId) } });
        await this.policies.assertItem(tx, actor, item, 'SPA.ITEM.CREATE');
        await this.commitValues(tx, actor, item, snapshot, prepared.result);
        if (input.contacts) await tx.spaItemContact.createMany({ data: [...new Set(input.contacts)].map(contactId => ({ workspaceId: actor.workspaceId, itemId: item.id, contactId })) });
        await this.history(tx, actor, item, 'SPA_ITEM_CREATED', { schemaVersion: item.schemaVersion, version: item.version });
        return { id: item.id };
      });
      // Re-evaluate authorization/redaction on replay instead of returning a stale private response snapshot.
      const { snapshot } = await this.type(tx, actor, typeId);
      return this.projection(tx, actor, await this.load(tx, actor, typeId, committed.id, 'SPA.ITEM.CREATE'), snapshot);
  }
  async get(actor: Principal, typeId: string, itemId: string) {
    return this.db.$transaction(tx => this.readInTransaction(tx, actor, typeId, itemId));
  }
  async readInTransaction(tx: Tx, actor: Principal, typeId: string, itemId: string) {
    requirePermission(actor, 'SPA.ITEM.READ');
      const { snapshot } = await this.type(tx, actor, typeId);
      return this.projection(tx, actor, await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.READ'), snapshot);
  }
  async update(actor: Principal, typeId: string, itemId: string, raw: unknown, replace = false) {
    return this.db.$transaction(tx => this.updateInTransaction(tx, actor, typeId, itemId, raw, replace), { timeout: 30000 });
  }
  async updateInTransaction(tx: Tx, actor: Principal, typeId: string, itemId: string, raw: unknown, replace = false) {
    requirePermission(actor, 'SPA.ITEM.UPDATE');
    const input = parse(replace ? replaceItem : patchItem, raw);
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { type, snapshot } = await this.type(tx, actor, typeId, true);
      const item = await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.UPDATE');
      assertVersion(item.version, input.expectedVersion);
      if (item.status === 'TRASHED') throw new AppError('SPA_ITEM_TRASHED', 'Trashed Item is read-only.', 409);
      if (input.assignedUserId && input.assignedUserId !== item.assignedUserId) {
        await this.policies.assertItem(tx, actor, item, 'SPA.ITEM.ASSIGN'); await this.assignment(tx, actor, input.assignedUserId);
      }
      const current = await this.currentValues(tx, actor, itemId, snapshot);
      const prepared = await this.validateValues(tx, actor, typeId, snapshot, input.fieldValues ?? {}, current, replace, !!input.companyId || !!input.contacts?.length);
      if (input.companyId && prepared.references.checkCrmReference('COMPANY', input.companyId) !== 'OK' ||
        input.contacts?.some(id => prepared.references.checkCrmReference('CONTACT', id) !== 'OK'))
        throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'CRM relationship is inaccessible.', 422);
      const result = await tx.spaItem.update({ where: { id: itemId }, data: { title: input.title, assignedUserId: input.assignedUserId,
        companyId: replace ? input.companyId ?? null : input.companyId, schemaVersion: type.schemaVersion,
        updatedByUserId: actor.userId, version: { increment: 1 } } });
      await this.commitValues(tx, actor, result, snapshot, prepared.result);
      if (input.contacts !== undefined || replace) {
        await tx.spaItemContact.deleteMany({ where: { workspaceId: actor.workspaceId, itemId } });
        await tx.spaItemContact.createMany({ data: [...new Set(input.contacts ?? [])].map(contactId => ({ workspaceId: actor.workspaceId, itemId, contactId })) });
      }
      await this.history(tx, actor, result, 'SPA_ITEM_UPDATED', { version: result.version,
        changedFieldIds: snapshot.fields.filter(f => Object.keys(input.fieldValues ?? {}).includes(f.code)).map(f => f.id) });
      if (result.assignedUserId !== item.assignedUserId) await this.assigned(tx, actor, item.assignedUserId, result);
      return this.projection(tx, actor, result, snapshot);
  }
  async list(actor: Principal, typeId: string, raw: unknown) {
    return this.db.$transaction(tx => this.listInTransaction(tx, actor, typeId, raw), { timeout: 30000 });
  }
  private async listInTransaction(tx: Tx, actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.READ');
    const query = parse(itemQuery, raw);
    let selectedFilters: z.infer<typeof filters> = [];
    if (query.filters) {
      let decoded: unknown;
      try { decoded = JSON.parse(query.filters); } catch { throw new AppError('INVALID_ARGUMENT', 'Filters must be valid JSON.', 400); }
      selectedFilters = parse(filters, decoded);
    }
    return (async () => {
      const { snapshot } = await this.type(tx, actor, typeId);
      for (const filter of selectedFilters) {
        const field = snapshot.fields.find(f => f.code === filter.fieldCode && f.isActive && f.isSearchable);
        if (!field || !(await this.policies.fieldAccess(tx, actor, typeId, field.id)).canView)
          throw new AppError('SPA_FIELD_PERMISSION_DENIED', 'Filter field is unavailable.', 403);
      }
      const where: Prisma.SpaItemWhereInput = { AND: [await this.policies.itemWhere(tx, actor, typeId, 'SPA.ITEM.READ')], workspaceId: actor.workspaceId, typeId,
        ...(query.pipelineId ? { pipelineId: query.pipelineId } : {}), ...(query.stageId ? { stageId: query.stageId } : {}),
        status: query.status ?? { not: 'TRASHED' }, ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}) };
      if (!selectedFilters.length) {
        const rows = await tx.spaItem.findMany({ where, orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit, take: query.limit });
        const total = await tx.spaItem.count({ where });
        return { data: await this.projections(tx, actor, rows, snapshot),
          meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
      }
      // Typed JSON filters scan bounded chunks; only the requested page is retained in memory.
      const page: SpaItem[] = [];
      let total = 0;
      for (let offset = 0; ; offset += 250) {
        const rows = await tx.spaItem.findMany({ where, orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }], skip: offset, take: 250 });
        const values = await tx.spaItemValue.findMany({ where: { workspaceId: actor.workspaceId,
          itemId: { in: rows.map(i => i.id) }, fieldId: { in: snapshot.fields.filter(f => selectedFilters.some(s => s.fieldCode === f.code)).map(f => f.id) } } });
        for (const item of rows) {
          const current = new Map(values.filter(v => v.itemId === item.id).map(v => {
            const field = snapshot.fields.find(f => f.id === v.fieldId)!;
            return [field.code, storedValue(v, field)];
          }));
          if (!selectedFilters.every(filter => {
            const value = current.get(filter.fieldCode) ?? null;
            const same = canonical(value) === canonical(filter.value);
            return filter.operator === 'EQ' ? same : filter.operator === 'NEQ' ? !same
              : typeof value === 'string' && typeof filter.value === 'string' && value.toLowerCase().includes(filter.value.toLowerCase());
          })) continue;
          if (total >= (query.page - 1) * query.limit && page.length < query.limit) page.push(item);
          total++;
        }
        if (rows.length < 250) break;
      }
      return { data: await this.projections(tx, actor, page, snapshot), meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    })();
  }
  async assign(actor: Principal, typeId: string, itemId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.ASSIGN');
    const input = parse(z.strictObject({ expectedVersion: version, responsibleUserId: uuid }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { snapshot } = await this.type(tx, actor, typeId, true);
      const item = await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.ASSIGN');
      assertVersion(item.version, input.expectedVersion);
      if (item.status === 'TRASHED') throw new AppError('SPA_ITEM_TRASHED', 'Trashed Item is read-only.', 409);
      await this.assignment(tx, actor, input.responsibleUserId);
      const result = await tx.spaItem.update({ where: { id: item.id }, data: { assignedUserId: input.responsibleUserId,
        version: { increment: 1 }, updatedByUserId: actor.userId } });
      await this.assigned(tx, actor, item.assignedUserId, result);
      return this.projection(tx, actor, result, snapshot);
    });
  }
  async observer(actor: Principal, typeId: string, itemId: string, raw: unknown, remove = false) {
    requirePermission(actor, 'SPA.ITEM.MANAGE_OBSERVERS');
    const { userId } = parse(z.strictObject({ userId: uuid }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      await this.type(tx, actor, typeId, true);
      const item = await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.MANAGE_OBSERVERS');
      if (item.status === 'TRASHED') throw new AppError('SPA_ITEM_TRASHED', 'Trashed Item is read-only.', 409);
      if (!await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId, key: 'OBSERVERS', enabled: true } }))
        throw new AppError('SPA_CAPABILITY_DISABLED', 'Observers are disabled.', 409);
      if (!remove) await this.assignment(tx, actor, userId);
      const where = { workspaceId_itemId_userId: { workspaceId: actor.workspaceId, itemId, userId } };
      const existing = await tx.spaItemObserver.findUnique({ where });
      if (remove ? existing : !existing) {
        if (remove) await tx.spaItemObserver.delete({ where });
        else await tx.spaItemObserver.create({ data: where.workspaceId_itemId_userId });
        await tx.spaItem.update({ where: { id: itemId }, data: { version: { increment: 1 }, updatedByUserId: actor.userId } });
        await this.history(tx, actor, item, remove ? 'SPA_ITEM_OBSERVER_REMOVED' : 'SPA_ITEM_OBSERVER_ADDED', { userId });
      }
      return { userId, observing: !remove };
    });
  }
  async removeObserver(actor: Principal, typeId: string, itemId: string, userId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.MANAGE_OBSERVERS');
    parse(z.strictObject({}), raw);
    return this.observer(actor, typeId, itemId, { userId }, true);
  }
  async lifecycle(actor: Principal, typeId: string, itemId: string, raw: unknown, restore = false) {
    const permission = restore ? 'SPA.ITEM.RESTORE' : 'SPA.ITEM.DELETE';
    requirePermission(actor, permission);
    const { expectedVersion } = parse(z.strictObject({ expectedVersion: version }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { type, snapshot } = await this.type(tx, actor, typeId, true);
      const item = await this.load(tx, actor, typeId, itemId, permission);
      assertVersion(item.version, expectedVersion);
      if (restore ? item.status !== 'TRASHED' : item.status === 'TRASHED')
        throw new AppError('SPA_ITEM_TRASHED', 'Item cannot perform this lifecycle transition.', 409);
      let status = 'TRASHED';
      let closedAt = item.closedAt;
      if (restore) {
        await this.assignment(tx, actor, item.assignedUserId);
        const stage = await this.stage(tx, actor, typeId, item.pipelineId, item.stageId);
        const current = await this.currentValues(tx, actor, itemId, snapshot);
        const prepared = await this.validateValues(tx, actor, typeId, snapshot, {}, current);
        status = stage && stage.semantic !== 'PROGRESS' ? 'COMPLETED' : 'ACTIVE';
        closedAt = status === 'COMPLETED' ? item.closedAt ?? new Date() : null;
        const result = await tx.spaItem.update({ where: { id: itemId }, data: { status, closedAt, trashedAt: null, purgeAfter: null,
          version: { increment: 1 }, schemaVersion: type.schemaVersion, updatedByUserId: actor.userId } });
        await this.commitValues(tx, actor, result, snapshot, prepared.result);
        await this.history(tx, actor, result, 'SPA_ITEM_RESTORED', { version: result.version, status });
        return this.projection(tx, actor, result, snapshot);
      }
      const recycling = await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId, key: 'RECYCLE_BIN' } });
      const retention = recycling?.configuration as { retentionDays?: number } | undefined;
      const days = Math.min(3650, Math.max(1, retention?.retentionDays ?? 30));
      const result = await tx.spaItem.update({ where: { id: itemId }, data: { status, trashedAt: new Date(),
        purgeAfter: new Date(Date.now() + days * 86400000), version: { increment: 1 }, updatedByUserId: actor.userId } });
      await this.history(tx, actor, result, 'SPA_ITEM_TRASHED', { version: result.version, purgeAfter: result.purgeAfter!.toISOString() });
      return { id: itemId, status: result.status, version: result.version };
    }, { timeout: 30000 });
  }
  async itemHistory(actor: Principal, typeId: string, itemId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.READ');
    const query = parse(pageQuery, raw);
    return this.db.$transaction(async tx => {
      await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.READ');
      const where = { workspaceId: actor.workspaceId, typeId, itemId };
      const data = await tx.spaHistory.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit, take: query.limit });
      const total = await tx.spaHistory.count({ where });
      return { data, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    });
  }
  async permissionsMe(actor: Principal, typeId: string, itemId: string) {
    requirePermission(actor, 'SPA.ITEM.READ');
    return this.db.$transaction(async tx => {
      const { type, snapshot } = await this.type(tx, actor, typeId);
      const item = await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.READ');
      const actions: string[] = [];
      for (const action of actor.grants.keys()) if (action.startsWith('SPA.ITEM.') && await this.policies.allowed(tx, actor, item, action))
        actions.push(action);
      if (type.status !== 'ACTIVE') actions.splice(0, actions.length, ...actions.filter(a => ['SPA.ITEM.READ', 'SPA.ITEM.EXPORT'].includes(a)));
      const transitions = [];
      if (actions.includes('SPA.ITEM.STAGE_CHANGE')) {
        const pipelines = await tx.spaPipeline.findMany({ where: { workspaceId: actor.workspaceId, typeId, status: 'ACTIVE' }, select: { id: true } });
        const stages = await tx.spaStage.findMany({ where: { workspaceId: actor.workspaceId, pipelineId: { in: pipelines.map(p => p.id) }, status: 'ACTIVE' } });
        for (const stage of stages) if (await this.policies.allowed(tx, actor, { ...item, pipelineId: stage.pipelineId, stageId: stage.id }, 'SPA.ITEM.STAGE_CHANGE'))
          transitions.push({ pipelineId: stage.pipelineId, stageId: stage.id });
      }
      const visibleFields: string[] = [], editableFields: string[] = [];
      for (const field of snapshot.fields) {
        const access = await this.policies.fieldAccess(tx, actor, typeId, field.id);
        if (access.canView) visibleFields.push(field.code);
        if (access.canEdit && field.isActive && item.status !== 'TRASHED' && actions.includes('SPA.ITEM.UPDATE')) editableFields.push(field.code);
      }
      return { actions: item.status === 'TRASHED' ? actions.filter(a => ['SPA.ITEM.READ','SPA.ITEM.RESTORE'].includes(a)) : actions,
        visibleFields, editableFields, transitions: item.status === 'TRASHED' ? [] : transitions };
    });
  }
  async transition(actor: Principal, typeId: string, itemId: string, raw: unknown) {
    return this.db.$transaction(tx => this.transitionInTransaction(tx, actor, typeId, itemId, raw), { timeout: 30000 });
  }
  async transitionInTransaction(tx: Tx, actor: Principal, typeId: string, itemId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.STAGE_CHANGE');
    const input = parse(z.strictObject({ expectedVersion: version, targetPipelineId: uuid, targetStageId: uuid,
      reason: z.string().trim().max(2000).optional() }), raw);
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { type, snapshot } = await this.type(tx, actor, typeId, true);
      const item = await this.load(tx, actor, typeId, itemId, 'SPA.ITEM.STAGE_CHANGE');
      assertVersion(item.version, input.expectedVersion);
      if (item.status === 'TRASHED') throw new AppError('SPA_ITEM_TRASHED', 'Trashed Item cannot transition.', 409);
      const target = await this.stage(tx, actor, typeId, input.targetPipelineId, input.targetStageId);
      if (!target) throw new AppError('SPA_INVALID_TRANSITION', 'Pipeline capability is required.', 422);
      await this.policies.assertItem(tx, actor, { ...item, pipelineId: target.pipelineId, stageId: target.id }, 'SPA.ITEM.STAGE_CHANGE');
      const source = item.stageId ? await tx.spaStage.findFirst({ where: { workspaceId: actor.workspaceId, id: item.stageId } }) : null;
      const current = await this.currentValues(tx, actor, itemId, snapshot);
      const prepared = await this.validateValues(tx, actor, typeId, snapshot, {}, current);
      const required = parse(z.array(z.string().max(64)).max(500), target.requirements);
      for (const fieldCode of required) {
        const field = snapshot.fields.find(f => f.code === fieldCode && f.isActive);
        if (!field || empty(prepared.result.get(fieldCode)))
          throw new AppError('SPA_STAGE_REQUIRED_FIELDS', 'Target Stage requirements are not satisfied.', 422);
      }
      const rules = source ? parse(z.array(z.strictObject({ targetStageId: uuid, allowedRoleIds: z.array(uuid).max(1000).default([]),
        condition: z.json().optional() })).max(500), source.transitionRules) : [];
      if (rules.length) {
        const rule = rules.find(r => r.targetStageId === target.id);
        if (!rule || rule.allowedRoleIds.length && !rule.allowedRoleIds.includes(actor.roleId))
          throw new AppError('SPA_INVALID_TRANSITION', 'Transition is not permitted.', 403);
        if (rule.condition) {
          const operands = new Map<string, OperandDescriptor>();
          for (const field of snapshot.fields) {
            if (!(await this.policies.fieldAccess(tx, actor, typeId, field.id)).canView) continue;
            const dataType = ['INTEGER','DECIMAL'].includes(field.fieldType) ? 'NUMBER' : field.fieldType === 'BOOLEAN' ? 'BOOLEAN'
              : field.fieldType === 'DATE' ? 'DATE' : field.fieldType === 'DATETIME' ? 'DATETIME' : 'TEXT';
            const ref = 'target.customFields.' + field.code;
            operands.set(ref, { ref, label: field.name, dataType, scope: 'CURRENT', supportsChange: false });
          }
          if (validateConditionTree(rule.condition, operands).length || !evaluateConditionTree(rule.condition as ConditionNode,
            operands, ref => { const value = prepared.result.get(ref.replace('target.customFields.', ''));
              return { values: Array.isArray(value) ? value : [value], empty: empty(value) }; }).matched)
            throw new AppError('SPA_INVALID_TRANSITION', 'Transition conditions are not satisfied.', 422);
        }
      }
      const status = target.semantic === 'PROGRESS' ? 'ACTIVE' : 'COMPLETED';
      const result = await tx.spaItem.update({ where: { id: itemId }, data: { pipelineId: target.pipelineId, stageId: target.id,
        status, closedAt: status === 'COMPLETED' ? new Date() : null, schemaVersion: type.schemaVersion,
        version: { increment: 1 }, updatedByUserId: actor.userId } });
      await this.commitValues(tx, actor, result, snapshot, prepared.result);
      await this.history(tx, actor, result, 'SPA_ITEM_STAGE_CHANGED', { oldPipelineId: item.pipelineId, oldStageId: item.stageId,
        newPipelineId: target.pipelineId, newStageId: target.id, semantic: target.semantic, reason: input.reason ?? null,
        enteredAt: new Date().toISOString(), exitedAt: new Date().toISOString(), version: result.version });
      return this.projection(tx, actor, result, snapshot);
  }
  async kanban(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.ITEM.READ');
    const query = parse(z.strictObject({ pipelineId: uuid, page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().max(160).optional(), filters: z.string().max(10000).optional() }), raw);
    return this.db.$transaction(async tx => {
      const { snapshot } = await this.type(tx, actor, typeId);
      if (!await tx.spaCapability.findFirst({ where: { workspaceId: actor.workspaceId, typeId, key: 'KANBAN', enabled: true } }))
        throw new AppError('SPA_CAPABILITY_DISABLED', 'Kanban is disabled.', 409);
      if (!await tx.spaPipeline.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: query.pipelineId, status: 'ACTIVE' } }))
        throw new AppError('SPA_PIPELINE_NOT_FOUND', 'Pipeline was not found.', 404);
      const stages = await tx.spaStage.findMany({ where: { workspaceId: actor.workspaceId, pipelineId: query.pipelineId, status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
      const columns = [];
      for (const stage of stages) {
        const stagePolicy = await tx.spaStagePolicy.findFirst({ where: { workspaceId: actor.workspaceId, typeId,
          stageId: stage.id, roleId: actor.roleId, action: 'SPA.ITEM.READ' } });
        if (stagePolicy?.scope === 'NONE') continue;
        const page = await this.listInTransaction(tx, actor, typeId, { ...query, stageId: stage.id, sortBy: 'updatedAt' });
        columns.push({ stage, items: page.data, count: page.meta.total, meta: page.meta });
      }
      return { pipelineId: query.pipelineId, columns };
    }, { timeout: 30000 });
  }
}

