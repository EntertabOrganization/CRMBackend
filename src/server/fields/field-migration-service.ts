import type { User } from '../domain';
import { AppError, badRequest } from '../errors';
import { emitDomainEvent } from '../events';
import type { FieldTypeContext } from './field-types';
import { fieldTypeRegistry } from './field-types';
import type { CustomFieldDefinitionService } from './custom-field-service';
import type { FieldSupport } from './support';
import type { CustomField, CustomFieldMigration, CustomFieldOption, CustomFieldType, CustomFieldValueRow, MoneyValue } from './types';
import { CUSTOM_FIELD_TYPES, FIELD_PERMISSIONS } from './types';

type MigrationInput = {
  targetType?: CustomFieldType;
  isMultiple?: boolean;
  validationConfig?: Record<string, unknown> | null;
  referenceConfig?: Record<string, unknown> | null;
  staticDefaultValue?: unknown;
  options?: Array<{ code?: string; label?: string }>;
  version?: number;
  idempotencyKey?: string;
};

type ConversionOutcome = { ok: true; value: unknown } | { ok: false; code: string };

const TEXT_LIKE: CustomFieldType[] = ['TEXT', 'TEXTAREA', 'PHONE', 'EMAIL', 'URL'];
const NUMERIC_SOURCES: CustomFieldType[] = ['INTEGER', 'DECIMAL', 'MONEY', ...TEXT_LIKE];
const SAME_TYPE_ONLY: CustomFieldType[] = ['USER_REFERENCE', 'CRM_REFERENCE', 'FILE', 'ADDRESS'];

/**
 * Explicit, all-or-nothing business-data migration for a custom field's type/multiplicity. The original field stays
 * authoritative until every stored value converts; failing values are reported, never silently nulled.
 */
export class FieldMigrationService {
  constructor(
    private readonly support: FieldSupport,
    private readonly definitions: CustomFieldDefinitionService,
  ) {}

  private get store() {
    return this.support.store;
  }

  private manageActor(user: User, workspaceId: string) {
    const actor = this.support.deps.access.actor(user, workspaceId);
    this.support.deps.access.requireWorkspaceScope(actor, FIELD_PERMISSIONS.manageFields);
    return actor;
  }

  preview(user: User, workspaceId: string, fieldId: string, input: MigrationInput) {
    const actor = this.manageActor(user, workspaceId);
    const field = this.support.field(actor.workspaceId, fieldId);
    return this.analyze(field, input);
  }

  start(user: User, workspaceId: string, fieldId: string, input: MigrationInput) {
    const actor = this.manageActor(user, workspaceId);
    if (input.idempotencyKey) {
      const previous = this.store.state.crmCustomFieldMigrations.find(
        (item) => item.workspaceId === workspaceId && item.fieldId === fieldId && item.idempotencyKey === input.idempotencyKey,
      );
      if (previous) return this.toDto(previous);
    }
    const field = this.support.field(workspaceId, fieldId);
    this.support.assertVersion(field.version, input.version);
    const analysis = this.analyze(field, input);
    const now = new Date();
    const migration: CustomFieldMigration = {
      id: this.store.id(),
      workspaceId,
      fieldId,
      fromType: field.fieldType,
      toType: analysis.targetType,
      requestedByUserId: actor.user.id,
      status: 'RUNNING',
      preview: analysis.summary,
      report: null,
      checkpoint: null,
      schemaVersionBefore: this.support.schemaVersion(workspaceId, field.entityType),
      schemaVersionAfter: null,
      idempotencyKey: input.idempotencyKey ?? null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
    };
    this.store.state.crmCustomFieldMigrations.push(migration);
    this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.TYPE_MIGRATION_STARTED', 'CrmCustomField', field.id, { fieldType: field.fieldType }, { fieldType: analysis.targetType });

    if (analysis.blockers.length > 0 || analysis.summary.nonConvertible > 0) {
      migration.status = 'FAILED';
      migration.completedAt = new Date();
      migration.report = { blockers: analysis.blockers, examples: analysis.summary.examples, nonConvertible: analysis.summary.nonConvertible };
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.TYPE_MIGRATION_FAILED', 'CrmCustomField', field.id, null, migration.report);
      return this.toDto(migration);
    }

    try {
      this.store.atomicSync(() => this.cutover(actor.user.id, field, analysis));
    } catch (error) {
      // atomicSync restored the pre-migration state (including the RUNNING record); re-record the failure.
      const failed: CustomFieldMigration = { ...migration, status: 'FAILED', completedAt: new Date(), report: { error: error instanceof Error ? error.message : 'unknown' } };
      this.store.state.crmCustomFieldMigrations = this.store.state.crmCustomFieldMigrations.filter((item) => item.id !== migration.id);
      this.store.state.crmCustomFieldMigrations.push(failed);
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.TYPE_MIGRATION_FAILED', 'CrmCustomField', field.id, null, failed.report);
      return this.toDto(failed);
    }
    const stored = this.store.state.crmCustomFieldMigrations.find((item) => item.id === migration.id)!;
    stored.status = 'COMPLETED';
    stored.completedAt = new Date();
    stored.schemaVersionAfter = this.support.schemaVersion(workspaceId, field.entityType);
    stored.report = { migratedValues: analysis.summary.convertible };
    this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.TYPE_MIGRATION_COMPLETED', 'CrmCustomField', field.id, { fieldType: migration.fromType }, { fieldType: migration.toType }, { migratedValues: analysis.summary.convertible });
    emitDomainEvent(this.store, {
      workspaceId,
      eventType: 'CUSTOM_FIELD_MIGRATION_COMPLETED',
      entityType: 'CUSTOM_FIELD',
      entityId: field.id,
      actorUserId: actor.user.id,
      changes: { entityType: field.entityType, fromType: migration.fromType, toType: migration.toType, schemaVersion: stored.schemaVersionAfter },
    });
    return this.toDto(stored);
  }

