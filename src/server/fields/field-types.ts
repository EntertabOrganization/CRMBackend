import { canonicalDecimal, compareDecimals, decimalToScaled } from './decimal';
import type {
  AddressValue,
  ConditionOperator,
  CrmReferenceValue,
  CustomField,
  CustomFieldOption,
  CustomFieldType,
  CustomFieldValueRow,
  FieldViolation,
  MoneyValue,
  TypedValueColumns,
} from './types';

export type ParseResult<T = unknown> = { ok: true; value: T } | { ok: false; violations: FieldViolation[] };

export type ReferenceCheck = 'OK' | 'MISSING' | 'FORBIDDEN' | 'UNAVAILABLE';

/** Everything a handler needs from the outside world. Supplied by the value service so handlers stay pure/testable. */
export type FieldTypeContext = {
  options: CustomFieldOption[];
  /** Already stored (normalized) items for this field; unchanged historical items are preserved even when inactive. */
  existingItems: unknown[];
  checkUser(userId: string): ReferenceCheck;
  isUserSelectable(userId: string): boolean;
  checkCrmReference(entityType: string, entityId: string): ReferenceCheck;
  checkFile(fileId: string): ReferenceCheck;
  registeredEntityTypes: string[];
};

export type ConditionDataType = 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'DATE' | 'DATETIME' | 'ENUM';

export type DefinitionDraft = {
  fieldType: CustomFieldType;
  isMultiple: boolean;
  validationConfig: Record<string, unknown> | null | undefined;
  referenceConfig: Record<string, unknown> | null | undefined;
};

export interface FieldTypeHandler {
  readonly type: CustomFieldType;
  readonly supportsMultiple: boolean;
  readonly intrinsicallyMultiple: boolean;
  readonly usesOptions: boolean;
  readonly conditionDataType: ConditionDataType;
  /** Config-time validation. Invalid configuration is rejected when the admin saves, never deferred to record writes. */
  validateDefinition(draft: DefinitionDraft, context: { registeredEntityTypes: string[] }): FieldViolation[];
  /** Normalizes and validates one item. */
  parseItem(input: unknown, field: CustomField, ctx: FieldTypeContext): ParseResult;
  serializeItem(value: unknown): TypedValueColumns;
  deserializeItem(row: CustomFieldValueRow): unknown;
  /** Public API shape for one item. */
  toApi(value: unknown): unknown;
  /** Value used by the condition evaluator (numbers as scaled bigint, dates as epoch ms, text/enum as string). */
  comparable(value: unknown): string | number | bigint | boolean | null;
  isEmptyItem(value: unknown): boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const INT32_MAX = 2_147_483_647;
const MAX_TEXT_LENGTH = 100_000;
const MAX_REGEX_INPUT = 10_000;
const MAX_ITEMS = 100;

const violation = (code: string, message: string): FieldViolation => ({ code, message });
const fail = (code: string, message: string): ParseResult => ({ ok: false, violations: [violation(code, message)] });
const okResult = (value: unknown): ParseResult => ({ ok: true, value });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(config: Record<string, unknown> | null | undefined, allowed: string[], label: string): FieldViolation[] {
  if (!config) return [];
  const unknown = Object.keys(config).filter((key) => !allowed.includes(key));
  return unknown.map((key) => violation('CONFIG_UNKNOWN_KEY', `${label} does not support "${key}".`));
}

function numberConfig(config: Record<string, unknown> | null | undefined, key: string, integer = false): { value?: number; error?: FieldViolation } {
  const raw = config?.[key];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'number' || !Number.isFinite(raw) || (integer && !Number.isInteger(raw))) {
    return { error: violation('CONFIG_INVALID', `${key} must be ${integer ? 'an integer' : 'a number'}.`) };
  }
  return { value: raw };
}

