import type { ActorContext } from '../access-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict } from '../errors';
import { applyQuery } from '../query';
import type { ActionServices } from './actions';
import { MAX_CONDITION_DEPTH, MAX_CONDITION_NODES, validateConditionTree } from './conditions';
import type { AutomationIdentityService } from './identity';
import type { AutomationRegistry, Problem } from './registry';
import type { AutomationSupport, Json } from './support';
import { isPlainObject, sha256, stableStringify } from './support';
import type { AutomationAction, AutomationRevision, AutomationRule, ConditionNode, ExecutionPolicy, RuleState, TimingConfig } from './types';
import { AUTOMATION_PERMISSIONS as P, DEFAULT_EXECUTION_POLICY } from './types';
import { collectReferences, isReferenceShape } from './variables';

const MAX_ACTIONS = 20;
const MAX_CONFIG_BYTES = 20_000;
const MAX_DELAY_MINUTES = 366 * 24 * 60;
const RULE_KEYS = ['version', 'name', 'description', 'priority', 'targetType'];
const CONFIG_KEYS = ['trigger', 'conditions', 'timing', 'executionPolicy', 'actions'];

type ActionInput = { actionCode: string; config: Json; continueOnError: boolean; name: string | null };
type RevisionConfig = {
  triggerCode: string | null;
  triggerConfig: Json;
  conditionTree: ConditionNode | null;
  timing: TimingConfig;
  executionPolicy: Partial<ExecutionPolicy>;
  actions: ActionInput[];
};

export function configHashOf(targetType: string, config: RevisionConfig) {
  return sha256(
    stableStringify({
      targetType,
      trigger: { code: config.triggerCode, config: config.triggerConfig },
      conditions: config.conditionTree,
      timing: config.timing,
      policy: config.executionPolicy,
      actions: config.actions.map((action, index) => ({ order: index, code: action.actionCode, config: action.config, continueOnError: action.continueOnError })),
    }),
  );
}

function jsonSize(value: unknown) {
  return JSON.stringify(value ?? null).length;
}

function treeStats(node: unknown, depth = 1): { nodes: number; depth: number } {
  if (!isPlainObject(node)) return { nodes: 1, depth };
  if (node.type === 'GROUP' && Array.isArray(node.children)) {
    const children = node.children.map((child) => treeStats(child, depth + 1));
    return { nodes: 1 + children.reduce((sum, item) => sum + item.nodes, 0), depth: Math.max(depth, ...children.map((item) => item.depth)) };
  }
  return { nodes: 1, depth };
}

/** Rules, immutable revisions, draft editing and the publish/pause/enable lifecycle. */
export class RuleService {
  constructor(
    private readonly support: AutomationSupport,
    private readonly registry: AutomationRegistry,
    private readonly services: ActionServices,
    private readonly identity: AutomationIdentityService,
  ) {}

  private get state() {
    return this.support.state;
  }

  // ---- lookups ------------------------------------------------------------------------------------------------------------

