import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { audit, emitEvent, notFound, pageQuery, paged, requirePlatform, securityEvent, sha256, type PlatformPrincipal, type Tx } from './kernel';

/** Stable envelope (Shared-Contracts/04). Consumers receive references and safe context only. */
export type EventEnvelope = { eventId: string; eventType: string; eventVersion: number; workspaceId: string | null; aggregateType: string; aggregateId: string; aggregateVersion: number | null;
  occurredAt: string; correlationId: string | null; causationId: string | null; actorType: string; actorId: string | null; payload: Record<string, unknown>; source: 'WORKSPACE' | 'GLOBAL' };
export type Consumer = { id: string; handlerVersion: number; eventTypes: string[] | '*'; maxAttempts?: number; handle(tx: Tx, event: EventEnvelope): Promise<unknown> };
const consumers = new Map<string, Consumer>();
/** Owning modules register consumers at import time. A consumer must re-read live owner state and tenant scope. */
export function registerConsumer(consumer: Consumer) { consumers.set(consumer.id, consumer); }
export function registeredConsumers() { return [...consumers.values()]; }

const MAX_EVENT_ATTEMPTS = 8;
const backoff = (attempt: number) => Math.min(3600000, 15000 * 2 ** attempt) + Math.floor(Math.random() * 3000);

/** Transactional outbox dispatcher + admin API (30-Platform-Services/01). */
export class PlatformEventService {
  constructor(private readonly db: PrismaClient) {}