/** Rejects patterns that are unsafe to run against user input (catastrophic backtracking heuristics + size limits). */
export function validateSafePattern(pattern: unknown): FieldViolation | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return violation('CONFIG_INVALID', 'pattern must be a non-empty string.');
  if (pattern.length > 200) return violation('CONFIG_INVALID', 'pattern must be at most 200 characters.');
  if (/\\[1-9]/.test(pattern)) return violation('CONFIG_INVALID', 'pattern must not use backreferences.');
  if (/\(\?<?[=!]/.test(pattern)) return violation('CONFIG_INVALID', 'pattern must not use lookaround assertions.');
  // Nested quantifiers such as (a+)+ or (a*)* are the classic catastrophic-backtracking shapes.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) {
    return violation('CONFIG_INVALID', 'pattern contains nested quantifiers and is not allowed.');
  }
  try {
    new RegExp(pattern);
  } catch {
    return violation('CONFIG_INVALID', 'pattern is not a valid regular expression.');
  }
  return null;
}

function validateMultiplicity(draft: DefinitionDraft, handler: { supportsMultiple: boolean; intrinsicallyMultiple: boolean }): FieldViolation[] {
  const out: FieldViolation[] = [];
  if (draft.isMultiple && !handler.supportsMultiple) {
    out.push(violation('CONFIG_MULTIPLE_UNSUPPORTED', `${draft.fieldType} fields cannot hold multiple values.`));
  }
  if (handler.intrinsicallyMultiple && !draft.isMultiple) {
    out.push(violation('CONFIG_MULTIPLE_REQUIRED', `${draft.fieldType} fields are always multiple.`));
  }
  const maxItems = numberConfig(draft.validationConfig, 'maxItems', true);
  if (maxItems.error) out.push(maxItems.error);
  else if (maxItems.value !== undefined && (maxItems.value < 1 || maxItems.value > MAX_ITEMS)) {
    out.push(violation('CONFIG_INVALID', `maxItems must be between 1 and ${MAX_ITEMS}.`));
  }
  if (maxItems.value !== undefined && !draft.isMultiple) {
    out.push(violation('CONFIG_INVALID', 'maxItems only applies to multiple fields.'));
  }
  return out;
}

abstract class BaseHandler implements FieldTypeHandler {
  abstract readonly type: CustomFieldType;
  readonly supportsMultiple: boolean = true;
  readonly intrinsicallyMultiple: boolean = false;
  readonly usesOptions: boolean = false;
  abstract readonly conditionDataType: ConditionDataType;
  protected readonly allowedConfigKeys: string[] = [];

  validateDefinition(draft: DefinitionDraft, context: { registeredEntityTypes: string[] }): FieldViolation[] {
    const out = validateMultiplicity(draft, this);
    out.push(...unknownKeys(draft.validationConfig, ['maxItems', ...this.allowedConfigKeys], `${draft.fieldType} validationConfig`));
    out.push(...this.validateConfig(draft, context));
    out.push(...unknownKeys(draft.referenceConfig, this.allowedReferenceKeys(), `${draft.fieldType} referenceConfig`));
    return out;
  }

  protected allowedReferenceKeys(): string[] {
    return [];
  }

  protected validateConfig(_draft: DefinitionDraft, _context: { registeredEntityTypes: string[] }): FieldViolation[] {
    return [];
  }

  abstract parseItem(input: unknown, field: CustomField, ctx: FieldTypeContext): ParseResult;
  abstract serializeItem(value: unknown): TypedValueColumns;
  abstract deserializeItem(row: CustomFieldValueRow): unknown;

  toApi(value: unknown): unknown {
    return value;
  }

  comparable(value: unknown): string | number | bigint | boolean | null {
    return value === undefined || value === null ? null : String(value);
  }

  isEmptyItem(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  }
}

