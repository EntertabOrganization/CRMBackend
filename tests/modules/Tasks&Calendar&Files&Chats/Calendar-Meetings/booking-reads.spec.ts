import { randomUUID } from 'node:crypto';
import type { CalendarBooking } from '@/src/server/collab/calendar/booking-types';
import { expectAppError } from '@/tests/support/domain';
import { collabApp, perms } from '../support/domain';

function reservation(c: Awaited<ReturnType<typeof collabApp>>, ownerUserId = c.owner.user.id, status: CalendarBooking['status'] = 'PENDING') {
  const startAt = new Date('2030-01-07T09:00:00Z'), endAt = new Date('2030-01-07T09:30:00Z');
  const row: CalendarBooking = { id: randomUUID(), workspaceId: c.owner.workspaceId, bookingPageId: randomUUID(), ownerUserId,
    calendarId: randomUUID(), eventId: status === 'PENDING' ? null : randomUUID(), guestName: 'Guest', guestEmail: 'guest@example.com', guestPhone: null,
    startAt, endAt, reservedStartAt: startAt, reservedEndAt: endAt, status, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64),
    tokenNonce: 'secret nonce', tokenGeneration: 1, tokenExpiresAt: endAt, cancellationTokenHash: 'c'.repeat(64), rescheduleTokenHash: 'd'.repeat(64),
    sourceEpoch: 10, pageVersion: 3, rulesVersion: 1, version: 1, createdAt: startAt, updatedAt: startAt };
  c.state.calendarBookings.push(row); return row;
}

describe('Protected Booking reads', () => {
  it('requires the read permission and hides foreign and out-of-scope identities', async () => {
    const c = await collabApp(), own = await c.memberActor('reader', perms('OWN', 'booking.read'));
    const denied = await c.memberActor('denied', perms('WORKSPACE', 'booking.update')), foreign = await c.foreignActor();
    const row = reservation(c), svc = c.collab.calendar.bookings;
    await expectAppError(() => svc.list(denied, new URLSearchParams()), 'PERMISSION_DENIED', 403);
    await expectAppError(() => svc.get(denied, row.id), 'PERMISSION_DENIED', 403);
    for (const actor of [own, foreign]) {
      expect(svc.list(actor, new URLSearchParams()).data).toEqual([]);
      await expectAppError(() => svc.get(actor, row.id), 'BOOKING_NOT_FOUND', 404);
      await expectAppError(() => svc.get(actor, randomUUID()), 'BOOKING_NOT_FOUND', 404);
    }
    const self = reservation(c, own.user.id);
    expect(svc.list(own, new URLSearchParams()).data.map((item) => item.id)).toEqual([self.id]);
    expect(svc.get(own, self.id).id).toBe(self.id);
  });
  it('evaluates department and descendant scope against the reservation host', async () => {
    const c = await collabApp(), department = await c.memberActor('dept-reader', perms('DEPARTMENT', 'booking.read'));
    const tree = await c.memberActor('tree-reader', perms('DEPARTMENT_TREE', 'booking.read'));
    const host = await c.memberActor('child-host', []), unrelated = await c.memberActor('other-host', []);
    const root = c.app.departments.create(c.owner.user, c.owner.workspaceId, { name: 'Root' });
    const child = c.app.departments.create(c.owner.user, c.owner.workspaceId, { name: 'Child', parentDepartmentId: root.id });
    c.app.departments.addMembers(c.owner.user, c.owner.workspaceId, root.id, [department.user.id, tree.user.id]);
    c.app.departments.addMembers(c.owner.user, c.owner.workspaceId, child.id, [host.user.id]);
    const same = reservation(c, tree.user.id), descendant = reservation(c, host.user.id), outside = reservation(c, unrelated.user.id);
    const svc = c.collab.calendar.bookings;
    expect(svc.list(department, new URLSearchParams()).data.map((item) => item.id)).toEqual([same.id]);
    expect(new Set(svc.list(tree, new URLSearchParams()).data.map((item) => item.id))).toEqual(new Set([same.id, descendant.id]));
    await expectAppError(() => svc.get(department, descendant.id), 'BOOKING_NOT_FOUND', 404);
    await expectAppError(() => svc.get(tree, outside.id), 'BOOKING_NOT_FOUND', 404);
  });
  it('returns all lifecycle statuses without requiring the original page to remain published', async () => {
    const c = await collabApp(), svc = c.collab.calendar.bookings;
    const statuses: CalendarBooking['status'][] = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'];
    for (const status of statuses) reservation(c, c.owner.user.id, status);
    expect(new Set(svc.list(c.owner, new URLSearchParams()).data.map((item) => item.status))).toEqual(new Set(statuses));
  });
  it('whitelists response data and query fields before search/filter/pagination', async () => {
    const c = await collabApp(), svc = c.collab.calendar.bookings, row = reservation(c);
    reservation(c, c.owner.user.id, 'CANCELLED');
    const result = svc.list(c.owner, new URLSearchParams({ search: 'guest@example', status: 'PENDING', limit: '1' }));
    expect(result.meta).toMatchObject({ total: 1, totalPages: 1 }); expect(result.data[0].id).toBe(row.id);
    const hidden = ['idempotencyKey', 'requestHash', 'tokenNonce', 'tokenGeneration', 'tokenExpiresAt', 'cancellationTokenHash',
      'rescheduleTokenHash', 'sourceEpoch', 'pageVersion', 'rulesVersion', 'reservedStartAt', 'reservedEndAt'];
    for (const view of [svc.get(c.owner, row.id), result.data[0]]) for (const key of hidden) expect(view).not.toHaveProperty(key);
    for (const query of [new URLSearchParams({ filters: JSON.stringify({ requestHash: row.requestHash }) }), new URLSearchParams({ sortBy: 'tokenNonce' })])
      await expectAppError(() => svc.list(c.owner, query), 'QUERY_FIELD_NOT_ALLOWED', 400);
    expect(svc.list(c.owner, new URLSearchParams({ search: row.requestHash })).data).toEqual([]);
  });
});
