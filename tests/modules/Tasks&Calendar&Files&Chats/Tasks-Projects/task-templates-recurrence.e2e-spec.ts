import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);
let owner: Session, reader: Session, outsider: Session, responsible: Session;
const jobToken = randomUUID();
const previousToken = process.env.INTERNAL_JOB_TOKEN;
beforeAll(async () => {
  await prepareCollabDatabase();
  process.env.INTERNAL_JOB_TOKEN = jobToken;
  owner = await register('template-owner');
  reader = await member(owner, 'template-reader', [['task_template.read', 'OWN'], ['task_template.update', 'OWN']]);
  responsible = await member(owner, 'template-responsible', [['task.read', 'OWN']]);
  outsider = await register('template-outsider');
});
afterAll(async () => {
  if (previousToken === undefined) delete process.env.INTERNAL_JOB_TOKEN;
  else process.env.INTERNAL_JOB_TOKEN = previousToken;
  await disconnect();
});
async function template(extra: Record<string, unknown> = {}) {
  return expectOk(await call(owner, 'POST', 'task-templates', { body: { name: 'Reusable', titleTemplate: 'Work {{date}}', ...extra } }));
}
async function rule(id: string, extra: Record<string, unknown> = {}) {
  return expectOk(await call(owner, 'PUT', `task-templates/${id}/recurrence`, { body: { frequency: 'DAILY', startDate: '2030-01-01', creationLocalTime: '09:00', timezone: 'UTC', ...extra } }));
}
async function run() {
  return expectOk(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'task-recurrence-run' }, body: {}, headers: { 'x-internal-job-token': jobToken } }));
}
async function makeDue(id: string, scheduledFor: Date) {
  const prisma = await db();
  const current = await prisma.taskRecurrenceRule.findUniqueOrThrow({ where: { id } });
  await prisma.taskRecurrenceRule.update({ where: { id }, data: { nextRunAt: scheduledFor, version: current.version + 1 } });
}

