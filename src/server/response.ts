import { NextResponse } from 'next/server';
import { appContext } from './app-context';
import { AppError, isAppError } from './errors';
import type { ApiFailure, ApiSuccess, PageMeta } from './domain';
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

async function withState<T>(handler: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  const snapshot = await hydrateState(prisma);
  appContext.store.state = structuredClone(snapshot);
  appContext.realtime.discard();
  let committed = false;
  try {
    const result = await handler();
    try {
      // Timeline is projected from the outbox events this request just wrote, in the same transaction.
      appContext.timeline.projectPending();
    } catch (projectionError) {
      // A projection failure must never fail the business operation; the events stay unprojected and are retried.
      console.error('Timeline projection failed:', projectionError);
    }
    committed = true;
    return { result };
  } catch (error) {
    return { error };
  } finally {
    await persistState(prisma, snapshot, appContext.store.state);
    // Advisory hints are released only after the commit, and only for successful requests.
    if (committed) appContext.realtime.flush();
    else appContext.realtime.discard();
  }
}

/** Runs a read-only handler against freshly hydrated state (nothing is persisted or projected). */
export function readOnly<T>(handler: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  return serialized(async () => {
    const snapshot = await hydrateState(prisma);
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
