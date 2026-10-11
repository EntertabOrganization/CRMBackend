import { readJson } from '../../request';
import { fail, ok, runStateUnit } from '../../response';
import { requireWorkspaceContext } from '../../route-helpers';
import { AppError, isAppError } from '../../errors';
import { listed, type CollabRouter } from '../http';
import { Body } from '../support';
import type { CallService, CallStartTicket } from './call-service';

export function callRoutes(router: CollabRouter, calls: () => CallService) {
  router.get('calls', r => listed(calls().list(r.actor, r.query)))
    .get('calls/:id', r => calls().get(r.actor, r.params.id))
    .post('calls/:id/leave', r => calls().leave(r.actor, r.params.id, r.body))
    .post('calls/:id/end', r => calls().end(r.actor, r.params.id, r.body))
    .post('calls/:id/cancel', r => calls().cancel(r.actor, r.params.id, r.body))
    .get('calls/:id/participants', r => listed(calls().participants(r.actor, r.params.id, r.query)))
    .get('calls/:id/recording', r => calls().recording(r.actor, r.params.id, r.query))
    .publicRoute('POST', 'public/calls/:token/join', r => calls().joinExternal(r.params.token, r.body));
  const protect = async (task: () => Promise<unknown>) => {
    let response;
    try { response = ok(await task()); } catch (error) { response = fail(error); }
    response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('Referrer-Policy', 'no-referrer'); return response;
  };
  // Responses carrying participant media tokens or guest secrets are never cached.
  router.staged('POST', 'calls/:id/join', (request, params) => protect(() => runStateUnit(async () => {
    const { actor } = await requireWorkspaceContext(request);
    return calls().join(actor, params.id, new Body(await readJson<Record<string, unknown>>(request, 64 * 1024)));
  })));
  router.staged('POST', 'calls/:id/external-invitations', (request, params) => protect(() => runStateUnit(async () => {
    const { actor } = await requireWorkspaceContext(request);
    return calls().inviteExternal(actor, params.id, new Body(await readJson<Record<string, unknown>>(request, 64 * 1024)));
  })));
  // Start: reservation commits first, provider I/O runs between state units, and the outcome (room or FAILED) commits after.
  router.staged('POST', 'calls', request => protect(async () => {
    const key = request.headers.get('idempotency-key') ?? undefined;
    const raw = await readJson<Record<string, unknown>>(request, 64 * 1024);
    const ticket: CallStartTicket = await runStateUnit(async () => calls().reserve((await requireWorkspaceContext(request)).actor, new Body(raw), key));
    let roomId: string | undefined;
    if (!ticket.ready) {
      try { roomId = (await calls().openRoom(ticket, request.signal)).roomId; }
      catch (error) {
        await runStateUnit(() => calls().fail(ticket.workspaceId, ticket.callId, isAppError(error) ? error.code : 'CALL_PROVIDER_ERROR'));
        throw new AppError('CALL_PROVIDER_ERROR', 'The call provider is unavailable.', 502, { callId: ticket.callId });
      }
    }
    return runStateUnit(async () => calls().activate((await requireWorkspaceContext(request)).actor, ticket, roomId));
  }));
}