  private async claim(table: 'outbox_events' | 'platform_global_events', token: string, limit: number) {
    // SKIP LOCKED: two dispatchers never own the same committed batch.
    const ids = await this.db.$queryRawUnsafe<{ id: string }[]>(`UPDATE "${table}" SET publish_lease_token = $1, publish_lease_until = now() + interval '90 seconds'
      WHERE id IN (SELECT id FROM "${table}" WHERE publish_status IN ('PENDING','RETRYING') AND (publish_lease_until IS NULL OR publish_lease_until < now())
        ORDER BY occurred_at, id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING id`, token, limit);
    return ids.map(r => r.id);
  }
  private async envelope(id: string, source: 'WORKSPACE' | 'GLOBAL'): Promise<EventEnvelope | null> {
    if (source === 'WORKSPACE') {
      const e = await this.db.outboxEvent.findUnique({ where: { id } });
      return e && { eventId: e.id, eventType: e.eventType, eventVersion: e.eventVersion, workspaceId: e.workspaceId, aggregateType: e.entityType, aggregateId: e.entityId, aggregateVersion: e.aggregateVersion,
        occurredAt: e.occurredAt.toISOString(), correlationId: e.correlationId, causationId: e.causationId, actorType: e.actorUserId ? 'USER' : 'SERVICE', actorId: e.actorUserId, payload: e.payload as Record<string, unknown>, source };
    }
    const e = await this.db.platformGlobalEvent.findUnique({ where: { id } });
    return e && { eventId: e.id, eventType: e.eventType, eventVersion: e.eventVersion, workspaceId: null, aggregateType: e.aggregateType, aggregateId: e.aggregateId, aggregateVersion: e.aggregateVersion,
      occurredAt: e.occurredAt.toISOString(), correlationId: e.correlationId, causationId: e.causationId, actorType: e.actorType, actorId: e.actorId, payload: e.payload as Record<string, unknown>, source };
  }
  /** Delivers one event to every matching consumer exactly once in effect: receipt + effect commit together. */
  async deliver(event: EventEnvelope) {
    let pending = 0, dead = 0;
    for (const consumer of consumers.values()) {
      if (consumer.eventTypes !== '*' && !consumer.eventTypes.includes(event.eventType)) continue;
      if (await this.db.platformEventReceipt.findUnique({ where: { consumerId_eventId: { consumerId: consumer.id, eventId: event.eventId } } })) continue;
      const letter = await this.db.platformEventDeadLetter.findUnique({ where: { consumerId_eventId: { consumerId: consumer.id, eventId: event.eventId } } });
      if (letter && letter.status === 'OPEN') { dead++; continue; }
      if (letter && letter.status === 'RETRYING' && letter.nextRetryAt && letter.nextRetryAt > new Date()) { pending++; continue; }
      try {
        await this.db.$transaction(async tx => {
          // Receipt first: a concurrent publisher hits the unique (consumer,event) and rolls back its duplicate effect.
          await tx.platformEventReceipt.create({ data: { consumerId: consumer.id, eventId: event.eventId, workspaceId: event.workspaceId, handlerVersion: consumer.handlerVersion } });
          const result = await consumer.handle(tx, event);
          if (result !== undefined) await tx.platformEventReceipt.update({ where: { consumerId_eventId: { consumerId: consumer.id, eventId: event.eventId } }, data: { resultHash: sha256(JSON.stringify(result ?? null)) } });
          if (letter) await tx.platformEventDeadLetter.update({ where: { id: letter.id }, data: { status: 'RESOLVED' } });
        }, { timeout: 60000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue; // another publisher won
        const attempts = (letter?.attempts ?? 0) + 1, permanent = isAppError(error) && error.status >= 400 && error.status < 500 && ![409, 429].includes(error.status);
        const exhausted = permanent || attempts >= (consumer.maxAttempts ?? MAX_EVENT_ATTEMPTS);
        const code = isAppError(error) ? error.code : 'CONSUMER_ERROR';
        await this.db.platformEventDeadLetter.upsert({ where: { consumerId_eventId: { consumerId: consumer.id, eventId: event.eventId } },
          create: { consumerId: consumer.id, eventId: event.eventId, workspaceId: event.workspaceId, failureCode: code, attempts, status: exhausted ? 'OPEN' : 'RETRYING', nextRetryAt: new Date(Date.now() + backoff(attempts)) },
          update: { failureCode: code, attempts, status: exhausted ? 'OPEN' : 'RETRYING', nextRetryAt: new Date(Date.now() + backoff(attempts)) } });
        if (exhausted) { dead++; await securityEvent(this.db, { workspaceId: event.workspaceId, eventType: 'OUTBOX_DLQ_CREATED', risk: 'MEDIUM', details: { consumerId: consumer.id, eventId: event.eventId, failureCode: code } }); }
        else { pending++; await securityEvent(this.db, { workspaceId: event.workspaceId, eventType: 'OUTBOX_PUBLISH_FAILED', details: { consumerId: consumer.id, eventId: event.eventId, attempts } }); }
      }
    }
    return { pending, dead };
  }
  async tick(limit = 50) {
    const token = randomUUID(); let delivered = 0;
    for (const [table, source] of [['outbox_events', 'WORKSPACE'], ['platform_global_events', 'GLOBAL']] as const) {
      for (const id of await this.claim(table, token, limit)) {
        const event = await this.envelope(id, source); if (!event) continue;
        const { pending, dead } = await this.deliver(event);
        const status = pending ? 'RETRYING' : dead ? 'DEAD_LETTER' : 'PUBLISHED';
        const data = { publishStatus: status, publishAttempts: { increment: 1 }, publishLeaseToken: null, publishLeaseUntil: pending ? new Date(Date.now() + 15000) : null, publishedAt: status === 'PUBLISHED' ? new Date() : null };
        if (source === 'WORKSPACE') await this.db.outboxEvent.updateMany({ where: { id, publishLeaseToken: token }, data });
        else await this.db.platformGlobalEvent.updateMany({ where: { id, publishLeaseToken: token }, data });
        if (status === 'PUBLISHED') delivered++;
      }
    }
    return { delivered };
  }

  // ------------------------------------------------------------------ admin (platform.events.inspect / replay)
  async list(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.events.inspect');
    const q = pageQuery.extend({ status: z.enum(['PENDING', 'RETRYING', 'PUBLISHED', 'DEAD_LETTER']).optional(), eventType: z.string().max(120).optional(), workspaceId: z.uuid().optional() }).parse(raw);
    const where = { ...(q.status ? { publishStatus: q.status } : {}), ...(q.eventType ? { eventType: q.eventType } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) };
    const [rows, total] = await Promise.all([this.db.outboxEvent.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit,
      select: { id: true, workspaceId: true, eventType: true, eventVersion: true, entityType: true, entityId: true, aggregateVersion: true, occurredAt: true, publishStatus: true, publishAttempts: true, publishedAt: true, correlationId: true } }), this.db.outboxEvent.count({ where })]);
    return paged(rows, total, q.page, q.limit); // operational metadata only; payload never returned
  }
  async deliveries(actor: PlatformPrincipal, eventId: string) {
    requirePlatform(actor, 'platform.events.inspect');
    const id = z.uuid().parse(eventId);
    const [receipts, letters] = await Promise.all([this.db.platformEventReceipt.findMany({ where: { eventId: id }, orderBy: { processedAt: 'asc' } }), this.db.platformEventDeadLetter.findMany({ where: { eventId: id } })]);
    return { eventId: id, receipts, deadLetters: letters };
  }
  /** Authorized replay of a dead-lettered event: same eventId, receipts guarantee prior effects are not repeated. */
  async replay(actor: PlatformPrincipal, eventId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.events.replay');
    const input = z.strictObject({ reason: z.string().trim().min(1).max(500) }).parse(raw), id = z.uuid().parse(eventId);
    return this.db.$transaction(async tx => {
      const event = await tx.outboxEvent.findUnique({ where: { id } }) ?? null, global = event ? null : await tx.platformGlobalEvent.findUnique({ where: { id } });
      if (!event && !global) throw notFound('Event');
      const status = event?.publishStatus ?? global!.publishStatus;
      if (status !== 'DEAD_LETTER') throw new AppError('INVALID_STATE_TRANSITION', `Only DEAD_LETTER events can be replayed (current ${status}).`, 409);
      const reset = { publishStatus: 'PENDING', publishLeaseToken: null, publishLeaseUntil: null };
      if (event) await tx.outboxEvent.update({ where: { id }, data: reset }); else await tx.platformGlobalEvent.update({ where: { id }, data: reset });
      await tx.platformEventDeadLetter.updateMany({ where: { eventId: id, status: 'OPEN' }, data: { status: 'RETRYING', attempts: 0, nextRetryAt: new Date(), replayedAt: new Date(), replayedBy: actor.userId, replayReason: input.reason } });
      await audit(tx, { workspaceId: event?.workspaceId ?? null, actorId: actor.userId, actorType: 'PLATFORM', action: 'OUTBOX_REPLAY_REQUESTED', resourceType: 'OutboxEvent', resourceId: id, after: { reason: input.reason }, requestId });
      return { eventId: id, status: 'PENDING' };
    });
  }
}

