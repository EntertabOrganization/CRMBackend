import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { FieldTypeRegistry, type FieldTypeContext } from '../fields/field-types';
import type { CustomField, CustomFieldType } from '../fields/types';
import { code, name, uuid, version } from '../process-platform/dto';
import { AppError } from '../errors';

export const fieldTypes = ['TEXT','TEXTAREA','INTEGER','DECIMAL','BOOLEAN','DATE','DATETIME','LIST','MULTI_LIST',
  'EMAIL','PHONE','URL','MONEY','USER','CRM_REF','FILE','SPA_REF'] as const;
const validationConfig = z.strictObject({ minimum: z.union([z.string(), z.number()]).optional(),
  maximum: z.union([z.string(), z.number()]).optional(), scale: z.number().int().min(0).max(6).optional(),
  minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(1).max(100000).optional(),
  pattern: z.string().max(200).optional(), trim: z.boolean().optional(), maxItems: z.number().int().min(1).max(100).optional() });
export const optionInput = z.strictObject({ id: uuid.optional(), code, label: name,
  sortOrder: z.number().int().default(0), isActive: z.boolean().default(true) });
export const fieldDefinition = z.strictObject({ id: uuid, code, name, fieldType: z.enum(fieldTypes),
  isRequired: z.boolean().default(false), isMultiple: z.boolean().default(false), isActive: z.boolean().default(true),
  isSearchable: z.boolean().default(false), validation: validationConfig.default({}),
  options: z.array(optionInput).max(500).default([]), defaultValue: z.json().optional(),
  referenceTypeId: uuid.optional(), version: version.default(1) });
export const createField = fieldDefinition.omit({ id: true, version: true });
export const patchField = z.strictObject({ name: name.optional(), validation: validationConfig.optional(),
  options: z.array(optionInput).max(500).optional(), isRequired: z.boolean().optional(), isSearchable: z.boolean().optional() });
export type FieldDefinition = z.infer<typeof fieldDefinition>;
export const relationDefinition = z.strictObject({ id: uuid, code, name: name.optional(),
  targetType: z.enum(['CONTACT','COMPANY','LEAD','DEAL','SPA_ITEM','TASK','PROJECT','EVENT','FILE','PRODUCT','ACTIVITY','DOCUMENT']),
  targetSubtypeId: uuid.optional(), cardinality: z.enum(['ONE','MANY']), isRequired: z.boolean().default(false) });
export const layoutDefinition = z.strictObject({ id: uuid, name, context: z.enum(['CREATE','DETAIL','EDIT']), version: version.default(1),
  sections: z.array(z.strictObject({ id: uuid, name, fieldCodes: z.array(code).max(500) })).max(50) });
export const uniqueDefinition = z.strictObject({ id: uuid, name,
  fieldCodes: z.array(code).min(1).max(8), ignoreNull: z.boolean().default(true), caseInsensitive: z.boolean().default(true) });
export const schemaSnapshot = z.strictObject({ fields: z.array(fieldDefinition).max(500),
  uniqueConstraints: z.array(uniqueDefinition).max(100).default([]),
  relations: z.array(relationDefinition).max(100).default([]), layouts: z.array(layoutDefinition).max(50).default([]),
  capabilities: z.array(z.strictObject({ key: z.string(), enabled: z.boolean(), configuration: z.json() })).optional() });
export type SchemaSnapshot = z.infer<typeof schemaSnapshot>;
const registry = new FieldTypeRegistry();

export function sharedField(field: FieldDefinition, workspaceId: string): CustomField {
  const mapped = ({ USER: 'USER_REFERENCE', CRM_REF: 'CRM_REFERENCE' } as Record<string, CustomFieldType>)[field.fieldType]
    ?? field.fieldType as CustomFieldType;
  return { id: field.id, workspaceId, entityType: 'SPA_ITEM', code: field.code, label: field.name, fieldType: mapped,
    isMultiple: field.isMultiple || field.fieldType === 'MULTI_LIST', isActive: field.isActive, sortOrder: 0,
    validationConfig: field.validation, staticDefaultValue: field.defaultValue,
    referenceConfig: mapped === 'CRM_REFERENCE' ? { allowedEntityTypes: ['CONTACT','COMPANY','DEAL','LEAD'] } : undefined,
    showOnCreate: true, showOnEdit: true, showOnDetail: true, availableAsListColumn: true,
    searchable: field.isSearchable, filterable: field.isSearchable, sortable: field.isSearchable,
    availableInForms: true, availableInImport: true, availableInExport: true, availableInApi: true,
    version: field.version, createdAt: new Date(0), updatedAt: new Date(0) };
}

