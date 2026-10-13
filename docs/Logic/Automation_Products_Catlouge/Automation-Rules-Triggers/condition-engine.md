# Declarative Condition Engine

## Goal

Evaluate Rule eligibility safely and consistently without arbitrary tenant code.

## Condition tree

Use a typed declarative tree:

```text
GROUP(ALL | ANY)
  -> CONDITION
  -> CONDITION
  -> GROUP(...)
```

Control maximum depth/node count to prevent pathological expressions.

## Condition sources

Conditions may read only whitelisted context exposed by the target/trigger registry, for example:

- current system fields;
- current custom fields;
- pipeline/stage;
- ownership/responsible user;
- trigger changed-field before/after values;
- typed custom trigger payload;
- safe temporal values supplied by the engine;
- explicit derived values exposed by a registered adapter.

No raw SQL, JavaScript, template execution or reflection into arbitrary object fields.

## Operators

Support type-aware operators such as:

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
STARTS_WITH
ENDS_WITH
IS_EMPTY
IS_NOT_EMPTY
CHANGED
CHANGED_FROM
CHANGED_TO
```

Only expose operators valid for the data type.

## Null/empty semantics

Use shared server semantics and do not let frontend decide:

- null/missing -> empty where appropriate;
- empty string/whitespace -> empty for text;
- empty collection -> empty;
- false -> valid boolean value;
- zero -> valid numeric value.

## Evaluation timing

- Event match: evaluate using authoritative context/current data according to Rule definition.
- Delayed job: reload authoritative record and re-evaluate conditions that are defined as current-state conditions.
- Trigger-specific historical `before/after` values remain pinned event context and are not recomputed.

The Rule configuration must distinguish immutable trigger context from current target state.

## Variables

Provide a typed variable resolver for Action inputs. Examples:

```text
{{target.id}}
{{target.title}}
{{target.customFields.contract_number}}
{{trigger.payload.carrier}}
{{actor.id}}
```

Do not implement unsafe free-form code evaluation. Validate variable references during publish/dry run where possible.

## Publish validation

Publishing fails when:

- a referenced field is unavailable/invalid;
- operator does not support field type;
- required Trigger context is unavailable;
- a Custom Field is inactive and no migration resolution exists;
- tree exceeds safety limits.

## Acceptance criteria

- AND/OR nesting evaluates correctly.
- Type-invalid operators are rejected during configuration/publish.
- Delayed execution detects stale state.
- Custom trigger payload variables are read-only.
- Missing optional values do not crash evaluation.
