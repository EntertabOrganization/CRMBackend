# Calendar & Meetings — Domain Overview

## Goal / Scope

Define Personal, Company, Department and Project Calendars; Events/Meetings, attendees/guests, recurrence/reminders, availability/resources, booking pages/bookings and external synchronization.

## Ownership / Boundary

Calendar owns scheduled objects and availability/resource booking truth. Task deadlines and Project milestones may be projected into calendar views but remain source records in Tasks/Projects. CRM Activity may bind to/represent a customer meeting without becoming the Calendar source of truth.

## Entities / Fields / Enums

Core tables/aggregates:

```text
calendars
calendar_permissions
user_calendar_preferences
business_calendars
business_calendar_holidays
user_working_schedules
calendar_events
calendar_event_attendees
calendar_external_guests
calendar_event_reminders
calendar_event_history
calendar_recurrence_rules
calendar_recurrence_exceptions
calendar_resources
calendar_resource_bookings
calendar_booking_pages
calendar_availability_rules
calendar_bookings
calendar_event_crm_bindings
calendar_event_project_bindings
calendar_event_task_bindings
calendar_sync_connections
calendar_sync_mappings
calendar_sync_conflicts
calendar_busy_intervals
meeting_records
meeting_decisions
```

```text
CalendarType = PERSONAL | COMPANY | DEPARTMENT | PROJECT
AttendeeResponse = NEEDS_ACTION | ACCEPTED | TENTATIVE | DECLINED
EventStatus = CONFIRMED | TENTATIVE | CANCELLED
BookingMode = AUTO_CONFIRM | REQUIRE_APPROVAL
BookingStatus = PENDING | CONFIRMED | CANCELLED | COMPLETED | NO_SHOW
```


## Business Rules / Validation

- Calendar/Event ownership and permission must be separate from simple visibility.
- A Meeting is an Event with organizer/attendees, not a duplicate top-level business type.
- Free/busy exposes availability only.
- Public booking must re-check availability transactionally.
- Recurrence has stable occurrence identity and exception records.
- Sync must detect concurrent conflicts rather than silently overwriting.

## Permissions

- `CALENDAR.*`
- `EVENT.*`
- `BOOKING.*`
- `RESOURCE.*`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Domain / Outbox Events

- `CALENDAR_EVENT_CREATED`
- `CALENDAR_EVENT_UPDATED`
- `CALENDAR_EVENT_CANCELLED`
- `BOOKING_CREATED`
- `BOOKING_RESCHEDULED`
- `BOOKING_CANCELLED`
- `CALENDAR_SYNC_CONFLICT`

## Audit Events / Evidence

- `Calendar permission/admin, sync credential/security and destructive actions are centrally audited.`

## Dependencies / Integrations

- Tasks/Projects projections
- CRM Activity bindings
- Files
- Notifications
- Search
- Integration credential store

## Testing Requirements

- Timezone/all-day semantics.
- Recurring exception identity.
- Double-booking races.
- Public booking privacy.
- Provider sync conflict and retry.

## Acceptance Criteria

- All four calendar types work with server-side permissions.
- Task/project projections do not create duplicate Events.
- Bookings cannot double-book exclusive resources.
- Sync retries do not duplicate events.
