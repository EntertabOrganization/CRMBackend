import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';
async function setup() {
  const c = await collabApp(), calendar = c.collab.calendar;
  const container = calendar.calendars.create(c.owner, b({ type: 'PERSONAL', name: 'Private', timezone: 'UTC' }));
  const event = () => calendar.events.create(c.owner, b({ calendarId: container.id, title: 'Private salary discussion',
    startAt: '2030-01-07T09:00:00Z', endAt: '2030-01-07T10:00:00Z' }));
  const resource = calendar.resources.create(c.owner, b({ type: 'ROOM', name: 'Room', timezone: 'UTC' }));
  return { ...c, calendar, event, resource };
}
describe('Availability & Resources specification contracts', () => {
  it('keeps private Event details out of free/busy responses', async () => {
    const c = await setup(), reader = await c.memberActor('contract-freebusy', perms('WORKSPACE', 'calendar.free_busy'));
    c.event();
    const response = c.calendar.availability.freeBusy(reader, b({ startAt: '2030-01-07T00:00:00Z', endAt: '2030-01-08T00:00:00Z', userIds: [c.owner.user.id] }));
    expect(response.users[0].busy).toHaveLength(1);
    expect(Object.keys(response.users[0].busy[0]).sort()).toEqual(['endAt', 'startAt', 'state']);
    expect(JSON.stringify(response)).not.toMatch(/salary|title|description|eventId|organizer/);
  });
  it('permits only one competing exclusive reservation in the shared domain state', async () => {
    const c = await setup(), first = c.event(), second = c.event();
    const results = await Promise.allSettled([first, second].map(async (event) => c.calendar.resources.book(c.owner, event.id, b({ resourceId: c.resource.id }))));
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((row) => row.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('RESOURCE_BOOKING_CONFLICT');
  });
  it('rejects disabled resources during both booking and slot selection', async () => {
    const c = await setup(), event = c.event();
    c.calendar.resources.update(c.owner, c.resource.id, b({ isActive: false, version: 1 }));
    await expectAppError(() => c.calendar.resources.book(c.owner, event.id, b({ resourceId: c.resource.id })), 'RESOURCE_INACTIVE', 409);
    await expectAppError(() => c.calendar.availability.suggest(c.owner, b({ startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T18:00:00Z', resourceIds: [c.resource.id], durationMinutes: 60 })), 'RESOURCE_INACTIVE', 409);
  });
});
