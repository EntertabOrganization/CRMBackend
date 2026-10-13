# Activities & Timeline — Module Overview

## Goal

Provide one CRM-facing system for actionable follow-up work and one unified chronological history around CRM records, without duplicating the source-of-truth lifecycles owned by Calendar, Tasks, Communication or Files.

## Core distinction

### Activity

An Activity is actionable/stateful work. It can be planned, reassigned, reminded, completed, cancelled, reopened and bound to one or more CRM records.

### Timeline

Timeline is a derived historical/read model. It projects meaningful events from Activities and other TrueCRM modules into an ordered customer/opportunity history. Timeline is not the source of truth for those source modules.

### Audit

Audit is separate from Timeline. Audit is append-only evidence for exhaustive/sensitive changes; Timeline is optimized for readable business context.

## Built-in activity concepts

Initial CRM activity concepts:

```text
CALL
MEETING
EMAIL
MESSAGE
FOLLOW_UP
TASK
DOCUMENT
CUSTOM
```

`REMINDER` is **not** a standalone Activity type. Reminder schedules belong to Activities. A standalone reminder use case is modeled as `FOLLOW_UP`.

## Module responsibilities

Activities owns:

- generic Activity record;
- status/priority/direction/timing;
- creator/responsible/participants;
- CRM multi-bindings;
- customer communication snapshots;
- reminders;
- results/outcomes;
- workspace-defined custom Activity types;
- provider/app-defined Activity type registration metadata;
- generic Activity custom fields through the Custom Fields module;
- lifecycle commands;
- soft delete/restore;
- Activity query/list/deadline-board APIs;
- adapter contracts to specialist modules.

Timeline owns:

- chronological projected entries;
- source identity/deduplication;
- small presentation snapshots;
- permission-aware record Timeline queries;
- user comments;
- comment files/mentions;
- comment edit/soft-delete;
- rebuild/projection infrastructure.

## Does not own

- Calendar Event truth/recurrence/attendee response engine;
- Task truth/recurrence/dependencies/checklists;
- provider conversation/message/call delivery truth;
- file binaries;
- Automation execution;
- Notification delivery implementation;
- Audit storage implementation;
- CRM record truth.

## Core components

Suggested logical components:

```text
ActivityService
ActivityQueryService
ActivityLifecycleService
ActivityBindingService
ActivityParticipantService
ActivityCommunicationService
ActivityReminderService
ActivityTypeRegistry
CustomActivityTypeService
ActivityAdapterRegistry
ActivityOverdueScheduler
TimelineProjector
TimelineQueryService
TimelineCommentService
TimelineDedupeService
TimelineRebuildService
```

## Primary flows

### Create generic Activity

```text
User opens CRM record or Global Activities
→ choose Activity type
→ server authorizes CREATE + validates bindings/responsible/times/custom fields
→ save Activity + children atomically
→ create outbox event
→ schedule reminders
→ after commit project meaningful Timeline entry
→ notifications/realtime consume events
```

### Complete Activity

```text
User sends complete command + optional result/outcome
→ authorize COMPLETE
→ load current version/state
→ if already completed with same command: idempotent success
→ validate specialist adapter if type is specialist-backed
→ commit status/result/completedAt + outbox atomically
→ cancel pending reminders/overdue occurrence as appropriate
→ project Timeline completion entry
→ notify/realtime/automation consumers
```

### Provider communication

```text
Communication provider event verified by owning integration
→ stable provider event dedupe
→ Communication domain commits source event
→ Activity adapter create/update CRM Activity representation
→ project meaningful communication/Activity Timeline event using stable source event identity
→ no duplicates on retry
```

### Timeline read

```text
User opens CRM record
→ authorize record + TIMELINE.READ
→ query workspace/entity timeline with cursor/filter
→ filter/redact source/binding details by current access
→ return deterministic chronological page
```

## Dependencies

- CRM Core
- Workspaces/Permissions
- Custom Fields
- Calendar
- Tasks
- Communication/Contact Center
- Files/Documents
- Notifications
- Automation
- Platform Events/Outbox/Jobs/Realtime
- Audit
- Analytics consumers

## Acceptance criteria

- Users can create and complete generic Activities with correct permissions.
- Activities may exist without a CRM binding and may bind to multiple authorized CRM records.
- Unauthorized bindings are never disclosed.
- Meeting/Task/Communication/Document specialist behavior delegates to owning modules.
- Reminder scheduling is retry-safe.
- Overdue is derived correctly and emits exactly-once occurrence events.
- Completed/cancelled Activities require explicit reopen before business-field edits.
- Timeline remains ordered/readable and does not duplicate source business state.
- Exact duplicate source events do not create duplicate Timeline entries.
- Timeline comments support files/mentions, edit and soft delete with permissions.
- A missed realtime event is recoverable by normal API reload.
