# Shared Notifications

`NotificationService` is the default application NotificationPort, shared by Calendar reminders and Automation. In-app delivery persists to `user_notifications` in PostgreSQL. A unique Workspace/recipient/idempotency key prevents duplicate inbox items after retries or concurrent worker delivery. The service rechecks active internal membership and notification preferences at delivery, with membership row locks serializing revocation and preference changes.

Authenticated users access their active Workspace inbox through `GET /api/v1/notifications` (`page`, `limit` up to 100) and mark an item read using `POST /api/v1/notifications/:id/read` with an empty body. Reads and writes are restricted to the recipient; foreign or other-user IDs return `NOTIFICATION_NOT_FOUND`. Inbox responses omit internal delivery identities.

`GET /api/v1/notification-preferences` reads the caller's configured preferences. `PUT` accepts `notificationType` (uppercase code), `channel` (`IN_APP`, `EMAIL`, `PUSH`) and `enabled`. Unconfigured preferences default to enabled. Preference changes cannot select another user or Workspace.

The Calendar reminder worker uses this adapter by default. Run the token-protected `POST /api/v1/internal/crm/jobs/calendar-reminders` to dispatch due reminders. Disabled channels are suppressed with durable evidence. Email and Push have no configured delivery provider yet and fail explicitly with the existing retry/backoff behavior. Applications can wire an owning delivery adapter through `setNotificationPort`; no external delivery is simulated by the default service.

Migrations `20261009090000_shared_notifications` create the inbox and preferences with composite membership foreign keys. These tables are owned directly by the shared service and are intentionally outside the business state's hydrate/persist collections, so provider I/O does not mutate another request's working state.
