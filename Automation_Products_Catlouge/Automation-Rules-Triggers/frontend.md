# Automation Frontend Specification

## Main surfaces

### Automation Rule list

Display:

- name;
- target;
- trigger summary;
- operational status;
- active revision;
- priority;
- last run status/time;
- enabled/paused state.

Support search/filter and permission-aware actions.

### Rule designer

Recommended sections:

```text
Rule Basics
Trigger
Conditions
Actions
Timing
Execution/Safety
Review & Publish
```

## Condition builder

- nested ALL/ANY groups;
- field/variable selector supplied by backend metadata;
- type-aware operator selector;
- typed value editor;
- prevent unsupported combinations before submit while server remains authoritative;
- enforce nesting/node limits.

## Action editor

- action type palette grouped by module/category;
- schema-driven configuration;
- drag/drop or explicit reorder;
- `continueOnError` control where action supports it;
- timing/delay where defined at action/rule level by final backend model;
- show unavailable dependency/extension clearly.

Do not hard-code every future Action in one giant component. Render configuration from registered action metadata plus specialized editors only where needed.

## Publish flow

Publish screen shows:

- target/trigger;
- condition summary;
- ordered actions;
- timing;
- execution identity summary;
- warnings/dependencies;
- validation errors.

Only users with publish permission see/execute Publish.

## Dry run

User selects an eligible target record or provides allowed test context. UI shows:

- matched / not matched;
- condition decisions;
- resolved action previews with secrets redacted;
- validation warnings;
- explicit banner: no business side effects executed.

## Execution logs

List/detail must show:

- Rule/revision;
- target;
- Trigger/event;
- status;
- duration;
- actions and attempts;
- failure code/summary;
- retry/cancel controls when allowed;
- correlation ID for support.

## Realtime

Use shared realtime for job/execution status refresh if available. REST reload remains authoritative.

## UX error states

Handle:

- stale Rule version conflict;
- extension removed/disabled;
- referenced field/stage no longer available;
- publish validation failure;
- permission loss while page is open;
- target deleted during dry run/manual execution.

## Acceptance criteria

- Admin can build and publish a valid Rule without editing JSON manually.
- Invalid configuration is highlighted at the relevant section.
- Reorder persists deterministically.
- Dry run never performs a real action.
- Execution failure is inspectable from UI.
