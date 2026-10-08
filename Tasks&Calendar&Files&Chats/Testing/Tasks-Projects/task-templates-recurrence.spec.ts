import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

async function setup() {
  const ctx = await collabApp();
  const svc = ctx.collab.tasks.templates;
  const template = svc.create(ctx.owner, b({ name: 'Recurring', titleTemplate: 'Work {{date}}', checklists: [{ name: 'Steps', items: [{ title: 'Root', children: [{ title: 'Child' }] }] }] }));
  const rule = svc.setRecurrence(ctx.owner, template.id, b({ frequency: 'DAILY', startDate: '2030-01-01', creationLocalTime: '09:00', timezone: 'UTC', maxOccurrences: 2 }), true);
  return { ...ctx, svc, template, rule, get state() { return ctx.state; } };
}
describe('Task Templates & Recurrence contract', () => {
  it('deduplicates scheduler deliveries and creates independent task/checklist rows', async () => {
    const ctx = await setup();
    const { svc, rule, template, owner, collab } = ctx;
    const first = svc.runDue(new Date('2030-01-01T09:00:00Z'));
    expect(first.results[0].outcome).toBe('CREATED');
    expect(svc.runDue(new Date('2030-01-01T09:00:00Z')).processed).toBe(0);
    const live = ctx.state.taskRecurrenceRules.find((row) => row.id === rule.id)!;
    live.nextRunAt = new Date('2030-01-01T09:00:00Z');
    expect(svc.runDue(new Date('2030-01-01T09:00:00Z')).results[0].outcome).toBe('DUPLICATE');
    svc.runDue(new Date('2030-01-02T09:00:00Z'));
    expect(ctx.state.tasks.filter((row) => row.templateId === template.id)).toHaveLength(2);
    expect(ctx.state.taskRecurrenceInstances).toHaveLength(2);
    expect(live).toMatchObject({ nextRunAt: null, occurrenceCount: 2 });
    const [a, other] = ctx.state.tasks;
    const [checklist] = collab.tasks.checklists.list(owner, a.id);
    expect(checklist.items.map((row) => row.title)).toEqual(['Root', 'Child']);
    collab.tasks.checklists.setCompleted(owner, checklist.items[0].id, true, b());
    expect(collab.tasks.checklists.list(owner, other.id)[0].completedCount).toBe(0);
    expect(ctx.state.outboxEvents.filter((row) => row.eventType === 'TASK_RECURRING_INSTANCE_CREATED')).toHaveLength(2);
  });
  it('preserves wall-clock times across DST and clamps monthly/leap-year dates', async () => {
    const { svc, rule } = await setup();
    expect(svc.occurrences({ ...rule, startDate: '2030-03-30', timezone: 'Europe/Berlin', maxOccurrences: 3 }, new Date(0), 3).map((d) => d.toISOString())).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z']);
    expect(svc.occurrences({ ...rule, frequency: 'MONTHLY', startDate: '2030-01-31', maxOccurrences: 3 }, new Date(0), 3).map((d) => d.toISOString().slice(0, 10))).toEqual(['2030-01-31', '2030-02-28', '2030-03-31']);
    expect(svc.occurrences({ ...rule, frequency: 'YEARLY', startDate: '2028-02-29', maxOccurrences: 2 }, new Date(0), 2).map((d) => d.toISOString().slice(0, 10))).toEqual(['2028-02-29', '2029-02-28']);
  });
  it('edits templates without rewriting existing instances and replays instantiate keys', async () => {
    const { svc, template, owner, state } = await setup();
    const first = svc.instantiate(owner, template.id, b(), 'same');
    expect(svc.instantiate(owner, template.id, b(), 'same').id).toBe(first.id);
    svc.update(owner, template.id, b({ titleTemplate: 'Changed', version: 1 }), false);
    const second = svc.instantiate(owner, template.id, b());
    expect(first.title).not.toBe(second.title);
    expect(second.title).toBe('Changed');
    expect(state.tasks.find((row) => row.id === first.id)?.title).toBe(first.title);
  });
  it('rolls back a partial subtask failure and retries the same scheduled occurrence', async () => {
    const ctx = await setup();
    const { svc, owner, template, memberActor } = ctx;
    const member = await memberActor('child-responsible', perms('OWN', 'task.read'));
    const child = svc.create(owner, b({ name: 'Child', titleTemplate: 'Child', defaultResponsibleUserId: member.user.id }));
    svc.update(owner, template.id, b({ subtaskTemplateIds: [child.id], version: 1 }), false);
    ctx.state.users.find((row) => row.id === member.user.id)!.status = 'SUSPENDED';
    const now = new Date('2030-01-01T09:00:00Z');
    expect(svc.runDue(now).results[0].outcome).toBe('FAILED');
    expect(ctx.state.tasks).toHaveLength(0);
    expect(ctx.state.taskChecklists).toHaveLength(0);
    expect(ctx.state.outboxEvents.filter((row) => row.eventType === 'TASK_CREATED')).toHaveLength(0);
    const failed = ctx.state.taskRecurrenceInstances[0];
    expect(failed).toMatchObject({ status: 'FAILED', taskId: null, attempts: 1 });
    expect(svc.runDue(new Date(now.getTime() + 60_000)).results[0].outcome).toBe('RETRY_DEFERRED');
    ctx.state.users.find((row) => row.id === member.user.id)!.status = 'ACTIVE';
    expect(svc.runDue(new Date(now.getTime() + 16 * 60_000)).results[0].outcome).toBe('CREATED');
    expect(ctx.state.taskRecurrenceInstances).toHaveLength(1);
    expect(failed).toMatchObject({ status: 'CREATED', attempts: 2 });
    expect(ctx.state.tasks).toHaveLength(2);
  });
  it('rejects impossible calendar dates and invalid recurrence combinations', async () => {
    const { svc, template, owner } = await setup();
    for (const changes of [{ startDate: '2030-02-30' }, { endDate: '2030-02-30' }, { frequency: 'WEEKLY', daysOfWeek: [] }, { timezone: 'bad' }, { intervalValue: 0 }]) {
      await expectAppError(() => svc.setRecurrence(owner, template.id, b({ frequency: 'DAILY', startDate: '2030-01-01', timezone: 'UTC', ...changes }), true), 'RECURRENCE_INVALID_RULE', 400);
    }
  });
  it('enforces author management, personal visibility and tenant isolation', async () => {
    const { svc, template, owner, memberActor, foreignActor } = await setup();
    const reader = await memberActor('reader', perms('OWN', 'task_template.read', 'task_template.update'));
    expect(svc.get(reader, template.id).id).toBe(template.id);
    await expectAppError(() => svc.update(reader, template.id, b({ name: 'No', version: 1 }), false), 'PERMISSION_DENIED', 403);
    const personal = svc.create(owner, b({ name: 'Personal', titleTemplate: 'Private', scopeType: 'PERSONAL' }));
    await expectAppError(() => svc.get(reader, personal.id), 'TASK_TEMPLATE_NOT_FOUND', 404);
    const foreign = await foreignActor();
    await expectAppError(() => svc.get(foreign, template.id), 'TASK_TEMPLATE_NOT_FOUND', 404);
    await expectAppError(() => svc.instantiate(foreign, template.id, b()), 'TASK_TEMPLATE_NOT_FOUND', 404);
  });
});
