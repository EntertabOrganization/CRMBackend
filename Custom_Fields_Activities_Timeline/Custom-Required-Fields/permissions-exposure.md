# Field Permissions, Exposure and Authorized Schema

## Goal

Ensure dynamic fields participate in the same TrueCRM authorization model as their owning record while supporting stricter field-specific visibility/edit rules.

## Core rule

Field permission can **narrow** normal record access but cannot broaden it.

```text
Record = EDIT, Field = READ_ONLY  => effective = READ
Record = READ, Field = EDIT       => effective = READ
Record = NONE, Field = EDIT       => effective = NONE
```

## Permission subjects

The configuration must integrate with the existing authorization engine rather than inventing a new user/role system.

Applicable subject/reference types may include:

- role;
- user;
- department;
- department tree;
- other existing TrueCRM scope constructs if already supported.

The exact persistence may use generalized permission entries or a module-specific field visibility table, but evaluation must reuse the platform's canonical organizational relationships.

## Rule capabilities

A field rule needs to express at least:

```text
VIEW
EDIT
```

The default is inherited from record permission unless field restrictions reduce it.

When multiple applicable field rules exist, the **most restrictive applicable result wins**.

Avoid an ambiguous explicit `ALLOW` rule that could accidentally override a stronger restriction from another source.

## Hidden fields

If the actor cannot view a field:

- omit the field value from entity responses;
- omit the field from normal authorized schema endpoints;
- do not include it in validation details;
- do not include it in search results/filter suggestions/export selections;
- do not reveal option labels/counts/reference values;
- do not emit its raw value in realtime events to that client.

Admin schema-management endpoints may return the field definition only when the actor has configuration permission.

## Read-only fields

If the actor may view but not edit:

- include it in detail schema/response;
- mark the authorized schema descriptor as read-only;
- reject supplied modifications server-side with `FIELD_EDIT_FORBIDDEN` or the platform equivalent;
- do not silently ignore the submitted value.

## Required + hidden conflict prevention

A required rule must never make a field required for an actor who cannot see/edit that field in the relevant write flow.

At configuration time:

- run a compatibility check between requirement targeting and field permission policy;
- reject clearly impossible configurations;
- if authorization is dynamic and cannot be fully proven statically, the requirement resolver must avoid creating an unsatisfiable UI and return a configuration error visible to administrators rather than blaming the end user for an invisible field.

## Exposure flags

Each custom field has independent flags:

```text
availableInForms
availableInImport
availableInExport
availableInApi
searchable
filterable
sortable
showOnCreate
showOnEdit
showOnDetail
availableAsListColumn
```

These flags are capability gates, not permissions.

Effective access is the intersection of:

```text
record permission
∩ field permission
∩ surface exposure flag
∩ resource state
∩ subscription/feature entitlement if platform uses one
```

Examples:

- `availableInApi = true` does not let an unauthorized API key/user see the field.
- `availableInExport = false` excludes it from normal export selection even if the user can view it in CRM.
- `filterable = true` does not expose hidden values to a user without field view access.

## Authorized schema endpoint behavior

For normal entity create/edit/detail rendering, return only:

- active fields;
- registered for the requested entity type;
- enabled for the requested surface;
- visible to the actor;
- with editability calculated for the record context when an entity ID is supplied.

Include enough metadata to render:

```text
id
code
label/helpText
type
multiple
required now?
readOnly
sortOrder
default on create where authorized
validation constraints safe for the client
active list options the actor may use
reference selection metadata
schemaVersion
```

Do not rely on the frontend to hide unauthorized definitions received from the server.

## Search/filter/sort safety

- only fields explicitly configured for the capability may participate;
- only supported type handlers may expose an operator;
- all query fields/operators are allowlisted;
- field permission is checked before query execution/result disclosure;
- avoid arbitrary JSON-path/column names from the client;
- indexes/projections are added only for fields that need them;
- changing these flags triggers search mapping/index update/rebuild as needed.

## Permission keys

At minimum:

```text
CUSTOM_FIELDS.MANAGE
REQUIRED_FIELDS.MANAGE
```

Reading/editing field values occurs through the owning entity's normal permissions plus field restrictions; it does not require `CUSTOM_FIELDS.MANAGE`.

If the repository uses lowercase `resource.action` keys, map these semantics into that registry rather than creating a second format.

## Acceptance criteria

- Hidden fields are absent from normal API and schema responses.
- Read-only fields cannot be changed through direct API calls.
- A field rule never grants access to a record otherwise denied.
- Conflicting restrictions resolve to the most restrictive outcome.
- API/form/import/export/search flags never bypass permissions.
- Requirement configuration cannot create a knowingly hidden-and-required field for the affected write flow.
