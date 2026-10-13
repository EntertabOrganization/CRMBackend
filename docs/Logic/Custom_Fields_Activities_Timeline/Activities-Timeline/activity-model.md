# Activity Core Model

## Activity entity

Suggested logical fields:

```text
id UUID
workspaceId UUID
typeCode string
customActivityTypeId nullable
subject string
description nullable
status PLANNED | IN_PROGRESS | COMPLETED | CANCELLED
priority LOW | NORMAL | HIGH
direction INCOMING | OUTGOING | NOT_APPLICABLE
createdByUserId/service actor
responsibleUserId UUID nullable according to type policy
startAt timestamptz nullable
endAt timestamptz nullable
deadline timestamptz nullable
location nullable
resultText nullable
completedAt timestamptz nullable
cancelledAt timestamptz nullable
cancellationReason nullable
reopenedAt nullable
adapterKind nullable
adapterResourceId nullable
externalOrigin nullable
externalId nullable
version integer
isDeleted / deletedAt repository-equivalent
createdAt
updatedAt
```

Do not persist `OVERDUE` as status.

## Type-aware field rules

The Activity type registry declares capabilities and required fields.

Examples:

### CALL

- direction applicable;
- communications normally expected;
- start/end/deadline allowed;
- result/outcome allowed.

### MEETING

- direction defaults/forces `NOT_APPLICABLE`;
- scheduling delegates to Calendar when adapter is available;
- participants allowed;
- location allowed;
- recurrence belongs to Calendar.

### EMAIL / MESSAGE

- direction applicable;
- communications expected;
- provider delivery state remains in Communication module;
- Activity may represent planned or recorded interaction.

### FOLLOW_UP

- `NOT_APPLICABLE` direction by default;
- deadline expected for reminder usefulness;
- generic Activity-owned lifecycle.

### TASK

- Task lifecycle delegates to Tasks when specialist-backed;
- Activity should not invent task recurrence/checklists/dependencies.

### DOCUMENT

- references a generated/attached document/file through Files/Documents;
- document state remains external.

### CUSTOM

- configuration comes from workspace/app type definition;
- custom fields may apply to all Activities or specific custom type.

## Activity type registry

Model built-in and custom types through a registry so UI/API validation is not a large switch statement.

Suggested descriptor:

```ts
interface ActivityTypeDescriptor {
  code: string;
  label: string;
  supportsDirection: boolean;
  supportsParticipants: boolean;
  supportsCommunications: boolean;
  supportsLocation: boolean;
  supportsFiles: boolean;
  supportsResult: boolean;
  timingPolicy: 'DEADLINE' | 'START_END' | 'FLEXIBLE';
  adapterKind?: string;
}
```

## Status

```text
PLANNED
IN_PROGRESS
COMPLETED
CANCELLED
```

Status transitions are commands, not arbitrary free-form PATCH values. Ordinary PATCH must not directly set lifecycle status when a dedicated command exists.

## Priority

```text
LOW
NORMAL
HIGH
```

Default: `NORMAL`.

## Direction

```text
INCOMING
OUTGOING
NOT_APPLICABLE
```

Validation is type-aware.

## Timing

Support type-aware:

```text
startAt
endAt
deadline
```

Rules:

- store instants as `timestamptz`;
- validate `endAt >= startAt` when both supplied;
- a type may require deadline or start/end through descriptor/adapter;
- display in user/workspace timezone;
- no generic recurrence fields in Activity core;
- an adapter may expose read-only recurrence summary from Calendar/Tasks if useful.

## Creator and responsibility

- creator/actor is recorded separately from responsible user;
- exactly one primary responsible user for normal Activity ownership;
- zero/many internal participants are stored separately;
- responsible user changes require `ACTIVITY.ASSIGN` or repository-equivalent permission when policy distinguishes assignment;
- historical responsibility remains in Timeline/Audit even after user membership changes.

## Result/outcome

Completion may include:

- optional `resultText`;
- Activity custom-field values representing structured outcome;
- specialist result reference if adapter owns authoritative outcome.

Result data is validated before completion commits.

## Files

Use shared Files service attachments/bindings. Do not store raw binary/blob fields in Activity tables.

Files added after completion are allowed only if Activity/file permission policy permits; they do not reopen the Activity automatically.

## Unbound Activities

An Activity may have zero CRM bindings.

Global personal/team follow-up remains valid.

Binding can be added later through dedicated binding APIs/commands subject to authorization.

## Custom fields on Activities

Register Activities with the Custom Fields engine.

Scopes:

- common Activity fields: target all Activities;
- specific custom Activity type fields: target a custom type discriminator/constraint.

The Activity service must include applicable custom values in the same transaction as Activity create/update where feasible.

## Acceptance criteria

- Activity status cannot be arbitrarily PATCHed around lifecycle rules.
- Invalid time ranges are rejected.
- Direction validation is type-aware.
- Priority defaults to NORMAL.
- Activity can be unbound.
- Result custom fields validate on completion.
- Files are references to the Files module.
