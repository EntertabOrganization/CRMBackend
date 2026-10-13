import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { canonical, parse, uuid, version } from '../process-platform/dto';
import { createField, fieldDefinition, patchField, schemaSnapshot, uniqueDefinition,
  emptyFieldValue, normalizedFieldDefault, parseFieldValue, uniqueValueKey, validateDefinition, withOptionIds, type FieldDefinition, type SchemaSnapshot } from './field-metadata';
import { SpaPolicyService } from './policy-service';
import { valueHash } from './migration-service';
import { storedValue, valueColumns } from './item-service';

const draftChanges = z.strictObject({ expectedVersion: version, changes: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ADD_FIELD'), field: createField }),
  z.strictObject({ kind: z.literal('UPDATE_FIELD'), fieldId: uuid, changes: patchField }),
  z.strictObject({ kind: z.literal('DEACTIVATE_FIELD'), fieldId: uuid }),
])).max(500) });

export class SpaSchemaService {
  constructor(private readonly db: PrismaClient) {}
  private async visibleSnapshot(tx: Tx, actor: Principal, typeId: string, snapshot: SchemaSnapshot) {
    const policies = new SpaPolicyService(this.db);
    const visible: FieldDefinition[] = [];
    for (const field of snapshot.fields) if ((await policies.fieldAccess(tx, actor, typeId, field.id)).canView) visible.push(field);
    const codes = new Set(visible.map(f => f.code));
    return { ...snapshot, fields: visible, uniqueConstraints: snapshot.uniqueConstraints.filter(c => c.fieldCodes.every(code => codes.has(code))),
      layouts: snapshot.layouts.map(layout => ({ ...layout, sections: layout.sections.map(section => ({ ...section,
        fieldCodes: section.fieldCodes.filter(code => codes.has(code)) })) })) };
  }
  private async load(tx: Tx, actor: Principal, typeId: string, writable = false) {
    parse(uuid, typeId);
    const type = await tx.spaEntityType.findFirst({ where: { id: typeId, workspaceId: actor.workspaceId, deletedAt: null } });
    if (!type) throw new AppError('SPA_TYPE_NOT_FOUND', 'Smart Process Type was not found.', 404);
    if (writable && type.status === 'ARCHIVED') throw new AppError('SPA_TYPE_ARCHIVED', 'Archived Type is read-only.', 409);
    const draft = await tx.spaSchemaDraft.findUniqueOrThrow({ where: { workspaceId_typeId: { workspaceId: actor.workspaceId, typeId } } });
    return { type, draft, snapshot: parse(schemaSnapshot, draft.snapshot) };
  }
  private async save(tx: Tx, actor: Principal, typeId: string, id: string, snapshot: SchemaSnapshot) {
    for (const field of snapshot.fields) { validateDefinition(field, actor.workspaceId); normalizedFieldDefault(field, actor.workspaceId); }
    if (new Set(snapshot.fields.map(field => field.code)).size !== snapshot.fields.length)
      throw new AppError('SPA_FIELD_CODE_EXISTS', 'Field code already exists.', 409);
    const result = await tx.spaSchemaDraft.update({ where: { id }, data: {
      snapshot: snapshot as Prisma.InputJsonObject, version: { increment: 1 } } });
    await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_SCHEMA_DRAFT_UPDATED', { draftVersion: result.version });
    return result;
  }
  async draft(actor: Principal, typeId: string) {
    requirePermission(actor, 'SPA.SCHEMA.READ');
    return this.db.$transaction(async tx => {
      const { draft, snapshot } = await this.load(tx, actor, typeId);
      return { ...draft, snapshot: await this.visibleSnapshot(tx, actor, typeId, snapshot) };
    });
  }
  async fields(actor: Principal, typeId: string) {
    requirePermission(actor, 'SPA.SCHEMA.READ');
    return this.db.$transaction(async tx => (await this.visibleSnapshot(tx, actor, typeId,
      (await this.load(tx, actor, typeId)).snapshot)).fields);
  }
  async addField(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    const input = parse(createField, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { draft, snapshot } = await this.load(tx, actor, typeId, true);
      const field = withOptionIds(parse(fieldDefinition, { ...input, id: randomUUID() }));
      snapshot.fields.push(field);
      await this.save(tx, actor, typeId, draft.id, snapshot);
      return field;
    });
  }
  async editField(actor: Principal, typeId: string, fieldId: string, raw: unknown, deactivate = false) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    parse(uuid, fieldId);
    const input = deactivate ? parse(z.strictObject({ expectedVersion: version }), raw) : parse(patchField, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { draft, snapshot } = await this.load(tx, actor, typeId, true);
      const index = snapshot.fields.findIndex(field => field.id === fieldId);
      if (index < 0) throw new AppError('SPA_FIELD_NOT_FOUND', 'Field was not found.', 404);
      if (deactivate) assertVersion(snapshot.fields[index].version, (input as { expectedVersion: number }).expectedVersion);
      const changes = deactivate ? { isActive: false } : input;
      const updated = withOptionIds(parse(fieldDefinition, { ...snapshot.fields[index], ...changes,
        version: snapshot.fields[index].version + 1 }));
      snapshot.fields[index] = updated;
      await this.save(tx, actor, typeId, draft.id, snapshot);
      if (deactivate) await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_FIELD_DEACTIVATED', { fieldId, fieldVersion: updated.version });
      return updated;
    });
  }
  async changeDraft(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    const input = parse(draftChanges, raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { draft, snapshot } = await this.load(tx, actor, typeId, true);
      assertVersion(draft.version, input.expectedVersion);
      for (const change of input.changes) {
        if (change.kind === 'ADD_FIELD') snapshot.fields.push(withOptionIds(parse(fieldDefinition, { ...change.field, id: randomUUID() })));
        else {
          const field = snapshot.fields.find(field => field.id === change.fieldId);
          if (!field) throw new AppError('SPA_FIELD_NOT_FOUND', 'Field was not found.', 404);
          Object.assign(field, change.kind === 'DEACTIVATE_FIELD' ? { isActive: false } : change.changes);
          field.version += 1;
        }
      }
      return this.save(tx, actor, typeId, draft.id, snapshot);
    });
  }
  private async existingValues(tx: Tx, actor: Principal, typeId: string, snapshot: SchemaSnapshot,
    convertedValues = new Map<string, { fieldId: string; value: unknown }>()) {
    const items = await tx.spaItem.findMany({ where: { workspaceId: actor.workspaceId, typeId,
      status: { not: 'TRASHED' } }, select: { id: true } });
    const values = new Map(items.map(item => [item.id,
      new Map<string, unknown>(snapshot.fields.map(field => [field.code, normalizedFieldDefault(field, actor.workspaceId)]))]));
    const fields = new Map(snapshot.fields.map(field => [field.id, field]));
    const rows = await tx.spaItemValue.findMany({ where: { workspaceId: actor.workspaceId,
      itemId: { in: items.map(item => item.id) }, fieldId: { in: [...fields.keys()] } } });
    for (const row of rows) {
      const field = fields.get(row.fieldId)!;
      const conversion = convertedValues.get(row.itemId);
      values.get(row.itemId)!.set(field.code, conversion?.fieldId === field.id ? conversion.value : storedValue(row, field));
    }
    return values;
  }
  private duplicateIssues(snapshot: SchemaSnapshot, values: Map<string, Map<string, unknown>>) {
    const issues: Array<{ code: string; fieldCode: string; affectedItems: number }> = [];
    for (const constraint of snapshot.uniqueConstraints) {
      if (constraint.fieldCodes.some(code => !snapshot.fields.some(field => field.code === code)))
        throw new AppError('SPA_FIELD_TYPE_INVALID', 'Constraint references an unavailable field.', 422);
      const groups = new Map<string, number>();
      for (const item of values.values()) {
        const key = uniqueValueKey(constraint, item);
        if (key !== null) groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      const affectedItems = [...groups.values()].filter(count => count > 1).reduce((total, count) => total + count, 0);
      if (affectedItems) issues.push({ code: 'SPA_SCHEMA_DUPLICATE_VALUES', fieldCode: constraint.fieldCodes.join(','), affectedItems });
    }
    return issues;
  }
  /** Impact preview reads existing values and cannot clear or coerce them. */
  private async impact(tx: Tx, actor: Principal, typeId: string, snapshot: SchemaSnapshot, migratedFieldId?: string,
    convertedValues = new Map<string, { fieldId: string; value: unknown }>()) {
    const published = await tx.spaFieldDefinition.findMany({ where: { workspaceId: actor.workspaceId, typeId } });
    const values = await this.existingValues(tx, actor, typeId, snapshot, convertedValues);
    const issues: Array<{ code: string; fieldCode: string; affectedItems: number }> = [];
    for (const field of snapshot.fields) {
      validateDefinition(field, actor.workspaceId);
      const old = published.find(row => row.id === field.id);
      const count = await tx.spaItemValue.count({ where: { workspaceId: actor.workspaceId, fieldId: field.id } });
      if (old && old.fieldType !== field.fieldType && count > 0 && field.id !== migratedFieldId)
        issues.push({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED', fieldCode: field.code, affectedItems: count });
      if (field.isRequired && field.isActive) {
        const missing = [...values.values()].filter(item => emptyFieldValue(item.get(field.code))).length;
        if (missing) issues.push({ code: 'SPA_REQUIRED_FIELD_MISSING', fieldCode: field.code, affectedItems: missing });
      }
      if (field.isActive && (!old || old.fieldType === field.fieldType || field.id === migratedFieldId) &&
          !['USER', 'CRM_REF', 'FILE', 'SPA_REF'].includes(field.fieldType)) {
        let invalid = 0, conversions = 0;
        for (const item of values.values()) {
          const value = item.get(field.code);
          if (emptyFieldValue(value)) continue;
          try {
            const normalized = parseFieldValue(field, value, actor.workspaceId, { registeredEntityTypes: [], checkUser: () => 'MISSING',
              isUserSelectable: () => false, checkCrmReference: () => 'MISSING', checkFile: () => 'MISSING' },
              Array.isArray(value) ? value : [value]);
            if (canonical(normalized) !== canonical(value)) conversions++;
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            invalid++;
          }
        }
        if (invalid) issues.push({ code: 'SPA_ITEM_VALIDATION_FAILED', fieldCode: field.code, affectedItems: invalid });
        if (conversions) issues.push({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED', fieldCode: field.code, affectedItems: conversions });
      }
    }
    for (const old of published) if (!snapshot.fields.some(field => field.id === old.id))
      issues.push({ code: 'SPA_SCHEMA_MIGRATION_REQUIRED', fieldCode: old.code, affectedItems:
        await tx.spaItemValue.count({ where: { workspaceId: actor.workspaceId, fieldId: old.id } }) });
    issues.push(...this.duplicateIssues(snapshot, values));
    return { valid: issues.length === 0, issues };
  }
  async validate(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    const input = parse(z.strictObject({ draftVersion: version }), raw);
    return this.db.$transaction(async tx => {
      const { draft, snapshot } = await this.load(tx, actor, typeId);
      assertVersion(draft.version, input.draftVersion);
      return this.impact(tx, actor, typeId, snapshot);
    });
  }
  async publish(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.PUBLISH', true);
    const input = parse(z.strictObject({ expectedDraftVersion: version, migrationPlanId: uuid.optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { type, draft, snapshot } = await this.load(tx, actor, typeId, true);
      assertVersion(draft.version, input.expectedDraftVersion);
      const job = input.migrationPlanId ? await tx.spaSchemaMigrationJob.findFirst({ where: {
        workspaceId: actor.workspaceId, typeId, id: input.migrationPlanId, status: 'SUCCEEDED', appliedAt: null } }) : null;
      if (input.migrationPlanId && (!job || job.oldVersion !== type.schemaVersion || job.draftId !== draft.id || job.draftVersion !== draft.version))
        throw new AppError('SPA_SCHEMA_MIGRATION_REQUIRED', 'Migration is incomplete or stale.', 422);
      const conversions = job ? await tx.spaSchemaMigrationValue.findMany({ where: { workspaceId: actor.workspaceId, jobId: job.id } }) : [];
      if (job) {
        const previous = await tx.spaSchemaVersion.findUniqueOrThrow({ where: { workspaceId_typeId_versionNumber: {
          workspaceId: actor.workspaceId, typeId, versionNumber: job.oldVersion } } });
        const oldField = parse(schemaSnapshot, previous.snapshot).fields.find(f => f.id === job.fieldId);
        const target = snapshot.fields.find(f => f.id === job.fieldId);
        if (!oldField || !target || target.fieldType !== job.targetType || conversions.length !== job.processedCount ||
          conversions.length !== await tx.spaItemValue.count({ where: { workspaceId: actor.workspaceId, fieldId: job.fieldId } }))
          throw new AppError('SPA_SCHEMA_MIGRATION_REQUIRED', 'Conversion coverage is incomplete.', 422);
        for (const conversion of conversions) {
          const item = await tx.spaItem.findFirst({ where: { workspaceId: actor.workspaceId, typeId, id: conversion.itemId } });
          const row = await tx.spaItemValue.findUnique({ where: { workspaceId_itemId_fieldId: {
            workspaceId: actor.workspaceId, itemId: conversion.itemId, fieldId: job.fieldId } } });
          if (!item || !row || item.version !== conversion.sourceItemVersion || valueHash(storedValue(row, oldField)) !== conversion.sourceHash)
            throw new AppError('SPA_SCHEMA_MIGRATION_REQUIRED', 'Items changed since the migration preview. Queue a fresh preview.', 422);
        }
      }
      const convertedValues = new Map(conversions.map(value => [value.itemId, { fieldId: job!.fieldId, value: value.convertedValue }]));
      const impact = await this.impact(tx, actor, typeId, snapshot, job?.fieldId, convertedValues);
      if (!impact.valid) throw new AppError('SPA_SCHEMA_MIGRATION_REQUIRED', 'Schema has unresolved conversion or required-value impacts.', 422, impact);
      const nextVersion = type.schemaVersion + 1;
      const publication = await tx.spaSchemaVersion.create({ data: { workspaceId: actor.workspaceId, typeId,
        versionNumber: nextVersion, snapshot: snapshot as Prisma.InputJsonObject,
        checksum: createHash('sha256').update(canonical(snapshot)).digest('hex'), publishedBy: actor.userId } });
      for (const field of snapshot.fields) {
        const data = { workspaceId: actor.workspaceId, typeId, code: field.code, name: field.name, fieldType: field.fieldType,
          isRequired: field.isRequired, isMultiple: field.isMultiple, isActive: field.isActive, isSearchable: field.isSearchable,
          options: field.options as Prisma.InputJsonValue, validation: field.validation as Prisma.InputJsonObject,
          ...(field.defaultValue !== undefined && { defaultValue: field.defaultValue === null ? Prisma.JsonNull : field.defaultValue as Prisma.InputJsonValue }), version: field.version };
        await tx.spaFieldDefinition.upsert({ where: { id: field.id }, create: { id: field.id, ...data }, update: data });
      }
      if (snapshot.capabilities) for (const capability of snapshot.capabilities)
        await tx.spaCapability.update({ where: { workspaceId_typeId_key: { workspaceId: actor.workspaceId, typeId, key: capability.key } },
          data: { enabled: capability.enabled, configuration: capability.configuration === null ? Prisma.JsonNull : capability.configuration as Prisma.InputJsonValue } });
      if (job) {
        const field = snapshot.fields.find(f => f.id === job.fieldId)!;
        for (const conversion of conversions) {
          const data = valueColumns(field, conversion.convertedValue);
          await tx.spaItemValue.update({ where: { workspaceId_itemId_fieldId: { workspaceId: actor.workspaceId,
            itemId: conversion.itemId, fieldId: job.fieldId } }, data: { valueText: data.valueText ?? null,
              valueNumber: data.valueNumber ?? null, valueDate: data.valueDate ?? null, valueBoolean: data.valueBoolean ?? null,
              valueJson: data.valueJson ?? Prisma.DbNull, schemaVersion: nextVersion } });
          await tx.spaItem.update({ where: { id: conversion.itemId }, data: { schemaVersion: nextVersion,
            version: { increment: 1 }, updatedByUserId: actor.userId } });
          await tx.spaHistory.create({ data: { workspaceId: actor.workspaceId, typeId, itemId: conversion.itemId,
            actorUserId: actor.userId, action: 'SPA_FIELD_VALUE_MIGRATED', changes: { jobId: job.id, fieldId: job.fieldId,
              oldSchemaVersion: job.oldVersion, newSchemaVersion: nextVersion, originalValueRetainedInJob: true } } });
        }
        await tx.spaSchemaMigrationJob.update({ where: { id: job.id }, data: { appliedAt: new Date() } });
        await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_FIELD_MIGRATION_COMPLETED', { jobId: job.id, schemaVersion: nextVersion,
          processedCount: conversions.length });
      }
      await tx.spaEntityType.update({ where: { id: typeId }, data: { schemaVersion: nextVersion, version: { increment: 1 } } });
      await tx.spaSchemaDraft.update({ where: { id: draft.id }, data: { version: { increment: 1 } } });
      await evidence(tx, actor, 'SPA_TYPE', typeId, 'SPA_SCHEMA_PUBLISHED', { schemaVersion: nextVersion, checksum: publication.checksum });
      return publication;
    });
  }
  async versions(actor: Principal, typeId: string, query: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.READ');
    const input = parse(z.strictObject({ page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20) }), query);
    return this.db.$transaction(async tx => {
      await this.load(tx, actor, typeId);
      const where = { workspaceId: actor.workspaceId, typeId };
      const data = await tx.spaSchemaVersion.findMany({ where, orderBy: { versionNumber: 'desc' },
        skip: (input.page - 1) * input.limit, take: input.limit });
      const total = await tx.spaSchemaVersion.count({ where });
      const projected = [];
      for (const publication of data) projected.push({ ...publication,
        snapshot: await this.visibleSnapshot(tx, actor, typeId, parse(schemaSnapshot, publication.snapshot)) });
      return { data: projected, meta: { ...input, total, totalPages: Math.ceil(total / input.limit) } };
    });
  }
  async uniqueConstraint(actor: Principal, typeId: string, raw: unknown) {
    requirePermission(actor, 'SPA.SCHEMA.MANAGE', true);
    const input = parse(uniqueDefinition.omit({ id: true }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'spa:type:' + typeId);
      const { draft, snapshot } = await this.load(tx, actor, typeId, true);
      if (input.fieldCodes.some(code => !snapshot.fields.some(field => field.code === code && field.isActive)))
        throw new AppError('SPA_FIELD_TYPE_INVALID', 'Constraint references an unavailable field.', 422);
      const constraint = parse(uniqueDefinition, { ...input, id: randomUUID() });
      snapshot.uniqueConstraints.push(constraint);
      const issues = this.duplicateIssues(snapshot, await this.existingValues(tx, actor, typeId, snapshot));
      if (issues.length) throw new AppError('SPA_SCHEMA_DUPLICATE_VALUES', 'Existing Item values conflict with this uniqueness rule.', 422, { issues });
      await this.save(tx, actor, typeId, draft.id, snapshot);
      return constraint;
    });
  }
}
