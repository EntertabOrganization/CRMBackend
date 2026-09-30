import { NextResponse } from 'next/server';
import { appContext } from './app-context';
import { AppError, isAppError } from './errors';
import type { ApiFailure, ApiSuccess, PageMeta } from './domain';
import { claimDueJobsInDb } from './automation/db-claim';
import { hydrateState, persistState } from './persistence';
import { prisma } from './prisma-client';

export function ok<T>(data: T, meta: PageMeta | null = null) {
  return NextResponse.json<ApiSuccess<T>>({ success: true, data, meta });
}

export function fail(error: unknown, requestId = crypto.randomUUID()) {
  const appError = isAppError(error)
    ? error
    : new AppError('INTERNAL_ERROR', 'Unexpected server error.', 500);

  if (!isAppError(error)) {
    console.error(`[${requestId}] Unhandled route error:`, error);
  }

  return NextResponse.json<ApiFailure>(
    {
      success: false,
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
      requestId,
    },
    { status: appError.status },
  );
}

// Requests share one in-memory working state (hydrate -> mutate -> persist), so they run one at a time. Without this,
// two overlapping requests could see each other's half-finished state.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Database uniqueness is the last line of defence for invariants the domain also checks (SKU, Variant combination, ...).
 * A violation that slips past the application check is translated into the same stable business error instead of a 500.
 */
function translatePersistError(error: unknown): unknown {
  const candidate = error as { code?: string; meta?: { target?: unknown } } | null;
  if (candidate?.code === 'P2002') {
    const target = JSON.stringify(candidate.meta?.target ?? '');
    if (target.includes('sku_key')) return new AppError('PRODUCT_SKU_CONFLICT', 'This SKU is already used by another item in the workspace.', 409);
    if (target.includes('axis_key')) return new AppError('VARIANT_COMBINATION_CONFLICT', 'A Variant with this option combination already exists.', 409);
    if (target.includes('idempotency_key') && target.includes('workspace_id')) return new AppError('AUTOMATION_DUPLICATE_JOB', 'The automation job already exists.', 409);
    if (target.includes('commercial_pack_records_invoice_number')) return new AppError('INVOICE_NUMBER_CONFLICT', 'Invoice number was allocated concurrently.', 409);
    if (target.includes('commercial_pack_records_provider_event')) return new AppError('PAYMENT_PROVIDER_EVENT_DUPLICATE', 'Provider event was already processed.', 409);
    if (target.includes('commercial_pack_records_channel_event') || target.includes('commercial_pack_external_message')) return new AppError('CHANNEL_EVENT_DUPLICATE', 'Channel event/message was already processed.', 409);
    if (target.includes('commercial_pack_form_submission_idempotency')) return new AppError('IDEMPOTENCY_KEY_REUSED', 'Submission idempotency key already exists.', 409);
    if (target.includes('commercial_pack_outbound_client_message')) return new AppError('MESSAGE_ALREADY_EXISTS', 'Client message was already accepted.', 409);
    if (target.includes('commercial_pack_')) return new AppError('CONCURRENCY_CONFLICT', 'A concurrent operation changed the same business invariant.', 409);
  }
  return translateDatabaseError(error);
}

/** Converts unavailable/missing PostgreSQL failures into a stable, sanitized API contract. */
export function translateDatabaseError(error: unknown): unknown {
  const candidate = error as { code?: string; name?: string; message?: string } | null;
  const unavailableCodes = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1017']);
  if (
    (candidate?.code && unavailableCodes.has(candidate.code)) ||
    candidate?.name === 'PrismaClientInitializationError' ||
    /can't reach database server|server has closed the connection/i.test(candidate?.message ?? '')
  ) {
    return new AppError('DATABASE_UNAVAILABLE', 'The database is temporarily unavailable.', 503);
  }
  return error;
}

