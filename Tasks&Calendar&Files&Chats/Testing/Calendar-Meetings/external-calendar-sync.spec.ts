import { expectAppError } from '@/tests/support/domain';
import { AppError } from '@/src/server/errors';
import type { CalendarSyncProvider } from '@/src/server/collab/calendar/sync-provider';
import type { ExternalCalendarEvent } from '@/src/server/collab/calendar/sync-types';
import { b, collabApp } from '../support/domain';

function fakeBroker() {
  const remote = new Map<string, ExternalCalendarEvent>(), keys = new Map<string, string>();
  let mode: 'OK' | 'DOWN' | 'REVOKED' = 'OK', counter = 0;
  const guard = () => { if (mode === 'DOWN') throw new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'down', 502); if (mode === 'REVOKED') throw new AppError('CALENDAR_SYNC_AUTH_REQUIRED', 'revoked', 401); };
  const provider: CalendarSyncProvider = {
    async connect() { guard(); return { credentialRef: 'cred-1', externalCalendarId: 'primary', accountEmail: 'me@example.com' }; },
    async pull() { guard(); return { events: [...remote.values()].map(event => ({ ...event })), nextCursor: `cursor-${++counter}` }; },
    async push(input) {
      guard();
      const existing = keys.get(input.idempotencyKey);
      if (existing) return { externalEventId: existing, etag: remote.get(existing)!.etag };
      const id = input.externalEventId ?? `ext-${remote.size + 1}`, etag = `etag-${++counter}`;
      remote.set(id, { ...input.event, externalEventId: id, etag, origin: input.event.origin } as ExternalCalendarEvent);
      keys.set(input.idempotencyKey, id);
      return { externalEventId: id, etag };
    } };
  const external = (id: string, title: string, extra: Partial<ExternalCalendarEvent> = {}) =>
    remote.set(id, { externalEventId: id, etag: `etag-${++counter}`, status: 'CONFIRMED', title, description: null, location: null, isAllDay: false,
      startAt: '2030-03-04T09:00:00Z', endAt: '2030-03-04T10:00:00Z', startDate: null, endDate: null, sourceTimezone: 'UTC', ...extra });
  return { provider, remote, external, setMode: (next: typeof mode) => { mode = next; } };
}
async function fixture() {
  const c = await collabApp(), sync = c.collab.calendar.sync, broker = fakeBroker();
  sync.configure(broker.provider);
  const calendar = c.collab.calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Work', timezone: 'Europe/Berlin' }));
  const ticket = sync.reserveConnect(c.owner, 'GOOGLE', b({ calendarId: calendar.id, authorizationCode: 'code', redirectUri: 'https://app.example/callback' }));
  const connection = sync.completeConnect(c.owner, ticket, await sync.exchange(ticket));
  const run = () => sync.sync(c.owner, connection.id, b());
  const events = () => c.state.calendarEvents.filter(row => row.calendarId === calendar.id && !row.isDeleted);
  return { c, sync, broker, calendar, connection, run, events };
}

it('Provider retry.', async () => {
  const x = await fixture();
  x.broker.external('g-1', 'Board meeting');
  x.broker.setMode('DOWN');
  await expectAppError(() => x.run(), 'CALENDAR_SYNC_PROVIDER_ERROR', 502);
  expect(x.c.state.calendarSyncConnections[0]).toMatchObject({ lastError: 'CALENDAR_SYNC_PROVIDER_ERROR', failureCount: 1, claimId: null, status: 'ACTIVE' });
  expect(x.events()).toHaveLength(0);
  x.broker.setMode('OK');
  expect((await x.run()).result).toMatchObject({ created: 1 });
  // Repeated sync never creates duplicate Events.
  expect((await x.run()).result).toMatchObject({ created: 0, skipped: 1 });
  expect(x.events()).toHaveLength(1);
  expect(x.c.state.calendarSyncMappings).toHaveLength(1);
  expect(x.c.state.outboxEvents.filter(row => row.eventType === 'CALENDAR_SYNC_FAILED')).toHaveLength(1);
  // Overlapping runs are fenced by the lease.
  const ticket = x.sync.prepareSync(x.c.owner, x.connection.id, b());
  await expectAppError(() => x.run(), 'CALENDAR_SYNC_IN_PROGRESS', 409);
  x.sync.failSync(ticket, 'CALENDAR_SYNC_PROVIDER_ERROR');
});

