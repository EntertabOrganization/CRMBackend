import { createHash, randomUUID } from 'node:crypto';
import { expectAppError } from '@/tests/support/domain';
import type { CallMediaProvider } from '@/src/server/collab/communication/call-provider';
import { b, collabApp, perms } from '../support/domain';

const CALLER = perms('WORKSPACE', 'call.create', 'call.read', 'call.join', 'call.end', 'call.external_invite', 'chat.read', 'chat.create', 'chat.message_send');
function fakeProvider() {
  const rooms = new Map<string, string>();
  let failing = false;
  const provider: CallMediaProvider = { name: 'FAKE',
    async createRoom(request) {
      if (failing) throw new Error('SFU down');
      if (!rooms.has(request.callId)) rooms.set(request.callId, `room-${rooms.size + 1}`);
      return { roomId: rooms.get(request.callId)! };
    },
    participantAccess(roomId, participantId, displayName, expiresAt) { return { joinUrl: `https://media.example/join/${roomId}`, token: `${roomId}:${participantId}:${displayName}`, expiresAt }; } };
  return { provider, rooms, fail: (value: boolean) => { failing = value; } };
}
async function fixture() {
  const c = await collabApp(), calls = c.collab.communication.calls, media = fakeProvider();
  calls.configure(media.provider);
  const alice = await c.memberActor('alice', CALLER), bob = await c.memberActor('bob', CALLER);
  const chat = c.collab.communication.chats.createGroup(alice, b({ title: 'Standup', memberUserIds: [bob.user.id] }));
  return { c, calls, media, alice, bob, chat };
}

it('Provider start failure.', async () => {
  const x = await fixture();
  x.media.fail(true);
  const error = await expectAppError(() => x.calls.start(x.alice, b({ chatId: x.chat.id }), 'start-1'), 'CALL_PROVIDER_ERROR', 502);
  const failed = x.c.state.calls.find(row => row.id === error.details.callId)!;
  expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'CALL_PROVIDER_ERROR', providerRoomId: null });
  // History survives: participants of the linked Chat still see the failed call.
  expect(x.calls.list(x.bob, new URLSearchParams()).data.map(row => [row.id, row.status])).toEqual([[failed.id, 'FAILED']]);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CALL_FAILED')).toHaveLength(1);
  expect(x.c.state.auditLogs.filter(row => row.action === 'CALL.PROVIDER_FAILED')).toHaveLength(1);
  await expectAppError(() => x.calls.join(x.bob, failed.id, b()), 'CALL_INVALID_STATE', 409);
  // A retry with the same key reports the same failed call instead of creating another.
  await expectAppError(() => x.calls.start(x.alice, b({ chatId: x.chat.id }), 'start-1'), 'CALL_PROVIDER_ERROR', 502);
  expect(x.c.state.calls).toHaveLength(1);
  // Provider room creation is idempotent per call.
  x.media.fail(false);
  const started = await x.calls.start(x.alice, b({ chatId: x.chat.id }), 'start-2');
  expect(started).toMatchObject({ status: 'RINGING', providerRoomId: 'room-1', participant: { role: 'HOST', status: 'JOINED' } });
  expect((await x.calls.start(x.alice, b({ chatId: x.chat.id }), 'start-2')).id).toBe(started.id);
  expect(x.media.rooms.size).toBe(1);
  expect(x.calls.join(x.bob, started.id, b()).call.status).toBe('ACTIVE');
});

it('End retry.', async () => {
  const x = await fixture(), call = await x.calls.start(x.alice, b({ chatId: x.chat.id }));
  x.calls.join(x.bob, call.id, b());
  await expectAppError(() => x.calls.end(x.bob, call.id, b()), 'PERMISSION_DENIED', 403);
  const ended = x.calls.end(x.alice, call.id, b());
  expect(ended).toMatchObject({ status: 'ENDED', endedByUserId: x.alice.user.id, joinedCount: 0 });
  expect(x.calls.end(x.alice, call.id, b())).toEqual(ended);
  expect(x.calls.end(x.bob, call.id, b()).status).toBe('ENDED');
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CALL_ENDED')).toHaveLength(1);
  await expectAppError(() => x.calls.cancel(x.alice, call.id, b()), 'CALL_INVALID_STATE', 409);
  await expectAppError(() => x.calls.join(x.bob, call.id, b()), 'CALL_INVALID_STATE', 409);
  // Cancel is for ringing calls and is idempotent; the last participant leaving ends an active call.
  const ringing = await x.calls.start(x.alice, b({ chatId: x.chat.id }));
  expect(x.calls.cancel(x.alice, ringing.id, b()).status).toBe('CANCELLED');
  expect(x.calls.cancel(x.alice, ringing.id, b()).status).toBe('CANCELLED');
  await expectAppError(() => x.calls.end(x.alice, ringing.id, b()), 'CALL_INVALID_STATE', 409);
  const active = await x.calls.start(x.alice, b({ chatId: x.chat.id }));
  x.calls.join(x.bob, active.id, b());
  x.calls.leave(x.alice, active.id, b());
  expect(x.calls.leave(x.bob, active.id, b()).status).toBe('ENDED');
});

