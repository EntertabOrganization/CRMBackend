import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { InMemoryFilePort } from '@/src/server/ports';
import { b, collabApp, perms } from '../support/domain';

const permissions = perms('OWN', 'event.create', 'event.read', 'event.update', 'event.cancel', 'event.delete_admin',
  'event.attendee_manage', 'event.meeting_record_manage', 'calendar.read', 'task.read', 'project.read');
async function setup() {
  const ctx = await collabApp();
  const calendar = ctx.collab.calendar.calendars.create(ctx.owner, b({ type: 'PERSONAL', name: 'Private', timezone: 'UTC' }));
  const events = ctx.collab.calendar.events;
  const create = (extra: Record<string, unknown> = {}) => events.create(ctx.owner, b({
    calendarId: calendar.id, title: 'Meeting', startAt: '2030-03-31T01:00:00+01:00', endAt: '2030-03-31T03:00:00+02:00', sourceTimezone: 'Europe/Berlin', ...extra,
  }));
  return { ...ctx, get state() { return ctx.state; }, calendar, events, create };
}
describe('Events & Meetings contract', () => {
  it('All-day vs timed validation preserves date semantics and validates impossible dates and mixed fields', async () => {
    const c = await setup(), timed = c.create();
    expect(timed.startAt!.toISOString()).toBe('2030-03-31T00:00:00.000Z');
    expect(timed.endAt!.toISOString()).toBe('2030-03-31T01:00:00.000Z');
    const allDay = c.create({ isAllDay: true, startAt: null, endAt: null, startDate: '2030-03-31', endDate: '2030-04-01' });
    expect(allDay).toMatchObject({ startAt: null, endAt: null, startDate: '2030-03-31', endDate: '2030-04-01' });
    for (const extra of [{ startAt: '2030-02-30T09:00:00Z' }, { startAt: '2030-03-31T00:00:00' }, { endAt: '2030-03-31T00:00:00Z' }, { startDate: '2030-01-01' }])
      await expectAppError(() => c.create(extra), 'EVENT_INVALID_TIME_RANGE', 400);
    for (const extra of [{ startDate: '2030-02-30' }, { endDate: '2030-03-31' }, { startAt: '2030-03-31T00:00:00Z' }])
      await expectAppError(() => c.create({ isAllDay: true, startAt: null, endAt: null, startDate: '2030-03-31', endDate: '2030-04-01', ...extra }), 'EVENT_ALL_DAY_INVALID', 400);
    c.events.update(c.owner, timed.id, b({ isAllDay: true, startDate: '2030-05-01', endDate: '2030-05-02', version: 1 }));
    expect(c.events.get(c.owner, timed.id)).toMatchObject({ isAllDay: true, startAt: null, startDate: '2030-05-01' });
    expect(c.state.calendarEvents).toHaveLength(2);
  });
  it('Attendee self-response grants invitation-only access without changing Event content or Calendar permissions', async () => {
    const c = await setup(), attendee = await c.memberActor('attendee', permissions), other = await c.memberActor('other', permissions);
    const event = c.create({ attendeeUserIds: [attendee.user.id] });
    expect(c.events.get(attendee, event.id).title).toBe('Meeting');
    await expectAppError(() => c.collab.calendar.calendars.get(attendee, c.calendar.id), 'CALENDAR_NOT_FOUND', 404);
    await expectAppError(() => c.events.update(attendee, event.id, b({ title: 'Hijack', version: 1 })), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.events.respond(attendee, event.id, b({ response: 'ACCEPTED', userId: other.user.id })), 'VALIDATION_ERROR', 400);
    expect(c.events.respond(attendee, event.id, b({ response: 'TENTATIVE' }))).toMatchObject({ userId: attendee.user.id, response: 'TENTATIVE' });
    expect(c.events.respond(attendee, event.id, b({ response: 'TENTATIVE' }))).toMatchObject({ response: 'TENTATIVE' });
    expect(c.state.outboxEvents.filter((row) => row.entityId === event.id && row.eventType === 'CALENDAR_ATTENDEE_RESPONDED')).toHaveLength(1);
    await expectAppError(() => c.events.get(other, event.id), 'EVENT_NOT_FOUND', 404);
    c.events.removeAttendee(c.owner, event.id, attendee.user.id);
    await expectAppError(() => c.events.get(attendee, event.id), 'EVENT_NOT_FOUND', 404);
    expect(c.state.calendarEventAttendees.find((row) => row.eventId === event.id && row.userId === attendee.user.id)!.removedAt).toBeInstanceOf(Date);
  });
  it('External guest privacy keeps contact lists and invitation secrets away from ordinary attendees', async () => {
    const c = await setup(), attendee = await c.memberActor('guest-observer', permissions);
    const event = c.create({ attendeeUserIds: [attendee.user.id] });
    const guest = c.events.addGuest(c.owner, event.id, b({ email: 'Guest@Example.com', name: 'Guest' }));
    expect(guest).toMatchObject({ email: 'guest@example.com', response: 'NEEDS_ACTION' });
    expect(guest).not.toHaveProperty('inviteTokenHash');
    c.state.calendarExternalGuests.find((row) => row.id === guest.id)!.inviteTokenHash = 'never-expose';
    expect(JSON.stringify(c.events.guests(c.owner, event.id))).not.toContain('never-expose');
    expect(c.events.get(attendee, event.id)).not.toHaveProperty('guests');
    await expectAppError(() => c.events.guests(attendee, event.id), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.events.addGuest(attendee, event.id, b({ email: 'leak@example.com' })), 'PERMISSION_DENIED', 403);
    expect(c.events.addGuest(c.owner, event.id, b({ email: 'GUEST@example.com' })).id).toBe(guest.id);
    c.events.removeGuest(c.owner, event.id, guest.id);
    expect(c.state.calendarExternalGuests.find((row) => row.id === guest.id)).toMatchObject({ inviteTokenHash: null });
  });
  it('Stale version update and invalid replacements leave Event state, history and outbox unchanged', async () => {
    const c = await setup(), event = c.create(), count = c.state.outboxEvents.length;
    await expectAppError(() => c.events.update(c.owner, event.id, b({ title: 'Partial', endAt: 'bad', version: 1 })), 'EVENT_INVALID_TIME_RANGE', 400);
    expect(c.events.get(c.owner, event.id)).toMatchObject({ title: 'Meeting', version: 1 });
    expect(c.state.outboxEvents).toHaveLength(count);
    c.events.update(c.owner, event.id, b({ title: 'Changed', version: 1 }));
    expect(c.state.calendarEventHistory.find((row) => row.eventId === event.id && row.action === 'CALENDAR_EVENT_UPDATED')!.changes)
      .toMatchObject({ before: { title: 'Meeting' }, after: { title: 'Changed' } });
    await expectAppError(() => c.events.update(c.owner, event.id, b({ title: 'Stale', version: 1 })), 'RESOURCE_VERSION_CONFLICT', 409);
    const replaced = c.events.update(c.owner, event.id, b({ title: 'All day', isAllDay: true, startDate: '2030-01-01', endDate: '2030-01-02', sourceTimezone: 'UTC', version: 2 }), true);
    expect(replaced).toMatchObject({ version: 3, description: null, location: null, startAt: null });
  });
  it('Calendar edit-own ACL and platform actions remain separate; tenant targets cannot be linked', async () => {
    const c = await setup(), editor = await c.memberActor('editor', permissions), limited = await c.memberActor('limited', perms('OWN', 'event.read', 'calendar.read'));
    const company = c.collab.calendar.calendars.create(c.owner, b({ type: 'COMPANY', name: 'Company', timezone: 'UTC' }));
    c.collab.calendar.calendars.replacePermissions(c.owner, company.id, b({ version: 1, permissions: [{ subjectType: 'USER', subjectId: editor.user.id, level: 'EDIT_OWN' }, { subjectType: 'USER', subjectId: limited.user.id, level: 'MANAGE' }] }));
    const own = c.events.create(editor, b({ calendarId: company.id, title: 'Own', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' }));
    c.events.update(editor, own.id, b({ title: 'Editable', version: 1 }));
    const theirs = c.create({ calendarId: company.id });
    await expectAppError(() => c.events.update(editor, theirs.id, b({ title: 'No', version: 1 })), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.events.update(limited, theirs.id, b({ title: 'No', version: 1 })), 'PERMISSION_DENIED', 403);
    const foreign = await c.foreignActor(), task = c.collab.tasks.tasks.create(foreign, { title: 'Foreign' });
    await expectAppError(() => c.events.get(foreign, own.id), 'EVENT_NOT_FOUND', 404);
    await expectAppError(() => c.create({ attendeeUserIds: [foreign.user.id] }), 'EVENT_ATTENDEE_INVALID', 400);
    await expectAppError(() => c.events.addBinding(c.owner, theirs.id, b({ entityType: 'TASK', entityId: task.id })), 'EVENT_BINDING_INVALID', 400);
  });
  it('Cancellation preserves identity, restoration preserves tentative status, and administrative deletion preserves evidence', async () => {
    const c = await setup(), event = c.create({ status: 'TENTATIVE' });
    c.events.cancel(c.owner, event.id, b());
    expect(c.events.get(c.owner, event.id)).toMatchObject({ status: 'CANCELLED', statusBeforeCancel: 'TENTATIVE' });
    await expectAppError(() => c.events.update(c.owner, event.id, b({ title: 'No', version: 2 })), 'EVENT_CANCELLED', 409);
    c.events.cancel(c.owner, event.id, b());
    expect(c.state.outboxEvents.filter((row) => row.entityId === event.id && row.eventType === 'CALENDAR_EVENT_CANCELLED')).toHaveLength(1);
    c.events.cancel(c.owner, event.id, b(), true);
    expect(c.events.get(c.owner, event.id)).toMatchObject({ status: 'TENTATIVE', cancelledAt: null });
    c.events.remove(c.owner, event.id);
    await expectAppError(() => c.events.get(c.owner, event.id), 'EVENT_NOT_FOUND', 404);
    expect(c.state.calendarEvents.find((row) => row.id === event.id)).toMatchObject({ isDeleted: true });
    expect(c.state.calendarEventHistory.filter((row) => row.eventId === event.id)).toHaveLength(4);
    expect(c.state.auditLogs.some((row) => row.entityId === event.id && row.action === 'CALENDAR_EVENT.DELETED')).toBe(true);
  });
  it('Meeting records and decisions share Event identity with independent record versions and replay-safe decisions', async () => {
    const c = await setup(), event = c.create();
    expect(c.events.meetingRecord(c.owner, event.id)).toMatchObject({ version: 0, decisions: [] });
    c.events.putMeetingRecord(c.owner, event.id, b({ agenda: 'Agenda', notes: 'Notes', version: 0 }));
    await expectAppError(() => c.events.putMeetingRecord(c.owner, event.id, b({ notes: 'Stale', version: 0 })), 'RESOURCE_VERSION_CONFLICT', 409);
    const first = c.events.addDecision(c.owner, event.id, b({ text: 'Decision' }), 'once');
    expect(c.events.addDecision(c.owner, event.id, b({ text: 'Decision' }), 'once').id).toBe(first.id);
    expect(c.events.meetingRecord(c.owner, event.id)).toMatchObject({ version: 1, decisions: [{ text: 'Decision' }] });
    expect(c.state.calendarEvents).toHaveLength(1);
    expect(c.state.auditLogs.filter((row) => row.entityId === event.id).map((row) => row.action)).toEqual(expect.arrayContaining(['CALENDAR_EVENT.MEETING_RECORD_CHANGED', 'CALENDAR_EVENT.MEETING_DECISION_ADDED']));
  });
  it('File attachment checks enforce usability and reader permission; sources bind durably without copying source records', async () => {
    const c = await setup(), fake = new InMemoryFilePort(), fileId = randomUUID(), foreign = await c.foreignActor();
    c.app.setFilePort(fake); fake.register(c.owner.workspaceId, fileId);
    const task = c.collab.tasks.tasks.create(c.owner, { title: 'Source', deadlineAt: new Date('2030-01-01T12:00:00Z') });
    const event = c.create({ fileIds: [fileId], bindings: [{ entityType: 'TASK', entityId: task.id }] });
    expect(event.fileIds).toEqual([fileId]);
    expect(c.events.bindings(c.owner, event.id)).toMatchObject([{ entityId: task.id }]);
    await expectAppError(() => c.create({ fileIds: [randomUUID()] }), 'FILE_NOT_FOUND', 404);
    const foreignFile = randomUUID(); fake.register(foreign.workspaceId, foreignFile);
    await expectAppError(() => c.create({ fileIds: [foreignFile] }), 'FILE_NOT_FOUND', 404);
    expect(c.state.calendarEvents).toHaveLength(1);
    const projected = c.collab.tasks.tasks.create(c.owner, { title: 'Deadline', deadlineAt: new Date() });
    expect(projected.deadlineAt).toBeInstanceOf(Date);
    expect(c.state.calendarEvents).toHaveLength(1);
    const boundTask = c.collab.tasks.tasks.create(c.owner, { title: 'From event', bindings: [{ entityType: 'CALENDAR_EVENT', entityId: event.id }] });
    expect(c.collab.tasks.tasks.bindings(c.owner, boundTask.id)[0].entityId).toBe(event.id);
  });
});
