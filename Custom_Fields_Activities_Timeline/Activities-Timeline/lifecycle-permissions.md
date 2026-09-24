# Activity Lifecycle, Permissions, Overdue and Bulk Operations

## Lifecycle

Allowed transitions:

```text
PLANNED -> IN_PROGRESS
PLANNED -> COMPLETED       (allowed when type/workflow permits direct completion)
PLANNED -> CANCELLED
IN_PROGRESS -> COMPLETED
IN_PROGRESS -> CANCELLED
COMPLETED -> IN_PROGRESS   (explicit reopen)
CANCELLED -> PLANNED       (explicit reopen)
```

Any unsupported transition returns a stable `ACTIVITY_INVALID_TRANSITION`.

## Editability by state

### PLANNED / IN_PROGRESS

Authorized business fields may be updated.

### COMPLETED

Business fields that change the meaning of completed work require explicit reopen first.

Allowed without reopen when separately authorized:

- Timeline comments;
- additional file attachments if product policy allows;
- non-business metadata that does not rewrite history, only if explicitly defined.

Do not permit ordinary PATCH to rewrite completion time/result/history silently.

### CANCELLED

Requires explicit reopen to resume business work.

## Complete command

Dedicated command:

```text
POST /activities/:id/complete
```

Input may include:

```json
{
  "idempotencyKey": "client-key",
  "resultText": "Customer approved the location.",
  "customFields": {
    "visit_outcome": "APPROVED"
  },
  "expectedVersion": 7
}
```

Rules:

- require `ACTIVITY.COMPLETE` plus resource scope;
- validate result custom fields/requirements if applicable;
- delegate specialist completion when authoritative adapter exists;
- commit state/result/outbox atomically after authoritative outcome;
- repeating same idempotency key returns same logical outcome;
- already completed Activity completion is idempotent and must not create duplicate Timeline/outbox side effects.

## Cancel command

Cancellation reason is optional.

- require appropriate update/cancel permission; if separate key is introduced, map consistently;
- delegate to specialist adapter if necessary;
- cancel pending reminders;
- project meaningful Timeline entry;
- preserve previous history.

## Reopen command

Transitions:

```text
COMPLETED -> IN_PROGRESS
CANCELLED -> PLANNED
```

Reason is optional.

Require `ACTIVITY.REOPEN`.

Reopening may create/reschedule reminders only from currently configured reminder definitions if still meaningful; do not resurrect already-sent occurrence keys as duplicates.

## Soft delete / restore

Soft delete:

- require `ACTIVITY.DELETE`;
- hide from normal lists;
- cancel pending reminders;
- preserve audit/timeline evidence;
- do not delete specialist source record unless an explicit separate specialist operation is requested and authorized;
- emit deleted event/realtime refresh.

Restore:

- restore Activity visibility when retention has not purged it;
- revalidate bindings/responsible/custom type availability;
- do not automatically resend past reminders;
- preserve old Timeline deletion/restoration history as meaningful events where product UX requires it.

No fixed purge period is defined here. Shared retention policy controls hard purge.

## Overdue

`OVERDUE` is derived when:

```text
Activity is not COMPLETED/CANCELLED/deleted
AND applicable deadline time < current time
```

If a type uses end/start as its deadline basis, centralize that resolution in the type descriptor.

### Exactly-once overdue occurrence

Create a durable occurrence/idempotency record or equivalent unique key such as:

```text
activityId + deadlineVersion/deadline timestamp + OVERDUE
```

When deadline moves into the future then later passes again, a new overdue occurrence may be valid. Do not suppress it forever just because the Activity was overdue once under an older deadline.

Emit:

```text
ACTIVITY_OVERDUE
```

once per applicable occurrence for Automation/Notification consumers.

## Permission keys

Semantic keys:

```text
ACTIVITY.CREATE
ACTIVITY.READ
ACTIVITY.UPDATE
ACTIVITY.DELETE
ACTIVITY.COMPLETE
ACTIVITY.REOPEN
ACTIVITY.ASSIGN
ACTIVITY.MANAGE_TYPES
TIMELINE.READ
TIMELINE.COMMENT
TIMELINE.COMMENT_EDIT
TIMELINE.COMMENT_DELETE
```

Map naming to the repository registry (for example `activity.create`) if required; preserve granularity.

## Scope evaluation

Use existing TrueCRM scopes such as Own, Department, Department Tree, Team/All where available.

`OWN` should include at minimum Activities for which the user is responsible; repository policy may also include creator/participant only if explicitly consistent with the authorization model. Do not silently broaden OWN to every Activity the user can mention.

Manager scopes resolve through current organization membership but must not rewrite historical responsible data.

## Multi-binding permission

Read:

- Activity permission/scope + at least one authorized binding or authorized unbound-Activity access.

Update Activity:

- based on Activity permission/scope/responsibility;
- do not require access to every redacted binding merely to update subject/deadline if policy permits.

Add/remove a binding:

- separately authorize target CRM record.

## Bulk actions

Supported:

```text
reassign
complete
cancel
soft-delete
```

Input contains bounded list of Activity IDs and operation payload/idempotency root.

Behavior:

- process each item independently through the same single-item domain command;
- reauthorize/revalidate each item;
- return partial success with per-item result;
- do not silently ignore failures;
- use stable per-item idempotency key derived from bulk request + Activity ID;
- avoid one giant transaction across unrelated Activities.

Response concept:

```json
{
  "succeeded": 17,
  "failed": 3,
  "results": [
    {"id": "a", "success": true},
    {"id": "b", "success": false, "code": "PERMISSION_DENIED"}
  ]
}
```

## Timeline-worthy Activity changes

Normally project:

- created;
- major reschedule;
- reassignment;
- completion;
- cancellation;
- reopen;
- deletion/restoration where useful to CRM history.

Minor description/title edits stay in Audit unless product policy marks them meaningful.

## Acceptance criteria

- Illegal transitions fail.
- Completed/cancelled work cannot be silently rewritten through PATCH.
- Complete is idempotent.
- Reopen uses locked transitions.
- Overdue event fires once per deadline occurrence, not once forever.
- Bulk operations partially succeed with explicit failures.
- Soft delete does not erase Timeline/Audit evidence or specialist source records.