it('Echo loop prevention.', async () => {
  const x = await fixture();
  const local = x.c.collab.calendar.events.create(x.c.owner, b({ calendarId: x.calendar.id, title: 'Planning', startAt: '2030-03-05T09:00:00Z', endAt: '2030-03-05T10:00:00Z' }));
  expect((await x.run()).result).toMatchObject({ pushed: 1, created: 0 });
  // The pushed event comes back from the provider on the next pull and is recognised as our own write.
  expect((await x.run()).result).toMatchObject({ pushed: 0, created: 0, updated: 0, skipped: 1 });
  expect(x.events()).toHaveLength(1);
  expect(x.c.state.calendarEvents.find(row => row.id === local.id)!.version).toBe(local.version);
  // Inbound changes are applied without being pushed back.
  const mapping = x.c.state.calendarSyncMappings[0];
  x.broker.remote.set(mapping.externalEventId, { ...x.broker.remote.get(mapping.externalEventId)!, title: 'Planning (moved)', etag: 'etag-remote-edit', origin: null });
  expect((await x.run()).result).toMatchObject({ updated: 1, pushed: 0 });
  expect((await x.run()).result).toMatchObject({ updated: 0, pushed: 0 });
  expect(x.c.state.calendarEvents.find(row => row.id === local.id)!.title).toBe('Planning (moved)');
});

it('Concurrent conflict.', async () => {
  const x = await fixture();
  x.broker.external('g-2', 'Review');
  await x.run();
  const local = x.events()[0], mapping = x.c.state.calendarSyncMappings[0];
  x.c.collab.calendar.events.update(x.c.owner, local.id, b({ title: 'Review (local)', version: local.version }));
  x.broker.remote.set('g-2', { ...x.broker.remote.get('g-2')!, title: 'Review (remote)', etag: 'etag-both' });
  expect((await x.run()).result).toMatchObject({ conflicts: 1, updated: 0, pushed: 0 });
  // Neither side is overwritten while the conflict is open; it stays visible across syncs.
  expect(x.c.state.calendarEvents.find(row => row.id === local.id)!.title).toBe('Review (local)');
  expect(x.broker.remote.get('g-2')!.title).toBe('Review (remote)');
  await x.run();
  const [conflict] = x.sync.conflicts(x.c.owner, new URLSearchParams({ status: 'OPEN' })).data;
  expect(conflict).toMatchObject({ mappingId: mapping.id, localSnapshotJson: { title: 'Review (local)' }, externalSnapshotJson: { title: 'Review (remote)' } });
  expect(x.c.state.calendarSyncConflicts).toHaveLength(1);
  // Choosing LOCAL pushes the local version on the next run.
  x.sync.resolve(x.c.owner, conflict.id, b({ resolution: 'LOCAL' }));
  expect((await x.run()).result).toMatchObject({ pushed: 1 });
  expect(x.broker.remote.get('g-2')!.title).toBe('Review (local)');
  await expectAppError(() => x.sync.resolve(x.c.owner, conflict.id, b({ resolution: 'EXTERNAL' })), 'CALENDAR_SYNC_CONFLICT', 409);
  expect(x.c.state.auditLogs.filter(row => row.action === 'CALENDAR_SYNC.CONFLICT_RESOLVED')).toHaveLength(1);
});