  get(user: User, workspaceId: string, fieldId: string, migrationId: string) {
    const actor = this.manageActor(user, workspaceId);
    const migration = this.store.state.crmCustomFieldMigrations.find((item) => item.id === migrationId && item.workspaceId === actor.workspaceId && item.fieldId === fieldId);
    if (!migration) throw new AppError('CUSTOM_FIELD_MIGRATION_NOT_FOUND', 'Migration was not found.', 404);
    return this.toDto(migration);
  }

  // ---- analysis ------------------------------------------------------------------------------------------------------

  private analyze(field: CustomField, input: MigrationInput) {
    const targetType = (input.targetType ?? field.fieldType) as CustomFieldType;
    if (!CUSTOM_FIELD_TYPES.includes(targetType)) throw new AppError('CUSTOM_FIELD_TYPE_UNSUPPORTED', 'targetType is not supported.', 400);
    const targetHandler = fieldTypeRegistry.get(targetType);
    const targetMultiple = targetHandler.intrinsicallyMultiple ? true : input.isMultiple ?? (targetType === field.fieldType ? field.isMultiple : false);
    const targetValidation = input.validationConfig !== undefined ? input.validationConfig : targetType === field.fieldType ? field.validationConfig ?? null : null;
    const targetReference = input.referenceConfig !== undefined ? input.referenceConfig : targetType === field.fieldType ? field.referenceConfig ?? null : null;
    if (targetType === field.fieldType && targetMultiple === field.isMultiple && input.validationConfig === undefined && input.referenceConfig === undefined && !input.options) {
      throw badRequest('CUSTOM_FIELD_MIGRATION_NOOP', 'The target configuration equals the current configuration.');
    }

    const blockers: Array<{ code: string; message: string }> = [];
    for (const problem of targetHandler.validateDefinition(
      { fieldType: targetType, isMultiple: targetMultiple, validationConfig: targetValidation, referenceConfig: targetReference },
      { registeredEntityTypes: this.support.deps.registry.types().filter((type) => type !== 'ACTIVITY') },
    )) {
      blockers.push({ code: problem.code, message: problem.message });
    }
    if (targetType !== field.fieldType && this.definitions.dependentRules(field.workspaceId, field.id).length > 0) {
      blockers.push({ code: 'CUSTOM_FIELD_DEPENDENCIES_EXIST', message: 'Active requirement rules depend on this field.' });
    }
    if (field.staticDefaultValue !== null && field.staticDefaultValue !== undefined && targetType !== field.fieldType && input.staticDefaultValue === undefined) {
      blockers.push({ code: 'DEFAULT_INCOMPATIBLE', message: 'The static default must be replaced or cleared for the new type.' });
    }

    const targetOptions = this.targetOptions(field, targetType, input);
    if (targetHandler.usesOptions && targetOptions.length === 0) blockers.push({ code: 'OPTIONS_REQUIRED', message: 'List fields need at least one option.' });
    const targetField: CustomField = { ...field, fieldType: targetType, isMultiple: targetMultiple, validationConfig: targetValidation, referenceConfig: targetReference };
    const sourceOptions = this.support.optionsOf(field.id);

    const rows = this.store.state.crmCustomFieldValues.filter((row) => row.fieldId === field.id).sort((a, b) => a.ordinal - b.ordinal);
    const byEntity = new Map<string, CustomFieldValueRow[]>();
    for (const row of rows) byEntity.set(row.entityId, [...(byEntity.get(row.entityId) ?? []), row]);

    const converted = new Map<string, unknown[]>();
    const examples: Array<{ entityId: string; reason: string }> = [];
    let convertible = 0;
    let nonConvertible = 0;
    const sourceHandler = fieldTypeRegistry.get(field.fieldType);
    for (const [entityId, entityRows] of byEntity) {
      if (!targetMultiple && entityRows.length > 1) {
        nonConvertible += entityRows.length;
        if (examples.length < 10) examples.push({ entityId, reason: 'MULTIPLE_VALUES_FOR_SINGLE_FIELD' });
        continue;
      }
      const items: unknown[] = [];
      let failed: string | null = null;
      for (const row of entityRows) {
        const item = sourceHandler.deserializeItem(row);
        const outcome = this.convert(field, item, targetField, sourceOptions, targetOptions);
        if (!outcome.ok) {
          failed = outcome.code;
          break;
        }
        items.push(outcome.value);
      }
      if (failed) {
        nonConvertible += entityRows.length;
        if (examples.length < 10) examples.push({ entityId, reason: failed });
      } else {
        convertible += entityRows.length;
        converted.set(entityId, items);
      }
    }

    return {
      targetType,
      targetMultiple,
      targetValidation,
      targetReference,
      targetOptions,
      staticDefaultValue: input.staticDefaultValue,
      blockers,
      converted,
      summary: { totalValues: rows.length, convertible, nonConvertible, examples, affectedEntities: byEntity.size } as {
        totalValues: number;
        convertible: number;
        nonConvertible: number;
        examples: Array<{ entityId: string; reason: string }>;
        affectedEntities: number;
      },
    };
  }

