# Activities & Timeline — Frontend Specification

## Required surfaces

```text
CRM record
├── Activities / Things to do
└── Timeline

Global CRM
└── Activities
    ├── List
    └── Deadline Board

Settings
└── Activity Types
```

Use the existing TrueCRM design system, routing and state/data libraries.

## CRM Activities section

For an authorized CRM record, show:

- open/planned Activities relevant to that record;
- quick create actions for supported Activity types;
- responsible user;
- due/start time;
- priority;
- type/icon;
- overdue indicator;
- complete/cancel/reopen actions when authorized;
- link to full Activity details.

Do not reveal other unauthorized bindings.

## Activity create/edit form

Common sections:

### Basic

- type;
- subject;
- description;
- priority;
- direction where applicable;
- responsible user;
- internal participants.

### Timing

Type-aware:

- start;
- end;
- deadline;
- location when applicable.

### CRM links

- current CRM record preselected when launched from record;
- add additional authorized Lead/Contact/Company/Deal bindings;
- server-side search pickers;
- no client-only permission assumptions.

### Communications

For communication types:

- select Contact/Company communication value where appropriate;
- show normalized/display value;
- allow safe manual value only if domain policy permits it;
- preserve value snapshot after save.

### Reminders

- add multiple reminders;
- absolute or relative;
- select eligible recipients from responsible + participants;
- clear timezone display.

### Custom fields

Render authorized Activity/custom-type fields from the Custom Fields schema endpoint.

## Completed/cancelled UX

For completed/cancelled Activities:

- render business fields read-only;
- show result/cancellation metadata;
- allow comments/files where authorized;
- show `Reopen` only with permission;
- do not offer normal edit controls that would silently rewrite completed history.

## Global Activities default

Default normal-user landing state:

```text
My Open Activities
```

Include Activities where the user is responsible according to server authorization/query semantics.

Sort/surface overdue first, then deadline urgency.

## List view

Columns may include:

- type/icon;
- subject;
- CRM context (authorized bindings only);
- responsible;
- priority;
- start/deadline;
- status;
- overdue;
- quick actions.

Filters:

- My/Department/All where permission permits;
- type;
- status;
- priority;
- responsible;
- CRM binding;
- overdue;
- deadline/date range.

Use cursor pagination/infinite load or repository-standard cursor UI.

## Deadline Board

Required groups:

```text
Overdue
Today
Upcoming
Later
No Deadline
Completed
```

The exact date boundaries for Upcoming/Later must be centralized in UI/domain configuration so List and Board agree. If the repository already has activity deadline grouping conventions, reuse them.

Moving an Activity between groups through drag/drop is optional unless it maps unambiguously to a deadline change. Do not infer a new arbitrary time from a drag without clear UX rules.

## Bulk selection

Support when authorized:

- reassign;
- complete;
- cancel;
- soft delete.

After operation:

- show succeeded/failed count;
- show per-item reason for failures where safe;
- refresh successful rows;
- retain failed selections for correction if useful;
- never display "Success" for the whole operation when some items failed.

## Settings — Activity Types

List custom workspace Activity types with:

- name;
- code;
- icon/color preview;
- enabled state;
- defaults;
- custom-field count/summary where available.

Editor:

- name;
- code at creation only;
- approved icon picker;
- color token/picker under design-system rules;
- default duration;
- default priority;
- default direction;
- enabled state;
- link to configure custom fields for this type.

Disabling a used type must explain that historical Activities remain.

## Timeline UI

Timeline appears in CRM record detail.

Features:

- newest-first or existing product convention;
- infinite/cursor load;
- filters by category/date/actor where useful;
- distinct icons/cards by category;
- collapsed grouping of noisy related entries without deleting underlying entries;
- safe display snapshot when source record changed/deleted;
- link to source object only if currently accessible.

## Timeline comments

Comment composer supports:

- text;
- shared file attachments;
- @mentions using stable user IDs;
- Activity link where launched from an Activity discussion.

Comment actions:

- edit when authorized;
- soft delete when authorized;
- deleted-state UI rather than exposing removed content;
- mention notification does not change CRM permissions.

## Realtime behavior

Realtime updates:

- add/update Activity cards;
- reflect completion/cancel/reopen;
- add Timeline entry/comment;
- reflect comment edit/delete;
- refresh custom schema when relevant.

Client must dedupe by stable ID/event version so the same item is not rendered twice after optimistic UI + realtime + query refetch.

REST/query cache remains authoritative.

## Adapter UX

### Meeting

Open/use Calendar-backed scheduling controls when available. Show Calendar validation/conflict errors directly.

### Task

Task-specific advanced actions link to Tasks; CRM Activity surface should not create fake recurrence/checklist controls.

### Communication

Show source/provider delivery/read summary only when provided by authorized Communication APIs.

### Document

Use Files/Documents picker/viewer.

## Accessibility

- keyboard-operable Activity actions/menus;
- time/status not conveyed by color alone;
- readable overdue/priority labels;
- accessible mention and file controls;
- confirmation dialogs for destructive/bulk actions where appropriate;
- preserve focus after realtime list changes when feasible.

## Acceptance criteria

- User can create Activity from CRM record or global area.
- Default global view is My Open Activities.
- Deadline Board groups Activities correctly.
- Completed/cancelled Activity cannot be silently edited without reopen.
- Bulk partial failures are visibly reported.
- Timeline pagination/filter/comments work without duplicate realtime entries.
- Unauthorized bindings never appear in UI payload/state.
