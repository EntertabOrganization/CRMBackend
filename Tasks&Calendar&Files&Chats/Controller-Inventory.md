# Controller & API Inventory

Controller count: **29**
Explicit endpoint/operation lines in module specs: **365**

| # | Controller | Primary specification |
|---:|---|---|
| 1 | `TasksController` | `Tasks-Projects/tasks.md` |
| 2 | `TaskChecklistsController` | `Tasks-Projects/task-checklists.md` |
| 3 | `TaskDependenciesController` | `Tasks-Projects/task-dependencies.md` |
| 4 | `TaskTimeEntriesController` | `Tasks-Projects/task-time-tracking.md` |
| 5 | `TaskTemplatesController` | `Tasks-Projects/task-templates-recurrence.md` |
| 6 | `ProjectsController` | `Tasks-Projects/projects-workgroups.md` |
| 7 | `ProjectMembersController` | `Tasks-Projects/project-members-permissions.md` |
| 8 | `ProjectStagesController` | `Tasks-Projects/project-kanban-planning.md` |
| 9 | `CalendarsController` | `Calendar-Meetings/calendars.md` |
| 10 | `CalendarEventsController` | `Calendar-Meetings/events-meetings.md` |
| 11 | `AvailabilityController` | `Calendar-Meetings/availability-resources.md` |
| 12 | `CalendarResourcesController` | `Calendar-Meetings/availability-resources.md` |
| 13 | `BookingPagesController` | `Calendar-Meetings/booking-pages.md` |
| 14 | `BookingsController` | `Calendar-Meetings/booking-pages.md` |
| 15 | `CalendarSyncController` | `Calendar-Meetings/external-calendar-sync.md` |
| 16 | `FileStoragesController` | `Files-Drive-Documents/storages-folders.md` |
| 17 | `FoldersController` | `Files-Drive-Documents/storages-folders.md` |
| 18 | `FilesController` | `Files-Drive-Documents/files-versions-uploads.md` |
| 19 | `UploadSessionsController` | `Files-Drive-Documents/files-versions-uploads.md` |
| 20 | `FileAccessController` | `Files-Drive-Documents/permissions-sharing.md` |
| 21 | `AttachmentsController` | `Files-Drive-Documents/attachments.md` |
| 22 | `DocumentTemplatesController` | `Files-Drive-Documents/templates-generated-documents.md` |
| 23 | `GeneratedDocumentsController` | `Files-Drive-Documents/templates-generated-documents.md` |
| 24 | `FeedController` | `Communication/feed.md` |
| 25 | `ChatsController` | `Communication/chats-messages.md` |
| 26 | `MessagesController` | `Communication/chats-messages.md` |
| 27 | `ChannelsController` | `Communication/channels.md` |
| 28 | `CollabsController` | `Communication/collabs.md` |
| 29 | `CallsController` | `Communication/calls.md` |

## Notes

- The count covers explicit REST operations in this pack. Internal application-service methods, WebSocket event types, background-job handlers and shared platform controllers are not counted as domain REST controllers.
- Shared Search, Notifications, Audit, Realtime, Jobs, Entitlements and Webhook delivery remain platform services; these domains integrate with them rather than duplicating their controllers.
- Exact NestJS file names may follow repository conventions, but controller ownership and route behavior must remain equivalent.
