import { FakeCalendarPort, FakeTaskPort } from '@/src/server/activities/adapters';
import { AdapterUnavailableError } from '@/src/server/ports';
import { addMember, ACTIVITY_BASIC, DAY, expectAppError, fullApp, HOUR, iso, project } from './support/domain';

type App = Awaited<ReturnType<typeof fullApp>>;

const stored = (t: App, id: string) => t.app.store.state.crmActivities.find((item) => item.id === id)!;
const events = (t: App, type: string, activityId?: string) =>
  t.app.store.state.outboxEvents.filter((event) => event.eventType === type && (!activityId || event.entityId === activityId));
const meeting = (t: App, extra: Record<string, unknown> = {}) =>
  t.app.activities.create(t.user, t.workspace.id, { typeCode: 'MEETING', subject: 'Kickoff', startAt: iso(DAY), endAt: iso(DAY + HOUR), location: 'HQ', ...extra });
const task = (t: App, extra: Record<string, unknown> = {}) =>
  t.app.activities.create(t.user, t.workspace.id, { typeCode: 'TASK', subject: 'Prepare contract', deadline: iso(2 * DAY), ...extra });

describe('Activity specialist adapters', () => {
  it('delegates Meeting scheduling to the Calendar adapter and mirrors the confirmed outcome', async () => {
    const t = await fullApp();
    const calendar = new FakeCalendarPort();
    t.app.adapters.registerCalendar(calendar);
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', ACTIVITY_BASIC);
    const created = await meeting(t, { participants: [mate.user.id], idempotencyKey: 'meet-1' });
    expect(created).toMatchObject({ adapterKind: 'CALENDAR', adapterResourceId: 'cal-1' });
    expect(calendar.calls).toEqual([{ op: 'create', eventId: 'cal-1', key: 'meet-1:calendar:create' }]);

    // Rescheduling goes through Calendar first; the Activity reflects what Calendar confirmed.
    const newStart = iso(3 * DAY);
    const updated = await t.app.activities.update(t.user, t.workspace.id, created.id, { expectedVersion: created.version, startAt: newStart, endAt: iso(3 * DAY + HOUR) });
    expect(calendar.calls.map((call) => call.op)).toEqual(['create', 'update']);
    expect(new Date(updated.startAt!).toISOString()).toBe(newStart);
    expect(events(t, 'ACTIVITY_UPDATED', created.id)[0].payload).toMatchObject({ rescheduled: true });

    await t.app.activities.complete(t.user, t.workspace.id, created.id, { resultText: 'Held' });
    expect(calendar.calls.map((call) => call.op)).toEqual(['create', 'update', 'complete']);
    const cancelled = await meeting(t);
    await t.app.activities.cancel(t.user, t.workspace.id, cancelled.id);
    expect(calendar.calls.at(-1)).toMatchObject({ op: 'cancel', eventId: 'cal-2' });
    // Recurrence is Calendar's: the Activity has no recurrence fields at all.
    expect(Object.keys(stored(t, created.id))).not.toEqual(expect.arrayContaining(['recurrence', 'rrule']));
  });

  it('does not create or change anything when Calendar rejects or is unavailable', async () => {
    const t = await fullApp();
    const calendar = new FakeCalendarPort();
    t.app.adapters.registerCalendar(calendar);
    calendar.failNext = new AdapterUnavailableError('down');
    await expectAppError(() => meeting(t), 'ACTIVITY_ADAPTER_UNAVAILABLE', 503);
    expect(t.app.store.state.crmActivities).toHaveLength(0);
    expect(events(t, 'ACTIVITY_CREATED')).toHaveLength(0);
    calendar.failNext = new Error('slot conflict with attendee');
    await expectAppError(() => meeting(t), 'ACTIVITY_ADAPTER_CONFLICT', 409);
    // The provider message never leaks to the client.
    const error = await expectAppError(async () => {
      calendar.failNext = new Error('secret provider detail');
      await meeting(t);
    }, 'ACTIVITY_ADAPTER_CONFLICT', 409);
    expect(error.message).not.toContain('secret');
    expect(t.app.store.state.auditLogs.some((log) => log.action === 'ACTIVITY.ADAPTER_SYNC_FAILED')).toBe(true);

    const ok = await meeting(t);
    calendar.failNext = new AdapterUnavailableError('down');
    const before = { version: stored(t, ok.id).version, startAt: stored(t, ok.id).startAt };
    await expectAppError(() => t.app.activities.update(t.user, t.workspace.id, ok.id, { expectedVersion: before.version, startAt: iso(5 * DAY), endAt: iso(5 * DAY + HOUR) }), 'ACTIVITY_ADAPTER_UNAVAILABLE', 503);
    expect(stored(t, ok.id)).toMatchObject(before); // a timeout never produces a half-updated Activity
    calendar.failNext = new Error('nope');
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, ok.id), 'ACTIVITY_ADAPTER_CONFLICT', 409);
    expect(stored(t, ok.id).status).toBe('PLANNED');
  });

  it('delegates Task completion to the Tasks adapter and never completes locally when Tasks refuses', async () => {
    const t = await fullApp();
    const tasks = new FakeTaskPort();
    t.app.adapters.registerTasks(tasks);
    const created = await task(t, { idempotencyKey: 'task-1' });
    expect(created.adapterResourceId).toBe('task-1');
    tasks.failNext = new Error('checklist incomplete');
    await expectAppError(() => t.app.activities.complete(t.user, t.workspace.id, created.id, { idempotencyKey: 'done-1' }), 'ACTIVITY_ADAPTER_CONFLICT', 409);
    expect(stored(t, created.id).status).toBe('PLANNED');
    expect(events(t, 'ACTIVITY_COMPLETED', created.id)).toHaveLength(0);
    // The failed attempt did not consume the idempotency key: the retry succeeds and completes exactly once.
    const done = await t.app.activities.complete(t.user, t.workspace.id, created.id, { idempotencyKey: 'done-1' });
    expect(done.status).toBe('COMPLETED');
    await t.app.activities.complete(t.user, t.workspace.id, created.id, { idempotencyKey: 'done-1' });
    expect(tasks.calls.filter((call) => call.op === 'complete')).toHaveLength(1);
    expect(events(t, 'ACTIVITY_COMPLETED', created.id)).toHaveLength(1);
    await t.app.activities.reopen(t.user, t.workspace.id, created.id);
    expect(tasks.calls.map((call) => call.op)).toEqual(['create', 'complete', 'reopen']);
    await t.app.activities.update(t.user, t.workspace.id, created.id, { expectedVersion: stored(t, created.id).version, subject: 'Prepare final contract' });
    expect(tasks.calls.at(-1)?.op).toBe('update');
    await t.app.activities.cancel(t.user, t.workspace.id, created.id);
    expect(tasks.calls.at(-1)?.op).toBe('cancel');
  });

  it('keeps generic Activities working when a specialist module is not registered (no duplicate specialist behaviour)', async () => {
    const t = await fullApp();
    const m = await meeting(t);
    const tk = await task(t);
    expect(m.adapterKind).toBeNull();
    expect(tk.adapterResourceId).toBeNull();
    expect((await t.app.activities.complete(t.user, t.workspace.id, tk.id)).status).toBe('COMPLETED');
    // No recurrence/checklist/dependency concepts are invented on the CRM side.
    expect(Object.keys(t.app.store.state.crmActivities[0])).not.toEqual(expect.arrayContaining(['recurrence', 'checklist', 'dependencies']));
    expect(t.app.adapters.has('CALENDAR')).toBe(false);
  });

  it('deduplicates repeated provider communication events into one logical Activity representation', async () => {
    const t = await fullApp();
    const contact = t.app.crmCore.createContact(t.user, t.workspace.id, { firstName: 'Nadine', lastName: 'Saleh' });
    const deal = t.app.crm.createDeal(t.user, t.workspace.id, { title: 'Deal', contactIds: [contact.id] });
    const input = {
      origin: 'voip-provider',
      externalId: 'call-123',
      typeCode: 'CALL' as const,
      direction: 'INCOMING' as const,
      subject: 'Inbound call',
      occurredAt: new Date(Date.now() - HOUR),
      responsibleUserId: t.user.id,
      resultText: 'Asked for pricing',
      bindings: [{ entityType: 'CONTACT', entityId: contact.id }, { entityType: 'DEAL', entityId: deal.id }],
      communications: [{ type: 'PHONE' as const, value: '+1 202 555 0100', crmEntityType: 'CONTACT', crmEntityId: contact.id }],
    };
    const first = t.app.activities.ingestProviderCommunication(t.workspace.id, input);
    const second = t.app.activities.ingestProviderCommunication(t.workspace.id, input);
    const third = t.app.activities.ingestProviderCommunication(t.workspace.id, { ...input, resultText: 'Asked for pricing' });
    expect(first.created).toBe(true);
    expect([second.created, third.created]).toEqual([false, false]);
    expect(second.activityId).toBe(first.activityId);
    expect(t.app.store.state.crmActivities).toHaveLength(1);
    expect(stored(t, first.activityId)).toMatchObject({ status: 'COMPLETED', adapterKind: 'COMMUNICATION', externalOrigin: 'voip-provider', externalId: 'call-123', createdByUserId: null });
    expect(t.app.store.state.crmActivityCommunications[0].normalizedValue).toBe('+12025550100');
    expect(events(t, 'ACTIVITY_CREATED')).toHaveLength(1);

    // The Timeline gets exactly one COMMUNICATION entry per bound record even after redelivery.
    project(t.app);
    const entries = t.app.store.state.crmTimelineEntries.filter((entry) => entry.sourceId === first.activityId);
    expect(entries.map((entry) => [entry.entityType, entry.category, entry.actorType]).sort()).toEqual([['CONTACT', 'COMMUNICATION', 'PROVIDER'], ['DEAL', 'COMMUNICATION', 'PROVIDER']]);
    // A different external id is a different interaction.
    expect(t.app.activities.ingestProviderCommunication(t.workspace.id, { ...input, externalId: 'call-124' }).created).toBe(true);
    // The same external id from another provider is also a different interaction.
    expect(t.app.activities.ingestProviderCommunication(t.workspace.id, { ...input, origin: 'other-provider' }).created).toBe(true);
    // A genuine provider-side change (e.g. call notes arrive later) updates the representation without a new Activity.
    const updated = t.app.activities.ingestProviderCommunication(t.workspace.id, { ...input, resultText: 'Asked for pricing and a demo' });
    expect(updated).toEqual({ activityId: first.activityId, created: false });
    expect(stored(t, first.activityId).resultText).toBe('Asked for pricing and a demo');
  });

  it('refuses provider events that point outside the workspace', async () => {
    const t = await fullApp();
    const other = await (await import('./support/domain')).otherTenant(t.app);
    const foreignLead = t.app.crm.createLead(other.user, other.workspace.id, { title: 'Foreign' });
    const base = { origin: 'p', externalId: 'e1', typeCode: 'EMAIL' as const, direction: 'INCOMING' as const, subject: 's', occurredAt: new Date(), responsibleUserId: t.user.id };
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.ingestProviderCommunication(t.workspace.id, { ...base, bindings: [{ entityType: 'LEAD', entityId: foreignLead.id }] })), 'ACTIVITY_BINDING_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.ingestProviderCommunication(t.workspace.id, { ...base, responsibleUserId: other.user.id })), 'ACTIVITY_ASSIGN_FORBIDDEN', 403);
    expect(t.app.store.state.crmActivities).toHaveLength(0);
  });

  it('references documents through the Files port instead of copying them', async () => {
    const t = await fullApp();
    t.files.register(t.workspace.id, '44444444-4444-4444-8444-444444444444');
    const doc = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'DOCUMENT', subject: 'Contract v1', fileIds: ['44444444-4444-4444-8444-444444444444'] });
    expect(doc.fileIds).toEqual(['44444444-4444-4444-8444-444444444444']);
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'DOCUMENT', subject: 'x', fileIds: ['55555555-5555-4555-8555-555555555555'] }), 'FIELD_REFERENCE_INVALID', 400);
    const other = await (await import('./support/domain')).otherTenant(t.app);
    t.files.register(other.workspace.id, '66666666-6666-4666-8666-666666666666');
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'DOCUMENT', subject: 'x', fileIds: ['66666666-6666-4666-8666-666666666666'] }), 'FIELD_REFERENCE_INVALID', 400);
    t.files.register(t.workspace.id, '77777777-7777-4777-8777-777777777777', [t.user.id]); // exists but this actor may not use it
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'DOCUMENT', subject: 'x', fileIds: ['77777777-7777-4777-8777-777777777777'] }), 'FIELD_REFERENCE_INVALID', 400);
    // Activity tables hold references only.
    expect(JSON.stringify(t.app.store.state.crmActivities)).not.toMatch(/base64|blob|bytes/i);
  });
});
