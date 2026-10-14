import { PrismaClient, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AutomationDiagnosticRetention } from '../src/server/automation/diagnostic-retention';
import { prepareProcessPlatformDatabase } from './support/process-platform-db';

jest.setTimeout(120000);
let db: PrismaClient, retention: AutomationDiagnosticRetention;
const now = new Date('2026-10-14T10:00:00Z'), old = new Date(now.getTime() - 130 * 86400000);
beforeAll(async () => {
  const url = await prepareProcessPlatformDatabase('truecrm_automation_retention_test');
  db = new PrismaClient({ datasources: { db: { url } } }); retention = new AutomationDiagnosticRetention(db);
}, 300000);
afterAll(async () => { await db?.$disconnect(); await (await import('../src/server/prisma-client')).prisma.$disconnect(); });
async function fixture(settings: Prisma.InputJsonObject = {}) {
  const user = await db.user.create({ data: { email: randomUUID() + '@example.test', firstName: 'Retention', lastName: 'Owner', status: 'ACTIVE' } });
  const workspace = await db.workspace.create({ data: { name: 'Retention', slug: randomUUID(), ownerUserId: user.id, settings } });
  const log = (createdAt = old, refs: { executionId?: string; jobId?: string; ruleId?: string } = {}) => db.automationLog.create({ data: {
    workspaceId: workspace.id, level: 'INFO', code: 'ACTION_COMPLETED', message: 'Safe diagnostic', createdAt, ...refs } });
  return { user, workspace, log, run: (limit = 500) => retention.run({ workspaceId: workspace.id, limit }, now) };
}
async function checkpoint(f: Awaited<ReturnType<typeof fixture>>, status: 'PENDING' | 'SUCCEEDED' = 'SUCCEEDED') {
  const rule = await db.automationRule.create({ data: { workspaceId: f.workspace.id, name: 'Retained Rule', targetType: 'DEAL', createdByUserId: f.user.id } });
  const revision = await db.automationRuleRevision.create({ data: { workspaceId: f.workspace.id, ruleId: rule.id, revisionNumber: 1,
    state: 'PUBLISHED', publishedAt: old, publishedByUserId: f.user.id, createdByUserId: f.user.id, configHash: 'immutable-configuration' } });
  const execution = await db.automationExecution.create({ data: { workspaceId: f.workspace.id, ruleId: rule.id, ruleRevisionId: revision.id,
    ruleName: rule.name, revisionNumber: 1, targetType: 'DEAL', targetId: randomUUID(), sourceEventId: randomUUID(), triggerCode: 'TEST',
    timingMode: 'IMMEDIATE', status, identityKind: 'SYSTEM', correlationId: randomUUID(), startedAt: old, completedAt: status === 'SUCCEEDED' ? old : null } });
  const job = await db.automationJob.create({ data: { workspaceId: f.workspace.id, ruleId: rule.id, ruleRevisionId: revision.id,
    targetType: 'DEAL', targetId: execution.targetId, sourceEventId: execution.sourceEventId, triggerCode: 'TEST', timingMode: 'IMMEDIATE',
    scheduledAt: old, status, idempotencyKey: randomUUID(), correlationId: execution.correlationId, triggerContext: {}, identityKind: 'SYSTEM', executionId: execution.id } });
  return { rule, revision, execution, job };
}
it('prunes old diagnostic logs with transactional totals and retains recent logs', async () => {
  const f = await fixture(), expired = await f.log(), recent = await f.log(now);
  expect(await f.run()).toMatchObject({ retentionDays: 90, deletedLogs: 1, hasMore: false });
  expect(await db.automationLog.findUnique({ where: { id: expired.id } })).toBeNull();
  expect(await db.automationLog.findUnique({ where: { id: recent.id } })).not.toBeNull();
  expect(await db.auditLog.findFirst({ where: { workspaceId: f.workspace.id, action: 'AUTOMATION.DIAGNOSTICS_PRUNED' } }))
    .toMatchObject({ afterData: { deletedLogs: 1, retentionDays: 90 } });
  expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id, eventType: 'AUTOMATION_DIAGNOSTICS_PRUNED' } })).toBe(1);
});
it('uses bounded oldest-first batches and does not duplicate evidence on an empty retry', async () => {
  const f = await fixture(), first = await f.log(new Date(old.getTime() - 1000)); await f.log(); await f.log();
  expect(await f.run(2)).toMatchObject({ deletedLogs: 2, hasMore: true });
  expect(await db.automationLog.findUnique({ where: { id: first.id } })).toBeNull();
  expect(await f.run(2)).toMatchObject({ deletedLogs: 1, hasMore: false });
  expect(await f.run(2)).toMatchObject({ deletedLogs: 0, hasMore: false });
  expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
  expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
});
it('uses current Workspace policy and rejects invalid retention without effects', async () => {
  const f = await fixture({ automationDiagnosticRetentionDays: 30 });
  await f.log(new Date(now.getTime() - 40 * 86400000)); expect((await f.run()).deletedLogs).toBe(1);
  const held = await f.log();
  await db.workspace.update({ where: { id: f.workspace.id }, data: { settings: { automationDiagnosticRetentionDays: 0 } } });
  await expect(f.run()).rejects.toMatchObject({ code: 'AUTOMATION_RETENTION_POLICY_INVALID', status: 409 });
  expect(await db.automationLog.findUnique({ where: { id: held.id } })).not.toBeNull();
});
it.each([null, '90', 1.5, 3651])('rejects a malformed or out-of-range configured retention value (%p)', async value => {
  const f = await fixture({ automationDiagnosticRetentionDays: value }), log = await f.log();
  await expect(f.run()).rejects.toMatchObject({ code: 'AUTOMATION_RETENTION_POLICY_INVALID', status: 409 });
  expect(await db.automationLog.findUnique({ where: { id: log.id } })).not.toBeNull();
  expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});
