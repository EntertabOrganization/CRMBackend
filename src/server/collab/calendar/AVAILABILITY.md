# Calendar availability

`POST /api/v1/availability/free-busy` accepts offset-aware `startAt` and `endAt`, plus optional `userIds` and `resourceIds`. Ranges are positive and at most 31 days; at most 50 subjects may be selected. With no selected resources or supplied user list, the caller is selected. Each user must be an active Workspace member covered by the caller's `calendar.free_busy` scope. Resources additionally require `resource.read`.

Responses contain merged busy intervals, configured working windows and free intervals. Event IDs, titles, descriptions, organizers and attendee lists are excluded. Cancelled/deleted/FREE Events and declined attendees do not block availability. Recurring Events use original identities and current exceptions/range edits; all-day boundaries use their source timezone.

`POST /api/v1/availability/suggest-slots` accepts the same fields plus required `durationMinutes` (1–1440), optional `stepMinutes` (1–1440; default 15), and optional `limit` (1–100; default 20). Slots intersect every selected subject's free windows. The step grid starts at the requested start instant, and duration is elapsed time. Disabled resources and insufficient resource capacity are rejected. Suggestions reserve nothing; booking finalization must revalidate authoritative availability transactionally.

Business calendars and user schedules are persisted separately from derived availability:

- `GET/PUT /api/v1/availability/business-calendar`: one business calendar per Workspace. Writes require workspace `calendar.business_calendar_manage`.
- `GET/PUT /api/v1/availability/working-schedules/:userId`: one user schedule per Workspace/user. Reads use `calendar.free_busy`; writes use `calendar.working_schedule_manage`, with the corresponding scope checked against the target user.

PUT replaces configuration and requires `timezone`, `weekly`, and `version` (0 for creation). Optional `holidays` and `overrides` reset to empty when omitted. Weekly windows contain ISO `dayOfWeek` (1–7), `localStartTime`, and `localEndTime` (`HH:mm`, with `24:00` allowed as an end). A date override contains `date` (`YYYY-MM-DD`) and `windows`; an empty override closes that date. Date overrides take precedence over holidays and weekly windows. User windows intersect business windows; resources inherit business windows. Unconfigured schedules impose no working-hours restriction, explicitly reported as `UNRESTRICTED`. Nonexistent DST boundaries produce no guessed working window.

Configuration is versioned, tenant-constrained and audited. PostgreSQL independently checks schedule shapes and immutable identities.

Queries have bounded event and recurrence budgets. A dense recurrence or COUNT-bounded history exceeding synchronous coverage queues a durable rebuild and returns HTTP 202 with `pending: true`, `retryAfterSeconds: 5`, and empty subject/slot arrays. Partial intervals are never returned as free time. Repeat the same query after the scheduler advances coverage; ready results return HTTP 200 with `pending: false`.

The token-protected `POST /api/v1/internal/crm/jobs/calendar-availability` accepts `limit` (1–100; default 25), measured in pages. Each page scans at most 1,000 candidates and commits its cursor separately. Optimistic versions fence competing workers; failed pages retain their committed cursor, retry with backoff, and stop after three failures. Queries then return `409 AVAILABILITY_UNAVAILABLE`. Event/rule edits invalidate previous coverage, and authorization and membership are checked on every query. Rebuilds expire after 24 hours; expired records are reclaimed when new work is queued. Each Workspace retains at most 1,000 rebuild records; exhausted queue or aggregate synchronous budgets fail explicitly.

Recurring resource reservations and authoritative public Booking finalization remain pending.
