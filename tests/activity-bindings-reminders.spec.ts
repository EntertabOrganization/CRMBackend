import { ACTIVITY_BASIC, addMember, DAY, expectAppError, fullApp, HOUR, iso } from './support/domain';

type App = Awaited<ReturnType<typeof fullApp>>;

const followUp = (t: App, extra: Record<string, unknown> = {}, user = t.user) =>
  t.app.activities.create(user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Check in', ...extra });
const stored = (t: App, id: string) => t.app.store.state.crmActivities.find((item) => item.id === id)!;
const events = (t: App, type: string, activityId?: string) =>
  t.app.store.state.outboxEvents.filter((event) => event.eventType === type && (!activityId || event.entityId === activityId));

function crmRecords(t: App) {
  const deal = t.app.crm.createDeal(t.user, t.workspace.id, { title: 'Big Deal', companyId: null, contactIds: [] as string[] } as never).id;
  return deal;
}

async function records(t: App) {
  const company = t.app.crmCore.createCompany(t.user, t.workspace.id, { name: 'Acme' });
  const contact = t.app.crmCore.createContact(t.user, t.workspace.id, { firstName: 'Nadine', lastName: 'Saleh' });
  const deal = t.app.crm.createDeal(t.user, t.workspace.id, { title: 'Big Deal', companyId: company.id });
  const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Hot lead' });
  return { company, contact, deal, lead };
}

describe('Activities - bindings, communications, reminders and overdue', () => {
  it('binds one Activity to multiple same-workspace CRM records', async () => {
    const t = await fullApp();
    const { company, contact, deal } = await records(t);
    const a = await followUp(t, {
      bindings: [
        { entityType: 'DEAL', entityId: deal.id },
        { entityType: 'CONTACT', entityId: contact.id },
        { entityType: 'COMPANY', entityId: company.id },
        { entityType: 'DEAL', entityId: deal.id }, // duplicate is ignored
      ],
    });
    expect(a.bindings.map((binding) => [binding.entityType, binding.displayName])).toEqual([
      ['DEAL', 'Big Deal'],
      ['CONTACT', 'Nadine Saleh'],
      ['COMPANY', 'Acme'],
    ]);
    expect(a.bindings[0].isPrimary).toBe(true);
    // Unique per (activity, entity): a second explicit add conflicts.
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.addBinding(t.user, t.workspace.id, a.id, { entityType: 'DEAL', entityId: deal.id })), 'ACTIVITY_BINDING_EXISTS', 409);
    // Unsupported entity types are refused like unreadable ones.
    await expectAppError(() => followUp(t, { bindings: [{ entityType: 'INVOICE', entityId: deal.id }] }), 'ACTIVITY_BINDING_FORBIDDEN', 403);
    void crmRecords;
  });

  it('redacts bindings the reader cannot access while preserving visible Activity context', async () => {
    const t = await fullApp();
    const { company, contact, deal } = await records(t);
    const dealOnly = await addMember(t.app, t.user, t.workspace.id, 'dealer', [['activity.read', 'WORKSPACE'], ['crm.deal.read', 'WORKSPACE']]);
    const contactOnly = await addMember(t.app, t.user, t.workspace.id, 'contacter', [['activity.read', 'WORKSPACE'], ['crm.contact.read', 'WORKSPACE']]);
    const noCrm = await addMember(t.app, t.user, t.workspace.id, 'nocrm', [['activity.read', 'WORKSPACE']]);
    const a = await followUp(t, {
      bindings: [
        { entityType: 'DEAL', entityId: deal.id },
        { entityType: 'CONTACT', entityId: contact.id },
        { entityType: 'COMPANY', entityId: company.id },
      ],
      communications: [],
    });

    const asDealer = t.app.activities.getById(dealOnly.user, t.workspace.id, a.id);
    expect(asDealer.bindings.map((binding) => binding.entityType)).toEqual(['DEAL']);
    const asContacter = t.app.activities.getById(contactOnly.user, t.workspace.id, a.id);
    expect(asContacter.bindings.map((binding) => binding.entityType)).toEqual(['CONTACT']);
    // The redacted payload reveals nothing about the hidden records: no ids, names or counts.
    const serialized = JSON.stringify(asDealer);
    for (const secret of [contact.id, company.id, 'Acme', 'Nadine']) expect(serialized).not.toContain(secret);
    // No authorized binding and not responsible => the Activity does not exist for that user.
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.getById(noCrm.user, t.workspace.id, a.id)), 'ACTIVITY_NOT_FOUND', 404);
    expect(t.app.activities.list(noCrm.user, t.workspace.id, new URLSearchParams({ view: 'ALL' })).data).toEqual([]);
    // Filtering by a hidden binding cannot be used to probe for it.
    expect(t.app.activities.list(dealOnly.user, t.workspace.id, new URLSearchParams({ view: 'ALL', bindingEntityId: contact.id })).data).toEqual([]);
    expect(t.app.activities.list(dealOnly.user, t.workspace.id, new URLSearchParams({ view: 'ALL', bindingEntityId: deal.id })).data.map((x) => x.id)).toEqual([a.id]);

    // The responsible user keeps their own Activity even without CRM access (all bindings redacted).
    const mine = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Assigned', responsibleUserId: noCrm.user.id, bindings: [{ entityType: 'COMPANY', entityId: company.id }] });
    const seen = t.app.activities.getById(noCrm.user, t.workspace.id, mine.id);
    expect(seen.bindings).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(company.id);
  });

  it('separately authorizes adding/removing a target CRM binding', async () => {
    const t = await fullApp();
    const { company, deal } = await records(t);
    const editor = await addMember(t.app, t.user, t.workspace.id, 'editor', [...ACTIVITY_BASIC, ['crm.deal.read', 'WORKSPACE']]);
    const a = await followUp(t, { bindings: [{ entityType: 'DEAL', entityId: deal.id }, { entityType: 'COMPANY', entityId: company.id }] });
    // activity.update is not enough to attach a restricted Company...
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.addBinding(editor.user, t.workspace.id, a.id, { entityType: 'COMPANY', entityId: company.id })), 'ACTIVITY_BINDING_FORBIDDEN', 403);
    // ...nor to remove a binding they cannot even see.
    const companyBinding = t.app.store.state.crmActivityBindings.find((item) => item.entityType === 'COMPANY')!;
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.removeBinding(editor.user, t.workspace.id, a.id, companyBinding.id)), 'ACTIVITY_BINDING_NOT_FOUND', 404);
    expect(t.app.store.state.crmActivityBindings.some((item) => item.id === companyBinding.id)).toBe(true);
    // A visible binding can be removed; editing does not require access to every OTHER (redacted) binding.
    const dealBinding = t.app.store.state.crmActivityBindings.find((item) => item.entityType === 'DEAL')!;
    expect(t.app.activities.removeBinding(editor.user, t.workspace.id, a.id, dealBinding.id)).toEqual({ id: dealBinding.id, removed: true });
    const edited = await t.app.activities.update(editor.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, subject: 'Edited by editor' }).catch((error) => error);
    // After the removal the editor sees no binding at all, so the Activity is no longer visible to them.
    expect(edited.code).toBe('ACTIVITY_NOT_FOUND');
    expect(events(t, 'ACTIVITY_BINDING_CHANGED', a.id)).toHaveLength(1);
    expect(t.app.store.state.auditLogs.some((log) => log.action === 'ACTIVITY.BINDING_REMOVED')).toBe(true);
  });

  it('stores internal participants separately from customer communications', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', ACTIVITY_BASIC);
    const a = await t.app.activities.create(t.user, t.workspace.id, {
      typeCode: 'CALL',
      subject: 'Intro call',
      participants: [mate.user.id, t.user.id, mate.user.id],
      communications: [{ type: 'PHONE', value: '+1 (202) 555-0123' }],
    });
    // The responsible user is never duplicated as a participant; participants are users, communications are values.
    expect(a.participants).toEqual([{ userId: mate.user.id, role: 'PARTICIPANT' }]);
    expect(a.communications).toEqual([expect.objectContaining({ type: 'PHONE', value: '+12025550123', displayValue: '+1 (202) 555-0123' })]);
    expect(t.app.store.state.crmActivityParticipants).toHaveLength(1);
    expect(t.app.store.state.crmActivityCommunications).toHaveLength(1);
    // Participation grants no CRM access by itself.
    const { deal } = await records(t);
    const bound = await followUp(t, { participants: [mate.user.id], bindings: [{ entityType: 'DEAL', entityId: deal.id }] });
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.getById(mate.user, t.workspace.id, bound.id)), 'ACTIVITY_NOT_FOUND', 404);
    // Types without the concept refuse it.
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'x', communications: [{ type: 'EMAIL', value: 'a@b.com' }] }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'CALL', subject: 'x', communications: [{ type: 'EMAIL', value: 'not-an-email' }] }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'CALL', subject: 'x', communications: [{ type: 'FAX', value: '1' }] }), 'FIELD_VALIDATION_FAILED');
  });

  it('preserves the CRM reference and normalized phone/email value used historically', async () => {
    const t = await fullApp();
    const contact = t.app.crmCore.createContact(t.user, t.workspace.id, { firstName: 'Nadine', lastName: 'Saleh', communications: [{ type: 'PHONE', value: '+12025550123', isPrimary: true }] });
    const a = await t.app.activities.create(t.user, t.workspace.id, {
      typeCode: 'CALL',
      subject: 'Call Nadine',
      bindings: [{ entityType: 'CONTACT', entityId: contact.id }],
      communications: [
        { type: 'PHONE', crmEntityType: 'CONTACT', crmEntityId: contact.id, value: '+1 (202) 555-0123' },
        { type: 'EMAIL', crmEntityType: 'CONTACT', crmEntityId: contact.id, value: ' Nadine@Example.COM ' },
      ],
    });
    // The contact later gets a new primary phone: the historical snapshot is not rewritten.
    t.app.crmCore.addContactCommunication(t.user, t.workspace.id, contact.id, { type: 'PHONE', value: '+442079460000', isPrimary: true });
    const reloaded = t.app.activities.getById(t.user, t.workspace.id, a.id);
    expect(reloaded.communications.map((item) => [item.type, item.value, item.crmEntityId])).toEqual([
      ['PHONE', '+12025550123', contact.id],
      ['EMAIL', 'nadine@example.com', contact.id],
    ]);
    // A reader who cannot see the contact keeps the value used at the time but loses the reference.
    const noContact = await addMember(t.app, t.user, t.workspace.id, 'nocontact', [['activity.read', 'WORKSPACE'], ['crm.lead.read', 'WORKSPACE']]);
    const own = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'CALL', subject: 'Own', responsibleUserId: noContact.user.id, communications: [{ type: 'PHONE', crmEntityType: 'CONTACT', crmEntityId: contact.id, value: '+12025550123' }] });
    expect(t.app.activities.getById(noContact.user, t.workspace.id, own.id).communications[0]).toMatchObject({ value: '+12025550123', crmEntityId: null, crmEntityType: null });
  });

  it('supports multiple absolute/relative reminders with selected eligible recipients', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', ACTIVITY_BASIC);
    const outsider = await addMember(t.app, t.user, t.workspace.id, 'outsider', ACTIVITY_BASIC);
    const start = iso(3 * DAY);
    const deadline = iso(4 * DAY);
    const a = await t.app.activities.create(t.user, t.workspace.id, {
      typeCode: 'CALL',
      subject: 'Reminded call',
      startAt: start,
      deadline,
      participants: [mate.user.id],
      reminders: [
        { mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -3600, recipientUserIds: [t.user.id, mate.user.id] },
        { mode: 'RELATIVE', relativeTo: 'DEADLINE', offsetSeconds: -86400 },
        { mode: 'ABSOLUTE', absoluteAt: iso(2 * DAY), recipientUserIds: [mate.user.id] },
      ],
    });
    expect(a.reminders).toHaveLength(3);
    const byMode = a.reminders.map((reminder) => [reminder.mode, reminder.relativeTo, new Date(reminder.scheduledFor!).toISOString(), [...reminder.recipientUserIds].sort()]);
    expect(byMode[0]).toEqual(['RELATIVE', 'START', new Date(new Date(start).getTime() - 3600_000).toISOString(), [t.user.id, mate.user.id].sort()]);
    expect(byMode[1]).toEqual(['RELATIVE', 'DEADLINE', new Date(new Date(deadline).getTime() - DAY).toISOString(), [t.user.id]]); // defaults to the responsible user
    expect(byMode[2][3]).toEqual([mate.user.id]);
    expect(new Set(t.app.store.state.crmActivityReminders.map((r) => r.occurrenceKey)).size).toBe(3);

    const bad = (reminder: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'CALL', subject: 'x', startAt: start, participants: [mate.user.id], reminders: [reminder], ...extra }), 'ACTIVITY_REMINDER_INVALID', 400);
    await bad({ mode: 'ABSOLUTE', absoluteAt: iso(-HOUR) }); // already in the past
    await bad({ mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -10 * DAY / 1000 * 1000 }); // resolves to the past
    await bad({ mode: 'RELATIVE', relativeTo: 'DEADLINE', offsetSeconds: -3600 }); // no deadline to anchor on
    await bad({ mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -3600, recipientUserIds: [outsider.user.id] }); // not responsible/participant
    await bad({ mode: 'DAILY' });
    await bad({ mode: 'RELATIVE', relativeTo: 'NOON', offsetSeconds: -60 });
  });

  it('manages reminders through dedicated operations and preserves audit history', async () => {
    const t = await fullApp();
    const a = await followUp(t, { startAt: iso(3 * DAY) });
    const created = t.app.activities.createReminder(t.user, t.workspace.id, a.id, { mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -900 }) as any;
    expect(t.app.activities.listReminders(t.user, t.workspace.id, a.id)).toHaveLength(1);
    const updated = t.app.activities.updateReminder(t.user, t.workspace.id, a.id, created.id, { mode: 'ABSOLUTE', absoluteAt: iso(DAY) }) as any;
    expect(updated.mode).toBe('ABSOLUTE');
    expect(t.app.activities.deleteReminder(t.user, t.workspace.id, a.id, created.id)).toEqual({ id: created.id, removed: true });
    expect(t.app.activities.listReminders(t.user, t.workspace.id, a.id)).toEqual([]);
    expect(t.app.store.state.auditLogs.map((log) => log.action)).toEqual(expect.arrayContaining(['ACTIVITY.REMINDER_ADDED', 'ACTIVITY.REMINDER_UPDATED', 'ACTIVITY.REMINDER_REMOVED']));
    await expectAppError(() => Promise.resolve().then(() => t.app.activities.deleteReminder(t.user, t.workspace.id, a.id, created.id)), 'ACTIVITY_REMINDER_NOT_FOUND', 404);
  });

  it('does not duplicate a reminder when the worker retries', async () => {
    const t = await fullApp();
    const a = await followUp(t, { startAt: iso(3 * DAY), reminders: [{ mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -3600 }] });
    const fireAt = new Date(new Date(a.startAt!).getTime() - 1800_000);
    expect(t.app.activities.runDueReminders(new Date(Date.now() + HOUR)).emitted).toBe(0); // not due yet
    const first = t.app.activities.runDueReminders(fireAt);
    expect(first.emitted).toBe(1);
    // A retried / concurrently duplicated worker run produces nothing more.
    expect(t.app.activities.runDueReminders(fireAt).emitted).toBe(0);
    expect(t.app.activities.runDueReminders(new Date(fireAt.getTime() + DAY)).emitted).toBe(0);
    const due = events(t, 'ACTIVITY_REMINDER_DUE', a.id);
    expect(due).toHaveLength(1);
    expect(due[0].payload).toMatchObject({ recipientUserIds: [t.user.id] });
    expect(due[0].idempotencyKey).toBe(t.app.store.state.crmActivityReminders[0].occurrenceKey);
    expect(t.app.store.state.crmActivityReminders[0]).toMatchObject({ status: 'SENT' });
    // A sent reminder is never resurrected by reopen.
    await t.app.activities.complete(t.user, t.workspace.id, a.id);
    await t.app.activities.reopen(t.user, t.workspace.id, a.id);
    expect(t.app.store.state.crmActivityReminders[0].status).toBe('SENT');
    expect(t.app.activities.runDueReminders(new Date(fireAt.getTime() + DAY)).emitted).toBe(0);
  });

  it('cancels pending reminders when an Activity completes or is deleted, and restores future ones on reopen', async () => {
    const t = await fullApp();
    const a = await followUp(t, { startAt: iso(3 * DAY), reminders: [{ mode: 'ABSOLUTE', absoluteAt: iso(2 * DAY) }] });
    await t.app.activities.complete(t.user, t.workspace.id, a.id);
    expect(t.app.store.state.crmActivityReminders[0].status).toBe('CANCELLED');
    expect(t.app.activities.runDueReminders(new Date(Date.now() + 10 * DAY)).emitted).toBe(0);
    await t.app.activities.reopen(t.user, t.workspace.id, a.id);
    expect(t.app.store.state.crmActivityReminders[0].status).toBe('SCHEDULED');
    // A worker that races a completion still never notifies for a finished activity.
    await t.app.activities.cancel(t.user, t.workspace.id, a.id);
    t.app.store.state.crmActivityReminders[0].status = 'SCHEDULED';
    expect(t.app.activities.runDueReminders(new Date(Date.now() + 10 * DAY)).emitted).toBe(0);
    expect(t.app.store.state.crmActivityReminders[0].status).toBe('CANCELLED');
  });

  it('recomputes relative reminders when the activity time changes and cancels ones that would fire in the past', async () => {
    const t = await fullApp();
    const a = await followUp(t, { startAt: iso(3 * DAY), reminders: [{ mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -3600 }] });
    const newStart = iso(6 * DAY);
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: a.version, startAt: newStart });
    const reminder = t.app.store.state.crmActivityReminders[0];
    expect(reminder.scheduledFor!.toISOString()).toBe(new Date(new Date(newStart).getTime() - 3600_000).toISOString());
    expect(reminder.status).toBe('SCHEDULED');
    expect(reminder.occurrenceKey).toContain(reminder.scheduledFor!.toISOString());
    // Moving the start so close that the reminder time is already past does not fire a surprise notification.
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, startAt: iso(10 * 60_000) });
    expect(t.app.store.state.crmActivityReminders[0].status).toBe('CANCELLED');
    expect(t.app.activities.runDueReminders(new Date(Date.now() + DAY)).emitted).toBe(0);
  });

  it('derives overdue without persisting OVERDUE as lifecycle status', async () => {
    const t = await fullApp();
    const late = await followUp(t, { deadline: iso(-2 * HOUR) });
    const fine = await followUp(t, { deadline: iso(2 * HOUR) });
    const meeting = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'MEETING', subject: 'Old meeting', startAt: iso(-3 * HOUR), endAt: iso(-2 * HOUR) });
    expect(late.isOverdue).toBe(true);
    expect(fine.isOverdue).toBe(false);
    expect(meeting.isOverdue).toBe(true); // meetings use their scheduled end as the deadline basis
    expect(stored(t, late.id).status).toBe('PLANNED');
    expect(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).toContain(stored(t, late.id).status);
    const done = await t.app.activities.complete(t.user, t.workspace.id, late.id);
    expect(done.isOverdue).toBe(false);
    const deleted = await followUp(t, { deadline: iso(-HOUR) });
    await t.app.activities.softDelete(t.user, t.workspace.id, deleted.id);
    expect(t.app.activities.getById(t.user, t.workspace.id, deleted.id, true).isOverdue).toBe(false);
  });

  it('emits ACTIVITY_OVERDUE exactly once per deadline occurrence and again after a legitimate reschedule', async () => {
    const t = await fullApp();
    const a = await followUp(t, { deadline: iso(-HOUR) });
    const skipped = await followUp(t, { deadline: iso(-HOUR) });
    await t.app.activities.complete(t.user, t.workspace.id, skipped.id);
    expect(t.app.activities.runOverdueSweep().emitted).toBe(1);
    // Worker retries and duplicate schedulers do not re-emit for the same deadline occurrence.
    expect(t.app.activities.runOverdueSweep().emitted).toBe(0);
    expect(t.app.activities.runOverdueSweep(new Date(Date.now() + DAY)).emitted).toBe(0);
    expect(events(t, 'ACTIVITY_OVERDUE', a.id)).toHaveLength(1);
    expect(events(t, 'ACTIVITY_OVERDUE', skipped.id)).toHaveLength(0);
    expect(t.app.store.state.crmActivityOverdueOccurrences).toHaveLength(1);

    // The deadline moves into the future and later passes again: a new, legitimate occurrence.
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, deadline: iso(2 * DAY) });
    expect(stored(t, a.id).deadlineVersion).toBe(2);
    expect(t.app.activities.runOverdueSweep().emitted).toBe(0); // not overdue yet
    expect(t.app.activities.runOverdueSweep(new Date(Date.now() + 3 * DAY)).emitted).toBe(1);
    expect(t.app.activities.runOverdueSweep(new Date(Date.now() + 4 * DAY)).emitted).toBe(0);
    expect(events(t, 'ACTIVITY_OVERDUE', a.id)).toHaveLength(2);
    expect(events(t, 'ACTIVITY_OVERDUE', a.id)[1].payload).toMatchObject({ deadlineVersion: 2 });
    // Non-deadline edits do not create new occurrences.
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, subject: 'Renamed' });
    expect(stored(t, a.id).deadlineVersion).toBe(2);
  });

  it('raises assignment, reassignment, cancellation and completion events for notification consumers', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', ACTIVITY_BASIC);
    const a = await followUp(t, { responsibleUserId: mate.user.id });
    expect(events(t, 'ACTIVITY_REASSIGNED', a.id)[0].payload).toMatchObject({ initialAssignment: true, to: mate.user.id });
    await t.app.activities.reassign(t.user, t.workspace.id, a.id, { responsibleUserId: t.user.id });
    expect(events(t, 'ACTIVITY_REASSIGNED', a.id)[1].payload).toMatchObject({ from: mate.user.id, to: t.user.id });
    expect(t.app.store.state.auditLogs.some((log) => log.action === 'ACTIVITY.REASSIGNED')).toBe(true);
    await t.app.activities.cancel(t.user, t.workspace.id, a.id);
    expect(events(t, 'ACTIVITY_CANCELLED', a.id)).toHaveLength(1);
    // Reassigning to the current responsible user is a no-op (safe bulk retries).
    const before = stored(t, a.id).version;
    await t.app.activities.reassign(t.user, t.workspace.id, a.id, { responsibleUserId: t.user.id });
    expect(stored(t, a.id).version).toBe(before);
  });
});
