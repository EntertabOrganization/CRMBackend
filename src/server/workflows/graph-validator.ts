import { AppError } from '../errors';
import { parse } from '../process-platform/dto';
import type { Principal } from '../process-platform/context';
import { configs, actionConfig, httpConfig, type Graph, type Node } from './dto';
import { compileExpression } from './expression';
import { typedValue } from './typed-values';
import type { WorkflowActionRegistry } from './action-registry';

export type GraphProblem = { nodeId?: string; edgeId?: string; code: string; message: string };
type ValidationPorts = { actions: WorkflowActionRegistry; actor: Principal;
  connection: (connectionId: string, path: string) => Promise<void>;
  subworkflow: (workflowId: string, versionId?: string) => Promise<void>;
  user: (userId: string) => Promise<void>;
  maxLoopIterations?: number };

function expressions(node: Node): string[] {
  const result: string[] = [];
  for (const key of ['expression','collection','correlationKey','result']) if (typeof node.config[key] === 'string') result.push(node.config[key]);
  for (const key of ['inputExpressions','inputMapping','outputMapping']) {
    const mapping = node.config[key];
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) result.push(...Object.values(mapping).filter((v): v is string => typeof v === 'string'));
  }
  const compensation = node.config.compensation;
  if (compensation && typeof compensation === 'object' && !Array.isArray(compensation)) {
    const mapping = compensation.inputExpressions;
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) result.push(...Object.values(mapping).filter((v): v is string => typeof v === 'string'));
  }
  return result;
}

export function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new AppError('WORKFLOW_NODE_INVALID','Configuration is too deeply nested.',422);
  if (Array.isArray(value)) { for (const item of value) assertNoSecrets(item,depth + 1); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key,item] of Object.entries(value)) {
    if (/^(?:password|secret|token|authorization|apiKey|accessToken|refreshToken|clientSecret|privateKey|__proto__|prototype|constructor)$/i.test(key))
      throw new AppError('WORKFLOW_NODE_INVALID','Secrets must be referenced through an Integration connection.',422);
    assertNoSecrets(item,depth + 1);
  }
}