async function withState<T>(handler: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  let snapshot;
  try {
    snapshot = await hydrateState(prisma);
  } catch (error) {
    return { error: translateDatabaseError(error) };
  }
  appContext.store.state = structuredClone(snapshot);
  appContext.realtime.discard();
  let committed = false;
  let outcome: { result?: T; error?: unknown };
  try {
    const result = await handler();
    try {
      // Timeline is projected from the outbox events this request just wrote, in the same transaction.
      appContext.timeline.projectPending();
    } catch (projectionError) {
      // A projection failure must never fail the business operation; the events stay unprojected and are retried.
      console.error('Timeline projection failed:', projectionError);
    }
    try {
      // Automation matches the new events against active Rules and only records durable jobs here (no side effects);
      // the jobs run afterwards in their own transactions. A failure leaves the events unprocessed for a later retry.
      appContext.automation.ingestPending();
    } catch (ingestError) {
      console.error('Automation ingestion failed:', ingestError);
    }
    committed = true;
    outcome = { result };
  } catch (error) {
    outcome = { error };
  }
  if (committed) {
    try {
      await persistState(prisma, snapshot, appContext.store.state);
    } catch (persistError) {
      committed = false;
      appContext.store.state = structuredClone(snapshot);
      outcome = { error: translatePersistError(persistError) };
    }
  } else {
    // A failed handler is a failed transaction. Never persist mutations that
    // happened before validation/provider failure, and do not leave them in the
    // shared working state for the next request.
    appContext.store.state = structuredClone(snapshot);
  }
  // Advisory hints are released only after the commit, and only for successful requests.
  if (committed) appContext.realtime.flush();
  else appContext.realtime.discard();
  return outcome;
}

/** Runs a read-only handler against freshly hydrated state (nothing is persisted or projected). */
export function readOnly<T>(handler: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  return serialized(async () => {
    let snapshot;
    try {
      snapshot = await hydrateState(prisma);
    } catch (error) {
      return { error: translateDatabaseError(error) };
    }
    appContext.store.state = structuredClone(snapshot);
    try {
      return { result: await handler() };
    } catch (error) {
      return { error };
    }
  });
}

export function route<T>(handler: () => Promise<T>, meta: PageMeta | null = null) {
  return serialized(async () => {
    const outcome = await withState(handler);
    if (!('error' in outcome)) kickAutomationRunner();
    return 'error' in outcome ? fail(outcome.error) : ok(outcome.result as T, meta);
  });
}

export function routeWithMeta<T>(handler: () => Promise<{ data: T; meta: PageMeta | Record<string, unknown> | null }>) {
  return serialized(async () => {
    const outcome = await withState(handler);
    if ('error' in outcome) return fail(outcome.error);
    const value = outcome.result!;
    return ok(value.data, value.meta as PageMeta | null);
  });
}

// ---- Automation background work ---------------------------------------------------------------------------------------------

/** Runs one unit of system work (an Automation step) in its own hydrate -> run -> commit transaction and rethrows its error. */
export function runStateUnit<T>(handler: () => Promise<T> | T): Promise<T> {
  return serialized(async () => {
    const outcome = await withState(async () => handler());
    if ('error' in outcome) throw outcome.error;
    return outcome.result as T;
  });
}

const dbStateRunner = {
  unit: runStateUnit,
  claimDue: (limit: number, workerId: string, now: Date) => claimDueJobsInDb(prisma, limit, workerId, now),
};

function useDbRunner() {
  appContext.automation.setStateRunner(dbStateRunner);
  return appContext.automation.runner;
}

/** Claims and runs due Automation jobs (scheduler endpoint / optional inline runner). */
export async function runAutomationDue(limit = 25) {
  return useDbRunner().runDue({ limit });
}

/** Runs one specific pending job now (manual execution). Returns the execution id when a run happened. */
export async function runAutomationJob(jobId: string): Promise<string | null> {
  const runner = useDbRunner();
  const claimed = await runStateUnit(() => {
    const job = appContext.automation.support.state.automationJobs.find((item) => item.id === jobId);
    if (!job || job.status !== 'PENDING') return false;
    job.status = 'RUNNING';
    job.claimedBy = 'manual';
    job.leaseExpiresAt = new Date(Date.now() + 5 * 60_000);
    return true;
  });
  return claimed ? runner.runJob(jobId) : null;
}

let inlineRunnerActive = false;

/**
 * Optional in-process worker (AUTOMATION_INLINE_RUNNER=1): after a request commits, due jobs are run in the background.
 * Production deployments normally drive jobs through POST /api/v1/internal/crm/jobs/automation-run instead.
 */
export function kickAutomationRunner() {
  if (process.env.AUTOMATION_INLINE_RUNNER !== '1' || inlineRunnerActive) return;
  if (!appContext.automation.hasWork()) return;
  inlineRunnerActive = true;
  setImmediate(() => {
    runAutomationDue()
      .catch((error) => console.error('Inline automation runner failed:', error))
      .finally(() => {
        inlineRunnerActive = false;
      });
  });
}
