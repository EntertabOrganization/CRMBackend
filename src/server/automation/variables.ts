/**
 * Typed variable resolver for Action inputs: `{{target.title}}`, `{{target.customFields.contract_number}}`,
 * `{{trigger.payload.carrier}}`, `{{actor.id}}`. Only whitelisted roots resolve; there is no expression evaluation and no
 * access to anything outside the supplied scope (payload values are read-only context).
 */

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const SINGLE = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;
const ROOTS = ['target', 'trigger', 'actor', 'rule', 'now'];

export type VariableScope = {
  target: Record<string, unknown>;
  trigger: Record<string, unknown>;
  actor: Record<string, unknown>;
  rule: Record<string, unknown>;
  now: string;
};

/** All `{{ref}}` occurrences inside any string of a JSON-like value. */
export function collectReferences(value: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8) return into;
  if (typeof value === 'string') {
    for (const match of value.matchAll(TEMPLATE)) into.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectReferences(item, into, depth + 1);
  }
  return into;
}

/** Is the reference shaped like a whitelisted root path? (Availability of the specific field is checked by the caller.) */
export function isReferenceShape(ref: string): boolean {
  const [root, ...rest] = ref.split('.');
  return ROOTS.includes(root) && (root === 'now' ? rest.length === 0 : rest.length > 0);
}

function lookup(scope: VariableScope, ref: string): unknown {
  const [root, ...rest] = ref.split('.');
  if (root === 'now') return scope.now;
  const base = (scope as Record<string, unknown>)[root];
  if (!base || typeof base !== 'object') return undefined;
  const key = rest.join('.');
  // Flat keys (customFields.code) are stored under their dotted name; nested payload objects are walked.
  if (key in (base as Record<string, unknown>)) return (base as Record<string, unknown>)[key];
  let cursor: unknown = base;
  for (const part of rest) {
    if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, part)) cursor = (cursor as Record<string, unknown>)[part];
    else return undefined;
  }
  return cursor;
}

/** Resolves templates inside a JSON-like value. A string that is exactly one variable keeps the variable's native type. */
export function resolveTemplates<T>(value: T, scope: VariableScope, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    const single = SINGLE.exec(value);
    if (single) {
      const resolved = lookup(scope, single[1]);
      return (resolved === undefined ? '' : resolved) as unknown as T;
    }
    return value.replace(TEMPLATE, (_, ref: string) => {
      const resolved = lookup(scope, ref);
      if (resolved === undefined || resolved === null) return '';
      return typeof resolved === 'object' ? '' : String(resolved);
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveTemplates(inner, scope, depth + 1)])) as unknown as T;
  }
  return value;
}
