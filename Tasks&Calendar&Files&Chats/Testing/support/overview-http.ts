import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from './e2e';

const configs = {
 tasks: { prefix: 'tasks', body: { title: 'Overview task' }, read: 'task.read', notFound: 'TASK_NOT_FOUND', model: 'task', action: 'TASK.CREATED', event: 'TASK_CREATED' },
 calendar: { prefix: 'calendars', body: { type: 'PERSONAL', name: 'Overview calendar', timezone: 'UTC' }, read: 'calendar.read', notFound: 'CALENDAR_NOT_FOUND', model: 'calendar', action: 'CALENDAR.DELETED', event: 'CALENDAR_UPDATED' },
 files: { prefix: 'file-storages', body: { type: 'PERSONAL', name: 'Overview Drive' }, read: 'storage.read', notFound: 'STORAGE_NOT_FOUND', model: 'projectFileStorage', action: 'STORAGE.CREATED', event: 'STORAGE_CREATED' },
 communication: { prefix: 'chats', body: { title: 'Overview Chat' }, read: 'chat.read', notFound: 'CHAT_NOT_FOUND', model: 'collaborationChat', action: 'CHAT.ARCHIVED', event: 'CHAT_ARCHIVED' },
} as const;

/** Each overview executes real HTTP routes and checks PostgreSQL state, using a fresh Workspace per scenario. */
export function overviewHttpScenarios(domain: keyof typeof configs) {
 jest.setTimeout(180000);
 beforeAll(prepareCollabDatabase); afterAll(disconnect);
 const config = configs[domain];
 const fixture = async () => {
  const owner = await register(`${domain}-overview`), prisma = await db();
  const resource = expectOk(await call(owner, 'POST', config.prefix, { body: config.body }));
  return { owner, prisma, resource, path: `${config.prefix}/${resource.id}` };
 };
 return {
  async 'requires authenticated/authorized workspace context for protected endpoints'() {
   const x = await fixture();
   for (const [method, path] of [['GET', config.prefix], ['GET', x.path], ['POST', config.prefix]] as const)
    expectError(await call(null, method, path, { body: method === 'POST' ? config.body : undefined }), 401, 'UNAUTHENTICATED');
   const reader = await member(x.owner, `${domain}-readonly`, [[config.read, 'WORKSPACE']]);
   expectError(await call(reader, 'POST', config.prefix, { body: config.body }), 403, 'PERMISSION_DENIED');
  },
  async 'rejects cross-workspace resource access without leaking resource existence'() {
   const x = await fixture(), foreign = await register(`${domain}-foreign`);
   const actual = expectError(await call(foreign, 'GET', x.path), 404, config.notFound);
   const missing = expectError(await call(foreign, 'GET', `${config.prefix}/${MISSING_ID}`), 404, config.notFound);
   expect(actual.message).toBe(missing.message);
   expect(expectOk(await call(foreign, 'GET', config.prefix)).some((row: { id: string }) => row.id === x.resource.id)).toBe(false);
  },
  async 'returns stable machine-readable error envelopes for invalid requests'() {
   const owner = await register(`${domain}-invalid`);
   const response = await call(owner, 'POST', config.prefix, { body: { ...config.body, invalidProperty: true } });
   expectError(response, 400, 'VALIDATION_ERROR');
   expect(response.body).toMatchObject({ success: false, requestId: expect.any(String), error: { code: 'VALIDATION_ERROR', message: expect.any(String) } });
   expectError(await call(owner, 'GET', `${config.prefix}/${MISSING_ID}`), 404, config.notFound);
  },
  async 'persists critical state and outbox/audit consistently on successful mutation'() {
   const x = await fixture();
   if (domain === 'calendar') expectOk(await call(x.owner, 'DELETE', x.path, { body: {} }));
   if (domain === 'communication') expectOk(await call(x.owner, 'POST', `${x.path}/archive`, { body: { version: x.resource.version } }));
   const delegate = (x.prisma as unknown as Record<string, { findUniqueOrThrow(args: unknown): Promise<{ workspaceId: string; isDeleted?: boolean; status?: string }> }>)[config.model];
   const stored = await delegate.findUniqueOrThrow({ where: { id: x.resource.id } }); expect(stored.workspaceId).toBe(x.owner.workspaceId);
   if (domain === 'calendar') expect(stored.isDeleted).toBe(true);
   if (domain === 'communication') expect(stored.status).toBe('ARCHIVED');
   expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, entityId: x.resource.id, action: config.action } })).toBe(1);
   expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, entityId: x.resource.id, eventType: config.event } })).toBe(1);
  },
 };
}
