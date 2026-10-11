import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api } from '@/tests/support/api';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);

const brokerToken = randomUUID(), prior = { url: process.env.CALENDAR_SYNC_BROKER_URL, token: process.env.CALENDAR_SYNC_BROKER_TOKEN };
let server: Server, failure = 0, etag = 'v1', title = 'Provider Event';
const pushed = new Map<string, { externalEventId: string; etag: string }>();
beforeAll(async () => {
 await prepareCollabDatabase();
 server = createServer((request, response) => {
  let body = ''; request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
   if (failure || request.headers.authorization !== `Bearer ${brokerToken}`) { response.writeHead(failure || 401); response.end(); return; }
   const payload = JSON.parse(body), connectionId = payload.connectionId;
   let result;
   if (request.url === '/connect') result = { connectionId, credentialRef: 'vault-reference', externalCalendarId: 'primary', accountEmail: 'account@example.com' };
   else if (request.url === '/pull') result = { connectionId, nextCursor: etag, events: [{ externalEventId: 'remote-1', etag, title, status: 'CONFIRMED', description: null, location: null,
    isAllDay: false, startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z', startDate: null, endDate: null, sourceTimezone: 'UTC' }] };
   else if (request.url === '/push') {
    const key = String(request.headers['idempotency-key']);
    if (!pushed.has(key)) pushed.set(key, { externalEventId: payload.externalEventId ?? `local-${payload.event.localEventId}`, etag: `push-${payload.event.localVersion}` });
    result = { connectionId, ...pushed.get(key) };
   } else { response.writeHead(404); response.end(); return; }
   response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 process.env.CALENDAR_SYNC_BROKER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.CALENDAR_SYNC_BROKER_TOKEN = brokerToken;
 const { appContext } = await import('@/src/server/app-context');
 const { EnvironmentCalendarSyncProvider } = await import('@/src/server/collab/calendar/sync-provider');
 appContext.collab.calendar.sync.configure(new EnvironmentCalendarSyncProvider());
});
afterAll(async () => {
 for (const [key, value] of Object.entries({ CALENDAR_SYNC_BROKER_URL: prior.url, CALENDAR_SYNC_BROKER_TOKEN: prior.token })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 if (server) await new Promise(resolve => server.close(resolve)); await disconnect();
});
beforeEach(() => { failure = 0; etag = 'v1'; title = 'Provider Event'; });
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:import-1\r\nDTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261103\r\nSUMMARY:Imported\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
async function fixture(label = 'sync') {
 const owner = await register(label), prisma = await db();
 const calendar = expectOk(await call(owner, 'POST', 'calendars', { body: { type: 'PERSONAL', name: 'Sync', timezone: 'UTC' } }));
 const connectBody = { calendarId: calendar.id, authorizationCode: 'secret-code', redirectUri: 'https://crm.example/callback' };
 const connection = expectOk(await call(owner, 'POST', 'calendar-sync/connections/google', { body: connectBody }));
 const sync = () => call(owner, 'POST', `calendar-sync/connections/${connection.id}/sync`, { body: {} });
 return { owner, prisma, calendar, connectBody, connection, sync };
}

it('exposes and enforces representative Google/Microsoft, ICS and mapping routes', async () => {
 const x = await fixture();
 expect(expectOk(await call(x.owner, 'POST', 'calendar-sync/connections/microsoft', { body: x.connectBody })).provider).toBe('MICROSOFT');
 expect(expectOk(await call(x.owner, 'GET', 'calendar-sync/connections'))).toHaveLength(2);
 expect(expectOk(await call(x.owner, 'GET', `calendar-sync/connections/${x.connection.id}`)).id).toBe(x.connection.id);
 expect(expectOk(await x.sync()).result.created).toBe(1);
 expect(expectOk(await x.sync()).result.skipped).toBe(1);
 const mappings = expectOk(await call(x.owner, 'GET', `calendar-sync/connections/${x.connection.id}/mappings`)); expect(mappings).toHaveLength(1);
 expect(await x.prisma.calendarSyncMapping.count({ where: { connectionId: x.connection.id } })).toBe(1);
 const imported = expectOk(await call(x.owner, 'POST', 'calendar-sync/connections/ics/import', { body: { calendarId: x.calendar.id, icsContent: ics } }));
 expect(imported.result.created).toBe(1);
 expect(expectOk(await call(x.owner, 'POST', 'calendar-sync/connections/ics/import', { body: { calendarId: x.calendar.id, icsContent: ics } })).result.skipped).toBe(1);
 const exported = await api('GET', '/api/v1/calendar-sync/[[...path]]', { token: x.owner.token, workspaceId: x.owner.workspaceId, params: { path: ['ics', 'export'] }, query: { calendarId: x.calendar.id } });
 expect(exported.status).toBe(200); expect(String(exported.body)).toContain('BEGIN:VCALENDAR');
 expect(expectOk(await call(x.owner, 'DELETE', `calendar-sync/connections/${x.connection.id}`, { body: {} })).status).toBe('DISCONNECTED');
 expectError(await x.sync(), 404, 'CALENDAR_SYNC_CONNECTION_NOT_FOUND');
 expect(await x.prisma.calendarEvent.count({ where: { calendarId: x.calendar.id } })).toBe(2);
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
 const x = await fixture('sync-auth');
 for (const [method, path] of [['GET', 'calendar-sync/connections'], ['POST', 'calendar-sync/connections/google'], ['POST', 'calendar-sync/connections/microsoft'], ['POST', 'calendar-sync/connections/ics/import'],
  ['GET', 'calendar-sync/ics/export'], ['GET', `calendar-sync/connections/${MISSING_ID}`], ['DELETE', `calendar-sync/connections/${MISSING_ID}`], ['POST', `calendar-sync/connections/${MISSING_ID}/sync`],
  ['GET', `calendar-sync/connections/${MISSING_ID}/mappings`], ['GET', 'calendar-sync/conflicts'], ['GET', `calendar-sync/conflicts/${MISSING_ID}`], ['POST', `calendar-sync/conflicts/${MISSING_ID}/resolve`]] as const)
  expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
 const reader = await member(x.owner, 'sync-reader', [['calendar_sync.read', 'WORKSPACE']]);
 expectError(await call(reader, 'POST', 'calendar-sync/connections/google', { body: x.connectBody }), 403, 'PERMISSION_DENIED');
 expectError(await call(reader, 'POST', `calendar-sync/connections/${x.connection.id}/sync`, { body: {} }), 403, 'PERMISSION_DENIED');
 expect(expectOk(await call(reader, 'GET', 'calendar-sync/connections'))).toEqual([]);
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
 const x = await fixture('sync-tenant'), foreign = await register('sync-foreign');
 for (const suffix of ['', '/mappings']) expectError(await call(foreign, 'GET', `calendar-sync/connections/${x.connection.id}${suffix}`), 404, 'CALENDAR_SYNC_CONNECTION_NOT_FOUND');
 expectError(await call(foreign, 'POST', `calendar-sync/connections/${x.connection.id}/sync`, { body: {} }), 404, 'CALENDAR_SYNC_CONNECTION_NOT_FOUND');
 expectError(await call(foreign, 'DELETE', `calendar-sync/connections/${x.connection.id}`, { body: {} }), 404, 'CALENDAR_SYNC_CONNECTION_NOT_FOUND');
 await expect(x.prisma.calendarSyncConnection.update({ where: { id: x.connection.id }, data: { workspaceId: foreign.workspaceId } })).rejects.toThrow(/CALENDAR_SYNC_MAPPING_INVALID/);
 await x.sync(); const mapping = await x.prisma.calendarSyncMapping.findFirstOrThrow({ where: { connectionId: x.connection.id } });
 await expect(x.prisma.calendarSyncMapping.update({ where: { id: mapping.id }, data: { localEventId: MISSING_ID } })).rejects.toThrow(/CALENDAR_SYNC_MAPPING_INVALID/);
 await expect(x.prisma.calendarSyncMapping.delete({ where: { id: mapping.id } })).rejects.toThrow(/CALENDAR_SYNC_HISTORY_IMMUTABLE/);
});

it('returns stable machine-readable errors and durable provider failure state', async () => {
 const x = await fixture('sync-errors'); failure = 503;
 expectError(await x.sync(), 502, 'CALENDAR_SYNC_PROVIDER_ERROR');
 expect(await x.prisma.calendarSyncConnection.findUniqueOrThrow({ where: { id: x.connection.id } })).toMatchObject({ failureCount: 1, lastError: 'CALENDAR_SYNC_PROVIDER_ERROR', claimId: null });
 failure = 0; expect(expectOk(await x.sync()).result.created).toBe(1); failure = 401;
 expectError(await x.sync(), 409, 'CALENDAR_SYNC_AUTH_REQUIRED');
 expect(await x.prisma.calendarSyncConnection.findUniqueOrThrow({ where: { id: x.connection.id } })).toMatchObject({ status: 'AUTH_REQUIRED', claimId: null }); failure = 0;
 expectError(await call(x.owner, 'POST', 'calendar-sync/connections/google', { body: { ...x.connectBody, redirectUri: 'http://evil.example' } }), 400, 'VALIDATION_ERROR');
 expectError(await call(x.owner, 'POST', 'calendar-sync/connections/ics/import', { body: { calendarId: x.calendar.id, icsContent: 'bad' } }), 400, 'ICS_IMPORT_INVALID');
 expectError(await call(x.owner, 'GET', `calendar-sync/connections/${MISSING_ID}`), 404, 'CALENDAR_SYNC_CONNECTION_NOT_FOUND');
});

it('persists conflicts, resolutions, critical state and outbox/audit consistently', async () => {
 const x = await fixture('sync-conflict'); await x.sync();
 const mapping = await x.prisma.calendarSyncMapping.findFirstOrThrow({ where: { connectionId: x.connection.id } });
 const event = expectOk(await call(x.owner, 'GET', `events/${mapping.localEventId}`));
 expectOk(await call(x.owner, 'PATCH', `events/${event.id}`, { body: { title: 'Local edit', version: event.version } })); etag = 'v2'; title = 'Remote edit';
 expect(expectOk(await x.sync()).result.conflicts).toBe(1);
 const conflicts = expectOk(await call(x.owner, 'GET', 'calendar-sync/conflicts')); expect(conflicts).toHaveLength(1);
 const conflict = expectOk(await call(x.owner, 'GET', `calendar-sync/conflicts/${conflicts[0].id}`));
 const foreign = await register('sync-conflict-foreign'); expectError(await call(foreign, 'GET', `calendar-sync/conflicts/${conflict.id}`), 404, 'CALENDAR_SYNC_CONFLICT_NOT_FOUND');
 expectOk(await call(x.owner, 'POST', `calendar-sync/conflicts/${conflict.id}/resolve`, { body: { resolution: 'EXTERNAL', version: conflict.version } }));
 expect(expectOk(await call(x.owner, 'GET', `events/${event.id}`)).title).toBe('Remote edit');
 await expect(x.prisma.calendarSyncConflict.update({ where: { id: conflict.id }, data: { status: 'OPEN', resolution: null, resolvedAt: null, resolvedByUserId: null } })).rejects.toThrow(/CALENDAR_SYNC_HISTORY_IMMUTABLE/);
 expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'CALENDAR_SYNC_CONFLICT_RESOLVED' } })).toBe(1);
 expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'CALENDAR_SYNC.CONFLICT_RESOLVED' } })).toBe(1);
 expect(JSON.stringify(expectOk(await call(x.owner, 'GET', `calendar-sync/connections/${x.connection.id}`)))).not.toContain('vault-reference');
 expect(JSON.stringify(await x.prisma.auditLog.findMany({ where: { workspaceId: x.owner.workspaceId } }))).not.toContain('secret-code');
 expectOk(await call(x.owner, 'DELETE', `calendar-sync/connections/${x.connection.id}`, { body: {} }));
 expect((await x.prisma.calendarSyncCredential.findFirstOrThrow({ where: { connectionId: x.connection.id } })).revokedAt).toBeInstanceOf(Date);
 await expect(x.prisma.calendarSyncConnection.update({ where: { id: x.connection.id }, data: { status: 'ACTIVE' } })).rejects.toThrow(/CALENDAR_SYNC_MAPPING_INVALID/);
});
