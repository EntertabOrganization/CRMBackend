import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';
jest.setTimeout(300_000);
let owner: Session, reader: Session, outsider: Session, noManage: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('series-owner'); outsider = await register('series-outsider');
  reader = await member(owner, 'series-reader', [['event.read', 'OWN'], ['event.update', 'OWN'], ['event.recurrence_manage', 'OWN']]);
  noManage = await member(owner, 'series-no-manage', [['event.read', 'OWN'], ['event.update', 'OWN']]);
});
afterAll(disconnect);
async function setup(extra: Record<string, unknown> = {}) {
  const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Series', timezone: 'Europe/Berlin' } }));
  const event = expectOk(await call(owner, 'POST', 'calendar-events', { body: { calendarId: calendar.id, title: 'Daily',
    startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin', ...extra } }));
  const rule = expectOk(await call(owner, 'PUT', `calendar-events/${event.id}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=5', sourceTimezone: 'Europe/Berlin', version: 0 } }));
  return { calendar, event, rule, path: `calendar-events/${event.id}` };
}
describe('Calendar recurrence series HTTP/PostgreSQL contracts', () => {
  it('persists series CRUD, DST source identity, replacement and historical removal', async () => {
    const c = await setup();
    expect(c.rule.upcoming[1]).toMatchObject({ recurrenceId: '2030-03-31T09:00:00.000', startAt: '2030-03-31T07:00:00.000Z' });
    expect(expectOk(await call(owner, 'GET', `${c.path}/recurrence`)).id).toBe(c.rule.id);
    const patch = expectOk(await call(owner, 'PATCH', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;INTERVAL=2;COUNT=3' }, headers: { 'if-match': '"1"' } }));
    expect(patch).toMatchObject({ version: 2, dtstartLocal: c.rule.dtstartLocal });
    expectOk(await call(owner, 'PUT', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=WEEKLY;COUNT=2', sourceTimezone: 'Europe/Berlin', version: 2 } }));
    expectError(await call(owner, 'PUT', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=WEEKLY;COUNT=2', version: 3 } }), 400, 'VALIDATION_ERROR');
    expectOk(await call(owner, 'DELETE', `${c.path}/recurrence`, { headers: { 'if-match': '"3"' } }));
    expect(expectOk(await call(owner, 'GET', `${c.path}/recurrence`))).toBeNull();
    expect(await (await db()).calendarRecurrenceRule.findUnique({ where: { id: c.rule.id } })).toMatchObject({ isDeleted: true, version: 4 });
    const newRule = expectOk(await call(owner, 'PUT', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=2', sourceTimezone: 'Europe/Berlin', version: 0 } }));
    expect(newRule.id).not.toBe(c.rule.id);
    expect(await (await db()).calendarRecurrenceRule.count({ where: { eventId: c.event.id } })).toBe(2);
    expect(await (await db()).calendarEventHistory.count({ where: { eventId: c.event.id, action: 'CALENDAR_RECURRENCE_CHANGED' } })).toBe(5);
    expect(await (await db()).outboxEvent.count({ where: { entityId: c.event.id, eventType: 'CALENDAR_RECURRENCE_CHANGED' } })).toBe(5);
  });
  it('edits one, future and entire series without duplicating occurrences or replacing independent exceptions', async () => {
    const c = await setup(), identity = c.rule.upcoming[2].recurrenceId;
    const moved = expectOk(await call(owner, 'PATCH', `${c.path}/occurrences/${identity}`, { body: { title: 'Independent', startAt: '2030-04-08T15:00:00+02:00', version: 1 } }));
    expect(moved).toMatchObject({ recurrenceId: identity, recurrenceVersion: 2, startAt: '2030-04-08T13:00:00.000Z', endAt: '2030-04-08T14:00:00.000Z' });
    const future = expectOk(await call(owner, 'PATCH', `${c.path}/recurrence/future`, { body: { recurrenceId: c.rule.upcoming[1].recurrenceId, title: 'Future', startAt: '2030-03-31T11:00:00+02:00', version: 2 } }));
    expect(future.upcoming[0]).toMatchObject({ title: 'Daily', startAt: '2030-03-30T08:00:00.000Z' });
    expect(future.upcoming[1]).toMatchObject({ title: 'Future', startAt: '2030-03-31T09:00:00.000Z' });
    expect(future.upcoming[2]).toMatchObject({ title: 'Independent', recurrenceId: identity, startAt: moved.startAt });
    const currentParent = expectOk(await call(owner, 'GET', c.path));
    expectOk(await call(owner, 'PATCH', c.path, { body: { title: 'Whole series', version: currentParent.version } }));
    const all = expectOk(await call(owner, 'GET', `${c.path}/recurrence`));
    expect(all.upcoming[0].title).toBe('Whole series'); expect(all.upcoming[1].title).toBe('Future'); expect(all.upcoming[2].title).toBe('Independent');
    expectOk(await call(owner, 'PATCH', `${c.path}/occurrences/${identity}`, { body: { location: 'Room', version: 3 } }));
    expectOk(await call(owner, 'POST', `${c.path}/occurrences/${identity}/cancel`, { body: { version: 4 } }));
    const count = await (await db()).outboxEvent.count({ where: { entityId: c.event.id } });
    expectOk(await call(owner, 'POST', `${c.path}/occurrences/${identity}/cancel`, { body: { version: 4 } }));
    expect(await (await db()).outboxEvent.count({ where: { entityId: c.event.id } })).toBe(count);
    expect(await (await db()).calendarEvent.count({ where: { calendarId: c.calendar.id } })).toBe(2);
    expect(await (await db()).calendarRecurrenceException.count({ where: { recurrenceRuleId: c.rule.id } })).toBe(1);
    expect(await (await db()).calendarRecurrenceRange.count({ where: { recurrenceRuleId: c.rule.id } })).toBe(1);
    expect(expectOk(await call(owner, 'GET', `calendar-events/${moved.overrideEventId}`)).status).toBe('CANCELLED');
    expect(expectOk(await call(owner, 'GET', 'calendar-events', { query: { calendarId: c.calendar.id } })).map((row: any) => row.id)).toEqual([c.event.id]);
  });
  it('authenticates every protected route, requires edit and recurrence grants, and hides cross-tenant resources', async () => {
    const c = await setup(), identity = c.rule.upcoming[1].recurrenceId;
    for (const [method, suffix, body] of [
      ['GET', '/recurrence', undefined], ['PUT', '/recurrence', { version: 1 }], ['PATCH', '/recurrence', { version: 1 }], ['DELETE', '/recurrence', { version: 1 }],
      ['PATCH', `/occurrences/${identity}`, { version: 1 }], ['POST', `/occurrences/${identity}/cancel`, { version: 1 }], ['PATCH', '/recurrence/future', { recurrenceId: identity, version: 1 }],
    ] as const) {
      expectError(await call(null, method, `${c.path}${suffix}`, { workspaceId: owner.workspaceId, body }), 401, 'UNAUTHENTICATED');
      expectError(await call(outsider, method, `${c.path}${suffix}`, { body }), 404, 'EVENT_NOT_FOUND');
    }
    expectOk(await call(owner, 'POST', `${c.path}/attendees`, { body: { attendeeUserIds: [reader.userId, noManage.userId] } }));
    expectOk(await call(reader, 'GET', `${c.path}/recurrence`));
    expectError(await call(reader, 'PATCH', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=WEEKLY', version: 1 } }), 403, 'PERMISSION_DENIED');
    expectOk(await call(owner, 'PUT', `calendars/${c.calendar.id}/permissions`, { body: { version: 1, permissions: [{ subjectType: 'USER', subjectId: noManage.userId, level: 'EDIT_ALL' }] } }));
    expectError(await call(noManage, 'PATCH', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=WEEKLY', version: 1 } }), 403, 'PERMISSION_DENIED');
    expectError(await call(owner, 'GET', `calendar-events/${randomUUID()}/recurrence`), 404, 'EVENT_NOT_FOUND');
  });
  it('rejects invalid and stale writes atomically and serializes concurrent writers by aggregate version', async () => {
    const c = await setup(), prisma = await db(), count = await prisma.outboxEvent.count({ where: { entityId: c.event.id } });
    expectError(await call(owner, 'PATCH', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=DAILY;COUNT=0', version: 1 } }), 400, 'RECURRENCE_INVALID_RULE');
    expectError(await call(owner, 'PATCH', `${c.path}/recurrence`, { body: { sourceTimezone: 'Mars/Orbit', version: 1 } }), 400, 'RECURRENCE_INVALID_RULE');
    expectError(await call(owner, 'PATCH', `${c.path}/occurrences/${c.rule.upcoming[1].recurrenceId}`, { body: { title: 'Partial', endAt: 'bad', version: 1 } }), 400, 'EVENT_INVALID_TIME_RANGE');
    expectError(await call(owner, 'PATCH', `${c.path}/recurrence/future`, { body: { recurrenceId: '2030-04-10T09:00:00.000', title: 'Absent', version: 1 } }), 404, 'RECURRENCE_OCCURRENCE_NOT_FOUND');
    expectError(await call(owner, 'PATCH', `${c.path}/recurrence/future`, { body: { recurrenceId: c.rule.upcoming[1].recurrenceId, startAt: '2200-01-01T09:00:00Z', version: 1 } }), 400, 'RECURRENCE_SCOPE_INVALID');
    expect(await prisma.outboxEvent.count({ where: { entityId: c.event.id } })).toBe(count);
    expect(await prisma.calendarRecurrenceException.count({ where: { recurrenceRuleId: c.rule.id } })).toBe(0);
    const writes = await Promise.all(['FREQ=DAILY;COUNT=2', 'FREQ=WEEKLY;COUNT=2'].map((rruleText) => call(owner, 'PATCH', `${c.path}/recurrence`, { body: { rruleText, version: 1 } })));
    expect(writes.map((row) => row.status).sort()).toEqual([200, 409]);
    expectError(writes.find((row) => row.status === 409)!, 409, 'RESOURCE_VERSION_CONFLICT');
    expect(await prisma.calendarRecurrenceRule.findUnique({ where: { id: c.rule.id } })).toMatchObject({ version: 2 });
    expect(await prisma.outboxEvent.count({ where: { entityId: c.event.id } })).toBe(count + 1);
  });
  it('persists date-only future shifts and retains cancellation/history under Event lifecycle', async () => {
    const c = await setup({ isAllDay: true, startAt: null, endAt: null, startDate: '2030-03-30', endDate: '2030-04-01' });
    const future = expectOk(await call(owner, 'PATCH', `${c.path}/recurrence/future`, { body: { recurrenceId: '2030-03-31', startDate: '2030-04-02', version: 1 } }));
    expect(future.upcoming[2]).toMatchObject({ recurrenceId: '2030-04-01', startDate: '2030-04-03', endDate: '2030-04-05', startAt: null });
    const occurrence = expectOk(await call(owner, 'PATCH', `${c.path}/occurrences/2030-04-01`, { body: { startDate: '2030-04-10', version: 2 } }));
    expect(await (await db()).calendarEvent.findUnique({ where: { id: occurrence.overrideEventId } })).toMatchObject({ startAt: null, startDate: new Date('2030-04-10T00:00:00Z') });
    expectOk(await call(owner, 'POST', `${c.path}/cancel`, { body: {} }));
    expect(expectOk(await call(owner, 'GET', `${c.path}/recurrence`)).upcoming.every((row: any) => row.status === 'CANCELLED')).toBe(true);
    expectError(await call(owner, 'PATCH', `${c.path}/recurrence`, { body: { rruleText: 'FREQ=DAILY', version: 3 } }), 409, 'EVENT_CANCELLED');
    expectOk(await call(owner, 'POST', `${c.path}/restore`, { body: {} }));
    expectOk(await call(owner, 'DELETE', c.path));
    expectError(await call(owner, 'GET', `calendar-events/${occurrence.overrideEventId}`), 404, 'EVENT_NOT_FOUND');
    expect(await (await db()).calendarRecurrenceException.count({ where: { recurrenceRuleId: c.rule.id } })).toBe(1);
    await expect((await db()).calendarEvent.delete({ where: { id: c.event.id } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('enforces database ownership, original identity, version and override-link invariants', async () => {
    const c = await setup(), other = await setup(), prisma = await db();
    await expect(prisma.calendarRecurrenceRule.update({ where: { id: c.rule.id }, data: { dtstartLocal: '2030-03-31T09:00:00.000', version: 2 } })).rejects.toThrow('RECURRENCE_SCOPE_INVALID');
    await expect(prisma.calendarRecurrenceRule.update({ where: { id: c.rule.id }, data: { rruleText: 'FREQ=WEEKLY', version: 1 } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.calendarEvent.update({ where: { id: c.event.id }, data: { recurrenceRuleId: other.rule.id, version: 3 } })).rejects.toMatchObject({ code: 'P2003' });
    const now = new Date();
    await expect(prisma.calendarRecurrenceException.create({ data: { id: randomUUID(), workspaceId: c.event.workspaceId,
      recurrenceRuleId: c.rule.id, recurrenceId: c.rule.upcoming[0].recurrenceId, exceptionType: 'MODIFIED', overrideEventId: other.event.id, createdAt: now, updatedAt: now } })).rejects.toThrow('RECURRENCE_SCOPE_INVALID');
    await expect(prisma.calendarRecurrenceRange.create({ data: { id: randomUUID(), workspaceId: outsider.workspaceId,
      recurrenceRuleId: c.rule.id, recurrenceId: c.rule.upcoming[0].recurrenceId, createdAt: now, updatedAt: now } })).rejects.toThrow('RECURRENCE_SCOPE_INVALID');
    expect(await prisma.calendarRecurrenceRule.findUnique({ where: { id: c.rule.id } })).toMatchObject({ version: 1 });
  });
});
