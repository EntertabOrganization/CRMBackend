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

export async function route<T>(handler: () => Promise<T>, meta: PageMeta | null = null) {
  const snapshot = await hydrateState(prisma);
  appContext.store.state = structuredClone(snapshot);
  try {
    const result = await handler();
    return ok(result, meta);
  } catch (error) {
    return fail(error);
  } finally {
    await persistState(prisma, snapshot, appContext.store.state);
  }
}

export async function routeWithMeta<T>(handler: () => Promise<{ data: T; meta: PageMeta | Record<string, unknown> | null }>) {
  const snapshot = await hydrateState(prisma);
  appContext.store.state = structuredClone(snapshot);
  try {
    const result = await handler();
    return ok(result.data, result.meta as PageMeta | null);
  } catch (error) {
    return fail(error);
  } finally {
    await persistState(prisma, snapshot, appContext.store.state);
  }
}
