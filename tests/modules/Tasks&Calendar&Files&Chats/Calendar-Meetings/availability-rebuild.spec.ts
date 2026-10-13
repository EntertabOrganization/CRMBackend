import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Private', timezone: 'UTC' }));
  const event = calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Dense', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T09:01:00Z' }));
  calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=SECONDLY;COUNT=3000', sourceTimezone: 'UTC', version: 0 }), true);
  const query = { startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' };
  return { c, calendar, event, query };
}
describe('Durable bounded recurrence availability rebuilds', () => {
  it('rechecks scoped access before reading ready cached coverage', async () => {
    const { c, calendar, query } = await setup();
    const reader = await c.memberActor('cached-own-reader', perms('OWN', 'calendar.free_busy'));
    calendar.availability.freeBusy(c.owner, b(query));
    for (let i = 0; i < 5; i++) calendar.availabilityRebuilds.runOne();
    await expectAppError(() => calendar.availability.freeBusy(reader, b({ ...query, userIds: [c.owner.user.id] })), 'AVAILABILITY_SUBJECT_NOT_FOUND', 404);
  });
  it('keeps valid COUNT ordinals across nonexistent DST occurrences', async () => {
    const { c, calendar } = await setup();
    const event = calendar.events.create(c.owner, b({ calendarId: c.state.calendars[0].id, title: 'DST', sourceTimezone: 'Europe/Berlin',
      startAt: '2030-03-30T02:30:00+01:00', endAt: '2030-03-30T03:30:00+01:00' }));
    calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=3', sourceTimezone: 'Europe/Berlin', version: 0 }), true);
    const range = { startAt: new Date('2030-03-30T00:00:00Z'), endAt: new Date('2030-04-04T00:00:00Z') };
    const root = c.state.calendarEvents.find((row) => row.id === event.id)!;
    const job = calendar.availabilityRebuilds.enqueue(root, range);
    expect(calendar.availabilityRebuilds.runOne()?.status).toBe('READY');
    expect(job.cursorOrdinal).toBe(3);
    expect(calendar.availabilityRebuilds.ready(root, range)?.map((row) => row.startAt.toISOString())).toEqual([
      '2030-03-30T01:30:00.000Z', '2030-04-01T00:30:00.000Z', '2030-04-02T00:30:00.000Z',
    ]);
  });
  it('starts old unbounded dense series at the query window rather than replaying decades', async () => {
    const { c, calendar } = await setup();
    const event = calendar.events.create(c.owner, b({ calendarId: c.state.calendars[0].id, title: 'Old dense', startAt: '2000-01-01T09:00:00Z', endAt: '2000-01-01T09:01:00Z' }));
    calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=SECONDLY', sourceTimezone: 'UTC', version: 0 }), true);
    const query = { startAt: '2090-01-01T09:00:00Z', endAt: '2090-01-01T09:30:00Z' };
    expect(calendar.availability.freeBusy(c.owner, b(query)).pending).toBe(true);
    for (let i = 0; i < 4; i++) calendar.availabilityRebuilds.runOne();
    const result = calendar.availability.freeBusy(c.owner, b(query));
    expect(result.pending).toBe(false);
    expect(result.users[0].busy).toEqual([{ startAt: new Date(query.startAt), endAt: new Date(query.endAt), state: 'BUSY' }]);
  });
  it('resumes bounded pages, deduplicates queries and publishes only complete merged intervals', async () => {
    const { c, calendar, query } = await setup();
    expect(calendar.availability.freeBusy(c.owner, b(query)).pending).toBe(true);
    const job = c.state.calendarAvailabilityRebuilds[0];
    expect(calendar.availabilityRebuilds.runOne()?.status).toBe('PENDING');
    expect(job.cursorOrdinal).toBe(1000);
    expect(calendar.availability.freeBusy(c.owner, b(query))).toMatchObject({ pending: true, users: [] });
    expect(c.state.calendarAvailabilityRebuilds).toHaveLength(1);
    for (let i = 0; i < 5 && job.status !== 'READY'; i++) calendar.availabilityRebuilds.runOne();
    expect(job.status).toBe('READY'); expect(job.cursorOrdinal).toBe(3000);
    const result = calendar.availability.freeBusy(c.owner, b(query));
    expect(result.pending).toBe(false);
    expect(result.users[0].busy).toEqual([{ startAt: new Date(query.startAt), endAt: new Date('2030-01-01T09:50:59Z'), state: 'BUSY' }]);
    expect(calendar.availabilityRebuilds.runOne()).toBeNull();
  });
  it('invalidates results when source versions change and cancels obsolete pending work', async () => {
    const { c, calendar, event, query } = await setup();
    calendar.availability.freeBusy(c.owner, b(query));
    const old = c.state.calendarAvailabilityRebuilds[0];
    calendar.events.update(c.owner, event.id, b({ busyStatus: 'FREE', version: calendar.events.get(c.owner, event.id).version }));
    expect(calendar.availabilityRebuilds.runOne()?.status).toBe('CANCELLED');
    expect(old.busy).toEqual([]);
    expect(calendar.availability.freeBusy(c.owner, b(query)).pending).toBe(true);
    expect(c.state.calendarAvailabilityRebuilds).toHaveLength(2);
    for (let i = 0; i < 5; i++) calendar.availabilityRebuilds.runOne();
    expect(calendar.availability.freeBusy(c.owner, b(query)).users[0].busy).toEqual([]);
  });
  it('retains the last committed page after failure and bounds retries with sanitized errors', async () => {
    const { c, calendar, query } = await setup();
    calendar.availability.freeBusy(c.owner, b(query)); calendar.availabilityRebuilds.runOne();
    const job = c.state.calendarAvailabilityRebuilds[0], before = structuredClone(job.busy), cursor = job.cursorRecurrenceId;
    const spy = jest.spyOn(calendar.recurrence, 'resolveKnown').mockImplementation(() => { throw new Error('secret provider details'); });
    let now = new Date();
    for (let i = 0; i < 3; i++) { expect(calendar.availabilityRebuilds.runOne(now)?.status).toBe('FAILED'); now = new Date(now.getTime() + 120_000); }
    expect(job.busy).toEqual(before); expect(job.cursorRecurrenceId).toBe(cursor);
    expect(job.lastErrorCode).toBe('AVAILABILITY_REBUILD_FAILED'); expect(job.failures).toBe(3);
    expect(calendar.availabilityRebuilds.runOne(now)).toBeNull();
    await expectAppError(() => calendar.availability.freeBusy(c.owner, b(query)), 'AVAILABILITY_UNAVAILABLE', 409);
    spy.mockRestore();
  });
  it('finishes a COUNT-bounded series beyond the synchronous history budget', async () => {
    const { c, calendar, event } = await setup();
    calendar.recurrence.update(c.owner, event.id, b({ rruleText: 'FREQ=DAILY;COUNT=25000', version: 1 }));
    const query = { startAt: '2090-01-01T00:00:00Z', endAt: '2090-01-02T00:00:00Z' };
    expect(calendar.availability.freeBusy(c.owner, b(query)).pending).toBe(true);
    for (let i = 0; i < 30; i++) calendar.availabilityRebuilds.runOne();
    const result = calendar.availability.freeBusy(c.owner, b(query));
    expect(result.pending).toBe(false); expect(result.users[0].busy[0].startAt).toEqual(new Date('2090-01-01T09:00:00Z'));
  });
});