  private targetOptions(field: CustomField, targetType: CustomFieldType, input: MigrationInput): CustomFieldOption[] {
    const handler = fieldTypeRegistry.get(targetType);
    if (!handler.usesOptions) return [];
    const existing = fieldTypeRegistry.get(field.fieldType).usesOptions ? this.support.optionsOf(field.id) : [];
    const now = new Date();
    const created: CustomFieldOption[] = (input.options ?? [])
      .filter((option) => typeof option?.label === 'string' && option.label.trim())
      .map((option, index) => ({
        id: this.store.id(),
        workspaceId: field.workspaceId,
        fieldId: field.id,
        code: (option.code ?? option.label!).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || `OPTION_${index + 1}`,
        label: option.label!.trim(),
        sortOrder: (existing.length + index + 1) * 10,
        isActive: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }));
    return [...existing, ...created];
  }

  private convert(source: CustomField, item: unknown, target: CustomField, sourceOptions: CustomFieldOption[], targetOptions: CustomFieldOption[]): ConversionOutcome {
    const targetHandler = fieldTypeRegistry.get(target.fieldType);
    const sameType = source.fieldType === target.fieldType || (targetHandler.usesOptions && fieldTypeRegistry.get(source.fieldType).usesOptions);
    const ctx: FieldTypeContext = {
      options: targetOptions,
      existingItems: [item],
      checkUser: () => 'OK',
      isUserSelectable: () => true,
      checkCrmReference: () => 'OK',
      checkFile: () => 'OK',
      registeredEntityTypes: this.support.deps.registry.types(),
    };

    let raw: unknown;
    if (sameType) {
      raw = item;
    } else if (SAME_TYPE_ONLY.includes(source.fieldType) || SAME_TYPE_ONLY.includes(target.fieldType)) {
      return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
    } else {
      const text = this.asText(source, item, sourceOptions);
      switch (target.fieldType) {
        case 'TEXT':
        case 'TEXTAREA':
          raw = text;
          break;
        case 'PHONE':
        case 'EMAIL':
        case 'URL':
          if (!TEXT_LIKE.includes(source.fieldType)) return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
          raw = text;
          break;
        case 'INTEGER':
        case 'DECIMAL':
          if (!NUMERIC_SOURCES.includes(source.fieldType) && source.fieldType !== 'BOOLEAN') return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
          raw = source.fieldType === 'MONEY' ? (item as MoneyValue).amount : text;
          break;
        case 'BOOLEAN':
          if (source.fieldType === 'BOOLEAN') raw = item;
          else if (TEXT_LIKE.includes(source.fieldType) && ['true', 'false'].includes(String(text).toLowerCase())) raw = String(text).toLowerCase() === 'true';
          else return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
          break;
        case 'DATE':
          if (source.fieldType === 'DATETIME') raw = String(item).slice(0, 10);
          else if (TEXT_LIKE.includes(source.fieldType)) raw = text;
          else return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
          break;
        case 'DATETIME':
          if (source.fieldType === 'DATE') raw = `${item as string}T00:00:00.000Z`;
          else if (TEXT_LIKE.includes(source.fieldType)) raw = text;
          else return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
          break;
        case 'LIST':
        case 'MULTI_LIST': {
          const wanted = String(text ?? '').trim().toLowerCase();
          const option = targetOptions.find((candidate) => candidate.label.toLowerCase() === wanted || candidate.code.toLowerCase() === wanted);
          if (!option) return { ok: false, code: 'NO_MATCHING_OPTION' };
          raw = option.id;
          break;
        }
        case 'MONEY':
          return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
        default:
          return { ok: false, code: 'TYPE_NOT_CONVERTIBLE' };
      }
    }
    if (raw === null || raw === undefined) return { ok: false, code: 'EMPTY_VALUE' };
    const result = targetHandler.parseItem(raw, target, ctx);
    if (!result.ok) return { ok: false, code: result.violations[0]?.code ?? 'INVALID_VALUE' };
    return { ok: true, value: result.value };
  }

