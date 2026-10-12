import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isAppError } from '../errors';
import { prisma } from '../prisma-client';
import { readJson } from '../request';
import { checkRateLimit,processRateLimitPolicies } from '../rate-limit';
import { authenticate, type Principal } from './context';

export type PackHandler = (context: { actor: Principal; body: unknown; query: Record<string, string>;
  params: Record<string, string>; request: NextRequest }) => Promise<unknown>;
export type ScopedPublicHandler = (context: { body: unknown; query: Record<string,string>; params: Record<string,string>; request: NextRequest }) => Promise<unknown>;
type Entry = { method: string; path: string; controller: string; status: number } &
  ({ public: false; handler: PackHandler } | { public: true; handler: ScopedPublicHandler });

/** Only implemented vertical slices are registered. Unimplemented inventory entries do not become fake routes. */
export class PackRouter {
  readonly entries: Entry[] = [];
  add(method: string, path: string, controller: string, handler: PackHandler, status = 200) {
    this.entries.push({ method, path, controller, handler, status, public: false });
    return this;
  }
  /** Explicit public boundary: the owning service must validate its scoped credential/callback proof. */
  addPublic(method: string, path: string, controller: string, handler: ScopedPublicHandler, status = 200) {
    this.entries.push({ method,path,controller,handler,status,public: true });
    return this;
  }
  async dispatch(request: NextRequest) {
    const requestId = randomUUID();
    try {
      const segments = request.nextUrl.pathname.split('/').filter(Boolean);
      const matches = this.entries.filter(entry => entry.method === request.method).map(entry => {
        const pattern = entry.path.split('/').filter(Boolean);
        const params: Record<string, string> = {};
        let score = '';
        const matched = pattern.length === segments.length && pattern.every((part, index) => {
          score += part.startsWith(':') ? '0' : '1';
          if (part.startsWith(':')) { params[part.slice(1)] = segments[index]; return true; }
          return part === segments[index];
        });
        return { entry, params, score, matched };
      }).filter(candidate => candidate.matched).sort((a, b) => b.score.localeCompare(a.score));
      const match = matches[0];
      if (!match) return NextResponse.json({ success: false, error: { code: 'RESOURCE_NOT_FOUND',
        message: 'Resource was not found.', details: null }, requestId }, { status: 404 });
      const actor = match.entry.public ? null : await authenticate(prisma,request);
      if (actor) checkRateLimit(actor.workspaceId + ':' + actor.userId,request.method==='GET' ? processRateLimitPolicies.read : processRateLimitPolicies.write);
      const body = request.method === 'GET' ? {} : await readJson(request, 262144);
      const context = { body,query: Object.fromEntries(request.nextUrl.searchParams),params: match.params,request };
      const result = match.entry.public ? await match.entry.handler(context)
        : await match.entry.handler({ ...context,actor: actor! });
      const paged = result && typeof result === 'object' && 'data' in result && 'meta' in result;
      const envelope = paged ? { success: true, ...result } : { success: true,data: result,meta: null };
      return NextResponse.json(JSON.parse(JSON.stringify(envelope,(_key,value) => typeof value==='bigint' ? value.toString() : value)),
        { status: match.entry.status });
    } catch (error) {
      let status = 500, code = 'INTERNAL_ERROR', message = 'Request could not be completed.', details: unknown = null;
      if (isAppError(error)) ({ status, code, message, details } = error);
      else if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        status = 409; code = 'RESOURCE_VERSION_CONFLICT'; message = 'Concurrent modification; reload and retry.';
      } else if (error instanceof Prisma.PrismaClientInitializationError) {
        status = 503; code = 'DATABASE_UNAVAILABLE'; message = 'The database is temporarily unavailable.';
      }
      return NextResponse.json({ success: false, error: { code, message, details },
        requestId }, { status });
    }
  }
}
