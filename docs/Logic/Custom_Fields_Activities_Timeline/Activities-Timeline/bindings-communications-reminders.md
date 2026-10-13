# Activity Bindings, Communications, Participants and Reminders

## CRM bindings

One Activity may bind to zero or many CRM records.

Initial supported binding types should align with implemented CRM Core:

```text
LEAD
CONTACT
COMPANY
DEAL
```

Future field/entity registration can extend supported binding types through a registry rather than hard-coded table-specific code.

## Binding model

Suggested:

```text
id UUID
workspaceId UUID
activityId UUID
entityType
entityId UUID
isPrimary boolean optional
createdAt
createdByActor
```

Unique constraint:

```text
(activity_id, entity_type, entity_id)
```

Every binding must be same-workspace.

## Visibility rule

To see an Activity through CRM context, actor must:

1. have `ACTIVITY.READ` in applicable scope;
2. have access to at least one bound CRM record, or qualify through unbound/own Activity access rules.

When an Activity has multiple bindings:

- include only bindings the actor may read;
- do not reveal hidden binding count/name/ID/type if that would disclose restricted records;
- a Timeline on an authorized CRM record may show the Activity entry for that record even when other bindings are redacted.

## Binding mutation

Adding/removing a binding requires:

- permission to edit/manage the Activity or bind according to module policy;
- appropriate read/edit/link permission on target CRM record;
- same-workspace validation;
- target record active/allowed state according to CRM policy.

Activity-edit permission alone is not enough to attach an arbitrary restricted Company/Deal.

## Participants

Internal participants are TrueCRM user identities/workspace members, not CRM Contacts.

Suggested:

```text
crm_activity_participants
- activityId
- userId
- role PARTICIPANT | WATCHER or repository-equivalent
- workspaceId
```

A responsible user is stored on Activity separately.

Participation must not grant broader CRM record access automatically unless platform policy explicitly says so.

## Communications

Customer communication endpoints are distinct from internal participants.

Suggested logical record:

```text
id UUID
workspaceId
activityId
communicationType PHONE | EMAIL | MESSENGER | OTHER
crmEntityType nullable
crmEntityId nullable
normalizedValue
rawDisplayValue nullable/safe
label/type metadata nullable
isPrimary nullable
createdAt
```

Store both:

- CRM reference where applicable;
- normalized value used at the time.

This preserves accurate history if the Contact later changes phone/email.

Do not automatically update old Activity communication snapshots when CRM communication fields change.

## Communication normalization

Use shared CRM/Communication normalizers.

- email: normalized according to platform email rules;
- phone: normalized format where possible while retaining safe display value;
- messenger: channel identity + provider-safe identifier;
- never use display label as dedupe identity.

## Reminders

Reminder schedules attach to Activities.

Suggested model:

```text
id UUID
workspaceId
activityId
mode RELATIVE | ABSOLUTE
relativeTo START | DEADLINE nullable
offsetSeconds nullable
absoluteAt timestamptz nullable
status SCHEDULED | SENT | CANCELLED
occurrenceKey/idempotencyKey
createdAt
```

Recipients may use a child table:

```text
activityReminderId
userId
```

Allowed recipients are selected from:

- responsible user;
- eligible internal participants.

The server validates recipient eligibility at reminder creation/update.

## Relative reminders

Examples:

```text
1 day before DEADLINE
1 hour before START
15 minutes before START
```

If the source time changes, recompute pending reminder jobs transactionally/safely.

If the new reminder time is already in the past:

- do not silently create repeated immediate notifications;
- apply a documented policy such as schedule immediately once if still meaningful, or reject during edit. Prefer repository Notification scheduler convention and cover with tests.

The exact past-reminder UX policy is not explicitly locked by source documents; choose the safest repository-consistent behavior and document it in implementation notes.

## Absolute reminders

Store as `timestamptz` and do not shift merely because user timezone preference changes after creation. Display using current display timezone.

## Reminder delivery

Reminder scheduler emits a notification event/job; Notification module decides channel delivery according to user preferences.

Activities does not send email/push directly.

Required properties:

- retries are idempotent;
- `SENT` is recorded only after the notification handoff contract succeeds according to platform semantics;
- duplicate worker execution does not produce duplicate logical reminder occurrence;
- cancelled/completed/deleted Activities cancel irrelevant pending reminders according to type/policy.

## Notification triggers beyond reminders

Activities should emit events suitable for Notifications for:

- assignment;
- reassignment;
- participant invitation/addition where applicable;
- reminders;
- overdue;
- cancellation;
- selected completion events according to notification preference/policy.

Activities publishes business events; Notification preferences control actual channels.

## Acceptance criteria

- Same Activity may bind to Deal + Contact + Company.
- A user with access only to the Deal sees only authorized binding information.
- Cross-workspace bindings fail.
- Historical communication value does not change when Contact phone/email changes.
- Multiple reminders can target selected responsible/participant users.
- Reminder retry does not duplicate logical delivery.
- Completing/deleting an Activity prevents irrelevant future reminders.
