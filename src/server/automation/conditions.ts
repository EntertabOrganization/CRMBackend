import { canonicalDecimal, decimalToScaled } from '../fields/decimal';
import type { ConditionDataType } from '../fields/field-types';
import type { ConditionNode } from './types';

/**
 * Declarative condition engine. A condition is a bounded tree of ALL/ANY groups over allow-listed operators and
 * whitelisted operands. There is no expression language, no eval, no template execution and no reflection: operands are
 * resolved by name through the target/trigger registries and compared with type-aware operators.
 */

export const MAX_CONDITION_DEPTH = 5;
export const MAX_CONDITION_NODES = 50;
export const MAX_IN_LIST = 100;

export const OPERATORS_BY_TYPE: Record<ConditionDataType, string[]> = {
  TEXT: ['EQ', 'NEQ', 'IN', 'NOT_IN', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  NUMBER: ['EQ', 'NEQ', 'IN', 'NOT_IN', 'GT', 'GTE', 'LT', 'LTE', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  BOOLEAN: ['EQ', 'NEQ', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  DATE: ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  DATETIME: ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IS_EMPTY', 'IS_NOT_EMPTY'],
  ENUM: ['EQ', 'NEQ', 'IN', 'NOT_IN', 'IS_EMPTY', 'IS_NOT_EMPTY'],
};
export const CHANGE_OPERATORS = ['CHANGED', 'CHANGED_FROM', 'CHANGED_TO'];
const VALUELESS = ['IS_EMPTY', 'IS_NOT_EMPTY', 'CHANGED'];
const LIST_OPERATORS = ['IN', 'NOT_IN'];

export type OperandDescriptor = {
  /** Whitelisted reference: target.<field> | target.customFields.<code> | trigger.payload.<key> | actor.id | now */
  ref: string;
  label: string;
  dataType: ConditionDataType;
  /** CURRENT = re-read from the record on every evaluation; EVENT = pinned in the trigger context. */
  scope: 'CURRENT' | 'EVENT';
  /** May CHANGED / CHANGED_FROM / CHANGED_TO be used (record fields only)? */
  supportsChange: boolean;
  options?: Array<{ id: string; code: string; label: string }>;
};

export type ConditionProblem = { path: string; code: string; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function operatorsFor(dataType: ConditionDataType, supportsChange: boolean) {
  return [...OPERATORS_BY_TYPE[dataType], ...(supportsChange ? CHANGE_OPERATORS : [])];
}

function validScalar(dataType: ConditionDataType, value: unknown): boolean {
  switch (dataType) {
    case 'NUMBER':
      return (typeof value === 'string' || typeof value === 'number') && canonicalDecimal(value) !== null;
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'DATE':
    case 'DATETIME':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value));
    default:
      return typeof value === 'string' && value.length > 0 && value.length <= 500;
  }
}

/** Structural + type validation. Every problem is returned with its tree path so the designer can highlight it. */
export function validateConditionTree(tree: unknown, operands: Map<string, OperandDescriptor>): ConditionProblem[] {
  const problems: ConditionProblem[] = [];
  let nodes = 0;
  const visit = (node: unknown, path: string, depth: number) => {
    nodes += 1;
    if (nodes > MAX_CONDITION_NODES) {
      if (nodes === MAX_CONDITION_NODES + 1) problems.push({ path, code: 'AUTOMATION_CONDITION_INVALID', message: `A condition tree may contain at most ${MAX_CONDITION_NODES} nodes.` });
      return;
    }
    if (!isObject(node)) {
      problems.push({ path, code: 'AUTOMATION_CONDITION_INVALID', message: 'A condition node must be an object.' });
      return;
    }
    if (node.type === 'GROUP') {
      const extra = Object.keys(node).filter((key) => !['type', 'operator', 'children'].includes(key));
      if (extra.length > 0) problems.push({ path, code: 'AUTOMATION_CONDITION_INVALID', message: `Unsupported group keys: ${extra.join(', ')}.` });
      if (depth > MAX_CONDITION_DEPTH) {
        problems.push({ path, code: 'AUTOMATION_CONDITION_INVALID', message: `Groups may be nested at most ${MAX_CONDITION_DEPTH} levels deep.` });
        return;
      }
      if (node.operator !== 'ALL' && node.operator !== 'ANY') problems.push({ path: `${path}.operator`, code: 'AUTOMATION_CONDITION_INVALID', message: 'A group operator must be ALL or ANY.' });
      if (!Array.isArray(node.children)) {
        problems.push({ path: `${path}.children`, code: 'AUTOMATION_CONDITION_INVALID', message: 'A group needs a children array.' });
        return;
      }
      node.children.forEach((child, index) => visit(child, `${path}.children[${index}]`, depth + 1));
      return;
    }
    if (node.type !== 'CONDITION') {
      problems.push({ path, code: 'AUTOMATION_CONDITION_INVALID', message: 'A node type must be GROUP or CONDITION.' });
      return;
    }
    const extra = Object.keys(node).filter((key) => !['type', 'field', 'operator', 'value'].includes(key));
    if (extra.length > 0) problems.push({ path, code: 'AUTOMATION_CONDITION_INVALID', message: `Unsupported condition keys: ${extra.join(', ')}.` });
    const operand = typeof node.field === 'string' ? operands.get(node.field) : undefined;
    if (!operand) {
      problems.push({ path: `${path}.field`, code: 'AUTOMATION_CONDITION_FIELD_UNAVAILABLE', message: `"${String(node.field)}" is not an available field for this Rule.` });
      return;
    }
    const operator = String(node.operator);
    const allowed = operatorsFor(operand.dataType, operand.supportsChange);
    if (!allowed.includes(operator)) {
      problems.push({ path: `${path}.operator`, code: 'AUTOMATION_CONDITION_OPERATOR_INVALID', message: `${operator} is not supported for ${operand.dataType} fields.` });
      return;
    }
    if (VALUELESS.includes(operator)) {
      if (node.value !== undefined && node.value !== null) problems.push({ path: `${path}.value`, code: 'AUTOMATION_CONDITION_INVALID', message: `${operator} takes no value.` });
      return;
    }
    if (LIST_OPERATORS.includes(operator)) {
      if (!Array.isArray(node.value) || node.value.length === 0 || node.value.length > MAX_IN_LIST || node.value.some((item) => !validScalar(operand.dataType, item))) {
        problems.push({ path: `${path}.value`, code: 'AUTOMATION_CONDITION_VALUE_INVALID', message: `${operator} needs 1-${MAX_IN_LIST} valid ${operand.dataType} values.` });
      }
      return;
    }
    if (!validScalar(operand.dataType, node.value)) problems.push({ path: `${path}.value`, code: 'AUTOMATION_CONDITION_VALUE_INVALID', message: `A valid ${operand.dataType} value is required.` });
  };
  visit(tree, '$', 1);
  return problems;
}

type Comparable = string | number | bigint | boolean;

function toComparable(dataType: ConditionDataType, raw: unknown): Comparable | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  switch (dataType) {
    case 'NUMBER':
      return decimalToScaled(raw);
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? raw : null;
    case 'DATE':
    case 'DATETIME': {
      const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw) : NaN;
      return Number.isNaN(ms) ? null : ms;
    }
    default:
      return String(raw).trim().toLowerCase();
  }
}

