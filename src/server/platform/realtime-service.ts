import type { PrismaClient } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { resolvePrincipal, type Principal } from '../process-platform/context';
import { hasResolver, visibleIds } from './access';
import { cacheVersion, securityEvent } from './kernel';

const TOKEN_TTL_SECONDS = 300, MAX_TOPICS = 20, MAX_HINTS_PER_POLL = 100, RESYNC_WINDOW_MS = 7 * 86400000;
const secret = () => process.env.REALTIME_TOKEN_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'local-realtime-development-secret';
const sign = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url');
type Claims = { u: string; w: string; v: number; exp: number };
/** Topic = aggregate type whose live access resolver is registered (e.g. task, crm.contact, site, knowledge.article). */
const TOPIC_TO_AGGREGATES: Record<string, string[]> = { task: ['TASK', 'Task'], 'crm.contact': ['CONTACT', 'CrmContact'], site: ['SITE', 'Site'], 'hr.employee': ['HR_EMPLOYEE'],
  'marketing.campaign': ['MARKETING_CAMPAIGN'], 'knowledge.article': ['KnowledgeArticle'], notification: ['Notification'] };
const presence = new Map<string, Map<string, number>>(); // ephemeral only (never business truth)

/** Realtime hints & presence (30-Platform-Services/04). Business truth is always re-read from REST APIs. */
export class PlatformRealtimeService {
  constructor(private readonly db: PrismaClient) {}
  async token(actor: Principal) {
    const v = await cacheVersion(this.db, 'auth', `${actor.workspaceId}:${actor.userId}`);
    const body = Buffer.from(JSON.stringify({ u: actor.userId, w: actor.workspaceId, v, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS } satisfies Claims)).toString('base64url');
    return { token: body + '.' + sign(body), expiresIn: TOKEN_TTL_SECONDS, topics: Object.keys(TOPIC_TO_AGGREGATES) };
  }
  private verify(token: string): Claims {
    const [body, mac] = token.split('.');
    const expected = body ? sign(body) : '';
    if (!body || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new AppError('UNAUTHENTICATED', 'Realtime token is invalid.', 401);
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
    if (claims.exp * 1000 < Date.now()) throw new AppError('UNAUTHENTICATED', 'Realtime token expired.', 401);
    return claims;
  }
  /** Re-resolves membership and the auth cache version: revocation interrupts streams immediately. */
  async authorize(token: string, rawTopics: string): Promise<{ actor: Principal; topics: string[]; claims: Claims }> {
    const claims = this.verify(token);
    const topics = z.array(z.string().max(60)).max(MAX_TOPICS).parse(rawTopics ? rawTopics.split(',').filter(Boolean) : []);
    for (const t of topics) if (!TOPIC_TO_AGGREGATES[t] || t !== 'notification' && !hasResolver(t)) {
      await securityEvent(this.db, { workspaceId: claims.w, principalId: claims.u, eventType: 'REALTIME_SUBSCRIBE_DENIED', details: { topic: t } });
      throw new AppError('PERMISSION_DENIED', 'Topic is not available.', 403);
    }
    const actor = await resolvePrincipal(this.db, claims.w, claims.u);
    if (await cacheVersion(this.db, 'auth', `${claims.w}:${claims.u}`) !== claims.v) throw new AppError('UNAUTHENTICATED', 'Access changed; request a new realtime token.', 401);
    return { actor, topics, claims };
  }
  /** Returns authorized hints after the cursor. Hints contain references only, never payloads or titles. */
  async poll(actor: Principal, topics: string[], cursor: string | null) {
    const after = cursor ? new Date(Number(cursor)) : new Date(Date.now() - 60000);
    if (Number.isNaN(after.getTime())) throw new AppError('VALIDATION_FAILED', 'Cursor is invalid.', 400);
    if (Date.now() - after.getTime() > RESYNC_WINDOW_MS) return { resyncRequired: true, hints: [], cursor: String(Date.now()) };
    const aggregates = topics.flatMap(t => TOPIC_TO_AGGREGATES[t]);
    const events = await this.db.outboxEvent.findMany({ where: { workspaceId: actor.workspaceId, entityType: { in: aggregates }, occurredAt: { gt: after } }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: MAX_HINTS_PER_POLL + 1,
      select: { id: true, eventType: true, entityType: true, entityId: true, aggregateVersion: true, occurredAt: true, payload: true } });
    const slow = events.length > MAX_HINTS_PER_POLL, page = events.slice(0, MAX_HINTS_PER_POLL), hints = [];
    const visible = await this.db.$transaction(async tx => {
      const out = new Map<string, Set<string>>();
      for (const t of topics) if (t !== 'notification') out.set(t, await visibleIds(tx, actor, t, page.filter(e => TOPIC_TO_AGGREGATES[t].includes(e.entityType)).map(e => e.entityId)));
      return out;
    });
    for (const e of page) {
      const topic = topics.find(t => TOPIC_TO_AGGREGATES[t].includes(e.entityType))!;
      const allowed = topic === 'notification' ? (e.payload as { recipientId?: string }).recipientId === actor.userId : visible.get(topic)?.has(e.entityId);
      if (allowed) hints.push({ eventId: e.id, topic, eventType: e.eventType, resourceId: e.entityId, version: e.aggregateVersion, occurredAt: e.occurredAt });
    }
    const last = page[page.length - 1];
    // Backpressure: a slow subscriber gets a resync instruction instead of an unbounded backlog.
    return { resyncRequired: slow, hints, cursor: String(last ? last.occurredAt.getTime() : after.getTime()) };
  }
  heartbeat(actor: Principal, resource: string) {
    const key = `${actor.workspaceId}:${z.string().max(120).parse(resource)}`, now = Date.now();
    const map = presence.get(key) ?? new Map<string, number>(); map.set(actor.userId, now + 45000); presence.set(key, map);
    return { resource, ttlSeconds: 45 };
  }
  present(actor: Principal, resource: string) {
    const map = presence.get(`${actor.workspaceId}:${resource}`) ?? new Map(), now = Date.now();
    return { resource, userIds: [...map].filter(([, until]) => until > now).map(([u]) => u), note: 'Presence is ephemeral and never a business state.' };
  }
  /** SSE response: polls authorized hints, re-checks access each cycle, ends on revocation or token expiry. */
  stream(token: string, rawTopics: string, cursor: string | null, signal: AbortSignal) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start: async controller => {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        let current = cursor, alive = true;
        signal.addEventListener('abort', () => { alive = false; });
        while (alive) {
          try {
            const { actor, topics, claims } = await this.authorize(token, rawTopics);
            const batch = await this.poll(actor, topics, current); current = batch.cursor;
            for (const h of batch.hints) send('hint', h);
            if (batch.resyncRequired) send('resync', { cursor: current });
            send('cursor', { cursor: current });
            if (claims.exp * 1000 - Date.now() < 5000) { send('expired', {}); break; }
          } catch (error) {
            await securityEvent(this.db, { eventType: 'REALTIME_CONNECTION_REVOKED', details: { code: error instanceof AppError ? error.code : 'ERROR' } }).catch(() => null);
            send('revoked', { code: error instanceof AppError ? error.code : 'ERROR' }); break;
          }
          await new Promise(r => setTimeout(r, 2000));
        }
        controller.close();
      },
    });
  }
}
