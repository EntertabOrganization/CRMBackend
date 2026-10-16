import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isAppError } from '../errors';
import { prisma } from '../prisma-client';
import { readJson, readRawBody } from '../request';
import { checkRateLimit, processRateLimitPolicies } from '../rate-limit';
import { authenticate, type Principal } from '../process-platform/context';
import { authenticateUser, resolvePlatformPrincipal, type PlatformPrincipal, type UserPrincipal } from './kernel';

type Ctx = { body: unknown; rawBody?: string; query: Record<string, string>; params: Record<string, string>; request: NextRequest; requestId: string; key: string | null };
type Entry = { method: string; path: string; status: number; signed?: boolean } & (
  | { kind: 'workspace'; handler: (c: Ctx & { actor: Principal }) => Promise<unknown> }
  | { kind: 'platform'; handler: (c: Ctx & { actor: PlatformPrincipal }) => Promise<unknown> }
  | { kind: 'user'; handler: (c: Ctx & { actor: UserPrincipal }) => Promise<unknown> }
  | { kind: 'public'; handler: (c: Ctx) => Promise<unknown> });

/**
 * Router for the final-pack modules. Context kinds are explicit: a Workspace principal (membership-resolved),
 * a Platform principal (platform.* grants only), a plain authenticated user (Partner portal / self-service)
 * or a public/signed boundary validated by the owning service.
 */
export class SuiteRouter {
  readonly entries: Entry[] = [];
  workspace(method: string, path: string, handler: (c: Ctx & { actor: Principal }) => Promise<unknown>, status = 200) { this.entries.push({ kind: 'workspace', method, path, handler, status }); return this; }
  platform(method: string, path: string, handler: (c: Ctx & { actor: PlatformPrincipal }) => Promise<unknown>, status = 200) { this.entries.push({ kind: 'platform', method, path, handler, status }); return this; }
  user(method: string, path: string, handler: (c: Ctx & { actor: UserPrincipal }) => Promise<unknown>, status = 200) { this.entries.push({ kind: 'user', method, path, handler, status }); return this; }
  public(method: string, path: string, handler: (c: Ctx) => Promise<unknown>, status = 200) { this.entries.push({ kind: 'public', method, path, handler, status }); return this; }
  signed(path: string, handler: (c: Ctx) => Promise<unknown>, status = 202) { this.entries.push({ kind: 'public', method: 'POST', path, handler, status, signed: true }); return this; }

  async dispatch(request: NextRequest) {
    const requestId = request.headers.get('x-request-id') && /^[0-9a-f-]{36}$/i.test(request.headers.get('x-request-id')!) ? request.headers.get('x-request-id')! : randomUUID();
    try {
      const segments = request.nextUrl.pathname.split('/').filter(Boolean);
      const match = this.entries.filter(e => e.method === request.method).map(entry => {
        const pattern = entry.path.split('/').filter(Boolean), params: Record<string, string> = {}; let score = '';
        const matched = pattern.length === segments.length && pattern.every((part, i) => { score += part.startsWith(':') ? '0' : '1'; if (part.startsWith(':')) { params[part.slice(1)] = decodeURIComponent(segments[i]); return true; } return part === segments[i]; });
        return { entry, params, score, matched };
      }).filter(c => c.matched).sort((a, b) => b.score.localeCompare(a.score))[0];
      if (!match) return NextResponse.json({ success: false, error: { code: 'NOT_FOUND', message: 'Resource was not found.', details: null }, requestId }, { status: 404 });
      const { entry } = match;
      const rawBody = entry.signed ? await readRawBody(request, 262144) : undefined;
      const body = entry.signed ? {} : request.method === 'GET' || request.method === 'DELETE' && !request.headers.get('content-length') ? {} : await readJson(request, 262144);
      const ctx: Ctx = { body, rawBody, query: Object.fromEntries(request.nextUrl.searchParams), params: match.params, request, requestId, key: request.headers.get('idempotency-key') };
      let result: unknown;
      if (entry.kind === 'public') result = await entry.handler(ctx);
      else if (entry.kind === 'workspace') {
        const actor = await authenticate(prisma, request);
        checkRateLimit(actor.workspaceId + ':' + actor.userId, request.method === 'GET' ? processRateLimitPolicies.read : processRateLimitPolicies.write);
        result = await entry.handler({ ...ctx, actor });
      } else {
        const user = await authenticateUser(request.headers.get('authorization'));
        checkRateLimit('user:' + user.userId, request.method === 'GET' ? processRateLimitPolicies.read : processRateLimitPolicies.write);
        result = entry.kind === 'platform' ? await entry.handler({ ...ctx, actor: await resolvePlatformPrincipal(prisma, user.userId) }) : await entry.handler({ ...ctx, actor: user });
      }
      const listed = result && typeof result === 'object' && 'data' in result && 'meta' in result;
      const envelope = listed ? { success: true, ...(result as object) } : { success: true, data: result ?? null, meta: null };
      return NextResponse.json(JSON.parse(JSON.stringify(envelope, (_k, v) => typeof v === 'bigint' ? v.toString() : v instanceof Prisma.Decimal ? v.toFixed() : v)), { status: entry.status, headers: { 'x-request-id': requestId } });
    } catch (error) {
      let status = 500, code = 'INTERNAL_ERROR', message = 'Request could not be completed.', details: unknown = null;
      const headers: Record<string, string> = { 'x-request-id': requestId };
      if (isAppError(error)) { ({ status, code, message, details } = error); if (code === 'RESOURCE_VERSION_CONFLICT') code = 'VERSION_CONFLICT'; if (status === 429) headers['retry-after'] = '60'; }
      else if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) { status = 409; code = 'VERSION_CONFLICT'; message = 'Concurrent modification; reload and retry.'; }
      else if (error instanceof Prisma.PrismaClientInitializationError) { status = 503; code = 'DEPENDENCY_UNAVAILABLE'; message = 'The database is temporarily unavailable.'; }
      return NextResponse.json({ success: false, error: { code, message, details }, requestId }, { status, headers });
    }
  }
}
export const nextHandlers = (router: SuiteRouter) => {
  const handle = (request: NextRequest) => router.dispatch(request);
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
};