class TextHandler extends BaseHandler {
  readonly conditionDataType = 'TEXT' as const;
  protected readonly allowedConfigKeys = ['minLength', 'maxLength', 'pattern', 'trim'];
  constructor(readonly type: CustomFieldType) {
    super();
  }

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    const min = numberConfig(draft.validationConfig, 'minLength', true);
    const max = numberConfig(draft.validationConfig, 'maxLength', true);
    if (min.error) out.push(min.error);
    if (max.error) out.push(max.error);
    if (min.value !== undefined && min.value < 0) out.push(violation('CONFIG_INVALID', 'minLength must be >= 0.'));
    if (max.value !== undefined && (max.value < 1 || max.value > MAX_TEXT_LENGTH)) {
      out.push(violation('CONFIG_INVALID', `maxLength must be between 1 and ${MAX_TEXT_LENGTH}.`));
    }
    if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
      out.push(violation('CONFIG_INVALID', 'minLength cannot exceed maxLength.'));
    }
    if (draft.validationConfig?.pattern !== undefined) {
      const problem = validateSafePattern(draft.validationConfig.pattern);
      if (problem) out.push(problem);
    }
    if (draft.validationConfig?.trim !== undefined && typeof draft.validationConfig.trim !== 'boolean') {
      out.push(violation('CONFIG_INVALID', 'trim must be a boolean.'));
    }
    return out;
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    if (typeof input !== 'string') return fail('INVALID_TYPE', 'A text value is required.');
    const config = field.validationConfig ?? {};
    const value = config.trim === false ? input : input.trim();
    if (value.length > MAX_TEXT_LENGTH) return fail('MAX_LENGTH', `Maximum length is ${MAX_TEXT_LENGTH}.`);
    if (typeof config.minLength === 'number' && value.length < config.minLength) {
      return fail('MIN_LENGTH', `Minimum length is ${config.minLength}.`);
    }
    if (typeof config.maxLength === 'number' && value.length > config.maxLength) {
      return fail('MAX_LENGTH', `Maximum length is ${config.maxLength}.`);
    }
    if (typeof config.pattern === 'string' && value !== '') {
      if (value.length > MAX_REGEX_INPUT) return fail('PATTERN_MISMATCH', 'Value is too long to validate.');
      if (!new RegExp(config.pattern).test(value)) return fail('PATTERN_MISMATCH', 'Value does not match the required format.');
    }
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueText: value as string };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueText ?? null;
  }
}

class ContactStringHandler extends BaseHandler {
  readonly conditionDataType = 'TEXT' as const;
  protected readonly allowedConfigKeys = ['maxLength'];
  constructor(readonly type: 'PHONE' | 'EMAIL' | 'URL') {
    super();
  }

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const max = numberConfig(draft.validationConfig, 'maxLength', true);
    if (max.error) return [max.error];
    if (max.value !== undefined && (max.value < 1 || max.value > 2048)) return [violation('CONFIG_INVALID', 'maxLength must be between 1 and 2048.')];
    return [];
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    if (typeof input !== 'string') return fail('INVALID_TYPE', 'A text value is required.');
    const raw = input.trim();
    const maxLength = typeof field.validationConfig?.maxLength === 'number' ? field.validationConfig.maxLength : 2048;
    if (raw.length > maxLength) return fail('MAX_LENGTH', `Maximum length is ${maxLength}.`);
    if (this.type === 'EMAIL') {
      const email = raw.toLowerCase();
      return EMAIL_PATTERN.test(email) ? okResult(email) : fail('INVALID_EMAIL', 'A valid email address is required.');
    }
    if (this.type === 'PHONE') {
      // Syntax only: we never claim the number is reachable or owned by the contact.
      const compact = raw.replace(/[\s().-]/g, '');
      if (!/^\+?\d{5,15}$/.test(compact)) return fail('INVALID_PHONE', 'A valid phone number is required.');
      return okResult(compact);
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('INVALID_URL', 'Only http and https URLs are allowed.');
      return okResult(url.toString());
    } catch {
      return fail('INVALID_URL', 'A valid URL is required.');
    }
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueText: value as string };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueText ?? null;
  }
}