export function validateDefinition(field: FieldDefinition, workspaceId: string) {
  if (['ID','WORKSPACEID','TYPEID','CREATEDAT','UPDATEDAT','VERSION'].includes(field.code.replace(/_/g, '')))
    throw new AppError('SPA_FIELD_CODE_EXISTS', 'System field codes are reserved.', 422);
  if (new Set(field.options.map(option => option.code)).size !== field.options.length)
    throw new AppError('SPA_FIELD_CODE_EXISTS', 'Option codes must be unique.', 422);
  if (field.fieldType === 'SPA_REF') {
    if (!field.referenceTypeId) throw new AppError('SPA_FIELD_TYPE_INVALID', 'SPA_REF requires a target Type.', 422);
    return;
  }
  const shared = sharedField(field, workspaceId);
  const problems = registry.get(shared.fieldType).validateDefinition({ fieldType: shared.fieldType,
    isMultiple: shared.isMultiple, validationConfig: field.validation,
    referenceConfig: shared.referenceConfig },
    { registeredEntityTypes: ['CONTACT','COMPANY','DEAL','LEAD','SPA_ITEM'] });
  if (problems.length) throw new AppError('SPA_FIELD_TYPE_INVALID', 'Field configuration is invalid.', 422, { problems });
}

export function withOptionIds(field: FieldDefinition): FieldDefinition {
  return { ...field, options: field.options.map(option => ({ ...option, id: option.id ?? randomUUID() })) };
}

/** Reuses the existing typed field engine; reference authority is provided by the owning application service. */
export function parseFieldValue(field: FieldDefinition, value: unknown, workspaceId: string,
  context: Omit<FieldTypeContext, 'options' | 'existingItems'>, existingItems: unknown[] = []): unknown {
  if (value === null || value === undefined || value === '') {
    if (field.isRequired) throw new AppError('SPA_REQUIRED_FIELD_MISSING', 'A required field is missing.', 422, { field: field.code });
    return null;
  }
  const multiple = field.isMultiple || field.fieldType === 'MULTI_LIST';
  const items = multiple ? value : [value];
  if (!Array.isArray(items) || items.length > (field.validation.maxItems ?? 100) || multiple && !Array.isArray(value))
    throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'Field multiplicity is invalid.', 422, { field: field.code });
  if (field.isRequired && items.length === 0)
    throw new AppError('SPA_REQUIRED_FIELD_MISSING', 'A required field is missing.', 422, { field: field.code });
  const shared = sharedField(field, workspaceId);
  const parsed = items.map(item => {
    if (field.fieldType === 'SPA_REF') {
      const result = uuid.safeParse(item);
      if (!result.success || context.checkCrmReference('SPA_ITEM', result.data) !== 'OK')
        throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'SPA reference is inaccessible.', 422, { field: field.code });
      return result.data;
    }
    const result = registry.get(shared.fieldType).parseItem(item, shared, { ...context, existingItems,
      options: field.options.map(option => ({ ...option, id: option.id!, workspaceId, fieldId: field.id,
        version: 1, createdAt: new Date(0), updatedAt: new Date(0) })) });
    if (!result.ok) throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'Field value is invalid.', 422,
      { field: field.code, violations: result.violations });
    return result.value;
  });
  if (multiple && ['LIST','MULTI_LIST','USER','CRM_REF','FILE','SPA_REF'].includes(field.fieldType) &&
      new Set(parsed.map(item => JSON.stringify(item))).size !== parsed.length)
    throw new AppError('SPA_ITEM_VALIDATION_FAILED', 'Duplicate multiple values are not allowed.', 422);
  return multiple ? parsed : parsed[0];
}
