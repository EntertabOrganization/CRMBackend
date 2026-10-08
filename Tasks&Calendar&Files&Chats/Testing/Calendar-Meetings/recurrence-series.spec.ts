import { randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

async function setup(extra: Record<string, unknown> = {}) {
  const c = await collabApp(), events = c.collab.calendar.events, recurrence = c.collab.calendar.recurrence;
  const calendar = c.collab.calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Series', timezone: 'Europe/Berlin' }));
  const event = events.create(c.owner, b({ calendarId: calendar.id, title: 'Daily', description: 'Agenda',
    startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin', ...extra }));
  const rule = recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=5', sourceTimezone: 'Europe/Berlin', version: 0 }), true)!;
  return { ...c, get state() { return c.state; }, calendar, event, events, recurrence, rule };
}
describe('Calendar recurrence series contracts', () => {
  it('supports series CRUD, preserves local DTSTART and returns DST-safe occurrences', async () => {
    const c = await setup();
    expect(c.rule.upcoming.map((row) => row.startAt!.toISOString())).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z', '2030-04-02T07:00:00.000Z', '2030-04-03T07:00:00.000Z']);
    const updated = c.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY;INTERVAL=2;COUNT=3', version: 1 }))!;
    expect(updated).toMatchObject({ id: c.rule.id, dtstartLocal: '2030-03-30T09:00:00.000', version: 2 });
    expect(updated.upcoming.map((row) => row.recurrenceId.slice(0, 10))).toEqual(['2030-03-30', '2030-04-01', '2030-04-03']);
    c.recurrence.remove(c.owner, c.event.id, b({ version: 2 }));
    expect(c.recurrence.get(c.owner, c.event.id)).toBeNull();
    expect(c.state.calendarRecurrenceRules[0]).toMatchObject({ isDeleted: true, version: 3 });
    const fresh = c.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=WEEKLY;COUNT=2', sourceTimezone: 'Europe/Berlin', version: 0 }), true)!;
    expect(fresh.id).not.toBe(c.rule.id); expect(c.state.calendarRecurrenceRules).toHaveLength(2);
    expect(c.state.calendarEventHistory.filter((row) => row.action === 'CALENDAR_RECURRENCE_CHANGED')).toHaveLength(4);
  });
  it('moves one occurrence without changing its original identity, deduplicates overrides and cancels historically', async () => {
    const c = await setup(), identity = c.rule.upcoming[1].recurrenceId;
    const moved = c.recurrence.editOccurrence(c.owner, c.event.id, identity, b({ startAt: '2030-04-05T15:00:00+02:00', title: 'Moved', version: 1 }));
    expect(moved).toMatchObject({ recurrenceId: identity, recurrenceVersion: 2, title: 'Moved', startAt: new Date('2030-04-05T13:00:00Z'), endAt: new Date('2030-04-05T14:00:00Z') });
    const again = c.recurrence.editOccurrence(c.owner, c.event.id, identity, b({ location: 'Room A', version: 2 }));
    expect(again.overrideEventId).toBe(moved.overrideEventId);
    expect(c.state.calendarEvents).toHaveLength(2); expect(c.state.calendarRecurrenceExceptions).toHaveLength(1);
    expect(c.recurrence.get(c.owner, c.event.id)!.upcoming[0].title).toBe('Daily');
    expect(c.events.list(c.owner, new URLSearchParams()).data.map((row) => row.id)).toEqual([c.event.id]);
    c.recurrence.cancelOccurrence(c.owner, c.event.id, identity, b({ version: 3 }));
    const count = c.state.outboxEvents.length;
    c.recurrence.cancelOccurrence(c.owner, c.event.id, identity, b({ version: 3 }));
    expect(c.state.outboxEvents).toHaveLength(count);
    await expectAppError(() => c.recurrence.cancelOccurrence(c.owner, c.event.id, identity, b({ version: 'bad' })), 'VALIDATION_ERROR', 400);
    expect(c.events.get(c.owner, moved.overrideEventId!).status).toBe('CANCELLED');
    expect(c.state.calendarRecurrenceExceptions[0]).toMatchObject({ recurrenceId: identity, exceptionType: 'CANCELLED', overrideEventId: moved.overrideEventId });
    await expectAppError(() => c.recurrence.editOccurrence(c.owner, c.event.id, identity, b({ title: 'Revive', version: 4 })), 'EVENT_CANCELLED', 409);
  });
  it('edits current-and-future by original identities and leaves independently modified occurrences intact', async () => {
    const c = await setup(), [a, boundary, single] = c.rule.upcoming;
    c.recurrence.editOccurrence(c.owner, c.event.id, single.recurrenceId, b({ title: 'Independent', startAt: '2030-03-29T15:00:00+01:00', version: 1 }));
    const future = c.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: boundary.recurrenceId, title: 'Future', startAt: '2030-03-31T11:00:00+02:00', version: 2 }))!;
    expect(future.upcoming[0]).toMatchObject({ recurrenceId: a.recurrenceId, title: 'Daily', startAt: a.startAt });
    expect(future.upcoming[1]).toMatchObject({ recurrenceId: boundary.recurrenceId, title: 'Future', startAt: new Date('2030-03-31T09:00:00Z'), endAt: new Date('2030-03-31T10:00:00Z') });
    expect(future.upcoming[2]).toMatchObject({ title: 'Independent', startAt: new Date('2030-03-29T14:00:00Z') });
    expect(future.upcoming[3]).toMatchObject({ title: 'Future', startAt: new Date('2030-04-02T09:00:00Z') });
    c.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: boundary.recurrenceId, location: 'New room', description: null, version: 3 }));
    expect(c.state.calendarRecurrenceRanges).toHaveLength(1);
    c.events.update(c.owner, c.event.id, b({ title: 'Entire series', version: c.events.get(c.owner, c.event.id).version }));
    const all = c.recurrence.get(c.owner, c.event.id)!;
    expect(all.upcoming[0].title).toBe('Entire series'); expect(all.upcoming[1].title).toBe('Future'); expect(all.upcoming[1].description).toBeNull();
  });
  it('keeps all-day recurrence, exceptions and future shifts as dates and prevents series type changes', async () => {
    const c = await setup({ isAllDay: true, startAt: null, endAt: null, startDate: '2030-03-30', endDate: '2030-04-01' });
    expect(c.rule.upcoming[1]).toMatchObject({ recurrenceId: '2030-03-31', startDate: '2030-03-31', endDate: '2030-04-02', startAt: null });
    c.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: '2030-03-31', startDate: '2030-04-02', version: 1 }));
    expect(c.recurrence.get(c.owner, c.event.id)!.upcoming[2]).toMatchObject({ recurrenceId: '2030-04-01', startDate: '2030-04-03', endDate: '2030-04-05', startAt: null });
    c.recurrence.editOccurrence(c.owner, c.event.id, '2030-04-01', b({ startDate: '2030-04-10', version: 2 }));
    expect(c.recurrence.get(c.owner, c.event.id)!.upcoming[2]).toMatchObject({ recurrenceId: '2030-04-01', startDate: '2030-04-10', endDate: '2030-04-12' });
    await expectAppError(() => c.events.update(c.owner, c.event.id, b({ isAllDay: false, startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z', version: c.events.get(c.owner, c.event.id).version })), 'RECURRENCE_SCOPE_INVALID', 400);
  });
  it('rejects invalid/stale recurrence mutations before changing parent, history or outbox', async () => {
    const c = await setup(), before = structuredClone(c.state);
    await expectAppError(() => c.recurrence.update(c.owner, c.event.id, b({ sourceTimezone: 'Unknown/Zone', version: 1 })), 'RECURRENCE_INVALID_RULE', 400);
    await expectAppError(() => c.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY;COUNT=0', version: 1 })), 'RECURRENCE_INVALID_RULE', 400);
    await expectAppError(() => c.recurrence.update(c.owner, c.event.id, b({ rruleText: 'FREQ=DAILY', version: 0 })), 'RESOURCE_VERSION_CONFLICT', 409);
    await expectAppError(() => c.recurrence.editOccurrence(c.owner, c.event.id, '2030-04-10T09:00:00.000', b({ title: 'Absent', version: 1 })), 'RECURRENCE_OCCURRENCE_NOT_FOUND', 404);
    await expectAppError(() => c.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: c.rule.upcoming[1].recurrenceId, startAt: 'bad', version: 1 })), 'VALIDATION_ERROR', 400);
    await expectAppError(() => c.recurrence.editFuture(c.owner, c.event.id, b({ recurrenceId: c.rule.upcoming[1].recurrenceId, startAt: '2200-01-01T09:00:00Z', version: 1 })), 'RECURRENCE_SCOPE_INVALID', 400);
    await expectAppError(() => c.recurrence.editOccurrence(c.owner, c.event.id, c.rule.upcoming[1].recurrenceId, b({ title: 'Partial', endAt: 'bad', version: 1 })), 'EVENT_INVALID_TIME_RANGE', 400);
    expect(c.state.calendarEvents).toEqual(before.calendarEvents); expect(c.state.calendarRecurrenceRules).toEqual(before.calendarRecurrenceRules);
    expect(c.state.outboxEvents).toEqual(before.outboxEvents); expect(c.state.calendarEventHistory).toEqual(before.calendarEventHistory);
  });
  it('requires both recurrence and Event-update permission plus Calendar editing access, and hides foreign IDs', async () => {
    const c = await setup(), reader = await c.memberActor('rec-reader', perms('OWN', 'event.read', 'event.update', 'event.recurrence_manage'));
    c.events.addAttendees(c.owner, c.event.id, b({ userId: reader.user.id }));
    expect(c.recurrence.get(reader, c.event.id)!.id).toBe(c.rule.id);
    await expectAppError(() => c.recurrence.update(reader, c.event.id, b({ rruleText: 'FREQ=WEEKLY', version: 1 })), 'PERMISSION_DENIED', 403);
    const missingUpdate = await c.memberActor('rec-no-update', perms('OWN', 'event.read', 'event.recurrence_manage'));
    c.events.addAttendees(c.owner, c.event.id, b({ userId: missingUpdate.user.id }));
    c.collab.calendar.calendars.replacePermissions(c.owner, c.calendar.id, b({ version: c.calendar.version, permissions: [{ subjectType: 'USER', subjectId: missingUpdate.user.id, level: 'EDIT_ALL' }] }));
    await expectAppError(() => c.recurrence.update(missingUpdate, c.event.id, b({ rruleText: 'FREQ=WEEKLY', version: 1 })), 'PERMISSION_DENIED', 403);
    const foreign = await c.foreignActor();
    for (const run of [() => c.recurrence.get(foreign, c.event.id), () => c.recurrence.update(foreign, c.event.id, b({ version: 1 })), () => c.recurrence.editOccurrence(foreign, c.event.id, c.rule.upcoming[0].recurrenceId, b({ version: 1 })), () => c.recurrence.remove(foreign, c.event.id, b({ version: 1 }))]) await expectAppError(run, 'EVENT_NOT_FOUND', 404);
    await expectAppError(() => c.recurrence.get(c.owner, randomUUID()), 'EVENT_NOT_FOUND', 404);
  });
  it('inherits live invitation access for overrides and revokes it when parent membership or lifecycle changes', async () => {
    const c = await setup(), attendee = await c.memberActor('rec-attendee', perms('OWN', 'event.read'));
    c.events.addAttendees(c.owner, c.event.id, b({ userId: attendee.user.id }));
    const moved = c.recurrence.editOccurrence(c.owner, c.event.id, c.rule.upcoming[1].recurrenceId, b({ title: 'Private occurrence', version: 1 }));
    expect(c.events.get(attendee, moved.overrideEventId!).title).toBe('Private occurrence');
    await expectAppError(() => c.events.update(c.owner, moved.overrideEventId!, b({ title: 'Bypass', version: 1 })), 'RECURRENCE_SCOPE_INVALID', 400);
    c.events.removeAttendee(c.owner, c.event.id, attendee.user.id);
    await expectAppError(() => c.events.get(attendee, moved.overrideEventId!), 'EVENT_NOT_FOUND', 404);
    c.events.cancel(c.owner, c.event.id, b());
    expect(c.recurrence.get(c.owner, c.event.id)!.upcoming.every((row) => row.status === 'CANCELLED')).toBe(true);
    await expectAppError(() => c.recurrence.update(c.owner, c.event.id, b({ version: 2 })), 'EVENT_CANCELLED', 409);
    c.events.cancel(c.owner, c.event.id, b(), true);
    c.events.remove(c.owner, c.event.id);
    await expectAppError(() => c.events.get(c.owner, moved.overrideEventId!), 'EVENT_NOT_FOUND', 404);
    expect(c.state.calendarRecurrenceExceptions).toHaveLength(1);
  });
  it('changes the source timezone for the whole series while keeping original local IDs', async () => {
    const c = await setup(), changed = c.recurrence.update(c.owner, c.event.id, b({ sourceTimezone: 'America/New_York', version: 1 }))!;
    expect(changed.upcoming[0]).toMatchObject({ recurrenceId: c.rule.upcoming[0].recurrenceId, startAt: new Date('2030-03-30T13:00:00Z') });
    expect(c.events.get(c.owner, c.event.id)).toMatchObject({ sourceTimezone: 'America/New_York', startAt: new Date('2030-03-30T13:00:00Z') });
  });
});
