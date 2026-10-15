import { randomUUID } from 'node:crypto';

/** Pure Workflow graph builders; no server modules are loaded, so HTTP suites can import them before database setup. */
export type GraphNode = { id: string; nodeKey: string; nodeType: string; config: Record<string, unknown>; position: { x: number; y: number } };
export const node = (nodeKey: string, nodeType: string, config: Record<string, unknown> = {}): GraphNode =>
  ({ id: randomUUID(), nodeKey, nodeType, config, position: { x: 0, y: 0 } });
export const edge = (from: GraphNode, to: GraphNode, edgeType = 'NEXT', condition?: string) =>
  ({ id: randomUUID(), fromNodeId: from.id, toNodeId: to.id, edgeType, sortOrder: 0, ...(condition ? { condition } : {}) });
export const typed = (code: string, datatype = 'TEXT', extra: Record<string, unknown> = {}) =>
  ({ code, datatype, required: false, validation: {}, classification: 'BUSINESS', ...extra });
export type GraphInput = { nodes: GraphNode[]; edges: ReturnType<typeof edge>[]; parameters?: unknown[]; variables?: unknown[]; constants?: unknown[] };
/** START -> ...middle -> END as a single sequential path. */
export function linear(...middle: GraphNode[]): GraphInput {
  const start = node('START', 'START'), end = node('END', 'END'), chain = [start, ...middle, end];
  return { nodes: chain, edges: chain.slice(1).map((target, index) => edge(chain[index], target)) };
}