// ====================================================================== jobs & schedules (30-Platform-Services/02)
export type JobContext = { jobId: string; attempt: number; workspaceId: string | null; payload: Record<string, unknown>; idempotencyKey: string };
export type JobHandler = { type: string; ownerModule: string; maxAttempts?: number; run(ctx: JobContext): Promise<unknown> };
const jobHandlers = new Map<string, JobHandler>();
export function registerJob(handler: JobHandler) { jobHandlers.set(handler.type, handler); }
export type ScheduleDefinition = { name: string; ownerModule: string; jobType: string; intervalMinutes?: number; dailyLocalTime?: string; timezone?: string };
const scheduleDefinitions = new Map<string, ScheduleDefinition>();
export function registerSchedule(definition: ScheduleDefinition) { scheduleDefinitions.set(definition.name, definition); }

const JOB_SAFETY_CAP = 20;
/** Enqueue is idempotent per (type, idempotencyKey). Payload carries references, never credentials. */
export async function enqueueJob(db: PrismaClient | Tx, input: { type: string; ownerModule: string; workspaceId?: string | null; payload?: Record<string, unknown>; idempotencyKey: string; maxAttempts?: number; runAt?: Date; correlationId?: string }) {
  const maxAttempts = Math.min(Math.max(1, input.maxAttempts ?? jobHandlers.get(input.type)?.maxAttempts ?? 5), JOB_SAFETY_CAP);
  const existing = await db.platformJob.findUnique({ where: { type_idempotencyKey: { type: input.type, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;
  try {
    return await db.platformJob.create({ data: { type: input.type, ownerModule: input.ownerModule, workspaceId: input.workspaceId ?? null, payload: (input.payload ?? {}) as Prisma.InputJsonObject,
      idempotencyKey: input.idempotencyKey, maxAttempts, nextRunAt: input.runAt ?? new Date(), correlationId: input.correlationId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return db.platformJob.findUniqueOrThrow({ where: { type_idempotencyKey: { type: input.type, idempotencyKey: input.idempotencyKey } } });
    throw error;
  }
}

export class PlatformJobService {
  constructor(private readonly db: PrismaClient) {}
  /** Claims due jobs, including RUNNING jobs whose lease expired (worker crash) — handlers are effect-idempotent. */
  async tick(limit = 20) {
    const token = randomUUID();
    const ids = (await this.db.$queryRaw<{ id: string }[]>`UPDATE platform_jobs SET state = 'RUNNING', lease_token = ${token}, lease_until = now() + interval '5 minutes', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM platform_jobs WHERE (state IN ('QUEUED','RETRYING') AND next_run_at <= now()) OR (state = 'RUNNING' AND lease_until < now())
        ORDER BY next_run_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING id`).map(r => r.id);
    let succeeded = 0;
    for (const id of ids) {
      const job = await this.db.platformJob.findUniqueOrThrow({ where: { id } });
      const attempt = await this.db.platformJobAttempt.upsert({ where: { jobId_attemptNumber: { jobId: id, attemptNumber: job.attempts } }, create: { jobId: id, attemptNumber: job.attempts }, update: { startedAt: new Date() } });
      const handler = jobHandlers.get(job.type);
      let outcome: { state: string; errorCode?: string; result?: unknown };
      if (!handler) outcome = { state: 'FAILED', errorCode: 'JOB_HANDLER_NOT_REGISTERED' };
      else try { outcome = { state: 'SUCCEEDED', result: await handler.run({ jobId: id, attempt: job.attempts, workspaceId: job.workspaceId, payload: job.payload as Record<string, unknown>, idempotencyKey: job.idempotencyKey }) }; }
      catch (error) {
        const code = isAppError(error) ? error.code : 'JOB_TRANSIENT_ERROR';
        const permanent = isAppError(error) && error.status >= 400 && error.status < 500 && ![409, 429].includes(error.status);
        outcome = permanent ? { state: 'FAILED', errorCode: code } : job.attempts >= job.maxAttempts ? { state: 'DEAD_LETTER', errorCode: code } : { state: 'RETRYING', errorCode: code };
      }
      await this.db.$transaction(async tx => {
        const updated = await tx.platformJob.updateMany({ where: { id, leaseToken: token }, data: { state: outcome.state, leaseToken: null, leaseUntil: null, lastErrorCode: outcome.errorCode ?? null,
          result: outcome.result === undefined ? undefined : JSON.parse(JSON.stringify(outcome.result ?? null)), version: { increment: 1 },
          nextRunAt: outcome.state === 'RETRYING' ? new Date(Date.now() + backoff(job.attempts)) : undefined } });
        if (!updated.count) return; // lease lost: a newer claim owns the job
        await tx.platformJobAttempt.update({ where: { id: attempt.id }, data: { completedAt: new Date(), outcome: outcome.state, errorCode: outcome.errorCode ?? null } });
        if (outcome.state === 'DEAD_LETTER') await audit(tx, { workspaceId: job.workspaceId, actorId: null, actorType: 'SERVICE', action: 'JOB_DEAD_LETTERED', resourceType: 'PlatformJob', resourceId: id, after: { type: job.type, errorCode: outcome.errorCode } });
      });
      if (outcome.state === 'SUCCEEDED') succeeded++;
    }
    return { claimed: ids.length, succeeded };
  }
  /** Each schedule occurrence has a deterministic key; repeated ticks/restarts enqueue it once (AC04). */
  async tickSchedules(now = new Date()) {
    let enqueued = 0;
    for (const def of scheduleDefinitions.values()) {
      const row = await this.db.platformSchedule.upsert({ where: { name: def.name }, create: { name: def.name, ownerModule: def.ownerModule, jobType: def.jobType, intervalMinutes: def.intervalMinutes ?? null, dailyLocalTime: def.dailyLocalTime ?? null, timezone: def.timezone ?? 'UTC' }, update: {} });
      if (!row.active) continue;
      let occurrence: string | null = null;
      if (row.intervalMinutes) occurrence = `${row.name}:${Math.floor(now.getTime() / (row.intervalMinutes * 60000))}`;
      else if (row.dailyLocalTime) {
        const { zonedInstant, localDateOf } = await import('../suite/kernel');
        const date = localDateOf(now, row.timezone), due = zonedInstant(date, row.dailyLocalTime, row.timezone);
        if (now >= due) occurrence = `${row.name}:${date}`;
      }
      if (!occurrence || occurrence === row.lastOccurrenceKey) continue;
      await enqueueJob(this.db, { type: row.jobType, ownerModule: row.ownerModule, idempotencyKey: occurrence });
      await this.db.platformSchedule.update({ where: { id: row.id }, data: { lastOccurrenceKey: occurrence, lastEnqueuedAt: now } });
      enqueued++;
    }
    return { enqueued };
  }

  async list(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.jobs.inspect');
    const q = pageQuery.extend({ status: z.enum(['QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED']).optional(), type: z.string().max(120).optional(), workspaceId: z.uuid().optional() }).parse(raw);
    const where = { ...(q.status ? { state: q.status } : {}), ...(q.type ? { type: q.type } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) };
    const [rows, total] = await Promise.all([this.db.platformJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit,
      select: { id: true, workspaceId: true, type: true, ownerModule: true, state: true, attempts: true, maxAttempts: true, nextRunAt: true, lastErrorCode: true, version: true, createdAt: true } }), this.db.platformJob.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async attempts(actor: PlatformPrincipal, jobId: string) {
    requirePlatform(actor, 'platform.jobs.inspect');
    return this.db.platformJobAttempt.findMany({ where: { jobId: z.uuid().parse(jobId) }, orderBy: { attemptNumber: 'asc' } });
  }
  async command(actor: PlatformPrincipal, jobId: string, action: 'retry' | 'cancel', raw: unknown, requestId: string) {
    requirePlatform(actor, action === 'retry' ? 'platform.jobs.retry' : 'platform.jobs.cancel');
    const input = z.strictObject({ reason: z.string().trim().min(1).max(500) }).parse(raw), id = z.uuid().parse(jobId);
    return this.db.$transaction(async tx => {
      const job = await tx.platformJob.findUnique({ where: { id } }); if (!job) throw notFound('Job');
      const allowed = action === 'retry' ? ['DEAD_LETTER', 'FAILED'] : ['QUEUED', 'RETRYING'];
      if (!allowed.includes(job.state)) throw new AppError('INVALID_STATE_TRANSITION', `Cannot ${action} a ${job.state} job.`, 409);
      const updated = await tx.platformJob.update({ where: { id }, data: action === 'retry' ? { state: 'QUEUED', nextRunAt: new Date(), maxAttempts: Math.min(job.attempts + job.maxAttempts, JOB_SAFETY_CAP + job.attempts), version: { increment: 1 } } : { state: 'CANCELLED', version: { increment: 1 } } });
      await audit(tx, { workspaceId: job.workspaceId, actorId: actor.userId, actorType: 'PLATFORM', action: action === 'retry' ? 'JOB_REPLAY_REQUESTED' : 'JOB_CANCELLED', resourceType: 'PlatformJob', resourceId: id, after: { reason: input.reason, from: job.state }, requestId });
      return { id, state: updated.state, version: updated.version };
    });
  }
  async patchSchedule(actor: PlatformPrincipal, scheduleId: string, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.jobs.retry');
    const input = z.strictObject({ active: z.boolean(), expectedVersion: z.number().int().positive() }).parse(raw), id = z.uuid().parse(scheduleId);
    return this.db.$transaction(async tx => {
      const row = await tx.platformSchedule.findUnique({ where: { id } }); if (!row) throw notFound('Schedule');
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Schedule changed; reload.', 409);
      const updated = await tx.platformSchedule.update({ where: { id }, data: { active: input.active, version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'SCHEDULE_CHANGED', resourceType: 'PlatformSchedule', resourceId: id, before: { active: row.active }, after: { active: input.active }, requestId });
      return updated;
    });
  }
  async schedules(actor: PlatformPrincipal) { requirePlatform(actor, 'platform.jobs.inspect'); return this.db.platformSchedule.findMany({ orderBy: { name: 'asc' } }); }
  /** Domain-facing enqueue that also records a JOB_QUEUED event in the caller's transaction. */
  static async enqueueInTx(tx: Tx, input: Parameters<typeof enqueueJob>[1]) {
    const job = await enqueueJob(tx, input);
    if (input.workspaceId) await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'JOB_QUEUED', aggregateType: 'PlatformJob', aggregateId: job.id, actorType: 'SERVICE', payload: { type: job.type } });
    return job;
  }
}
