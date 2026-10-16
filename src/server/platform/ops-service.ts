import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { enqueueJob, registerJob, registerSchedule } from './events-service';
import { assertVersion, audit, emitEvent, notFound, pageQuery, paged, requirePlatform, requireStepUp, type DbClient, type PlatformPrincipal } from './kernel';

const SECRET_KEY = /(secret|token|password|authorization|cookie|api[-_]?key|private|prompt|credential|signature)/i;
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/-]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+)/g;
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]').slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  return value;
}
/** Structured JSON log line with correlation; secrets, tokens, provider payloads and AI prompts are redacted (AC03). */
export function logEvent(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, message, at: new Date().toISOString(), ...(redact(fields) as object) });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  return line;
}
export const redactForLog = redact;

/** Provider readiness reports configuration only, never values. Missing optional providers degrade, they do not kill liveness. */
const PROVIDERS: Record<string, string[]> = {
  notificationsEmail: ['NOTIFICATION_EMAIL_PROVIDER'], notificationsPush: ['NOTIFICATION_PUSH_PROVIDER'], billingPayments: ['BILLING_PAYMENT_PROVIDER'],
  aiGateway: ['AI_GATEWAY_URL'], fileProcessor: ['FILE_PROCESSOR_URL'], mfaVerifier: ['PLATFORM_MFA_VERIFIER_SECRET'], restoreRunner: ['RESTORE_TEST_RUNNER_URL'],
};
export function providerHealth() { return Object.fromEntries(Object.entries(PROVIDERS).map(([name, vars]) => [name, vars.every(v => process.env[v]) ? 'CONFIGURED' : 'NOT_CONFIGURED'])); }
const environment = () => process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const METRICS = ['queue_lag', 'outbox_lag_seconds', 'search_lag', 'dead_letters', 'failed_jobs', 'notification_failures'] as const;