describe('Task Templates & Recurrence HTTP/PostgreSQL contract', () => {
  it('exposes CRUD and instantiates independent tasks with nested checklists and idempotency', async () => {
    const t = await template({ checklists: [{ name: 'Steps', items: [{ title: 'Root', children: [{ title: 'Nested' }] }] }] });
    expect(expectOk(await call(owner, 'GET', 'task-templates')).some((row: any) => row.id === t.id)).toBe(true);
    expect(expectOk(await call(owner, 'GET', `task-templates/${t.id}`)).checklists[0].items[0].children[0].title).toBe('Nested');
    const first = expectOk(await call(owner, 'POST', `task-templates/${t.id}/instantiate`, { headers: { 'idempotency-key': 'instantiate-once' } }));
    expect(expectOk(await call(owner, 'POST', `task-templates/${t.id}/instantiate`, { headers: { 'idempotency-key': 'instantiate-once' } })).id).toBe(first.id);
    const updated = expectOk(await call(owner, 'PATCH', `task-templates/${t.id}`, { body: { titleTemplate: 'Changed', version: 1 } }));
    expectError(await call(owner, 'PATCH', `task-templates/${t.id}`, { body: { name: 'Stale', version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    const second = expectOk(await call(owner, 'POST', `task-templates/${t.id}/instantiate`));
    expect(second.title).toBe('Changed');
    expect(expectOk(await call(owner, 'GET', `tasks/${first.id}`)).title).toBe(first.title);
    const checklists = expectOk(await call(owner, 'GET', `tasks/${first.id}/checklists`));
    expect(checklists[0].items.map((row: any) => row.title)).toEqual(['Root', 'Nested']);
    expectOk(await call(owner, 'PUT', `task-templates/${t.id}`, { body: { name: 'Replaced', titleTemplate: 'Replacement', version: updated.version } }));
    expect(expectOk(await call(owner, 'GET', `task-templates/${t.id}`)).checklists).toEqual([]);
    expectOk(await call(owner, 'DELETE', `task-templates/${t.id}`));
    expectError(await call(owner, 'GET', `task-templates/${t.id}`), 404, 'TASK_TEMPLATE_NOT_FOUND');
    expect(expectOk(await call(owner, 'GET', `tasks/${first.id}`)).id).toBe(first.id);
  });
  it('enforces authentication, author rights, personal visibility and tenant boundaries', async () => {
    const t = await template();
    expectError(await call(null, 'GET', `task-templates/${t.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(reader, 'POST', 'task-templates', { body: { name: 'No', titleTemplate: 'No' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'PATCH', `task-templates/${t.id}`, { body: { name: 'No', version: 1 } }), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'PUT', `task-templates/${t.id}/recurrence`, { body: { frequency: 'DAILY' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'POST', `task-templates/${t.id}/instantiate`), 403, 'PERMISSION_DENIED');
    const personal = await template({ scopeType: 'PERSONAL' });
    expectError(await call(reader, 'GET', `task-templates/${personal.id}`), 404, 'TASK_TEMPLATE_NOT_FOUND');
    for (const suffix of ['', '/recurrence']) {
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) expectError(await call(outsider, method, `task-templates/${t.id}${suffix}`, { body: method === 'PATCH' ? { version: 1 } : undefined }), 404, 'TASK_TEMPLATE_NOT_FOUND');
    }
    for (const suffix of ['/instantiate', '/recurrence/run-due-preview']) expectError(await call(outsider, 'POST', `task-templates/${t.id}${suffix}`), 404, 'TASK_TEMPLATE_NOT_FOUND');
    expectError(await call(outsider, 'GET', `task-templates/${t.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    expectError(await call(owner, 'POST', 'task-templates', { body: { name: 'Foreign', titleTemplate: 'Foreign', defaultResponsibleUserId: outsider.userId } }), 400, 'TASK_RESPONSIBLE_INVALID');
  });
  it('persists recurrence configuration, previews DST instants without mutation and deletes rules', async () => {
    const t = await template();
    const r = await rule(t.id, { startDate: '2030-03-30', timezone: 'Europe/Berlin', maxOccurrences: 3 });
    expect(expectOk(await call(owner, 'GET', `task-templates/${t.id}/recurrence`)).upcoming).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z']);
    const preview = expectOk(await call(reader, 'POST', `task-templates/${t.id}/recurrence/run-due-preview`, { body: { until: '2030-04-02T00:00:00Z' } }));
    expect(preview.occurrences.map((row: any) => row.scheduledFor)).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z']);
    const prisma = await db();
    expect(await prisma.taskRecurrenceInstance.count({ where: { recurrenceRuleId: r.id } })).toBe(0);
    const patched = expectOk(await call(owner, 'PATCH', `task-templates/${t.id}/recurrence`, { body: { isActive: false, version: 1 } }));
    expect(patched).toMatchObject({ isActive: false, nextRunAt: null, version: 2 });
    expectError(await call(owner, 'PATCH', `task-templates/${t.id}/recurrence`, { body: { isActive: true, version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectOk(await call(owner, 'DELETE', `task-templates/${t.id}/recurrence`));
    expectError(await call(owner, 'GET', `task-templates/${t.id}/recurrence`), 404, 'RECURRENCE_NOT_FOUND');
    expect(await prisma.outboxEvent.count({ where: { entityId: t.id, eventType: 'TASK_RECURRENCE_CHANGED' } })).toBe(3);
    expect((await prisma.auditLog.findMany({ where: { entityId: t.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['TASK_TEMPLATE.CREATED', 'TASK_TEMPLATE.RECURRENCE_CHANGED', 'TASK_TEMPLATE.RECURRENCE_DELETED']));
  });
  it('rejects invalid calendar dates and recurrence inputs without saving configuration', async () => {
    const t = await template();
    for (const extra of [{ startDate: '2030-02-30' }, { endDate: '2030-02-30' }, { frequency: 'WEEKLY', daysOfWeek: [] }, { timezone: 'bad' }, { intervalValue: 0 }]) {
      expectError(await call(owner, 'PUT', `task-templates/${t.id}/recurrence`, { body: { frequency: 'DAILY', startDate: '2030-01-01', timezone: 'UTC', ...extra } }), 400, 'RECURRENCE_INVALID_RULE');
    }
    expectError(await call(owner, 'PATCH', `task-templates/${t.id}`, { body: { titleTemplate: '', version: 1 } }), 400, 'VALIDATION_ERROR');
    expect(await (await db()).taskRecurrenceRule.count({ where: { templateId: t.id } })).toBe(0);
  });
  it('runs the authenticated scheduler exactly once per occurrence', async () => {
    const t = await template(), r = await rule(t.id);
    const scheduled = new Date(Date.now() - 60_000);
    await makeDue(r.id, scheduled);
    expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'task-recurrence-run' }, body: {} }), 401, 'UNAUTHENTICATED');
    expect((await run()).results.find((row: any) => row.ruleId === r.id).outcome).toBe('CREATED');
    expect((await run()).results.some((row: any) => row.ruleId === r.id)).toBe(false);
    await makeDue(r.id, scheduled);
    expect((await run()).results.find((row: any) => row.ruleId === r.id).outcome).toBe('DUPLICATE');
    const prisma = await db();
    const instance = await prisma.taskRecurrenceInstance.findFirstOrThrow({ where: { recurrenceRuleId: r.id } });
    expect(instance).toMatchObject({ status: 'CREATED', attempts: 1 });
    expect(await prisma.task.count({ where: { templateId: t.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { entityId: instance.taskId!, eventType: 'TASK_RECURRING_INSTANCE_CREATED' } })).toBe(1);
    await expect(prisma.taskRecurrenceInstance.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, recurrenceRuleId: r.id, templateId: t.id, scheduledFor: scheduled, status: 'FAILED', attempts: 1, createdAt: new Date(), updatedAt: new Date() } })).rejects.toMatchObject({ code: 'P2002' });
  });
  it('records failed targets and retries the same occurrence after recovery', async () => {
    const t = await template({ defaultResponsibleUserId: responsible.userId }), r = await rule(t.id);
    const prisma = await db();
    await makeDue(r.id, new Date(Date.now() - 60_000));
    await prisma.user.update({ where: { id: responsible.userId }, data: { status: 'SUSPENDED' } });
    expect((await run()).results.find((row: any) => row.ruleId === r.id)).toMatchObject({ outcome: 'FAILED', errorCode: 'RECURRENCE_TARGET_INVALID' });
    expect(await prisma.task.count({ where: { templateId: t.id } })).toBe(0);
    const failed = await prisma.taskRecurrenceInstance.findFirstOrThrow({ where: { recurrenceRuleId: r.id } });
    expect((await run()).results.find((row: any) => row.ruleId === r.id).outcome).toBe('RETRY_DEFERRED');
    await prisma.user.update({ where: { id: responsible.userId }, data: { status: 'ACTIVE' } });
    await prisma.taskRecurrenceInstance.update({ where: { id: failed.id }, data: { updatedAt: new Date(Date.now() - 16 * 60_000) } });
    expect((await run()).results.find((row: any) => row.ruleId === r.id).outcome).toBe('CREATED');
    expect(await prisma.taskRecurrenceInstance.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'CREATED', attempts: 2 });
    expect(await prisma.taskRecurrenceInstance.count({ where: { recurrenceRuleId: r.id } })).toBe(1);
    expect(await prisma.task.count({ where: { templateId: t.id } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { entityId: t.id, eventType: 'TASK_RECURRENCE_FAILED' } })).toBe(1);
  });
});