it('honors legal holds and future shared retention on logs and owning checkpoints', async () => {
  const f = await fixture(), c = await checkpoint(f), direct = await f.log(), heldExecution = await f.log(old, { executionId: c.execution.id });
  const future = await f.log();
  for (const [resourceId, legalHold, expiresAt] of [[direct.id, true, old], [c.execution.id, true, old], [future.id, false, new Date(now.getTime() + 86400000)]] as const) {
    const id = randomUUID();
    await db.commercialPackRecord.create({ data: { id, workspaceId: f.workspace.id, collection: 'retentionRecords',
      data: { id, workspaceId: f.workspace.id, category: 'AUTOMATION', resourceId, legalHold, expiresAt: expiresAt.toISOString(), purgedAt: null } } });
  }
  expect((await f.run()).deletedLogs).toBe(0);
  expect(await db.automationLog.count({ where: { id: { in: [direct.id, heldExecution.id, future.id] } } })).toBe(3);
});
it('preserves active recovery diagnostics, action checkpoints, immutable configuration and existing Audit', async () => {
  const f = await fixture(), active = await checkpoint(f, 'PENDING'), complete = await checkpoint(f);
  const pending = await f.log(old, { executionId: active.execution.id, jobId: active.job.id });
  await f.log(old, { executionId: complete.execution.id, jobId: complete.job.id });
  const action = await db.automationActionExecution.create({ data: { workspaceId: f.workspace.id, executionId: complete.execution.id,
    actionId: randomUUID(), actionCode: 'CRM.UPDATE_FIELD', actionOrder: 1, status: 'SUCCEEDED', attemptCount: 1,
    idempotencyKey: randomUUID(), continueOnError: false, result: { entityId: complete.execution.targetId }, attempts: [{ attempt: 1, outcome: 'SUCCEEDED' }] } });
  const audit = await db.auditLog.create({ data: { workspaceId: f.workspace.id, entityType: 'AUTOMATION_RULE', entityId: complete.rule.id, action: 'AUTOMATION.PUBLISHED' } });
  expect((await f.run()).deletedLogs).toBe(1);
  expect(await db.automationLog.findUnique({ where: { id: pending.id } })).not.toBeNull();
  expect(await db.automationActionExecution.findUnique({ where: { id: action.id } })).toEqual(action);
  expect(await db.automationRuleRevision.findUnique({ where: { id: complete.revision.id } })).toEqual(complete.revision);
  expect(await db.automationExecution.findUnique({ where: { id: complete.execution.id } })).toEqual(complete.execution);
  expect(await db.automationJob.findUnique({ where: { id: complete.job.id } })).toEqual(complete.job);
  expect(await db.auditLog.findUnique({ where: { id: audit.id } })).toEqual(audit);
});
it('rejects malformed scope/input and never prunes another Workspace', async () => {
  const f = await fixture(), foreign = await fixture(), foreignLog = await foreign.log(); await f.log();
  await expect(retention.run({ workspaceId: f.workspace.id, limit: 0 }, now)).rejects.toMatchObject({ status: 400 });
  await expect(retention.run({ workspaceId: 'invalid' }, now)).rejects.toMatchObject({ status: 400 });
  await expect(retention.run({ workspaceId: f.workspace.id, unexpected: true }, now)).rejects.toMatchObject({ status: 400 });
  await expect(retention.run({ workspaceId: randomUUID() }, now)).rejects.toMatchObject({ status: 404 });
  expect((await f.run()).deletedLogs).toBe(1);
  expect(await db.automationLog.findUnique({ where: { id: foreignLog.id } })).not.toBeNull();
});
it('keeps retryable failures and active recovery Job diagnostics until recovery is terminal', async () => {
  const f = await fixture(), retry = await checkpoint(f), recovered = await checkpoint(f);
  await db.automationExecution.update({ where: { id: retry.execution.id }, data: { status: 'FAILED_RETRYABLE' } });
  await db.automationJob.update({ where: { id: recovered.job.id }, data: { status: 'PENDING' } });
  await f.log(old, { executionId: retry.execution.id }); await f.log(old, { executionId: recovered.execution.id });
  expect((await f.run()).deletedLogs).toBe(0);
  await db.automationExecution.update({ where: { id: retry.execution.id }, data: { status: 'FAILED_FINAL' } });
  await db.automationJob.update({ where: { id: recovered.job.id }, data: { status: 'SUCCEEDED' } });
  expect((await f.run()).deletedLogs).toBe(2);
});
it('serializes concurrent batches without duplicate deletions', async () => {
  const f = await fixture(); await f.log(); await f.log();
  const results = await Promise.all([f.run(1), f.run(1)]);
  expect(results.reduce((total, result) => total + result.deletedLogs, 0)).toBe(2);
  expect(await db.automationLog.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
});
it('rolls back deletions and Audit if completion evidence cannot commit', async () => {
  const f = await fixture(), log = await f.log();
  await db.$executeRawUnsafe("CREATE FUNCTION retention_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'AUTOMATION_DIAGNOSTICS_PRUNED' THEN RAISE EXCEPTION 'simulated evidence failure'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER retention_test_fail BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION retention_test_fail()');
  try {
    await expect(f.run()).rejects.toThrow('simulated evidence failure');
    expect(await db.automationLog.findUnique({ where: { id: log.id } })).not.toBeNull();
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER retention_test_fail ON outbox_events'); await db.$executeRawUnsafe('DROP FUNCTION retention_test_fail()');
  }
});
it('requires the scheduler token and strict input on the real maintenance route', async () => {
  const f = await fixture(); await f.log();
  const { prisma } = await import('../src/server/prisma-client');
  expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toBe('truecrm_automation_retention_test');
  const { NextRequest } = await import('next/server'), { POST } = await import('../app/api/v1/internal/crm/jobs/[job]/route');
  const prior = process.env.INTERNAL_JOB_TOKEN, priorFile = process.env.TEST_INTERNAL_JOB_TOKEN_FILE;
  const token = randomUUID(); process.env.INTERNAL_JOB_TOKEN = token; delete process.env.TEST_INTERNAL_JOB_TOKEN_FILE;
  const call = (body: unknown, authorized = false) => POST(new NextRequest('http://test.local/api/v1/internal/crm/jobs/automation-diagnostic-retention',
    { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-internal-job-token': token } : {}) }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ job: 'automation-diagnostic-retention' }) });
  try {
    expect((await call({ workspaceId: f.workspace.id })).status).toBe(401);
    expect((await call({ workspaceId: f.workspace.id, limit: 'all' }, true)).status).toBe(400);
    const result = await call({ workspaceId: f.workspace.id, limit: 1 }, true); expect(result.status).toBe(200);
    expect((await result.json()).data).toMatchObject({ workspaceId: f.workspace.id, deletedLogs: 1 });
  } finally {
    if (prior === undefined) delete process.env.INTERNAL_JOB_TOKEN; else process.env.INTERNAL_JOB_TOKEN = prior;
    if (priorFile === undefined) delete process.env.TEST_INTERNAL_JOB_TOKEN_FILE; else process.env.TEST_INTERNAL_JOB_TOKEN_FILE = priorFile;
  }
});