class IntegerHandler extends BaseHandler {
  readonly type = 'INTEGER' as const;
  readonly conditionDataType = 'NUMBER' as const;
  protected readonly allowedConfigKeys = ['minimum', 'maximum'];

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    const min = numberConfig(draft.validationConfig, 'minimum', true);
    const max = numberConfig(draft.validationConfig, 'maximum', true);
    if (min.error) out.push(min.error);
    if (max.error) out.push(max.error);
    if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
      out.push(violation('CONFIG_INVALID', 'minimum cannot exceed maximum.'));
    }
    return out;
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    let value: number;
    if (typeof input === 'number') value = input;
    else if (typeof input === 'string' && /^-?\d+$/.test(input.trim())) value = Number(input.trim());
    else return fail('INVALID_TYPE', 'An integer is required.');
    if (!Number.isInteger(value) || Math.abs(value) > INT32_MAX) return fail('INVALID_TYPE', 'An integer within the supported range is required.');
    const config = field.validationConfig ?? {};
    if (typeof config.minimum === 'number' && value < config.minimum) return fail('MIN_VALUE', `Minimum allowed value is ${config.minimum}.`);
    if (typeof config.maximum === 'number' && value > config.maximum) return fail('MAX_VALUE', `Maximum allowed value is ${config.maximum}.`);
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueInteger: value as number };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueInteger ?? null;
  }

  comparable(value: unknown) {
    return typeof value === 'number' ? decimalToScaled(value) : null;
  }

  isEmptyItem(value: unknown) {
    return value === undefined || value === null;
  }
}

class DecimalHandler extends BaseHandler {
  readonly type = 'DECIMAL' as const;
  readonly conditionDataType = 'NUMBER' as const;
  protected readonly allowedConfigKeys = ['minimum', 'maximum', 'scale'];

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    for (const key of ['minimum', 'maximum']) {
      const raw = draft.validationConfig?.[key];
      if (raw !== undefined && raw !== null && canonicalDecimal(raw) === null) out.push(violation('CONFIG_INVALID', `${key} must be a decimal.`));
    }
    const scale = numberConfig(draft.validationConfig, 'scale', true);
    if (scale.error) out.push(scale.error);
    else if (scale.value !== undefined && (scale.value < 0 || scale.value > 8)) out.push(violation('CONFIG_INVALID', 'scale must be between 0 and 8.'));
    const min = draft.validationConfig?.minimum;
    const max = draft.validationConfig?.maximum;
    if (min !== undefined && max !== undefined && (compareDecimals(min, max) ?? 0) > 0) {
      out.push(violation('CONFIG_INVALID', 'minimum cannot exceed maximum.'));
    }
    return out;
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    const scale = typeof field.validationConfig?.scale === 'number' ? field.validationConfig.scale : 8;
    const value = canonicalDecimal(input, scale);
    if (value === null) return fail('INVALID_TYPE', `A decimal with at most ${scale} fractional digits is required.`);
    const config = field.validationConfig ?? {};
    if (config.minimum !== undefined && (compareDecimals(value, config.minimum) ?? 0) < 0) {
      return fail('MIN_VALUE', `Minimum allowed value is ${config.minimum}.`);
    }
    if (config.maximum !== undefined && (compareDecimals(value, config.maximum) ?? 0) > 0) {
      return fail('MAX_VALUE', `Maximum allowed value is ${config.maximum}.`);
    }
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueDecimal: value as string };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueDecimal == null ? null : canonicalDecimal(row.valueDecimal);
  }

  comparable(value: unknown) {
    return typeof value === 'string' ? decimalToScaled(value) : null;
  }
}

class BooleanHandler extends BaseHandler {
  readonly type = 'BOOLEAN' as const;
  readonly supportsMultiple = false;
  readonly conditionDataType = 'BOOLEAN' as const;

  parseItem(input: unknown): ParseResult {
    return typeof input === 'boolean' ? okResult(input) : fail('INVALID_TYPE', 'A boolean is required.');
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueBoolean: value as boolean };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueBoolean ?? null;
  }

  comparable(value: unknown) {
    return typeof value === 'boolean' ? value : null;
  }

  isEmptyItem(value: unknown) {
    return value === undefined || value === null;
  }
}

