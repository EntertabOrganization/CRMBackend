# Errors, Idempotency, Concurrency and Retry Contract

## Stable error response

Prefer repository envelope. Semantic structure:

```json
{
  "success": false,
  "error": {
    "code": "ACTIVITY_VERSION_CONFLICT",
    "message": "The activity changed after you opened it.",
    "details": null
  },
  "requestId": "correlation-id"
}
```

Do not make clients parse human messages.

## Shared error categories

### Authentication / authorization

```text
UNAUTHENTICATED
PERMISSION_DENIED
WORKSPACE_SCOPE_VIOLATION
RESOURCE_NOT_FOUND_OR_FORBIDDEN  (if masking convention used)
```

### Configuration concurrency

```text
CONFIGURATION_VERSION_CONFLICT
ACTIVITY_VERSION_CONFLICT
```

### Field validation

```text
FIELD_VALIDATION_FAILED
FIELD_EDIT_FORBIDDEN
FIELD_REFERENCE_INVALID
FIELD_REFERENCE_FORBIDDEN
CUSTOM_FIELD_CODE_CONFLICT
CUSTOM_FIELD_DEPENDENCIES_EXIST
CUSTOM_FIELD_TYPE_MIGRATION_REQUIRED
FIELD_OPTION_INACTIVE
FIELD_REQUIREMENT_INVALID
```

### Activity

```text
ACTIVITY_INVALID_TRANSITION
ACTIVITY_EDIT_REQUIRES_REOPEN
ACTIVITY_BINDING_FORBIDDEN
ACTIVITY_TIME_INVALID
ACTIVITY_REMINDER_INVALID
ACTIVITY_ADAPTER_UNAVAILABLE
ACTIVITY_ADAPTER_CONFLICT
```

### Idempotency

```text
IDEMPOTENCY_CONFLICT
```

## Field validation details

Return all safe field violations in one response.

```json
{
  "fields": {
    "estimated_users": [
      {"code": "MAX_VALUE", "message": "Maximum allowed value is 100000."}
    ],
    "contract_number": [
      {"code": "REQUIRED", "message": "Contract Number is required."}
    ]
  }
}
```

No error for a hidden field may reveal field identity to an unauthorized actor.

## Optimistic concurrency

Use integer version/ETag equivalent on:

- custom field definitions;
- required-field rules;
- custom Activity type definitions;
- Activities;
- Timeline comments where concurrent edits matter.

On mismatch:

- do not partially write;
- return 409-style conflict;
- return current version metadata if safe;
- frontend asks user to reload/reconcile.

## Idempotency keys

Require/support idempotency for retry-sensitive operations:

```text
Activity create
Activity complete
Activity cancel
Activity reopen
bulk Activity root + per-item derived key
Timeline comment create
provider/specialist synchronization commands
field migration start where duplicate job creation would be harmful
```

### Storage

Use shared platform idempotency service/table when available.

Key scope must include enough context such as:

```text
workspace + actor/application + operation + key
```

Store normalized request fingerprint + logical result/reference.

### Same key, same request

Return the original logical result without duplicating side effects.

### Same key, different request

Return:

```text
IDEMPOTENCY_CONFLICT
```

Do not silently treat it as a new operation.

## Provider dedupe

Provider/source events use their trusted stable provider event/message/call ID in addition to platform idempotency when available.

Duplicate delivery must not create duplicate:

- Activity;
- Timeline entry;
- reminder/notification;
- completion event.

## Job retries

All background handlers must separate:

- transient retryable errors;
- permanent validation/config errors;
- permission/state changes making delayed action stale.

Retries preserve correlation/idempotency metadata.

After max retries, follow platform dead-letter/failure visibility conventions.

## Bulk operations

Do not wrap unrelated Activities in one all-or-nothing transaction.

Each item calls the single-item domain command and returns:

```text
success + resulting version/id
or
safe error code/message
```

Bound input size. The exact maximum is repository/platform policy rather than invented here.

## Reordering concurrency

Field/option reorder requests provide expected schema/config version.

All order writes are atomic.

A stale reorder must fail rather than overwrite a newer admin's configuration.

## Exactly-once meaning

Database/distributed delivery is normally at-least-once; achieve **exactly-once business effect** through uniqueness/idempotency.

Examples:

- unique Timeline projection source key;
- unique reminder occurrence key;
- unique provider origin/external ID;
- idempotency record for lifecycle command.

Do not claim queue delivery itself is exactly once.