export async function collectMetrics(db: DbClient) {
  const now = Date.now();
  const [queueLag, deadLetters, failedJobs, oldestOutbox, oldestGlobal, searchLag, notificationFailures] = await Promise.all([
    db.platformJob.count({ where: { state: { in: ['QUEUED', 'RETRYING'] }, nextRunAt: { lt: new Date(now - 60000) } } }),
    db.platformEventDeadLetter.count({ where: { status: 'OPEN' } }),
    db.platformJob.count({ where: { state: { in: ['FAILED', 'DEAD_LETTER'] }, updatedAt: { gt: new Date(now - 86400000) } } }),
    db.outboxEvent.findFirst({ where: { publishStatus: { in: ['PENDING', 'RETRYING'] } }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    db.platformGlobalEvent.findFirst({ where: { publishStatus: { in: ['PENDING', 'RETRYING'] } }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    db.searchReindexJob.count({ where: { state: { in: ['QUEUED', 'RUNNING'] } } }),
    db.notificationDelivery.count({ where: { status: 'FAILED', updatedAt: { gt: new Date(now - 3600000) } } }),
  ]);
  const oldest = Math.min(oldestOutbox?.occurredAt.getTime() ?? now, oldestGlobal?.occurredAt.getTime() ?? now);
  return { queue_lag: queueLag, outbox_lag_seconds: Math.round((now - oldest) / 1000), search_lag: searchLag, dead_letters: deadLetters, failed_jobs: failedJobs, notification_failures: notificationFailures } satisfies Record<(typeof METRICS)[number], number>;
}

registerJob({ type: 'platform.ops.snapshot', ownerModule: 'platform', maxAttempts: 2, async run() {
  const { prisma } = await import('../prisma-client');
  const metrics = await collectMetrics(prisma), providers = providerHealth();
  const degraded = metrics.outbox_lag_seconds > 300 || metrics.dead_letters > 0 || metrics.queue_lag > 100;
  await prisma.$transaction(async tx => {
    const snapshot = await tx.serviceHealthSnapshot.create({ data: { component: 'api', environment: environment(), availability: degraded ? 'DEGRADED' : 'AVAILABLE', queueLag: metrics.queue_lag, outboxLag: metrics.outbox_lag_seconds, searchLag: metrics.search_lag, providerHealth: providers } });
    if (degraded) await emitEvent(tx, { workspaceId: null, eventType: 'DEPLOYMENT_HEALTH_DEGRADED', aggregateType: 'ServiceHealthSnapshot', aggregateId: snapshot.id, actorType: 'SERVICE', payload: { ...metrics } });
    for (const rule of await tx.alertRule.findMany({ where: { enabled: true } })) {
      const value = metrics[rule.metric as keyof typeof metrics]; if (value === undefined) continue;
      const open = await tx.platformAlert.findFirst({ where: { ruleId: rule.id, state: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
      if (value > rule.threshold && !open) {
        const alert = await tx.platformAlert.create({ data: { ruleId: rule.id, metric: rule.metric, observedValue: value } });
        await emitEvent(tx, { workspaceId: null, eventType: 'RECOVERY_ALERT_RAISED', aggregateType: 'PlatformAlert', aggregateId: alert.id, aggregateVersion: 1, actorType: 'SERVICE', payload: { metric: rule.metric, observedValue: value, threshold: rule.threshold, escalationTarget: rule.escalationTarget } });
        logEvent('warn', 'platform alert raised', { alertId: alert.id, metric: rule.metric, observedValue: value, threshold: rule.threshold });
      } else if (value <= rule.threshold && open) await tx.platformAlert.update({ where: { id: open.id }, data: { state: 'RESOLVED', resolvedAt: new Date() } });
    }
  });
  return metrics;
} });
registerSchedule({ name: 'platform.ops.snapshot', ownerModule: 'platform', jobType: 'platform.ops.snapshot', intervalMinutes: 5 });

registerJob({ type: 'platform.ops.restoreTest', ownerModule: 'platform', maxAttempts: 3, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const test = await prisma.restoreTest.findUnique({ where: { id: String(ctx.payload.restoreTestId) } });
  if (!test || !['REQUESTED', 'RUNNING'].includes(test.status)) return { skipped: true };
  const url = process.env.RESTORE_TEST_RUNNER_URL;
  if (!url) throw new AppError('DEPENDENCY_UNAVAILABLE', 'RESTORE_TEST_RUNNER_URL is not configured.', 503);
  await prisma.restoreTest.update({ where: { id: test.id }, data: { status: 'RUNNING' } });
  const started = Date.now();
  // The runner restores into the named isolated environment only; it never receives production write credentials.
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.RESTORE_TEST_RUNNER_TOKEN ?? ''), 'idempotency-key': test.id },
    body: JSON.stringify({ restoreTestId: test.id, backupId: test.backupId, targetEnvironment: test.isolatedEnvironment }), signal: AbortSignal.timeout(30 * 60000) });
  if (!response.ok) throw new AppError('PROVIDER_UNAVAILABLE', `Restore runner returned ${response.status}.`, response.status >= 500 ? 502 : 422);
  const body = z.object({ checks: z.array(z.object({ name: z.string().max(120), passed: z.boolean(), detail: z.string().max(500).optional() })).min(1), measuredRtoMinutes: z.number().int().min(0).optional() }).parse(await response.json());
  const passed = body.checks.every(c => c.passed), measured = body.measuredRtoMinutes ?? Math.ceil((Date.now() - started) / 60000);
  await prisma.$transaction(async tx => {
    await tx.restoreTest.update({ where: { id: test.id }, data: { status: passed ? 'PASSED' : 'FAILED', checks: body.checks, measuredRtoMinutes: measured, completedAt: new Date() } });
    await tx.recoveryPlan.updateMany({ where: { environment: String(ctx.payload.planEnvironment ?? '') }, data: { lastRestoreTestAt: new Date(), lastResult: passed ? `PASSED in ${measured} min` : 'FAILED', version: { increment: 1 } } });
    await audit(tx, { workspaceId: null, actorId: null, actorType: 'SERVICE', action: 'RESTORE_TEST_COMPLETED', resourceType: 'RestoreTest', resourceId: test.id, after: { passed, measured } });
    await emitEvent(tx, { workspaceId: null, eventType: 'RESTORE_TEST_COMPLETED', aggregateType: 'RestoreTest', aggregateId: test.id, actorType: 'SERVICE', payload: { passed, measuredRtoMinutes: measured } });
  });
  return { passed };
} });

/** Observability, alerting, recovery plans and isolated restore tests (30-Platform-Services/10). */
export class PlatformOpsService {
  constructor(private readonly db: PrismaClient) {}
  static live() { return { status: 'live', uptimeSeconds: Math.round(process.uptime()) }; }
  /** Readiness: database is essential; optional providers are reported as impact without failing (AC02). */
  static async ready(db: DbClient) {
    await db.$queryRaw`SELECT 1`;
    const metrics = await collectMetrics(db).catch(() => null);
    const providers = providerHealth();
    return { status: 'ready', database: 'available', providers, degraded: Object.values(providers).some(v => v !== 'CONFIGURED') || (metrics?.dead_letters ?? 0) > 0 };
  }
  async metrics(actor: PlatformPrincipal) {
    requirePlatform(actor, 'platform.ops.read');
    const [metrics, recent, openAlerts] = await Promise.all([collectMetrics(this.db), this.db.serviceHealthSnapshot.findMany({ orderBy: { observedAt: 'desc' }, take: 48 }), this.db.platformAlert.count({ where: { state: { in: ['OPEN', 'ACKNOWLEDGED'] } } })]);
    return { environment: environment(), metrics, providers: providerHealth(), openAlerts, history: recent };
  }
  async alertRules(actor: PlatformPrincipal) { requirePlatform(actor, 'platform.ops.read'); return this.db.alertRule.findMany({ orderBy: { metric: 'asc' } }); }
  async upsertAlertRule(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.ops.manage');
    const input = z.strictObject({ metric: z.enum(METRICS), threshold: z.number().int().min(0).max(10000000), escalationTarget: z.string().trim().min(2).max(200), enabled: z.boolean().default(true) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.alertRule.upsert({ where: { metric: input.metric }, create: input, update: { ...input, version: { increment: 1 } } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'ALERT_RULE_CHANGED', resourceType: 'AlertRule', resourceId: row.id, after: input, requestId });
      return row;
    });
  }
  async alerts(actor: PlatformPrincipal, raw: unknown) {
    requirePlatform(actor, 'platform.ops.read');
    const q = pageQuery.extend({ state: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional() }).parse(raw);
    const where = q.state ? { state: q.state } : {};
    const [rows, total] = await Promise.all([this.db.platformAlert.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.platformAlert.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async alertCommand(actor: PlatformPrincipal, id: string, command: 'acknowledge' | 'resolve', requestId: string) {
    requirePlatform(actor, 'platform.ops.manage');
    return this.db.$transaction(async tx => {
      const alert = await tx.platformAlert.findUnique({ where: { id: z.uuid().parse(id) } });
      if (!alert) throw notFound('Alert');
      const allowed: Record<string, string[]> = { OPEN: ['ACKNOWLEDGED', 'RESOLVED'], ACKNOWLEDGED: ['RESOLVED'] };
      const to = command === 'acknowledge' ? 'ACKNOWLEDGED' : 'RESOLVED';
      if (!(allowed[alert.state] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Alert is ${alert.state}.`, 409);
      const updated = await tx.platformAlert.update({ where: { id: alert.id }, data: { state: to, ...(to === 'ACKNOWLEDGED' ? { acknowledgedBy: actor.userId, acknowledgedAt: new Date() } : { resolvedAt: new Date() }) } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'ALERT_' + to, resourceType: 'PlatformAlert', resourceId: alert.id, before: { state: alert.state }, after: { state: to }, requestId });
      return updated;
    });
  }
  async recoveryPlans(actor: PlatformPrincipal) {
    requirePlatform(actor, 'platform.ops.read');
    const plans = await this.db.recoveryPlan.findMany({ orderBy: { environment: 'asc' } });
    const tests = await this.db.restoreTest.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    // RPO/RTO are configured targets; only a measured restore result is evidence (no fabricated guarantee).
    return { plans: plans.map(p => ({ ...p, verified: !!p.lastRestoreTestAt && p.lastResult?.startsWith('PASSED') })), recentRestoreTests: tests };
  }
  async upsertRecoveryPlan(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'platform.ops.manage');
    const input = z.strictObject({ environment: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), backupProfileId: z.string().trim().min(1).max(120), targetRpoMinutes: z.number().int().min(1).max(10080), targetRtoMinutes: z.number().int().min(1).max(10080),
      procedureRef: z.string().trim().min(3).max(500), expectedVersion: z.number().int().min(0).default(0) }).parse(raw);
    return this.db.$transaction(async tx => {
      const existing = await tx.recoveryPlan.findUnique({ where: { environment: input.environment } });
      assertVersion(existing?.version ?? 0, input.expectedVersion);
      const { expectedVersion: _v, ...data } = input;
      const row = existing ? await tx.recoveryPlan.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } }) : await tx.recoveryPlan.create({ data });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'RECOVERY_PLAN_CHANGED', resourceType: 'RecoveryPlan', resourceId: row.id, after: data, requestId });
      return row;
    });
  }
  /** Restricted: step-up MFA; target must be an allow-listed isolated environment and never the running/production one. */
  async requestRestoreTest(actor: PlatformPrincipal, raw: unknown, mfa: string | null, requestId: string) {
    requirePlatform(actor, 'platform.backup.restoreTest'); requireStepUp(actor, mfa);
    const input = z.strictObject({ backupId: z.string().trim().min(1).max(200), isolatedEnvironment: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), planEnvironment: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).optional() }).parse(raw);
    const allowed = (process.env.RESTORE_TEST_ENVIRONMENTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (['production', 'prod', environment()].includes(input.isolatedEnvironment) || !allowed.includes(input.isolatedEnvironment))
      throw new AppError('BUSINESS_RULE_VIOLATION', 'Restore tests run only in an allow-listed isolated environment, never production.', 422);
    if (!process.env.RESTORE_TEST_RUNNER_URL) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Restore test runner is not configured.', 503);
    return this.db.$transaction(async tx => {
      const test = await tx.restoreTest.create({ data: { backupId: input.backupId, isolatedEnvironment: input.isolatedEnvironment, requestedBy: actor.userId } });
      await enqueueJob(tx, { type: 'platform.ops.restoreTest', ownerModule: 'platform', payload: { restoreTestId: test.id, planEnvironment: input.planEnvironment ?? null }, idempotencyKey: 'restore:' + test.id });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'RESTORE_TEST_REQUESTED', resourceType: 'RestoreTest', resourceId: test.id, after: input, requestId });
      return { id: test.id, status: test.status };
    });
  }
}