function isValidDate(text: string) {
  if (!DATE_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
}

class DateHandler extends BaseHandler {
  readonly type = 'DATE' as const;
  readonly conditionDataType = 'DATE' as const;
  protected readonly allowedConfigKeys = ['minimum', 'maximum'];

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    for (const key of ['minimum', 'maximum']) {
      const raw = draft.validationConfig?.[key];
      if (raw !== undefined && raw !== null && (typeof raw !== 'string' || !isValidDate(raw))) out.push(violation('CONFIG_INVALID', `${key} must be a YYYY-MM-DD date.`));
    }
    return out;
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    if (typeof input !== 'string' || !isValidDate(input.trim())) return fail('INVALID_TYPE', 'A date in YYYY-MM-DD format is required.');
    const value = input.trim();
    const config = field.validationConfig ?? {};
    if (typeof config.minimum === 'string' && value < config.minimum) return fail('MIN_VALUE', `Earliest allowed date is ${config.minimum}.`);
    if (typeof config.maximum === 'string' && value > config.maximum) return fail('MAX_VALUE', `Latest allowed date is ${config.maximum}.`);
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueDate: new Date(`${value as string}T00:00:00.000Z`) };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueDate ? new Date(row.valueDate).toISOString().slice(0, 10) : null;
  }

  comparable(value: unknown) {
    return typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`).getTime() : null;
  }
}

class DateTimeHandler extends BaseHandler {
  readonly type = 'DATETIME' as const;
  readonly conditionDataType = 'DATETIME' as const;
  protected readonly allowedConfigKeys = ['minimum', 'maximum'];

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    for (const key of ['minimum', 'maximum']) {
      const raw = draft.validationConfig?.[key];
      if (raw !== undefined && raw !== null && (typeof raw !== 'string' || Number.isNaN(Date.parse(raw)))) out.push(violation('CONFIG_INVALID', `${key} must be an ISO-8601 date-time.`));
    }
    return out;
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    // Real instants only: require an explicit offset/Z so values never silently depend on a server timezone.
    if (typeof input !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(input.trim()) || Number.isNaN(Date.parse(input))) {
      return fail('INVALID_TYPE', 'An ISO-8601 date-time with a timezone offset is required.');
    }
    const value = new Date(input).toISOString();
    const config = field.validationConfig ?? {};
    if (typeof config.minimum === 'string' && Date.parse(value) < Date.parse(config.minimum)) return fail('MIN_VALUE', `Earliest allowed value is ${config.minimum}.`);
    if (typeof config.maximum === 'string' && Date.parse(value) > Date.parse(config.maximum)) return fail('MAX_VALUE', `Latest allowed value is ${config.maximum}.`);
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueDateTime: new Date(value as string) };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueDateTime ? new Date(row.valueDateTime).toISOString() : null;
  }

  comparable(value: unknown) {
    return typeof value === 'string' ? Date.parse(value) : null;
  }
}

class ListHandler extends BaseHandler {
  readonly conditionDataType = 'ENUM' as const;
  readonly usesOptions = true;
  protected readonly allowedConfigKeys = ['maxItems'];
  readonly intrinsicallyMultiple: boolean;

  constructor(readonly type: 'LIST' | 'MULTI_LIST') {
    super();
    this.intrinsicallyMultiple = type === 'MULTI_LIST';
  }

  parseItem(input: unknown, field: CustomField, ctx: FieldTypeContext): ParseResult {
    if (typeof input !== 'string' || input.trim() === '') return fail('INVALID_TYPE', 'An option is required.');
    const key = input.trim();
    const option = ctx.options.find((item) => item.id === key) ?? ctx.options.find((item) => item.code.toLowerCase() === key.toLowerCase());
    if (!option) return fail('FIELD_OPTION_NOT_FOUND', 'The selected option does not exist.');
    // A deactivated option may only be kept when the record already holds it; it can never be newly selected.
    if (!option.isActive && !ctx.existingItems.includes(option.id)) return fail('FIELD_OPTION_INACTIVE', 'The selected option is no longer available.');
    return okResult(option.id);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueUuid: value as string };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueUuid ?? null;
  }
}

class MoneyHandler extends BaseHandler {
  readonly type = 'MONEY' as const;
  readonly supportsMultiple = false;
  readonly conditionDataType = 'NUMBER' as const;
  protected readonly allowedConfigKeys = ['minimum', 'maximum', 'currencies'];

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    for (const key of ['minimum', 'maximum']) {
      const raw = draft.validationConfig?.[key];
      if (raw !== undefined && raw !== null && canonicalDecimal(raw) === null) out.push(violation('CONFIG_INVALID', `${key} must be a decimal.`));
    }
    const currencies = draft.validationConfig?.currencies;
    if (currencies !== undefined && (!Array.isArray(currencies) || currencies.some((code) => typeof code !== 'string' || !CURRENCY_PATTERN.test(code)))) {
      out.push(violation('CONFIG_INVALID', 'currencies must be an array of 3-letter uppercase currency codes.'));
    }
    return out;
  }

  parseItem(input: unknown, field: CustomField): ParseResult {
    if (!isPlainObject(input)) return fail('INVALID_TYPE', 'A money value {amount, currency} is required.');
    const extra = Object.keys(input).filter((key) => key !== 'amount' && key !== 'currency');
    if (extra.length > 0) return fail('INVALID_TYPE', 'Money values only support amount and currency.');
    const amount = canonicalDecimal(input.amount);
    if (amount === null) return fail('INVALID_TYPE', 'A valid decimal amount is required.');
    const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
    if (!CURRENCY_PATTERN.test(currency)) return fail('INVALID_CURRENCY', 'A 3-letter currency code is required.');
    const config = field.validationConfig ?? {};
    if (Array.isArray(config.currencies) && !config.currencies.includes(currency)) return fail('INVALID_CURRENCY', 'This currency is not allowed for the field.');
    if (config.minimum !== undefined && (compareDecimals(amount, config.minimum) ?? 0) < 0) return fail('MIN_VALUE', `Minimum allowed amount is ${config.minimum}.`);
    if (config.maximum !== undefined && (compareDecimals(amount, config.maximum) ?? 0) > 0) return fail('MAX_VALUE', `Maximum allowed amount is ${config.maximum}.`);
    return okResult({ amount, currency } satisfies MoneyValue);
  }

  serializeItem(value: unknown): TypedValueColumns {
    const money = value as MoneyValue;
    return { valueDecimal: money.amount, valueText: money.currency };
  }

  deserializeItem(row: CustomFieldValueRow) {
    if (row.valueDecimal == null || !row.valueText) return null;
    return { amount: canonicalDecimal(row.valueDecimal) as string, currency: row.valueText } satisfies MoneyValue;
  }

  comparable(value: unknown) {
    const money = value as MoneyValue | null;
    return money ? decimalToScaled(money.amount) : null;
  }

  isEmptyItem(value: unknown) {
    return value === undefined || value === null;
  }
}

class UserReferenceHandler extends BaseHandler {
  readonly type = 'USER_REFERENCE' as const;
  readonly conditionDataType = 'ENUM' as const;

  parseItem(input: unknown, _field: CustomField, ctx: FieldTypeContext): ParseResult {
    if (typeof input !== 'string' || !UUID_PATTERN.test(input.trim())) return fail('INVALID_TYPE', 'A user id is required.');
    const userId = input.trim().toLowerCase();
    // Unchanged historical references are preserved even if the user left the workspace.
    if (ctx.existingItems.includes(userId)) return okResult(userId);
    const check = ctx.checkUser(userId);
    if (check !== 'OK' || !ctx.isUserSelectable(userId)) return fail('FIELD_REFERENCE_INVALID', 'The referenced user is not available in this workspace.');
    return okResult(userId);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueUuid: value as string };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueUuid ?? null;
  }
}

class CrmReferenceHandler extends BaseHandler {
  readonly type = 'CRM_REFERENCE' as const;
  readonly conditionDataType = 'ENUM' as const;

  protected allowedReferenceKeys() {
    return ['allowedEntityTypes'];
  }

  protected validateConfig(draft: DefinitionDraft, context: { registeredEntityTypes: string[] }): FieldViolation[] {
    const allowed = draft.referenceConfig?.allowedEntityTypes;
    if (!Array.isArray(allowed) || allowed.length === 0) {
      return [violation('CONFIG_INVALID', 'referenceConfig.allowedEntityTypes must list at least one entity type.')];
    }
    const invalid = allowed.filter((item) => typeof item !== 'string' || !context.registeredEntityTypes.includes(item));
    return invalid.length > 0 ? [violation('CONFIG_INVALID', 'allowedEntityTypes contains an unsupported entity type.')] : [];
  }

  parseItem(input: unknown, field: CustomField, ctx: FieldTypeContext): ParseResult {
    if (!isPlainObject(input) || typeof input.entityType !== 'string' || typeof input.entityId !== 'string' || !UUID_PATTERN.test(input.entityId)) {
      return fail('INVALID_TYPE', 'A CRM reference {entityType, entityId} is required.');
    }
    const value: CrmReferenceValue = { entityType: input.entityType.trim().toUpperCase(), entityId: input.entityId.trim().toLowerCase() };
    const allowed = (field.referenceConfig?.allowedEntityTypes as string[] | undefined) ?? [];
    if (!allowed.includes(value.entityType)) return fail('FIELD_REFERENCE_INVALID', 'This entity type is not allowed for the field.');
    if (ctx.existingItems.some((item) => (item as CrmReferenceValue)?.entityType === value.entityType && (item as CrmReferenceValue)?.entityId === value.entityId)) {
      return okResult(value);
    }
    const check = ctx.checkCrmReference(value.entityType, value.entityId);
    // Missing and forbidden are reported identically so restricted records are never disclosed.
    if (check !== 'OK') return fail('FIELD_REFERENCE_INVALID', 'The referenced record is not available.');
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    const ref = value as CrmReferenceValue;
    return { valueUuid: ref.entityId, valueText: ref.entityType };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueUuid && row.valueText ? ({ entityType: row.valueText, entityId: row.valueUuid } satisfies CrmReferenceValue) : null;
  }

  comparable(value: unknown) {
    return value ? (value as CrmReferenceValue).entityId : null;
  }

  isEmptyItem(value: unknown) {
    return value === undefined || value === null;
  }
}

class FileHandler extends BaseHandler {
  readonly type = 'FILE' as const;
  readonly conditionDataType = 'ENUM' as const;
  protected readonly allowedConfigKeys = ['allowedMimeTypes', 'allowedExtensions', 'maxFileCount', 'maxFileSize'];

  protected validateConfig(draft: DefinitionDraft): FieldViolation[] {
    const out: FieldViolation[] = [];
    for (const key of ['allowedMimeTypes', 'allowedExtensions']) {
      const raw = draft.validationConfig?.[key];
      if (raw !== undefined && (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.length === 0))) {
        out.push(violation('CONFIG_INVALID', `${key} must be an array of non-empty strings.`));
      }
    }
    for (const key of ['maxFileCount', 'maxFileSize']) {
      const parsed = numberConfig(draft.validationConfig, key, true);
      if (parsed.error) out.push(parsed.error);
      else if (parsed.value !== undefined && parsed.value < 1) out.push(violation('CONFIG_INVALID', `${key} must be >= 1.`));
    }
    return out;
  }

  parseItem(input: unknown, _field: CustomField, ctx: FieldTypeContext): ParseResult {
    if (typeof input !== 'string' || !UUID_PATTERN.test(input.trim())) return fail('INVALID_TYPE', 'A file id is required.');
    const fileId = input.trim().toLowerCase();
    if (ctx.existingItems.includes(fileId)) return okResult(fileId);
    const check = ctx.checkFile(fileId);
    if (check === 'UNAVAILABLE') return fail('FILES_UNAVAILABLE', 'File attachments are not available yet.');
    if (check !== 'OK') return fail('FIELD_REFERENCE_INVALID', 'The referenced file is not available.');
    return okResult(fileId);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueUuid: value as string };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return row.valueUuid ?? null;
  }
}

class AddressHandler extends BaseHandler {
  readonly type = 'ADDRESS' as const;
  readonly conditionDataType = 'TEXT' as const;
  private static readonly KEYS = ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'] as const;

  parseItem(input: unknown): ParseResult {
    if (!isPlainObject(input)) return fail('INVALID_TYPE', 'An address object is required.');
    const extra = Object.keys(input).filter((key) => !(AddressHandler.KEYS as readonly string[]).includes(key));
    if (extra.length > 0) return fail('INVALID_TYPE', `Address does not support: ${extra.join(', ')}.`);
    const value: AddressValue = {};
    for (const key of AddressHandler.KEYS) {
      const raw = input[key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string') return fail('INVALID_TYPE', `${key} must be a string.`);
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      if (trimmed.length > 200) return fail('MAX_LENGTH', `${key} must be at most 200 characters.`);
      value[key] = key === 'countryCode' ? trimmed.toUpperCase() : trimmed;
    }
    if (value.countryCode && !COUNTRY_PATTERN.test(value.countryCode)) return fail('INVALID_COUNTRY', 'countryCode must be a 2-letter ISO country code.');
    if (Object.keys(value).length === 0) return fail('INVALID_TYPE', 'An address needs at least one component.');
    return okResult(value);
  }

  serializeItem(value: unknown): TypedValueColumns {
    return { valueJson: value };
  }

  deserializeItem(row: CustomFieldValueRow) {
    return (row.valueJson as AddressValue | null) ?? null;
  }

  comparable(value: unknown) {
    if (!value) return null;
    return Object.values(value as AddressValue).join(' ');
  }

  isEmptyItem(value: unknown) {
    return value === undefined || value === null || (isPlainObject(value) && Object.keys(value).length === 0);
  }
}

export class FieldTypeRegistry {
  private readonly handlers = new Map<CustomFieldType, FieldTypeHandler>();

  constructor() {
    const all: FieldTypeHandler[] = [
      new TextHandler('TEXT'),
      new TextHandler('TEXTAREA'),
      new IntegerHandler(),
      new DecimalHandler(),
      new BooleanHandler(),
      new DateHandler(),
      new DateTimeHandler(),
      new ListHandler('LIST'),
      new ListHandler('MULTI_LIST'),
      new ContactStringHandler('PHONE'),
      new ContactStringHandler('EMAIL'),
      new ContactStringHandler('URL'),
      new MoneyHandler(),
      new UserReferenceHandler(),
      new CrmReferenceHandler(),
      new FileHandler(),
      new AddressHandler(),
    ];
    for (const handler of all) this.handlers.set(handler.type, handler);
  }

  get(type: CustomFieldType): FieldTypeHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported field type ${type}`);
    return handler;
  }

  has(type: string): type is CustomFieldType {
    return this.handlers.has(type as CustomFieldType);
  }

  types(): CustomFieldType[] {
    return [...this.handlers.keys()];
  }

  /** Operators a predicate may use against a field type (only exposed when the handler supports them). */
  operatorsFor(dataType: ConditionDataType): ConditionOperator[] {
    switch (dataType) {
      case 'TEXT':
        return ['EQ', 'NEQ', 'CONTAINS', 'IN', 'NOT_IN', 'IS_EMPTY', 'IS_NOT_EMPTY'];
      case 'NUMBER':
        return ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN', 'NOT_IN', 'IS_EMPTY', 'IS_NOT_EMPTY'];
      case 'BOOLEAN':
        return ['EQ', 'NEQ'];
      case 'DATE':
      case 'DATETIME':
        return ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IS_EMPTY', 'IS_NOT_EMPTY'];
      case 'ENUM':
        return ['EQ', 'NEQ', 'IN', 'NOT_IN', 'IS_EMPTY', 'IS_NOT_EMPTY'];
    }
  }
}

export const fieldTypeRegistry = new FieldTypeRegistry();
