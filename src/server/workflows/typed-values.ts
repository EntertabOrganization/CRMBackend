import { canonicalDecimal } from '../fields/decimal';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import type { Parameter } from './dto';

const invalid = () => new AppError('WORKFLOW_PARAMETER_INVALID', 'Workflow value does not satisfy its declared type.', 422);
/** Bounded JSON type declarations; records accept only declared properties, never prototype keys. */
function jsonValue(schema: unknown, value: unknown, depth = 0): unknown {
  if (depth > 8 || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw invalid();
  const config = schema as Record<string, unknown>;
  if (config.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const properties = config.properties as Record<string,unknown>;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 100) throw invalid();
    const record = value as Record<string,unknown>, required = config.required ?? [];
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(properties,key))) throw invalid();
    if (Object.keys(record).some(key => ['__proto__','constructor','prototype'].includes(key) || !Object.prototype.hasOwnProperty.call(properties,key)) || required.some(key => record[key] === undefined)) throw invalid();
    return Object.fromEntries(Object.entries(record).map(([key,input]) => [key,jsonValue(properties[key],input,depth + 1)]));
  }
  if (config.type === 'array') {
    if (!Array.isArray(value) || value.length > Math.min(1000, typeof config.maxItems === 'number' ? config.maxItems : 1000)) throw invalid();
    return value.map(item => jsonValue(config.items,item,depth + 1));
  }
  if (config.type === 'string' && typeof value === 'string' && value.length <= 10000) return value;
  if (config.type === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (config.type === 'boolean' && typeof value === 'boolean') return value;
  if (config.type === 'null' && value === null) return value;
  throw invalid();
}

export function typedValue(definition: Parameter, input: unknown): unknown {
  const value = input === undefined ? definition.defaultValue : input;
  if (value === undefined || value === null || value === '') {
    if (definition.required) throw invalid(); return null;
  }
  switch (definition.datatype) {
    case 'TEXT': {
      if (typeof value !== 'string' || value.length > 10000) throw invalid();
      const maxLength = definition.validation.maxLength;
      if (typeof maxLength === 'number' && value.length > maxLength) throw invalid();
      return value;
    }
    case 'NUMBER': {
      const number = canonicalDecimal(value); if (number === null) throw invalid(); return number;
    }
    case 'MONEY': {
      if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const record = value as Record<string,unknown>, amount = canonicalDecimal(record.amount);
      if (amount === null || typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency) || Object.keys(record).some(k => !['amount','currency'].includes(k))) throw invalid();
      return { amount, currency: record.currency };
    }
    case 'BOOLEAN': if (typeof value !== 'boolean') throw invalid(); return value;
    case 'DATE': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw invalid();
      return value;
    }
    case 'DATETIME': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid();
      return new Date(value).toISOString();
    }
    case 'USER': return parse(uuid,value);
    case 'ENTITY_REF': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const record = value as Record<string,unknown>;
      if (typeof record.entityType !== 'string' || Object.keys(record).some(key => !['entityType','entityId'].includes(key))) throw invalid();
      const allowed = definition.validation.allowedEntityTypes;
      if (!Array.isArray(allowed) || !allowed.includes(record.entityType)) throw invalid();
      return { entityType: record.entityType, entityId: parse(uuid,record.entityId) };
    }
    case 'JSON_TYPED': return jsonValue(definition.validation.schema,value);
    default: throw invalid();
  }
}

export function typedRecord(definitions: Parameter[], input: Record<string,unknown>): Record<string,unknown> {
  if (Object.keys(input).some(key => !definitions.some(definition => definition.code === key))) throw invalid();
  return Object.fromEntries(definitions.map(definition => [definition.code,typedValue(definition,input[definition.code])]));
}
