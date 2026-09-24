# Required Fields and Conditional Requirement Rules

## Goal

Allow administrators/process owners to require supported system or custom fields globally, by pipeline/stage, and by safe declarative conditions, with one server-side evaluator reused by every write path.

## Rule model

Suggested logical model:

```text
crm_field_requirements
- id UUID
- workspaceId
- entityType
- targetKind SYSTEM | CUSTOM
- targetSystemFieldKey nullable
- targetCustomFieldId nullable
- pipelineId nullable
- stageId nullable
- isActive
- conditionRootId nullable
- version
- created/updated actor + timestamps
```

Conditions may be normalized into tables or stored as validated declarative JSON with versioned schema. Choose the repository approach that provides safe validation/querying/auditability.

## Applicability

A rule can be:

- global for the entity type;
- pipeline-specific;
- stage-specific;
- conditional in addition to the above.

If multiple active rules apply to the same field, **any applicable required rule makes the field required**.

There is no "optional override" that cancels a matching required rule in V1.

## Supported targets

### Custom fields

Any active field that is valid for the entity type and write flow.

### System fields

Only system fields explicitly exposed by the owning entity adapter as requirement-capable.

Do not let admins target protected/internal fields merely because they exist as database columns.

## Condition tree

Support controlled nested condition groups:

```text
ALL / AND
ANY / OR
```

Example:

```text
ALL
├── system:deal_type EQ "ENTERPRISE"
└── ANY
    ├── system:amount GTE 100000
    └── system:source EQ "PARTNER"

THEN custom:contract_approval_number is required
```

## Operators

Type-aware allowlist:

```text
EQ
NEQ
IN
NOT_IN
GT
GTE
LT
LTE
CONTAINS
IS_EMPTY
IS_NOT_EMPTY
```

Only expose an operator when the field type handler supports it.

Examples:

- numeric: EQ/NEQ/GT/GTE/LT/LTE/IN/NOT_IN/empty operators;
- text: EQ/NEQ/CONTAINS/empty operators;
- list/reference: EQ/NEQ/IN/NOT_IN/empty operators;
- boolean: EQ/NEQ;
- dates: comparison + empty operators.

No arbitrary executable expressions.

## Requirement evaluation context

Evaluate against the **post-write** logical record state:

```text
existing unchanged system values
+ incoming system changes
+ existing unchanged custom values
+ incoming custom changes
+ create-only defaults when applicable
+ target pipeline/stage context
```

For stage transition, use the proposed target pipeline/stage, not only the current one.

## Enforcement points

The same resolver is called for:

- entity create;
- entity update while an applicable rule is active;
- stage/pipeline transition into an applicable stage;
- subsequent normal save while remaining in that stage;
- Forms processing into the entity;
- Import row application;
- API writes;
- Automation writes;
- workflow/domain actions that use normal entity services.

A normal integration cannot bypass this by calling a lower-level repository.

## Existing data after rule introduction

When a new rule makes existing records incomplete:

- do not reject normal reads;
- do not destructively backfill or clear data;
- mark completeness in derived UI/schema state where useful;
- enforce the new rule on the next applicable normal save or stage transition;
- analytics/data-quality tooling may later report incomplete records, but that is outside this module's source-of-truth behavior.

## Empty semantics

Required validation treats as empty:

```text
missing on create when no default
null
whitespace-only text after normalization
empty array
```

Treat as valid present values when type-valid:

```text
0
0.0
false
```

## Controlled bypass

Only explicit internal migration/repair operations may bypass requirement validation.

Requirements:

- not available through public/normal CRUD endpoints;
- separate internal permission/service identity;
- reason is mandatory for the repair operation;
- audit every bypass;
- outbox/history as appropriate;
- never use bypass merely to make tests/imports pass.

## Configuration validation

Before saving a rule:

- target entity adapter exists;
- target field exists and is active or valid system descriptor;
- pipeline/stage belongs to same workspace and correct entity process;
- stage belongs to selected pipeline;
- all condition fields exist and are valid;
- operators are supported by field types;
- condition constants are type-valid;
- rule does not obviously require a field hidden/uneditable for the affected user population;
- cross-workspace references are rejected.

## Error behavior

If required fields are missing, return the common field validation envelope.

Field error example:

```json
{
  "code": "REQUIRED",
  "message": "Contract Approval Number is required.",
  "requirementRuleIds": ["uuid"]
}
```

Including rule IDs is optional for normal clients if considered configuration-sensitive. Admin/debug responses may expose them when authorized.

## Audit/events

At minimum:

```text
FIELD_REQUIREMENT.CREATED
FIELD_REQUIREMENT.UPDATED
FIELD_REQUIREMENT.ACTIVATED
FIELD_REQUIREMENT.DEACTIVATED
FIELD_REQUIREMENT.DELETED_IF_SAFE
FIELD_REQUIREMENT.SCHEMA_CHANGED
```

## Acceptance criteria

- Global rules enforce on create/update.
- Stage rules enforce before transition commit and on subsequent normal saves in that stage.
- Conditional nested AND/OR evaluation is deterministic.
- Any matching rule makes the field required.
- 0 and false satisfy presence.
- Existing legacy records remain readable after a new requirement.
- API/import/forms/automation cannot bypass normal validation.
- Cross-workspace pipeline/stage IDs are rejected.
- Invalid/unsupported condition operators are rejected at configuration time.
