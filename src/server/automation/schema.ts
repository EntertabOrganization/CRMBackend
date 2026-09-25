import type { SchemaNode } from './types';

/**
 * Restricted JSON-Schema subset for custom Trigger payloads and custom Action configuration. It is data, never code: no
 * $ref, no patterns/regex, no defaults, no additional properties, bounded depth and size. Values are validated server-side
 * before they can reach a Rule or an execution.
 */

export type SchemaProblem = { path: string; code: string; message: string };

const MAX_DEPTH = 4;
const MAX_PROPERTIES = 30;
const MAX_ENUM = 50;
const MAX_STRING = 5000;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const SENSITIVE_NAME = /(secret|token|password|passwd|apikey|api_key|credential|authorization)/i;
const SCHEMA_KEYS = ['type', 'description', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'properties', 'required', 'items', 'maxItems', 'format'];
const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
const FORMATS = ['uuid', 'date-time', 'email', 'uri', 'secret-ref'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_REF = /^[A-Za-z0-9_.:-]{1,100}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates that a schema definition itself is inside the allowed subset. Returns every problem found. */
export function validateSchemaDefinition(schema: unknown, path = '$', depth = 0, propertyName?: string): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const problem = (code: string, message: string) => problems.push({ path, code, message });
  if (!isObject(schema)) return [{ path, code: 'SCHEMA_INVALID', message: 'A schema must be an object.' }];
  if (depth > MAX_DEPTH) return [{ path, code: 'SCHEMA_TOO_DEEP', message: `Schemas may be nested at most ${MAX_DEPTH} levels deep.` }];
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.includes(key)) problem('SCHEMA_KEY_UNSUPPORTED', `"${key}" is not supported.`);
  if (typeof schema.type !== 'string' || !TYPES.includes(schema.type)) {
    problem('SCHEMA_TYPE_INVALID', `type must be one of ${TYPES.join(', ')}.`);
    return problems;
  }
  if (schema.format !== undefined && (typeof schema.format !== 'string' || !FORMATS.includes(schema.format))) problem('SCHEMA_FORMAT_INVALID', `format must be one of ${FORMATS.join(', ')}.`);
  // Anything that looks like a credential must be a reference, so plaintext secrets can never live in Rule JSON.
  if (propertyName && SENSITIVE_NAME.test(propertyName) && schema.format !== 'secret-ref') {
    problem('SCHEMA_SECRET_MUST_BE_REFERENCE', `"${propertyName}" looks like a credential; declare it with format "secret-ref".`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > MAX_ENUM || schema.enum.some((item) => typeof item !== 'string' && typeof item !== 'number')) {
      problem('SCHEMA_ENUM_INVALID', `enum must list 1-${MAX_ENUM} strings or numbers.`);
    }
  }
  for (const key of ['minLength', 'maxLength', 'maxItems'] as const) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || (schema[key] as number) < 0 || (schema[key] as number) > MAX_STRING)) problem('SCHEMA_BOUND_INVALID', `${key} must be an integer between 0 and ${MAX_STRING}.`);
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) problem('SCHEMA_BOUND_INVALID', `${key} must be a finite number.`);
  }
  if (schema.type === 'object') {
    const properties = schema.properties;
    if (properties !== undefined) {
      if (!isObject(properties) || Object.keys(properties).length > MAX_PROPERTIES) problem('SCHEMA_PROPERTIES_INVALID', `properties must be an object with at most ${MAX_PROPERTIES} entries.`);
      else {
        for (const [name, child] of Object.entries(properties)) {
          if (!NAME_PATTERN.test(name)) problems.push({ path: `${path}.${name}`, code: 'SCHEMA_PROPERTY_NAME_INVALID', message: 'Property names must be alphanumeric identifiers.' });
          problems.push(...validateSchemaDefinition(child, `${path}.${name}`, depth + 1, name));
        }
      }
    }
    if (schema.required !== undefined) {
      const names = isObject(properties) ? Object.keys(properties) : [];
      if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string' || !names.includes(name))) problem('SCHEMA_REQUIRED_INVALID', 'required must list declared property names.');
    }
  }
  if (schema.type === 'array') {
    if (schema.items === undefined) problem('SCHEMA_ITEMS_REQUIRED', 'array schemas need items.');
    else problems.push(...validateSchemaDefinition(schema.items, `${path}[]`, depth + 1));
  }
  return problems;
}

