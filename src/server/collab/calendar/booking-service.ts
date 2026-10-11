import type { ActorContext } from '../../access-service';
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isCalendarDate, notFoundError, pageOf, validationError } from '../support';
import { WithStatus } from '../http';
import type { CalendarBooking, CalendarBookingPage } from './booking-types';
import type { CalendarBookingPageService } from './booking-page-service';
import type { CalendarBookingPublicService } from './booking-public-service';
import type { CalendarEventService } from './event-service';
import { bookingToken, bookingTokenHash } from './booking-capabilities';
import type { CalendarResourceService } from './resource-service';

/** Concrete reservations belong to their original host, independently of later page edits/publication. */
export class CalendarBookingService {
  constructor(private readonly support: CollabSupport, private readonly pages: CalendarBookingPageService,
    private readonly publicAvailability: CalendarBookingPublicService, private readonly events: CalendarEventService,
    private readonly resources: CalendarResourceService) {}
  private visible(actor: ActorContext, row: CalendarBooking, permission = 'booking.read') {
    return row.workspaceId === actor.workspaceId &&
      this.support.scopeCovers(actor, this.support.scope(actor, permission), [row.ownerUserId]);
  }
  private row(actor: ActorContext, id: string, permission: string) {
    this.support.require(actor, permission);
    const row = this.support.state.calendarBookings.find((item) => item.id === id && this.visible(actor, item, permission));
    if (!row) throw notFoundError('BOOKING_NOT_FOUND', 'Booking'); return row;
  }
  /** Never serialize the persistence row: request identity and guest capability material stay server-side. */
  private view(row: CalendarBooking) {
    return { id: row.id, workspaceId: row.workspaceId, bookingPageId: row.bookingPageId, ownerUserId: row.ownerUserId,
      calendarId: row.calendarId, eventId: row.eventId, guestName: row.guestName, guestEmail: row.guestEmail,
      guestPhone: row.guestPhone, startAt: row.startAt, endAt: row.endAt, status: row.status,
      version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'booking.read');
    return pageOf(this.support.state.calendarBookings.filter((row) => this.visible(actor, row)).map((row) => this.view(row)), query,
      { searchable: ['guestName', 'guestEmail'], filterable: ['status', 'bookingPageId', 'ownerUserId', 'calendarId', 'startAt', 'endAt'],
        sortable: ['startAt', 'endAt', 'createdAt', 'updatedAt', 'guestName'], defaultSort: 'startAt' });
  }
  get(actor: ActorContext, id: string) {
    return this.view(this.row(actor, id, 'booking.read'));
  }
  update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const row = this.row(actor, id, 'booking.update');
    body.only(['guestName', 'guestEmail', 'guestPhone', 'version']);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (!['PENDING', 'CONFIRMED'].includes(row.status)) throw new AppError('BOOKING_STATE_INVALID', 'Only active Bookings can be edited.', 409);
    const guestName = body.has('guestName') ? body.str('guestName', { required: true, max: 200 }) : row.guestName;
    const guestEmail = body.has('guestEmail') ? body.str('guestEmail', { required: true, max: 320 }).toLowerCase() : row.guestEmail;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) throw validationError('guestEmail', 'guestEmail must be a valid email address.');
    const page = this.support.state.calendarBookingPages.find(page => page.id === row.bookingPageId && page.workspaceId === row.workspaceId);
    const guestPhone = body.has('guestPhone') ? body.str('guestPhone', { required: page?.requirePhone ?? false, max: 50 }) ?? null : row.guestPhone;
    if (guestName === row.guestName && guestEmail === row.guestEmail && guestPhone === row.guestPhone) return this.view(row);
    const emailChanged = guestEmail !== row.guestEmail;
    if (emailChanged && row.tokenGeneration >= 2147483647) throw new AppError('BOOKING_TOKEN_LIMIT', 'Booking capability revision limit reached.', 409);
    const before = this.view(row);
    if (row.status === 'CONFIRMED' && (guestName !== row.guestName || emailChanged))
      this.events.updateBookingGuest(row, { guestName, guestEmail }, actor);
    Object.assign(row, { guestName, guestEmail, guestPhone });
    if (emailChanged) {
      row.publicReceiptRevoked = true; row.tokenGeneration++;
      row.cancellationTokenHash = bookingTokenHash(bookingToken(row, 'cancel'));
      row.rescheduleTokenHash = bookingTokenHash(bookingToken(row, 'reschedule'));
    }
    this.support.touch(row); this.record(actor, row, 'UPDATED', before); return this.view(row);
  }
  private receipt(row: CalendarBooking, hideCapabilities = false) {
    const token = (purpose: 'cancel' | 'reschedule') => {
      const hash = purpose === 'cancel' ? row.cancellationTokenHash : row.rescheduleTokenHash;
      if (hideCapabilities || !hash || row.tokenExpiresAt <= this.support.now()) return null;
      const value = bookingToken(row, purpose);
      if (bookingTokenHash(value) !== hash) throw new AppError('BOOKING_UNAVAILABLE', 'The original Booking receipt cannot be recovered.', 503);
      return value;
    };
    return { bookingId: row.id, status: row.status, startAt: row.startAt, endAt: row.endAt, version: row.version,
      cancellationToken: token('cancel'), rescheduleToken: token('reschedule') };
  }
  private available(page: CalendarBookingPage, startAt: Date, excluding?: CalendarBooking) {
    const endAt = new Date(startAt.getTime() + page.durationMinutes * 60_000);
    const result = this.publicAvailability.slots(page.slug, new URLSearchParams({ startAt: startAt.toISOString(), endAt: endAt.toISOString(), limit: '1' }), excluding);
    if (result.pending) return null;
    if (!result.slots.some((slot) => slot.startAt.getTime() === startAt.getTime() && slot.endAt.getTime() === endAt.getTime()))
      throw new AppError('BOOKING_SLOT_UNAVAILABLE', 'This time is unavailable. Reload availability and retry.', 409);
    return { startAt, endAt, reservedStartAt: new Date(startAt.getTime() - page.bufferBeforeMinutes * 60_000),
      reservedEndAt: new Date(endAt.getTime() + page.bufferAfterMinutes * 60_000) };
  }
  private pending() { return new WithStatus(202, { booking: null, pending: true, retryAfterSeconds: 5 }); }
  private epoch(workspaceId: string) { return this.support.state.calendarAvailabilityEpochs.find((row) => row.workspaceId === workspaceId)?.epoch ?? 0; }
  private host(page: CalendarBookingPage) {
    return this.support.access.actor(this.support.state.users.find((user) => user.id === page.ownerUserId)!, page.workspaceId);
  }
  create(slug: string, body: Body, idempotencyKey?: string) {
    const { page, rules } = this.pages.published(slug);
    body.only(['guestName', 'guestEmail', 'guestPhone', 'startAt', 'clientRequestId']);
    const key = new Body({ key: idempotencyKey ?? body.raw.clientRequestId }).uuid('key', { required: true });
    if (body.has('clientRequestId') && body.uuid('clientRequestId', { required: true }) !== key)
      throw new AppError('BOOKING_IDEMPOTENCY_CONFLICT', 'Request identifiers must agree.', 409);
    const guestName = body.str('guestName', { required: true, max: 200 });
    const guestEmail = body.str('guestEmail', { required: true, max: 320 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) throw validationError('guestEmail', 'guestEmail must be a valid email address.');
    const guestPhone = body.str('guestPhone', { required: page.requirePhone, max: 50 }) ?? null;
    const startAt = body.instant('startAt', { required: true });
    if (!isCalendarDate(String(body.raw.startAt).slice(0, 10))) throw validationError('startAt', 'startAt must be a real calendar date.');
    const requestHash = createHash('sha256').update(JSON.stringify([guestName, guestEmail, guestPhone, startAt.toISOString()])).digest('hex');
    const existing = this.support.state.calendarBookings.find((row) => row.bookingPageId === page.id && row.idempotencyKey === key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AppError('BOOKING_IDEMPOTENCY_CONFLICT', 'This request identifier was already used for different booking details.', 409);
      return this.receipt(existing, existing.publicReceiptRevoked);
    }
    const range = this.available(page, startAt); if (!range) return this.pending();
    const now = this.support.now();
    const row: CalendarBooking = { id: this.support.id(), workspaceId: page.workspaceId, bookingPageId: page.id,
      attendeeUserIds: [...(page.attendeeUserIds ?? [])], resourceIds: [...(page.resourceIds ?? [])],
      ownerUserId: page.ownerUserId, calendarId: page.calendarId, eventId: null, guestName, guestEmail, guestPhone, ...range,
      status: page.bookingMode === 'REQUIRE_APPROVAL' ? 'PENDING' : 'CONFIRMED', idempotencyKey: key, requestHash,
      tokenNonce: randomBytes(32).toString('base64url'), tokenGeneration: 1, publicReceiptRevoked: false, tokenExpiresAt: new Date(range.endAt.getTime() + 7 * 86_400_000),
      cancellationTokenHash: null, rescheduleTokenHash: null, sourceEpoch: this.epoch(page.workspaceId),
      pageVersion: page.version, rulesVersion: rules.version, version: 1, createdAt: now, updatedAt: now };
    row.cancellationTokenHash = bookingTokenHash(bookingToken(row, 'cancel'));
    row.rescheduleTokenHash = bookingTokenHash(bookingToken(row, 'reschedule'));
    this.support.state.calendarBookings.push(row);
    if (row.status === 'CONFIRMED') {
      this.events.confirmBooking(row, this.host(page), page.title, page.timezone, null);
      this.resources.bookForBooking(row, this.host(page));
    }
    this.record(null, row, 'CREATED', null);
    if (row.status === 'CONFIRMED') this.record(null, row, 'CONFIRMED', null);
    return this.receipt(row);
  }
  approve(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const row = this.row(actor, id, 'booking.approve'); body.only(['version']); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status === 'CONFIRMED') return this.view(row);
    if (row.status !== 'PENDING') throw new AppError('BOOKING_STATE_INVALID', 'Only pending Bookings can be approved.', 409);
    const original = this.support.state.calendarBookingPages.find((page) => page.id === row.bookingPageId && page.workspaceId === row.workspaceId);
    if (!original) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page');
    const { page, rules } = this.pages.published(original.slug);
    if (page.ownerUserId !== row.ownerUserId || page.calendarId !== row.calendarId)
      throw new AppError('BOOKING_SLOT_UNAVAILABLE', 'The original host or Calendar is unavailable.', 409);
    const range = this.available(page, row.startAt, row); if (!range) return this.pending();
    if (range.endAt.getTime() !== row.endAt.getTime())
      throw new AppError('BOOKING_SLOT_UNAVAILABLE', 'The requested duration changed. Reschedule before approval.', 409);
    const before = this.view(row);
    Object.assign(row, range, { status: 'CONFIRMED', sourceEpoch: this.epoch(row.workspaceId), pageVersion: page.version, rulesVersion: rules.version });
    this.support.touch(row); this.events.confirmBooking(row, this.host(page), page.title, page.timezone, actor);
    this.resources.bookForBooking(row, this.host(page));
    this.record(actor, row, 'CONFIRMED', before); return this.view(row);
  }
  cancel(actor: ActorContext, id: string, body: Body, reject = false, ifMatch?: number) {
    const row = this.row(actor, id, reject ? 'booking.approve' : 'booking.cancel');
    body.only(['version']); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status === 'CANCELLED') return this.view(row);
    if (reject && row.status !== 'PENDING') throw new AppError('BOOKING_STATE_INVALID', 'Only pending Bookings can be rejected.', 409);
    this.cancelRow(row, actor, reject); return this.view(row);
  }
  private cancelRow(row: CalendarBooking, actor: ActorContext | null, reject = false) {
    if (!['PENDING', 'CONFIRMED'].includes(row.status)) throw new AppError('BOOKING_STATE_INVALID', 'This Booking is no longer active.', 409);
    const before = this.view(row);
    row.status = 'CANCELLED'; row.cancellationTokenHash = null; row.rescheduleTokenHash = null; row.tokenGeneration++;
    this.support.touch(row); this.events.cancelBooking(row, actor); this.record(actor, row, reject ? 'REJECTED' : 'CANCELLED', before);
  }
  publicCancel(token: string, body: Body) {
    body.only([]);
    const row = this.capability(token, 'cancel');
    this.cancelRow(row, null); return this.receipt(row);
  }
  private capability(token: string, purpose: 'cancel' | 'reschedule') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('BOOKING_TOKEN_INVALID', 'Booking token is invalid.', 404);
    const hash = bookingTokenHash(token), row = this.support.state.calendarBookings.find((item) =>
      (purpose === 'cancel' ? item.cancellationTokenHash : item.rescheduleTokenHash) === hash &&
      item.tokenExpiresAt > this.support.now() && ['PENDING', 'CONFIRMED'].includes(item.status));
    if (!row) throw new AppError('BOOKING_TOKEN_INVALID', 'Booking token is invalid.', 404);
    return row;
  }
  reschedule(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    const row = this.row(actor, id, 'booking.update'); body.only(['startAt', 'version']); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const result = this.rescheduleRow(row, body, actor); return result ?? this.view(row);
  }
  publicReschedule(token: string, body: Body) {
    const row = this.capability(token, 'reschedule'); body.only(['startAt', 'version']);
    this.support.expectVersion(row, body.raw.version, false);
    const result = this.rescheduleRow(row, body, null); return result ?? this.receipt(row);
  }
  private rescheduleRow(row: CalendarBooking, body: Body, actor: ActorContext | null) {
    if (!['PENDING', 'CONFIRMED'].includes(row.status)) throw new AppError('BOOKING_STATE_INVALID', 'This Booking is no longer active.', 409);
    const startAt = body.instant('startAt', { required: true });
    if (!isCalendarDate(String(body.raw.startAt).slice(0, 10))) throw validationError('startAt', 'startAt must be a real calendar date.');
    const original = this.support.state.calendarBookingPages.find((page) => page.id === row.bookingPageId && page.workspaceId === row.workspaceId);
    if (!original) throw notFoundError('BOOKING_PAGE_NOT_FOUND', 'Booking page');
    const { page, rules } = this.pages.published(original.slug);
    if (page.ownerUserId !== row.ownerUserId || page.calendarId !== row.calendarId)
      throw new AppError('BOOKING_SLOT_UNAVAILABLE', 'The original host or Calendar is unavailable.', 409);
    const range = this.available(page, startAt, row); if (!range) return this.pending();
    const before = this.view(row);
    Object.assign(row, range, { sourceEpoch: this.epoch(row.workspaceId), pageVersion: page.version, rulesVersion: rules.version,
      tokenGeneration: row.tokenGeneration + 1, tokenExpiresAt: new Date(range.endAt.getTime() + 7 * 86_400_000) });
    row.cancellationTokenHash = bookingTokenHash(bookingToken(row, 'cancel'));
    row.rescheduleTokenHash = bookingTokenHash(bookingToken(row, 'reschedule'));
    this.support.touch(row);
    if (row.status === 'CONFIRMED') this.events.rescheduleBooking(row, page.timezone, actor);
    this.record(actor, row, 'RESCHEDULED', before);
  }
  private record(actor: ActorContext | null, row: CalendarBooking, action: string, before: unknown) {
    this.support.audit(actor, row.workspaceId, `BOOKING.${action}`, 'CALENDAR_BOOKING', row.id, before, this.view(row));
    this.support.event({ workspaceId: row.workspaceId, type: `BOOKING_${action}`, entityType: 'CALENDAR_BOOKING', entityId: row.id,
      actorUserId: actor?.user.id ?? null, audienceUserIds: [row.ownerUserId], changes: { version: row.version, status: row.status } });
  }
}
