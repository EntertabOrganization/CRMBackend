# Availability & Resources Specification

## Goal / Scope

Implement permission-safe free/busy queries, suggested slots, rooms/equipment and exclusive resource booking.

## Ownership / Boundary

`AvailabilityController` owns free/busy/suggestion reads. `CalendarResourcesController` owns resources and resource booking policy.

## Entities / Fields / Enums

```text
calendar_resources:
 id, workspaceId, type ROOM|EQUIPMENT|OTHER,
 name, description nullable, capacity nullable,
 timezone, isExclusive, isActive, version

calendar_resource_bookings:
 id, workspaceId, resourceId, eventId,
 startAt, endAt, status ACTIVE|CANCELLED

calendar_busy_intervals:
 derived/read-model intervals only; rebuildable
```


## API Endpoints

```text
POST   /api/v1/availability/free-busy
POST   /api/v1/availability/suggest-slots
GET    /api/v1/calendar-resources
POST   /api/v1/calendar-resources
GET    /api/v1/calendar-resources/:id
PUT    /api/v1/calendar-resources/:id
PATCH  /api/v1/calendar-resources/:id
DELETE /api/v1/calendar-resources/:id
GET    /api/v1/calendar-resources/:id/availability
POST   /api/v1/calendar-events/:eventId/resources
DELETE /api/v1/calendar-events/:eventId/resources/:resourceId
```

## Business Rules / Validation

- Free/busy response contains intervals/state, not private titles/descriptions.
- Suggested slots consider working schedules, busy intervals, selected attendees/resources and requested duration.
- Exclusive resource overlap is rejected transactionally.
- Capacity/resource constraints are validated.
- Derived busy intervals may lag but booking finalization must query/revalidate authoritative state.

## Permissions

- `CALENDAR.FREE_BUSY`
- `RESOURCE.READ`
- `RESOURCE.MANAGE`
- `RESOURCE.BOOK`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `RESOURCE_NOT_FOUND`
- `RESOURCE_BOOKING_CONFLICT`
- `RESOURCE_CAPACITY_INVALID`
- `AVAILABILITY_INVALID_RANGE`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `RESOURCE_CREATED`
- `RESOURCE_BOOKED`
- `RESOURCE_BOOKING_CANCELLED`

## Audit Events / Evidence

- `Resource configuration changes and conflict overrides, if allowed, are audited.`

## Dependencies / Integrations

- Events
- Business Calendar/working schedules
- Booking pages

## Testing Requirements

- Privacy of free/busy.
- Concurrent exclusive bookings.
- Resource disabled during booking.

## Acceptance Criteria

- Private Event details never leak through free/busy.
- Two concurrent bookings cannot both acquire the same exclusive resource/time.
