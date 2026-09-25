import type { AutomationExecutionService } from './execution-service';

/**
 * How a unit of Automation work gets a consistent view of application state. In production every unit hydrates state,
 * runs, and commits in ONE database transaction (and lets Automation ingest the events the unit produced); in tests a
 * passthrough runner works directly on the in-memory store.
 */
export interface StateRunner {
  unit<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Claims due jobs with lease semantics. Production implements this as an atomic SQL claim; the default claims in-process. */
  claimDue?(limit: number, workerId: string, now: Date): Promise<string[]>;
}

export class AutomationRunner {
  constructor(
    private readonly execution: AutomationExecutionService,
    private readonly stateRunner: () => StateRunner,
  ) {}

  /**
   * Runs one claimed job to completion. State-bound steps are separate units (each its own transaction); a NETWORK action is
   * recorded as RUNNING first, executed OUTSIDE any transaction, and its outcome recorded afterwards - a crash in between
   * leaves an INTERRUPTED attempt that the retry re-runs with the same idempotency key.
   */
  async runJob(jobId: string): Promise<string | null> {
    const state = this.stateRunner();
    const begin = await state.unit(() => this.execution.beginJob(jobId));
    if (begin.kind === 'IGNORED') return null;
    if (begin.kind === 'FINISHED') return begin.executionId;
    const executionId = begin.executionId;
    for (let guard = 0; guard < 100; guard += 1) {
      const step = await state.unit(() => this.execution.step(executionId));
      if (step.kind === 'DONE') break;
      if (step.kind === 'NETWORK') {
        const outcome = await this.execution.callNetwork(step.ticket);
        await state.unit(() => this.execution.finishNetwork(step.ticket, outcome));
      }
    }
    await state.unit(() => this.execution.finalize(executionId));
    return executionId;
  }

  /** Claims and runs every due job (bounded). Failures of one job never stop the others. */
  async runDue(options: { limit?: number; workerId?: string; now?: Date } = {}): Promise<{ claimed: number; executions: string[] }> {
    const state = this.stateRunner();
    const now = options.now ?? new Date();
    const workerId = options.workerId ?? `worker-${process.pid}`;
    const limit = options.limit ?? 25;
    const ids = state.claimDue ? await state.claimDue(limit, workerId, now) : await state.unit(() => this.execution.claimDueJobs(now, limit, workerId));
    const executions: string[] = [];
    for (const id of ids) {
      try {
        const executionId = await this.runJob(id);
        if (executionId) executions.push(executionId);
      } catch (error) {
        // The lease expires and the job is reclaimed; the failure is visible in the server log.
        console.error(`Automation job ${id} failed unexpectedly:`, error);
      }
    }
    return { claimed: ids.length, executions };
  }
}