it('External token access scope.', async () => {
  const x = await fixture(), call = await x.calls.start(x.alice, b({ chatId: x.chat.id, title: 'Vendor sync' }));
  x.c.collab.communication.messages.send(x.alice, x.chat.id, b({ clientMessageId: 'secret', body: 'Internal pricing' }));
  await expectAppError(() => x.calls.inviteExternal(x.bob, call.id, b({ displayName: 'Vendor' })), 'PERMISSION_DENIED', 403);
  const invitation = x.calls.inviteExternal(x.alice, call.id, b({ displayName: 'Vendor', email: 'Vendor@Example.com' }));
  expect(x.c.state.callInvitations[0].tokenHash).toBe(createHash('sha256').update(invitation.token).digest('hex'));
  const joined = x.calls.joinExternal(invitation.token, b({ displayName: 'Vendor Rep' }));
  // The guest receives media access only: no Chat id, history, member directory or Workspace data.
  expect(Object.keys(joined).sort()).toEqual(['access', 'callId', 'callType', 'participantId', 'title']);
  expect(JSON.stringify(joined)).not.toContain(x.chat.id);
  expect(JSON.stringify(joined)).not.toContain('Internal pricing');
  expect(x.calls.joinExternal(invitation.token, b()).participantId).toBe(joined.participantId);
  expect(x.calls.participants(x.alice, call.id, new URLSearchParams()).data.find(row => row.role === 'GUEST')).toMatchObject({ userId: null, displayName: 'Vendor Rep', status: 'JOINED' });
  // Tokens are scoped to this live call: wrong tokens, other calls and ended calls are rejected.
  await expectAppError(() => x.calls.joinExternal('x'.repeat(43), b()), 'CALL_EXTERNAL_TOKEN_INVALID', 404);
  x.calls.end(x.alice, call.id, b());
  await expectAppError(() => x.calls.joinExternal(invitation.token, b()), 'CALL_EXTERNAL_TOKEN_INVALID', 404);
  // Members outside the linked Chat cannot see the call at all.
  const outsider = await x.c.memberActor('outsider', CALLER);
  await expectAppError(() => x.calls.get(outsider, call.id), 'CALL_NOT_FOUND', 404);
  await expectAppError(() => x.calls.start(outsider, b({ chatId: x.chat.id })), 'CALL_ACCESS_DENIED', 403);
  const foreign = await x.c.foreignActor();
  await expectAppError(() => x.calls.get(foreign, call.id), 'CALL_NOT_FOUND', 404);
});

it('Recording permission.', async () => {
  const x = await fixture();
  await expectAppError(() => x.calls.start(x.alice, b({ chatId: x.chat.id, recordingEnabled: true })), 'CALL_INVALID_STATE', 409);
  x.c.state.workspaces.find(row => row.id === x.c.owner.workspaceId)!.settings.callRecordingEnabled = true;
  const call = await x.calls.start(x.alice, b({ chatId: x.chat.id, recordingEnabled: true }));
  const objects = new Map<string, Buffer>(), bytes = Buffer.from('recorded media'), checksum = createHash('sha256').update(bytes).digest('hex');
  const f = x.c.collab.files;
  f.uploads.configure({ async putImmutable(key, data) { objects.set(key, data); }, async read(key) { return objects.get(key)!; } }, { async process() { return { scanStatus: 'CLEAN', processed: true }; } });
  const storage = f.storages.createStorage(x.c.owner, b({ type: 'COMPANY', name: 'Recordings' })), root = f.storages.root(x.c.owner, storage.id);
  const session = f.uploads.create(x.c.owner, b({ targetFolderId: root.id, desiredFileName: 'call.webm', mimeType: 'video/webm', expectedSizeBytes: bytes.length, expectedChecksum: checksum, idempotencyKey: randomUUID() }));
  await f.uploads.part(x.c.owner, session.id, b({ partNumber: 1, checksum, dataBase64: bytes.toString('base64') }));
  const fileId = (await f.uploads.complete(x.c.owner, session.id, b())).resultFileId!;
  await expectAppError(() => x.calls.end(x.alice, call.id, b({ recordingFileId: fileId })), 'CALL_ACCESS_DENIED', 403);
  const grant = (key: string) => x.c.state.rolePermissions.push({ id: randomUUID(), roleId: x.alice.role.id, permissionId: x.c.state.permissions.find(row => row.key === key)!.id, scope: 'WORKSPACE', isDeleted: false });
  for (const key of ['file.read', 'file.download', 'storage.read', 'folder.read', 'call.recording_read']) grant(key);
  x.calls.end(x.alice, call.id, b({ recordingFileId: fileId }));
  expect(x.c.state.calls.find(row => row.id === call.id)).toMatchObject({ status: 'ENDED', recordingFileId: fileId });
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CALL_RECORDING_AVAILABLE')).toHaveLength(1);
  // Reading the recording needs call.recording_read plus normal File download authority.
  await expectAppError(() => x.calls.recording(x.bob, call.id, new URLSearchParams()), 'PERMISSION_DENIED', 403);
  const auditor = await x.c.memberActor('auditor', [...CALLER, ...perms('WORKSPACE', 'call.recording_read')]);
  await expectAppError(() => x.calls.recording(auditor, call.id, new URLSearchParams()), 'CALL_NOT_FOUND', 404);
  const priorSecret = process.env.FILE_DELIVERY_SECRET;
  process.env.FILE_DELIVERY_SECRET = 'test-delivery-signing-secret-with-32-bytes';
  try { expect(await x.calls.recording(x.alice, call.id, new URLSearchParams())).toMatchObject({ callId: call.id, fileId, deliveryPath: expect.stringContaining('/api/v1/file-delivery/') }); }
  finally { if (priorSecret === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = priorSecret; }
  const plain = await x.calls.start(x.alice, b({ chatId: x.chat.id }));
  await expectAppError(() => x.calls.end(x.alice, plain.id, b({ recordingFileId: fileId })), 'CALL_INVALID_STATE', 409);
  await expectAppError(() => x.calls.recording(x.alice, plain.id, new URLSearchParams()), 'CALL_RECORDING_NOT_FOUND', 404);
});
