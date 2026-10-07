# Requirement Traceability

This maps major requirement families to implementation specifications and executable contracts.

| Requirement family | Module | Specification | Tests |
|---|---|---|---|
| Tasks & Projects | Tasks-Projects | `Tasks-Projects/overview.md` | `Testing/Tasks-Projects/overview.spec.ts`, `Testing/Tasks-Projects/overview.e2e-spec.ts` |
| Calendar & Meetings | Calendar-Meetings | `Calendar-Meetings/overview.md` | `Testing/Calendar-Meetings/overview.spec.ts`, `Testing/Calendar-Meetings/overview.e2e-spec.ts` |
| Files, Drive & Documents | Files-Drive-Documents | `Files-Drive-Documents/overview.md` | `Testing/Files-Drive-Documents/overview.spec.ts`, `Testing/Files-Drive-Documents/overview.e2e-spec.ts` |
| Feed, Chat & Internal Communication | Communication | `Communication/overview.md` | `Testing/Communication/overview.spec.ts`, `Testing/Communication/overview.e2e-spec.ts` |
| Tasks — Core | Tasks-Projects | `Tasks-Projects/tasks.md` | `Testing/Tasks-Projects/tasks.spec.ts`, `Testing/Tasks-Projects/tasks.e2e-spec.ts` |
| Task Checklists | Tasks-Projects | `Tasks-Projects/task-checklists.md` | `Testing/Tasks-Projects/task-checklists.spec.ts`, `Testing/Tasks-Projects/task-checklists.e2e-spec.ts` |
| Task Dependencies | Tasks-Projects | `Tasks-Projects/task-dependencies.md` | `Testing/Tasks-Projects/task-dependencies.spec.ts`, `Testing/Tasks-Projects/task-dependencies.e2e-spec.ts` |
| Task Time Tracking | Tasks-Projects | `Tasks-Projects/task-time-tracking.md` | `Testing/Tasks-Projects/task-time-tracking.spec.ts`, `Testing/Tasks-Projects/task-time-tracking.e2e-spec.ts` |
| Task Templates & Recurrence | Tasks-Projects | `Tasks-Projects/task-templates-recurrence.md` | `Testing/Tasks-Projects/task-templates-recurrence.spec.ts`, `Testing/Tasks-Projects/task-templates-recurrence.e2e-spec.ts` |
| Projects & Workgroups | Tasks-Projects | `Tasks-Projects/projects-workgroups.md` | `Testing/Tasks-Projects/projects-workgroups.spec.ts`, `Testing/Tasks-Projects/projects-workgroups.e2e-spec.ts` |
| Project Members & Contextual Permissions | Tasks-Projects | `Tasks-Projects/project-members-permissions.md` | `Testing/Tasks-Projects/project-members-permissions.spec.ts`, `Testing/Tasks-Projects/project-members-permissions.e2e-spec.ts` |
| Project Kanban & Planning | Tasks-Projects | `Tasks-Projects/project-kanban-planning.md` | `Testing/Tasks-Projects/project-kanban-planning.spec.ts`, `Testing/Tasks-Projects/project-kanban-planning.e2e-spec.ts` |
| Calendars | Calendar-Meetings | `Calendar-Meetings/calendars.md` | `Testing/Calendar-Meetings/calendars.spec.ts`, `Testing/Calendar-Meetings/calendars.e2e-spec.ts` |
| Events & Meetings | Calendar-Meetings | `Calendar-Meetings/events-meetings.md` | `Testing/Calendar-Meetings/events-meetings.spec.ts`, `Testing/Calendar-Meetings/events-meetings.e2e-spec.ts` |
| Calendar Recurrence & Reminders | Calendar-Meetings | `Calendar-Meetings/recurrence-reminders.md` | `Testing/Calendar-Meetings/recurrence-reminders.spec.ts`, `Testing/Calendar-Meetings/recurrence-reminders.e2e-spec.ts` |
| Availability & Resources | Calendar-Meetings | `Calendar-Meetings/availability-resources.md` | `Testing/Calendar-Meetings/availability-resources.spec.ts`, `Testing/Calendar-Meetings/availability-resources.e2e-spec.ts` |
| Booking Pages & Bookings | Calendar-Meetings | `Calendar-Meetings/booking-pages.md` | `Testing/Calendar-Meetings/booking-pages.spec.ts`, `Testing/Calendar-Meetings/booking-pages.e2e-spec.ts` |
| External Calendar Sync | Calendar-Meetings | `Calendar-Meetings/external-calendar-sync.md` | `Testing/Calendar-Meetings/external-calendar-sync.spec.ts`, `Testing/Calendar-Meetings/external-calendar-sync.e2e-spec.ts` |
| Storages & Folders | Files-Drive-Documents | `Files-Drive-Documents/storages-folders.md` | `Testing/Files-Drive-Documents/storages-folders.spec.ts`, `Testing/Files-Drive-Documents/storages-folders.e2e-spec.ts` |
| Files, Versions & Uploads | Files-Drive-Documents | `Files-Drive-Documents/files-versions-uploads.md` | `Testing/Files-Drive-Documents/files-versions-uploads.spec.ts`, `Testing/Files-Drive-Documents/files-versions-uploads.e2e-spec.ts` |
| File Permissions & Sharing | Files-Drive-Documents | `Files-Drive-Documents/permissions-sharing.md` | `Testing/Files-Drive-Documents/permissions-sharing.spec.ts`, `Testing/Files-Drive-Documents/permissions-sharing.e2e-spec.ts` |
| Generic File Attachments | Files-Drive-Documents | `Files-Drive-Documents/attachments.md` | `Testing/Files-Drive-Documents/attachments.spec.ts`, `Testing/Files-Drive-Documents/attachments.e2e-spec.ts` |
| Document Editing & Locking | Files-Drive-Documents | `Files-Drive-Documents/document-editing.md` | `Testing/Files-Drive-Documents/document-editing.spec.ts`, `Testing/Files-Drive-Documents/document-editing.e2e-spec.ts` |
| Document Templates & Generated Documents | Files-Drive-Documents | `Files-Drive-Documents/templates-generated-documents.md` | `Testing/Files-Drive-Documents/templates-generated-documents.spec.ts`, `Testing/Files-Drive-Documents/templates-generated-documents.e2e-spec.ts` |
| Feed | Communication | `Communication/feed.md` | `Testing/Communication/feed.spec.ts`, `Testing/Communication/feed.e2e-spec.ts` |
| Chats & Messages | Communication | `Communication/chats-messages.md` | `Testing/Communication/chats-messages.spec.ts`, `Testing/Communication/chats-messages.e2e-spec.ts` |
| Channels | Communication | `Communication/channels.md` | `Testing/Communication/channels.spec.ts`, `Testing/Communication/channels.e2e-spec.ts` |
| Collabs | Communication | `Communication/collabs.md` | `Testing/Communication/collabs.spec.ts`, `Testing/Communication/collabs.e2e-spec.ts` |
| Internal Calls | Communication | `Communication/calls.md` | `Testing/Communication/calls.spec.ts`, `Testing/Communication/calls.e2e-spec.ts` |

## Cross-cutting contracts

- Tenant isolation, API envelopes, pagination, optimistic concurrency, idempotency, outbox/jobs, audit, notifications, repository-first execution and Definition of FINISHED are governed by `Agent.md` and exercised by each applicable E2E contract.
- Product decisions Q1–Q51 are preserved in `Decision-Register.md` and mapped into the relevant specifications above.
- Source coverage and priority are documented in `Source-Coverage.md`.