function compare(a: Comparable, b: Comparable): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const left = String(a);
  const right = String(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** null/missing, blank text and empty collections are empty; false and 0 are real values. */
export function isEmptyValue(values: unknown[]): boolean {
  return values.length === 0 || values.every((value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0));
}

export type OperandResolution = {
  values: unknown[];
  empty: boolean;
  /** Present when the trigger carries before/after values for this field. */
  changed?: { before: unknown; after: unknown } | null;
};

export type NodeResult = { path: string; type: 'GROUP' | 'CONDITION'; field?: string; operator: string; matched: boolean };

export function evaluateConditionTree(
  tree: ConditionNode | null | undefined,
  operands: Map<string, OperandDescriptor>,
  resolve: (ref: string) => OperandResolution,
): { matched: boolean; results: NodeResult[] } {
  const results: NodeResult[] = [];
  const visit = (node: ConditionNode, path: string): boolean => {
    if (node.type === 'GROUP') {
      const matches = node.children.map((child, index) => visit(child, `${path}.children[${index}]`));
      const matched = node.children.length === 0 ? true : node.operator === 'ALL' ? matches.every(Boolean) : matches.some(Boolean);
      results.push({ path, type: 'GROUP', operator: node.operator, matched });
      return matched;
    }
    const operand = operands.get(node.field);
    const matched = operand ? evaluateCondition(node, operand, resolve(node.field)) : false;
    results.push({ path, type: 'CONDITION', field: node.field, operator: node.operator, matched });
    return matched;
  };
  const matched = tree ? visit(tree, '$') : true;
  return { matched, results };
}

function evaluateCondition(node: Extract<ConditionNode, { type: 'CONDITION' }>, operand: OperandDescriptor, resolution: OperandResolution): boolean {
  const { operator } = node;
  if (operator === 'IS_EMPTY') return resolution.empty;
  if (operator === 'IS_NOT_EMPTY') return !resolution.empty;
  const dataType = operand.dataType;
  const constants = (Array.isArray(node.value) ? node.value : [node.value]).map((value) => toComparable(dataType, value)).filter((value): value is Comparable => value !== null);
  const first = constants[0];
  if (operator === 'CHANGED') return resolution.changed != null;
  if (operator === 'CHANGED_FROM') return resolution.changed != null && first !== undefined && toComparable(dataType, resolution.changed.before) !== null && compare(toComparable(dataType, resolution.changed.before)!, first) === 0;
  if (operator === 'CHANGED_TO') return resolution.changed != null && first !== undefined && toComparable(dataType, resolution.changed.after) !== null && compare(toComparable(dataType, resolution.changed.after)!, first) === 0;
  const comparables = resolution.values.map((value) => toComparable(dataType, value)).filter((value): value is Comparable => value !== null);
  switch (operator) {
    case 'EQ':
      return first !== undefined && comparables.some((value) => compare(value, first) === 0);
    case 'NEQ':
      return first !== undefined && !comparables.some((value) => compare(value, first) === 0);
    case 'IN':
      return comparables.some((value) => constants.some((constant) => compare(value, constant) === 0));
    case 'NOT_IN':
      return !comparables.some((value) => constants.some((constant) => compare(value, constant) === 0));
    case 'GT':
      return first !== undefined && comparables.some((value) => compare(value, first) > 0);
    case 'GTE':
      return first !== undefined && comparables.some((value) => compare(value, first) >= 0);
    case 'LT':
      return first !== undefined && comparables.some((value) => compare(value, first) < 0);
    case 'LTE':
      return first !== undefined && comparables.some((value) => compare(value, first) <= 0);
    case 'CONTAINS':
      return first !== undefined && comparables.some((value) => String(value).includes(String(first)));
    case 'STARTS_WITH':
      return first !== undefined && comparables.some((value) => String(value).startsWith(String(first)));
    case 'ENDS_WITH':
      return first !== undefined && comparables.some((value) => String(value).endsWith(String(first)));
    default:
      return false;
  }
}
