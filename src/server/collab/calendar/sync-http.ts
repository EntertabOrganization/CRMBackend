import { NextResponse, type NextRequest } from 'next/server';
import { AppError, isAppError } from '../../errors';
import { readJson } from '../../request';
import { fail, ok, runStateUnit } from '../../response';
import { requireWorkspaceContext } from '../../route-helpers';
import { listed, type CollabRouter } from '../http';
import { Body } from '../support';
import type { CalendarSyncService, SyncOutcome } from './sync-service';

export function calendarSyncRoutes(router: CollabRouter, sync: () => CalendarSyncService) {
  router.get('calendar-sync/connections', r => listed(sync().list(r.actor, r.query)))
    .post('calendar-sync/connections/ics/import', r => sync().importIcs(r.actor, r.body))
    .get('calendar-sync/connections/:id', r => sync().get(r.actor, r.params.id))
    .delete('calendar-sync/connections/:id', r => sync().disconnect(r.actor, r.params.id, r.body))
    .get('calendar-sync/connections/:id/mappings', r => listed(sync().mappings(r.actor, r.params.id, r.query)))
    .get('calendar-sync/conflicts', r => listed(sync().conflicts(r.actor, r.query)))
    .get('calendar-sync/conflicts/:id', r => sync().getConflict(r.actor, r.params.id))
    .post('calendar-sync/conflicts/:id/resolve', r => sync().resolve(r.actor, r.params.id, r.body));
  const protect = async (task: () => Promise<unknown>) => {
    let response;
    try { response = ok(await task()); } catch (error) { response = fail(error); }
    response.headers.set('Cache-Control', 'private, no-store'); return response;
  };
  const actorOf = async (request: NextRequest) => (await requireWorkspaceContext(request)).actor;
  // Authorization-code exchange runs between state units; nothing is committed unless the broker returns a credential reference.
  for (const provider of ['GOOGLE', 'MICROSOFT'] as const)
    router.staged('POST', `calendar-sync/connections/${provider.toLowerCase()}`, request => protect(async () => {
      await runStateUnit(() => actorOf(request));
      const raw = await readJson<Record<string, unknown>>(request, 64 * 1024);
      const ticket = await runStateUnit(async () => sync().reserveConnect(await actorOf(request), provider, new Body(raw)));
      let result;
      try { result = await sync().exchange(ticket, request.signal); }
      catch (error) {
        if (isAppError(error) && error.code === 'CALENDAR_SYNC_AUTH_REQUIRED') throw new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'The provider rejected the authorization code.', 400);
        throw new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'The calendar provider is unavailable.', 502);
      }
      return runStateUnit(async () => sync().completeConnect(await actorOf(request), ticket, result));
    }));
  // Sync: lease + snapshot commit first; provider pull/push outside state units; failures are committed visibly.
  router.staged('POST', 'calendar-sync/connections/:id/sync', (request, params) => protect(async () => {
    await runStateUnit(() => actorOf(request));
    const raw = await readJson<Record<string, unknown>>(request, 64 * 1024);
    const ticket = await runStateUnit(async () => sync().prepareSync(await actorOf(request), params.id, new Body(raw)));
    let outcome: SyncOutcome;
    try { outcome = await sync().exchangeChanges(ticket, request.signal); }
    catch (error) {
      const code = isAppError(error) ? error.code : 'CALENDAR_SYNC_PROVIDER_ERROR';
      await runStateUnit(() => sync().failSync(ticket, code));
      throw code === 'CALENDAR_SYNC_AUTH_REQUIRED' ? new AppError(code, 'The calendar provider rejected the stored authorization. Reconnect it.', 409)
        : new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'The calendar provider is unavailable. Retry later.', 502);
    }
    try { return await runStateUnit(async () => { await actorOf(request); return sync().applySync(ticket, outcome); }); }
    catch (error) {
      await runStateUnit(() => sync().failSync(ticket, isAppError(error) ? error.code : 'CALENDAR_SYNC_PROVIDER_ERROR'));
      throw error;
    }
  }));
  router.staged('GET', 'calendar-sync/ics/export', request => (async () => {
    try {
      const exported = await runStateUnit(async () => sync().exportIcs(await actorOf(request), request.nextUrl.searchParams));
      return new NextResponse(exported.content, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${exported.filename}"`, 'x-content-type-options': 'nosniff' } });
    } catch (error) { const response = fail(error); response.headers.set('Cache-Control', 'private, no-store'); return response; }
  })());
}
