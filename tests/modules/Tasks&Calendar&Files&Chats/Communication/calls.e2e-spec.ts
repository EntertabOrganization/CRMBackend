import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api } from '@/tests/support/api';
import { MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
jest.setTimeout(180000);

const brokerToken = randomUUID(), prior = { url: process.env.CALL_PROVIDER_URL, token: process.env.CALL_PROVIDER_TOKEN };
const rooms = new Map<string, string>(), keys: string[] = [];
let failing = false, server: Server;
beforeAll(async () => {
  await prepareCollabDatabase();
  server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${brokerToken}` || request.url !== '/rooms' || failing) { response.writeHead(failing ? 503 : 401); response.end(); return; }
      const { callId } = JSON.parse(body) as { callId: string };
      keys.push(String(request.headers['idempotency-key']));
      if (!rooms.has(callId)) rooms.set(callId, `room-${rooms.size + 1}`);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ callId, roomId: rooms.get(callId) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.CALL_PROVIDER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.CALL_PROVIDER_TOKEN = brokerToken;
  const { appContext } = await import('@/src/server/app-context');
  const { EnvironmentCallProvider } = await import('@/src/server/collab/communication/call-provider');
  appContext.collab.communication.calls.configure(new EnvironmentCallProvider());
});
afterAll(async () => {
  for (const [key, value] of Object.entries({ CALL_PROVIDER_URL: prior.url, CALL_PROVIDER_TOKEN: prior.token })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await new Promise(resolve => server.close(resolve)); await disconnect();
});

const CALLER = ['call.create', 'call.read', 'call.join', 'call.end', 'call.external_invite', 'chat.read'].map(key => [key, 'WORKSPACE'] as [string, 'WORKSPACE']);
async function fixture(label = 'calls') {
  const owner = await register(label), prisma = await db(), bob = await member(owner, `${label}-bob`, CALLER);
  const chat = expectOk(await call(owner, 'POST', 'chats', { body: { title: 'Standup', memberUserIds: [bob.userId] } }));
  const start = (session = owner, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => call(session, 'POST', 'calls', { body: { chatId: chat.id, ...body }, headers });
  const guestJoin = (token: string, body: Record<string, unknown> = {}) => api('POST', '/api/v1/public/calls/[[...path]]', { params: { path: [token, 'join'] }, body });
  return { owner, bob, prisma, chat, start, guestJoin };
}

it('exposes and enforces representative routes: POST   /api/v1/calls; GET    /api/v1/calls; GET    /api/v1/calls/:id; POST   /api/v1/calls/:id/join', async () => {
  const x = await fixture();
  const results = await Promise.all([x.start(x.owner, {}, { 'idempotency-key': 'call-start' }), x.start(x.owner, {}, { 'idempotency-key': 'call-start' })]);
  const started = expectOk(results[0]); expect(expectOk(results[1]).id).toBe(started.id);
  expect(started).toMatchObject({ status: 'RINGING', providerRoomId: expect.stringMatching(/^room-/), access: { token: expect.any(String) } });
  expect(keys.filter(key => key === `call-room:${started.id}`).length).toBeGreaterThanOrEqual(1);
  expect(await x.prisma.communicationCall.count({ where: { workspaceId: x.owner.workspaceId } })).toBe(1);
  expect(expectOk(await call(x.bob, 'GET', 'calls')).map((row: { id: string }) => row.id)).toEqual([started.id]);
  const joined = expectOk(await call(x.bob, 'POST', `calls/${started.id}/join`, { body: {} }));
  expect(joined.call.status).toBe('ACTIVE');
  expect(expectOk(await call(x.owner, 'GET', `calls/${started.id}/participants`))).toHaveLength(2);
  const invitation = expectOk(await call(x.owner, 'POST', `calls/${started.id}/external-invitations`, { body: { displayName: 'Vendor' } }));
  const guest = expectOk(await x.guestJoin(invitation.token, { displayName: 'Vendor rep' }));
  expect(Object.keys(guest).sort()).toEqual(['access', 'callId', 'callType', 'participantId', 'title']);
  expectOk(await call(x.bob, 'POST', `calls/${started.id}/leave`, { body: {} }));
  expect(expectOk(await call(x.owner, 'POST', `calls/${started.id}/end`, { body: {} })).status).toBe('ENDED');
  expect(expectOk(await call(x.owner, 'POST', `calls/${started.id}/end`, { body: {} })).status).toBe('ENDED');
  expectError(await x.guestJoin(invitation.token), 404, 'CALL_EXTERNAL_TOKEN_INVALID');
  const ringing = expectOk(await x.start());
  expect(expectOk(await call(x.owner, 'POST', `calls/${ringing.id}/cancel`, { body: {} })).status).toBe('CANCELLED');
  expect(expectOk(await call(x.owner, 'GET', `calls/${ringing.id}`)).status).toBe('CANCELLED');
  expectError(await call(x.owner, 'GET', `calls/${started.id}/recording`), 404, 'CALL_RECORDING_NOT_FOUND');
  expectError(await call(x.bob, 'GET', `calls/${started.id}/recording`), 403, 'PERMISSION_DENIED');
});

it('requires authenticated/authorized workspace context for protected endpoints', async () => {
  const x = await fixture('calls-auth'), id = MISSING_ID;
  for (const [method, path] of [['POST', 'calls'], ['GET', 'calls'], ['GET', `calls/${id}`], ['POST', `calls/${id}/join`], ['POST', `calls/${id}/leave`], ['POST', `calls/${id}/end`],
    ['POST', `calls/${id}/cancel`], ['GET', `calls/${id}/participants`], ['POST', `calls/${id}/external-invitations`], ['GET', `calls/${id}/recording`]] as const)
    expectError(await call(null, method, path, { body: method === 'GET' ? undefined : {} }), 401);
  const reader = await member(x.owner, 'call-reader', [['call.read', 'WORKSPACE'], ['chat.read', 'WORKSPACE']]);
  expectError(await x.start(reader), 403, 'PERMISSION_DENIED');
  const started = expectOk(await x.start());
  expectError(await call(x.bob, 'POST', `calls/${started.id}/end`, { body: {} }), 403, 'PERMISSION_DENIED');
  expectError(await call(x.bob, 'POST', `calls/${started.id}/external-invitations`, { body: { displayName: 'x' } }), 403, 'PERMISSION_DENIED');
  expectError(await call(reader, 'GET', `calls/${started.id}`), 404, 'CALL_NOT_FOUND');
});

it('rejects cross-workspace resource access without leaking resource existence', async () => {
  const x = await fixture('calls-tenant'), foreign = await register('calls-foreign'), started = expectOk(await x.start());
  expectError(await call(foreign, 'GET', `calls/${started.id}`), 404, 'CALL_NOT_FOUND');
  expectError(await call(foreign, 'POST', `calls/${started.id}/join`, { body: {} }), 404, 'CALL_NOT_FOUND');
  expectError(await call(foreign, 'POST', 'calls', { body: { chatId: x.chat.id } }), 403, 'CALL_ACCESS_DENIED');
  expectError(await call(foreign, 'POST', 'calls', { body: { inviteeUserIds: [x.owner.userId] } }), 403, 'CALL_ACCESS_DENIED');
  // Independent SQL guards: tenant-composite links, one-way lifecycle, no deletes.
  await expect(x.prisma.communicationCall.update({ where: { id: started.id }, data: { chatId: MISSING_ID } })).rejects.toThrow();
  expectOk(await call(x.owner, 'POST', `calls/${started.id}/end`, { body: {} }));
  await expect(x.prisma.communicationCall.update({ where: { id: started.id }, data: { status: 'ACTIVE', endedAt: null } })).rejects.toThrow(/CALL_INVALID_STATE/);
  await expect(x.prisma.communicationCall.delete({ where: { id: started.id } })).rejects.toThrow(/CALL_HISTORY_IMMUTABLE/);
  await expect(x.prisma.communicationCallParticipant.create({ data: { id: randomUUID(), workspaceId: x.owner.workspaceId, callId: started.id, userId: foreign.userId, role: 'PARTICIPANT',
    status: 'JOINED', joinedAt: new Date() } })).rejects.toThrow(/CALL_INVALID_STATE/);
});

it('returns stable machine-readable error envelopes for invalid requests', async () => {
  const x = await fixture('calls-errors');
  failing = true;
  try {
    const failed = await x.start();
    const error = expectError(failed, 502, 'CALL_PROVIDER_ERROR');
    expect(await x.prisma.communicationCall.findUniqueOrThrow({ where: { id: error.details.callId } })).toMatchObject({ status: 'FAILED', errorCode: 'CALL_PROVIDER_ERROR' });
    expect(expectOk(await call(x.bob, 'GET', `calls/${error.details.callId}`)).status).toBe('FAILED');
  } finally { failing = false; }
  expectError(await x.start(x.owner, { callType: 'HOLOGRAM' }), 400, 'VALIDATION_ERROR');
  expectError(await x.start(x.owner, { recordingEnabled: true }), 409, 'CALL_INVALID_STATE');
  expectError(await x.start(x.owner, { collabId: MISSING_ID }), 400, 'VALIDATION_ERROR');
  expectError(await call(x.owner, 'GET', `calls/${MISSING_ID}`), 404, 'CALL_NOT_FOUND');
  expectError(await x.guestJoin('a'.repeat(43)), 404, 'CALL_EXTERNAL_TOKEN_INVALID');
  const ended = expectOk(await x.start());
  expectOk(await call(x.owner, 'POST', `calls/${ended.id}/end`, { body: {} }));
  expectError(await call(x.owner, 'POST', `calls/${ended.id}/cancel`, { body: {} }), 409, 'CALL_INVALID_STATE');
  expectError(await call(x.owner, 'POST', `calls/${ended.id}/external-invitations`, { body: { displayName: 'Late' } }), 409, 'CALL_INVALID_STATE');
});

it('persists critical state and outbox/audit consistently on successful mutation', async () => {
  const x = await fixture('calls-outbox'), started = expectOk(await x.start());
  for (const type of ['CALL_STARTED', 'CALL_PARTICIPANT_JOINED'])
    expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: type, entityId: started.id } })).toBe(1);
  const invitation = expectOk(await call(x.owner, 'POST', `calls/${started.id}/external-invitations`, { body: { displayName: 'Vendor', email: 'vendor@example.com' } }));
  const stored = await x.prisma.communicationCallInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  expect(JSON.stringify(stored)).not.toContain(invitation.token);
  expect(await x.prisma.auditLog.count({ where: { workspaceId: x.owner.workspaceId, action: 'CALL.EXTERNAL_INVITED', entityId: started.id } })).toBe(1);
  expectOk(await x.guestJoin(invitation.token));
  expect(await x.prisma.communicationCallParticipant.findFirstOrThrow({ where: { callId: started.id, externalGuestId: invitation.id } })).toMatchObject({ role: 'GUEST', userId: null, status: 'JOINED' });
  expectOk(await call(x.owner, 'POST', `calls/${started.id}/end`, { body: {} }));
  expect(await x.prisma.communicationCall.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ status: 'ENDED', endedByUserId: x.owner.userId });
  expect(await x.prisma.outboxEvent.count({ where: { workspaceId: x.owner.workspaceId, eventType: 'CALL_ENDED', entityId: started.id } })).toBe(1);
  expect(await x.prisma.communicationCallParticipant.count({ where: { callId: started.id, status: 'JOINED' } })).toBe(0);
});
