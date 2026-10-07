import { NextRequest, NextResponse } from 'next/server';
import type { ActorContext } from '../access-service';
import type { User } from '../domain';
import { AppError } from '../errors';
import { readJson } from '../request';
import { routeWithMeta } from '../response';
import { requireWorkspaceContext } from '../route-helpers';
import { Body } from './support';
import type { CursorResult, PageResult } from './support';

/**
 * One catch-all Next route file per top-level prefix delegates here. Authentication and Workspace resolution run BEFORE
 * route matching, so an anonymous caller learns nothing about which paths exist. Handlers run inside the repository's
 * transactional request wrapper (hydrate -> mutate -> persist state + outbox + audit in one database transaction).
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type AuthedContext = {
  request: NextRequest;
  actor: ActorContext;
  user: User;
  workspaceId: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
  idempotencyKey: string | undefined;
  ifMatch: number | undefined;
};

export type PublicContext = Omit<AuthedContext, 'actor' | 'user' | 'workspaceId'> & { clientKey: string };

/** Marks a list result so the envelope carries pagination meta. */
export class Listed<T> {
  constructor(readonly data: T[], readonly meta: PageResult<T>['meta'] | CursorResult<T>['meta']) {}
}

export const listed = <T>(result: PageResult<T> | CursorResult<T>) => new Listed(result.data, result.meta);

/** A single resource plus envelope meta (e.g. non-blocking warnings). */
export class WithMeta<T> {
  constructor(readonly data: T, readonly meta: Record<string, unknown>) {}
}

/** Non-200 success status (e.g. 202 Accepted for queued long-running work). */
export class WithStatus<T> {
  constructor(readonly status: number, readonly data: T) {}
}

type Handler = (ctx: AuthedContext) => unknown;
type PublicHandler = (ctx: PublicContext) => unknown;
type RouteEntry = { method: Method; segments: string[]; handler: Handler | PublicHandler; isPublic: boolean };

export class CollabRouter {
  private readonly routes: RouteEntry[] = [];

  private add(method: Method, path: string, handler: Handler | PublicHandler, isPublic: boolean) {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler, isPublic });
    return this;
  }

  get(path: string, handler: Handler) { return this.add('GET', path, handler, false); }
  post(path: string, handler: Handler) { return this.add('POST', path, handler, false); }
  put(path: string, handler: Handler) { return this.add('PUT', path, handler, false); }
  patch(path: string, handler: Handler) { return this.add('PATCH', path, handler, false); }
  delete(path: string, handler: Handler) { return this.add('DELETE', path, handler, false); }
  publicRoute(method: Method, path: string, handler: PublicHandler) { return this.add(method, path, handler, true); }

  /** Literal segments win over parameters at the first position where candidates differ (`/tasks/planner` beats `/tasks/:id`). */
  match(method: Method, segments: string[]) {
    const candidates: Array<{ entry: RouteEntry; params: Record<string, string>; score: string }> = [];
    for (const entry of this.routes) {
      if (entry.method !== method || entry.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let score = '';
      let ok = true;
      for (let index = 0; index < segments.length; index += 1) {
        const pattern = entry.segments[index];
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = segments[index];
          score += '0';
        } else if (pattern === segments[index]) {
          score += '1';
        } else {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push({ entry, params, score });
    }
    candidates.sort((a, b) => b.score.localeCompare(a.score));
    return candidates[0] ?? null;
  }

  pathExists(segments: string[]) {
    return (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as Method[]).some((method) => this.match(method, segments));
  }
}

function ifMatchOf(request: NextRequest) {
  const raw = request.headers.get('if-match');
  if (!raw) return undefined;
  const value = Number(raw.replace(/^W\//, '').replace(/"/g, ''));
  return Number.isInteger(value) ? value : undefined;
}

async function bodyOf(request: NextRequest, method: Method) {
  if (method === 'GET' || method === 'DELETE') {
    const text = await request.text().catch(() => '');
    if (!text.trim()) return new Body({});
    try {
      return new Body(JSON.parse(text));
    } catch {
      throw new AppError('INVALID_JSON', 'Request body must be valid JSON.', 400);
    }
  }
  return new Body(await readJson<Record<string, unknown>>(request));
}

function unwrap(result: unknown) {
  if (result instanceof Listed) return { data: result.data, meta: result.meta as never };
  if (result instanceof WithMeta) return { data: result.data, meta: result.meta as never };
  return { data: result, meta: null };
}

async function respond(task: () => Promise<unknown>) {
  let status = 200;
  const response = await routeWithMeta(async () => {
    const result = await task();
    if (result instanceof WithStatus) {
      status = result.status;
      return unwrap(result.data);
    }
    return unwrap(result);
  });
  if (status === 200 || response.status !== 200) return response;
  return new NextResponse(response.body, { status, headers: response.headers });
}

type Params = { params: Promise<{ path?: string[] | string }> };

/** Builds the exported handlers of `app/api/v1/<prefix>/[[...path]]/route.ts`. */
export function collabRouteHandlers(prefix: string, router: () => CollabRouter) {
  const handle = (method: Method) => async (request: NextRequest, context: Params) => {
    const raw = (await context.params).path;
    const rest = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const segments = [...prefix.split('/'), ...rest];
    return respond(async () => {
      const found = router().match(method, segments);
      if (found?.entry.isPublic) {
        const body = await bodyOf(request, method);
        const clientKey = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
        return (found.entry.handler as PublicHandler)({ request, params: found.params, query: request.nextUrl.searchParams, body, idempotencyKey: request.headers.get('idempotency-key') ?? undefined, ifMatch: ifMatchOf(request), clientKey });
      }
      const { actor, user, workspaceId } = await requireWorkspaceContext(request);
      if (!found) {
        throw router().pathExists(segments)
          ? new AppError('METHOD_NOT_ALLOWED', `${method} is not supported for this resource.`, 405)
          : new AppError('ROUTE_NOT_FOUND', 'The requested endpoint does not exist.', 404);
      }
      const body = await bodyOf(request, method);
      return (found.entry.handler as Handler)({
        request,
        actor,
        user,
        workspaceId,
        params: found.params,
        query: request.nextUrl.searchParams,
        body,
        idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
        ifMatch: ifMatchOf(request),
      });
    });
  };
  return { GET: handle('GET'), POST: handle('POST'), PUT: handle('PUT'), PATCH: handle('PATCH'), DELETE: handle('DELETE') };
}
