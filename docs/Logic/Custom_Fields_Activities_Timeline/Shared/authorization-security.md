# Shared Authorization and Security Contract

## Workspace isolation

Every request executes in one resolved active workspace context.

Reject:

- field ID from another workspace;
- option ID from another field/workspace;
- requirement rule pointing to another workspace's stage/pipeline;
- custom value referencing another workspace user/CRM record/file where policy forbids it;
- Activity binding to another workspace;
- participant from invalid workspace context;
- Timeline comment against another workspace CRM entity.

Knowing a valid UUID must never grant access.

## Permission semantics

Semantic permission keys required by this pack:

```text
CUSTOM_FIELDS.MANAGE
REQUIRED_FIELDS.MANAGE
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

If the repository registry uses lowercase/dotted names, translate one-to-one.

## Field authorization algorithm

For a value read/write:

1. authorize owning business record;
2. load relevant field definition;
3. verify active/surface exposure for normal operation;
4. evaluate field visibility/edit restriction;
5. compute most restrictive effective access;
6. validate value/requirement;
7. perform write through owning entity transaction.

A field permission can never grant access to a record denied by CRM authorization.

## Activity authorization algorithm

### Read

1. require active workspace membership/service identity;
2. require Activity read capability/scope;
3. for bound Activity, require at least one binding visible under CRM permissions, unless the Activity is otherwise visible under unbound/personal Activity rules;
4. redact every unauthorized binding/source link;
5. filter Activity custom fields using field authorization.

### Update

1. authorize Activity update under responsibility/scope;
2. enforce state editability;
3. authorize assignment changes separately if required;
4. authorize binding additions/removals against each target CRM object;
5. validate custom-field edits;
6. optimistic concurrency check.

### Lifecycle

Use dedicated COMPLETE/REOPEN/etc. permission and current-state checks. Do not assume UPDATE automatically grants every high-impact lifecycle action.

## Timeline authorization

Before querying Timeline:

1. authorize target CRM entity;
2. require Timeline read capability;
3. query only that workspace/entity;
4. redact linked source details no longer accessible;
5. ensure stored presentation snapshots never contain secrets that cannot safely be redacted.

Comments additionally require comment permissions and normal CRM record access.

## Mention security

A mention is a notification reference, not an access grant.

If mentioned user cannot access the CRM record:

- do not expose the record through the notification payload;
- Notification module should suppress/degrade the message according to platform rules;
- never add the user to the record solely because they were mentioned.

## Reference-picker security

User/CRM/file pickers must query server-side authorized endpoints.

Do not:

- download all workspace CRM records to the browser;
- use hidden IDs from client state without server checks;
- return unauthorized names in autocomplete errors.

## Sensitive error handling

Prefer generic not-found/masked responses when distinguishing forbidden from nonexistent would leak resource existence under the repository security standard.

Field validation errors may name only fields the actor can view.

Bulk results should expose safe per-item error codes without revealing hidden entity details.

## File security

Any file used in Activity/custom field/comment must:

- exist;
- be in a usable/non-quarantined state;
- be accessible to the actor and target object according to Files policy;
- remain stored once, referenced through binding/attachment;
- not be exposed later if current permission denies it.

## Input safety

- sanitize/render Timeline/comment rich text with approved platform sanitizer;
- enforce request/body limits;
- validate enum values strictly;
- reject unknown custom field codes rather than mass-assigning arbitrary metadata;
- protect regex validation from catastrophic patterns;
- validate URLs and do not fetch arbitrary user URLs from these modules;
- normalize phone/email through shared utilities;
- validate structured JSON (address/money/config) with explicit schemas.

## Rate limits

Use platform request-limit policies for:

- admin configuration mutations;
- bulk Activity operations;
- Timeline comment creation;
- reference search/autocomplete;
- migration preview/start.

No fixed numeric values are invented by this pack; reuse platform policy/entitlement configuration.

## Audit vs Timeline

Security-sensitive configuration changes go to Audit even when they are not shown in CRM Timeline.

Timeline must never be treated as sufficient compliance evidence for configuration/permission changes.