  private asText(source: CustomField, item: unknown, sourceOptions: CustomFieldOption[]): string | null {
    switch (source.fieldType) {
      case 'TEXT':
      case 'TEXTAREA':
      case 'PHONE':
      case 'EMAIL':
      case 'URL':
      case 'DECIMAL':
      case 'DATE':
      case 'DATETIME':
        return String(item);
      case 'INTEGER':
        return String(item);
      case 'BOOLEAN':
        return item ? 'true' : 'false';
      case 'LIST':
      case 'MULTI_LIST':
        return sourceOptions.find((option) => option.id === item)?.label ?? null;
      case 'MONEY':
        return `${(item as MoneyValue).amount} ${(item as MoneyValue).currency}`;
      default:
        return null;
    }
  }

  private cutover(actorUserId: string, field: CustomField, analysis: ReturnType<FieldMigrationService['analyze']>) {
    const sourceOptionsWereUsed = fieldTypeRegistry.get(field.fieldType).usesOptions;
    const targetHandler = fieldTypeRegistry.get(analysis.targetType);
    // Rewrite every value row through the target handler's serialization.
    const now = new Date();
    this.store.state.crmCustomFieldValues = this.store.state.crmCustomFieldValues.filter((row) => row.fieldId !== field.id);
    for (const [entityId, items] of analysis.converted) {
      items.forEach((item, ordinal) => {
        this.store.state.crmCustomFieldValues.push({
          id: this.store.id(),
          workspaceId: field.workspaceId,
          fieldId: field.id,
          entityType: field.entityType,
          entityId,
          ordinal,
          valueText: null,
          valueInteger: null,
          valueDecimal: null,
          valueBoolean: null,
          valueDate: null,
          valueDateTime: null,
          valueUuid: null,
          valueJson: null,
          ...targetHandler.serializeItem(item),
          createdAt: now,
          updatedAt: now,
        });
      });
    }
    if (targetHandler.usesOptions) {
      const known = new Set(this.support.optionsOf(field.id).map((option) => option.id));
      for (const option of analysis.targetOptions) if (!known.has(option.id)) this.store.state.crmCustomFieldOptions.push(option);
    } else if (sourceOptionsWereUsed) {
      this.store.state.crmCustomFieldOptions = this.store.state.crmCustomFieldOptions.filter((option) => option.fieldId !== field.id);
    }
    const typeChanged = analysis.targetType !== field.fieldType;
    field.fieldType = analysis.targetType;
    field.isMultiple = analysis.targetMultiple;
    field.validationConfig = analysis.targetValidation;
    field.referenceConfig = analysis.targetReference;
    if (analysis.staticDefaultValue !== undefined) field.staticDefaultValue = analysis.staticDefaultValue;
    else if (typeChanged) field.staticDefaultValue = null;
    field.version += 1;
    field.updatedAt = now;
    field.updatedByUserId = actorUserId;
    this.support.bumpSchema(field.workspaceId, field.entityType, actorUserId, 'FIELD_TYPE_MIGRATED', { fieldId: field.id });
  }

  toDto(migration: CustomFieldMigration) {
    return migration;
  }
}
