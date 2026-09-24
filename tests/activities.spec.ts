import {
  ACTIVITY_BASIC,
  actorOf,
  addMember,
  CRM_READ,
  DAY,
  expectAppError,
  fullApp,
  HOUR,
  iso,
  otherTenant,
  project,
} from './support/domain';

type App = Awaited<ReturnType<typeof fullApp>>;

const call = (t: App, extra: Record<string, unknown> = {}, user = t.user) =>
  t.app.activities.create(user, t.workspace.id, { typeCode: 'CALL', subject: 'Follow up on proposal', ...extra });
const followUp = (t: App, extra: Record<string, unknown> = {}, user = t.user) =>
  t.app.activities.create(user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Check in', ...extra });
const stored = (t: App, id: string) => t.app.store.state.crmActivities.find((item) => item.id === id)!;
const events = (t: App, type: string, activityId?: string) =>
  t.app.store.state.outboxEvents.filter((event) => event.eventType === type && (!activityId || event.entityId === activityId));

describe('Activities - lifecycle and state', () => {
  it('supports PLANNED -> IN_PROGRESS -> COMPLETED and cancellation paths', async () => {
    const t = await fullApp();
    const a = await call(t);
    expect(a.status).toBe('PLANNED');
    const started = await t.app.activities.start(t.user, t.workspace.id, a.id, { expectedVersion: a.version });
    expect(started.status).toBe('IN_PROGRESS');
    const done = await t.app.activities.complete(t.user, t.workspace.id, a.id, { resultText: 'Customer approved.' });
    expect(done).toMatchObject({ status: 'COMPLETED', resultText: 'Customer approved.' });
    expect(done.completedAt).toBeInstanceOf(Date);

    // PLANNED -> COMPLETED directly, and both cancel paths.
    const direct = await followUp(t);
    expect((await t.app.activities.complete(t.user, t.workspace.id, direct.id)).status).toBe('COMPLETED');
    const cancelPlanned = await followUp(t);
    expect((await t.app.activities.cancel(t.user, t.workspace.id, cancelPlanned.id, { reason: 'Customer asked to stop' })).status).toBe('CANCELLED');
    const cancelStarted = await followUp(t);
    await t.app.activities.start(t.user, t.workspace.id, cancelStarted.id);
    const cancelled = await t.app.activities.cancel(t.user, t.workspace.id, cancelStarted.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBeNull(); // the reason is optional
    expect(t.app.store.state.auditLogs.map((log) => log.action)).toEqual(expect.arrayContaining(['ACTIVITY.CREATED', 'ACTIVITY.STARTED', 'ACTIVITY.COMPLETED', 'ACTIVITY.CANCELLED']));
  });

  it('rejects illegal transitions with a stable code', async () => {
    const t = await fullApp();
    const a = await followUp(t);
    await t.app.activities.complete(t.user, t.workspace.id, a.id);
    await expectAppError(() => t.app.activities.start(t.user, t.workspace.id, a.id), 'ACTIVITY_INVALID_TRANSITION', 409);
    await expectAppError(() => t.app.activities.cancel(t.user, t.workspace.id, a.id), 'ACTIVITY_INVALID_TRANSITION', 409);
    const planned = await followUp(t);
    await expectAppError(() => t.app.activities.reopen(t.user, t.workspace.id, planned.id), 'ACTIVITY_INVALID_TRANSITION', 409); // PLANNED cannot be "reopened"
    const cancelled = await followUp(t);
    await t.app.activities.cancel(t.user, t.workspace.id, cancelled.id);
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, cancelled.id), 'ACTIVITY_INVALID_TRANSITION', 409);
    // Status can never be written through create or PATCH.
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, status: 'PLANNED' }), 'ACTIVITY_STATUS_PATCH_FORBIDDEN', 400);
    await expectAppError(() => followUp(t, { status: 'COMPLETED' }), 'ACTIVITY_STATUS_PATCH_FORBIDDEN', 400);
  });

  it('supports COMPLETED -> IN_PROGRESS and CANCELLED -> PLANNED only through reopen', async () => {
    const t = await fullApp();
    const completed = await followUp(t);
    await t.app.activities.complete(t.user, t.workspace.id, completed.id, { resultText: 'ok' });
    const reopenedCompleted = await t.app.activities.reopen(t.user, t.workspace.id, completed.id, { reason: 'Customer came back' });
    expect(reopenedCompleted.status).toBe('IN_PROGRESS');
    expect(reopenedCompleted.completedAt).toBeNull();
    expect(reopenedCompleted.reopenedAt).toBeInstanceOf(Date);

    const cancelled = await followUp(t);
    await t.app.activities.cancel(t.user, t.workspace.id, cancelled.id, { reason: 'x' });
    const reopenedCancelled = await t.app.activities.reopen(t.user, t.workspace.id, cancelled.id);
    expect(reopenedCancelled.status).toBe('PLANNED');
    expect(reopenedCancelled.cancelledAt).toBeNull();
    // Reopening an already-open activity is invalid, never a silent no-op that rewrites state.
    await expectAppError(() => t.app.activities.reopen(t.user, t.workspace.id, cancelled.id), 'ACTIVITY_INVALID_TRANSITION', 409);
  });

  it('rejects editing completed business fields without reopen, but still allows adding files', async () => {
    const t = await fullApp();
    const a = await followUp(t, { description: 'original' });
    await t.app.activities.complete(t.user, t.workspace.id, a.id, { resultText: 'final' });
    const current = () => stored(t, a.id).version;
    const error = await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: current(), description: 'rewrite history' }), 'ACTIVITY_EDIT_REQUIRES_REOPEN', 409);
    expect(error.message).toMatch(/reopened/);
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: current(), deadline: iso(DAY) }), 'ACTIVITY_EDIT_REQUIRES_REOPEN', 409);
    expect(stored(t, a.id)).toMatchObject({ description: 'original', resultText: 'final' });
    t.files.register(t.workspace.id, '33333333-3333-4333-8333-333333333333');
    const withFile = await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: current(), fileIds: ['33333333-3333-4333-8333-333333333333'] });
    expect(withFile.fileIds).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(withFile.status).toBe('COMPLETED'); // adding a file does not reopen it
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: current(), fileIds: [] }), 'ACTIVITY_EDIT_REQUIRES_REOPEN', 409);
    await t.app.activities.reopen(t.user, t.workspace.id, a.id);
    const edited = await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: current(), description: 'now editable' });
    expect(edited.description).toBe('now editable');
  });

  it('uses LOW/NORMAL/HIGH priority with NORMAL default', async () => {
    const t = await fullApp();
    expect((await call(t)).priority).toBe('NORMAL');
    expect((await call(t, { priority: 'HIGH' })).priority).toBe('HIGH');
    expect((await call(t, { priority: 'LOW' })).priority).toBe('LOW');
    await expectAppError(() => call(t, { priority: 'URGENT' }), 'FIELD_VALIDATION_FAILED');
  });

  it('validates INCOMING/OUTGOING/NOT_APPLICABLE by activity type', async () => {
    const t = await fullApp();
    expect((await call(t)).direction).toBe('OUTGOING'); // type default
    expect((await call(t, { direction: 'INCOMING' })).direction).toBe('INCOMING');
    expect((await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'EMAIL', subject: 'Re: quote', direction: 'INCOMING' })).direction).toBe('INCOMING');
    expect((await followUp(t)).direction).toBe('NOT_APPLICABLE');
    await expectAppError(() => followUp(t, { direction: 'INCOMING' }), 'FIELD_VALIDATION_FAILED');
    // Meetings force NOT_APPLICABLE.
    const meeting = { typeCode: 'MEETING', subject: 'Kickoff', startAt: iso(DAY), endAt: iso(DAY + HOUR) };
    expect((await t.app.activities.create(t.user, t.workspace.id, meeting)).direction).toBe('NOT_APPLICABLE');
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { ...meeting, direction: 'OUTGOING' }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => call(t, { direction: 'SIDEWAYS' }), 'FIELD_VALIDATION_FAILED');
  });

  it('validates type-aware start/end/deadline with timezone-explicit instants', async () => {
    const t = await fullApp();
    await expectAppError(() => call(t, { startAt: iso(DAY), endAt: iso(DAY - HOUR) }), 'ACTIVITY_TIME_INVALID', 400);
    await expectAppError(() => call(t, { startAt: '2027-01-01T10:00:00' }), 'ACTIVITY_TIME_INVALID', 400); // no offset => ambiguous instant
    await expectAppError(() => call(t, { deadline: 'tomorrow' }), 'ACTIVITY_TIME_INVALID', 400);
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'MEETING', subject: 'No times' }), 'ACTIVITY_TIME_INVALID', 400);
    await expectAppError(() => followUp(t, { location: 'Room 1' }), 'FIELD_VALIDATION_FAILED'); // follow-ups have no location
    const withOffset = await call(t, { startAt: '2027-01-01T10:00:00+02:00', endAt: '2027-01-01T10:30:00+02:00', deadline: '2027-01-01T08:00:00Z' });
    expect(new Date(withOffset.startAt!).toISOString()).toBe('2027-01-01T08:00:00.000Z');
    expect(new Date(withOffset.deadline!).toISOString()).toBe('2027-01-01T08:00:00.000Z');
    // PATCH validates the merged times too.
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, withOffset.id, { expectedVersion: withOffset.version, endAt: '2027-01-01T05:00:00Z' }), 'ACTIVITY_TIME_INVALID', 400);
  });

  it('allows an Activity with no CRM binding and adds a binding later', async () => {
    const t = await fullApp();
    const a = await followUp(t);
    expect(a.bindings).toEqual([]);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Later lead' });
    const binding = t.app.activities.addBinding(t.user, t.workspace.id, a.id, { entityType: 'LEAD', entityId: lead.id }) as any;
    expect(binding).toMatchObject({ entityType: 'LEAD', entityId: lead.id, isPrimary: true });
    expect(t.app.activities.getById(t.user, t.workspace.id, a.id).bindings).toHaveLength(1);
  });

  it('records optional result text and structured outcome custom fields on completion', async () => {
    const t = await fullApp();
    t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'ACTIVITY', label: 'Call outcome', code: 'call_outcome', fieldType: 'TEXT' });
    const a = await call(t);
    const done = await t.app.activities.complete(t.user, t.workspace.id, a.id, { resultText: 'Customer requested revised pricing.', customFields: { call_outcome: 'FOLLOW_UP_REQUIRED' }, expectedVersion: a.version });
    expect(done.resultText).toBe('Customer requested revised pricing.');
    expect(done.customFields).toEqual({ call_outcome: 'FOLLOW_UP_REQUIRED' });
    // Outcome values validate before completion commits: nothing changes on failure.
    t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'ACTIVITY', label: 'Score', code: 'score', fieldType: 'INTEGER', validationConfig: { minimum: 1 } });
    const b = await call(t);
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, b.id, { customFields: { score: 0 } }), 'FIELD_VALIDATION_FAILED');
    expect(stored(t, b.id).status).toBe('PLANNED');
    expect(events(t, 'ACTIVITY_COMPLETED', b.id)).toHaveLength(0);
    // Completing without a result is allowed; the result is optional.
    expect((await t.app.activities.complete(t.user, t.workspace.id, b.id)).resultText).toBeNull();
    await expectAppError(() => followUp(t).then((x) => t.app.activities.complete(t.user, t.workspace.id, x.id, { resultText: 'x'.repeat(25000) })), 'FIELD_VALIDATION_FAILED');
    // Documents carry no result concept.
    const doc = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'DOCUMENT', subject: 'Contract v1' });
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, doc.id, { resultText: 'nope' }), 'FIELD_VALIDATION_FAILED');
  });

  it('soft deletes and restores an Activity without erasing timeline or audit history', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'History lead' });
    const a = await call(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }], startAt: iso(2 * DAY), reminders: [{ mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -3600 }] });
    project(t.app);
    const timelineBefore = t.app.store.state.crmTimelineEntries.filter((entry) => entry.sourceId === a.id).length;
    expect(timelineBefore).toBe(1);

    const deleted = await t.app.activities.softDelete(t.user, t.workspace.id, a.id);
    expect(deleted).toEqual({ id: a.id, isDeleted: true });
    expect(stored(t, a.id).isDeleted).toBe(true);
    // Hidden from lists and direct reads; reminders no longer pending; evidence retained.
    expect(t.app.activities.list(t.user, t.workspace.id, new URLSearchParams({ view: 'ALL' })).data.map((x) => x.id)).not.toContain(a.id);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.getById(t.user, t.workspace.id, a.id)), 'ACTIVITY_NOT_FOUND', 404);
    expect(t.app.activities.getById(t.user, t.workspace.id, a.id, true).isDeleted).toBe(true);
    expect(t.app.store.state.crmActivityReminders.filter((r) => r.activityId === a.id).every((r) => r.status === 'CANCELLED')).toBe(true);
    project(t.app);
    expect(t.app.store.state.crmTimelineEntries.filter((entry) => entry.sourceId === a.id).map((entry) => entry.summaryCode)).toEqual(expect.arrayContaining(['ACTIVITY_CREATED', 'ACTIVITY_DELETED']));
    expect(t.app.store.state.auditLogs.some((log) => log.action === 'ACTIVITY.SOFT_DELETED' && log.entityId === a.id)).toBe(true);
    // Deleting twice is an idempotent no-op with no second event.
    await t.app.activities.softDelete(t.user, t.workspace.id, a.id);
    expect(events(t, 'ACTIVITY_DELETED', a.id)).toHaveLength(1);
    // The unbound-lead's own data is untouched.
    expect(t.app.store.state.crmLeads.find((item) => item.id === lead.id)!.isDeleted).toBe(false);

    const restored = await t.app.activities.restore(t.user, t.workspace.id, a.id);
    expect(restored.isDeleted).toBe(false);
    expect(t.app.store.state.crmActivityReminders.filter((r) => r.activityId === a.id).every((r) => r.status === 'SCHEDULED')).toBe(true); // future, never-sent reminders come back
    expect(t.app.activities.list(t.user, t.workspace.id, new URLSearchParams({ view: 'ALL' })).data.map((x) => x.id)).toContain(a.id);
  });

  it('revalidates the responsible user and bindings on restore', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'assignee', [...ACTIVITY_BASIC, ['activity.assign', 'WORKSPACE']]);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Will vanish' });
    const a = await call(t, { responsibleUserId: member.user.id, bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    await t.app.activities.softDelete(t.user, t.workspace.id, a.id);
    t.app.store.state.workspaceMemberships.find((item) => item.userId === member.user.id && item.workspaceId === t.workspace.id)!.isDeleted = true;
    const error = await expectAppError(() => t.app.activities.restore(t.user, t.workspace.id, a.id), 'ACTIVITY_RESTORE_INVALID', 409);
    expect(error.details.requires).toBe('responsibleUserId');
    t.app.store.state.crmLeads.find((item) => item.id === lead.id)!.isDeleted = true;
    const restored = await t.app.activities.restore(t.user, t.workspace.id, a.id, { responsibleUserId: t.user.id });
    expect(restored.responsibleUserId).toBe(t.user.id);
    expect(t.app.store.state.crmActivityBindings.filter((b) => b.activityId === a.id)).toHaveLength(0); // dangling binding dropped
  });

  it('returns a version conflict for a stale Activity PATCH and writes nothing', async () => {
    const t = await fullApp();
    const a = await call(t);
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: a.version, subject: 'Second' });
    const error = await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: a.version, subject: 'Third' }), 'ACTIVITY_VERSION_CONFLICT', 409);
    expect(error.details.currentVersion).toBe(a.version + 1);
    expect(stored(t, a.id).subject).toBe('Second');
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { subject: 'no version' }), 'ACTIVITY_VERSION_REQUIRED', 400);
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, a.id, { expectedVersion: a.version }), 'ACTIVITY_VERSION_CONFLICT', 409);
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, workspaceId: 'x', createdByUserId: 'y' }), 'ACTIVITY_FIELD_NOT_UPDATABLE', 400);
  });

  it('replays the same create/complete idempotency keys without duplicate business effects', async () => {
    const t = await fullApp();
    const first = await call(t, { idempotencyKey: 'create-1' });
    const again = await call(t, { idempotencyKey: 'create-1' });
    expect(again.id).toBe(first.id);
    expect(t.app.store.state.crmActivities).toHaveLength(1);
    expect(events(t, 'ACTIVITY_CREATED')).toHaveLength(1);

    const done = await t.app.activities.complete(t.user, t.workspace.id, first.id, { idempotencyKey: 'done-1', resultText: 'ok' });
    const replay = await t.app.activities.complete(t.user, t.workspace.id, first.id, { idempotencyKey: 'done-1', resultText: 'ok' });
    expect(replay.version).toBe(done.version);
    expect(events(t, 'ACTIVITY_COMPLETED', first.id)).toHaveLength(1);
    project(t.app);
    expect(t.app.store.state.crmTimelineEntries.filter((e) => e.summaryCode === 'ACTIVITY_COMPLETED')).toHaveLength(0); // unbound => nothing to project onto
    // Completing an already-completed activity without any key is also an idempotent success.
    const third = await t.app.activities.complete(t.user, t.workspace.id, first.id);
    expect(third.version).toBe(done.version);
    expect(events(t, 'ACTIVITY_COMPLETED', first.id)).toHaveLength(1);
  });

  it('returns a conflict for the same idempotency key with a different normalized request', async () => {
    const t = await fullApp();
    await call(t, { idempotencyKey: 'k' });
    await expectAppError(() => call(t, { idempotencyKey: 'k', subject: 'Different subject' }), 'IDEMPOTENCY_CONFLICT', 409);
    // Key order and whitespace-free JSON differences do not matter: it is the same normalized request.
    const a = await followUp(t, { idempotencyKey: 'k2', priority: 'HIGH', description: 'x' });
    const b = await t.app.activities.create(t.user, t.workspace.id, { description: 'x', priority: 'HIGH', subject: 'Check in', typeCode: 'FOLLOW_UP', idempotencyKey: 'k2' });
    expect(b.id).toBe(a.id);
    const done = await followUp(t);
    await t.app.activities.complete(t.user, t.workspace.id, done.id, { idempotencyKey: 'c', resultText: 'one' });
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, done.id, { idempotencyKey: 'c', resultText: 'two' }), 'IDEMPOTENCY_CONFLICT', 409);
    await expectAppError(() => call(t, { idempotencyKey: '' }), 'IDEMPOTENCY_KEY_INVALID', 400);
  });

  it('bulk completes valid activities and reports per-item failures without rolling back unrelated successes', async () => {
    const t = await fullApp();
    const ok1 = await followUp(t);
    const ok2 = await followUp(t);
    const cancelled = await followUp(t);
    await t.app.activities.cancel(t.user, t.workspace.id, cancelled.id);
    const other = await otherTenant(t.app);
    const foreign = await t.app.activities.create(other.user, other.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Foreign' });
    const result = await t.app.activities.bulk(t.user, t.workspace.id, {
      operation: 'COMPLETE',
      activityIds: [ok1.id, cancelled.id, foreign.id, ok2.id, '00000000-0000-4000-8000-000000000000'],
      idempotencyKey: 'bulk-root',
    });
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(3);
    expect(result.results.map((item) => [item.success, item.code])).toEqual([
      [true, undefined],
      [false, 'ACTIVITY_INVALID_TRANSITION'],
      [false, 'ACTIVITY_NOT_FOUND'],
      [true, undefined],
      [false, 'ACTIVITY_NOT_FOUND'],
    ]);
    expect(stored(t, ok1.id).status).toBe('COMPLETED');
    expect(stored(t, ok2.id).status).toBe('COMPLETED');
    expect(stored(t, foreign.id).status).toBe('PLANNED'); // the foreign workspace's activity is untouched
    // Retrying the same root does not repeat the effects of the successful items.
    const eventsBefore = events(t, 'ACTIVITY_COMPLETED').length;
    const retry = await t.app.activities.bulk(t.user, t.workspace.id, { operation: 'COMPLETE', activityIds: [ok1.id, ok2.id], idempotencyKey: 'bulk-root' });
    expect(retry.succeeded).toBe(2);
    expect(events(t, 'ACTIVITY_COMPLETED')).toHaveLength(eventsBefore);
  });

  it('bulk reassigns, cancels and soft-deletes with the same per-item authorization', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'worker', ACTIVITY_BASIC);
    const a = await followUp(t);
    const b = await followUp(t);
    const reassigned = await t.app.activities.bulk(t.user, t.workspace.id, { operation: 'REASSIGN', activityIds: [a.id, b.id], payload: { responsibleUserId: member.user.id } });
    expect(reassigned.succeeded).toBe(2);
    expect(stored(t, a.id).responsibleUserId).toBe(member.user.id);
    // The member lacks activity.assign / activity.delete, so each item fails on its own.
    const denied = await t.app.activities.bulk(member.user, t.workspace.id, { operation: 'SOFT_DELETE', activityIds: [a.id, b.id] });
    expect(denied.failed).toBe(2);
    expect(denied.results.every((item) => item.code === 'PERMISSION_DENIED')).toBe(true);
    const deniedAssign = await t.app.activities.bulk(member.user, t.workspace.id, { operation: 'REASSIGN', activityIds: [a.id], payload: { responsibleUserId: t.user.id } });
    expect(deniedAssign.results[0].code).toBe('ACTIVITY_ASSIGN_FORBIDDEN');
    expect((await t.app.activities.bulk(t.user, t.workspace.id, { operation: 'CANCEL', activityIds: [a.id] })).succeeded).toBe(1);
    expect((await t.app.activities.bulk(t.user, t.workspace.id, { operation: 'SOFT_DELETE', activityIds: [a.id, b.id] })).succeeded).toBe(2);
    await expectAppError(() => t.app.activities.bulk(t.user, t.workspace.id, { operation: 'COMPLETE', activityIds: Array.from({ length: 101 }, (_, i) => `id-${i}`) }), 'ACTIVITY_BULK_LIMIT_EXCEEDED', 400);
    await expectAppError(() => t.app.activities.bulk(t.user, t.workspace.id, { operation: 'EXPLODE', activityIds: [a.id] }), 'ACTIVITY_BULK_OPERATION_INVALID', 400);
  });

  it('enforces granular permission keys and scopes', async () => {
    const t = await fullApp();
    const creator = await addMember(t.app, t.user, t.workspace.id, 'creator', [['activity.create', 'WORKSPACE']]);
    await expectAppError(() => call(t, {}, creator.user).then(() => t.app.activities.list(creator.user, t.workspace.id, new URLSearchParams())), 'PERMISSION_DENIED', 403);
    const nobody = await addMember(t.app, t.user, t.workspace.id, 'nobody', [['crm.lead.read', 'WORKSPACE']]);
    await expectAppError(() => call(t, {}, nobody.user), 'PERMISSION_DENIED', 403);

    // OWN scope: only the responsible user's Activities are visible; being mentioned/creating is not enough.
    const own = await addMember(t.app, t.user, t.workspace.id, 'own', [['activity.create', 'WORKSPACE'], ['activity.read', 'OWN'], ['activity.update', 'OWN'], ['activity.complete', 'OWN']]);
    // Creating work for somebody else needs activity.assign.
    await expectAppError(() => followUp(t, { responsibleUserId: t.user.id }, own.user), 'ACTIVITY_ASSIGN_FORBIDDEN', 403);
    const theirs = await followUp(t);
    const ownMine = await followUp(t, {}, own.user);
    expect(t.app.activities.list(own.user, t.workspace.id, new URLSearchParams({ view: 'ALL' })).data.map((x) => x.id)).toEqual([ownMine.id]);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.getById(own.user, t.workspace.id, theirs.id)), 'ACTIVITY_NOT_FOUND', 404);
    await expectAppError(() => t.app.activities.update(own.user, t.workspace.id, theirs.id, { expectedVersion: 1, subject: 'x' }), 'ACTIVITY_NOT_FOUND', 404);
    // Lifecycle actions need their own key: update alone is not enough for reopen/delete.
    await t.app.activities.complete(own.user, t.workspace.id, ownMine.id);
    await expectAppError(() => t.app.activities.reopen(own.user, t.workspace.id, ownMine.id), 'PERMISSION_DENIED', 403);
    await expectAppError(() => t.app.activities.softDelete(own.user, t.workspace.id, ownMine.id), 'PERMISSION_DENIED', 403);
    const onlyRead = await addMember(t.app, t.user, t.workspace.id, 'reader', [['activity.read', 'WORKSPACE']]);
    const readable = await followUp(t);
    expect(t.app.activities.getById(onlyRead.user, t.workspace.id, readable.id).actions).toMatchObject({ canUpdate: false, canComplete: false, canDelete: false, canAssign: false });
    await expectAppError(() => t.app.activities.complete(onlyRead.user, t.workspace.id, readable.id), 'PERMISSION_DENIED', 403);
    await expectAppError(() => t.app.activities.update(onlyRead.user, t.workspace.id, readable.id, { expectedVersion: 1, subject: 'x' }), 'PERMISSION_DENIED', 403);
  });

  it('supports department scopes through the organization tree without rewriting responsibility', async () => {
    const t = await fullApp();
    const parent = t.app.departments.create(t.user, t.workspace.id, { name: 'Sales' });
    const child = t.app.departments.create(t.user, t.workspace.id, { name: 'Sales EMEA', parentDepartmentId: parent.id });
    const manager = await addMember(t.app, t.user, t.workspace.id, 'manager', [['activity.create', 'WORKSPACE'], ['activity.read', 'DEPARTMENT_TREE']]);
    const rep = await addMember(t.app, t.user, t.workspace.id, 'rep', [['activity.create', 'WORKSPACE'], ['activity.read', 'OWN']]);
    const peer = await addMember(t.app, t.user, t.workspace.id, 'peer', [['activity.create', 'WORKSPACE'], ['activity.read', 'DEPARTMENT']]);
    t.app.departments.addMembers(t.user, t.workspace.id, parent.id, [manager.user.id]);
    t.app.departments.addMembers(t.user, t.workspace.id, child.id, [rep.user.id, peer.user.id]);
    const repActivity = await followUp(t, {}, rep.user);
    expect(t.app.activities.getById(manager.user, t.workspace.id, repActivity.id).id).toBe(repActivity.id); // sub-department is inside the tree
    expect(t.app.activities.getById(peer.user, t.workspace.id, repActivity.id).id).toBe(repActivity.id); // same department
    const managerActivity = await followUp(t, {}, manager.user);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.getById(peer.user, t.workspace.id, managerActivity.id)), 'ACTIVITY_NOT_FOUND', 404); // parent dept is not peer's dept
  });

  it('rejects cross-workspace bindings, participants, responsible users and reads', async () => {
    const t = await fullApp();
    const other = await otherTenant(t.app);
    const foreignLead = t.app.crm.createLead(other.user, other.workspace.id, { title: 'Foreign lead' });
    const foreignActivity = await t.app.activities.create(other.user, other.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Foreign' });
    await expectAppError(() => call(t, { bindings: [{ entityType: 'LEAD', entityId: foreignLead.id }] }), 'ACTIVITY_BINDING_FORBIDDEN', 403);
    await expectAppError(() => call(t, { participants: [other.user.id] }), 'ACTIVITY_PARTICIPANT_INVALID', 400);
    await expectAppError(() => call(t, { responsibleUserId: other.user.id }), 'ACTIVITY_ASSIGN_FORBIDDEN', 403);
    await expectAppError(() => call(t, { communications: [{ type: 'EMAIL', value: 'a@b.com', crmEntityType: 'LEAD', crmEntityId: foreignLead.id }] }), 'ACTIVITY_BINDING_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.getById(t.user, t.workspace.id, foreignActivity.id)), 'ACTIVITY_NOT_FOUND', 404);
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, foreignActivity.id), 'ACTIVITY_NOT_FOUND', 404);
    await expectAppError(() => t.app.activities.softDelete(t.user, t.workspace.id, foreignActivity.id), 'ACTIVITY_NOT_FOUND', 404);
    const own = await call(t);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.addBinding(t.user, t.workspace.id, own.id, { entityType: 'LEAD', entityId: foreignLead.id })), 'ACTIVITY_BINDING_FORBIDDEN', 403);
    // The other tenant never sees this workspace's activities in a list either.
    expect(t.app.activities.list(other.user, other.workspace.id, new URLSearchParams({ view: 'ALL' })).data.map((x) => x.id)).toEqual([foreignActivity.id]);
    expect(actorOf(t.app, t.user, t.workspace.id).workspaceId).toBe(t.workspace.id);
  });

  it('creates custom Activity types without deployment and disabling one keeps history', async () => {
    const t = await fullApp();
    const type = t.app.activityTypeAdmin.create(t.user, t.workspace.id, {
      code: 'SITE_VISIT',
      name: 'Site visit',
      icon: 'map-pin',
      colorToken: 'accent-blue',
      defaultDurationMinutes: 90,
      defaultPriority: 'HIGH',
      defaultDirection: 'NOT_APPLICABLE',
    });
    expect(type).toMatchObject({ code: 'SITE_VISIT', enabled: true, version: 1 });
    t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'ACTIVITY', label: 'Visit outcome', code: 'visit_outcome', fieldType: 'TEXT', activityTypeId: type.id });
    t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'ACTIVITY', label: 'Everyone', code: 'everyone', fieldType: 'TEXT' });

    const start = iso(DAY);
    const visit = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'SITE_VISIT', subject: 'Measure the site', startAt: start, customFields: { visit_outcome: 'pending', everyone: 'x' } });
    // Type defaults seed the record; explicit values still win.
    expect(visit.priority).toBe('HIGH');
    expect(new Date(visit.endAt!).getTime() - new Date(visit.startAt!).getTime()).toBe(90 * 60_000);
    expect((await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'SITE_VISIT', subject: 'Explicit', startAt: start, endAt: iso(DAY + HOUR), priority: 'LOW' })).priority).toBe('LOW');
    // Per-type custom fields only apply to that type; common ones apply everywhere.
    const plain = await call(t, { customFields: { everyone: 'y' } });
    expect(plain.customFields).toEqual({ everyone: 'y' });
    await expectAppError(() => call(t, { customFields: { visit_outcome: 'nope' } }), 'FIELD_VALIDATION_FAILED');

    const disabled = t.app.activityTypeAdmin.setEnabled(t.user, t.workspace.id, type.id, false) as any;
    expect(disabled.enabled).toBe(false);
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'SITE_VISIT', subject: 'New' }), 'ACTIVITY_TYPE_DISABLED', 409);
    expect(t.app.activities.getById(t.user, t.workspace.id, visit.id).typeCode).toBe('SITE_VISIT'); // history intact
    expect((await t.app.activities.complete(t.user, t.workspace.id, visit.id)).status).toBe('COMPLETED');
    t.app.activityTypeAdmin.setEnabled(t.user, t.workspace.id, type.id, true);
    expect((await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'SITE_VISIT', subject: 'Again' })).typeCode).toBe('SITE_VISIT');
  });

  it('protects Activity type configuration: codes, built-ins, versions, permissions and markup', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'plain', ACTIVITY_BASIC);
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.create(member.user, t.workspace.id, { code: 'X_TYPE', name: 'X' })), 'PERMISSION_DENIED', 403);
    const created = t.app.activityTypeAdmin.create(t.user, t.workspace.id, { code: 'DEMO', name: 'Demo' });
    const type = { id: created.id, version: created.version };
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.create(t.user, t.workspace.id, { code: 'DEMO', name: 'Again' })), 'ACTIVITY_TYPE_CODE_CONFLICT', 409);
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.create(t.user, t.workspace.id, { code: 'CALL', name: 'Fake call' })), 'ACTIVITY_TYPE_CODE_CONFLICT', 409);
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.create(t.user, t.workspace.id, { code: 'REMINDER', name: 'Reminder' })), 'ACTIVITY_TYPE_CODE_CONFLICT', 409); // reminders are not a type
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.create(t.user, t.workspace.id, { code: 'SVG_TYPE', name: 'Svg', icon: '<svg onload=alert(1)>' })), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.update(t.user, t.workspace.id, type.id, { name: 'no version' })), 'CONFIGURATION_VERSION_REQUIRED', 400);
    t.app.activityTypeAdmin.update(t.user, t.workspace.id, type.id, { version: type.version, name: 'Demo 2' });
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.update(t.user, t.workspace.id, type.id, { version: type.version, name: 'stale' })), 'CONFIGURATION_VERSION_CONFLICT', 409);
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.update(t.user, t.workspace.id, type.id, { version: type.version + 1, code: 'RENAMED' })), 'ACTIVITY_TYPE_CODE_IMMUTABLE', 400);
    const listed = t.app.activityTypeAdmin.list(member.user, t.workspace.id) as any[];
    expect(listed.map((item) => item.code)).toEqual(expect.arrayContaining(['CALL', 'MEETING', 'EMAIL', 'MESSAGE', 'FOLLOW_UP', 'TASK', 'DOCUMENT', 'DEMO']));
    expect(listed.map((item) => item.code)).not.toContain('REMINDER');
    // A foreign workspace cannot reach this type by id.
    const other = await otherTenant(t.app);
    await expectAppError(() => Promise.resolve().then(() => t.app.activityTypeAdmin.get(other.user, other.workspace.id, type.id)), 'ACTIVITY_TYPE_NOT_FOUND', 404);
    await expectAppError(() => t.app.activities.create(other.user, other.workspace.id, { typeCode: 'DEMO', subject: 'x' }), 'ACTIVITY_TYPE_NOT_FOUND', 404);
  });

  it('lists My Open Activities by default with overdue and urgent work first, using cursor pagination', async () => {
    const t = await fullApp();
    const later = await followUp(t, { subject: 'later', deadline: iso(5 * DAY) });
    const soon = await followUp(t, { subject: 'soon', deadline: iso(2 * HOUR) });
    const overdue = await followUp(t, { subject: 'overdue', deadline: iso(-3 * HOUR) });
    const undated = await followUp(t, { subject: 'undated' });
    const done = await followUp(t, { subject: 'done', deadline: iso(-DAY) });
    await t.app.activities.complete(t.user, t.workspace.id, done.id);
    const teammate = await addMember(t.app, t.user, t.workspace.id, 'mate', [...ACTIVITY_BASIC, ['activity.assign', 'WORKSPACE']]);
    await t.app.activities.create(teammate.user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'not mine' });

    const mine = t.app.activities.list(t.user, t.workspace.id, new URLSearchParams());
    expect(mine.meta.view).toBe('MY_OPEN');
    expect(mine.data.map((x) => x.subject)).toEqual(['overdue', 'soon', 'later', 'undated']);
    expect(mine.data[0].isOverdue).toBe(true);
    expect(mine.data[1].isOverdue).toBe(false);

    // Cursor pages never repeat or skip an item, whatever the page size.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const params: URLSearchParams = new URLSearchParams({ limit: '2', view: 'ALL' });
      if (cursor) params.set('cursor', cursor);
      const page = t.app.activities.list(t.user, t.workspace.id, params);
      seen.push(...page.data.map((x) => x.id));
      cursor = page.meta.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(6);
    expect([later.id, soon.id, overdue.id, undated.id, done.id].every((id) => seen.includes(id))).toBe(true);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.list(t.user, t.workspace.id, new URLSearchParams({ cursor: 'garbage' }))), 'CRM_CURSOR_INVALID', 400);
  });

  it('filters by allow-listed fields only', async () => {
    const t = await fullApp();
    const high = await followUp(t, { priority: 'HIGH', subject: 'Renewal call', deadline: iso(-HOUR) });
    await call(t, { subject: 'Quote', priority: 'LOW', deadline: iso(3 * DAY) });
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Filter lead' });
    const bound = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    const q = (params: Record<string, string>) => t.app.activities.list(t.user, t.workspace.id, new URLSearchParams({ view: 'ALL', ...params })).data.map((x) => x.id);
    expect(q({ priority: 'HIGH' })).toEqual([high.id]);
    expect(q({ typeCode: 'CALL' })).toHaveLength(1);
    expect(q({ overdue: 'true' })).toEqual([high.id]);
    expect(q({ search: 'renewal' })).toEqual([high.id]);
    expect(q({ bindingEntityType: 'LEAD', bindingEntityId: lead.id })).toEqual([bound.id]);
    expect(q({ deadlineFrom: iso(DAY), deadlineTo: iso(5 * DAY) })).toHaveLength(1);
    expect(q({ responsibleUserId: t.user.id })).toHaveLength(3);
    expect(q({ status: 'COMPLETED' })).toEqual([]);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.list(t.user, t.workspace.id, new URLSearchParams({ status: 'BOGUS' }))), 'CRM_QUERY_INVALID', 400);
    const noDelete = await addMember(t.app, t.user, t.workspace.id, 'nodelete', ACTIVITY_BASIC);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.list(noDelete.user, t.workspace.id, new URLSearchParams({ includeDeleted: 'true' }))), 'PERMISSION_DENIED', 403);
  });

  it('marks stale realtime/outbox: emits events with a stable envelope and only after actual changes', async () => {
    const t = await fullApp();
    const a = await call(t, { idempotencyKey: 'env-1' });
    const created = events(t, 'ACTIVITY_CREATED', a.id)[0];
    expect(created).toMatchObject({ workspaceId: t.workspace.id, entityType: 'ACTIVITY', entityId: a.id, actorUserId: t.user.id, eventVersion: 1, idempotencyKey: 'env-1' });
    const envelope = (await import('@/src/server/events')).toEventEnvelope(created);
    expect(envelope).toMatchObject({ eventType: 'ACTIVITY_CREATED', aggregateType: 'ACTIVITY', aggregateId: a.id, actor: { type: 'USER', userId: t.user.id } });
    expect(Object.keys(envelope.changes)).not.toContain('description'); // compact summary, never the whole record
    const noChange = stored(t, a.id).version;
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: noChange, subject: a.subject });
    expect(stored(t, a.id).version).toBe(noChange);
    expect(events(t, 'ACTIVITY_UPDATED', a.id)).toHaveLength(0);
  });
});
