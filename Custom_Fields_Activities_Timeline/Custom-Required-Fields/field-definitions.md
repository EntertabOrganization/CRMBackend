# Custom Field Definitions

## Goal

Define stable workspace-scoped metadata for dynamic fields while keeping API identity separate from display labels and page layout.

## Field definition model

Suggested logical fields:

```text
id UUID
workspaceId UUID
entityType enum/string from registered FieldCapableEntity
code string
label string
description/helpText nullable
fieldType enum
isMultiple boolean
isActive boolean
sortOrder integer
staticDefaultValue typed/serialized nullable
validationConfig typed JSON/config object nullable
referenceConfig typed JSON/config object nullable
showOnCreate boolean
showOnEdit boolean
showOnDetail boolean
availableAsListColumn boolean
searchable boolean
filterable boolean
sortable boolean
availableInForms boolean
availableInImport boolean
availableInExport boolean
availableInApi boolean
version integer
createdAt timestamptz
updatedAt timestamptz
createdByUserId nullable/service-aware
updatedByUserId nullable/service-aware
```

Use repository-equivalent audit actor modeling if service accounts are supported.

## Uniqueness

Active and inactive definitions retain their code identity.

Required uniqueness:

```text
(workspace_id, entity_type, code)
```

Do not allow creating a new field with the code of a deactivated field. Reactivate or intentionally migrate the original field instead.

## Code generation

Creation accepts an optional `code`.

If absent:

1. normalize the label to a safe lowercase machine-code style;
2. strip/replace unsupported characters;
3. enforce a reasonable maximum length;
4. resolve collisions deterministically, for example `_2`, `_3`;
5. validate uniqueness inside workspace + entity type.

Examples:

```text
Customer Industry -> customer_industry
Contract Expiry Date -> contract_expiry_date
Estimated Users -> estimated_users
```

After creation, `code` is immutable through normal APIs.

## Mutable vs immutable properties

### Immutable after creation

- `id`
- `workspaceId`
- `entityType`
- `code`

`fieldType` is not normally mutable when data exists; use the explicit migration workflow described in `validation-options-lifecycle.md`.

### Mutable with validation

- label
- help text
- active state through dedicated lifecycle command
- sort order/reorder command
- validation configuration
- static default
- multiplicity only when compatible with existing values and dependencies
- exposure/search/display flags
- reference restrictions, subject to compatibility checks

## System fields

Required-field rules may target supported system fields, but system fields are not represented as user-created custom-field definitions.

Expose system-field descriptors through the schema/requirement API with stable identifiers such as:

```text
system:title
system:amount
system:source
```

The exact identifiers must be stable and namespaced so they cannot collide with custom field IDs/codes.

System-field descriptors declare:

- entity type;
- code/key;
- label;
- data type;
- whether a required rule is allowed;
- whether conditional operators are supported;
- whether the field may be read/edited through the owning entity API.

## Field schema versioning

Maintain a workspace/entity schema version or equivalent version token that changes when rendering/validation-relevant configuration changes.

Schema version changes include:

- field create/deactivate/reactivate/hard-delete;
- type migration completion;
- option changes;
- validation config changes;
- visibility/editability changes;
- requirement rule changes that affect rendering;
- ordering/display flags.

Use the version for:

- cache invalidation;
- optimistic config editing where useful;
- realtime schema-refresh hints;
- deterministic frontend refresh behavior.

## Reordering

Use a dedicated atomic reorder command.

Input example:

```json
{
  "orderedFieldIds": ["uuid-3", "uuid-1", "uuid-2"],
  "expectedSchemaVersion": 18
}
```

Rules:

- every ID must belong to the same workspace and entity type;
- duplicated/missing IDs are rejected according to endpoint contract;
- stale expected version returns conflict;
- all sort orders update in one transaction;
- one schema-change event is emitted after commit.

## Field count / abuse controls

The source documents identify excessive custom fields as a risk but do not define a numeric maximum. Therefore:

- do not invent a hard product limit in this pack;
- provide a centralized policy/entitlement hook that may enforce workspace limits later;
- protect endpoints with normal request limits;
- index only explicitly enabled/useful fields;
- ensure schema queries are paginated in administration views.

## Audit events

At minimum:

```text
CUSTOM_FIELD.CREATED
CUSTOM_FIELD.UPDATED
CUSTOM_FIELD.ACTIVATED
CUSTOM_FIELD.DEACTIVATED
CUSTOM_FIELD.REORDERED
CUSTOM_FIELD.HARD_DELETED
CUSTOM_FIELD.TYPE_MIGRATION_STARTED
CUSTOM_FIELD.TYPE_MIGRATION_COMPLETED
CUSTOM_FIELD.TYPE_MIGRATION_FAILED
CUSTOM_FIELD.SCHEMA_CHANGED
```

## Acceptance criteria

- The same code may exist for Deal and Contact in the same workspace.
- The same code may exist in two different workspaces.
- Duplicate code for the same workspace/entity is rejected.
- Renaming a field never changes its code.
- A deactivated field retains its code and cannot be recreated under the same identity accidentally.
- Reorder is atomic and conflict-safe.
- Configuration mutations increment/invalidate the schema version.
