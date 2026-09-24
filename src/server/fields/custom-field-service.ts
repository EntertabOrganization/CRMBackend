import type { ActorContext } from '../access-service';
import { AppError, badRequest, conflict, fieldValidationFailed } from '../errors';
import type { User } from '../domain';
import { applyQuery } from '../query';
import type { ReferenceCheck } from './field-types';
import { fieldTypeRegistry } from './field-types';
import type { FieldSupport } from './support';
import type {
  CustomField,
  CustomFieldOption,
  CustomFieldType,
  FieldRestriction,
  FieldRestrictionSubjectType,
  FieldVisibilityRule,
  FieldViolations,
} from './types';
import { CUSTOM_FIELD_TYPES, FIELD_PERMISSIONS } from './types';

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SEARCHABLE_TYPES: CustomFieldType[] = ['TEXT', 'TEXTAREA', 'PHONE', 'EMAIL', 'URL'];
const FILTERABLE_TYPES: CustomFieldType[] = [
  'TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'LIST', 'MULTI_LIST', 'PHONE', 'EMAIL', 'URL', 'MONEY', 'USER_REFERENCE', 'CRM_REFERENCE',
];
const SORTABLE_TYPES: CustomFieldType[] = [
  'TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'LIST', 'PHONE', 'EMAIL', 'URL', 'MONEY', 'USER_REFERENCE',
];
const REFERENCE_TYPES: CustomFieldType[] = ['USER_REFERENCE', 'CRM_REFERENCE', 'FILE'];
const FLAG_KEYS = [
  'showOnCreate',
  'showOnEdit',
  'showOnDetail',
  'availableAsListColumn',
  'searchable',
  'filterable',
  'sortable',
  'availableInForms',
  'availableInImport',
  'availableInExport',
  'availableInApi',
] as const;

type OptionInput = { code?: string; label?: string; sortOrder?: number };
type RestrictionInput = { subjectType?: string; subjectId?: string; restriction?: string };

export type FieldDependency = { module: string; type: string; id: string; description: string; remediation: string };
export type FieldDependencyProvider = (workspaceId: string, field: CustomField) => FieldDependency[];

