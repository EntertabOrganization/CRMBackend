# Events & Meetings Specification

## Goal / Scope

Implement timed/all-day Events and Meetings with organizer, attendees, external guests, files and business bindings.

## Ownership / Boundary

`CalendarEventsController` owns Event lifecycle, attendee/guest state and Meeting content. A Meeting is an Event with participants; do not duplicate event truth.

## Entities / Fields / Enums

```text
calendar_events:
 id, workspaceId, calendarId, organizerUserId,
 title, description nullable, location nullable,
 isAllDay,
 startAt/endAt timestamptz nullable,
 startDate/endDate date nullable,
 sourceTimezone,
 status CONFIRMED|TENTATIVE|CANCELLED,
 busyStatus FREE|BUSY,
 recurrenceRuleId nullable,
 version, cancelledAt nullable

calendar_event_attendees:
 eventId, userId, response NEEDS_ACTION|ACCEPTED|TENTATIVE|DECLINED,
 respondedAt nullable

calendar_external_guests:
 id, eventId, email, name nullable, response, inviteTokenHash nullable
```
Meeting records/decisions may store agenda/notes/decisions without becoming another scheduling object.

## API Endpoints

```text
POST   /api/v1/calendar-events
GET    /api/v1/calendar-events
GET    /api/v1/calendar-events/:id
PUT    /api/v1/calendar-events/:id
PATCH  /api/v1/calendar-events/:id
DELETE /api/v1/calendar-events/:id
POST   /api/v1/calendar-events/:id/cancel
POST   /api/v1/calendar-events/:id/restore
GET    /api/v1/calendar-events/:id/attendees
POST   /api/v1/calendar-events/:id/attendees
DELETE /api/v1/calendar-events/:id/attendees/:userId
POST   /api/v1/calendar-events/:id/respond
GET    /api/v1/calendar-events/:id/guests
POST   /api/v1/calendar-events/:id/guests
DELETE /api/v1/calendar-events/:id/guests/:guestId
GET    /api/v1/calendar-events/:id/bindings
POST   /api/v1/calendar-events/:id/bindings
DELETE /api/v1/calendar-events/:id/bindings/:bindingId
GET    /api/v1/calendar-events/:id/meeting-record
PUT    /api/v1/calendar-events/:id/meeting-record
POST   /api/v1/calendar-events/:id/meeting-decisions
```

## Business Rules / Validation

- Timed Event requires startAt < endAt and timezone-safe instants.
- All-day Event uses date fields; do not serialize as accidental midnight UTC.
- Organizer must have create permission on target Calendar.
- Internal attendees are active authorized same-Workspace users; external guests are email identities and receive only invitation-scoped information.
- Attendee may change own response but not rewrite Event unless separately authorized.
- Cancellation preserves historical Event identity.
- Task deadlines/project milestones projected into Calendar are not persisted here as duplicate Events.
- Business binding target must be same Workspace and readable by caller.
- Optimistic concurrency applies to Event edits.

## Permissions

- `EVENT.CREATE`
- `EVENT.READ`
- `EVENT.UPDATE`
- `EVENT.CANCEL`
- `EVENT.DELETE_ADMIN`
- `EVENT.ATTENDEE_MANAGE`
- `EVENT.MEETING_RECORD_MANAGE`

## Tenant / Ownership Rules

- All business rows and queries are scoped to the resolved active Workspace.
- Cross-Workspace IDs must not be linkable or inferable through this API.
- Resource-level authorization is re-evaluated server-side on every operation; possession of an ID is never authorization.

## Stable Error Cases

- `EVENT_NOT_FOUND`
- `EVENT_INVALID_TIME_RANGE`
- `EVENT_ALL_DAY_INVALID`
- `EVENT_ATTENDEE_INVALID`
- `EVENT_BINDING_INVALID`
- `EVENT_CANCELLED`
- `RESOURCE_VERSION_CONFLICT`
- `PERMISSION_DENIED`

## Domain / Outbox Events

- `CALENDAR_EVENT_CREATED`
- `CALENDAR_EVENT_UPDATED`
- `CALENDAR_EVENT_CANCELLED`
- `CALENDAR_ATTENDEE_RESPONDED`
- `CALENDAR_GUEST_INVITED`

## Audit Events / Evidence

- `Administrative delete, sensitive guest changes and material meeting record changes are audited.`

## Dependencies / Integrations

- Calendars
- Files attachments
- CRM/Task/Project bindings
- Notifications

## Testing Requirements

- All-day vs timed validation.
- Attendee self-response.
- External guest privacy.
- Stale version update.

## Acceptance Criteria

- Event semantics remain timezone-safe.
- Meeting is represented by Event rather than duplicated schedule data.
