# Custom & Required Fields — Frontend Specification

## Required surfaces

```text
Settings
├── Custom Fields
└── Required Fields

CRM Lead/Contact/Company/Deal
├── Create form
├── Edit form
├── Detail view
└── List columns/filters where enabled
```

Use the repository's existing component library, data-fetching strategy, form framework and routing conventions.

## Custom Fields settings list

Display at least:

- label;
- code;
- entity type;
- type;
- multiple flag;
- active state;
- search/filter/API exposure summary;
- sort/order controls;
- action menu.

Capabilities:

- search;
- filter by entity/type/active;
- create;
- edit;
- activate/deactivate;
- drag/drop or equivalent reorder;
- inspect dependency impact before deactivation;
- open type migration when required.

## Field editor

Sections should be logically grouped rather than one unstructured form:

### Basic

- entity type (create only);
- label;
- optional machine code at creation;
- help text;
- field type;
- multiple.

### Type settings

Render from field-type capabilities:

- text limits/pattern;
- numeric limits;
- list options;
- reference target types;
- file constraints;
- static default.

### Placement

- show on create;
- show on edit;
- show on detail;
- available as list column;
- sort order/reorder.

### Data capabilities

- searchable;
- filterable;
- sortable where supported;
- Forms exposure;
- Import exposure;
- Export exposure;
- API exposure.

### Permissions

Configure visibility/edit restrictions using existing role/user/department selector components where available.

## Field code UX

- if admin leaves code blank, show generated preview before save when feasible;
- clearly explain that code cannot be changed after creation because APIs/automation may depend on it;
- do not let label edits change code automatically.

## List options UX

For LIST/MULTI_LIST:

- add/edit labels;
- reorder;
- activate/deactivate;
- visually mark options already used when known;
- warn that deactivation preserves historical records;
- do not offer destructive deletion for used options.

## Deactivation dependency UX

If dependencies exist:

1. show grouped impact, for example Required Fields, Forms, Automation, Search;
2. disable final deactivation until blocking dependencies are resolved or explicitly disabled through supported actions;
3. do not silently cascade-delete dependent configuration.

## Type migration UX

When data exists:

- normal type dropdown must not silently save;
- open migration preview;
- show count of affected values;
- show convertible/non-convertible summary;
- show blocking dependencies/default/option changes;
- require explicit start;
- show async progress/status for large migrations;
- do not switch active schema until migration reports successful cutover.

## Required Fields settings

List/filter by:

- entity type;
- target field;
- pipeline;
- stage;
- active state.

Rule editor supports:

- supported system/custom target picker;
- global vs pipeline/stage context;
- nested ALL/ANY condition builder;
- type-aware operator picker;
- type-aware value control;
- validation before save.

Do not allow arbitrary code/expression input.

## Metadata-driven CRM rendering

Normal CRM create/edit/detail views request the authorized schema.

Render controls by field type and server-provided metadata.

Rules:

- hidden field: do not render;
- read-only: render non-editable in applicable surfaces;
- required-now: show required indicator and server error placement;
- inactive options on existing records: display historical label/state, but do not allow choosing them for new changes;
- inactive referenced user: display historical reference with inactive indicator where authorized;
- multi-value: preserve order and use accessible add/remove/reorder UX as appropriate;
- FILE: use shared Files upload/selection component;
- reference picker: use authorized server-side search, never load every workspace record client-side.

## Validation UX

On submit:

- preserve server field errors;
- show summary plus inline errors;
- focus/scroll to the first visible invalid field;
- never fabricate client-only success if server rejects a stage/save requirement;
- retain entered values after validation failure.

Client validation may improve UX but does not replace backend validation.

## Schema change realtime behavior

When receiving a schema change event while a form is open:

- do not silently destroy unsaved input;
- if the current schema version is stale, revalidate on submit server-side;
- where feasible, show a non-destructive "Field configuration changed" prompt and refresh metadata safely;
- if a newly required field appears, render it after refresh and preserve existing edits.

## Accessibility

- labels/help/error messages associated with controls;
- keyboard-accessible option/reorder interactions or non-drag alternatives;
- required/read-only states not conveyed by color alone;
- error summary is screen-reader discoverable;
- predictable focus after save/error.

## Acceptance criteria

- Admin can configure all supported field types without code deployment.
- Regular users receive only authorized schema.
- Hidden/read-only rules are correctly rendered but still enforced server-side.
- Conditional/stage requirements appear as required when currently applicable.
- Server returns multiple field errors and UI shows them without losing user input.
- Field deactivation/type migration UX communicates dependency/data impact.
