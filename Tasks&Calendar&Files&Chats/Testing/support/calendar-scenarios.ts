import { randomUUID } from 'node:crypto';
import { AppError } from '@/src/server/errors';
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from './domain';

async function fixture() {
 const c = await collabApp(), cal = c.collab.calendar;
 const calendar = cal.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Overview', timezone: 'Europe/Berlin' }));
 const create = (body: Record<string, unknown> = {}) => cal.events.create(c.owner, b({ calendarId: calendar.id, title: 'Private meeting', startAt: '2030-03-30T09:00:00+01:00', endAt: '2030-03-30T10:00:00+01:00', sourceTimezone: 'Europe/Berlin', ...body }));
 return { c, cal, calendar, create };
}
export const calendarOverviewScenarios = {
 async 'Timezone/all-day semantics.'() {
  const x = await fixture(), timed = x.create();
  expect(timed.startAt).toEqual(new Date('2030-03-30T08:00:00Z'));
  const day = x.cal.events.create(x.c.owner, b({ calendarId: x.calendar.id, title: 'Offsite', isAllDay: true, startDate: '2030-03-30', endDate: '2030-04-01' }));
  expect(day).toMatchObject({ startAt: null, endAt: null, startDate: '2030-03-30', endDate: '2030-04-01' });
  const recurrence = x.cal.recurrence.update(x.c.owner, timed.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', version: 0 }), true)!;
  expect(recurrence.upcoming.map(row => row.startAt!.toISOString())).toEqual(['2030-03-30T08:00:00.000Z', '2030-03-31T07:00:00.000Z', '2030-04-01T07:00:00.000Z']);
 },
 async 'Recurring exception identity.'() {
  const x = await fixture(), event = x.create();
  const rule = x.cal.recurrence.update(x.c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', version: 0 }), true)!;
  const identity = rule.upcoming[1].recurrenceId;
  x.cal.recurrence.editOccurrence(x.c.owner, event.id, identity, b({ startAt: '2030-04-10T10:00:00+02:00', version: rule.version }));
  const next = x.cal.recurrence.get(x.c.owner, event.id)!;
  x.cal.recurrence.cancelOccurrence(x.c.owner, event.id, identity, b({ version: next.version }));
  expect(x.cal.recurrence.get(x.c.owner, event.id)!.upcoming[1]).toMatchObject({ recurrenceId: identity, status: 'CANCELLED', startAt: new Date('2030-04-10T08:00:00Z') });
  expect(x.c.state.calendarRecurrenceExceptions).toHaveLength(1);
 },
 async 'Double-booking races.'() {
  const x = await fixture(), room = x.cal.resources.create(x.c.owner, b({ type: 'ROOM', name: 'Room', timezone: 'Europe/Berlin' }));
  const events = [x.create(), x.create()];
  const results = await Promise.allSettled(events.map(event => Promise.resolve().then(() => x.cal.resources.book(x.c.owner, event.id, b({ resourceId: room.id })))));
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_BOOKING_CONFLICT' } });
  expect(x.c.state.calendarResourceBookings.filter(row => row.status === 'ACTIVE')).toHaveLength(1);
 },
 async 'Public booking privacy.'() {
  const x = await fixture(); x.create();
  const outsider = await x.c.memberActor('free-busy', perms('WORKSPACE', 'calendar.free_busy'));
  const busy = x.cal.availability.freeBusy(outsider, b({ startAt: '2030-03-30T00:00:00Z', endAt: '2030-03-31T00:00:00Z', userIds: [x.c.owner.user.id] }));
  expect(JSON.stringify(busy)).not.toMatch(/Private meeting|title|description|eventId/);
  const page = x.cal.bookingPages.create(x.c.owner, b({ calendarId: x.calendar.id, title: 'Meet us', slug: `overview-${randomUUID()}`, durationMinutes: 30 }));
  x.cal.bookingPages.setRules(x.c.owner, page.id, b({ version: 0, timezone: 'Europe/Berlin', weekly: [{ dayOfWeek: 6, localStartTime: '08:00', localEndTime: '17:00' }] }));
  x.cal.bookingPages.publication(x.c.owner, page.id, b({ version: 2 }), true);
  const publicPage = x.cal.bookingPages.publicView(page.slug);
  expect(JSON.stringify(publicPage)).not.toMatch(/workspaceId|calendarId|Private meeting|tokenHash/);
 },
 async 'Provider sync conflict and retry.'() {
  const x = await fixture(), sync = x.cal.sync; let fails = true;
  sync.configure({ async connect() { return { credentialRef: 'vault', externalCalendarId: 'primary', accountEmail: null }; },
   async pull() { if (fails) throw new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'Unavailable', 502); return { nextCursor: 'c', events: [] }; },
   async push(item) { return { externalEventId: item.externalEventId ?? item.event.localEventId, etag: String(item.event.localVersion) }; } });
  const ticket = sync.reserveConnect(x.c.owner, 'MICROSOFT', b({ calendarId: x.calendar.id, authorizationCode: 'code', redirectUri: 'https://crm.example/callback' }));
  const connection = sync.completeConnect(x.c.owner, ticket, await sync.exchange(ticket)); x.create();
  await expectAppError(() => sync.sync(x.c.owner, connection.id, b()), 'CALENDAR_SYNC_PROVIDER_ERROR', 502); fails = false;
  await sync.sync(x.c.owner, connection.id, b()); await sync.sync(x.c.owner, connection.id, b()); expect(x.c.state.calendarSyncMappings).toHaveLength(1);
  const content = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:conflict\nDTSTART:20300401T100000Z\nDTEND:20300401T110000Z\nSUMMARY:Remote\nEND:VEVENT\nEND:VCALENDAR';
  sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: content }));
  const event = x.c.state.calendarEvents.find(row => row.title === 'Remote')!;
  x.cal.events.update(x.c.owner, event.id, b({ title: 'Local', version: event.version }));
  expect(sync.importIcs(x.c.owner, b({ calendarId: x.calendar.id, icsContent: content.replace('SUMMARY:Remote', 'SUMMARY:Changed') })).result.conflicts).toBe(1);
  expect(event.title).toBe('Local'); expect(x.c.state.calendarSyncConflicts[0].status).toBe('OPEN');
 },
};
