import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Reminders', timezone: 'Europe/Berlin' }));
  const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Meeting',
    startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin' }));
  return { ...c, get state() { return c.state; }, calendar, event, reminders: calendar.reminders };
}

describe('Calendar reminder configuration contracts', () => {
  it('creates offset and absolute reminders, replays creation and preserves cancellation evidence', async () => {
    const c = await setup(), input = b({ offsetSeconds: 900, channel: 'IN_APP' });
    const row = c.reminders.create(c.owner, c.event.id, input, 'reminder-create');
    expect(row).toMatchObject({ attendeeUserId: c.owner.user.id, dueAt: new Date('2030-03-30T07:45:00Z'), status: 'SCHEDULED', version: 1 });
    expect(c.reminders.create(c.owner, c.event.id, input, 'reminder-create').id).toBe(row.id);
    expect(c.state.calendarEventReminders).toHaveLength(1);
    const absolute = c.reminders.create(c.owner, c.event.id, b({ remindAt: '2030-03-30T07:00:00Z', channel: 'EMAIL' }));
    expect(absolute.offsetSeconds).toBeNull();
    c.reminders.update(c.owner, row.id, b({ remindAt: '2030-03-30T07:30:00Z', channel: 'PUSH', version: 1 }));
    expect(row).toMatchObject({ offsetSeconds: null, channel: 'PUSH', version: 2 });
    c.reminders.remove(c.owner, row.id, b({ version: 2 }));
    const count = c.state.outboxEvents.length;
    c.reminders.remove(c.owner, row.id, b({ version: 2 }));
    expect(c.state.outboxEvents).toHaveLength(count); expect(row.status).toBe('CANCELLED');
    expect(c.reminders.list(c.owner, c.event.id)).toHaveLength(2);
  });
  it('rejects invalid times, stale versions and unsupported fields without partial writes', async () => {
    const c = await setup(), count = c.state.outboxEvents.length;
    for (const raw of [{ offsetSeconds: -1 }, { offsetSeconds: null }, { offsetSeconds: 10, remindAt: '2030-03-30T07:00:00Z' },
      { remindAt: '2030-03-30T09:00:00Z' }, { remindAt: '2020-01-01T00:00:00Z' }, { remindAt: '2030-03-30T07:00:00' }, {}]) {
      await expectAppError(() => c.reminders.create(c.owner, c.event.id, b({ ...raw, channel: 'IN_APP' })), 'REMINDER_INVALID_TIME', 400);
    }
    expect(c.state.calendarEventReminders).toHaveLength(0); expect(c.state.outboxEvents).toHaveLength(count);
    const row = c.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 300, channel: 'IN_APP' }));
    await expectAppError(() => c.reminders.update(c.owner, row.id, b({ version: 0, offsetSeconds: 100 })), 'RESOURCE_VERSION_CONFLICT', 409);
    await expectAppError(() => c.reminders.update(c.owner, row.id, b({ version: 1, attendeeUserId: c.owner.user.id })), 'VALIDATION_ERROR', 400);
    expect(row.version).toBe(1);
  });
  it('keeps attendee reminders private, requires permission and hides foreign IDs', async () => {
    const c = await setup(), attendee = await c.memberActor('reminder-attendee', perms('OWN', 'event.read', 'event.reminder_manage'));
    const other = await c.memberActor('reminder-other', perms('OWN', 'event.read', 'event.reminder_manage'));
    const noManage = await c.memberActor('reminder-no-manage', perms('OWN', 'event.read'));
    c.calendar.events.addAttendees(c.owner, c.event.id, b({ attendeeUserIds: [attendee.user.id, other.user.id, noManage.user.id] }));
    c.app.realtime.discard();
    const recipientHints: string[] = [], otherHints: string[] = [];
    c.app.realtime.subscribe({ workspaceId: c.owner.workspaceId, userId: attendee.user.id, send: (hint) => recipientHints.push(hint.type) });
    c.app.realtime.subscribe({ workspaceId: c.owner.workspaceId, userId: other.user.id, send: (hint) => otherHints.push(hint.type) });
    const row = c.reminders.create(attendee, c.event.id, b({ offsetSeconds: 600, channel: 'IN_APP' }));
    expect(c.reminders.list(other, c.event.id)).toEqual([]);
    await expectAppError(() => c.reminders.update(other, row.id, b({ offsetSeconds: 100, version: 1 })), 'REMINDER_NOT_FOUND', 404);
    await expectAppError(() => c.reminders.create(other, c.event.id, b({ attendeeUserId: attendee.user.id, offsetSeconds: 100, channel: 'IN_APP' })), 'PERMISSION_DENIED', 403);
    await expectAppError(() => c.reminders.create(noManage, c.event.id, b({ offsetSeconds: 100, channel: 'IN_APP' })), 'PERMISSION_DENIED', 403);
    const foreign = await c.foreignActor();
    await expectAppError(() => c.reminders.list(foreign, c.event.id), 'EVENT_NOT_FOUND', 404);
    await expectAppError(() => c.reminders.remove(foreign, row.id, b({ version: 1 })), 'REMINDER_NOT_FOUND', 404);
    c.app.realtime.flush();
    expect(recipientHints).toContain('CALENDAR_REMINDER_SCHEDULED'); expect(otherHints).toEqual([]);
    c.calendar.events.removeAttendee(c.owner, c.event.id, attendee.user.id);
    expect(c.state.calendarEventReminders.find((item) => item.id === row.id)!.status).toBe('CANCELLED');
  });
  it('reschedules offsets when an Event moves and cancels pending reminders on cancellation/deletion', async () => {
    const c = await setup(), row = c.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'IN_APP' }));
    c.calendar.events.update(c.owner, c.event.id, b({ startAt: '2030-03-30T11:00:00+01:00', endAt: '2030-03-30T12:00:00+01:00', version: 1 }));
    expect(row).toMatchObject({ dueAt: new Date('2030-03-30T09:45:00Z'), version: 2 });
    c.calendar.events.cancel(c.owner, c.event.id, b()); expect(row.status).toBe('CANCELLED');
    c.calendar.events.cancel(c.owner, c.event.id, b(), true); expect(row.status).toBe('CANCELLED');
    const fresh = c.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 900, channel: 'IN_APP' }));
    c.calendar.events.remove(c.owner, c.event.id); expect(fresh.status).toBe('CANCELLED');
  });
  it('uses stable recurrence identity, follows moved occurrences and cancels removed/cancelled occurrences', async () => {
    const c = await setup(), recurrence = c.calendar.recurrence;
    const rule = recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', version: 0 }), true)!;
    await expectAppError(() => c.reminders.create(c.owner, c.event.id, b({ remindAt: '2030-03-30T07:00:00Z', channel: 'IN_APP' })), 'RECURRENCE_SCOPE_INVALID', 400);
    const row = c.reminders.create(c.owner, c.event.id, b({ recurrenceId: rule.upcoming[1].recurrenceId, offsetSeconds: 900, channel: 'IN_APP' }));
    expect(row.dueAt).toEqual(new Date('2030-03-31T06:45:00Z'));
    recurrence.editOccurrence(c.owner, c.event.id, row.recurrenceId!, b({ startAt: '2030-04-10T12:00:00+02:00', version: 1 }));
    expect(row.dueAt).toEqual(new Date('2030-04-10T09:45:00Z'));
    recurrence.cancelOccurrence(c.owner, c.event.id, row.recurrenceId!, b({ version: 2 })); expect(row.status).toBe('CANCELLED');
    const other = c.reminders.create(c.owner, c.event.id, b({ recurrenceId: rule.upcoming[2].recurrenceId, offsetSeconds: 900, channel: 'EMAIL' }));
    recurrence.remove(c.owner, c.event.id, b({ version: 3 })); expect(other.status).toBe('CANCELLED');
  });
  it('uses source-timezone midnight for all-day offsets and refuses sent reminder changes', async () => {
    const c = await setup();
    c.calendar.events.update(c.owner, c.event.id, b({ isAllDay: true, startDate: '2030-03-31', endDate: '2030-04-01', startAt: null, endAt: null, version: 1 }));
    const row = c.reminders.create(c.owner, c.event.id, b({ offsetSeconds: 0, channel: 'IN_APP' }));
    expect(row.dueAt).toEqual(new Date('2030-03-30T23:00:00Z'));
    row.status = 'SENT';
    await expectAppError(() => c.reminders.update(c.owner, row.id, b({ offsetSeconds: 100, version: 1 })), 'REMINDER_NOT_EDITABLE', 409);
    await expectAppError(() => c.reminders.remove(c.owner, row.id, b({ version: 1 })), 'REMINDER_NOT_EDITABLE', 409);
  });
});
