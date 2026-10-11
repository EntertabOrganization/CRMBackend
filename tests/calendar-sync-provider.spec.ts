import { randomUUID } from 'node:crypto';
import { HttpCalendarSyncProvider, validateExternalEvent } from '@/src/server/collab/calendar/sync-provider';
import { parseIcs, serializeIcs } from '@/src/server/collab/calendar/ics';
import { expectAppError } from './support/domain';
const identity = { workspaceId: randomUUID(), connectionId: randomUUID(), provider: 'GOOGLE' as const, credentialRef: 'vault', externalCalendarId: 'primary', cursor: null };
const event = { externalEventId: 'e', etag: '1', title: 'Event', status: 'CONFIRMED', isAllDay: false, startAt: '2030-01-01T10:00:00Z', endAt: '2030-01-01T11:00:00Z', sourceTimezone: 'UTC' };
afterEach(() => jest.restoreAllMocks());
it('validates provider intervals and strips unrecognized echo fields', async () => {
 expect(validateExternalEvent({ ...event, origin: { connectionId: identity.connectionId, localVersion: 1, accessToken: 'secret' } }).origin).toEqual({ connectionId: identity.connectionId, localVersion: 1 });
 for (const patch of [{ endAt: event.startAt }, { startAt: '2030-01-01T10:00:00' }, { startDate: '2030-01-01' }, { isAllDay: true }, { sourceTimezone: 'Invalid/Zone' }])
  await expectAppError(() => validateExternalEvent({ ...event, ...patch }), 'CALENDAR_SYNC_PROVIDER_ERROR', 502);
});
it('fails closed on redirect, revoked credentials, response identity mismatch and oversized streamed output', async () => {
 const provider = new HttpCalendarSyncProvider('https://broker.example', 'broker-token');
 const fetcher = jest.spyOn(global, 'fetch');
 for (const status of [302, 401, 503]) {
  fetcher.mockResolvedValueOnce(new Response('', { status }));
  await expectAppError(() => provider.pull(identity), status === 401 ? 'CALENDAR_SYNC_AUTH_REQUIRED' : 'CALENDAR_SYNC_PROVIDER_ERROR', status === 401 ? 401 : 502);
 }
 fetcher.mockResolvedValueOnce(Response.json({ connectionId: randomUUID(), events: [], nextCursor: 'c' }));
 await expectAppError(() => provider.pull(identity), 'CALENDAR_SYNC_PROVIDER_ERROR', 502);
 let pulls = 0;
 fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); } })));
 await expectAppError(() => provider.pull(identity), 'CALENDAR_SYNC_PROVIDER_ERROR', 502); expect(pulls).toBeLessThanOrEqual(6);
 fetcher.mockResolvedValueOnce(Response.json({ connectionId: identity.connectionId, events: [event], nextCursor: 'next' }));
 expect((await provider.pull({ ...identity, cursor: 'opaque\r\ncursor' })).events).toHaveLength(1);
 const options = fetcher.mock.calls.at(-1)![1]!;
 expect(options.redirect).toBe('manual'); expect((options.headers as Record<string, string>)['idempotency-key']).toMatch(/^calendar-sync-pull:[a-f0-9-]+:[a-f0-9]{64}$/);
});
it('rejects malformed ICS dates and preserves Unicode text across byte folding', async () => {
 const content = (time: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e\r\nDTSTART:${time}\r\nDTEND:20300301T120000Z\r\nSUMMARY:Event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
 for (const time of ['20300230T100000Z', '20300301T250000Z']) await expectAppError(() => parseIcs(content(time), 'UTC'), 'ICS_IMPORT_INVALID', 400);
 await expectAppError(() => parseIcs(content('20300301T100000Z') + 'SUMMARY:Trailing\r\n', 'UTC'), 'ICS_IMPORT_INVALID', 400);
 const title = 'Title\rInjected:'.repeat(3) + '😀'.repeat(80);
 const text = serializeIcs('Calendar', [{ id: randomUUID(), title, description: null, location: null, status: 'CONFIRMED', isAllDay: false, startAt: new Date('2030-03-01T10:00:00Z'),
  endAt: new Date('2030-03-01T11:00:00Z'), startDate: null, endDate: null, sourceTimezone: 'UTC', updatedAt: new Date(), rrule: null, sequence: 0 }]);
 expect(text.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75)).toBe(true);
 expect(parseIcs(text, 'UTC').events[0].title).toBe(title.replace(/\r/g, '\n'));
 expect(text).not.toContain('\uFFFD');
});
