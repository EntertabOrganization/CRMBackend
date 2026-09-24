# Shared Data Model and Relationship Contract

## Purpose

This file consolidates cross-file persistence expectations so the coding agent does not create contradictory tables/relationships between Custom Fields, Activities and Timeline.

## Entity map

```text
Workspace
├── CustomFieldDefinition
│   ├── CustomFieldOption
│   ├── CustomFieldValue -> field-capable business entity
│   ├── FieldVisibilityRule
│   └── FieldRequirement (target or condition dependency)
│
├── ActivityType (workspace custom types)
├── Activity
│   ├── ActivityBinding -> CRM Lead/Contact/Company/Deal
│   ├── ActivityParticipant -> User
│   ├── ActivityCommunication -> CRM record + historical value snapshot
│   ├── ActivityReminder
│   │   └── ActivityReminderRecipient -> User
│   └── CustomFieldValue(s) through generic field engine
│
└── TimelineEntry -> CRM entity read model
    └── TimelineComment / mention / file attachment references
```

## Suggested PostgreSQL tables

Names may adapt to repository conventions. Preserve semantics.

### Custom fields

```text
crm_custom_fields
crm_custom_field_options
crm_custom_field_values
crm_field_visibility_rules
crm_field_requirements
crm_field_requirement_conditions  (if normalized instead of validated JSON)
crm_custom_field_migrations
```

### Activities

```text
crm_activity_types
crm_activities
crm_activity_bindings
crm_activity_participants
crm_activity_communications
crm_activity_reminders
crm_activity_reminder_recipients
crm_activity_overdue_occurrences or shared idempotency/event occurrence storage
```

### Timeline

```text
crm_timeline_entries
crm_timeline_comments
crm_timeline_comment_mentions
```

Use the shared Files attachment system instead of creating duplicate file-binary tables.

## Core constraints

### Custom fields

- unique `(workspace_id, entity_type, code)`;
- field option belongs to same workspace through its field;
- field value belongs to one field and one same-workspace target entity;
- field value ordinal unique per `(field_id, entity_type, entity_id, ordinal)`;
- list value must reference an option from the same field;
- requirement target/conditions must reference same-workspace fields/pipeline/stage.

### Activities

- all child rows belong to Activity's workspace;
- binding unique `(activity_id, entity_type, entity_id)`;
- participant unique `(activity_id, user_id, role)` or repository-equivalent;
- reminder recipient unique `(reminder_id, user_id)`;
- external provider mapping unique enough to dedupe source interaction, e.g. `(workspace_id, origin, external_id)` where applicable;
- custom activity type code unique per workspace.

### Timeline

- every entry targets one workspace CRM entity;
- source event dedupe key unique per intended projection target;
- comment belongs to one Timeline/CRM target and same workspace;
- mention user is validated against workspace policy;
- projected entries and user comments must not share destructive cascade paths that erase history unexpectedly.

## Same-workspace validation

Database constraints should enforce workspace consistency where practical. Service-level checks remain mandatory because many polymorphic references cannot be fully enforced by ordinary foreign keys.

Never infer workspace from an untrusted request entity ID without loading/validating the referenced parent.

## Typed custom value integrity

A value row should satisfy exactly the storage columns required by its field type. Enforce in application validation; add CHECK constraints where maintainable.

Examples:

- INTEGER => integer populated, unrelated scalar columns null;
- BOOLEAN => boolean populated;
- DATE => date populated;
- LIST => option reference populated;
- multi-value => multiple rows, not comma-separated storage.

## Money and address

`MONEY` contains amount + currency. Amount uses precise numeric semantics. Currency uses a validated code/reference.

`ADDRESS` may use validated JSON for the structured payload because it is naturally composite, but the schema must be explicit/versioned and not accept arbitrary keys silently.

## Soft-deletion references

Do not cascade hard-delete historical values merely because:

- user leaves workspace;
- referenced CRM record is archived/deleted;
- custom field deactivates;
- custom activity type disables;
- Activity is soft-deleted.

Normal reads decide whether to show inactive/deleted referenced objects with historical labels or redacted placeholders according to access policy.

## Index guidance

Baseline operational indexes:

- custom fields: workspace/entity/active/sort/code;
- values: workspace/entityType/entityId/fieldId;
- list options: field/active/sort;
- requirements: workspace/entity/pipeline/stage/active;
- Activities: workspace/responsible/status/deadline; workspace/deleted; type; start/end as query needs justify;
- bindings: workspace/entityType/entityId and activityId;
- reminders: status/scheduled execution time;
- Timeline: workspace/entityType/entityId/occurredAt/id; source event dedupe columns;
- comments: workspace/entityType/entityId/createdAt.

Dynamic field filter/search indexes are created only for fields explicitly enabled and supported. Do not create an index per every custom field by default.

## Transaction boundaries

Atomic together when part of one logical domain change:

- owning CRM record + its custom values + owning outbox event;
- field definition + initial options + audit/outbox;
- Activity + bindings/participants/communications/reminders/custom values + outbox;
- Activity lifecycle state + result + outbox + reminder cancellation state where local;
- Timeline comment + mention refs + audit/outbox.

Timeline projections occur after source commit through events and are idempotent.

## Data ownership rule

Cross-module read references are allowed through contracts/read services. Cross-module direct writes are forbidden. Do not add foreign-key cascades that give Activities ownership of Calendar/Task/Communication/File source records.
