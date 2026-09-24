import type { PermissionScope } from '../domain';

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'INTEGER',
  'DECIMAL',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'LIST',
  'MULTI_LIST',
  'PHONE',
  'EMAIL',
  'URL',
  'MONEY',
  'USER_REFERENCE',
  'CRM_REFERENCE',
  'FILE',
  'ADDRESS',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Entities registered with the field engine. New entities register through the entity registry, not by editing the engine. */
export type FieldEntityType = string;

export type CustomField = {
  id: string;
  workspaceId: string;
  entityType: FieldEntityType;
  code: string;
  label: string;
  helpText?: string | null;
  fieldType: CustomFieldType;
  isMultiple: boolean;
  isActive: boolean;
  sortOrder: number;
  staticDefaultValue?: unknown;
  validationConfig?: Record<string, unknown> | null;
  referenceConfig?: Record<string, unknown> | null;
  /** Activity fields only: restricts the field to Activities of one custom Activity type. null = all Activities. */
  activityTypeId?: string | null;
  showOnCreate: boolean;
  showOnEdit: boolean;
  showOnDetail: boolean;
  availableAsListColumn: boolean;
  searchable: boolean;
  filterable: boolean;
  sortable: boolean;
  availableInForms: boolean;
  availableInImport: boolean;
  availableInExport: boolean;
  availableInApi: boolean;
  version: number;
  createdByUserId?: string | null;
  updatedByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomFieldOption = {
  id: string;
  workspaceId: string;
  fieldId: string;
  code: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** One typed storage row. Multi-value fields use several ordered rows. */
export type CustomFieldValueRow = {
  id: string;
  workspaceId: string;
  fieldId: string;
  entityType: FieldEntityType;
  entityId: string;
  ordinal: number;
  valueText?: string | null;
  valueInteger?: number | null;
  valueDecimal?: string | null;
  valueBoolean?: boolean | null;
  valueDate?: Date | null;
  valueDateTime?: Date | null;
  valueUuid?: string | null;
  valueJson?: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type TypedValueColumns = Partial<
  Pick<
    CustomFieldValueRow,
    'valueText' | 'valueInteger' | 'valueDecimal' | 'valueBoolean' | 'valueDate' | 'valueDateTime' | 'valueUuid' | 'valueJson'
  >
>;

export type FieldRestrictionSubjectType = 'ROLE' | 'USER' | 'DEPARTMENT' | 'DEPARTMENT_TREE';
export type FieldRestriction = 'HIDDEN' | 'READ_ONLY';

export type FieldVisibilityRule = {
  id: string;
  workspaceId: string;
  fieldId: string;
  subjectType: FieldRestrictionSubjectType;
  subjectId: string;
  restriction: FieldRestriction;
  createdAt: Date;
  updatedAt: Date;
};

export const CONDITION_OPERATORS = [
  'EQ',
  'NEQ',
  'IN',
  'NOT_IN',
  'GT',
  'GTE',
  'LT',
  'LTE',
  'CONTAINS',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type ConditionOperand =
  | { kind: 'SYSTEM'; key: string }
  | { kind: 'CUSTOM'; fieldId: string };

export type ConditionNode =
  | { type: 'GROUP'; operator: 'ALL' | 'ANY'; children: ConditionNode[] }
  | { type: 'PREDICATE'; field: ConditionOperand; operator: ConditionOperator; value?: unknown };

export type FieldRequirement = {
  id: string;
  workspaceId: string;
  entityType: FieldEntityType;
  targetKind: 'SYSTEM' | 'CUSTOM';
  targetSystemFieldKey?: string | null;
  targetCustomFieldId?: string | null;
  pipelineId?: string | null;
  stageId?: string | null;
  isActive: boolean;
  conditions?: ConditionNode | null;
  conditionsVersion: number;
  version: number;
  createdByUserId?: string | null;
  updatedByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomFieldMigrationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export type CustomFieldMigration = {
  id: string;
  workspaceId: string;
  fieldId: string;
  fromType: CustomFieldType;
  toType: CustomFieldType;
  requestedByUserId: string;
  status: CustomFieldMigrationStatus;
  preview: Record<string, unknown>;
  report?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  schemaVersionBefore?: number | null;
  schemaVersionAfter?: number | null;
  idempotencyKey?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
};

export type FieldSchemaVersion = {
  id: string;
  workspaceId: string;
  entityType: FieldEntityType;
  version: number;
  updatedAt: Date;
};

export type FieldViolation = {
  code: string;
  message: string;
  requirementRuleIds?: string[];
};

export type FieldViolations = Record<string, FieldViolation[]>;

/** Normalized (in-memory) value shapes handled by the field type registry. */
export type MoneyValue = { amount: string; currency: string };
export type AddressValue = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
};
export type CrmReferenceValue = { entityType: string; entityId: string };

export type FieldEffectiveAccess = 'HIDDEN' | 'READ_ONLY' | 'EDIT';

/** Permission scope keys used by this module. */
export const FIELD_PERMISSIONS = {
  manageFields: 'custom_fields.manage',
  manageRequirements: 'required_fields.manage',
} as const;

export type ManagePermissionScope = PermissionScope;