/** Deterministic machine code from a label: lower snake_case, safe characters only, bounded length. */
export function generateFieldCode(label: string, isTaken: (code: string) => boolean) {
  let base = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  if (!base) base = 'field';
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  let candidate = base;
  for (let n = 2; isTaken(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

export class CustomFieldDefinitionService {
  private readonly dependencyProviders: FieldDependencyProvider[] = [];

  constructor(private readonly support: FieldSupport) {}

  /** Forms/Import/Automation/Search register here so deactivation can report their dependencies. */
  registerDependencyProvider(provider: FieldDependencyProvider) {
    this.dependencyProviders.push(provider);
  }

  private get store() {
    return this.support.store;
  }

  private manageActor(user: User, workspaceId: string) {
    const actor = this.support.deps.access.actor(user, workspaceId);
    this.support.deps.access.requireWorkspaceScope(actor, FIELD_PERMISSIONS.manageFields);
    return actor;
  }

  // ---- create / read -------------------------------------------------------------------------------------------

  create(user: User, workspaceId: string, input: Record<string, unknown>) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const violations: FieldViolations = {};
      const add = (key: string, code: string, message: string) => (violations[key] ??= []).push({ code, message });

      const entityType = typeof input.entityType === 'string' ? input.entityType : '';
      if (!this.support.deps.registry.has(entityType)) {
        throw new AppError('ENTITY_TYPE_NOT_FIELD_CAPABLE', `${entityType || 'entityType'} does not support custom fields.`, 400);
      }
      const label = typeof input.label === 'string' ? input.label.trim() : '';
      if (!label || label.length > 200) add('label', 'INVALID', 'label is required (max 200 characters).');
      const fieldType = input.fieldType as CustomFieldType;
      if (!CUSTOM_FIELD_TYPES.includes(fieldType)) {
        throw new AppError('CUSTOM_FIELD_TYPE_UNSUPPORTED', 'fieldType is not supported.', 400);
      }
      const handler = fieldTypeRegistry.get(fieldType);
      const isMultiple = handler.intrinsicallyMultiple ? true : input.isMultiple === true;

      let code = '';
      if (input.code !== undefined && input.code !== null && input.code !== '') {
        code = String(input.code);
        if (!CODE_PATTERN.test(code)) add('code', 'INVALID', 'code must be lowercase snake_case (a-z, 0-9, _), starting with a letter, max 64 characters.');
      } else if (label) {
        code = generateFieldCode(label, (candidate) => this.codeTaken(workspaceId, entityType, candidate));
      }
      // Deactivated fields keep their code identity, so they count here too.
      if (code && CODE_PATTERN.test(code) && this.codeTaken(workspaceId, entityType, code)) {
        throw conflict('CUSTOM_FIELD_CODE_CONFLICT', `A custom field with code "${code}" already exists for ${entityType}.`);
      }

      const validationConfig = this.objectOrNull(input.validationConfig, 'validationConfig', add);
      const referenceConfig = this.objectOrNull(input.referenceConfig, 'referenceConfig', add);
      const registeredEntityTypes = this.referenceTargetTypes();
      for (const problem of handler.validateDefinition({ fieldType, isMultiple, validationConfig, referenceConfig }, { registeredEntityTypes })) {
        add(fieldType === 'CRM_REFERENCE' && problem.message.includes('allowedEntityTypes') ? 'referenceConfig' : 'validationConfig', problem.code, problem.message);
      }

      const flags = this.readFlags(input, fieldType, isMultiple, add);
      const activityTypeId = this.readActivityTypeId(workspaceId, entityType, input.activityTypeId, add);

      const optionInputs = Array.isArray(input.options) ? (input.options as OptionInput[]) : [];
      if (!handler.usesOptions && optionInputs.length > 0) add('options', 'INVALID', `${fieldType} fields do not support options.`);
      const now = new Date();
      const field: CustomField = {
        id: this.store.id(),
        workspaceId,
        entityType,
        code,
        label,
        helpText: typeof input.helpText === 'string' ? input.helpText.trim().slice(0, 1000) || null : null,
        fieldType,
        isMultiple,
        isActive: true,
        sortOrder: this.nextSortOrder(workspaceId, entityType, input.sortOrder),
        staticDefaultValue: null,
        validationConfig,
        referenceConfig,
        activityTypeId,
        ...flags,
        version: 1,
        createdByUserId: actor.user.id,
        updatedByUserId: actor.user.id,
        createdAt: now,
        updatedAt: now,
      };

      const options = handler.usesOptions ? this.buildOptions(workspaceId, field.id, optionInputs, add) : [];
      const restrictions = this.buildRestrictions(workspaceId, field.id, input.restrictions, add);

      if (input.staticDefaultValue !== undefined && input.staticDefaultValue !== null) {
        this.applyDefault(field, options, input.staticDefaultValue, add);
      }
      if (Object.keys(violations).length > 0) throw fieldValidationFailed(violations);

      this.store.state.crmCustomFields.push(field);
      this.store.state.crmCustomFieldOptions.push(...options);
      this.store.state.crmFieldVisibilityRules.push(...restrictions);
      const schemaVersion = this.support.bumpSchema(workspaceId, entityType, actor.user.id, 'FIELD_CREATED', { fieldId: field.id });
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.CREATED', 'CrmCustomField', field.id, null, this.auditShape(field), { schemaVersion });
      return this.toAdminDto(field);
    });
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.manageActor(user, workspaceId);
    const truthy = (key: string) => (searchParams.get(key) === null ? undefined : searchParams.get(key) === 'true');
    const filters = {
      entityType: searchParams.get('entityType') ?? undefined,
      fieldType: searchParams.get('fieldType') ?? undefined,
      isActive: truthy('isActive'),
      isMultiple: truthy('isMultiple'),
      searchable: truthy('searchable'),
      filterable: truthy('filterable'),
      availableInApi: truthy('availableInApi'),
    };
    const rows = this.store.state.crmCustomFields.filter(
      (field) =>
        field.workspaceId === actor.workspaceId &&
        (filters.entityType === undefined || field.entityType === filters.entityType) &&
        (filters.fieldType === undefined || field.fieldType === filters.fieldType) &&
        (filters.isActive === undefined || field.isActive === filters.isActive) &&
        (filters.isMultiple === undefined || field.isMultiple === filters.isMultiple) &&
        (filters.searchable === undefined || field.searchable === filters.searchable) &&
        (filters.filterable === undefined || field.filterable === filters.filterable) &&
        (filters.availableInApi === undefined || field.availableInApi === filters.availableInApi),
    );
    const page = Math.max(Number(searchParams.get('page') ?? '1') || 1, 1);
    const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? '20') || 20, 1), 100);
    const result = applyQuery(rows as unknown as Array<CustomField & Record<string, unknown>>, {
      search: searchParams.get('search') ?? undefined,
      page,
      limit,
      sortBy: (searchParams.get('sortBy') ?? undefined) as never,
      sortOrder: searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc',
    }, {
      searchable: ['label', 'code', 'helpText'],
      filterable: [],
      sortable: ['sortOrder', 'label', 'code', 'createdAt', 'entityType', 'fieldType'],
      defaultSortBy: 'sortOrder',
    });
    return {
      data: (result.data as CustomField[]).map((field) => this.toAdminDto(field)),
      meta: result.meta,
    };
  }

  get(user: User, workspaceId: string, fieldId: string) {
    const actor = this.manageActor(user, workspaceId);
    return this.toAdminDto(this.support.field(actor.workspaceId, fieldId));
  }

  // ---- update / lifecycle ---------------------------------------------------------------------------------------

  update(user: User, workspaceId: string, fieldId: string, input: Record<string, unknown>) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      this.support.assertVersion(field.version, input.version);
      for (const immutable of ['id', 'workspaceId', 'entityType', 'code'] as const) {
        if (input[immutable] !== undefined && input[immutable] !== field[immutable]) {
          throw badRequest('CUSTOM_FIELD_IMMUTABLE', `${immutable} cannot be changed after creation.`);
        }
      }
      const before = this.auditShape(field);
      const violations: FieldViolations = {};
      const add = (key: string, code: string, message: string) => (violations[key] ??= []).push({ code, message });
      const handlerBefore = fieldTypeRegistry.get(field.fieldType);
      const hasValues = this.support.valueCount(field.id) > 0;

      const nextType = (input.fieldType ?? field.fieldType) as CustomFieldType;
      if (!CUSTOM_FIELD_TYPES.includes(nextType)) throw new AppError('CUSTOM_FIELD_TYPE_UNSUPPORTED', 'fieldType is not supported.', 400);
      const nextHandler = fieldTypeRegistry.get(nextType);
      const nextMultiple = input.isMultiple !== undefined ? input.isMultiple === true : nextHandler.intrinsicallyMultiple ? true : field.isMultiple;
      const typeChanged = nextType !== field.fieldType;
      const multiplicityShrinks = field.isMultiple && !nextMultiple;
      if (hasValues && (typeChanged || multiplicityShrinks)) {
        throw conflict('CUSTOM_FIELD_TYPE_MIGRATION_REQUIRED', 'Stored values exist. Use the type migration workflow to change the field type or multiplicity.', {
          fieldId: field.id,
          valueCount: this.support.valueCount(field.id),
        });
      }
      if (typeChanged && this.dependentRules(workspaceId, field.id).length > 0) {
        throw conflict('CUSTOM_FIELD_DEPENDENCIES_EXIST', 'Requirement rules depend on this field; resolve them before changing its type.', {
          dependencies: this.dependencies(workspaceId, field),
        });
      }
      if (typeChanged && this.support.optionsOf(field.id).length > 0 && !nextHandler.usesOptions) {
        throw conflict('CUSTOM_FIELD_IN_USE', 'Remove the field options before changing to a type without options.');
      }

      const label = input.label !== undefined ? (typeof input.label === 'string' ? input.label.trim() : '') : field.label;
      if (!label || label.length > 200) add('label', 'INVALID', 'label is required (max 200 characters).');
      const validationConfig = input.validationConfig !== undefined ? this.objectOrNull(input.validationConfig, 'validationConfig', add) : field.validationConfig ?? null;
      const referenceConfig = input.referenceConfig !== undefined ? this.objectOrNull(input.referenceConfig, 'referenceConfig', add) : field.referenceConfig ?? null;
      for (const problem of nextHandler.validateDefinition(
        { fieldType: nextType, isMultiple: nextMultiple, validationConfig, referenceConfig },
        { registeredEntityTypes: this.referenceTargetTypes() },
      )) {
        add(nextType === 'CRM_REFERENCE' && problem.message.includes('allowedEntityTypes') ? 'referenceConfig' : 'validationConfig', problem.code, problem.message);
      }
      // Narrowing reference targets while values exist would orphan stored references.
      if (hasValues && field.fieldType === 'CRM_REFERENCE' && input.referenceConfig !== undefined) {
        const previous = (field.referenceConfig?.allowedEntityTypes as string[] | undefined) ?? [];
        const next = (referenceConfig?.allowedEntityTypes as string[] | undefined) ?? [];
        if (previous.some((item) => !next.includes(item))) {
          throw conflict('CUSTOM_FIELD_TYPE_MIGRATION_REQUIRED', 'Reference target types cannot be narrowed while values exist.');
        }
      }
      const flags = this.readFlags({ ...this.flagsOf(field), ...input }, nextType, nextMultiple, add);

      const draftField: CustomField = { ...field, fieldType: nextType, isMultiple: nextMultiple, validationConfig, referenceConfig };
      const options = this.support.optionsOf(field.id);
      if (input.staticDefaultValue !== undefined) {
        if (input.staticDefaultValue === null) draftField.staticDefaultValue = null;
        else this.applyDefault(draftField, options, input.staticDefaultValue, add);
      } else if (field.staticDefaultValue !== null && field.staticDefaultValue !== undefined && (typeChanged || input.validationConfig !== undefined)) {
        // Existing default must still satisfy the new configuration.
        this.applyDefault(draftField, options, this.defaultToInput(field), add);
      }
      if (Object.keys(violations).length > 0) throw fieldValidationFailed(violations);

      let restrictions: FieldVisibilityRule[] | null = null;
      if (input.restrictions !== undefined) {
        restrictions = this.buildRestrictions(workspaceId, field.id, input.restrictions, add);
        if (Object.keys(violations).length > 0) throw fieldValidationFailed(violations);
        if (restrictions.length > 0 && this.activeRequirementsTargeting(workspaceId, field.id).length > 0) {
          throw conflict('FIELD_REQUIREMENT_CONFIGURATION_CONFLICT', 'A required-field rule targets this field; it cannot be hidden or made read-only for anyone.');
        }
      }

      Object.assign(field, {
        label,
        helpText: input.helpText !== undefined ? (typeof input.helpText === 'string' ? input.helpText.trim().slice(0, 1000) || null : null) : field.helpText,
        fieldType: nextType,
        isMultiple: nextMultiple,
        validationConfig,
        referenceConfig,
        staticDefaultValue: draftField.staticDefaultValue ?? null,
        ...flags,
        updatedByUserId: actor.user.id,
        updatedAt: new Date(),
        version: field.version + 1,
      });
      if (handlerBefore.type !== nextHandler.type && !hasValues) this.store.state.crmCustomFieldOptions = this.store.state.crmCustomFieldOptions.filter((o) => o.fieldId !== field.id || nextHandler.usesOptions);
      if (restrictions) {
        this.store.state.crmFieldVisibilityRules = this.store.state.crmFieldVisibilityRules.filter((rule) => rule.fieldId !== field.id);
        this.store.state.crmFieldVisibilityRules.push(...restrictions);
      }
      const schemaVersion = this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'FIELD_UPDATED', { fieldId: field.id });
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.UPDATED', 'CrmCustomField', field.id, before, this.auditShape(field), { schemaVersion });
      return this.toAdminDto(field);
    });
  }

  activate(user: User, workspaceId: string, fieldId: string, input: { version?: number } = {}) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      if (input.version !== undefined) this.support.assertVersion(field.version, input.version);
      if (!field.isActive) {
        // Reactivation requires the stored configuration to still be valid.
        const handler = fieldTypeRegistry.get(field.fieldType);
        const problems = handler.validateDefinition(
          { fieldType: field.fieldType, isMultiple: field.isMultiple, validationConfig: field.validationConfig, referenceConfig: field.referenceConfig },
          { registeredEntityTypes: this.referenceTargetTypes() },
        );
        if (problems.length > 0) throw fieldValidationFailed({ validationConfig: problems });
        field.isActive = true;
        field.version += 1;
        field.updatedAt = new Date();
        field.updatedByUserId = actor.user.id;
        this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'FIELD_ACTIVATED', { fieldId });
        this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.ACTIVATED', 'CrmCustomField', field.id, { isActive: false }, { isActive: true });
      }
      return this.toAdminDto(field);
    });
  }

  deactivate(user: User, workspaceId: string, fieldId: string, input: { version?: number } = {}) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      if (input.version !== undefined) this.support.assertVersion(field.version, input.version);
      if (field.isActive) {
        const blocking = this.dependencies(workspaceId, field).filter((dependency) => dependency.type !== 'INACTIVE_REQUIREMENT');
        if (blocking.length > 0) {
          throw conflict('CUSTOM_FIELD_DEPENDENCIES_EXIST', 'Active dependencies must be resolved before this field can be deactivated.', { dependencies: blocking });
        }
        field.isActive = false;
        field.version += 1;
        field.updatedAt = new Date();
        field.updatedByUserId = actor.user.id;
        // Values are intentionally preserved; only rendering and new writes stop.
        this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'FIELD_DEACTIVATED', { fieldId });
        this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.DEACTIVATED', 'CrmCustomField', field.id, { isActive: true }, { isActive: false });
      }
      return this.toAdminDto(field);
    });
  }

  hardDelete(user: User, workspaceId: string, fieldId: string) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      if (field.isActive) throw conflict('CUSTOM_FIELD_IN_USE', 'Deactivate the field before deleting it.');
      const valueCount = this.support.valueCount(field.id);
      if (valueCount > 0) throw conflict('CUSTOM_FIELD_IN_USE', 'The field holds stored values and cannot be deleted.', { valueCount });
      const dependencies = this.dependencies(workspaceId, field, true);
      if (dependencies.length > 0) throw conflict('CUSTOM_FIELD_DEPENDENCIES_EXIST', 'Dependencies still reference this field.', { dependencies });
      const before = this.auditShape(field);
      this.store.state.crmCustomFields = this.store.state.crmCustomFields.filter((item) => item.id !== field.id);
      this.store.state.crmCustomFieldOptions = this.store.state.crmCustomFieldOptions.filter((item) => item.fieldId !== field.id);
      this.store.state.crmFieldVisibilityRules = this.store.state.crmFieldVisibilityRules.filter((item) => item.fieldId !== field.id);
      this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'FIELD_HARD_DELETED', { fieldId });
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.HARD_DELETED', 'CrmCustomField', field.id, before, null);
      return { id: field.id, deleted: true };
    });
  }

  reorder(user: User, workspaceId: string, input: { entityType?: string; orderedFieldIds?: string[]; expectedSchemaVersion?: number }) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const ids = input.orderedFieldIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
        throw badRequest('FIELD_REORDER_INVALID', 'orderedFieldIds must be a non-empty array of field ids.');
      }
      if (new Set(ids).size !== ids.length) throw badRequest('FIELD_REORDER_INVALID', 'orderedFieldIds contains duplicates.');
      const fields = ids.map((id) => this.support.field(workspaceId, id));
      const entityType = fields[0].entityType;
      if (fields.some((field) => field.entityType !== entityType) || (input.entityType && input.entityType !== entityType)) {
        throw badRequest('FIELD_REORDER_INVALID', 'All fields must belong to the same entity type.');
      }
      const all = this.support.fieldsFor(workspaceId, entityType);
      if (all.length !== ids.length) throw badRequest('FIELD_REORDER_INVALID', 'orderedFieldIds must contain every field of the entity type exactly once.');
      const current = this.support.schemaVersion(workspaceId, entityType);
      this.support.assertVersion(current, input.expectedSchemaVersion, 'schema');
      ids.forEach((id, index) => {
        const field = fields[index];
        field.sortOrder = (index + 1) * 10;
        field.updatedAt = new Date();
        field.version += 1;
        field.updatedByUserId = actor.user.id;
        void id;
      });
      const schemaVersion = this.support.bumpSchema(workspaceId, entityType, actor.user.id, 'FIELDS_REORDERED');
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.REORDERED', 'CrmCustomField', entityType, null, { orderedFieldIds: ids }, { schemaVersion });
      return { entityType, schemaVersion, fields: fields.map((field) => ({ id: field.id, sortOrder: field.sortOrder, version: field.version })) };
    });
  }

  // ---- options ---------------------------------------------------------------------------------------------------

  listOptions(user: User, workspaceId: string, fieldId: string) {
    const actor = this.manageActor(user, workspaceId);
    const field = this.support.field(actor.workspaceId, fieldId);
    this.assertUsesOptions(field);
    return this.support.optionsOf(field.id).sort((a, b) => a.sortOrder - b.sortOrder).map((option) => ({ ...option, inUse: this.optionInUse(option) }));
  }

  createOption(user: User, workspaceId: string, fieldId: string, input: OptionInput) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      this.assertUsesOptions(field);
      const violations: FieldViolations = {};
      const built = this.buildOptions(workspaceId, field.id, [input], (key, code, message) => (violations[key] ??= []).push({ code, message }), this.support.optionsOf(field.id));
      if (Object.keys(violations).length > 0) throw fieldValidationFailed(violations);
      const option = built[0];
      this.store.state.crmCustomFieldOptions.push(option);
      this.touchField(field, actor);
      const schemaVersion = this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'OPTION_CREATED', { fieldId });
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.OPTION_CREATED', 'CrmCustomFieldOption', option.id, null, option, { schemaVersion });
      return option;
    });
  }

  updateOption(user: User, workspaceId: string, fieldId: string, optionId: string, input: { label?: string; version?: number }) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      const option = this.option(field, optionId);
      this.support.assertVersion(option.version, input.version, 'option');
      const label = typeof input.label === 'string' ? input.label.trim() : '';
      if (!label || label.length > 200) throw fieldValidationFailed({ label: [{ code: 'INVALID', message: 'label is required (max 200 characters).' }] });
      const before = { ...option };
      // Identity (id + code) is immutable; only the display label changes.
      option.label = label;
      option.version += 1;
      option.updatedAt = new Date();
      this.touchField(field, actor);
      this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'OPTION_UPDATED', { fieldId });
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.OPTION_UPDATED', 'CrmCustomFieldOption', option.id, before, option);
      return option;
    });
  }

  setOptionActive(user: User, workspaceId: string, fieldId: string, optionId: string, active: boolean) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      const option = this.option(field, optionId);
      if (option.isActive !== active) {
        option.isActive = active;
        option.version += 1;
        option.updatedAt = new Date();
        this.touchField(field, actor);
        this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, active ? 'OPTION_ACTIVATED' : 'OPTION_DEACTIVATED', { fieldId });
        this.support.audit(workspaceId, actor.user.id, active ? 'CUSTOM_FIELD.OPTION_ACTIVATED' : 'CUSTOM_FIELD.OPTION_DEACTIVATED', 'CrmCustomFieldOption', option.id, { isActive: !active }, { isActive: active });
      }
      return option;
    });
  }

  reorderOptions(user: User, workspaceId: string, fieldId: string, input: { orderedOptionIds?: string[]; expectedSchemaVersion?: number }) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const field = this.support.field(workspaceId, fieldId);
      this.assertUsesOptions(field);
      const options = this.support.optionsOf(field.id);
      const ids = input.orderedOptionIds;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== options.length || ids.some((id) => !options.some((option) => option.id === id))) {
        throw badRequest('FIELD_REORDER_INVALID', 'orderedOptionIds must contain every option of the field exactly once.');
      }
      this.support.assertVersion(this.support.schemaVersion(workspaceId, field.entityType), input.expectedSchemaVersion, 'schema');
      ids.forEach((id, index) => {
        const option = options.find((item) => item.id === id)!;
        option.sortOrder = (index + 1) * 10;
        option.version += 1;
        option.updatedAt = new Date();
      });
      this.touchField(field, actor);
      const schemaVersion = this.support.bumpSchema(workspaceId, field.entityType, actor.user.id, 'OPTIONS_REORDERED', { fieldId });
      this.support.audit(workspaceId, actor.user.id, 'CUSTOM_FIELD.OPTIONS_REORDERED', 'CrmCustomField', field.id, null, { orderedOptionIds: ids }, { schemaVersion });
      return { schemaVersion, options: this.support.optionsOf(field.id).sort((a, b) => a.sortOrder - b.sortOrder) };
    });
  }

  // ---- dependencies ------------------------------------------------------------------------------------------------

  getDependencies(user: User, workspaceId: string, fieldId: string) {
    const actor = this.manageActor(user, workspaceId);
    const field = this.support.field(actor.workspaceId, fieldId);
    const dependencies = this.dependencies(workspaceId, field, true);
    const groups: Record<string, FieldDependency[]> = {};
    for (const dependency of dependencies) (groups[dependency.module] ??= []).push(dependency);
    return { fieldId: field.id, valueCount: this.support.valueCount(field.id), blocking: dependencies.filter((d) => d.type !== 'INACTIVE_REQUIREMENT').length, groups };
  }

  // ---- shared helpers used by the sibling services ----------------------------------------------------------------

  /** Requirement rules (active or not) that use the field as target or as a condition operand. */
  dependentRules(workspaceId: string, fieldId: string, includeInactive = false) {
    return this.store.state.crmFieldRequirements.filter(
      (rule) =>
        rule.workspaceId === workspaceId &&
        (includeInactive || rule.isActive) &&
        (rule.targetCustomFieldId === fieldId || this.conditionUsesField(rule.conditions, fieldId)),
    );
  }

  activeRequirementsTargeting(workspaceId: string, fieldId: string) {
    return this.store.state.crmFieldRequirements.filter((rule) => rule.workspaceId === workspaceId && rule.isActive && rule.targetCustomFieldId === fieldId);
  }

  private conditionUsesField(node: unknown, fieldId: string): boolean {
    if (!node || typeof node !== 'object') return false;
    const candidate = node as { type?: string; field?: { kind?: string; fieldId?: string }; children?: unknown[] };
    if (candidate.field?.kind === 'CUSTOM' && candidate.field.fieldId === fieldId) return true;
    return (candidate.children ?? []).some((child) => this.conditionUsesField(child, fieldId));
  }

  private dependencies(workspaceId: string, field: CustomField, includeInactive = false): FieldDependency[] {
    const out: FieldDependency[] = [];
    for (const rule of this.dependentRules(workspaceId, field.id, true)) {
      if (!rule.isActive && !includeInactive) continue;
      out.push({
        module: 'REQUIRED_FIELDS',
        type: rule.isActive ? 'REQUIREMENT_RULE' : 'INACTIVE_REQUIREMENT',
        id: rule.id,
        description: rule.targetCustomFieldId === field.id ? 'Field is the target of a required-field rule.' : 'Field is used in a required-field condition.',
        remediation: 'Deactivate or edit the rule before changing this field.',
      });
    }
    for (const provider of this.dependencyProviders) out.push(...provider(workspaceId, field));
    return out;
  }

  private option(field: CustomField, optionId: string): CustomFieldOption {
    const option = this.support.optionsOf(field.id).find((item) => item.id === optionId);
    if (!option) throw new AppError('FIELD_OPTION_NOT_FOUND', 'Option was not found.', 404);
    return option;
  }

  private optionInUse(option: CustomFieldOption) {
    return this.store.state.crmCustomFieldValues.some((row) => row.fieldId === option.fieldId && row.valueUuid === option.id);
  }

  private assertUsesOptions(field: CustomField) {
    if (!fieldTypeRegistry.get(field.fieldType).usesOptions) throw badRequest('CUSTOM_FIELD_TYPE_UNSUPPORTED', `${field.fieldType} fields do not use options.`);
  }

  private touchField(field: CustomField, actor: ActorContext) {
    field.version += 1;
    field.updatedAt = new Date();
    field.updatedByUserId = actor.user.id;
  }

  private codeTaken(workspaceId: string, entityType: string, code: string) {
    return this.store.state.crmCustomFields.some((item) => item.workspaceId === workspaceId && item.entityType === entityType && item.code === code);
  }

  private nextSortOrder(workspaceId: string, entityType: string, requested: unknown) {
    if (typeof requested === 'number' && Number.isInteger(requested)) return requested;
    const orders = this.support.fieldsFor(workspaceId, entityType).map((field) => field.sortOrder);
    return (orders.length ? Math.max(...orders) : 0) + 10;
  }

  private referenceTargetTypes() {
    return this.support.deps.registry.types().filter((type) => type !== 'ACTIVITY');
  }

  private objectOrNull(value: unknown, key: string, add: (key: string, code: string, message: string) => void): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      add(key, 'INVALID', `${key} must be an object.`);
      return null;
    }
    return value as Record<string, unknown>;
  }

  private flagsOf(field: CustomField) {
    return Object.fromEntries(FLAG_KEYS.map((key) => [key, field[key]]));
  }

  private readFlags(
    input: Record<string, unknown>,
    fieldType: CustomFieldType,
    isMultiple: boolean,
    add: (key: string, code: string, message: string) => void,
  ) {
    const defaults: Record<(typeof FLAG_KEYS)[number], boolean> = {
      showOnCreate: true,
      showOnEdit: true,
      showOnDetail: true,
      availableAsListColumn: false,
      searchable: false,
      filterable: false,
      sortable: false,
      availableInForms: false,
      availableInImport: false,
      availableInExport: false,
      availableInApi: true,
    };
    const out = { ...defaults };
    for (const key of FLAG_KEYS) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'boolean') add(key, 'INVALID', `${key} must be a boolean.`);
      else out[key] = input[key] as boolean;
    }
    if (out.searchable && !SEARCHABLE_TYPES.includes(fieldType)) add('searchable', 'UNSUPPORTED', `${fieldType} fields cannot be searchable.`);
    if (out.filterable && !FILTERABLE_TYPES.includes(fieldType)) add('filterable', 'UNSUPPORTED', `${fieldType} fields cannot be filterable.`);
    if (out.sortable && (!SORTABLE_TYPES.includes(fieldType) || isMultiple)) add('sortable', 'UNSUPPORTED', `${fieldType}${isMultiple ? ' (multiple)' : ''} fields cannot be sortable.`);
    return out;
  }

  private readActivityTypeId(
    workspaceId: string,
    entityType: string,
    value: unknown,
    add: (key: string, code: string, message: string) => void,
  ): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (entityType !== 'ACTIVITY') {
      add('activityTypeId', 'INVALID', 'activityTypeId only applies to ACTIVITY fields.');
      return null;
    }
    const type = this.store.state.crmActivityTypes.find((item) => item.id === value && item.workspaceId === workspaceId);
    if (!type) {
      add('activityTypeId', 'NOT_FOUND', 'The activity type does not exist.');
      return null;
    }
    return type.id;
  }

  private buildOptions(
    workspaceId: string,
    fieldId: string,
    inputs: OptionInput[],
    add: (key: string, code: string, message: string) => void,
    existing: CustomFieldOption[] = [],
  ) {
    const now = new Date();
    const codes = new Set(existing.map((option) => option.code));
    let nextOrder = (existing.length ? Math.max(...existing.map((option) => option.sortOrder)) : 0) + 10;
    const out: CustomFieldOption[] = [];
    for (const [index, item] of inputs.entries()) {
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      if (!label || label.length > 200) {
        add(`options[${index}].label`, 'INVALID', 'label is required (max 200 characters).');
        continue;
      }
      let code = typeof item.code === 'string' && item.code.trim() ? item.code.trim() : '';
      if (code && !/^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
        add(`options[${index}].code`, 'INVALID', 'option code may only contain letters, numbers, _, . and -.');
        continue;
      }
      if (!code) code = generateFieldCode(label, (candidate) => codes.has(candidate)).toUpperCase();
      if (codes.has(code)) {
        add(`options[${index}].code`, 'DUPLICATE', `Option code "${code}" is already used.`);
        continue;
      }
      codes.add(code);
      out.push({
        id: this.store.id(),
        workspaceId,
        fieldId,
        code,
        label,
        sortOrder: typeof item.sortOrder === 'number' && Number.isInteger(item.sortOrder) ? item.sortOrder : nextOrder,
        isActive: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      nextOrder += 10;
    }
    return out;
  }

  private buildRestrictions(
    workspaceId: string,
    fieldId: string,
    value: unknown,
    add: (key: string, code: string, message: string) => void,
  ): FieldVisibilityRule[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      add('restrictions', 'INVALID', 'restrictions must be an array.');
      return [];
    }
    const out: FieldVisibilityRule[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of (value as RestrictionInput[]).entries()) {
      const subjectType = raw?.subjectType as FieldRestrictionSubjectType;
      const restriction = raw?.restriction as FieldRestriction;
      const subjectId = typeof raw?.subjectId === 'string' ? raw.subjectId : '';
      if (!['ROLE', 'USER', 'DEPARTMENT', 'DEPARTMENT_TREE'].includes(subjectType) || !['HIDDEN', 'READ_ONLY'].includes(restriction) || !subjectId) {
        add(`restrictions[${index}]`, 'INVALID', 'subjectType (ROLE|USER|DEPARTMENT|DEPARTMENT_TREE), subjectId and restriction (HIDDEN|READ_ONLY) are required.');
        continue;
      }
      if (!this.subjectExists(workspaceId, subjectType, subjectId)) {
        add(`restrictions[${index}].subjectId`, 'NOT_FOUND', 'The subject does not exist in this workspace.');
        continue;
      }
      const key = `${subjectType}:${subjectId}`;
      if (seen.has(key)) {
        add(`restrictions[${index}]`, 'DUPLICATE', 'A subject can only appear once; the most restrictive value wins across subjects.');
        continue;
      }
      seen.add(key);
      const now = new Date();
      out.push({ id: this.store.id(), workspaceId, fieldId, subjectType, subjectId, restriction, createdAt: now, updatedAt: now });
    }
    return out;
  }

  private subjectExists(workspaceId: string, subjectType: FieldRestrictionSubjectType, subjectId: string) {
    const s = this.store.state;
    switch (subjectType) {
      case 'ROLE':
        return s.roles.some((role) => role.id === subjectId && role.workspaceId === workspaceId && !role.isDeleted);
      case 'USER':
        return this.support.deps.access.isActiveMember(workspaceId, subjectId);
      default:
        return s.departments.some((department) => department.id === subjectId && department.workspaceId === workspaceId && !department.isDeleted);
    }
  }

  /** Defaults are static typed values only, validated with the same handler as normal writes. */
  private applyDefault(
    field: CustomField,
    options: CustomFieldOption[],
    raw: unknown,
    add: (key: string, code: string, message: string) => void,
  ) {
    if (REFERENCE_TYPES.includes(field.fieldType)) {
      add('staticDefaultValue', 'UNSUPPORTED', `${field.fieldType} fields cannot have a static default.`);
      return;
    }
    const handler = fieldTypeRegistry.get(field.fieldType);
    const ctx = {
      options,
      existingItems: [],
      checkUser: (): ReferenceCheck => 'MISSING',
      isUserSelectable: () => false,
      checkCrmReference: (): ReferenceCheck => 'MISSING',
      checkFile: (): ReferenceCheck => 'UNAVAILABLE',
      registeredEntityTypes: [],
    };
    const items = field.isMultiple ? (Array.isArray(raw) ? raw : [raw]) : [raw];
    if (!field.isMultiple && Array.isArray(raw)) {
      add('staticDefaultValue', 'INVALID', 'A single-value field cannot have an array default.');
      return;
    }
    const parsed: unknown[] = [];
    for (const item of items) {
      const result = handler.parseItem(item, field, ctx);
      if (!result.ok) {
        for (const violation of result.violations) add('staticDefaultValue', violation.code, violation.message);
        return;
      }
      parsed.push(result.value);
    }
    field.staticDefaultValue = field.isMultiple ? parsed : parsed[0];
  }

  private defaultToInput(field: CustomField) {
    return field.staticDefaultValue;
  }

  auditShape(field: CustomField) {
    return {
      id: field.id,
      entityType: field.entityType,
      code: field.code,
      label: field.label,
      fieldType: field.fieldType,
      isMultiple: field.isMultiple,
      isActive: field.isActive,
      version: field.version,
      ...this.flagsOf(field),
    };
  }

  toAdminDto(field: CustomField) {
    const handler = fieldTypeRegistry.get(field.fieldType);
    return {
      ...field,
      options: handler.usesOptions ? this.support.optionsOf(field.id).sort((a, b) => a.sortOrder - b.sortOrder) : undefined,
      restrictions: this.store.state.crmFieldVisibilityRules
        .filter((rule) => rule.fieldId === field.id)
        .map((rule) => ({ id: rule.id, subjectType: rule.subjectType, subjectId: rule.subjectId, restriction: rule.restriction })),
      valueCount: this.support.valueCount(field.id),
      schemaVersion: this.support.schemaVersion(field.workspaceId, field.entityType),
      // Lets the requirement condition builder offer only operators this field type supports.
      conditionOperators: fieldTypeRegistry.operatorsFor(handler.conditionDataType),
    };
  }
}