/** Validates a value against a schema (already checked with validateSchemaDefinition). Unknown properties are rejected. */
export function validateAgainstSchema(schema: SchemaNode, value: unknown, path = '$'): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const problem = (code: string, message: string) => problems.push({ path, code, message });
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [{ path, code: 'INVALID_TYPE', message: 'A string is required.' }];
      if (value.length > MAX_STRING) problem('TOO_LONG', `At most ${MAX_STRING} characters are allowed.`);
      if (schema.minLength !== undefined && value.length < schema.minLength) problem('TOO_SHORT', `At least ${schema.minLength} characters are required.`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) problem('TOO_LONG', `At most ${schema.maxLength} characters are allowed.`);
      if (schema.enum && !schema.enum.includes(value)) problem('NOT_IN_ENUM', 'The value is not one of the allowed options.');
      if (schema.format === 'uuid' && !UUID.test(value)) problem('INVALID_FORMAT', 'A UUID is required.');
      if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) problem('INVALID_FORMAT', 'An email address is required.');
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) problem('INVALID_FORMAT', 'An ISO date-time is required.');
      if (schema.format === 'secret-ref' && !SECRET_REF.test(value)) problem('INVALID_FORMAT', 'A secret reference name is required (never the secret itself).');
      if (schema.format === 'uri') {
        try {
          if (new URL(value).protocol !== 'https:') problem('INVALID_FORMAT', 'An https URL is required.');
        } catch {
          problem('INVALID_FORMAT', 'A valid URL is required.');
        }
      }
      return problems;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return [{ path, code: 'INVALID_TYPE', message: schema.type === 'integer' ? 'An integer is required.' : 'A number is required.' }];
      if (schema.minimum !== undefined && value < schema.minimum) problem('TOO_SMALL', `The minimum is ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) problem('TOO_LARGE', `The maximum is ${schema.maximum}.`);
      if (schema.enum && !schema.enum.includes(value)) problem('NOT_IN_ENUM', 'The value is not one of the allowed options.');
      return problems;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [{ path, code: 'INVALID_TYPE', message: 'A boolean is required.' }];
    case 'array': {
      if (!Array.isArray(value)) return [{ path, code: 'INVALID_TYPE', message: 'An array is required.' }];
      const max = schema.maxItems ?? 100;
      if (value.length > max) problem('TOO_MANY_ITEMS', `At most ${max} items are allowed.`);
      value.slice(0, max).forEach((item, index) => problems.push(...validateAgainstSchema(schema.items!, item, `${path}[${index}]`)));
      return problems;
    }
    case 'object': {
      if (!isObject(value)) return [{ path, code: 'INVALID_TYPE', message: 'An object is required.' }];
      const properties = schema.properties ?? {};
      for (const key of Object.keys(value)) if (!(key in properties)) problems.push({ path: `${path}.${key}`, code: 'UNKNOWN_PROPERTY', message: 'Unknown property.' });
      for (const name of schema.required ?? []) if (value[name] === undefined || value[name] === null) problems.push({ path: `${path}.${name}`, code: 'REQUIRED', message: 'This property is required.' });
      for (const [name, child] of Object.entries(properties)) {
        if (value[name] !== undefined && value[name] !== null) problems.push(...validateAgainstSchema(child, value[name], `${path}.${name}`));
      }
      return problems;
    }
    default:
      return [{ path, code: 'SCHEMA_INVALID', message: 'Unsupported schema type.' }];
  }
}
