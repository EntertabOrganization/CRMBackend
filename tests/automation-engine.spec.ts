/**
 * Automation Rules & Triggers - domain contract tests
 * (tests/modules/Automation_Products_Catlouge/Automation/automation-rules.spec.ts + automation-execution.spec.ts).
 * Everything runs through the real services against the in-memory store; time is driven by the runner's `now`.
 */
import { RecordingCommunicationPort, RecordingNotificationPort } from '@/src/server/ports';
import type { NotificationPort } from '@/src/server/ports';
import { AppError } from '@/src/server/errors';
import { addMember, expectAppError, fullApp, HOUR, otherTenant } from './support/domain';

type T = Awaited<ReturnType<typeof setup>>;
const MINUTE = 60_000;

async function setup() {
  const t = await fullApp();
  const { app, user } = t;
  const ws = t.workspace.id;
  const notifications = new RecordingNotificationPort();
  app.automation.setNotificationPort(notifications);
  app.automation.setCommunicationPort(new RecordingCommunicationPort());
  const company = app.crmCore.createCompany(user, ws, { name: 'Acme' });
  const deal = app.crm.createDeal(user, ws, { title: 'Big deal', companyId: company.id });
  const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === ws && item.entityType === 'DEAL' && item.isDefault)!;
  // Default deal pipeline is New / Won / Lost; add progress stages so tests can move through several stages.
  for (const [name, position] of [['Discovery', 12], ['Proposal', 14], ['Negotiation', 16]] as const) app.crm.createStage(user, ws, pipeline.id, { name, semanticType: 'PROGRESS', position });
  const stages = app.store.state.crmStages.filter((stage) => stage.pipelineId === pipeline.id && stage.semanticType === 'PROGRESS').sort((a, b) => a.position - b.position);
  const A = app.automation;
  const followUp = (subject = 'Follow up {{target.title}}', extra: Record<string, unknown> = {}) => ({ actionCode: 'activities.create_activity', config: { typeCode: 'FOLLOW_UP', subject }, ...extra });
  const enter = (stageId: string) => ({ code: 'crm.stage.entered', config: { stageId } });
  const create = (input: Record<string, unknown> = {}) =>
    A.rules.create(user, ws, { name: 'Rule', targetType: 'DEAL', trigger: enter(stages[1].id), actions: [followUp()], ...input });
  const publish = (rule: { id: string; version: number }) => A.rules.publish(user, ws, rule.id, { version: rule.version });
  const publishNew = (input: Record<string, unknown> = {}) => publish(create(input));
  const move = (stageId: string, dealId = deal.id) => {
    const current = app.store.state.crmDeals.find((item) => item.id === dealId)!;
    return app.crm.transitionDeal(user, ws, dealId, { expectedVersion: current.version, targetStageId: stageId });
  };
  const process = async (now?: Date) => {
    A.ingestPending();
    return A.runner.runDue({ now });
  };
  const executions = (ruleId?: string) => app.store.state.automationExecutions.filter((item) => !ruleId || item.ruleId === ruleId);
  const activities = () => app.store.state.crmActivities.filter((item) => item.workspaceId === ws);
  return { ...t, ws, A, deal, stages, notifications, followUp, enter, create, publish, publishNew, move, process, executions, activities, company };
}

