import { randomUUID } from 'node:crypto';
import { api } from '@/tests/support/api';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);
let owner: Session, reader: Session, outsider: Session;
beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('calendar-owner');
  reader = await member(owner, 'calendar-reader', [
    ['calendar.read', 'OWN'], ['calendar.create', 'OWN'], ['calendar.update', 'OWN'],
    ['calendar.delete', 'OWN'], ['calendar.permission_manage', 'OWN'], ['project.read', 'OWN'],
  ]);
  outsider = await register('calendar-outsider');
});
afterAll(disconnect);
async function calendar(extra: Record<string, unknown> = {}) {
  return expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'COMPANY', name: 'Calendar', timezone: 'UTC', ...extra } }));
}
async function grant(id: string, permissions: unknown[], version = 1) {
  return expectOk(await call(owner, 'PUT', `calendars/${id}/permissions`, { body: { permissions, version } }));
}
async function department(session: Session, name: string) {
  return expectOk(await api('POST', '/api/v1/departments', { token: session.token, workspaceId: session.workspaceId, body: { name } }));
}

describe('Calendar HTTP/PostgreSQL contract', () => {
  it('exposes CRUD with optimistic versions, immutable type and persisted outbox/audit', async () => {
    const c = await calendar({ description: 'Original', colorPreference: '#123456' });
    expect(expectOk(await call(owner, 'GET', 'calendars')).some((row: any) => row.id === c.id)).toBe(true);
    expect(expectOk(await call(owner, 'GET', `calendars/${c.id}`))).toMatchObject({ type: 'COMPANY', version: 1, effectiveLevel: 'MANAGE' });
    const patched = expectOk(await call(owner, 'PATCH', `calendars/${c.id}`, { body: { name: 'Changed' }, headers: { 'if-match': '"1"' } }));
    expect(patched).toMatchObject({ name: 'Changed', description: 'Original', version: 2 });
    expectError(await call(owner, 'PATCH', `calendars/${c.id}`, { body: { name: 'Stale', version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(owner, 'PATCH', `calendars/${c.id}`, { body: { type: 'PERSONAL', version: 2 } }), 400, 'VALIDATION_ERROR');
    const replaced = expectOk(await call(owner, 'PUT', `calendars/${c.id}`, { body: { name: 'Replaced', timezone: 'Africa/Cairo', version: 2 } }));
    expect(replaced).toMatchObject({ description: null, colorPreference: null, version: 3 });
    expectOk(await call(owner, 'DELETE', `calendars/${c.id}`));
    expectError(await call(owner, 'GET', `calendars/${c.id}`), 404, 'CALENDAR_NOT_FOUND');
    const prisma = await db();
    expect(await prisma.calendar.findUnique({ where: { id: c.id } })).toMatchObject({ isDeleted: true, version: 4 });
    expect((await prisma.outboxEvent.findMany({ where: { entityId: c.id } })).map((row) => row.eventType)).toEqual(['CALENDAR_CREATED', 'CALENDAR_UPDATED', 'CALENDAR_UPDATED', 'CALENDAR_UPDATED']);
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'CALENDAR.DELETED' } })).toBe(1);
  });
  it('enforces authentication, private discovery, management levels and every tenant boundary', async () => {
    const c = await calendar({ type: 'PERSONAL' });
    expectError(await call(null, 'GET', 'calendars', { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(reader, 'GET', `calendars/${c.id}`), 404, 'CALENDAR_NOT_FOUND');
    expect(expectOk(await call(reader, 'GET', 'calendars')).some((row: any) => row.id === c.id)).toBe(false);
    await grant(c.id, [{ subjectType: 'USER', subjectId: reader.userId, level: 'VIEW' }]);
    expect(expectOk(await call(reader, 'GET', `calendars/${c.id}`)).effectiveLevel).toBe('VIEW');
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      expectError(await call(reader, method, `calendars/${c.id}`, { body: method === 'DELETE' ? undefined : { version: 2 } }), 403, 'PERMISSION_DENIED');
    }
    expectError(await call(reader, 'GET', `calendars/${c.id}/permissions`), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'PUT', `calendars/${c.id}/permissions`, { body: { permissions: [], version: 2 } }), 403, 'PERMISSION_DENIED');
    for (const [method, suffix] of [
      ['GET', ''], ['PUT', ''], ['PATCH', ''], ['DELETE', ''],
      ['GET', '/permissions'], ['PUT', '/permissions'], ['GET', '/preferences'], ['PATCH', '/preferences'],
    ] as const) expectError(await call(outsider, method, `calendars/${c.id}${suffix}`, { body: ['PUT', 'PATCH'].includes(method) ? { version: 2 } : undefined }), 404, 'CALENDAR_NOT_FOUND');
    expectError(await call(outsider, 'GET', `calendars/${c.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    expectError(await call(reader, 'POST', 'calendars', { body: { type: 'COMPANY', name: 'Denied', timezone: 'UTC' } }), 403, 'PERMISSION_DENIED');
  });
  it('replaces permission sets atomically, persists audit and isolates each user preference version', async () => {
    const c = await calendar();
    expect(expectOk(await call(owner, 'GET', `calendars/${c.id}/permissions`)).permissions).toEqual([]);
    await grant(c.id, [{ subjectType: 'WORKSPACE', level: 'VIEW' }]);
    await grant(c.id, [{ subjectType: 'USER', subjectId: reader.userId.toUpperCase(), level: 'MANAGE' }], 2);
    expect(expectOk(await call(reader, 'GET', `calendars/${c.id}`)).effectiveLevel).toBe('MANAGE');
    expectOk(await call(reader, 'PATCH', `calendars/${c.id}`, { body: { description: 'Delegate', version: 3 } }));
    expectError(await call(owner, 'PUT', `calendars/${c.id}/permissions`, { body: { permissions: [], version: 2 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expect(expectOk(await call(reader, 'GET', `calendars/${c.id}/preferences`))).toMatchObject({ version: 0, isVisible: true });
    expect(expectOk(await call(reader, 'PATCH', `calendars/${c.id}/preferences`, { body: { colorPreference: '#abc', isVisible: false, version: 0 } }))).toMatchObject({ version: 1, isVisible: false });
    expectOk(await call(owner, 'PATCH', `calendars/${c.id}/preferences`, { body: { colorPreference: '#123456' } }));
    expect(expectOk(await call(owner, 'GET', `calendars/${c.id}/preferences`))).toMatchObject({ colorPreference: '#123456', isVisible: true, version: 1 });
    expectOk(await call(reader, 'PATCH', `calendars/${c.id}/preferences`, { body: { isVisible: true, version: 1 } }));
    expectError(await call(reader, 'PATCH', `calendars/${c.id}/preferences`, { body: { isVisible: false, version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    const prisma = await db();
    expect(await prisma.calendarPermission.count({ where: { calendarId: c.id } })).toBe(1);
    expect(await prisma.userCalendarPreference.count({ where: { calendarId: c.id } })).toBe(2);
    expect(await prisma.calendar.findUnique({ where: { id: c.id } })).toMatchObject({ version: 4 });
    expect(await prisma.outboxEvent.count({ where: { entityId: c.id, eventType: 'CALENDAR_PERMISSION_CHANGED' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'CALENDAR.PERMISSIONS_CHANGED' } })).toBe(2);
  });
  it('rejects invalid inputs and cross-tenant targets without partial state changes', async () => {
    const c = await calendar();
    expectError(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Foreign', timezone: 'UTC', ownerUserId: outsider.userId } }), 400, 'CALENDAR_INVALID_OWNER');
    const foreignDepartment = await department(outsider, 'Foreign');
    expectError(await call(owner, 'POST', 'calendars', { body: { type: 'DEPARTMENT', name: 'Foreign', timezone: 'UTC', departmentId: foreignDepartment.id } }), 404, 'DEPARTMENT_NOT_FOUND');
    const foreignProject = expectOk(await call(outsider, 'POST', 'projects', { body: { name: 'Foreign' } }));
    expectError(await call(owner, 'POST', 'calendars', { body: { type: 'PROJECT', name: 'Foreign', timezone: 'UTC', projectId: foreignProject.id } }), 404, 'PROJECT_NOT_FOUND');
    for (const permissions of [
      [{ subjectType: 'USER', subjectId: outsider.userId, level: 'VIEW' }],
      [{ subjectType: 'DEPARTMENT', subjectId: foreignDepartment.id, level: 'VIEW' }],
      [{ subjectType: 'ROLE', subjectId: randomUUID(), level: 'VIEW' }],
      [{ subjectType: 'PROJECT_ROLE', subjectId: 'MEMBER', level: 'VIEW' }],
      [{ subjectType: 'WORKSPACE', level: 'VIEW' }, { subjectType: 'WORKSPACE', level: 'CREATE' }],
    ]) expectError(await call(owner, 'PUT', `calendars/${c.id}/permissions`, { body: { permissions, version: 1 } }), 400, 'CALENDAR_PERMISSION_INVALID');
    expectError(await call(owner, 'PATCH', `calendars/${c.id}`, { body: { name: 'Invalid', timezone: 'Mars/Olympus', version: 1 } }), 400, 'CALENDAR_INVALID_TIMEZONE');
    expectError(await call(owner, 'PATCH', `calendars/${c.id}/preferences`, { body: { colorPreference: 'red' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: '', timezone: 'UTC' } }), 400, 'VALIDATION_ERROR');
    expect(await (await db()).calendar.findUnique({ where: { id: c.id } })).toMatchObject({ name: 'Calendar', version: 1 });
    expect(await (await db()).calendarPermission.count({ where: { calendarId: c.id } })).toBe(0);
  });
  it('derives department access from current membership persisted through the owning service', async () => {
    const d = await department(owner, 'Calendar department');
    const c = await calendar({ type: 'DEPARTMENT', departmentId: d.id });
    expectError(await call(reader, 'GET', `calendars/${c.id}`), 404, 'CALENDAR_NOT_FOUND');
    const { runStateUnit } = await import('@/src/server/response');
    const { appContext } = await import('@/src/server/app-context');
    await runStateUnit(() => appContext.departments.addMembers(appContext.store.state.users.find((row) => row.id === owner.userId)!, owner.workspaceId, d.id, [reader.userId]));
    expect(expectOk(await call(reader, 'GET', `calendars/${c.id}`)).effectiveLevel).toBe('CREATE');
    await runStateUnit(() => appContext.departments.removeMember(appContext.store.state.users.find((row) => row.id === owner.userId)!, owner.workspaceId, d.id, reader.userId));
    expectError(await call(reader, 'GET', `calendars/${c.id}`), 404, 'CALENDAR_NOT_FOUND');
  });
  it('provisions one canonical Project Calendar and preserves it read-only after project hard deletion', async () => {
    const p = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Calendar project' } }));
    const prisma = await db();
    expect(await prisma.calendar.count({ where: { projectId: p.id } })).toBe(0);
    const tool = expectOk(await call(owner, 'POST', `projects/${p.id}/tools/CALENDAR/enable`));
    expect(expectOk(await call(owner, 'POST', `projects/${p.id}/tools/CALENDAR/enable`)).linkedResourceId).toBe(tool.linkedResourceId);
    const id = tool.linkedResourceId;
    expect(await prisma.calendar.count({ where: { projectId: p.id } })).toBe(1);
    expectOk(await call(owner, 'POST', `projects/${p.id}/members`, { body: { userId: reader.userId } }));
    expect(expectOk(await call(reader, 'GET', `calendars/${id}`)).effectiveLevel).toBe('CREATE');
    await grant(id, [{ subjectType: 'USER', subjectId: reader.userId, level: 'VIEW' }]);
    expectOk(await call(owner, 'DELETE', `projects/${p.id}/members/${reader.userId}`));
    expect(expectOk(await call(reader, 'GET', `calendars/${id}`)).effectiveLevel).toBe('VIEW');
    const version = expectOk(await call(owner, 'GET', `calendars/${id}`)).version;
    expectOk(await call(owner, 'POST', `projects/${p.id}/archive`));
    expectError(await call(owner, 'PATCH', `calendars/${id}`, { body: { name: 'Denied', version } }), 409, 'PROJECT_ARCHIVED');
    expectOk(await call(owner, 'POST', `projects/${p.id}/unarchive`));
    const current = expectOk(await call(owner, 'GET', `calendars/${id}`));
    expectOk(await call(owner, 'PATCH', `calendars/${id}`, { body: { name: 'Preserved', version: current.version } }));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}`));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}/hard`));
    expect(await prisma.calendar.findUnique({ where: { id } })).toMatchObject({ projectId: null, isReadOnly: true, isDeleted: false, name: 'Preserved' });
    expectError(await call(owner, 'PATCH', `calendars/${id}`, { body: { name: 'Denied', version: 6 } }), 409, 'CALENDAR_READ_ONLY');
    expect(await prisma.calendarPermission.count({ where: { calendarId: id } })).toBe(1);
  });
  it('protects database invariants for concurrent versions, canonical calendars and polymorphic subjects', async () => {
    const c = await calendar();
    const prisma = await db();
    await expect(prisma.calendar.update({ where: { id: c.id }, data: { name: 'Lost update' } })).rejects.toThrow('RESOURCE_VERSION_CONFLICT');
    await expect(prisma.calendar.update({ where: { id: c.id }, data: { ownerUserId: outsider.userId, version: 2 } })).rejects.toThrow('CALENDAR_USER_TENANT_INVALID');
    await expect(prisma.calendarPermission.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, calendarId: c.id, subjectType: 'USER', subjectId: outsider.userId, level: 'VIEW' } })).rejects.toThrow('CALENDAR_PERMISSION_INVALID');
    await grant(c.id, [{ subjectType: 'WORKSPACE', level: 'VIEW' }]);
    await expect(prisma.calendarPermission.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, calendarId: c.id, subjectType: 'WORKSPACE', subjectId: null, level: 'VIEW' } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.userCalendarPreference.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, calendarId: c.id, userId: outsider.userId, createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow('CALENDAR_USER_TENANT_INVALID');
    const p = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Unique Calendar' } }));
    const pc = await calendar({ type: 'PROJECT', projectId: p.id });
    const { id: _id, effectiveLevel: _level, preferences: _preferences, ...data } = pc;
    await expect(prisma.calendar.create({ data: { ...data, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() } })).rejects.toMatchObject({ code: 'P2002' });
    expect(expectOk(await call(owner, 'GET', `projects/${p.id}/tools`)).find((row: any) => row.toolType === 'CALENDAR')).toMatchObject({ isEnabled: false, linkedResourceId: pc.id });
    expectOk(await call(owner, 'DELETE', `projects/${p.id}`));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}/hard`));
    expect(await prisma.calendar.findUnique({ where: { id: pc.id } })).toMatchObject({ projectId: null, isReadOnly: true });
  });
});