  rule(workspaceId: string, ruleId: unknown): AutomationRule {
    const row = typeof ruleId === 'string' ? this.state.automationRules.find((item) => item.id === ruleId && item.workspaceId === workspaceId) : undefined;
    // A Rule from another workspace is indistinguishable from a missing one.
    if (!row) throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'Automation rule was not found.', 404);
    return row;
  }

  revision(workspaceId: string, revisionId: string | null | undefined): AutomationRevision | null {
    if (!revisionId) return null;
    return this.state.automationRevisions.find((item) => item.id === revisionId && item.workspaceId === workspaceId) ?? null;
  }

  actionsOf(revisionId: string): AutomationAction[] {
    return this.state.automationActions.filter((item) => item.revisionId === revisionId).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  configOf(revision: AutomationRevision): RevisionConfig {
    return {
      triggerCode: revision.triggerCode,
      triggerConfig: revision.triggerConfig,
      conditionTree: revision.conditionTree,
      timing: revision.timing,
      executionPolicy: revision.executionPolicy,
      actions: this.actionsOf(revision.id).map((action) => ({ actionCode: action.actionCode, config: action.config, continueOnError: action.continueOnError, name: action.name })),
    };
  }

  policyOf(revision: AutomationRevision): ExecutionPolicy {
    return { ...DEFAULT_EXECUTION_POLICY, ...revision.executionPolicy };
  }

  // ---- DTOs -----------------------------------------------------------------------------------------------------------------

  revisionDto(revision: AutomationRevision) {
    const actions = this.actionsOf(revision.id);
    return {
      id: revision.id,
      ruleId: revision.ruleId,
      revisionNumber: revision.revisionNumber,
      state: revision.state,
      trigger: { code: revision.triggerCode, config: revision.triggerConfig },
      conditions: revision.conditionTree,
      timing: revision.timing,
      executionPolicy: this.policyOf(revision),
      actions: actions.map((action, index) => ({ id: action.id, order: index + 1, actionCode: action.actionCode, name: action.name, config: action.config, continueOnError: action.continueOnError })),
      configHash: revision.configHash,
      publishedAt: revision.publishedAt,
      publishedByUserId: revision.publishedByUserId,
      supersededAt: revision.supersededAt,
      createdAt: revision.createdAt,
    };
  }

  private lastExecutions(workspaceId: string) {
    const last = new Map<string, { status: string; at: Date; executionId: string }>();
    for (const execution of this.state.automationExecutions) {
      if (execution.workspaceId !== workspaceId) continue;
      const current = last.get(execution.ruleId);
      if (!current || execution.startedAt > current.at) last.set(execution.ruleId, { status: execution.status, at: execution.startedAt, executionId: execution.id });
    }
    return last;
  }

  ruleDto(rule: AutomationRule, last?: { status: string; at: Date; executionId: string }) {
    const active = this.revision(rule.workspaceId, rule.activeRevisionId);
    const draft = this.revision(rule.workspaceId, rule.draftRevisionId);
    const shown = active ?? draft;
    const trigger = shown ? this.registry.triggerFor(rule.workspaceId, shown.triggerCode ?? '', true) : undefined;
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      targetType: rule.targetType,
      priority: rule.priority,
      state: rule.state,
      version: rule.version,
      activeRevisionId: rule.activeRevisionId,
      activeRevisionNumber: active?.revisionNumber ?? null,
      draftRevisionId: rule.draftRevisionId,
      hasDraft: Boolean(draft),
      triggerCode: shown?.triggerCode ?? null,
      triggerLabel: trigger?.label ?? shown?.triggerCode ?? null,
      timingMode: shown?.timing.mode ?? null,
      lastExecution: last ? { status: last.status, at: last.at, executionId: last.executionId } : null,
      createdByUserId: rule.createdByUserId,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }

  // ---- read -------------------------------------------------------------------------------------------------------------------

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    const state = searchParams.get('state');
    if (state && !['DRAFT', 'ACTIVE', 'PAUSED', 'DISABLED', 'ARCHIVED'].includes(state)) throw badRequest('AUTOMATION_QUERY_INVALID', 'Unknown state.');
    const targetType = searchParams.get('targetType');
    const includeArchived = searchParams.get('includeArchived') === 'true';
    const rows = this.state.automationRules.filter(
      (rule) => rule.workspaceId === workspaceId && (state ? rule.state === state : includeArchived || rule.state !== 'ARCHIVED') && (!targetType || rule.targetType === targetType),
    );
    const last = this.lastExecutions(workspaceId);
    const page = Math.max(Number(searchParams.get('page') ?? '1') || 1, 1);
    const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? '20') || 20, 1), 100);
    const result = applyQuery(rows as unknown as Array<AutomationRule & Record<string, unknown>>, {
      search: searchParams.get('search') ?? undefined,
      page,
      limit,
      sortBy: (searchParams.get('sortBy') ?? undefined) as never,
      sortOrder: searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc',
    }, { searchable: ['name', 'description'], filterable: [], sortable: ['priority', 'name', 'createdAt', 'updatedAt', 'state'], defaultSortBy: 'priority' });
    return { data: (result.data as AutomationRule[]).map((rule) => this.ruleDto(rule, last.get(rule.id))), meta: result.meta };
  }

  get(user: User, workspaceId: string, ruleId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    const rule = this.rule(workspaceId, ruleId);
    const active = this.revision(workspaceId, rule.activeRevisionId);
    const draft = this.revision(workspaceId, rule.draftRevisionId);
    return {
      ...this.ruleDto(rule, this.lastExecutions(workspaceId).get(rule.id)),
      activeRevision: active ? this.revisionDto(active) : null,
      draftRevision: draft ? this.revisionDto(draft) : null,
    };
  }

  listRevisions(user: User, workspaceId: string, ruleId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    const rule = this.rule(workspaceId, ruleId);
    const revisions = this.state.automationRevisions.filter((item) => item.ruleId === rule.id).sort((a, b) => b.revisionNumber - a.revisionNumber);
    return revisions.map((revision) => ({ id: revision.id, revisionNumber: revision.revisionNumber, state: revision.state, configHash: revision.configHash, publishedAt: revision.publishedAt, publishedByUserId: revision.publishedByUserId, createdAt: revision.createdAt }));
  }

  getRevision(user: User, workspaceId: string, ruleId: string, revisionId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    const rule = this.rule(workspaceId, ruleId);
    const revision = this.state.automationRevisions.find((item) => item.id === revisionId && item.ruleId === rule.id && item.workspaceId === workspaceId);
    if (!revision) throw new AppError('AUTOMATION_RULE_NOT_FOUND', 'Revision was not found.', 404);
    return this.revisionDto(revision);
  }

  // ---- draft parsing (structural only: incomplete drafts are allowed, unsafe/oversized ones are not) --------------------------

  private parseConfig(input: Json, base: RevisionConfig | null): RevisionConfig {
    const config: RevisionConfig = base ? { ...base, actions: [...base.actions] } : { triggerCode: null, triggerConfig: {}, conditionTree: null, timing: { mode: 'IMMEDIATE' }, executionPolicy: {}, actions: [] };
    if (input.trigger !== undefined) {
      if (input.trigger === null) {
        config.triggerCode = null;
        config.triggerConfig = {};
      } else {
        if (!isPlainObject(input.trigger) || typeof input.trigger.code !== 'string' || input.trigger.code.length === 0 || input.trigger.code.length > 100) throw badRequest('AUTOMATION_TRIGGER_NOT_SUPPORTED', 'trigger must be {code, config}.', { field: 'trigger' });
        if (input.trigger.config !== undefined && !isPlainObject(input.trigger.config)) throw badRequest('AUTOMATION_TRIGGER_NOT_SUPPORTED', 'trigger.config must be an object.', { field: 'trigger.config' });
        if (jsonSize(input.trigger.config) > 10_000) throw badRequest('AUTOMATION_TRIGGER_NOT_SUPPORTED', 'trigger.config is too large.', { field: 'trigger.config' });
        config.triggerCode = input.trigger.code;
        config.triggerConfig = (input.trigger.config as Json) ?? {};
      }
    }
    if (input.conditions !== undefined) {
      if (input.conditions !== null && !isPlainObject(input.conditions)) throw badRequest('AUTOMATION_CONDITION_INVALID', 'conditions must be a condition tree or null.', { field: 'conditions' });
      if (input.conditions !== null) {
        const stats = treeStats(input.conditions);
        if (stats.nodes > MAX_CONDITION_NODES || stats.depth > MAX_CONDITION_DEPTH + 1 || jsonSize(input.conditions) > 60_000) throw badRequest('AUTOMATION_CONDITION_INVALID', 'The condition tree exceeds the allowed size or depth.', { field: 'conditions' });
      }
      config.conditionTree = input.conditions as ConditionNode | null;
    }
    if (input.timing !== undefined) config.timing = this.parseTiming(input.timing);
    if (input.executionPolicy !== undefined) config.executionPolicy = this.parsePolicy(input.executionPolicy);
    if (input.actions !== undefined) {
      if (!Array.isArray(input.actions) || input.actions.length > MAX_ACTIONS) throw badRequest('AUTOMATION_ACTION_NOT_SUPPORTED', `actions must be an array of at most ${MAX_ACTIONS} items.`, { field: 'actions' });
      config.actions = input.actions.map((entry, index) => {
        if (!isPlainObject(entry) || typeof entry.actionCode !== 'string' || entry.actionCode.length === 0 || entry.actionCode.length > 100) throw badRequest('AUTOMATION_ACTION_NOT_SUPPORTED', `actions[${index}] needs an actionCode.`, { field: `actions[${index}]` });
        const extra = Object.keys(entry).filter((key) => !['actionCode', 'config', 'continueOnError', 'name', 'id', 'order'].includes(key));
        if (extra.length > 0) throw badRequest('AUTOMATION_ACTION_NOT_SUPPORTED', `actions[${index}] has unsupported keys: ${extra.join(', ')}.`, { field: `actions[${index}]` });
        if (entry.config !== undefined && !isPlainObject(entry.config)) throw badRequest('AUTOMATION_ACTION_NOT_SUPPORTED', `actions[${index}].config must be an object.`, { field: `actions[${index}].config` });
        if (jsonSize(entry.config) > MAX_CONFIG_BYTES) throw badRequest('AUTOMATION_ACTION_NOT_SUPPORTED', `actions[${index}].config is too large.`, { field: `actions[${index}].config` });
        if (entry.continueOnError !== undefined && typeof entry.continueOnError !== 'boolean') throw badRequest('AUTOMATION_ACTION_NOT_SUPPORTED', `actions[${index}].continueOnError must be a boolean.`, { field: `actions[${index}]` });
        return {
          actionCode: entry.actionCode,
          config: (entry.config as Json) ?? {},
          continueOnError: entry.continueOnError === true,
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : null,
        };
      });
    }
    return config;
  }

  private parseTiming(value: unknown): TimingConfig {
    const fail = (message: string) => badRequest('AUTOMATION_TIMING_INVALID', message, { field: 'timing' });
    if (!isPlainObject(value)) throw fail('timing must be an object.');
    const allowed = { IMMEDIATE: ['mode'], DELAY: ['mode', 'delayMinutes'], SCHEDULED: ['mode', 'runAt'], RELATIVE_TO_FIELD: ['mode', 'field', 'offsetMinutes', 'ifPast'] } as Record<string, string[]>;
    const mode = String(value.mode);
    if (!allowed[mode]) throw fail('timing.mode must be IMMEDIATE, DELAY, SCHEDULED or RELATIVE_TO_FIELD.');
    const extra = Object.keys(value).filter((key) => !allowed[mode].includes(key));
    if (extra.length > 0) throw fail(`Unsupported timing keys: ${extra.join(', ')}.`);
    if (mode === 'IMMEDIATE') return { mode: 'IMMEDIATE' };
    if (mode === 'DELAY') {
      if (!Number.isInteger(value.delayMinutes) || (value.delayMinutes as number) < 1 || (value.delayMinutes as number) > MAX_DELAY_MINUTES) throw fail('delayMinutes must be an integer between 1 and 527040.');
      return { mode: 'DELAY', delayMinutes: value.delayMinutes as number };
    }
    if (mode === 'SCHEDULED') {
      if (typeof value.runAt !== 'string' || Number.isNaN(Date.parse(value.runAt))) throw fail('runAt must be an ISO timestamp.');
      return { mode: 'SCHEDULED', runAt: new Date(value.runAt).toISOString() };
    }
    if (typeof value.field !== 'string' || !/^target\.[A-Za-z0-9_.]{1,100}$/.test(value.field)) throw fail('field must be a target date field reference.');
    if (!Number.isInteger(value.offsetMinutes) || Math.abs(value.offsetMinutes as number) > MAX_DELAY_MINUTES) throw fail('offsetMinutes must be an integer between -527040 and 527040.');
    if (value.ifPast !== undefined && value.ifPast !== 'RUN_NOW' && value.ifPast !== 'SKIP') throw fail('ifPast must be RUN_NOW or SKIP.');
    return { mode: 'RELATIVE_TO_FIELD', field: value.field, offsetMinutes: value.offsetMinutes as number, ifPast: (value.ifPast as 'RUN_NOW' | 'SKIP') ?? 'RUN_NOW' };
  }

  private parsePolicy(value: unknown): Partial<ExecutionPolicy> {
    if (!isPlainObject(value)) throw badRequest('AUTOMATION_POLICY_INVALID', 'executionPolicy must be an object.', { field: 'executionPolicy' });
    const extra = Object.keys(value).filter((key) => !['identity', 'maxAttempts', 'allowManual'].includes(key));
    if (extra.length > 0) throw badRequest('AUTOMATION_POLICY_INVALID', `Unsupported executionPolicy keys: ${extra.join(', ')}.`, { field: 'executionPolicy' });
    const policy: Partial<ExecutionPolicy> = {};
    if (value.identity !== undefined) {
      if (value.identity !== 'SERVICE' && value.identity !== 'INITIATING_USER') throw badRequest('AUTOMATION_POLICY_INVALID', 'identity must be SERVICE or INITIATING_USER.', { field: 'executionPolicy.identity' });
      policy.identity = value.identity;
    }
    if (value.maxAttempts !== undefined) {
      if (!Number.isInteger(value.maxAttempts) || (value.maxAttempts as number) < 1 || (value.maxAttempts as number) > 10) throw badRequest('AUTOMATION_POLICY_INVALID', 'maxAttempts must be between 1 and 10.', { field: 'executionPolicy.maxAttempts' });
      policy.maxAttempts = value.maxAttempts as number;
    }
    if (value.allowManual !== undefined) {
      if (typeof value.allowManual !== 'boolean') throw badRequest('AUTOMATION_POLICY_INVALID', 'allowManual must be a boolean.', { field: 'executionPolicy.allowManual' });
      policy.allowManual = value.allowManual;
    }
    return policy;
  }

  private writeDraft(workspaceId: string, revision: AutomationRevision, config: RevisionConfig) {
    revision.triggerCode = config.triggerCode;
    revision.triggerConfig = config.triggerConfig;
    revision.conditionTree = config.conditionTree;
    revision.timing = config.timing;
    revision.executionPolicy = config.executionPolicy;
    revision.updatedAt = new Date();
    // The draft's action list is rebuilt as a whole so ordering is always contiguous and deterministic.
    const now = new Date();
    this.state.automationActions = [
      ...this.state.automationActions.filter((item) => item.revisionId !== revision.id),
      ...config.actions.map((action, index) => ({ id: this.support.store.id(), workspaceId, revisionId: revision.id, actionCode: action.actionCode, sortOrder: index, name: action.name, config: action.config, continueOnError: action.continueOnError, createdAt: now })),
    ];
  }

  // ---- create / update -----------------------------------------------------------------------------------------------------------

  create(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manage);
    const unknown = Object.keys(input).filter((key) => ![...RULE_KEYS, ...CONFIG_KEYS].includes(key) || key === 'version');
    if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `These fields cannot be set here: ${unknown.join(', ')}.`, { fields: unknown });
    return this.support.store.atomicSync(() => {
      const name = this.readName(input.name);
      const targetType = this.readTarget(input.targetType);
      const config = this.parseConfig(input, null);
      const now = new Date();
      const rule: AutomationRule = {
        id: this.support.store.id(),
        workspaceId,
        name,
        description: this.readDescription(input.description),
        targetType,
        priority: this.readPriority(input.priority) ?? 100,
        state: 'DRAFT',
        activeRevisionId: null,
        draftRevisionId: null,
        version: 1,
        createdByUserId: actor.user.id,
        updatedByUserId: actor.user.id,
        createdAt: now,
        updatedAt: now,
      };
      const revision = this.newRevision(rule, 1, actor);
      rule.draftRevisionId = revision.id;
      this.state.automationRules.push(rule);
      this.state.automationRevisions.push(revision);
      this.writeDraft(workspaceId, revision, config);
      this.support.audit(actor, 'AUTOMATION.RULE_CREATED', 'AutomationRule', rule.id, null, { name, targetType });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_RULE_STATE_CHANGED', 'AUTOMATION_RULE', rule.id, { state: rule.state });
      return this.get(user, workspaceId, rule.id);
    });
  }

  update(user: User, workspaceId: string, ruleId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manage);
    const unknown = Object.keys(input).filter((key) => ![...RULE_KEYS, ...CONFIG_KEYS].includes(key));
    if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `These fields cannot be updated here: ${unknown.join(', ')}. Use the lifecycle commands for state changes.`, { fields: unknown });
    return this.support.store.atomicSync(() => {
      const rule = this.rule(workspaceId, ruleId);
      this.support.assertVersion(rule.version, input.version);
      if (rule.state === 'ARCHIVED') throw conflict('AUTOMATION_RULE_ARCHIVED', 'An archived Rule cannot be edited.');
      const before = { name: rule.name, priority: rule.priority, targetType: rule.targetType };
      if (input.name !== undefined) rule.name = this.readName(input.name);
      if (input.description !== undefined) rule.description = this.readDescription(input.description);
      if (input.priority !== undefined) rule.priority = this.readPriority(input.priority)!;
      if (input.targetType !== undefined && input.targetType !== rule.targetType) {
        if (this.state.automationRevisions.some((item) => item.ruleId === rule.id && item.state !== 'DRAFT')) throw conflict('AUTOMATION_TARGET_IMMUTABLE', 'The target of a published Rule cannot change. Create a new Rule instead.');
        rule.targetType = this.readTarget(input.targetType);
      }
      if (CONFIG_KEYS.some((key) => input[key] !== undefined)) {
        let draft = this.revision(workspaceId, rule.draftRevisionId);
        if (!draft) {
          // Editing a published Rule never touches the published revision: it starts a new draft from it.
          const active = this.revision(workspaceId, rule.activeRevisionId);
          const next = Math.max(0, ...this.state.automationRevisions.filter((item) => item.ruleId === rule.id).map((item) => item.revisionNumber)) + 1;
          draft = this.newRevision(rule, next, actor);
          this.state.automationRevisions.push(draft);
          rule.draftRevisionId = draft.id;
          this.writeDraft(workspaceId, draft, active ? this.configOf(active) : this.parseConfig({}, null));
        }
        this.writeDraft(workspaceId, draft, this.parseConfig(input, this.configOf(draft)));
      }
      rule.version += 1;
      rule.updatedAt = new Date();
      rule.updatedByUserId = actor.user.id;
      this.support.audit(actor, 'AUTOMATION.RULE_UPDATED', 'AutomationRule', rule.id, before, { name: rule.name, priority: rule.priority, targetType: rule.targetType });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_RULE_STATE_CHANGED', 'AUTOMATION_RULE', rule.id, { state: rule.state, version: rule.version });
      return this.get(user, workspaceId, rule.id);
    });
  }

  private newRevision(rule: AutomationRule, revisionNumber: number, actor: ActorContext): AutomationRevision {
    const now = new Date();
    return {
      id: this.support.store.id(),
      workspaceId: rule.workspaceId,
      ruleId: rule.id,
      revisionNumber,
      state: 'DRAFT',
      triggerCode: null,
      triggerConfig: {},
      conditionTree: null,
      conditionsVersion: 1,
      timing: { mode: 'IMMEDIATE' },
      executionPolicy: {},
      configHash: null,
      publishedAt: null,
      publishedByUserId: null,
      supersededAt: null,
      createdByUserId: actor.user.id,
      createdAt: now,
      updatedAt: now,
    };
  }

  private readName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw badRequest('VALIDATION_ERROR', 'name is required (max 200 characters).', { field: 'name' });
    return value.trim();
  }

  private readDescription(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > 2000) throw badRequest('VALIDATION_ERROR', 'description must be text (max 2000 characters).', { field: 'description' });
    return value.trim() || null;
  }

  private readPriority(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100_000) throw badRequest('VALIDATION_ERROR', 'priority must be an integer between 0 and 100000 (lower runs first).', { field: 'priority' });
    return value as number;
  }

  private readTarget(value: unknown): string {
    if (typeof value !== 'string' || !this.registry.targets.has(value)) throw new AppError('AUTOMATION_TARGET_NOT_FOUND', 'The target type is not registered for Automation.', 400, { field: 'targetType' });
    return value;
  }

  // ---- publish validation -------------------------------------------------------------------------------------------------------------

  /** Complete validation of a revision against the live registries. Publish refuses anything that returns a problem. */
  validate(workspaceId: string, rule: Pick<AutomationRule, 'targetType' | 'name'>, config: RevisionConfig): Problem[] {
    const problems: Problem[] = [];
    const add = (section: string, path: string, code: string, message: string) => problems.push({ section, path, code, message });
    const target = this.registry.targets.find(rule.targetType);
    if (!target) add('basics', '$.targetType', 'AUTOMATION_TARGET_NOT_FOUND', 'The target type is not registered.');

    const trigger = config.triggerCode ? this.registry.triggerFor(workspaceId, config.triggerCode) : undefined;
    if (!config.triggerCode) add('trigger', '$.trigger', 'AUTOMATION_TRIGGER_NOT_SUPPORTED', 'Choose a trigger.');
    else if (!trigger) {
      const disabled = this.registry.triggerFor(workspaceId, config.triggerCode, true);
      add('trigger', '$.trigger.code', disabled ? 'AUTOMATION_EXTENSION_DISABLED' : 'AUTOMATION_TRIGGER_NOT_SUPPORTED', disabled ? 'The custom trigger is disabled.' : `The trigger "${config.triggerCode}" is not available.`);
    } else if (!trigger.targetTypes.includes(rule.targetType)) add('trigger', '$.trigger.code', 'AUTOMATION_TRIGGER_NOT_SUPPORTED', `The trigger does not support ${rule.targetType}.`);
    else for (const problem of trigger.validateConfig(config.triggerConfig, rule.targetType, { workspaceId, store: this.support.store })) add('trigger', `$.trigger.config${problem.path.slice(1)}`, problem.code, problem.message);

    const operands = this.registry.operandsFor(workspaceId, rule.targetType, trigger);
    if (config.conditionTree) for (const problem of validateConditionTree(config.conditionTree, operands)) add('conditions', problem.path, problem.code, problem.message);

    if (config.actions.length === 0) add('actions', '$.actions', 'AUTOMATION_ACTION_NOT_SUPPORTED', 'Add at least one action.');
    const referenceable = new Set<string>(['target.id', 'target.title', 'trigger.eventType', 'trigger.eventId', 'trigger.occurredAt', 'actor.id', 'rule.name', 'now']);
    for (const ref of operands.keys()) if (ref.startsWith('target.') || ref.startsWith('trigger.')) referenceable.add(ref);
    config.actions.forEach((action, index) => {
      const at = `$.actions[${index}]`;
      const descriptor = this.registry.resolveAction(workspaceId, action.actionCode);
      if (!descriptor) {
        const disabled = this.registry.resolveAction(workspaceId, action.actionCode, true);
        add('actions', at, disabled ? 'AUTOMATION_EXTENSION_DISABLED' : 'AUTOMATION_ACTION_NOT_SUPPORTED', disabled ? 'The custom action is disabled.' : `The action "${action.actionCode}" is not available.`);
        return;
      }
      if (descriptor.targetTypes !== '*' && !descriptor.targetTypes.includes(rule.targetType)) add('actions', at, 'AUTOMATION_ACTION_NOT_SUPPORTED', `${descriptor.label} does not support ${rule.targetType}.`);
      if (!descriptor.isAvailable(this.services)) add('actions', at, 'AUTOMATION_ACTION_NOT_SUPPORTED', `${descriptor.label} is unavailable because its owning module is not connected.`);
      if (action.continueOnError && !descriptor.supportsContinueOnError) add('actions', `${at}.continueOnError`, 'AUTOMATION_ACTION_NOT_SUPPORTED', 'This action does not support continueOnError.');
      for (const problem of descriptor.validate(action.config, { workspaceId, targetType: rule.targetType, services: this.services })) add('actions', `${at}.config${problem.path.slice(1)}`, problem.code, problem.message);
      for (const ref of collectReferences(action.config)) {
        if (!isReferenceShape(ref) || !referenceable.has(ref)) add('actions', `${at}.config`, 'AUTOMATION_VARIABLE_UNAVAILABLE', `The variable {{${ref}}} is not available for this Rule.`);
      }
    });

    const timing = config.timing;
    if (timing.mode === 'RELATIVE_TO_FIELD' && target && !target.timingFields(workspaceId).some((field) => field.ref === timing.field)) {
      add('timing', '$.timing.field', 'AUTOMATION_TIMING_INVALID', 'The selected field is not a date field of this target.');
    }
    const policy = { ...DEFAULT_EXECUTION_POLICY, ...config.executionPolicy };
    if (policy.identity === 'INITIATING_USER') {
      if (timing.mode !== 'IMMEDIATE') add('policy', '$.executionPolicy.identity', 'AUTOMATION_POLICY_INVALID', 'Delayed and scheduled Rules run as the Automation service identity, not as a user.');
      if (trigger?.isExtension || config.triggerCode === 'activity.overdue') add('policy', '$.executionPolicy.identity', 'AUTOMATION_POLICY_INVALID', 'System and integration triggers have no initiating user; use the service identity.');
    }
    return problems;
  }

  // ---- lifecycle commands --------------------------------------------------------------------------------------------------------------------

  publish(user: User, workspaceId: string, ruleId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    // Publishing is a stronger capability than editing a draft.
    this.support.requireWorkspace(actor, P.publish);
    return this.support.store.atomicSync(() => {
      const rule = this.rule(workspaceId, ruleId);
      this.support.assertVersion(rule.version, input.version);
      if (rule.state === 'ARCHIVED') throw conflict('AUTOMATION_RULE_ARCHIVED', 'An archived Rule cannot be published.');
      const draft = this.revision(workspaceId, rule.draftRevisionId);
      if (!draft) throw new AppError('AUTOMATION_RULE_NOT_PUBLISHABLE', 'There is no draft to publish.', 400, { errors: [{ section: 'basics', path: '$', code: 'AUTOMATION_RULE_NOT_PUBLISHABLE', message: 'There is no draft to publish.' }] });
      const config = this.configOf(draft);
      const problems = this.validate(workspaceId, rule, config);
      if (problems.length > 0) throw new AppError('AUTOMATION_RULE_NOT_PUBLISHABLE', 'The Rule cannot be published until the listed problems are fixed.', 400, { errors: problems });

      const now = new Date();
      const previous = this.revision(workspaceId, rule.activeRevisionId);
      if (previous) {
        previous.state = 'SUPERSEDED';
        previous.supersededAt = now;
      }
      draft.state = 'PUBLISHED';
      draft.publishedAt = now;
      draft.publishedByUserId = actor.user.id;
      draft.configHash = configHashOf(rule.targetType, config);
      draft.updatedAt = now;
      rule.activeRevisionId = draft.id;
      rule.draftRevisionId = null;
      if (rule.state === 'DRAFT') rule.state = 'ACTIVE';
      rule.version += 1;
      rule.updatedAt = now;
      rule.updatedByUserId = actor.user.id;
      this.support.audit(actor, 'AUTOMATION.RULE_PUBLISHED', 'AutomationRule', rule.id, { activeRevisionId: previous?.id ?? null }, { activeRevisionId: draft.id, revisionNumber: draft.revisionNumber, configHash: draft.configHash });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_RULE_PUBLISHED', 'AUTOMATION_RULE', rule.id, { revisionId: draft.id, revisionNumber: draft.revisionNumber, state: rule.state });
      return this.get(user, workspaceId, rule.id);
    });
  }

  private setState(user: User, workspaceId: string, ruleId: string, input: Json, next: RuleState, permission: string, allowedFrom: RuleState[], action: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, permission);
    return this.support.store.atomicSync(() => {
      const rule = this.rule(workspaceId, ruleId);
      if (input.version !== undefined) this.support.assertVersion(rule.version, input.version);
      if (rule.state === next) return this.get(user, workspaceId, rule.id);
      if (!allowedFrom.includes(rule.state)) throw conflict('AUTOMATION_RULE_STATE_INVALID', `A Rule in state ${rule.state} cannot be moved to ${next}.`, { state: rule.state });
      if (next === 'ACTIVE' && !rule.activeRevisionId) throw conflict('AUTOMATION_RULE_NOT_PUBLISHABLE', 'Publish the Rule before enabling it.');
      const before = rule.state;
      rule.state = next;
      rule.version += 1;
      rule.updatedAt = new Date();
      rule.updatedByUserId = actor.user.id;
      this.support.audit(actor, action, 'AutomationRule', rule.id, { state: before }, { state: next });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_RULE_STATE_CHANGED', 'AUTOMATION_RULE', rule.id, { state: next, previousState: before });
      return this.get(user, workspaceId, rule.id);
    });
  }

  pause(user: User, workspaceId: string, ruleId: string, input: Json = {}) {
    return this.setState(user, workspaceId, ruleId, input, 'PAUSED', P.manage, ['ACTIVE'], 'AUTOMATION.RULE_PAUSED');
  }

  disable(user: User, workspaceId: string, ruleId: string, input: Json = {}) {
    return this.setState(user, workspaceId, ruleId, input, 'DISABLED', P.manage, ['ACTIVE', 'PAUSED'], 'AUTOMATION.RULE_DISABLED');
  }

  /** Re-activating executes logic again, so it needs the publish capability. */
  enable(user: User, workspaceId: string, ruleId: string, input: Json = {}) {
    return this.setState(user, workspaceId, ruleId, input, 'ACTIVE', P.publish, ['PAUSED', 'DISABLED'], 'AUTOMATION.RULE_ENABLED');
  }

  /** Never-published, unused Rules are deleted; anything with history is archived so logs keep their references. */
  remove(user: User, workspaceId: string, ruleId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manage);
    return this.support.store.atomicSync(() => {
      const rule = this.rule(workspaceId, ruleId);
      const used = this.state.automationRevisions.some((item) => item.ruleId === rule.id && item.state !== 'DRAFT') || this.state.automationExecutions.some((item) => item.ruleId === rule.id) || this.state.automationJobs.some((item) => item.ruleId === rule.id);
      if (!used) {
        const revisionIds = new Set(this.state.automationRevisions.filter((item) => item.ruleId === rule.id).map((item) => item.id));
        this.state.automationActions = this.state.automationActions.filter((item) => !revisionIds.has(item.revisionId));
        this.state.automationRevisions = this.state.automationRevisions.filter((item) => item.ruleId !== rule.id);
        this.state.automationRules = this.state.automationRules.filter((item) => item.id !== rule.id);
        this.support.audit(actor, 'AUTOMATION.RULE_DELETED', 'AutomationRule', rule.id, { name: rule.name }, null);
        return { id: rule.id, deleted: true, archived: false };
      }
      rule.state = 'ARCHIVED';
      rule.version += 1;
      rule.updatedAt = new Date();
      this.support.audit(actor, 'AUTOMATION.RULE_ARCHIVED', 'AutomationRule', rule.id, null, { state: 'ARCHIVED' });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_RULE_STATE_CHANGED', 'AUTOMATION_RULE', rule.id, { state: 'ARCHIVED' });
      return { id: rule.id, deleted: false, archived: true };
    });
  }
}