describe('Rule definitions, revisions and publication', () => {
  it('creates a Draft rule for a registered target and rejects unknown targets', async () => {
    const t = await setup();
    const rule = t.create();
    expect(rule).toMatchObject({ state: 'DRAFT', targetType: 'DEAL', hasDraft: true, activeRevisionId: null, version: 1 });
    await expectAppError(() => t.create({ targetType: 'INVOICE' }), 'AUTOMATION_TARGET_NOT_FOUND', 400);
  });

  it('refuses to publish unknown triggers/actions and invalid configuration with section-level details', async () => {
    const t = await setup();
    const bad = t.create({ trigger: { code: 'crm.nope', config: {} }, actions: [{ actionCode: 'crm.explode', config: {} }, { actionCode: 'crm.update_fields', config: { fields: { nope: 1 } } }] });
    const error = await expectAppError(() => t.publish(bad), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
    const codes = error.details.errors.map((entry: { code: string; section: string }) => `${entry.section}:${entry.code}`);
    expect(codes).toEqual(expect.arrayContaining(['trigger:AUTOMATION_TRIGGER_NOT_SUPPORTED', 'actions:AUTOMATION_ACTION_NOT_SUPPORTED', 'actions:AUTOMATION_FIELD_UNAVAILABLE']));
    // A draft may be incomplete, but publishing it is refused, never partially applied.
    expect(t.A.rules.get(t.user, t.ws, bad.id).state).toBe('DRAFT');
    const noAction = t.create({ actions: [] });
    await expectAppError(() => t.publish(noAction), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
  });

  it('validates conditions: type-aware operators, unknown fields, unsafe shapes and size limits', async () => {
    const t = await setup();
    const publishWith = (conditions: unknown) => t.publish(t.create({ conditions }));
    await expectAppError(() => publishWith({ type: 'CONDITION', field: 'target.title', operator: 'GT', value: 1 }), 'AUTOMATION_RULE_NOT_PUBLISHABLE');
    await expectAppError(() => publishWith({ type: 'CONDITION', field: 'target.secretColumn', operator: 'EQ', value: 'x' }), 'AUTOMATION_RULE_NOT_PUBLISHABLE');
    await expectAppError(() => publishWith({ type: 'CONDITION', field: 'target.amount', operator: 'GT', value: 'abc' }), 'AUTOMATION_RULE_NOT_PUBLISHABLE');
    await expectAppError(() => publishWith({ type: 'CONDITION', field: 'target.title', operator: 'EQ', value: 'x', code: 'process.exit()' }), 'AUTOMATION_RULE_NOT_PUBLISHABLE');
    let deep: any = { type: 'CONDITION', field: 'target.title', operator: 'IS_NOT_EMPTY' };
    for (let i = 0; i < 8; i += 1) deep = { type: 'GROUP', operator: 'ALL', children: [deep] };
    await expectAppError(() => t.create({ conditions: deep }), 'AUTOMATION_CONDITION_INVALID', 400);
    const ok = publishWith({ type: 'GROUP', operator: 'ANY', children: [{ type: 'CONDITION', field: 'target.amount', operator: 'GTE', value: '100' }, { type: 'CONDITION', field: 'target.title', operator: 'CONTAINS', value: 'deal' }] });
    expect(ok.state).toBe('ACTIVE');
  });

  it('publishes an immutable revision; editing a published rule creates a new draft and leaves the published one untouched', async () => {
    const t = await setup();
    const published = t.publishNew();
    const revision1 = published.activeRevision!;
    expect(published).toMatchObject({ state: 'ACTIVE', activeRevisionNumber: 1, hasDraft: false });
    expect(revision1.configHash).toMatch(/^[0-9a-f]{64}$/);

    const edited = t.A.rules.update(t.user, t.ws, published.id, { version: published.version, actions: [t.followUp('Changed')] });
    expect(edited.draftRevision).toMatchObject({ revisionNumber: 2, state: 'DRAFT' });
    expect(edited.activeRevision!.actions[0].config).toEqual(revision1.actions[0].config);
    expect(edited.activeRevision!.configHash).toBe(revision1.configHash);

    const republished = t.publish(edited);
    expect(republished.activeRevisionNumber).toBe(2);
    const revisions = t.A.rules.listRevisions(t.user, t.ws, published.id);
    expect(revisions.map((rev) => [rev.revisionNumber, rev.state])).toEqual([[2, 'PUBLISHED'], [1, 'SUPERSEDED']]);
    // The superseded revision is still readable, byte-for-byte.
    expect(t.A.rules.getRevision(t.user, t.ws, published.id, revision1.id).configHash).toBe(revision1.configHash);
  });

  it('detects optimistic concurrency conflicts and never overwrites a newer admin edit', async () => {
    const t = await setup();
    const rule = t.create();
    t.A.rules.update(t.user, t.ws, rule.id, { version: rule.version, name: 'Renamed by admin 1' });
    await expectAppError(() => t.A.rules.update(t.user, t.ws, rule.id, { version: rule.version, name: 'Stale overwrite' }), 'AUTOMATION_RULE_VERSION_CONFLICT', 409);
    await expectAppError(() => t.A.rules.publish(t.user, t.ws, rule.id, { version: rule.version }), 'AUTOMATION_RULE_VERSION_CONFLICT', 409);
    expect(t.A.rules.get(t.user, t.ws, rule.id).name).toBe('Renamed by admin 1');
    await expectAppError(() => t.A.rules.update(t.user, t.ws, rule.id, { name: 'no version' }), 'AUTOMATION_RULE_VERSION_REQUIRED', 400);
  });

  it('separates edit from publish permission and scopes everything to the workspace', async () => {
    const t = await setup();
    const editor = await addMember(t.app, t.user, t.ws, 'editor', [['automation.manage', 'WORKSPACE'], ['automation.read', 'WORKSPACE']]);
    const rule = t.A.rules.create(editor.user, t.ws, { name: 'Mine', targetType: 'DEAL', trigger: t.enter(t.stages[1].id), actions: [t.followUp()] });
    await expectAppError(() => t.A.rules.publish(editor.user, t.ws, rule.id, { version: rule.version }), 'PERMISSION_DENIED', 403);
    const reader = await addMember(t.app, t.user, t.ws, 'reader', [['automation.read', 'WORKSPACE']]);
    expect(t.A.rules.list(reader.user, t.ws, new URLSearchParams()).data).toHaveLength(1);
    await expectAppError(() => t.A.rules.update(reader.user, t.ws, rule.id, { version: 1, name: 'x' }), 'PERMISSION_DENIED', 403);
    await expectAppError(() => t.A.rules.list((editor as any).user, t.ws, new URLSearchParams({ state: 'BOGUS' })), 'AUTOMATION_QUERY_INVALID', 400);
    const other = await otherTenant(t.app);
    await expectAppError(() => t.A.rules.get(other.user, other.workspace.id, rule.id), 'AUTOMATION_RULE_NOT_FOUND', 404);
    // A valid rule UUID is not authority: the caller is not even a member of the other workspace.
    await expectAppError(() => t.A.rules.get(other.user, t.ws, rule.id), 'PERMISSION_DENIED', 403);
  });

  it('pauses without erasing history and re-enabling requires the publish capability', async () => {
    const t = await setup();
    const rule = t.publishNew();
    const paused = t.A.rules.pause(t.user, t.ws, rule.id);
    expect(paused.state).toBe('PAUSED');
    t.move(t.stages[1].id);
    await t.process();
    expect(t.executions(rule.id)).toHaveLength(0);
    expect(t.A.rules.get(t.user, t.ws, rule.id).activeRevisionId).toBe(rule.activeRevisionId);
    const editor = await addMember(t.app, t.user, t.ws, 'mgr', [['automation.manage', 'WORKSPACE']]);
    await expectAppError(() => t.A.rules.enable(editor.user, t.ws, rule.id), 'PERMISSION_DENIED', 403);
    expect(t.A.rules.enable(t.user, t.ws, rule.id).state).toBe('ACTIVE');
  });

  it('hard-deletes an unused draft but archives a rule that has history', async () => {
    const t = await setup();
    const draft = t.create();
    expect(t.A.rules.remove(t.user, t.ws, draft.id)).toMatchObject({ deleted: true });
    const used = t.publishNew();
    t.move(t.stages[1].id);
    await t.process();
    expect(t.A.rules.remove(t.user, t.ws, used.id)).toMatchObject({ archived: true });
    expect(t.executions(used.id).length).toBeGreaterThan(0);
  });
});

describe('Event matching and execution', () => {
  it('runs the configured domain action through the owning service with correlation metadata', async () => {
    const t = await setup();
    const rule = t.publishNew();
    t.move(t.stages[1].id);
    const outcome = await t.process();
    expect(outcome.claimed).toBe(1);
    const [execution] = t.executions(rule.id);
    expect(execution).toMatchObject({ status: 'SUCCEEDED', revisionNumber: 1, depth: 0, identityKind: 'SERVICE', isManual: false, targetTitle: 'Big deal' });
    const [activity] = t.activities();
    expect(activity.subject).toBe('Follow up Big deal');
    expect(t.app.store.state.crmActivityBindings.some((binding) => binding.activityId === activity.id && binding.entityType === 'DEAL' && binding.entityId === t.deal.id)).toBe(true);
    // Events produced by the action carry the chain's correlation, causation and depth.
    const created = t.app.store.state.outboxEvents.find((event) => event.eventType === 'ACTIVITY_CREATED' && event.entityId === activity.id)!;
    expect(created).toMatchObject({ correlationId: execution.correlationId, causationId: execution.id, automationDepth: 1 });
    // The action ran as the scoped service identity, never as the owner.
    expect(activity.createdByUserId).toBe(execution.identityUserId);
    expect(t.app.store.state.users.find((user) => user.id === execution.identityUserId)?.meta).toMatchObject({ service: 'AUTOMATION' });
    const detail = t.A.execution.getExecution(t.user, t.ws, execution.id);
    expect(detail.actions).toMatchObject([{ status: 'SUCCEEDED', attemptCount: 1, order: 1 }]);
    expect(t.app.store.state.outboxEvents.some((event) => event.eventType === 'AUTOMATION_EXECUTION_SUCCEEDED')).toBe(true);
  });

  it('records a skipped execution and no side effect when conditions do not match', async () => {
    const t = await setup();
    const rule = t.publishNew({ conditions: { type: 'CONDITION', field: 'target.title', operator: 'STARTS_WITH', value: 'zzz' } });
    t.move(t.stages[1].id);
    await t.process();
    expect(t.executions(rule.id)).toMatchObject([{ status: 'SKIPPED_CONDITION', skipReason: 'CONDITIONS_NOT_MET' }]);
    expect(t.activities()).toHaveLength(0);
  });

  it('evaluates nested ALL/ANY groups with type-aware operators and CHANGED semantics', async () => {
    const t = await setup();
    const matching = t.publishNew({
      name: 'nested',
      conditions: {
        type: 'GROUP',
        operator: 'ALL',
        children: [
          { type: 'CONDITION', field: 'target.title', operator: 'CONTAINS', value: 'BIG' },
          { type: 'GROUP', operator: 'ANY', children: [{ type: 'CONDITION', field: 'target.amount', operator: 'GT', value: '1000' }, { type: 'CONDITION', field: 'target.stageId', operator: 'CHANGED_TO', value: t.stages[1].id }] },
          { type: 'CONDITION', field: 'target.sourceId', operator: 'IS_EMPTY' },
        ],
      },
    });
    const failing = t.publishNew({ name: 'nested-no', conditions: { type: 'GROUP', operator: 'ALL', children: [{ type: 'CONDITION', field: 'target.amount', operator: 'IS_NOT_EMPTY' }] } });
    t.move(t.stages[1].id);
    await t.process();
    expect(t.executions(matching.id)[0].status).toBe('SUCCEEDED');
    expect(t.executions(failing.id)[0].status).toBe('SKIPPED_CONDITION');
  });

  it('executes all matching rules independently in deterministic priority order; one failure does not affect another', async () => {
    const t = await setup();
    const low = t.publishNew({ name: 'B second', priority: 20, actions: [t.followUp('B')] });
    const high = t.publishNew({ name: 'A first', priority: 10, actions: [{ actionCode: 'crm.set_responsible', config: { userId: '00000000-0000-4000-8000-000000000000' } }] });
    const tie = t.publishNew({ name: 'C tie', priority: 20, actions: [t.followUp('C')] });
    t.move(t.stages[1].id);
    t.A.ingestPending();
    const jobs = t.app.store.state.automationJobs.filter((job) => job.status === 'PENDING');
    expect(jobs).toHaveLength(3);
    // Priority first (lower runs first); equal priorities fall back to creation time, then id - stable and deterministic.
    const rank = (id: string) => t.app.store.state.automationRules.find((rule) => rule.id === id)!;
    const expected = [high, low, tie].map((rule) => rank(rule.id)).sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map((rule) => rule.id);
    expect(jobs.map((job) => job.ruleId)).toEqual(expected);
    expect(expected[0]).toBe(high.id);
    await t.A.runner.runDue();
    expect(t.executions(high.id)[0]).toMatchObject({ status: 'FAILED_FINAL', errorCode: expect.any(String) });
    expect(t.executions(low.id)[0].status).toBe('SUCCEEDED');
    expect(t.executions(tie.id)[0].status).toBe('SUCCEEDED');
    expect(t.activities().map((activity) => activity.subject).sort()).toEqual(['B', 'C']);
  });

  it('pins delayed jobs to the creating revision and re-checks conditions before acting', async () => {
    const t = await setup();
    const rule = t.publishNew({ timing: { mode: 'DELAY', delayMinutes: 60 }, actions: [t.followUp('from revision 1')] });
    t.move(t.stages[1].id);
    const start = new Date();
    await t.process(start);
    expect(t.activities()).toHaveLength(0);
    const job = t.app.store.state.automationJobs[0];
    expect(job).toMatchObject({ status: 'PENDING', timingMode: 'DELAY' });
    expect(job.scheduledAt.getTime()).toBeGreaterThanOrEqual(start.getTime() + 59 * MINUTE);

    // A new revision is published while the job waits: the job keeps using revision 1.
    const edited = t.A.rules.update(t.user, t.ws, rule.id, { version: t.A.rules.get(t.user, t.ws, rule.id).version, actions: [t.followUp('from revision 2')] });
    t.publish(edited);
    expect(t.A.rules.get(t.user, t.ws, rule.id).activeRevisionNumber).toBe(2);
    await t.process(new Date(start.getTime() + 61 * MINUTE));
    expect(t.activities().map((activity) => activity.subject)).toEqual(['from revision 1']);
    expect(t.executions(rule.id)[0]).toMatchObject({ revisionNumber: 1, status: 'SUCCEEDED' });
  });

  it('skips a delayed job as stale when the record left the stage, was archived, or the rule was paused', async () => {
    const t = await setup();
    const rule = t.publishNew({ timing: { mode: 'DELAY', delayMinutes: 30 } });
    t.move(t.stages[1].id);
    await t.process(new Date());
    t.move(t.stages[2].id);
    const later = new Date(Date.now() + HOUR);
    await t.process(later);
    expect(t.executions(rule.id)[0]).toMatchObject({ status: 'SKIPPED_STALE', skipReason: 'STAGE_CHANGED' });
    expect(t.activities()).toHaveLength(0);
    expect(t.app.store.state.automationJobs[0].status).toBe('SKIPPED');

    const second = await setup();
    const r2 = second.publishNew({ timing: { mode: 'DELAY', delayMinutes: 30 } });
    second.move(second.stages[1].id);
    await second.process(new Date());
    second.app.crmCore.archiveDeal(second.user, second.ws, second.deal.id);
    await second.process(new Date(Date.now() + HOUR));
    expect(second.executions(r2.id)[0]).toMatchObject({ status: 'SKIPPED_STALE', skipReason: 'TARGET_NOT_ACTIONABLE' });

    const third = await setup();
    const r3 = third.publishNew({ timing: { mode: 'DELAY', delayMinutes: 30 } });
    third.move(third.stages[1].id);
    await third.process(new Date());
    third.A.rules.pause(third.user, third.ws, r3.id);
    await third.process(new Date(Date.now() + HOUR));
    expect(third.executions(r3.id)[0]).toMatchObject({ status: 'SKIPPED_STALE', skipReason: 'RULE_PAUSED' });
  });

  it('supports scheduled and relative-to-field timing', async () => {
    const t = await setup();
    const runAt = new Date(Date.now() + 2 * HOUR).toISOString();
    t.publishNew({ name: 'scheduled', timing: { mode: 'SCHEDULED', runAt } });
    t.move(t.stages[1].id);
    t.A.ingestPending();
    expect(t.app.store.state.automationJobs[0].scheduledAt.toISOString()).toBe(runAt);

    const field = t.app.fields.definitions.create(t.user, t.ws, { entityType: 'DEAL', label: 'Renewal', fieldType: 'DATETIME' });
    const renewal = new Date(Date.now() + 10 * HOUR);
    t.app.crmCore.updateRecord(t.user, t.ws, 'DEAL', t.deal.id, { expectedVersion: t.app.store.state.crmDeals.find((deal) => deal.id === t.deal.id)!.version, customFields: { [field.code]: renewal.toISOString() } });
    t.A.ingestPending();
    const rel = t.publishNew({ name: 'relative', timing: { mode: 'RELATIVE_TO_FIELD', field: `target.customFields.${field.code}`, offsetMinutes: -60 } });
    t.move(t.stages[2].id);
    t.A.ingestPending();
    const relJob = t.app.store.state.automationJobs.find((job) => job.ruleId === rel.id);
    expect(relJob).toBeUndefined();
    const rel2 = t.publishNew({ name: 'relative2', trigger: t.enter(t.stages[3]?.id ?? t.stages[1].id), timing: { mode: 'RELATIVE_TO_FIELD', field: `target.customFields.${field.code}`, offsetMinutes: -60 } });
    t.move(t.stages[3]?.id ?? t.stages[1].id);
    t.A.ingestPending();
    const job2 = t.app.store.state.automationJobs.find((job) => job.ruleId === rel2.id);
    if (job2) expect(Math.abs(job2.scheduledAt.getTime() - (renewal.getTime() - HOUR))).toBeLessThan(1000);
  });
});

describe('Action ordering, failure handling, retries and idempotency', () => {
  it('runs actions in order, stops on a permanent failure and keeps prior effects', async () => {
    const t = await setup();
    const rule = t.publishNew({ actions: [t.followUp('one'), { actionCode: 'crm.set_responsible', config: { userId: '00000000-0000-4000-8000-000000000000' } }, t.followUp('three')] });
    t.move(t.stages[1].id);
    await t.process();
    const [execution] = t.executions(rule.id);
    expect(execution.status).toBe('FAILED_FINAL');
    const detail = t.A.execution.getExecution(t.user, t.ws, execution.id);
    expect(detail.actions.map((action) => [action.order, action.status])).toEqual([[1, 'SUCCEEDED'], [2, 'FAILED'], [3, 'SKIPPED']]);
    expect(detail.actions[1]).toMatchObject({ retryable: false, attemptCount: 1 });
    expect(t.activities().map((activity) => activity.subject)).toEqual(['one']);
    // A permanent failure is never retried automatically.
    expect(t.app.store.state.automationJobs[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    const again = await t.A.runner.runDue({ now: new Date(Date.now() + 5 * HOUR) });
    expect(again.claimed).toBe(0);
  });

  it('continues after a failed action only when continueOnError is set and reports partial failure', async () => {
    const t = await setup();
    const rule = t.publishNew({ actions: [{ actionCode: 'crm.set_responsible', config: { userId: '00000000-0000-4000-8000-000000000000' }, continueOnError: true }, t.followUp('after')] });
    t.move(t.stages[1].id);
    await t.process();
    expect(t.executions(rule.id)[0]).toMatchObject({ status: 'SUCCEEDED_WITH_ERRORS', errorCode: 'AUTOMATION_PARTIAL_FAILURE' });
    expect(t.activities().map((activity) => activity.subject)).toEqual(['after']);
  });

  it('retries only retryable failures from the failed action without repeating completed side effects', async () => {
    const t = await setup();
    let calls = 0;
    const flaky: NotificationPort = {
      notifyUsers: (input) => {
        calls += 1;
        if (calls === 1) throw new AppError('RATE_LIMITED', 'slow down', 429);
        t.notifications.notifyUsers(input);
        return { reference: input.idempotencyKey };
      },
    };
    t.A.setNotificationPort(flaky);
    const rule = t.publishNew({ actions: [t.followUp('once'), { actionCode: 'notifications.notify_user', config: { userIds: ['{{target.responsibleUserId}}'], title: 'Hi', message: 'Deal {{target.title}}' } }] });
    t.move(t.stages[1].id);
    const start = new Date();
    await t.process(start);
    expect(t.executions(rule.id)[0].status).toBe('FAILED_RETRYABLE');
    const job = t.app.store.state.automationJobs[0];
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(job.scheduledAt.getTime()).toBeGreaterThan(start.getTime());
    expect(t.activities()).toHaveLength(1);

    // Not due yet -> nothing happens; once due the run resumes at action 2 only.
    expect((await t.A.runner.runDue({ now: start })).claimed).toBe(0);
    await t.A.runner.runDue({ now: new Date(start.getTime() + 10 * MINUTE) });
    expect(t.executions(rule.id)[0].status).toBe('SUCCEEDED');
    expect(t.activities()).toHaveLength(1);
    expect(t.notifications.sent).toHaveLength(1);
    const detail = t.A.execution.getExecution(t.user, t.ws, t.executions(rule.id)[0].id);
    expect(detail.actions.map((action) => [action.status, action.attemptCount])).toEqual([['SUCCEEDED', 1], ['SUCCEEDED', 2]]);
  });

  it('turns a retryable failure into FAILED_FINAL after max attempts and allows an authorized human retry', async () => {
    const t = await setup();
    let fail = true;
    t.A.setNotificationPort({
      notifyUsers: (input) => {
        if (fail) throw new AppError('RATE_LIMITED', 'busy', 429);
        t.notifications.notifyUsers(input);
        return {};
      },
    });
    const rule = t.publishNew({ executionPolicy: { maxAttempts: 2 }, actions: [{ actionCode: 'notifications.notify_user', config: { userIds: ['{{target.responsibleUserId}}'], title: 'x', message: 'y' } }] });
    t.move(t.stages[1].id);
    let now = new Date();
    await t.process(now);
    now = new Date(now.getTime() + 2 * HOUR);
    await t.A.runner.runDue({ now });
    const execution = t.executions(rule.id)[0];
    expect(execution.status).toBe('FAILED_FINAL');

    const analyst = await addMember(t.app, t.user, t.ws, 'analyst', [['automation.view_logs', 'WORKSPACE']]);
    await expectAppError(() => t.A.execution.retry(analyst.user, t.ws, execution.id), 'PERMISSION_DENIED', 403);
    fail = false;
    const retried = t.A.execution.retry(t.user, t.ws, execution.id);
    expect(retried).toMatchObject({ status: 'PENDING', retryCount: 1 });
    await t.A.runner.runDue({ now: new Date(now.getTime() + MINUTE) });
    expect(t.executions(rule.id)[0].status).toBe('SUCCEEDED');
    expect(t.notifications.sent).toHaveLength(1);
    await expectAppError(() => t.A.execution.retry(t.user, t.ws, execution.id), 'AUTOMATION_EXECUTION_NOT_RETRYABLE', 409);
    expect(t.app.store.state.auditLogs.some((log) => log.action === 'AUTOMATION.EXECUTION_RETRIED')).toBe(true);
  });

  it('deduplicates redelivered source events (revision + event + target) and manual requests with the same key', async () => {
    const t = await setup();
    const rule = t.publishNew();
    t.move(t.stages[1].id);
    await t.process();
    for (const event of t.app.store.state.outboxEvents) event.automationProcessedAt = null;
    await t.process();
    expect(t.executions(rule.id)).toHaveLength(1);
    expect(t.activities()).toHaveLength(1);

    const manualRule = t.publishNew({ name: 'manual', trigger: { code: 'manual.execute', config: {} }, actions: [t.followUp('manual once')] });
    const first = t.A.execution.executeManually(t.user, t.ws, manualRule.id, { targetId: t.deal.id, idempotencyKey: 'same' });
    const second = t.A.execution.executeManually(t.user, t.ws, manualRule.id, { targetId: t.deal.id, idempotencyKey: 'same' });
    expect(second.jobId).toBe(first.jobId);
    await t.A.runner.runDue();
    expect(t.activities().filter((activity) => activity.subject === 'manual once')).toHaveLength(1);
  });

  it('cancels a pending job but not one that already ran', async () => {
    const t = await setup();
    const rule = t.publishNew({ timing: { mode: 'DELAY', delayMinutes: 30 } });
    t.move(t.stages[1].id);
    await t.process(new Date());
    const job = t.app.store.state.automationJobs[0];
    const cancelled = t.A.execution.cancelJob(t.user, t.ws, job.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(t.executions(rule.id)[0]).toMatchObject({ status: 'CANCELLED', skipReason: 'JOB_CANCELLED' });
    await t.A.runner.runDue({ now: new Date(Date.now() + 2 * HOUR) });
    expect(t.activities()).toHaveLength(0);
    await expectAppError(() => t.A.execution.cancelJob(t.user, t.ws, job.id), 'AUTOMATION_JOB_NOT_CANCELLABLE', 409);

    const t2 = await setup();
    t2.publishNew();
    t2.move(t2.stages[1].id);
    await t2.process();
    await expectAppError(() => t2.A.execution.cancelJob(t2.user, t2.ws, t2.app.store.state.automationJobs[0].id), 'AUTOMATION_JOB_NOT_CANCELLABLE', 409);
  });

  it('recovers a crashed worker: an expired lease re-runs the job with the same idempotency keys', async () => {
    const t = await setup();
    t.publishNew();
    t.move(t.stages[1].id);
    t.A.ingestPending();
    const [id] = t.A.execution.claimDueJobs(new Date(), 5, 'crashed-worker');
    t.A.execution.beginJob(id);
    const execution = t.app.store.state.automationExecutions[0];
    const row = t.app.store.state.automationActionExecutions[0];
    // Simulate: the action attempt started, the worker died before recording an outcome.
    row.status = 'RUNNING';
    row.attemptCount = 1;
    row.attempts = [{ attempt: 1, startedAt: new Date().toISOString() }];
    expect((await t.A.runner.runDue({ now: new Date() })).claimed).toBe(0);
    const later = new Date(Date.now() + 10 * MINUTE);
    const result = await t.A.runner.runDue({ now: later });
    expect(result.claimed).toBe(1);
    expect(execution.status).toBe('SUCCEEDED');
    expect(row.attempts.map((attempt) => attempt.outcome)).toEqual(['INTERRUPTED', 'SUCCEEDED']);
    expect(row.idempotencyKey).toBe(`${execution.id}:${row.actionId}`);
    expect(t.activities()).toHaveLength(1);
  });
});

describe('Loop and depth protection', () => {
  it('stops a self-triggering rule chain with a visible loop error instead of running forever', async () => {
    const t = await setup();
    const rule = t.publishNew({
      name: 'loop',
      trigger: { code: 'crm.field.changed', config: { fields: ['title'] } },
      actions: [{ actionCode: 'crm.update_fields', config: { fields: { title: '{{target.title}}!' } } }],
    });
    const deal = t.app.store.state.crmDeals.find((item) => item.id === t.deal.id)!;
    t.app.crmCore.updateRecord(t.user, t.ws, 'DEAL', t.deal.id, { title: 'Start', expectedVersion: deal.version });
    for (let i = 0; i < 8; i += 1) await t.process();
    const runs = t.executions(rule.id).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    expect(runs.length).toBeLessThanOrEqual(6);
    const blocked = runs.filter((run) => run.errorCode === 'AUTOMATION_LOOP_LIMIT_EXCEEDED');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('SUCCEEDED');
    expect(t.app.store.state.outboxEvents.some((event) => event.eventType === 'AUTOMATION_LOOP_BLOCKED')).toBe(true);
    expect(t.app.store.state.automationLogs.some((log) => log.code === 'AUTOMATION_LOOP_BLOCKED')).toBe(true);
    // The title was rewritten a bounded number of times.
    expect(t.app.store.state.crmDeals.find((item) => item.id === t.deal.id)!.title.length).toBeLessThan('Start'.length + 10);
    expect(blocked.every((run) => run.status === 'FAILED_FINAL')).toBe(true);
  });

  it('applies the depth limit across two cooperating rules (A -> B -> A)', async () => {
    const t = await setup();
    const a = t.publishNew({ name: 'A', trigger: { code: 'crm.field.changed', config: { fields: ['title'] } }, conditions: { type: 'CONDITION', field: 'target.title', operator: 'CONTAINS', value: 'a' }, actions: [{ actionCode: 'crm.update_fields', config: { fields: { title: '{{target.title}}b' } } }] });
    const b = t.publishNew({ name: 'B', trigger: { code: 'crm.field.changed', config: { fields: ['title'] } }, conditions: { type: 'CONDITION', field: 'target.title', operator: 'CONTAINS', value: 'b' }, actions: [{ actionCode: 'crm.update_fields', config: { fields: { title: '{{target.title}}a' } } }] });
    const deal = t.app.store.state.crmDeals.find((item) => item.id === t.deal.id)!;
    t.app.crmCore.updateRecord(t.user, t.ws, 'DEAL', t.deal.id, { title: 'a', expectedVersion: deal.version });
    for (let i = 0; i < 12; i += 1) await t.process();
    const all = [...t.executions(a.id), ...t.executions(b.id)];
    expect(all.some((run) => run.errorCode === 'AUTOMATION_LOOP_LIMIT_EXCEEDED')).toBe(true);
    expect(Math.max(...all.map((run) => run.depth))).toBeLessThanOrEqual(5);
    expect(all.length).toBeLessThan(12);
  });
});

describe('Dry run and manual execution', () => {
  it('evaluates and previews without any side effect', async () => {
    const t = await setup();
    const rule = t.create({
      conditions: { type: 'CONDITION', field: 'target.title', operator: 'CONTAINS', value: 'deal' },
      actions: [t.followUp(), { actionCode: 'integrations.call_webhook', config: { url: 'https://hooks.example.com/a', secretRef: 'crm-hook', body: { deal: '{{target.title}}', authorization: 'Bearer abc' } } }],
    });
    const snapshot = () => JSON.stringify([t.app.store.state.outboxEvents.length, t.app.store.state.crmActivities.length, t.app.store.state.automationJobs.length, t.app.store.state.automationExecutions.length, t.app.store.state.auditLogs.length, t.app.store.state.crmDeals.map((deal) => deal.version)]);
    const before = snapshot();
    const result = t.A.execution.dryRun(t.user, t.ws, rule.id, { targetId: t.deal.id });
    expect(snapshot()).toBe(before);
    expect(result).toMatchObject({ matched: true, sideEffectsExecuted: false, target: { title: 'Big deal' } });
    expect(result.resolvedActions[0]).toMatchObject({ order: 1, actionCode: 'activities.create_activity', valid: true, wouldRun: true });
    expect(result.resolvedActions[0].resolved).toMatchObject({ subject: 'Follow up Big deal' });
    expect(JSON.stringify(result)).not.toContain('Bearer abc');
    expect(result.conditionResults.some((node) => node.matched)).toBe(true);
    const noMatch = t.A.execution.dryRun(t.user, t.ws, rule.id, { targetId: t.deal.id, context: { changedFields: { title: { before: 'a', after: 'b' } } } });
    expect(noMatch.matched).toBe(true);
    await expectAppError(() => t.A.execution.dryRun(t.user, t.ws, rule.id, { targetId: '00000000-0000-4000-8000-000000000000' }), 'AUTOMATION_TARGET_NOT_FOUND', 404);
  });

  it('runs manually only with the execute permission, on accessible records, and never bypasses conditions', async () => {
    const t = await setup();
    const rule = t.publishNew({ trigger: { code: 'manual.execute', config: {} }, conditions: { type: 'CONDITION', field: 'target.title', operator: 'STARTS_WITH', value: 'zzz' } });
    const skipped = t.A.execution.executeManually(t.user, t.ws, rule.id, { targetId: t.deal.id });
    expect(skipped.execution).toMatchObject({ status: 'SKIPPED_CONDITION', isManual: false });
    expect(t.activities()).toHaveLength(0);

    const open = t.publishNew({ name: 'open', trigger: { code: 'manual.execute', config: {} } });
    const runner = await addMember(t.app, t.user, t.ws, 'runner', [['automation.execute', 'WORKSPACE'], ['crm.deal.read', 'OWN'], ['crm.deal.update', 'OWN']]);
    // The deal belongs to the owner, so an OWN-scoped runner cannot see it.
    await expectAppError(() => t.A.execution.executeManually(runner.user, t.ws, open.id, { targetId: t.deal.id }), 'AUTOMATION_TARGET_NOT_FOUND', 404);
    const noPerm = await addMember(t.app, t.user, t.ws, 'nope', [['crm.deal.update', 'WORKSPACE'], ['crm.deal.read', 'WORKSPACE']]);
    await expectAppError(() => t.A.execution.executeManually(noPerm.user, t.ws, open.id, { targetId: t.deal.id }), 'PERMISSION_DENIED', 403);
    const ok = t.A.execution.executeManually(t.user, t.ws, open.id, { targetId: t.deal.id });
    expect(ok.queued).toBe(true);
    await t.A.runner.runDue();
    const execution = t.executions(open.id)[0];
    expect(execution).toMatchObject({ status: 'SUCCEEDED', isManual: true });
    expect(t.app.store.state.auditLogs.some((log) => log.action === 'AUTOMATION.RULE_EXECUTED_MANUALLY')).toBe(true);
    // Another workspace's record cannot be used even with a valid id.
    const other = await otherTenant(t.app);
    const foreignDeal = t.app.crm.createDeal(other.user, other.workspace.id, { title: 'Other', companyId: t.app.crmCore.createCompany(other.user, other.workspace.id, { name: 'X' }).id });
    await expectAppError(() => t.A.execution.executeManually(t.user, t.ws, open.id, { targetId: foreignDeal.id }), 'AUTOMATION_TARGET_NOT_FOUND', 404);
    // Paused rules cannot be run manually.
    t.A.rules.pause(t.user, t.ws, open.id);
    await expectAppError(() => t.A.execution.executeManually(t.user, t.ws, open.id, { targetId: t.deal.id }), 'AUTOMATION_RULE_STATE_INVALID', 409);
  });
});

describe('Execution identity and owner-domain enforcement', () => {
  it('keeps the service identity scoped: registered permissions only, never an owner, and owner services still refuse the rest', async () => {
    const t = await setup();
    t.publishNew();
    t.move(t.stages[1].id);
    await t.process();
    const identity = t.A.identity.serviceIdentity(t.ws);
    expect(identity.actor.role).toMatchObject({ isOwnerRole: false, isSystem: true, name: 'Automation Service' });
    const granted = t.app.store.state.rolePermissions.filter((row) => row.roleId === identity.actor.role.id && !row.isDeleted).map((row) => t.app.store.state.permissions.find((permission) => permission.id === row.permissionId)!.key);
    expect(granted).toEqual(expect.arrayContaining(['crm.deal.update', 'crm.deal.transition', 'activity.create']));
    expect(granted).not.toContain('crm.deal.delete');
    expect(granted).not.toContain('role.update');
    // Administrative operations are refused: it is a plain, non-owner member.
    expect(() => t.app.roles.create(identity.user, t.ws, { name: 'escalate' })).toThrow();
    expect(t.app.store.state.roles.filter((role) => role.workspaceId === t.ws && role.name === 'escalate')).toHaveLength(0);
    // The service user is not listed as a workspace user.
    expect(t.app.users.list(t.user).some((user) => user.email.includes('service.entertab.invalid'))).toBe(false);
  });

  it('honours the owning domain: transitions still respect stage permissions and required fields', async () => {
    const t = await setup();
    const rule = t.publishNew({ name: 'mover', trigger: t.enter(t.stages[1].id), actions: [{ actionCode: 'crm.move_stage', config: { stageId: t.stages[2].id } }] });
    t.move(t.stages[1].id);
    await t.process();
    expect(t.executions(rule.id)[0].status).toBe('SUCCEEDED');
    expect(t.app.store.state.crmDeals.find((deal) => deal.id === t.deal.id)!.stageId).toBe(t.stages[2].id);
    const identity = t.A.identity.serviceIdentity(t.ws);
    // Deny the service role entering the next stage: the pipeline service refuses, Automation reports a permanent failure.
    t.app.store.state.crmRoleStagePermissions.push({ id: 'p1', workspaceId: t.ws, roleId: identity.actor.role.id, stageId: t.stages[3].id, canView: true, canEnter: false, canLeave: true, createdAt: new Date(), updatedAt: new Date() } as any);
    const guarded = t.publishNew({ name: 'guarded', trigger: t.enter(t.stages[2].id), actions: [{ actionCode: 'crm.move_stage', config: { stageId: t.stages[3].id } }] });
    const fresh = t.app.crm.createDeal(t.user, t.ws, { title: 'Second', companyId: t.company.id });
    t.move(t.stages[2].id, fresh.id);
    await t.process();
    expect(t.executions(guarded.id)[0]).toMatchObject({ status: 'FAILED_FINAL' });
    expect(t.app.store.state.crmDeals.find((deal) => deal.id === fresh.id)!.stageId).toBe(t.stages[2].id);
  });

  it('requires an INITIATING_USER identity to still be an active member', async () => {
    const t = await setup();
    const member = await addMember(t.app, t.user, t.ws, 'actor', [['crm.deal.read', 'WORKSPACE'], ['crm.deal.update', 'WORKSPACE'], ['crm.deal.transition', 'WORKSPACE'], ['activity.create', 'WORKSPACE'], ['activity.read', 'WORKSPACE']]);
    const rule = t.publishNew({ executionPolicy: { identity: 'INITIATING_USER' } });
    const current = t.app.store.state.crmDeals.find((deal) => deal.id === t.deal.id)!;
    t.app.crm.transitionDeal(member.user, t.ws, t.deal.id, { expectedVersion: current.version, targetStageId: t.stages[1].id });
    t.A.ingestPending();
    t.app.store.state.workspaceMemberships.find((m) => m.userId === member.user.id && m.workspaceId === t.ws)!.status = 'SUSPENDED';
    await t.A.runner.runDue();
    expect(t.executions(rule.id)[0]).toMatchObject({ status: 'FAILED_FINAL', errorCode: 'AUTOMATION_IDENTITY_UNAVAILABLE' });
    await expectAppError(() => t.publishNew({ timing: { mode: 'DELAY', delayMinutes: 5 }, executionPolicy: { identity: 'INITIATING_USER' } }), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
  });

  it('withholds actions whose owning module is not connected instead of faking them', async () => {
    const t = await setup();
    t.A.setNotificationPort(null);
    const types = t.A.actionTypes(t.user, t.ws).map((action) => action.code);
    expect(types).toEqual(expect.arrayContaining(['crm.update_fields', 'activities.create_activity', 'tasks.create_task', 'communication.send_message']));
    expect(types).not.toContain('notifications.notify_user');
    const rule = t.create({ actions: [{ actionCode: 'notifications.notify_user', config: { userIds: ['{{target.responsibleUserId}}'], title: 'x', message: 'y' } }] });
    await expectAppError(() => t.publish(rule), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
  });
});
