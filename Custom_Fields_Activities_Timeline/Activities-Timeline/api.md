# Activities & Timeline — API Contract

## Base

```text
/api/v1/crm
```

## Activity type administration

```text
POST   /api/v1/crm/activity-types
GET    /api/v1/crm/activity-types
GET    /api/v1/crm/activity-types/:typeId
PATCH  /api/v1/crm/activity-types/:typeId
POST   /api/v1/crm/activity-types/:typeId/enable
POST   /api/v1/crm/activity-types/:typeId/disable
```

Requires `ACTIVITY.MANAGE_TYPES`.

Built-in types may be returned by the list endpoint but are not mutable through workspace custom-type PATCH.

## Activities

```text
POST   /api/v1/crm/activities
GET    /api/v1/crm/activities
GET    /api/v1/crm/activities/:activityId
PATCH  /api/v1/crm/activities/:activityId
DELETE /api/v1/crm/activities/:activityId
POST   /api/v1/crm/activities/:activityId/restore
POST   /api/v1/crm/activities/:activityId/start
POST   /api/v1/crm/activities/:activityId/complete
POST   /api/v1/crm/activities/:activityId/cancel
POST   /api/v1/crm/activities/:activityId/reopen
POST   /api/v1/crm/activities/bulk
```

If the repository prefers action subresources or PATCH status commands, preserve dedicated command semantics and update tests consistently.

### Create example

```json
{
  "typeCode": "CALL",
  "subject": "Follow up on proposal",
  "description": "Discuss revised terms.",
  "responsibleUserId": "user-uuid",
  "priority": "HIGH",
  "direction": "OUTGOING",
  "startAt": "2026-10-05T10:00:00Z",
  "endAt": "2026-10-05T10:30:00Z",
  "deadline": "2026-10-05T10:00:00Z",
  "bindings": [
    {"entityType": "DEAL", "entityId": "deal-uuid"},
    {"entityType": "CONTACT", "entityId": "contact-uuid"}
  ],
  "communications": [
    {
      "type": "PHONE",
      "crmEntityType": "CONTACT",
      "crmEntityId": "contact-uuid",
      "value": "+12025550123"
    }
  ],
  "participants": ["participant-user-uuid"],
  "reminders": [
    {
      "mode": "RELATIVE",
      "relativeTo": "START",
      "offsetSeconds": -3600,
      "recipientUserIds": ["user-uuid"]
    }
  ],
  "customFields": {},
  "idempotencyKey": "client-create-key"
}
```

Do not accept a client `workspaceId` as authorization truth.

### PATCH

Accept editable business fields only and `expectedVersion`/If-Match equivalent.

Do not allow direct lifecycle jumps by patching `status` when a dedicated command exists.

### Complete

```json
{
  "expectedVersion": 7,
  "idempotencyKey": "complete-key",
  "resultText": "Customer requested revised pricing.",
  "customFields": {
    "call_outcome": "FOLLOW_UP_REQUIRED"
  }
}
```

### Cancel

```json
{
  "expectedVersion": 7,
  "idempotencyKey": "cancel-key",
  "reason": "Customer requested cancellation."
}
```

Reason optional.

### Reopen

```json
{
  "expectedVersion": 8,
  "idempotencyKey": "reopen-key",
  "reason": "Customer reopened discussion."
}
```

Reason optional.

## Bindings

Dedicated endpoints/commands are recommended:

```text
GET    /api/v1/crm/activities/:activityId/bindings
POST   /api/v1/crm/activities/:activityId/bindings
DELETE /api/v1/crm/activities/:activityId/bindings/:bindingId
```

Every mutation independently authorizes target record.

## Reminders

May be managed inside Activity PATCH or dedicated routes. If dedicated:

```text
GET    /api/v1/crm/activities/:activityId/reminders
POST   /api/v1/crm/activities/:activityId/reminders
PATCH  /api/v1/crm/activities/:activityId/reminders/:reminderId
DELETE /api/v1/crm/activities/:activityId/reminders/:reminderId
```

