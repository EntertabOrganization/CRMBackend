import type { OutboxEvent } from '../domain';
import type { ActionServices } from './actions';
import type { NodeResult, OperandDescriptor, OperandResolution } from './conditions';
import { evaluateConditionTree, isEmptyValue } from './conditions';
import type { AutomationIdentityService } from './identity';
import type { AutomationRegistry, TargetRecord, TriggerDescriptor } from './registry';
import type { RuleService } from './rule-service';
import { configHashOf } from './rule-service';
import type { AutomationSupport } from './support';
import { MAX_AUTOMATION_DEPTH } from './support';
import type {
  AutomationExecution,
  AutomationJob,
  AutomationRevision,
  AutomationRule,
  ExecutionPolicy,
  ExecutionStatus,
  TimingConfig,
  TimingMode,
  TriggerContext,
} from './types';
import { DEFAULT_EXECUTION_POLICY } from './types';
import type { VariableScope } from './variables';

const BATCH = 200;

export type Evaluation = { matched: boolean; results: NodeResult[] };

/**
 * Event matching and job creation. Runs after the source transaction's outbox rows exist and only records durable jobs and
 * skip/loop diagnostics: no Action side effect can happen here.
 */
export class AutomationEngine {
  constructor(
    private readonly support: AutomationSupport,
    private readonly registry: AutomationRegistry,
    private readonly rules: RuleService,
    private readonly identity: AutomationIdentityService,
    private readonly services: ActionServices,
  ) {}

  private get state() {
    return this.support.state;
  }

  // ---- evaluation helpers ---------------------------------------------------------------------------------------------------------

  operandsFor(workspaceId: string, targetType: string, triggerCode: string | null): Map<string, OperandDescriptor> {
    const trigger = triggerCode ? this.registry.triggerFor(workspaceId, triggerCode, true) : undefined;
    return this.registry.operandsFor(workspaceId, targetType, trigger);
  }

  /**
   * Evaluates the revision's condition tree. Record fields come from the CURRENT authoritative record; trigger before/after
   * values and custom-trigger payload come from the pinned event context and are never recomputed.
   */
  evaluate(revision: AutomationRevision, rule: Pick<AutomationRule, 'workspaceId' | 'targetType'>, target: TargetRecord, ctx: TriggerContext): Evaluation {
    const operands = this.operandsFor(rule.workspaceId, rule.targetType, revision.triggerCode);
    const resolve = (ref: string): OperandResolution => {
      if (ref.startsWith('target.')) {
        const key = ref.slice('target.'.length);
        const values = target.conditionValues[key] ?? [];
        let changed = ctx.changedFields?.[key] ?? null;
        if (!changed && key === 'stageId' && ctx.stage && ctx.stage.fromStageId !== undefined) changed = { before: ctx.stage.fromStageId, after: ctx.stage.stageId };
        return { values, empty: isEmptyValue(values), changed };
      }
      if (ref.startsWith('trigger.payload.')) {
        const value = ctx.payload?.[ref.slice('trigger.payload.'.length)];
        const values = value === undefined || value === null ? [] : [value];
        return { values, empty: isEmptyValue(values) };
      }
      if (ref === 'actor.id') {
        const values = ctx.actor.id ? [ctx.actor.id] : [];
        return { values, empty: values.length === 0 };
      }
      return { values: [new Date().toISOString()], empty: false };
    };
    return evaluateConditionTree(revision.conditionTree, operands, resolve);
  }

  scope(rule: Pick<AutomationRule, 'name'>, target: TargetRecord, ctx: TriggerContext, actorId: string): VariableScope {
    const trigger: Record<string, unknown> = { eventType: ctx.eventType, eventId: ctx.eventId, occurredAt: ctx.occurredAt };
    for (const [key, value] of Object.entries(ctx.payload ?? {})) trigger[`payload.${key}`] = value;
    trigger.payload = ctx.payload ?? {};
    return {
      target: { id: target.id, title: target.title, ...target.templateValues },
      trigger,
      actor: { id: actorId },
      rule: { name: rule.name },
      now: new Date().toISOString(),
    };
  }

