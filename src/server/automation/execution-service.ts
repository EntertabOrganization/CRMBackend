import type { User } from '../domain';
import { AppError, badRequest, conflict } from '../errors';
import { applyCursorQuery, parseCursorQuery } from '../query';
import type { ActionContext, ActionDescriptor, ActionServices, NetworkCall } from './actions';
import { ActionError, toActionError } from './actions';
import type { AutomationEngine } from './engine';
import type { AutomationIdentityService } from './identity';
import { redact, safeMessage } from './redact';
import type { AutomationRegistry } from './registry';
import type { RuleService } from './rule-service';
import { validateAgainstSchema } from './schema';
import type { AutomationSupport, Json } from './support';
import { LEASE_MS, isPlainObject } from './support';
import type {
  AutomationActionExecution,
  AutomationExecution,
  AutomationJob,
  AutomationRevision,
  AutomationRule,
  ExecutionPolicy,
  ExecutionStatus,
  TriggerContext,
} from './types';
import { AUTOMATION_PERMISSIONS as P, DEFAULT_EXECUTION_POLICY } from './types';
import { resolveTemplates } from './variables';

export type NetworkTicket = { executionId: string; actionExecutionId: string; call: NetworkCall };
export type StepResult = { kind: 'DONE' } | { kind: 'RAN' } | { kind: 'NETWORK'; ticket: NetworkTicket };
export type BeginResult = { kind: 'CONTINUE'; executionId: string } | { kind: 'FINISHED'; executionId: string | null } | { kind: 'IGNORED' };

const backoffMs = (attempts: number) => Math.min(60_000 * 4 ** Math.max(attempts - 1, 0), 3_600_000);
const isRetryJob = (job: AutomationJob) => /:retry:\d+$/.test(job.idempotencyKey);

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ActionError('AUTOMATION_ACTION_TIMEOUT', 'The action timed out.', true)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs pinned jobs: re-checks current state, executes ordered Actions through the owning services under an explicit
 * identity, records every attempt durably, retries only transient failures from the failed action, and never rolls back
 * (or repeats) side effects that already succeeded.
 */
export class AutomationExecutionService {
  constructor(
    private readonly support: AutomationSupport,
    private readonly registry: AutomationRegistry,
    private readonly rules: RuleService,
    private readonly engine: AutomationEngine,
    private readonly identity: AutomationIdentityService,
    private readonly services: ActionServices,
  ) {}

  private get state() {
    return this.support.state;
  }

  // ---- claiming --------------------------------------------------------------------------------------------------------------------------