it('Token revoked/provider unavailable.', async () => {
  const x = await fixture();
  x.broker.setMode('REVOKED');
  await expectAppError(() => x.run(), 'CALENDAR_SYNC_AUTH_REQUIRED', 409);
  expect(x.sync.get(x.c.owner, x.connection.id)).toMatchObject({ status: 'AUTH_REQUIRED', lastError: 'CALENDAR_SYNC_AUTH_REQUIRED' });
  await expectAppError(() => x.run(), 'CALENDAR_SYNC_AUTH_REQUIRED', 409);
  // Credential references are never projected.
  expect(JSON.stringify(x.sync.get(x.c.owner, x.connection.id))).not.toContain('cred-1');
  expect(JSON.stringify(x.sync.list(x.c.owner, new URLSearchParams()))).not.toContain('cred-1');
  expect(x.sync.disconnect(x.c.owner, x.connection.id, b()).status).toBe('DISCONNECTED');
  expect(x.c.state.calendarSyncCredentials[0].revokedAt).not.toBeNull();
  const foreign = await x.c.foreignActor();
  await expectAppError(() => x.sync.get(foreign, x.connection.id), 'CALENDAR_SYNC_CONNECTION_NOT_FOUND', 404);
});

it('imports ICS idempotently with timezones and recurrence, and exports readable Events', async () => {
  const x = await fixture();
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:standup@example.com', 'DTSTART;TZID=Europe/Berlin:20300304T090000', 'DTEND;TZID=Europe/Berlin:20300304T091500',
    'SUMMARY:Standup\\, daily', 'RRULE:FREQ=DAILY;COUNT=5', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:holiday@example.com', 'DTSTART;VALUE=DATE:20300401', 'SUMMARY:Holiday', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:override@example.com', 'RECURRENCE-ID:20300305T080000Z', 'DTSTART:20300305T080000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const first = x.sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: ics, sourceName: 'team' }));
  expect(first.result).toMatchObject({ created: 2 });
  expect(first.warnings.map(row => row.code)).toEqual(['RECURRENCE_OVERRIDE_UNSUPPORTED']);
  const standup = x.events().find(row => row.title === 'Standup, daily')!;
  expect(standup.startAt!.toISOString()).toBe('2030-03-04T08:00:00.000Z');
  expect(standup.recurrenceRuleId).not.toBeNull();
  expect(x.events().find(row => row.title === 'Holiday')).toMatchObject({ isAllDay: true, startDate: '2030-04-01', endDate: '2030-04-02' });
  expect(x.sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: ics, sourceName: 'team' })).result).toMatchObject({ created: 0, skipped: 2 });
  await expectAppError(() => x.sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x' })), 'ICS_IMPORT_INVALID', 400);
  await expectAppError(() => x.sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: 'hello' })), 'ICS_IMPORT_INVALID', 400);
  await expectAppError(() => x.sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Mars/Olympus:20300101T090000\r\nEND:VEVENT\r\nEND:VCALENDAR' })), 'ICS_IMPORT_INVALID', 400);
  const exported = x.sync.exportIcs(x.c.owner, new URLSearchParams({ calendarId: x.calendar.id, from: '2030-01-01T00:00:00Z', to: '2030-12-31T00:00:00Z' }));
  expect(exported.eventCount).toBe(2);
  expect(exported.content).toContain('SUMMARY:Standup\\, daily');
  expect(exported.content).toContain('DTSTART;TZID=Europe/Berlin:20300304T090000');
  expect(exported.content).toContain('RRULE:FREQ=DAILY;COUNT=5');
  expect(exported.content).toContain('DTSTART;VALUE=DATE:20300401');
  const outsider = await x.c.memberActor('outsider', [['calendar_sync.read', 'WORKSPACE'], ['calendar.read', 'WORKSPACE']]);
  await expectAppError(() => x.sync.exportIcs(outsider, new URLSearchParams({ calendarId: x.calendar.id })), 'CALENDAR_NOT_FOUND', 404);
});