  /** When should a matched job run? SKIP means the configured moment is already gone and the Rule says not to run late. */
  schedule(timing: TimingConfig, target: TargetRecord, now: Date): { at: Date } | { skip: string } {
    switch (timing.mode) {
      case 'IMMEDIATE':
        return { at: now };
      case 'DELAY':
        return { at: new Date(now.getTime() + timing.delayMinutes * 60_000) };
      case 'SCHEDULED': {
        const at = new Date(timing.runAt);
        return { at: at.getTime() < now.getTime() ? now : at };
      }
      case 'RELATIVE_TO_FIELD': {
        const raw = target.conditionValues[timing.field.replace(/^target\./, '')]?.[0];
        const base = typeof raw === 'string' ? Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw) : raw instanceof Date ? raw.getTime() : NaN;
        if (Number.isNaN(base)) return { skip: 'TIMING_FIELD_EMPTY' };
        const at = new Date(base + timing.offsetMinutes * 60_000);
        if (at.getTime() < now.getTime()) return timing.ifPast === 'SKIP' ? { skip: 'SCHEDULE_IN_PAST' } : { at: now };
        return { at };
      }
    }
  }

  // ---- ingestion -------------------------------------------------------------------------------------------------------------------------

  /** Consumes outbox events the Automation consumer has not seen yet. Idempotent: each event is marked once and jobs are deduped by key. */
  ingestPending(): { scanned: number; jobs: number } {
    const pending = this.state.outboxEvents
      .filter((event) => !event.automationProcessedAt)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, BATCH);
    let jobs = 0;
    for (const event of pending) {
      try {
        jobs += this.support.store.atomicSync(() => this.processEvent(event));
      } catch (error) {
        // A poison event must never block the queue: it is logged visibly and skipped.
        this.support.log(event.workspaceId, 'ERROR', 'AUTOMATION_INGEST_FAILED', `Event ${event.eventType} could not be matched.`, { correlationId: event.correlationId ?? event.id }, { eventType: event.eventType, error: error instanceof Error ? error.message : 'unknown' });
      }
      event.automationProcessedAt = new Date();
    }
    return { scanned: pending.length, jobs };
  }

  private baseContext(event: OutboxEvent, trigger: TriggerDescriptor, targetType: string): TriggerContext {
    const service = this.identity.isServiceUser(event.actorUserId);
    return {
      eventId: event.id,
      eventType: event.eventType,
      triggerCode: trigger.code,
      workspaceId: event.workspaceId,
      targetType,
      targetId: event.entityId,
      occurredAt: event.occurredAt.toISOString(),
      actor: event.actorUserId ? { type: service ? 'SERVICE' : 'USER', id: event.actorUserId } : { type: 'SYSTEM' },
      correlationId: event.correlationId ?? event.id,
      causationId: event.causationId ?? undefined,
      depth: event.automationDepth ?? 0,
    };
  }

  private processEvent(event: OutboxEvent): number {
    if (event.eventType.startsWith('AUTOMATION_')) return 0;
    const triggers = this.registry.triggersForEvent(event.eventType);
    if (triggers.length === 0) return 0;
    const targetType = event.entityType;
    if (!this.registry.targets.has(targetType)) return 0;
    let created = 0;
    for (const trigger of triggers) {
      if (!trigger.targetTypes.includes(targetType)) continue;
      const candidates = this.activeRules(event.workspaceId, targetType, trigger.code);
      if (candidates.length === 0) continue;
      const base = this.baseContext(event, trigger, targetType);
      const target = this.registry.targets.get(targetType).load(event.workspaceId, event.entityId);
      if (!target) continue;
      for (const { rule, revision } of candidates) {
        if (revision.publishedAt && event.occurredAt.getTime() < revision.publishedAt.getTime()) continue;
        const context = trigger.buildContext(event, revision.triggerConfig, base);
        if (!context) continue;
        created += this.matchRule(rule, revision, context, target, { initiator: context.actor });
      }
    }
    return created;
  }

  /** Active published Rules for a target+trigger, in deterministic order: priority, then creation time, then id. */
  activeRules(workspaceId: string, targetType: string, triggerCode: string) {
    const out: Array<{ rule: AutomationRule; revision: AutomationRevision }> = [];
    for (const rule of this.state.automationRules) {
      if (rule.workspaceId !== workspaceId || rule.state !== 'ACTIVE' || rule.targetType !== targetType || !rule.activeRevisionId) continue;
      const revision = this.rules.revision(workspaceId, rule.activeRevisionId);
      if (revision && revision.state === 'PUBLISHED' && revision.triggerCode === triggerCode) out.push({ rule, revision });
    }
    return out.sort((a, b) => a.rule.priority - b.rule.priority || a.rule.createdAt.getTime() - b.rule.createdAt.getTime() || a.rule.id.localeCompare(b.rule.id));
  }

  /** One Rule against one event: loop guard, conditions, then a durable job (or a visible skip record). Returns jobs created. */
  matchRule(
    rule: AutomationRule,
    revision: AutomationRevision,
    context: TriggerContext,
    target: TargetRecord,
    options: { initiator: TriggerContext['actor']; manual?: boolean },
  ): number {
    const workspaceId = rule.workspaceId;
    const dedupeKey = `${revision.id}:${context.eventId}:${context.targetId}`;
    if (this.state.automationJobs.some((job) => job.workspaceId === workspaceId && job.idempotencyKey === dedupeKey)) return 0;
    if (this.state.automationExecutions.some((execution) => execution.workspaceId === workspaceId && execution.ruleRevisionId === revision.id && execution.sourceEventId === context.eventId && execution.targetId === context.targetId)) return 0;

    const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, ...revision.executionPolicy };
    const loop = this.loopReason(rule, context);
    if (loop) {
      this.recordExecution(rule, revision, context, target, policy, 'FAILED_FINAL', { skipReason: loop, errorCode: 'AUTOMATION_LOOP_LIMIT_EXCEEDED', errorSummary: `Automation chain stopped (${loop === 'DEPTH' ? `depth limit ${MAX_AUTOMATION_DEPTH} reached` : 'this Rule already ran for this record in the same chain'}).`, initiator: options.initiator });
      this.support.log(workspaceId, 'ERROR', 'AUTOMATION_LOOP_BLOCKED', `Rule "${rule.name}" was blocked to stop an automation loop (${loop}).`, { ruleId: rule.id, correlationId: context.correlationId }, { depth: context.depth, targetType: context.targetType, targetId: context.targetId });
      this.support.emit(workspaceId, null, 'AUTOMATION_LOOP_BLOCKED', 'AUTOMATION_RULE', rule.id, { reason: loop, depth: context.depth, correlationId: context.correlationId }, context.correlationId);
      return 0;
    }

    const evaluation = this.evaluate(revision, rule, target, context);
    if (!evaluation.matched) {
      this.recordExecution(rule, revision, context, target, policy, 'SKIPPED_CONDITION', { skipReason: 'CONDITIONS_NOT_MET', outcome: evaluation, initiator: options.initiator });
      return 0;
    }
    // Anchor event-driven scheduling to the durable event timestamp. Using the
    // ingestion wall clock makes an IMMEDIATE job a few milliseconds newer than
    // the runner's supplied `now`, and also lets queue lag shift delayed jobs.
    const eventTime = new Date(context.occurredAt);
    const planned = options.manual ? { at: new Date() } : this.schedule(revision.timing, target, eventTime);
    if ('skip' in planned) {
      this.recordExecution(rule, revision, context, target, policy, 'SKIPPED_STALE', { skipReason: planned.skip, outcome: evaluation, initiator: options.initiator });
      return 0;
    }
    const now = new Date();
    const initiatorType = options.initiator.type;
    const job: AutomationJob = {
      id: this.support.store.id(),
      workspaceId,
      ruleId: rule.id,
      ruleRevisionId: revision.id,
      targetType: context.targetType,
      targetId: context.targetId,
      sourceEventId: context.eventId,
      triggerCode: context.triggerCode,
      timingMode: (options.manual ? 'IMMEDIATE' : revision.timing.mode) as TimingMode,
      scheduledAt: planned.at,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: policy.maxAttempts,
      idempotencyKey: dedupeKey,
      correlationId: context.correlationId,
      causationId: context.causationId ?? null,
      depth: context.depth,
      triggerContext: context,
      initiatorType,
      initiatorId: options.initiator.id ?? null,
      identityKind: policy.identity,
      executionId: null,
      leaseExpiresAt: null,
      claimedBy: null,
      lastErrorCode: null,
      cancelledAt: null,
      cancelledByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.automationJobs.push(job);
    this.support.log(workspaceId, 'INFO', 'AUTOMATION_JOB_CREATED', `Rule "${rule.name}" matched; job scheduled for ${planned.at.toISOString()}.`, { ruleId: rule.id, jobId: job.id, correlationId: context.correlationId });
    return 1;
  }

  private loopReason(rule: AutomationRule, context: TriggerContext): 'DEPTH' | 'REPLAY' | null {
    if (context.depth >= MAX_AUTOMATION_DEPTH) return 'DEPTH';
    if (context.depth > 0 && this.state.automationExecutions.some((execution) => execution.workspaceId === rule.workspaceId && execution.correlationId === context.correlationId && execution.ruleId === rule.id && execution.targetId === context.targetId)) return 'REPLAY';
    if (context.depth > 0 && this.state.automationJobs.some((job) => job.workspaceId === rule.workspaceId && job.correlationId === context.correlationId && job.ruleId === rule.id && job.targetId === context.targetId)) return 'REPLAY';
    return null;
  }

  /** Durable execution row for outcomes that never became a job (skipped, blocked). */
  recordExecution(
    rule: AutomationRule,
    revision: AutomationRevision,
    context: TriggerContext,
    target: TargetRecord | null,
    policy: ExecutionPolicy,
    status: ExecutionStatus,
    details: { skipReason?: string; errorCode?: string; errorSummary?: string; outcome?: Evaluation; initiator: TriggerContext['actor']; jobId?: string | null; isManual?: boolean },
  ): AutomationExecution {
    const now = new Date();
    const execution: AutomationExecution = {
      id: this.support.store.id(),
      workspaceId: rule.workspaceId,
      ruleId: rule.id,
      ruleRevisionId: revision.id,
      ruleName: rule.name,
      revisionNumber: revision.revisionNumber,
      jobId: details.jobId ?? null,
      targetType: context.targetType,
      targetId: context.targetId,
      targetTitle: target?.title ?? null,
      sourceEventId: context.eventId,
      triggerCode: context.triggerCode,
      timingMode: revision.timing.mode,
      status,
      initiatorType: details.initiator.type,
      initiatorId: details.initiator.id ?? null,
      identityKind: policy.identity,
      identityUserId: null,
      correlationId: context.correlationId,
      causationId: context.causationId ?? null,
      depth: context.depth,
      conditionOutcome: details.outcome ? { matched: details.outcome.matched, nodes: details.outcome.results } : null,
      skipReason: details.skipReason ?? null,
      errorCode: details.errorCode ?? null,
      errorSummary: details.errorSummary ?? null,
      retryCount: 0,
      isManual: details.isManual ?? false,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.state.automationExecutions.push(execution);
    if (status === 'SKIPPED_CONDITION' || status === 'SKIPPED_STALE') {
      this.support.emit(rule.workspaceId, null, 'AUTOMATION_EXECUTION_SKIPPED', 'AUTOMATION_EXECUTION', execution.id, { status, reason: details.skipReason ?? '', ruleId: rule.id }, context.correlationId);
    } else if (status === 'FAILED_FINAL') {
      this.support.emit(rule.workspaceId, null, 'AUTOMATION_EXECUTION_FAILED', 'AUTOMATION_EXECUTION', execution.id, { status, code: details.errorCode ?? '', ruleId: rule.id }, context.correlationId);
    }
    return execution;
  }

  /** Integrity: the stored revision must still hash to what was published (tamper/corruption detection). */
  verifyRevision(rule: AutomationRule, revision: AutomationRevision): boolean {
    if (!revision.configHash) return false;
    return configHashOf(rule.targetType, this.rules.configOf(revision)) === revision.configHash;
  }

  get servicesBundle() {
    return this.services;
  }
}
