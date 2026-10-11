import type { NextRequest } from 'next/server';
import { readJson } from '../../request';
import { fail, ok, runStateUnit } from '../../response';
import { requireWorkspaceContext } from '../../route-helpers';
import { listed, type CollabRouter } from '../http';
import { Body } from '../support';
import type { DocumentEditingService, EditStartTicket } from './editing-service';

export function editingRoutes(router: CollabRouter, editing: () => DocumentEditingService) {
  router.get('files/:id/edit-sessions', r => listed(editing().list(r.actor, r.params.id, r.query)))
    .get('edit-sessions/:id', r => editing().get(r.actor, r.params.id))
    .post('edit-sessions/:id/heartbeat', r => editing().heartbeat(r.actor, r.params.id, r.body))
    .post('edit-sessions/:id/abort', r => editing().abort(r.actor, r.params.id, r.body));
  const protect = async (task: () => Promise<unknown>) => {
    let response;
    try { response = ok(await task()); } catch (error) { response = fail(error); }
    response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('Referrer-Policy', 'no-referrer'); return response;
  };
  const authenticated = <T>(request: NextRequest, task: (actor: Awaited<ReturnType<typeof requireWorkspaceContext>>['actor']) => T | Promise<T>) =>
    runStateUnit(async () => task((await requireWorkspaceContext(request)).actor));
  router.staged('POST', 'files/:id/edit-sessions', (request, params) => protect(async () => {
    let ticket: EditStartTicket | undefined;
    try {
      ticket = await authenticated(request, async actor => editing().reserve(actor, params.id, new Body(await readJson<Record<string, unknown>>(request, 65536))));
      const opened = await editing().open(ticket, request.signal);
      const metadata = await authenticated(request, actor => editing().activate(actor, ticket!));
      return { ...metadata, editorUrl: opened.editorUrl, ...('dataBase64' in opened ? { dataBase64: opened.dataBase64 } : {}),
        ...(ticket.lockToken ? { lockToken: ticket.lockToken } : {}) };
    } catch (error) {
      if (ticket) await runStateUnit(async () => editing().compensate(ticket!));
      throw error;
    }
  }));
  router.staged('POST', 'edit-sessions/:id/complete', (request, params) => protect(async () => {
    const ticket = await authenticated(request, async actor => editing().beginSave(actor, params.id,
      new Body(await readJson<Record<string, unknown>>(request, 140 * 1024 * 1024))));
    if (ticket.completed) return ticket.completed;
    const result = await editing().saveContent(ticket, request.signal);
    await authenticated(request, actor => editing().stageSave(actor, params.id, ticket.hash, result, ticket.lockToken));
    for (let offset = 0, part = 1; offset < result.bytes.length; offset += 4 * 1024 * 1024, part++) {
      const bytes = result.bytes.subarray(offset, offset + 4 * 1024 * 1024);
      await authenticated(request, actor => editing().writePart(actor, params.id, ticket.hash, part, bytes, ticket.lockToken));
    }
    return authenticated(request, actor => editing().finishSave(actor, params.id, ticket.hash, ticket.lockToken));
  }));
}