/** Full publish validation; incremental drafts can remain incomplete but never contain unsafe configuration. */
export async function validateGraph(snapshot: Graph, ports: ValidationPorts, publish = true): Promise<GraphProblem[]> {
  const problems: GraphProblem[] = [];
  const problem = (code: string, message: string, nodeId?: string, edgeId?: string) => problems.push({ code,message,...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });
  const nodes = new Map(snapshot.nodes.map(node => [node.id,node]));
  const keys = new Map(snapshot.nodes.map(node => [node.nodeKey,node]));
  if (nodes.size !== snapshot.nodes.length || keys.size !== snapshot.nodes.length) problem('WORKFLOW_NODE_INVALID','Node identities and keys must be unique.');
  if (new Set(snapshot.edges.map(edge => edge.id)).size !== snapshot.edges.length) problem('WORKFLOW_EDGE_INVALID','Edge identities must be unique.');
  for (const definitions of [snapshot.parameters,snapshot.variables,snapshot.constants]) {
    if (new Set(definitions.map(d => d.code)).size !== definitions.length) problem('WORKFLOW_GRAPH_INVALID','Typed definition codes must be unique.');
    for (const definition of definitions) try {
      assertNoSecrets(definition);
      if (definition.defaultValue !== undefined) typedValue(definition,definition.defaultValue);
      if (snapshot.constants.includes(definition) && definition.defaultValue === undefined) problem('WORKFLOW_GRAPH_INVALID','Constants require a typed value.');
      if (definition.datatype === 'JSON_TYPED' && !definition.validation.schema) problem('WORKFLOW_GRAPH_INVALID','JSON_TYPED requires a bounded JSON schema.');
    } catch { problem('WORKFLOW_GRAPH_INVALID','Typed definition or default is invalid.'); }
  }
  for (const node of snapshot.nodes) try {
    assertNoSecrets(node.config); parse(configs[node.nodeType],node.config);
    for (const source of expressions(node)) compileExpression(source);
    if (['WHILE','FOR_EACH'].includes(node.nodeType)) {
      if (Number(node.config.maxIterations) > (ports.maxLoopIterations ?? 1000)) problem('WORKFLOW_LOOP_LIMIT_EXCEEDED','Loop exceeds the effective limit.',node.id);
      if (!keys.has(String(node.config.bodyNodeKey)) || !keys.has(String(node.config.exitNodeKey))) problem('WORKFLOW_NODE_INVALID','Loop body or exit is missing.',node.id);
    }
    if (node.nodeType === 'SET_VARIABLE' && !snapshot.variables.some(v => v.code === node.config.variable)) problem('WORKFLOW_NODE_INVALID','Variable is not declared.',node.id);
    if (['APPROVAL','REQUEST_INFO'].includes(node.nodeType)) {
      const ids = node.config.assigneeUserIds as string[];
      if (node.config.policy === 'QUORUM' && (!node.config.quorumCount || Number(node.config.quorumCount) > ids.length)) problem('WORKFLOW_APPROVAL_POLICY_INVALID','Quorum cannot exceed participants.',node.id);
      for (const userId of ids) await ports.user(userId);
      const timeout = node.config.timeoutPolicy as Record<string,unknown> | undefined;
      if (timeout?.toUserId) await ports.user(String(timeout.toUserId));
    }
    if (['PARALLEL_SPLIT','EVENT_RACE'].includes(node.nodeType)) {
      const join = keys.get(String(node.config.joinNodeKey));
      const outgoing = snapshot.edges.filter(edge => edge.fromNodeId === node.id);
      if (!join || join.nodeType !== 'PARALLEL_JOIN' || join.config.splitNodeKey !== node.nodeKey || outgoing.length < 2)
        problem('WORKFLOW_JOIN_INVALID','Split requires two branches and its matching join.',node.id);
      if (join?.config.mode === 'QUORUM' && (!join.config.requiredCount || Number(join.config.requiredCount) > outgoing.length)) problem('WORKFLOW_JOIN_INVALID','Join quorum exceeds branches.',node.id);
    }
    if (node.nodeType === 'PARALLEL_JOIN') {
      const split = keys.get(String(node.config.splitNodeKey));
      if (!split || !['PARALLEL_SPLIT','EVENT_RACE'].includes(split.nodeType) || split.config.joinNodeKey !== node.nodeKey)
        problem('WORKFLOW_JOIN_INVALID','Join must reference its matching split.',node.id);
    }
    if (['HTTP_REQUEST','OUTBOUND_WEBHOOK'].includes(node.nodeType)) {
      const config = parse(httpConfig,node.config); await ports.connection(config.connectionId,config.path);
    } else if (node.nodeType === 'SUB_WORKFLOW') {
      await ports.subworkflow(String(node.config.workflowId),typeof node.config.versionId === 'string' ? node.config.versionId : undefined);
    } else if ('actionCode' in node.config) {
      const config = parse(actionConfig,node.config); ports.actions.get(config.actionCode);
      if (!ports.actor.grants.has(ports.actions.get(config.actionCode).permission)) problem('WORKFLOW_DOMAIN_PERMISSION_DENIED','Action permission is required.',node.id);
      if (!Object.keys(config.inputExpressions).length) ports.actions.validate(ports.actor,config.actionCode,config.input);
      if (config.compensation) {
        const action = ports.actions.get(config.actionCode), inverse = ports.actions.get(config.compensation.actionCode);
        if (action.inverse !== inverse.code) problem('WORKFLOW_COMPENSATION_UNDEFINED','Compensation is not a declared inverse.',node.id);
      }
    }
  } catch (error) { problem(error instanceof AppError ? error.code : 'WORKFLOW_NODE_INVALID','Node configuration is invalid or unavailable.',node.id); }
  const adjacency = new Map<string,string[]>();
  for (const edge of snapshot.edges) {
    if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId)) { problem('WORKFLOW_EDGE_INVALID','Edge endpoint is outside this version.',undefined,edge.id); continue; }
    try { if (edge.condition) compileExpression(edge.condition); } catch { problem('WORKFLOW_UNSAFE_EXPRESSION','Edge condition is invalid.',undefined,edge.id); }
    adjacency.set(edge.fromNodeId,[...(adjacency.get(edge.fromNodeId) ?? []),edge.toNodeId]);
  }
  if (!publish) return problems;
  const starts = snapshot.nodes.filter(node => node.nodeType === 'START');
  if (starts.length !== 1 || snapshot.nodes.every(node => node.nodeType !== 'END')) problem('WORKFLOW_GRAPH_INVALID','Exactly one START and a reachable END are required.');
  const seen = new Set<string>(), visiting = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) { if (!['WHILE','FOR_EACH'].includes(nodes.get(id)?.nodeType ?? '')) problem('WORKFLOW_GRAPH_CYCLE','Cycles must return to an explicit bounded loop.',id); return; }
    if (seen.has(id)) return;
    visiting.add(id);
    for (const target of adjacency.get(id) ?? []) walk(target);
    visiting.delete(id); seen.add(id);
  };
  if (starts[0]) walk(starts[0].id);
  for (const node of snapshot.nodes) {
    if (!seen.has(node.id)) problem('WORKFLOW_GRAPH_INVALID','Node is unreachable from START.',node.id);
    const outgoing = snapshot.edges.filter(edge => edge.fromNodeId === node.id);
    if (!outgoing.length && !['END','TERMINATE'].includes(node.nodeType)) problem('WORKFLOW_GRAPH_INVALID','Nonterminal branch has no successor.',node.id);
    if (node.nodeType === 'CONDITION' && (!outgoing.some(e => e.edgeType === 'TRUE') || !outgoing.some(e => e.edgeType === 'FALSE')))
      problem('WORKFLOW_GRAPH_INVALID','Condition requires TRUE and FALSE branches.',node.id);
    if (node.nodeType === 'APPROVAL' && (!outgoing.some(e => e.edgeType === 'APPROVE') || !outgoing.some(e => e.edgeType === 'REJECT')))
      problem('WORKFLOW_GRAPH_INVALID','Approval requires approval and rejection outcomes.',node.id);
    if (['APPROVAL','REQUEST_INFO'].includes(node.nodeType) && node.config.dueSeconds && !outgoing.some(e => e.edgeType === 'TIMEOUT'))
      problem('WORKFLOW_GRAPH_INVALID','Timed human assignment requires a timeout branch.',node.id);
    if (['END','TERMINATE'].includes(node.nodeType) && outgoing.length) problem('WORKFLOW_GRAPH_INVALID','Terminal nodes cannot dispatch successors.',node.id);
    if (node.nodeType === 'START' && outgoing.length !== 1) problem('WORKFLOW_GRAPH_INVALID','START requires one successor.',node.id);
  }
  const canFinish = new Set(snapshot.nodes.filter(node => ['END','TERMINATE'].includes(node.nodeType)).map(node => node.id));
  let changed = true;
  while (changed) { changed = false; for (const edge of snapshot.edges) if (canFinish.has(edge.toNodeId) && !canFinish.has(edge.fromNodeId)) { canFinish.add(edge.fromNodeId); changed = true; } }
  for (const node of snapshot.nodes) if (!canFinish.has(node.id)) problem('WORKFLOW_GRAPH_INVALID','Branch has no finite terminal path.',node.id);
  return problems;
}
