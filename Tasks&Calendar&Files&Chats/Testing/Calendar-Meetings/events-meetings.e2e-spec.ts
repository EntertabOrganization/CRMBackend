import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { InMemoryFilePort } from '@/src/server/ports';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(300_000);
let owner: Session, attendee: Session, editor: Session, outsider: Session;
beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('event-owner');
  attendee = await member(owner, 'event-attendee', [['event.read', 'OWN'], ['calendar.read', 'OWN']]);
  editor = await member(owner, 'event-editor', ['event.create', 'event.read', 'event.update', 'event.cancel', 'event.delete_admin',
    'event.attendee_manage', 'event.meeting_record_manage', 'calendar.read', 'project.read', 'task.read'].map((key) => [key, 'OWN']));
  outsider = await register('event-outsider');
});
afterAll(disconnect);
async function calendar(extra: Record<string, unknown> = {}) {
  return expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Events', timezone: 'UTC', ...extra } }));
}
async function event(c?: any, extra: Record<string, unknown> = {}, key?: string) {
  c ??= await calendar();
  return expectOk(await call(owner, 'POST', 'calendar-events', { body: {
    calendarId: c.id, title: 'Meeting', startAt: '2030-03-31T01:00:00+01:00', endAt: '2030-03-31T03:00:00+02:00', sourceTimezone: 'Europe/Berlin', ...extra,
  }, headers: key ? { 'idempotency-key': key } : undefined }));
}
describe('Events & Meetings HTTP/PostgreSQL contract', () => {
  it('exposes timed/all-day CRUD, replacement and administrative deletion while preserving evidence', async () => {
    const c = await calendar(), e = await event(c);
    expect(e).toMatchObject({ startAt: '2030-03-31T00:00:00.000Z', endAt: '2030-03-31T01:00:00.000Z', startDate: null });
    expect(expectOk(await call(owner, 'GET', 'calendar-events', { query: { calendarId: c.id } })).map((row: any) => row.id)).toContain(e.id);
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}`)).id).toBe(e.id);
    expectOk(await call(owner, 'PATCH', `calendar-events/${e.id}`, { body: { title: 'Changed' }, headers: { 'if-match': '"1"' } }));
    expectError(await call(owner, 'PATCH', `calendar-events/${e.id}`, { body: { title: 'Stale', version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    const replaced = expectOk(await call(owner, 'PUT', `calendar-events/${e.id}`, { body: {
      title: 'All day', isAllDay: true, startDate: '2030-03-31', endDate: '2030-04-01', sourceTimezone: 'Europe/Berlin', version: 2,
    } }));
    expect(replaced).toMatchObject({ startAt: null, endAt: null, startDate: '2030-03-31', endDate: '2030-04-01', version: 3 });
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}`)).startDate).toBe('2030-03-31');
    expectOk(await call(owner, 'DELETE', `calendar-events/${e.id}`));
    expectError(await call(owner, 'GET', `calendar-events/${e.id}`), 404, 'EVENT_NOT_FOUND');
    const prisma = await db();
    expect(await prisma.calendarEvent.findUnique({ where: { id: e.id } })).toMatchObject({ isDeleted: true, version: 4, startAt: null });
    expect(await prisma.calendarEventHistory.count({ where: { eventId: e.id } })).toBe(4);
    expect(await prisma.outboxEvent.count({ where: { entityId: e.id } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { entityId: e.id, action: 'CALENDAR_EVENT.DELETED' } })).toBe(1);
  });
  it('validates ranges, timezone and source IDs atomically without inserting or partially updating Events', async () => {
    const c = await calendar(), e = await event(c), foreignCalendar = expectOk(await call(outsider, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Foreign', timezone: 'UTC' } }));
    expectError(await call(owner, 'POST', 'calendar-events', { body: { calendarId: foreignCalendar.id, title: 'No', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } }), 404, 'CALENDAR_NOT_FOUND');
    for (const extra of [{ startAt: '2030-02-30T00:00:00Z' }, { startAt: '2030-01-01T09:00:00' }, { endAt: '2030-03-31T00:00:00Z' }, { startDate: '2030-01-01' }])
      expectError(await call(owner, 'PATCH', `calendar-events/${e.id}`, { body: { title: 'Partial', version: 1, ...extra } }), 400, 'EVENT_INVALID_TIME_RANGE');
    expectError(await call(owner, 'POST', 'calendar-events', { body: { calendarId: c.id, title: 'Bad all-day', isAllDay: true, startDate: '2030-02-30', endDate: '2030-03-03' } }), 400, 'EVENT_ALL_DAY_INVALID');
    expectError(await call(owner, 'PATCH', `calendar-events/${e.id}`, { body: { sourceTimezone: 'Mars', version: 1 } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `calendar-events/${e.id}/attendees`, { body: { attendeeUserIds: [attendee.userId, outsider.userId] } }), 400, 'EVENT_ATTENDEE_INVALID');
    expectError(await call(owner, 'POST', 'calendar-events', { body: { calendarId: c.id, title: 'Wrong organizer', organizerUserId: outsider.userId, startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } }), 400, 'EVENT_ATTENDEE_INVALID');
    expect(await (await db()).calendarEvent.findUnique({ where: { id: e.id } })).toMatchObject({ title: 'Meeting', version: 1 });
    expect(await (await db()).calendarEventAttendee.count({ where: { eventId: e.id } })).toBe(1);
    expect(await (await db()).calendarEvent.count({ where: { calendarId: c.id } })).toBe(1);
  });
  it('authenticates every route and hides Events and their children across workspace boundaries', async () => {
    const e = await event();
    expectError(await call(null, 'GET', `calendar-events/${e.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(attendee, 'GET', `calendar-events/${e.id}`), 404, 'EVENT_NOT_FOUND');
    expectError(await call(attendee, 'POST', 'calendar-events', { body: {} }), 403, 'PERMISSION_DENIED');
    for (const [method, suffix] of [
      ['GET', ''], ['PUT', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/cancel'], ['POST', '/restore'],
      ['GET', '/attendees'], ['POST', '/attendees'], ['DELETE', `/attendees/${owner.userId}`], ['POST', '/respond'],
      ['GET', '/guests'], ['POST', '/guests'], ['DELETE', `/guests/${randomUUID()}`],
      ['GET', '/bindings'], ['POST', '/bindings'], ['DELETE', `/bindings/${randomUUID()}`],
      ['GET', '/meeting-record'], ['PUT', '/meeting-record'], ['POST', '/meeting-decisions'],
    ] as const) expectError(await call(outsider, method, `calendar-events/${e.id}${suffix}`, { body: ['PUT', 'PATCH', 'POST'].includes(method) ? {} : undefined }), 404, 'EVENT_NOT_FOUND');
    expectError(await call(outsider, 'GET', `calendar-events/${e.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    expect(expectOk(await call(outsider, 'GET', 'calendar-events'))).toEqual([]);
  });
  it('adds/removes attendees and persists only their own response without granting Calendar editing access', async () => {
    const c = await calendar(), e = await event(c);
    expectOk(await call(owner, 'POST', `calendar-events/${e.id}/attendees`, { body: { userId: attendee.userId } }));
    expectOk(await call(owner, 'POST', `calendar-events/${e.id}/attendees`, { body: { userId: attendee.userId } }));
    expect(expectOk(await call(attendee, 'GET', `calendar-events/${e.id}/attendees`))).toHaveLength(2);
    expectError(await call(attendee, 'GET', `calendars/${c.id}`), 404, 'CALENDAR_NOT_FOUND');
    expectError(await call(attendee, 'PATCH', `calendar-events/${e.id}`, { body: { title: 'Hijack', version: 2 } }), 403, 'PERMISSION_DENIED');
    expectError(await call(attendee, 'POST', `calendar-events/${e.id}/respond`, { body: { response: 'ACCEPTED', userId: owner.userId } }), 400, 'VALIDATION_ERROR');
    expect(expectOk(await call(attendee, 'POST', `calendar-events/${e.id}/respond`, { body: { response: 'ACCEPTED' } }))).toMatchObject({ userId: attendee.userId, response: 'ACCEPTED' });
    expectOk(await call(attendee, 'POST', `calendar-events/${e.id}/respond`, { body: { response: 'ACCEPTED' } }));
    expect(await (await db()).outboxEvent.count({ where: { entityId: e.id, eventType: 'CALENDAR_ATTENDEE_RESPONDED' } })).toBe(1);
    expectOk(await call(owner, 'DELETE', `calendar-events/${e.id}/attendees/${attendee.userId}`));
    expectError(await call(attendee, 'GET', `calendar-events/${e.id}`), 404, 'EVENT_NOT_FOUND');
    expect(await (await db()).calendarEventAttendee.findFirst({ where: { eventId: e.id, userId: attendee.userId } })).toMatchObject({ response: 'ACCEPTED', removedAt: expect.any(Date) });
  });
  it('enforces edit-own Calendar ACL, cancellation/restore and archived Project read-only state', async () => {
    const c = await calendar({ type: 'COMPANY' });
    expectOk(await call(owner, 'PUT', `calendars/${c.id}/permissions`, { body: { version: 1, permissions: [{ subjectType: 'USER', subjectId: editor.userId, level: 'EDIT_OWN' }] } }));
    const owned = expectOk(await call(editor, 'POST', 'calendar-events', { body: { calendarId: c.id, title: 'Mine', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z', status: 'TENTATIVE' } }));
    const other = await event(c);
    expectError(await call(editor, 'PATCH', `calendar-events/${other.id}`, { body: { title: 'No', version: 1 } }), 403, 'PERMISSION_DENIED');
    expectOk(await call(editor, 'POST', `calendar-events/${owned.id}/cancel`));
    expectOk(await call(editor, 'POST', `calendar-events/${owned.id}/cancel`));
    expectError(await call(editor, 'PATCH', `calendar-events/${owned.id}`, { body: { title: 'No', version: 2 } }), 409, 'EVENT_CANCELLED');
    expect(expectOk(await call(editor, 'POST', `calendar-events/${owned.id}/restore`))).toMatchObject({ status: 'TENTATIVE', cancelledAt: null, version: 3 });
    const p = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Event archive' } }));
    const tool = expectOk(await call(owner, 'POST', `projects/${p.id}/tools/CALENDAR/enable`));
    const pe = await event({ id: tool.linkedResourceId });
    expectOk(await call(owner, 'POST', `projects/${p.id}/archive`));
    expectError(await call(owner, 'PATCH', `calendar-events/${pe.id}`, { body: { title: 'No', version: 1 } }), 409, 'PROJECT_ARCHIVED');
    expectOk(await call(owner, 'POST', `projects/${p.id}/unarchive`));
    expectOk(await call(owner, 'PATCH', `calendar-events/${pe.id}`, { body: { title: 'Allowed', version: 1 } }));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}`));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}/hard`));
    expect(await (await db()).calendarEvent.findUnique({ where: { id: pe.id } })).toMatchObject({ isDeleted: false, calendarId: tool.linkedResourceId });
    expectError(await call(owner, 'PATCH', `calendar-events/${pe.id}`, { body: { title: 'No', version: 2 } }), 409, 'CALENDAR_READ_ONLY');
  });
  it('keeps guest email/token data private and records sensitive guest changes in audit and outbox', async () => {
    const e = await event(undefined, { attendeeUserIds: [attendee.userId] });
    const guest = expectOk(await call(owner, 'POST', `calendar-events/${e.id}/guests`, { body: { email: 'Guest@Example.com', name: 'Guest' } }));
    expect(guest).not.toHaveProperty('inviteTokenHash');
    const prisma = await db();
    await prisma.calendarExternalGuest.update({ where: { id: guest.id }, data: { inviteTokenHash: 'private-hash' } });
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}/guests`))[0]).toMatchObject({ email: 'guest@example.com' });
    expect(JSON.stringify(expectOk(await call(owner, 'GET', `calendar-events/${e.id}/guests`)))).not.toContain('private-hash');
    expectError(await call(attendee, 'GET', `calendar-events/${e.id}/guests`), 403, 'PERMISSION_DENIED');
    expectError(await call(attendee, 'POST', `calendar-events/${e.id}/guests`, { body: { email: 'No@example.com' } }), 403, 'PERMISSION_DENIED');
    expect(expectOk(await call(owner, 'POST', `calendar-events/${e.id}/guests`, { body: { email: 'GUEST@example.com' } })).id).toBe(guest.id);
    expectOk(await call(owner, 'DELETE', `calendar-events/${e.id}/guests/${guest.id}`));
    expect(await prisma.calendarExternalGuest.findUnique({ where: { id: guest.id } })).toMatchObject({ inviteTokenHash: null, removedAt: expect.any(Date) });
    expect(await prisma.outboxEvent.count({ where: { entityId: e.id, eventType: 'CALENDAR_GUEST_INVITED' } })).toBe(1);
    expect((await prisma.auditLog.findMany({ where: { entityId: e.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['CALENDAR_EVENT.GUEST_INVITED', 'CALENDAR_EVENT.GUEST_REMOVED']));
  });
  it('binds readable CRM/Task/Project sources, redacts inaccessible bindings and versions Meeting content', async () => {
    const e = await event(undefined, { attendeeUserIds: [attendee.userId] });
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Source' } }));
    const binding = expectOk(await call(owner, 'POST', `calendar-events/${e.id}/bindings`, { body: { entityType: 'TASK', entityId: task.id } }));
    expect(expectOk(await call(owner, 'POST', `calendar-events/${e.id}/bindings`, { body: { entityType: 'TASK', entityId: task.id } })).id).toBe(binding.id);
    expect(expectOk(await call(attendee, 'GET', `calendar-events/${e.id}/bindings`))).toEqual([]);
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}/bindings`))).toHaveLength(1);
    const authenticated = { token: owner.token, workspaceId: owner.workspaceId };
    const company = expectOk(await api('POST', '/api/v1/crm/companies', { ...authenticated, body: { name: 'Meeting customer' } }));
    const project = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Meeting project' } }));
    const activity = expectOk(await api('POST', '/api/v1/crm/activities', { ...authenticated, body: { typeCode: 'CALL', subject: 'Related customer call' } }));
    for (const [entityType, entityId] of [['COMPANY', company.id], ['PROJECT', project.id], ['ACTIVITY', activity.id]]) {
      expectOk(await call(owner, 'POST', `calendar-events/${e.id}/bindings`, { body: { entityType, entityId } }));
    }
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}/bindings`))).toHaveLength(4);
    expect(expectOk(await call(attendee, 'GET', `calendar-events/${e.id}/bindings`))).toEqual([]);
    const foreignTask = expectOk(await call(outsider, 'POST', 'tasks', { body: { title: 'Foreign' } }));
    expectError(await call(owner, 'POST', `calendar-events/${e.id}/bindings`, { body: { entityType: 'TASK', entityId: foreignTask.id } }), 400, 'EVENT_BINDING_INVALID');
    expectOk(await call(owner, 'DELETE', `calendar-events/${e.id}/bindings/${binding.id}`));
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}/meeting-record`))).toMatchObject({ version: 0, decisions: [] });
    expectOk(await call(owner, 'PUT', `calendar-events/${e.id}/meeting-record`, { body: { agenda: 'Agenda', notes: 'Notes', version: 0 } }));
    expectError(await call(owner, 'PUT', `calendar-events/${e.id}/meeting-record`, { body: { notes: 'Stale', version: 0 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(attendee, 'PUT', `calendar-events/${e.id}/meeting-record`, { body: { notes: 'No', version: 1 } }), 403, 'PERMISSION_DENIED');
    const decision = expectOk(await call(owner, 'POST', `calendar-events/${e.id}/meeting-decisions`, { body: { text: 'Proceed' }, headers: { 'idempotency-key': 'one-decision' } }));
    expect(expectOk(await call(owner, 'POST', `calendar-events/${e.id}/meeting-decisions`, { body: { text: 'Proceed' }, headers: { 'idempotency-key': 'one-decision' } })).id).toBe(decision.id);
    expect(expectOk(await call(attendee, 'GET', `calendar-events/${e.id}/meeting-record`))).toMatchObject({ agenda: 'Agenda', notes: 'Notes', decisions: [{ text: 'Proceed' }] });
    expect(await (await db()).meetingRecord.count({ where: { eventId: e.id } })).toBe(1);
    expect(await (await db()).meetingDecision.count({ where: { eventId: e.id } })).toBe(1);
    expect((await (await db()).auditLog.findMany({ where: { entityId: e.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['CALENDAR_EVENT.MEETING_RECORD_CHANGED', 'CALENDAR_EVENT.MEETING_DECISION_ADDED']));
  });
  it('replays retry keys, rejects payload changes, and replaces expired retry records without unique-key failures', async () => {
    const c = await calendar(), first = await event(c, {}, 'expires-after-window');
    expect((await event(c, {}, 'expires-after-window')).id).toBe(first.id);
    expectError(await call(owner, 'POST', 'calendar-events', { headers: { 'idempotency-key': 'expires-after-window' }, body: {
      calendarId: c.id, title: 'Different', startAt: '2030-03-31T01:00:00+01:00', endAt: '2030-03-31T03:00:00+02:00', sourceTimezone: 'Europe/Berlin',
    } }), 409, 'IDEMPOTENCY_KEY_REUSED');
    const prisma = await db();
    const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, actorUserId: owner.userId,
      operation: 'calendar.event.create', idempotencyKey: 'expires-after-window' } });
    await prisma.idempotencyRecord.update({ where: { id: record.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const next = await event(c, {}, 'expires-after-window');
    expect(next.id).not.toBe(first.id);
    expect(await prisma.idempotencyRecord.count({ where: { workspaceId: owner.workspaceId, actorUserId: owner.userId,
      operation: 'calendar.event.create', idempotencyKey: 'expires-after-window' } })).toBe(1);
    expect(await prisma.calendarEvent.count({ where: { calendarId: c.id } })).toBe(2);
  });

  it('checks File references through the shared port and database guards reject stale/cross-tenant writes', async () => {
    const { appContext } = await import('@/src/server/app-context');
    const fake = new InMemoryFilePort(), fileId = randomUUID(); fake.register(owner.workspaceId, fileId, [attendee.userId]); appContext.setFilePort(fake);
    const c = await calendar(), e = await event(c, { fileIds: [fileId], attendeeUserIds: [attendee.userId] }, 'one-event');
    expect((await event(c, { fileIds: [fileId], attendeeUserIds: [attendee.userId] }, 'one-event')).id).toBe(e.id);
    expect(e.fileIds).toEqual([fileId]);
    expect(expectOk(await call(attendee, 'GET', `calendar-events/${e.id}`)).fileIds).toEqual([]);
    expectOk(await call(owner, 'PATCH', `calendar-events/${e.id}`, { body: { fileIds: [fileId], version: 1 } }));
    expect(await (await db()).calendarEventFile.count({ where: { eventId: e.id } })).toBe(1);
    expectError(await call(owner, 'PATCH', `calendar-events/${e.id}`, { body: { fileIds: [randomUUID()], version: 2 } }), 404, 'FILE_NOT_FOUND');
    const prisma = await db();
    await expect(prisma.calendarEvent.update({ where: { id: e.id }, data: { title: 'Stale' } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.calendarEvent.update({ where: { id: e.id }, data: { organizerUserId: outsider.userId, version: 3 } })).rejects.toThrow('EVENT_ATTENDEE_INVALID');
    await expect(prisma.calendarEvent.update({ where: { id: e.id }, data: { startAt: new Date('2035-01-01'), version: 3 } })).rejects.toThrow('calendar_events_range_chk');
    await expect(prisma.calendarEventAttendee.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, eventId: e.id, userId: outsider.userId } })).rejects.toThrow('EVENT_ATTENDEE_INVALID');
    await expect(prisma.calendarEventAttendee.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, eventId: e.id, userId: attendee.userId } })).rejects.toMatchObject({ code: 'P2002' });
    const foreignTask = expectOk(await call(outsider, 'POST', 'tasks', { body: { title: 'Guarded foreign' } }));
    await expect(prisma.calendarEventBinding.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, eventId: e.id, entityType: 'TASK', entityId: foreignTask.id, createdByUserId: owner.userId, createdAt: new Date() } })).rejects.toThrow('EVENT_BINDING_INVALID');
    const localTask = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Historical source' } }));
    const binding = expectOk(await call(owner, 'POST', `calendar-events/${e.id}/bindings`, { body: { entityType: 'TASK', entityId: localTask.id } }));
    await expect(prisma.calendarEventBinding.update({ where: { id: binding.id }, data: { entityId: foreignTask.id } })).rejects.toThrow('EVENT_BINDING_INVALID');
    expectOk(await call(owner, 'PUT', `calendar-events/${e.id}/meeting-record`, { body: { notes: 'Historical notes', version: 0 } }));
    const record = await prisma.meetingRecord.findUniqueOrThrow({ where: { eventId: e.id } });
    await expect(prisma.meetingRecord.update({ where: { id: record.id }, data: { notes: 'Lost update' } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.meetingRecord.create({ data: { ...record, id: randomUUID() } })).rejects.toMatchObject({ code: 'P2002' });
    expectOk(await call(owner, 'DELETE', `tasks/${localTask.id}`));
    expectOk(await call(owner, 'DELETE', `tasks/${localTask.id}/hard`));
    expect(await prisma.calendarEventBinding.findUnique({ where: { id: binding.id } })).toMatchObject({ entityId: localTask.id });
    expect(expectOk(await call(owner, 'GET', `calendar-events/${e.id}/bindings`))).toEqual([]);
    await expect(prisma.calendarEvent.delete({ where: { id: e.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.calendarEvent.count({ where: { calendarId: c.id } })).toBe(1);
  });
});