Delete reminder means cancel/remove future reminder definition; preserve audit history.

## Activity list / global Activities

Cursor-based:

```text
GET /api/v1/crm/activities
```

Supported allowlisted filters include:

```text
cursor
limit
status
priority
typeCode
responsibleUserId
participantUserId
bindingEntityType
bindingEntityId
overdue true|false
deadlineFrom
deadlineTo
createdFrom/createdTo
includeDeleted authorized only
search subject/description according to policy
sort/deadline ordering predefined rather than arbitrary DB columns
```

Default normal-user view semantics correspond to **My Open Activities**, overdue/urgent first.

## Bulk

```text
POST /api/v1/crm/activities/bulk
```

Conceptual input:

```json
{
  "operation": "COMPLETE",
  "activityIds": ["a", "b", "c"],
  "idempotencyKey": "bulk-root",
  "payload": {}
}
```

Return partial per-item outcomes.

## Timeline

Locked family:

```text
GET  /api/v1/crm/:entityType/:entityId/timeline
POST /api/v1/crm/:entityType/:entityId/timeline/comments
GET  /api/v1/crm/timeline/comments/:commentId
PATCH /api/v1/crm/timeline/comments/:commentId
DELETE /api/v1/crm/timeline/comments/:commentId
```

### Timeline query

```text
?cursor=...
&limit=50
&category=ACTIVITY,COMMUNICATION,PAYMENT
&actorUserId=...
&from=...
&to=...
&sourceType=...
```

Cursor is deterministic across same timestamp using stable tie-breaker.

## Comment create example

```json
{
  "body": "Customer confirmed the revised scope. @Sara",
  "linkedActivityId": "activity-uuid",
  "fileIds": ["file-uuid"],
  "mentions": [{"userId": "user-uuid"}],
  "idempotencyKey": "comment-create-key"
}
```

Do not trust free-text mention parsing alone. Server validates stable mentioned user IDs.

## Response redaction

Activity responses:

- include only authorized CRM bindings;
- include custom fields according to field visibility;
- do not expose hidden CRM reference details;
- include deleted/inactive history only when endpoint/query permission allows it.

Timeline responses:

- only after target CRM record authorization;
- presentation snapshot must already be sanitized and may need current-access redaction for linked details.

## Stable errors

At minimum:

```text
ACTIVITY_NOT_FOUND
ACTIVITY_TYPE_NOT_FOUND
ACTIVITY_TYPE_DISABLED
ACTIVITY_INVALID_TRANSITION
ACTIVITY_EDIT_REQUIRES_REOPEN
ACTIVITY_ASSIGN_FORBIDDEN
ACTIVITY_BINDING_FORBIDDEN
ACTIVITY_BINDING_SCOPE_VIOLATION
ACTIVITY_TIME_INVALID
ACTIVITY_REMINDER_INVALID
ACTIVITY_ADAPTER_UNAVAILABLE
ACTIVITY_ADAPTER_CONFLICT
ACTIVITY_VERSION_CONFLICT
ACTIVITY_BULK_LIMIT_EXCEEDED
TIMELINE_ACCESS_FORBIDDEN
TIMELINE_COMMENT_NOT_FOUND
TIMELINE_COMMENT_EDIT_FORBIDDEN
TIMELINE_COMMENT_DELETE_FORBIDDEN
IDEMPOTENCY_CONFLICT
WORKSPACE_SCOPE_VIOLATION
```

## Idempotency

Support keys for retry-sensitive:

- create Activity;
- complete;
- cancel;
- reopen;
- comment create;
- provider/specialist synchronization.

Same key + same normalized request returns same logical result. Same key + materially different request returns `IDEMPOTENCY_CONFLICT`.

## Acceptance criteria

- Activity CRUD/commands use stable route family.
- Status commands cannot be bypassed through PATCH.
- List/timeline pagination is cursor based.
- Unauthorized bindings are redacted.
- Bulk returns explicit partial results.
- Timeline comments respect current CRM access and comment permissions.