  /** In-process claim (the production runner claims in SQL first; both use the same lease semantics). */
  claimDueJobs(now: Date, limit: number, workerId: string): string[] {
    const due = this.state.automationJobs
      .filter((job) => (job.status === 'PENDING' && job.scheduledAt <= now) || (job.status === 'RUNNING' && job.leaseExpiresAt !== null && job.leaseExpiresAt < now))
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const job of due) {
      job.status = 'RUNNING';
      job.claimedBy = workerId;
      job.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      job.updatedAt = now;
    }
    return due.map((job) => job.id);
  }

  // ---- begin ------------------------------------------------------------------------------------------------------------------------------

  private newExecution(job: AutomationJob, rule: AutomationRule, revision: AutomationRevision, now: Date): AutomationExecution {
    const execution: AutomationExecution = {
      id: this.support.store.id(),
      workspaceId: job.workspaceId,
      ruleId: rule.id,
      ruleRevisionId: revision.id,
      ruleName: rule.name,
      revisionNumber: revision.revisionNumber,
      jobId: job.id,
      targetType: job.targetType,
      targetId: job.targetId,
      targetTitle: null,
      sourceEventId: job.sourceEventId,
      triggerCode: job.triggerCode,
      timingMode: job.timingMode,
      status: 'RUNNING',
      initiatorType: job.initiatorType,
      initiatorId: job.initiatorId,
      identityKind: job.identityKind,
      identityUserId: null,
      correlationId: job.correlationId,
      causationId: job.causationId,
      depth: job.depth,
      conditionOutcome: null,
      skipReason: null,
      errorCode: null,
      errorSummary: null,
      retryCount: 0,
      isManual: job.sourceEventId.startsWith('manual:'),
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.automationExecutions.push(execution);
    job.executionId = execution.id;
    return execution;
  }

  private finishJob(job: AutomationJob, status: AutomationJob['status'], errorCode: string | null = null) {
    job.status = status;
    job.lastErrorCode = errorCode;
    job.leaseExpiresAt = null;
    job.claimedBy = null;
    job.updatedAt = new Date();
  }

  private terminate(job: AutomationJob, execution: AutomationExecution, status: ExecutionStatus, details: { reason?: string; code?: string; summary?: string } = {}): BeginResult {
    const now = new Date();
    execution.status = status;
    execution.skipReason = details.reason ?? execution.skipReason;
    execution.errorCode = details.code ?? null;
    execution.errorSummary = details.summary ?? null;
    execution.completedAt = now;
    execution.updatedAt = now;
    this.finishJob(job, status === 'FAILED_FINAL' ? 'FAILED' : status === 'CANCELLED' ? 'CANCELLED' : 'SKIPPED', details.code ?? null);
    const failed = status === 'FAILED_FINAL';
    this.support.log(job.workspaceId, failed ? 'ERROR' : 'INFO', failed ? (details.code ?? 'AUTOMATION_EXECUTION_FAILED') : 'AUTOMATION_EXECUTION_SKIPPED', details.summary ?? `Execution ${status}${details.reason ? ` (${details.reason})` : ''}.`, { ruleId: execution.ruleId, executionId: execution.id, jobId: job.id, correlationId: execution.correlationId });
    this.support.emit(job.workspaceId, null, failed ? 'AUTOMATION_EXECUTION_FAILED' : 'AUTOMATION_EXECUTION_SKIPPED', 'AUTOMATION_EXECUTION', execution.id, { status, reason: details.reason ?? '', code: details.code ?? '', ruleId: execution.ruleId }, execution.correlationId);
    return { kind: 'FINISHED', executionId: execution.id };
  }

  /** Gate + prepare a claimed job: rule state, revision integrity, target, staleness, conditions, identity, action rows. */
  beginJob(jobId: string, now: Date = new Date()): BeginResult {
    const job = this.state.automationJobs.find((item) => item.id === jobId);
    if (!job || job.status !== 'RUNNING') return { kind: 'IGNORED' };
    job.attempts += 1;
    job.updatedAt = now;
    const rule = this.state.automationRules.find((item) => item.id === job.ruleId && item.workspaceId === job.workspaceId);
    const revision = rule ? this.rules.revision(job.workspaceId, job.ruleRevisionId) : null;
    let execution = job.executionId ? this.state.automationExecutions.find((item) => item.id === job.executionId) ?? null : null;
    const resuming = Boolean(execution);
    if (!rule || !revision) {
      this.finishJob(job, 'FAILED', 'AUTOMATION_RULE_NOT_FOUND');
      return { kind: 'FINISHED', executionId: execution?.id ?? null };
    }
    if (!execution) execution = this.newExecution(job, rule, revision, now);
    else {
      execution.status = 'RUNNING';
      execution.completedAt = null;
      execution.errorCode = null;
      execution.errorSummary = null;
      execution.updatedAt = now;
    }
    if (!resuming) this.support.emit(job.workspaceId, null, 'AUTOMATION_EXECUTION_STARTED', 'AUTOMATION_EXECUTION', execution.id, { ruleId: rule.id, revisionNumber: revision.revisionNumber }, job.correlationId);

    // 1. The pinned revision must still be the exact configuration that was published.
    if (!this.engine.verifyRevision(rule, revision)) return this.terminate(job, execution, 'FAILED_FINAL', { code: 'AUTOMATION_REVISION_CORRUPT', summary: 'The pinned revision no longer matches its published checksum.' });

    // 2. Rule operational state (a human-initiated run/retry may still proceed for a paused Rule).
    const humanInitiated = execution.isManual || isRetryJob(job);
    if (rule.state === 'DISABLED' || rule.state === 'ARCHIVED' || (rule.state === 'PAUSED' && !humanInitiated) || (rule.state === 'DRAFT')) {
      return this.terminate(job, execution, 'SKIPPED_STALE', { reason: `RULE_${rule.state}`, summary: `The Rule is ${rule.state.toLowerCase()}.` });
    }

    // 3. Extensions/actions must still be available (uninstalled/disabled extensions never keep executing silently).
    const config = this.rules.configOf(revision);
    const trigger = this.registry.triggerFor(job.workspaceId, job.triggerCode);
    if (!trigger && job.triggerCode !== 'manual.execute') return this.terminate(job, execution, 'FAILED_FINAL', { code: 'AUTOMATION_EXTENSION_DISABLED', summary: 'The custom trigger is no longer available.' });
    for (const action of config.actions) {
      if (!this.registry.resolveAction(job.workspaceId, action.actionCode)) {
        const known = this.registry.resolveAction(job.workspaceId, action.actionCode, true);
        return this.terminate(job, execution, 'FAILED_FINAL', { code: known ? 'AUTOMATION_EXTENSION_DISABLED' : 'AUTOMATION_ACTION_NOT_SUPPORTED', summary: `The action "${action.actionCode}" is no longer available.` });
      }
    }

    // 4. Authoritative target (workspace-scoped) must still exist and be actionable.
    const target = this.registry.targets.get(job.targetType).load(job.workspaceId, job.targetId);
    if (!target) return this.terminate(job, execution, 'SKIPPED_STALE', { reason: 'TARGET_GONE', summary: 'The target record no longer exists.' });
    execution.targetTitle = target.title;
    if (!target.isActionable) return this.terminate(job, execution, 'SKIPPED_STALE', { reason: 'TARGET_NOT_ACTIONABLE', summary: 'The target record is archived or deleted.' });

    // 5. First run only: trigger-specific staleness, then the current-state conditions against the pinned trigger context.
    if (!resuming) {
      const reason = this.registry.triggerFor(job.workspaceId, job.triggerCode, true)?.staleReason?.(job.triggerContext, revision.triggerConfig, target) ?? null;
      if (reason) return this.terminate(job, execution, 'SKIPPED_STALE', { reason, summary: 'The record changed since the Rule matched.' });
      const evaluation = this.engine.evaluate(revision, rule, target, job.triggerContext);
      execution.conditionOutcome = { matched: evaluation.matched, nodes: evaluation.results };
      if (!evaluation.matched) return this.terminate(job, execution, 'SKIPPED_STALE', { reason: 'CONDITION_NO_LONGER_MATCHES', summary: 'The current record no longer satisfies the Rule conditions.' });
    }

    // 6. Explicit identity.
    const identity = this.identity.resolve(job);
    if (!identity) return this.terminate(job, execution, 'FAILED_FINAL', { code: 'AUTOMATION_IDENTITY_UNAVAILABLE', summary: 'The initiating user is no longer an active member of the workspace.' });
    execution.identityUserId = identity.user.id;

    // 7. Durable per-action records (created once; idempotency keys derive from the execution, so retries reuse them).
    const existing = this.state.automationActionExecutions.filter((row) => row.executionId === execution!.id);
    const actions = this.rules.actionsOf(revision.id);
    for (const [index, action] of actions.entries()) {
      if (existing.some((row) => row.actionOrder === index)) continue;
      this.state.automationActionExecutions.push({
        id: this.support.store.id(),
        workspaceId: job.workspaceId,
        executionId: execution.id,
        actionId: action.id,
        actionCode: action.actionCode,
        actionOrder: index,
        status: 'PENDING',
        attemptCount: 0,
        idempotencyKey: `${execution.id}:${action.id}`,
        continueOnError: action.continueOnError,
        retryable: false,
        errorCode: null,
        errorMessage: null,
        result: null,
        attempts: [],
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    // A crashed worker leaves an attempt RUNNING; it becomes an INTERRUPTED attempt and the action is retried with the same key.
    for (const row of this.state.automationActionExecutions.filter((item) => item.executionId === execution!.id && item.status === 'RUNNING')) {
      row.attempts = row.attempts.map((attempt, position) => (position === row.attempts.length - 1 && !attempt.endedAt ? { ...attempt, endedAt: now.toISOString(), outcome: 'INTERRUPTED' as const } : attempt));
      row.status = 'PENDING';
      row.updatedAt = now;
    }
    return { kind: 'CONTINUE', executionId: execution.id };
  }

  // ---- stepping ------------------------------------------------------------------------------------------------------------------------------

  private rows(executionId: string) {
    return this.state.automationActionExecutions.filter((row) => row.executionId === executionId).sort((a, b) => a.actionOrder - b.actionOrder);
  }

  private runningJob(executionId: string) {
    return this.state.automationJobs.find((job) => job.executionId === executionId && job.status === 'RUNNING');
  }

  private recordFailure(row: AutomationActionExecution, error: ActionError, secrets: string[] = []) {
    const now = new Date();
    row.status = 'FAILED';
    row.errorCode = error.code;
    row.errorMessage = safeMessage(error, secrets);
    row.retryable = error.retryable;
    row.completedAt = now;
    row.updatedAt = now;
    row.attempts = row.attempts.map((attempt, index) => (index === row.attempts.length - 1 ? { ...attempt, endedAt: now.toISOString(), outcome: 'FAILED' as const, errorCode: error.code } : attempt));
    const execution = this.state.automationExecutions.find((item) => item.id === row.executionId)!;
    this.support.log(row.workspaceId, 'ERROR', error.code, `Action ${row.actionCode} failed: ${row.errorMessage}`, { ruleId: execution.ruleId, executionId: execution.id, correlationId: execution.correlationId }, { actionOrder: row.actionOrder, attempt: row.attemptCount, retryable: error.retryable });
    this.support.emit(row.workspaceId, null, 'AUTOMATION_ACTION_FAILED', 'AUTOMATION_EXECUTION', execution.id, { actionCode: row.actionCode, code: error.code, retryable: error.retryable, ruleId: execution.ruleId }, execution.correlationId);
  }

  private recordSuccess(row: AutomationActionExecution, result: Record<string, unknown>) {
    const now = new Date();
    row.status = 'SUCCEEDED';
    row.errorCode = null;
    row.errorMessage = null;
    row.retryable = false;
    row.result = redact(result);
    row.completedAt = now;
    row.updatedAt = now;
    row.attempts = row.attempts.map((attempt, index) => (index === row.attempts.length - 1 ? { ...attempt, endedAt: now.toISOString(), outcome: 'SUCCEEDED' as const } : attempt));
  }

  /** The next action that must run, or null when the execution is complete or halted by a failed action. */
  private nextRow(rows: AutomationActionExecution[]) {
    for (const row of rows) {
      if (row.status === 'SUCCEEDED' || row.status === 'SKIPPED') continue;
      if (row.status === 'FAILED') {
        if (row.continueOnError) continue;
        return null;
      }
      return row;
    }
    return null;
  }

  /**
   * Executes (or prepares) the next Action. DOMAIN/ADAPTER actions run inside the caller's state transaction and are recorded
   * atomically with their own result, so a committed domain change always has its SUCCEEDED record (no duplicates on retry).
   * NETWORK actions are recorded RUNNING first; the caller performs the call outside the transaction and reports back.
   */
  async step(executionId: string): Promise<StepResult> {
    const execution = this.state.automationExecutions.find((item) => item.id === executionId);
    const job = this.runningJob(executionId);
    if (!execution || !job) return { kind: 'DONE' };
    const rows = this.rows(executionId);
    const row = this.nextRow(rows);
    if (!row) return { kind: 'DONE' };
    const rule = this.state.automationRules.find((item) => item.id === execution.ruleId)!;
    const revision = this.rules.revision(job.workspaceId, job.ruleRevisionId)!;
    const action = this.rules.actionsOf(revision.id).find((item) => item.id === row.actionId);
    const descriptor: ActionDescriptor | undefined = this.registry.resolveAction(job.workspaceId, row.actionCode);
    const now = new Date();
    // The attempt is recorded before anything runs; recordSuccess/recordFailure close it.
    row.status = 'RUNNING';
    row.attemptCount += 1;
    row.startedAt = row.startedAt ?? now;
    row.attempts = [...row.attempts, { attempt: row.attemptCount, startedAt: now.toISOString() }];
    row.updatedAt = now;

    if (!descriptor || !action) {
      this.recordFailure(row, new ActionError('AUTOMATION_ACTION_NOT_SUPPORTED', 'The action is no longer available.'));
      return { kind: 'RAN' };
    }
    const identity = this.identity.resolve(job);
    const target = this.registry.targets.get(job.targetType).load(job.workspaceId, job.targetId);
    if (!identity || !target) {
      this.recordFailure(row, new ActionError(identity ? 'AUTOMATION_TARGET_NOT_FOUND' : 'AUTOMATION_IDENTITY_UNAVAILABLE', identity ? 'The target record no longer exists.' : 'The execution identity is no longer available.'));
      return { kind: 'RAN' };
    }
    const missing = this.identity.missingPermissions(identity, descriptor, job.targetType);
    if (missing.length > 0) {
      this.recordFailure(row, new ActionError('PERMISSION_DENIED', `The execution identity lacks: ${missing.join(', ')}.`));
      return { kind: 'RAN' };
    }
    const scope = this.engine.scope(rule, target, job.triggerContext, identity.user.id);
    const input = resolveTemplates(action.config, scope) as Record<string, unknown>;
    const ctx: ActionContext = { workspaceId: job.workspaceId, user: identity.user, actor: identity.actor, targetType: job.targetType, target, idempotencyKey: row.idempotencyKey, executionId, services: this.services };

    if (descriptor.sideEffect === 'NETWORK') {
      try {
        const call = descriptor.buildNetworkCall!(ctx, input);
        return { kind: 'NETWORK', ticket: { executionId, actionExecutionId: row.id, call } };
      } catch (error) {
        this.recordFailure(row, toActionError(error));
        return { kind: 'RAN' };
      }
    }

    const outboxBefore = this.state.outboxEvents.length;
    try {
      const result = await this.support.store.atomic(async () => {
        const value = await withTimeout(Promise.resolve(descriptor.execute!(ctx, input)), descriptor.timeoutMs);
        // Everything the owning service emitted carries the chain's correlation/causation and depth (loop protection).
        for (const event of this.state.outboxEvents.slice(outboxBefore)) {
          event.correlationId = job.correlationId;
          event.causationId = executionId;
          event.automationDepth = job.depth + 1;
        }
        return value;
      });
      this.recordSuccess(row, result);
    } catch (error) {
      this.recordFailure(row, toActionError(error));
    }
    return { kind: 'RAN' };
  }

  /** Records the outcome of an off-transaction network call. */
  finishNetwork(ticket: NetworkTicket, outcome: { ok: true; response: { status: number; bytes: number } } | { ok: false; error: unknown }) {
    const row = this.state.automationActionExecutions.find((item) => item.id === ticket.actionExecutionId);
    if (!row || row.status !== 'RUNNING') return;
    if (outcome.ok) {
      const descriptor = this.registry.resolveAction(row.workspaceId, row.actionCode, true);
      this.recordSuccess(row, descriptor?.summarizeNetwork?.(outcome.response) ?? { status: outcome.response.status });
    } else {
      this.recordFailure(row, toActionError(outcome.error, ticket.call.secrets), ticket.call.secrets);
    }
  }

  /** Runs the network call for a ticket (no state access; safe to await outside the transaction). */
  async callNetwork(ticket: NetworkTicket): Promise<{ ok: true; response: { status: number; bytes: number } } | { ok: false; error: unknown }> {
    try {
      const response = await this.services.egress().send(ticket.call.request);
      return { ok: true, response };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // ---- finalize -----------------------------------------------------------------------------------------------------------------------------------

  finalize(executionId: string, now: Date = new Date()): ExecutionStatus | null {
    const execution = this.state.automationExecutions.find((item) => item.id === executionId);
    const job = this.state.automationJobs.find((item) => item.executionId === executionId && item.status === 'RUNNING');
    if (!execution || !job) return null;
    const rows = this.rows(executionId);
    const blocking = rows.find((row) => row.status === 'FAILED' && !row.continueOnError);
    const soft = rows.filter((row) => row.status === 'FAILED' && row.continueOnError);
    const pending = rows.filter((row) => row.status === 'PENDING');
    execution.updatedAt = now;

    if (blocking) {
      execution.errorCode = blocking.errorCode;
      execution.errorSummary = `Action ${blocking.actionOrder + 1} (${blocking.actionCode}) failed: ${blocking.errorMessage ?? blocking.errorCode}`;
      if (blocking.retryable && job.attempts < job.maxAttempts) {
        // Transient failure: resume from the failed action after a backoff; completed actions are never repeated.
        blocking.status = 'PENDING';
        execution.status = 'FAILED_RETRYABLE';
        job.status = 'PENDING';
        job.scheduledAt = new Date(now.getTime() + backoffMs(job.attempts));
        job.lastErrorCode = blocking.errorCode;
        job.leaseExpiresAt = null;
        job.claimedBy = null;
        job.updatedAt = now;
        this.support.log(execution.workspaceId, 'WARN', 'AUTOMATION_RETRY_SCHEDULED', `Retry ${job.attempts}/${job.maxAttempts} scheduled for ${job.scheduledAt.toISOString()}.`, { ruleId: execution.ruleId, executionId, jobId: job.id, correlationId: execution.correlationId });
        return execution.status;
      }
      for (const row of pending) {
        row.status = 'SKIPPED';
        row.updatedAt = now;
      }
      execution.status = 'FAILED_FINAL';
      execution.completedAt = now;
      this.finishJob(job, 'FAILED', blocking.errorCode);
      this.support.emit(execution.workspaceId, null, 'AUTOMATION_EXECUTION_FAILED', 'AUTOMATION_EXECUTION', execution.id, { status: execution.status, code: blocking.errorCode ?? '', ruleId: execution.ruleId }, execution.correlationId);
      return execution.status;
    }

    execution.errorCode = soft.length > 0 ? 'AUTOMATION_PARTIAL_FAILURE' : null;
    execution.errorSummary = soft.length > 0 ? `${soft.length} action(s) failed and were skipped (continueOnError).` : null;
    execution.status = soft.length > 0 ? 'SUCCEEDED_WITH_ERRORS' : 'SUCCEEDED';
    execution.completedAt = now;
    this.finishJob(job, 'SUCCEEDED');
    this.support.emit(execution.workspaceId, null, 'AUTOMATION_EXECUTION_SUCCEEDED', 'AUTOMATION_EXECUTION', execution.id, { status: execution.status, ruleId: execution.ruleId }, execution.correlationId);
    return execution.status;
  }

  // ---- human commands ---------------------------------------------------------------------------------------------------------------------------------

  retry(user: User, workspaceId: string, executionId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.retry);
    return this.support.store.atomicSync(() => {
      const execution = this.execution(workspaceId, executionId);
      const reason = (message: string) => new AppError('AUTOMATION_EXECUTION_NOT_RETRYABLE', message, 409, { status: execution.status });
      if (!['FAILED_FINAL', 'FAILED_RETRYABLE', 'SUCCEEDED_WITH_ERRORS'].includes(execution.status)) throw reason('Only failed executions can be retried.');
      if (execution.errorCode === 'AUTOMATION_LOOP_LIMIT_EXCEEDED') throw reason('A loop-blocked execution cannot be retried.');
      const rule = this.state.automationRules.find((item) => item.id === execution.ruleId);
      if (!rule || !['ACTIVE', 'PAUSED'].includes(rule.state)) throw reason('The Rule is not executable under the current policy.');
      const original = this.state.automationJobs.filter((job) => job.executionId === execution.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!original) throw reason('This execution has no runnable job.');
      const now = new Date();
      const pending = this.state.automationJobs.find((job) => job.executionId === execution.id && job.status === 'PENDING');
      if (pending) {
        pending.scheduledAt = now;
        pending.updatedAt = now;
      } else {
        const rows = this.rows(execution.id);
        if (!rows.some((row) => row.status === 'FAILED')) throw reason('There is no failed action to resume.');
        for (const row of rows) {
          if (row.status === 'FAILED' || row.status === 'SKIPPED') {
            row.status = 'PENDING';
            row.updatedAt = now;
          }
        }
        execution.retryCount += 1;
        execution.status = 'PENDING';
        execution.completedAt = null;
        const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, ...(this.rules.revision(workspaceId, execution.ruleRevisionId)?.executionPolicy ?? {}) };
        this.state.automationJobs.push({
          ...original,
          id: this.support.store.id(),
          status: 'PENDING',
          scheduledAt: now,
          attempts: 0,
          maxAttempts: policy.maxAttempts,
          idempotencyKey: `${original.idempotencyKey.replace(/:retry:\d+$/, '')}:retry:${execution.retryCount}`,
          executionId: execution.id,
          leaseExpiresAt: null,
          claimedBy: null,
          lastErrorCode: null,
          cancelledAt: null,
          cancelledByUserId: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      this.support.audit(actor, 'AUTOMATION.EXECUTION_RETRIED', 'AutomationExecution', execution.id, { status: execution.status }, { retryCount: execution.retryCount });
      return this.detail(actor, execution);
    });
  }

  cancelJob(user: User, workspaceId: string, jobId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.retry);
    return this.support.store.atomicSync(() => {
      const job = this.state.automationJobs.find((item) => item.id === jobId && item.workspaceId === workspaceId);
      if (!job) throw new AppError('AUTOMATION_JOB_NOT_FOUND', 'Automation job was not found.', 404);
      // Only work that has not started can be cancelled; a running/finished job may already have irreversible effects.
      if (job.status !== 'PENDING') throw new AppError('AUTOMATION_JOB_NOT_CANCELLABLE', `A ${job.status.toLowerCase()} job cannot be cancelled.`, 409, { status: job.status });
      const now = new Date();
      job.status = 'CANCELLED';
      job.cancelledAt = now;
      job.cancelledByUserId = actor.user.id;
      job.updatedAt = now;
      const rule = this.state.automationRules.find((item) => item.id === job.ruleId);
      const revision = this.rules.revision(workspaceId, job.ruleRevisionId);
      if (job.executionId) {
        const execution = this.state.automationExecutions.find((item) => item.id === job.executionId);
        if (execution && execution.status !== 'SUCCEEDED') {
          execution.status = 'CANCELLED';
          execution.completedAt = now;
          execution.updatedAt = now;
        }
      } else if (rule && revision) {
        this.engine.recordExecution(rule, revision, job.triggerContext, null, { ...DEFAULT_EXECUTION_POLICY, ...revision.executionPolicy }, 'CANCELLED', { skipReason: 'JOB_CANCELLED', initiator: { type: 'USER', id: actor.user.id }, jobId: job.id });
      }
      this.support.log(workspaceId, 'INFO', 'AUTOMATION_JOB_CANCELLED', 'The job was cancelled before it started.', { ruleId: job.ruleId, jobId: job.id, correlationId: job.correlationId });
      this.support.audit(actor, 'AUTOMATION.JOB_CANCELLED', 'AutomationJob', job.id, { status: 'PENDING' }, { status: 'CANCELLED' });
      return this.jobDto(job);
    });
  }

  // ---- manual execution / dry run ----------------------------------------------------------------------------------------------------------------------

  /**
   * Manual run: same revision, same conditions, same logging and idempotency as an automatic run - it only chooses the
   * record. It is never a condition bypass; a non-matching record produces a visible SKIPPED_CONDITION execution.
   */
  executeManually(user: User, workspaceId: string, ruleId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.execute);
    const unknown = Object.keys(input).filter((key) => !['targetId', 'idempotencyKey', 'revisionId'].includes(key));
    if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `Unsupported keys: ${unknown.join(', ')}.`);
    return this.support.store.atomicSync(() => {
      const rule = this.rules.rule(workspaceId, ruleId);
      const revision = this.rules.revision(workspaceId, rule.activeRevisionId);
      if (rule.state !== 'ACTIVE' || !revision || revision.state !== 'PUBLISHED') throw conflict('AUTOMATION_RULE_STATE_INVALID', 'Only an active, published Rule can be run manually.', { state: rule.state });
      if (input.revisionId !== undefined && input.revisionId !== revision.id) throw new AppError('AUTOMATION_RULE_VERSION_CONFLICT', 'The Rule has a newer published revision.', 409, { activeRevisionId: revision.id });
      const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, ...revision.executionPolicy };
      if (!policy.allowManual) throw new AppError('AUTOMATION_MANUAL_DISABLED', 'This Rule does not allow manual execution.', 403);
      if (typeof input.targetId !== 'string') throw badRequest('AUTOMATION_TARGET_NOT_FOUND', 'targetId is required.', { field: 'targetId' });
      const descriptor = this.registry.targets.get(rule.targetType);
      const target = descriptor.load(workspaceId, input.targetId);
      // Missing, foreign and inaccessible records are indistinguishable.
      if (!target || !descriptor.canAccess(actor, input.targetId, 'update')) throw new AppError('AUTOMATION_TARGET_NOT_FOUND', 'The target record was not found.', 404);
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200)) throw badRequest('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string (max 200 characters).');
      const eventId = `manual:${input.idempotencyKey ?? this.support.store.id()}`;
      const context: TriggerContext = {
        eventId,
        eventType: 'MANUAL',
        triggerCode: 'manual.execute',
        workspaceId,
        targetType: rule.targetType,
        targetId: input.targetId,
        occurredAt: new Date().toISOString(),
        actor: { type: 'USER', id: actor.user.id },
        correlationId: eventId,
        depth: 0,
      };
      const created = this.engine.matchRule(rule, revision, context, target, { initiator: context.actor, manual: true });
      const key = `${revision.id}:${eventId}:${input.targetId}`;
      const job = this.state.automationJobs.find((item) => item.workspaceId === workspaceId && item.idempotencyKey === key);
      const execution = this.state.automationExecutions.find((item) => item.workspaceId === workspaceId && item.ruleRevisionId === revision.id && item.sourceEventId === eventId && item.targetId === input.targetId);
      if (created > 0) this.support.audit(actor, 'AUTOMATION.RULE_EXECUTED_MANUALLY', 'AutomationRule', rule.id, null, { targetType: rule.targetType, targetId: input.targetId, revisionNumber: revision.revisionNumber });
      return { jobId: job?.id ?? null, execution: execution ? this.executionDto(execution) : null, queued: Boolean(job && job.status === 'PENDING') };
    });
  }

  /** Outcome of a queued manual run (summary only: log detail needs the view_logs capability). */
  resultForJob(user: User, workspaceId: string, jobId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.execute);
    const job = this.state.automationJobs.find((item) => item.id === jobId && item.workspaceId === workspaceId);
    if (!job) throw new AppError('AUTOMATION_JOB_NOT_FOUND', 'Automation job was not found.', 404);
    const execution = this.state.automationExecutions.find((item) => item.jobId === job.id || item.id === job.executionId);
    return { jobId: job.id, queued: job.status === 'PENDING', job: this.jobDto(job), execution: execution ? this.executionDto(execution) : null };
  }

  /** Simulation only: reads, evaluates and previews. It cannot write anything, call a provider or reach a network. */
  dryRun(user: User, workspaceId: string, ruleId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.manage, P.execute, P.publish);
    const unknown = Object.keys(input).filter((key) => !['targetId', 'revision', 'context'].includes(key));
    if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `Unsupported keys: ${unknown.join(', ')}.`);
    const rule = this.rules.rule(workspaceId, ruleId);
    const which = input.revision === 'ACTIVE' ? 'ACTIVE' : input.revision === 'DRAFT' ? 'DRAFT' : rule.draftRevisionId ? 'DRAFT' : 'ACTIVE';
    const revision = this.rules.revision(workspaceId, which === 'DRAFT' ? rule.draftRevisionId : rule.activeRevisionId);
    if (!revision) throw new AppError('AUTOMATION_RULE_NOT_FOUND', `The Rule has no ${which.toLowerCase()} revision.`, 404);
    const config = this.rules.configOf(revision);
    const validation = this.rules.validate(workspaceId, rule, config);
    const trigger = revision.triggerCode ? this.registry.triggerFor(workspaceId, revision.triggerCode, true) : undefined;
    const descriptor = this.registry.targets.find(rule.targetType);

    const testContext = isPlainObject(input.context) ? input.context : {};
    const extraContext = Object.keys(testContext).filter((key) => !['payload', 'changedFields'].includes(key));
    if (extraContext.length > 0) throw badRequest('AUTOMATION_CONDITION_INVALID', `Unsupported test context keys: ${extraContext.join(', ')}.`);
    if (testContext.payload !== undefined) {
      if (!trigger?.payloadSchema) throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', 'This trigger has no payload schema.');
      const problems = validateAgainstSchema(trigger.payloadSchema, testContext.payload);
      if (problems.length > 0) throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', 'The test payload does not match the trigger schema.', { errors: problems });
    }

    let target = null as ReturnType<NonNullable<typeof descriptor>['load']>;
    if (typeof input.targetId === 'string' && descriptor) {
      target = descriptor.load(workspaceId, input.targetId);
      if (!target || !descriptor.canAccess(actor, input.targetId, 'read')) throw new AppError('AUTOMATION_TARGET_NOT_FOUND', 'The target record was not found.', 404);
    }
    const now = new Date();
    const context: TriggerContext = {
      eventId: 'dry-run',
      eventType: 'DRY_RUN',
      triggerCode: revision.triggerCode ?? 'manual.execute',
      workspaceId,
      targetType: rule.targetType,
      targetId: target?.id ?? '',
      occurredAt: now.toISOString(),
      actor: { type: 'USER', id: actor.user.id },
      correlationId: 'dry-run',
      depth: 0,
      changedFields: isPlainObject(testContext.changedFields) ? (testContext.changedFields as TriggerContext['changedFields']) : undefined,
      payload: isPlainObject(testContext.payload) ? testContext.payload : undefined,
    };
    const evaluation = target ? this.engine.evaluate(revision, rule, target, context) : null;
    const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, ...revision.executionPolicy };
    const schedule = target ? this.engine.schedule(revision.timing, target, now) : null;
    const scope = target ? this.engine.scope(rule, target, context, actor.user.id) : null;
    const registered = new Set(this.identity.registeredPermissions(workspaceId));

    const resolvedActions = config.actions.map((action, index) => {
      const action_ = this.registry.resolveAction(workspaceId, action.actionCode);
      const problems = action_ ? action_.validate(action.config, { workspaceId, targetType: rule.targetType, services: this.services }) : [{ path: '$', code: 'AUTOMATION_ACTION_NOT_SUPPORTED', message: 'The action is not available.' }];
      const resolved = scope ? redact(resolveTemplates(action.config, scope)) : redact(action.config);
      const missing = action_ && policy.identity === 'SERVICE' ? action_.requiredPermissions(rule.targetType).filter((permission) => !registered.has(permission)) : [];
      return {
        order: index + 1,
        actionCode: action.actionCode,
        label: action_?.label ?? action.actionCode,
        continueOnError: action.continueOnError,
        sideEffect: action_?.sideEffect ?? null,
        valid: problems.length === 0 && missing.length === 0 && Boolean(action_?.isAvailable(this.services)),
        problems,
        resolved: action_ ? action_.preview(resolved as Record<string, unknown>) : resolved,
        missingPermissions: missing,
        wouldRun: Boolean(evaluation?.matched) && problems.length === 0,
      };
    });

    return {
      revision: { id: revision.id, number: revision.revisionNumber, state: revision.state },
      target: target ? { id: target.id, title: target.title } : null,
      matched: evaluation ? evaluation.matched : null,
      conditionResults: evaluation?.results ?? [],
      timing: { mode: revision.timing.mode, scheduledAt: schedule && 'at' in schedule ? schedule.at.toISOString() : null, skipReason: schedule && 'skip' in schedule ? schedule.skip : null },
      identity: { kind: policy.identity, description: policy.identity === 'SERVICE' ? 'Scoped Automation service identity' : 'The user whose action triggered the Rule' },
      validation,
      resolvedActions,
      sideEffectsExecuted: false,
    };
  }

  // ---- queries -------------------------------------------------------------------------------------------------------------------------------------------

  execution(workspaceId: string, executionId: unknown): AutomationExecution {
    const row = typeof executionId === 'string' ? this.state.automationExecutions.find((item) => item.id === executionId && item.workspaceId === workspaceId) : undefined;
    if (!row) throw new AppError('AUTOMATION_EXECUTION_NOT_FOUND', 'Automation execution was not found.', 404);
    return row;
  }

  executionDto(execution: AutomationExecution) {
    const started = execution.startedAt.getTime();
    const ended = execution.completedAt?.getTime();
    return {
      id: execution.id,
      ruleId: execution.ruleId,
      ruleName: execution.ruleName,
      revisionId: execution.ruleRevisionId,
      revisionNumber: execution.revisionNumber,
      jobId: execution.jobId,
      target: { type: execution.targetType, id: execution.targetId, title: execution.targetTitle },
      triggerCode: execution.triggerCode,
      timingMode: execution.timingMode,
      status: execution.status,
      isManual: execution.isManual,
      initiator: { type: execution.initiatorType, id: execution.initiatorId },
      identity: { kind: execution.identityKind, userId: execution.identityUserId },
      correlationId: execution.correlationId,
      causationId: execution.causationId,
      depth: execution.depth,
      skipReason: execution.skipReason,
      errorCode: execution.errorCode,
      errorSummary: execution.errorSummary,
      retryCount: execution.retryCount,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      durationMs: ended ? ended - started : null,
    };
  }

  jobDto(job: AutomationJob) {
    return {
      id: job.id,
      ruleId: job.ruleId,
      revisionId: job.ruleRevisionId,
      target: { type: job.targetType, id: job.targetId },
      triggerCode: job.triggerCode,
      timingMode: job.timingMode,
      status: job.status,
      scheduledAt: job.scheduledAt,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      correlationId: job.correlationId,
      depth: job.depth,
      lastErrorCode: job.lastErrorCode,
      executionId: job.executionId,
      cancelledAt: job.cancelledAt,
      createdAt: job.createdAt,
    };
  }

  detail(actor: { workspaceId: string }, execution: AutomationExecution) {
    const rows = this.rows(execution.id);
    const logs = this.state.automationLogs.filter((log) => log.executionId === execution.id || (log.jobId && log.jobId === execution.jobId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(-200);
    const jobs = this.state.automationJobs.filter((job) => job.executionId === execution.id || job.id === execution.jobId);
    return {
      ...this.executionDto(execution),
      conditionOutcome: execution.conditionOutcome,
      actions: rows.map((row) => ({
        id: row.id,
        order: row.actionOrder + 1,
        actionCode: row.actionCode,
        status: row.status,
        attemptCount: row.attemptCount,
        continueOnError: row.continueOnError,
        retryable: row.retryable,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        result: row.result,
        attempts: row.attempts,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      })),
      jobs: jobs.map((job) => this.jobDto(job)),
      logs: logs.map((log) => ({ id: log.id, level: log.level, code: log.code, message: log.message, data: log.data ? redact(log.data) : null, createdAt: log.createdAt })),
      canRetry: ['FAILED_FINAL', 'FAILED_RETRYABLE', 'SUCCEEDED_WITH_ERRORS'].includes(execution.status) && execution.errorCode !== 'AUTOMATION_LOOP_LIMIT_EXCEEDED' && Boolean(execution.jobId),
      canCancel: jobs.some((job) => job.status === 'PENDING'),
      workspaceId: actor.workspaceId,
    };
  }

  listExecutions(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.viewLogs);
    const q = (key: string) => searchParams.get(key) ?? undefined;
    const from = q('from') ? Date.parse(q('from')!) : undefined;
    const to = q('to') ? Date.parse(q('to')!) : undefined;
    if ((from !== undefined && Number.isNaN(from)) || (to !== undefined && Number.isNaN(to))) throw badRequest('AUTOMATION_QUERY_INVALID', 'from/to must be ISO timestamps.');
    const status = q('status')?.split(',');
    const rows = this.state.automationExecutions
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => !q('ruleId') || row.ruleId === q('ruleId'))
      .filter((row) => !q('targetType') || row.targetType === q('targetType'))
      .filter((row) => !q('targetId') || row.targetId === q('targetId'))
      .filter((row) => !status || status.includes(row.status))
      .filter((row) => !q('triggerCode') || row.triggerCode === q('triggerCode'))
      .filter((row) => !q('correlationId') || row.correlationId === q('correlationId'))
      .filter((row) => from === undefined || row.startedAt.getTime() >= from)
      .filter((row) => to === undefined || row.startedAt.getTime() <= to);
    const options = parseCursorQuery<AutomationExecution>(searchParams);
    const result = applyCursorQuery(rows as unknown as Array<AutomationExecution & Record<string, unknown>>, { ...options, sortBy: 'startedAt', sortOrder: 'desc', filters: undefined, search: undefined }, { searchable: [], filterable: [], sortable: ['startedAt'], defaultSortBy: 'startedAt' });
    return { data: (result.data as AutomationExecution[]).map((row) => this.executionDto(row)), meta: result.meta };
  }

  getExecution(user: User, workspaceId: string, executionId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.viewLogs);
    return this.detail(actor, this.execution(workspaceId, executionId));
  }

  listJobs(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.viewLogs, P.read);
    const status = searchParams.get('status')?.split(',');
    const rows = this.state.automationJobs.filter((job) => job.workspaceId === workspaceId && (!status || status.includes(job.status)) && (!searchParams.get('ruleId') || job.ruleId === searchParams.get('ruleId')));
    const options = parseCursorQuery<AutomationJob>(searchParams);
    const result = applyCursorQuery(rows as unknown as Array<AutomationJob & Record<string, unknown>>, { ...options, sortBy: 'scheduledAt', sortOrder: 'desc', filters: undefined, search: undefined }, { searchable: [], filterable: [], sortable: ['scheduledAt'], defaultSortBy: 'scheduledAt' });
    return { data: (result.data as AutomationJob[]).map((job) => this.jobDto(job)), meta: result.meta };
  }
}
