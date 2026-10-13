# Booking Pages & Bookings Specification

## Goal / Scope

Implement public/internal scheduling pages, availability rules, guest booking, approval, reschedule and cancellation.

## Ownership / Boundary

`BookingPagesController` owns page configuration/publication. `BookingsController` owns concrete reservation lifecycle and creates/updates Calendar Event via Calendar service.

## Entities / Fields / Enums

```text
calendar_booking_pages:
 id, workspaceId, ownerUserId, title, slug,
 status DRAFT|PUBLISHED|UNPUBLISHED,
 bookingMode AUTO_CONFIRM|REQUIRE_APPROVAL,
 durationMinutes, timezonePolicy,
 requireName=true, requireEmail=true, requirePhone boolean,
 minNoticeMinutes, maxAdvanceDays,
 bufferBeforeMinutes, bufferAfterMinutes,
 version

calendar_availability_rules:
 pageId, dayOfWeek/date overrides, localStartTime, localEndTime, timezone

calendar_bookings:
 id, workspaceId, bookingPageId, eventId nullable,
 guestName, guestEmail, guestPhone nullable,
 startAt, endAt,
 status PENDING|CONFIRMED|CANCELLED|COMPLETED|NO_SHOW,
 cancellationTokenHash, rescheduleTokenHash,
 idempotencyKey/clientRequestId, version
```


## API Endpoints

```text
POST   /api/v1/booking-pages
GET    /api/v1/booking-pages
GET    /api/v1/booking-pages/:id
PUT    /api/v1/booking-pages/:id
PATCH  /api/v1/booking-pages/:id
DELETE /api/v1/booking-pages/:id
POST   /api/v1/booking-pages/:id/publish
POST   /api/v1/booking-pages/:id/unpublish
GET    /api/v1/booking-pages/:id/rules
PUT    /api/v1/booking-pages/:id/rules
GET    /api/v1/public/booking/:slug
GET    /api/v1/public/booking/:slug/slots
POST   /api/v1/public/booking/:slug/bookings
GET    /api/v1/bookings
GET    /api/v1/bookings/:id
POST   /api/v1/bookings/:id/approve
POST   /api/v1/bookings/:id/reject
PATCH  /api/v1/bookings/:id
POST   /api/v1/bookings/:id/reschedule
POST   /api/v1/bookings/:id/cancel
POST   /api/v1/public/bookings/:token/reschedule
POST   /api/v1/public/bookings/:token/cancel
```

## Business Rules / Validation

- Public page is rate-limited and exposes only configured public host/page data.
- Name/email required; phone/additional fields configurable.
- AUTO_CONFIRM default; REQUIRE_APPROVAL creates PENDING until authorized approval.
- Final booking transaction rechecks attendee/resource availability and acquires reservation atomically.
- Idempotency prevents duplicate booking on retry.
- Public cancellation/reschedule token is signed/high-entropy, scoped and revocable; never accepts internal booking ID alone as authority.
- No private Event titles are disclosed in open-slot response.

## Permissions

- `BOOKING_PAGE.CREATE`
- `BOOKING_PAGE.UPDATE`
- `BOOKING_PAGE.PUBLISH`
- `BOOKING.READ`
- `BOOKING.APPROVE`
- `BOOKING.UPDATE`
- `BOOKING.CANCEL`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `BOOKING_PAGE_NOT_FOUND`
- `BOOKING_PAGE_NOT_PUBLISHED`
- `BOOKING_SLOT_UNAVAILABLE`
- `BOOKING_APPROVAL_REQUIRED`
- `BOOKING_TOKEN_INVALID`
- `BOOKING_RATE_LIMITED`
- `BOOKING_IDEMPOTENCY_CONFLICT`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `BOOKING_PAGE_PUBLISHED`
- `BOOKING_CREATED`
- `BOOKING_CONFIRMED`
- `BOOKING_RESCHEDULED`
- `BOOKING_CANCELLED`
- `BOOKING_REJECTED`

## Audit Events / Evidence

- `Booking page/public security and administrative booking changes are audited.`

## Dependencies / Integrations

- Events
- Availability/resources
- Notifications
- RateLimit service

## Testing Requirements

- Concurrent same-slot booking.
- Public token replay.
- Retry same idempotency key.
- Approval vs auto-confirm.

## Acceptance Criteria

- Public booking cannot double-book.
- Public caller cannot enumerate internal Events/users.
