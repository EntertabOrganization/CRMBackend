# Calendar Recurrence & Reminders Specification

## Goal / Scope

Implement recurring Event rules, occurrence exceptions and reminder scheduling.

## Ownership / Boundary

Recurrence data is Calendar-owned. Reminder delivery is scheduled through shared jobs/Notifications.

## Entities / Fields / Enums

```text
calendar_recurrence_rules:
 id, workspaceId, eventId,
 rruleText or structured fields,
 sourceTimezone, startsAt, until nullable, count nullable, version

calendar_recurrence_exceptions:
 id, workspaceId, recurrenceRuleId,
 recurrenceId, exceptionType CANCELLED|MODIFIED,
 overrideEventId nullable

calendar_event_reminders:
 id, workspaceId, eventId, attendeeUserId nullable,
 offsetSeconds or remindAt,
 channel IN_APP|EMAIL|PUSH,
 status SCHEDULED|SENT|CANCELLED|FAILED
```
Recurrence must be compatible with iCalendar/RRULE concepts even if internally stored in normalized fields.

## API Endpoints

```text
GET    /api/v1/calendar-events/:eventId/recurrence
PUT    /api/v1/calendar-events/:eventId/recurrence
PATCH  /api/v1/calendar-events/:eventId/recurrence
DELETE /api/v1/calendar-events/:eventId/recurrence
POST   /api/v1/calendar-events/:eventId/occurrences/:recurrenceId/cancel
PATCH  /api/v1/calendar-events/:eventId/occurrences/:recurrenceId
PATCH  /api/v1/calendar-events/:eventId/recurrence/future
GET    /api/v1/calendar-events/:eventId/reminders
POST   /api/v1/calendar-events/:eventId/reminders
PATCH  /api/v1/calendar-reminders/:id
DELETE /api/v1/calendar-reminders/:id
```

## Business Rules / Validation

- Recurrence source timezone is required.
- Occurrence identity is stable even when an occurrence is modified/cancelled.
- Support edit current occurrence, current-and-future, or entire series semantics without duplicating unrelated occurrences.
- Reminder scheduler retries are idempotent.
- Cancelled Event/occurrence cancels pending reminders.
- Reminder preferences/channel permission are respected.

## Permissions

- `EVENT.UPDATE`
- `EVENT.RECURRENCE_MANAGE`
- `EVENT.REMINDER_MANAGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `RECURRENCE_INVALID_RULE`
- `RECURRENCE_OCCURRENCE_NOT_FOUND`
- `RECURRENCE_SCOPE_INVALID`
- `REMINDER_INVALID_TIME`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CALENDAR_RECURRENCE_CHANGED`
- `CALENDAR_OCCURRENCE_EXCEPTION_CREATED`
- `CALENDAR_REMINDER_SCHEDULED`

## Audit Events / Evidence

- `Major recurrence-series changes can be audited via Event history; reminder sends are delivery evidence rather than central Audit for every send.`

## Dependencies / Integrations

- Jobs/Scheduler
- Notifications
- External sync

## Testing Requirements

- DST recurrence.
- Exception identity.
- Edit one vs future vs all.
- Retry reminder send.

## Acceptance Criteria

- Series edits preserve correct occurrence semantics.
- One failed reminder does not corrupt Event recurrence.
