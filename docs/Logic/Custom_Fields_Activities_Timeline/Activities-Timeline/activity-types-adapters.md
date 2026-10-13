# Activity Types and Specialist Adapters

## Custom Activity types

TrueCRM supports two custom-type sources:

1. workspace-defined custom Activity types;
2. app/provider-defined types registered through controlled integration mechanisms.

## Workspace custom type model

Suggested fields:

```text
id UUID
workspaceId UUID
code string
name string
icon nullable
colorToken nullable
defaultDurationMinutes nullable
defaultPriority LOW|NORMAL|HIGH
defaultDirection INCOMING|OUTGOING|NOT_APPLICABLE
enabled boolean
version integer
createdAt
updatedAt
```

Code is immutable after creation and unique per workspace.

Do not accept arbitrary SVG/script/icon markup. Use approved icon identifiers/assets according to frontend platform policy.

## Custom type defaults

Defaults seed the create form but do not overwrite explicitly supplied values.

- default duration may calculate proposed `endAt` from `startAt` client/server-side consistently;
- default priority/direction must still pass type rules;
- disabling a type prevents new Activities of that type but does not corrupt historical Activities.

## App/provider types

Provider/app-defined types require a stable owner/application identity and must not let one integration impersonate another integration's type.

Suggested identity:

```text
workspaceId or installation scope
provider/app installation ID
type code
```

Registration/unregistration must preserve historical Activities. Disable rather than delete a type that has Activity history.

## Activity adapter contract

Specialist types use adapters. Suggested contract:

```ts
interface ActivitySpecialistAdapter {
  readonly kind: ActivityAdapterKind;

  create?(ctx: ActivityAdapterCreateContext): Promise<ActivityAdapterResult>;
  update?(ctx: ActivityAdapterUpdateContext): Promise<ActivityAdapterResult>;
  complete?(ctx: ActivityAdapterCompleteContext): Promise<ActivityAdapterResult>;
  cancel?(ctx: ActivityAdapterCancelContext): Promise<ActivityAdapterResult>;
  reopen?(ctx: ActivityAdapterReopenContext): Promise<ActivityAdapterResult>;
  syncFromSource?(event: DomainEvent): Promise<void>;
}
```

Exact method set can vary; preserve authority direction.

## Calendar / Meeting adapter

Calendar Event is authoritative for meeting scheduling.

### Create meeting from CRM

```text
Activity command validates CRM/access/custom fields
→ call Calendar create/event service in controlled orchestration
→ Calendar validates availability/attendees/resource/time
→ receive confirmed event ID/state
→ save/link Activity representation + adapterResourceId
→ outbox/timeline after successful domain outcome
```

Use a transaction/orchestration pattern appropriate to modular monolith boundaries. Do not directly insert into Calendar tables.

If distributed failure exists between modules, use idempotent compensation/retry rather than leaving hidden divergence.

### Update meeting

CRM UI delegates timing/attendee changes to Calendar. Activity reflects confirmed values.

### Recurrence

Calendar owns recurrence rule and instances. Activity may reference/display summary but must not schedule duplicate recurring Activities independently.

## Tasks adapter

Tasks owns:

- task status;
- recurrence;
- checklist;
- dependencies;
- time tracking;
- project membership constraints.

Activity representation may expose CRM-centric summary/binding.

Completing Task through CRM calls Tasks service first/through orchestration. Do not independently mark Activity completed if authoritative Task completion failed.

## Communication adapter

For EMAIL/MESSAGE/CALL provider interactions:

- provider/integration verification occurs in Communication/Contact Center;
- source provider event is persisted/deduped there;
- adapter creates/updates corresponding CRM Activity representation;
- store source origin/external ID mapping;
- Timeline uses stable source event identity;
- provider delivery/read state remains in source module unless a read-only summary is projected.

Retries with the same external event ID must not create duplicate Activities.

## Files/Documents adapter

DOCUMENT Activity stores stable shared document/file reference.

Generated document remains owned by Documents module. Regeneration/versioning does not clone the file into Activities.

## Adapter unavailable

If a specialist module is not implemented yet:

- provide interface/port + deterministic fake in tests;
- generic Activities must still compile/run;
- type may be feature-gated/disabled until adapter registration;
- do not build a second Calendar/Tasks/Communication module inside Activities.

## Failure behavior

- adapter validation errors return stable domain errors;
- transient failures may retry if side effects are idempotent;
- external timeout does not produce a falsely completed Activity;
- orphan link detection/reconciliation may be implemented as a background health job if repository architecture supports it;
- all retries preserve correlation/idempotency keys.

## Audit/events

At minimum:

```text
ACTIVITY_TYPE.CREATED
ACTIVITY_TYPE.UPDATED
ACTIVITY_TYPE.ENABLED
ACTIVITY_TYPE.DISABLED
ACTIVITY.ADAPTER_LINKED
ACTIVITY.ADAPTER_SYNC_FAILED
```

## Acceptance criteria

- Workspace can create custom Activity types without deployment.
- Disabling a custom type blocks new Activities but preserves history.
- Meeting edits flow through Calendar authority.
- Task completion flows through Tasks authority.
- Duplicate provider communication events do not create duplicate Activities.
- Missing adapter does not cause the module to silently duplicate specialist functionality.
