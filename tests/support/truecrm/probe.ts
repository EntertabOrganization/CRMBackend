import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isAppError } from '../../../src/server/errors';
import type { Seeded } from './fixtures';
import { observe, send, type Actor, type Req, type Res } from './world';

export type Evidence = { executedRealApp: boolean; requestCount: number; dbAssertionCount: number; verifiedAssertions: Array<{ claim: string; passed: boolean; evidence?: unknown }>; failures: string[] };
type Outcome<T> = { ok: true; value: T; code?: undefined; status?: undefined } | { ok: false; value?: undefined; code: string; status: number; error: unknown };

/**
 * Records real application interactions (HTTP route dispatch or in-process owning-service commands) and
 * persisted-state assertions for one contract case. Nothing here fabricates a pass: every claim is computed
 * from a response or a database read.
 */
export class Probe {
  requests = 0; dbAssertions = 0; readonly assertions: Evidence['verifiedAssertions'] = []; readonly failures: string[] = [];
  constructor(readonly s: Seeded) {}
  get w() { return this.s.world; }
  get f() { return this.s.fixture; }
  get db(): PrismaClient { return this.s.world.db; }
  get ids() { return this.s.fixture.ids; }
  get x() { return this.s.extra; }
  key(prefix = 'k') { return prefix + '-' + randomUUID(); }

  /** Real HTTP dispatch through the module's route handler (auth, rate limits, envelopes). */
  async req(actor: Actor, method: Req['method'], path: string, body?: unknown, headers?: Record<string, string>): Promise<Res> {
    this.requests++;
    return send(this.w, this.f, { actor, method, path, body, headers });
  }
  /** Real in-process owning-service command (used where a deterministic provider fake must be injected). */
  async call<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    this.requests++;
    try { return { ok: true, value: await fn() }; }
    catch (error) {
      if (isAppError(error)) return { ok: false, code: error.code, status: error.status, error };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: /P2002/.test(message) ? 'UNIQUE_VIOLATION' : 'UNEXPECTED', status: 500, error: message };
    }
  }
  async q<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> { this.dbAssertions++; return fn(this.db); }
  async obs(collection: string, where: Record<string, unknown> = {}) { this.dbAssertions++; return observe(this.w, this.f, collection, where); }
  check(claim: string, passed: boolean, evidence?: unknown) { this.assertions.push({ claim, passed: Boolean(passed), evidence }); return Boolean(passed); }
  status(claim: string, res: Res, allowed: number[]) { return this.check(claim, allowed.includes(res.status), { status: res.status, error: res.body.error, requestId: res.body.requestId }); }
  code(claim: string, res: Res | Outcome<unknown>, codes: string[]) {
    const code = 'body' in res ? res.body.error?.code : res.code;
    return this.check(claim, Boolean(code && codes.includes(code)), { code, status: res.status });
  }
  ok(claim: string, res: Res) { return this.status(claim, res, [200, 201, 202]); }
  /** Workspace-wide audit/outbox counters for "no side effect" checks. */
  async sideEffects() {
    const ws = this.f.workspaceId;
    return this.q(async db => ({ audit: await db.auditLog.count({ where: { workspaceId: ws } }), outbox: await db.outboxEvent.count({ where: { workspaceId: ws } }) }));
  }
  evidence(): Evidence { return { executedRealApp: this.requests > 0, requestCount: this.requests, dbAssertionCount: this.dbAssertions, verifiedAssertions: this.assertions, failures: this.failures }; }
}

/** Per-module generic scenario descriptor used by the S01–S04 cases of every spec file. */
export type Generic = {
  scenario: string;
  foreign(p: Probe): Promise<{ actor: Actor; path: string }>;
  mutation(p: Probe): Promise<{ actor: Actor; deniedActor: Actor; req: Omit<Req, 'actor'>; count(): Promise<number>; resourceId(res: Res): string }>;
  idempotent(p: Probe): Promise<{ actor: Actor; req: Omit<Req, 'actor'>; count(): Promise<number>; id(res: Res): unknown }>;
};

const SECRET_KEYS = /"(password|passwordHash|credentialSecretRef|webhookSecretRef|apiKey|secret|tokenHash|privateSealed|reasonSealed)"\s*:/i;
export const genericCases: Record<string, (p: Probe, g: Generic) => Promise<void>> = {
  async S01(p, g) {
    const target = await g.foreign(p), res = await p.req(target.actor, 'GET', target.path);
    p.status('foreign workspace resource is concealed (403/404)', res, [403, 404]);
    p.check('error envelope carries no resource data', res.body.success === false && res.body.data === undefined, res.body);
    const foreignId = target.path.split('/').filter(Boolean).pop()!;
    p.check('response does not echo foreign record fields', !JSON.stringify(res.body.error ?? {}).includes('"workspaceId"'), { foreignId });
  },
  async S02(p, g) {
    const m = await g.mutation(p), before = await m.count(), effects = await p.sideEffects();
    const res = await p.req(m.deniedActor, m.req.method, m.req.path, m.req.body, m.req.headers);
    p.status('actor without the required permission is denied', res, [401, 403, 404]);
    const after = await m.count(), effectsAfter = await p.sideEffects();
    p.check('domain state unchanged after denial', after === before, { before, after });
    p.check('audit and outbox unchanged after denial', effects.audit === effectsAfter.audit && effects.outbox === effectsAfter.outbox, { effects, effectsAfter });
  },
  async S03(p, g) {
    const m = await g.idempotent(p), key = p.key('same-key');
    const headers = { ...(m.req.headers ?? {}), 'Idempotency-Key': key };
    const first = await p.req(m.actor, m.req.method, m.req.path, m.req.body, headers);
    p.ok('first keyed command succeeds', first);
    const afterFirst = await m.count(), providerFirst = await p.q(db => db.suiteProviderCall.count({ where: { workspaceId: p.f.workspaceId } }));
    const second = await p.req(m.actor, m.req.method, m.req.path, m.req.body, headers);
    p.ok('same-key retry is accepted as a replay', second);
    const afterSecond = await m.count(), providerSecond = await p.q(db => db.suiteProviderCall.count({ where: { workspaceId: p.f.workspaceId } }));
    p.check('retry returns the original resource', JSON.stringify(m.id(first)) === JSON.stringify(m.id(second)) && m.id(first) !== undefined, { first: m.id(first), second: m.id(second) });
    p.check('retry creates no duplicate business effect', afterFirst === afterSecond, { afterFirst, afterSecond });
    p.check('retry creates no duplicate provider effect', providerFirst === providerSecond, { providerFirst, providerSecond });
  },
  async S04(p, g) {
    const m = await g.mutation(p), before = await m.count();
    const res = await p.req(m.actor, m.req.method, m.req.path, m.req.body, m.req.headers);
    if (!p.ok('authorized mutation succeeds', res)) return;
    const id = m.resourceId(res), after = await m.count();
    p.check('domain state committed', after === before + 1, { before, after });
    const audit = await p.obs('audit_events', { resourceId: id }), outbox = await p.obs('outbox_events', { resourceId: id });
    p.check('audit record committed with the mutation', audit.length > 0, audit.map(a => a.action));
    p.check('outbox event committed with the mutation', outbox.length > 0, outbox.map(o => o.eventType));
    p.check('audit payload is redacted (no secrets/sealed fields)', audit.every(a => !SECRET_KEYS.test(JSON.stringify(a))), audit.length);
  },
};
